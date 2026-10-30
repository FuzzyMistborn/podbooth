"""
Participant local-recording upload page.

Security model
──────────────
• The page and upload API are gated by a per-session upload_token
  (secrets.token_urlsafe(32), stored on the Session, valid for 14 days from
  session creation).  The token is embedded in the studio for guests only;
  they pass it as ?token= on the page GET and X-Upload-Token on every POST.
• Filenames are validated against a strict allowlist (no path separators,
  no dotdot, alphanumerics + safe punctuation only, extension must match the
  content-type allowlist).
• Content-Type is validated against an explicit allowlist.
• Uploads are capped at MAX_UPLOAD_BYTES (10 GB); reading stops immediately
  if the limit is exceeded.
• The upload POST is rate-limited (10 requests / minute per IP).

Files land under:
  {upload_path}/session/{session_slug}/local/{filename}
"""

import asyncio
import hmac
import json
import logging
import os
import re
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from app import s3
from app.config import settings, ASSET_VERSION, APP_VERSION
from app.limiter import limiter
from app import models
from app.models import get_session
from app.routers.cloudsync import (
    S3Backend,
    UploadItem,
    _get_backends,
    _session_slug,
    cloud_upload_enabled,
    run_upload,
)
from app.routers.export import _probe_duration_s
from app.routers.upload import (
    CLOUD_PART_URL_EXPIRY_S,
    CLOUD_UPLOAD_PART_BYTES,
    _S3_MAX_PARTS,
    _metadata_lock,
    _save_run_metadata,
    direct_cloud_upload_enabled,
)

logger = logging.getLogger(__name__)

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
templates.env.globals["asset_v"] = ASSET_VERSION
templates.env.globals["app_version"] = APP_VERSION

# ── Security constants ─────────────────────────────────────────────────────────

MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024  # 10 GB
UPLOAD_TOKEN_TTL = timedelta(days=14)

# Accepted extensions — the extension check is the primary file-type gate.
_ALLOWED: frozenset[str] = frozenset({
    ".wav", ".mp3", ".mp4", ".m4a", ".mkv", ".mov",
    ".avi", ".webm", ".flac", ".ogg", ".aac", ".opus",
})

# Filename: starts with alphanumeric, then alphanumeric / space / - / _ / .
# No more than 255 chars total.
_SAFE_FILENAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9 ._-]{0,253}[A-Za-z0-9]$|^[A-Za-z0-9]$')

# ── State ──────────────────────────────────────────────────────────────────────

_local_upload_status: dict[str, dict] = {}
_local_upload_task_refs: set[asyncio.Task] = set()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _verify_upload_token(session, token: str) -> None:
    """Raise 403 if token is missing, wrong, or the session window has closed."""
    if not token:
        raise HTTPException(status_code=403, detail="Missing upload token")
    if not hmac.compare_digest(token, session.upload_token):
        raise HTTPException(status_code=403, detail="Invalid upload token")
    if datetime.now() - session.created_at > UPLOAD_TOKEN_TTL:
        raise HTTPException(status_code=403, detail="Upload token has expired")


def _validate_filename(raw: str) -> str:
    """Return a safe filename or raise 400."""
    # Use only the basename; discard any directory component the client sent.
    name = Path(raw).name.strip()

    if not name or name in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid filename")

    # Reject any remaining path separators or null bytes after basename extraction.
    if "/" in name or "\\" in name or "\x00" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid filename")

    if not _SAFE_FILENAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail="Filename may only contain letters, digits, spaces, hyphens, underscores, and dots",
        )

    ext = Path(name).suffix.lower()
    if not ext or ext not in _ALLOWED:
        raise HTTPException(
            status_code=400,
            detail=f"File extension '{ext or '(none)'}' is not allowed. Accepted: {', '.join(sorted(_ALLOWED))}",
        )

    return name


def _validate_content_type(content_type: str | None, filename: str) -> None:
    """Raise 415 if the Content-Type is not audio/*, video/*, or a known application/ variant."""
    if not content_type:
        raise HTTPException(status_code=415, detail="Content-Type header required")

    mime = content_type.split(";")[0].strip().lower()

    # Pass audio/* and video/* unconditionally.
    if mime.startswith("audio/") or mime.startswith("video/"):
        return

    # application/octet-stream: generic binary — browsers send this for many
    # formats they don't recognise (MKV, WAV, etc.). Extension check gates type.
    # application/mp4 / application/ogg: legitimate registered MIME types.
    if mime in {"application/octet-stream", "application/mp4", "application/ogg"}:
        return

    raise HTTPException(
        status_code=415,
        detail=f"Content-Type '{mime}' is not allowed. File must be audio or video.",
    )


async def _register_local_upload_run(
    session, slug: str, track_type: str, filename: str, duration_s: float,
) -> None:
    """Record a whole-file local upload in recording_metadata.json so export
    generation (_resolve_runs) can find it, reusing the same take for an
    existing run missing this track, or starting a new take otherwise."""
    session_dir = Path(settings.recordings_dir) / session.dir_name
    session_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = session_dir / "recording_metadata.json"

    async with _metadata_lock:
        data: dict = {}
        if metadata_path.exists():
            try:
                data = json.loads(metadata_path.read_text())
            except Exception:
                data = {}
        matching = [r for r in data.get("runs", []) if r.get("slug") == slug]
        take = next((r["take"] for r in matching if track_type not in r.get("tracks", {})), None)
        if take is None:
            take = max((r["take"] for r in matching), default=0) + 1

    part_dir = session_dir / slug
    await _save_run_metadata(
        part_dir, epoch_ms=0, nametake=(slug, take),
        track_type=track_type, filename=filename, expected_duration_s=duration_s,
    )


async def _record_local_upload(
    session_id: str, session, safe_participant: str, filename: str, track_type: str,
    file_size: int, duration_s: float, s3_keys: list[str],
) -> None:
    """After a local upload reached the bucket: record its keys in
    session.r2_files (needed for editor delivery), register its run for export
    generation, and refresh the editor manifest."""
    s = get_session(session_id)
    if not s:
        return
    existing = {f["key"] for f in s.r2_files}
    for key in s3_keys:
        if key not in existing:
            s.r2_files.append({
                "key": key,
                "filename": filename,
                "size_bytes": file_size,
                "uploaded_at": datetime.now(tz=timezone.utc).isoformat(),
                "uploader": safe_participant or "local-upload",
            })
    await models.touch(session_id)
    if duration_s > 0:
        await _register_local_upload_run(
            session, safe_participant or "guest", track_type, filename, duration_s,
        )
    from app.routers.s3upload import schedule_manifest_auto_refresh
    schedule_manifest_auto_refresh(session_id)


def _safe_participant(header: str) -> str:
    return "".join(c if c.isalnum() or c in "- _" else "_" for c in header).strip()


def _remote_path(session, participant: str, filename: str) -> str:
    slug = _session_slug(session.title)
    if participant:
        return f"{slug}/local/{participant}/{filename}"
    return f"{slug}/local/{filename}"


def _bucket_key(remote_path: str) -> str:
    prefix = s3.upload_prefix()
    return f"{prefix}/{remote_path}" if prefix else remote_path


def _is_active_bucket(backend) -> bool:
    """Whether an S3Backend is the bucket app.s3 (and so a direct browser
    upload) writes to."""
    if not isinstance(backend, S3Backend):
        return False
    bucket, _, endpoint, *_ = s3._active_backend()
    return backend._bucket == bucket and (backend._endpoint_url or None) == endpoint


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("/local-upload/{session_id}", response_class=HTMLResponse)
async def local_upload_page(
    request: Request,
    session_id: str,
    token: str = Query(default=""),
    participant: str = Query(default=""),
):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    _verify_upload_token(session, token)

    # Sanitise participant name — same character set as session slug.
    safe_participant = "".join(c if c.isalnum() or c in "- _" else "_" for c in participant).strip()

    return templates.TemplateResponse(
        request,
        "local_upload.html",
        {
            "session": session,
            "upload_token": token,
            "participant": safe_participant,
            "cloud_upload_enabled": cloud_upload_enabled(),
            "direct_cloud": direct_cloud_upload_enabled(),
        },
    )


@router.post("/api/session/{session_id}/local-upload")
@limiter.limit("10/minute")
async def start_local_upload(
    request: Request,
    session_id: str,
    file: UploadFile = File(...),
    x_upload_token: str = Header(default=""),
    x_participant: str = Header(default=""),
):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    _verify_upload_token(session, x_upload_token)

    backends = _get_backends()
    if not backends:
        raise HTTPException(status_code=400, detail="No cloud upload configured")

    # Validate filename and content-type before touching the body.
    raw_filename = file.filename or ""
    filename = _validate_filename(raw_filename)
    _validate_content_type(file.content_type, filename)

    # Stream into a temp file, aborting if the size limit is exceeded.
    suffix = Path(filename).suffix
    fd, tmp_path_str = tempfile.mkstemp(suffix=suffix, prefix="pb_local_")
    tmp_path = Path(tmp_path_str)
    bytes_received = 0
    try:
        with os.fdopen(fd, "wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)  # 1 MiB chunks
                if not chunk:
                    break
                bytes_received += len(chunk)
                if bytes_received > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds maximum allowed size ({MAX_UPLOAD_BYTES // (1024**3)} GB)",
                    )
                fh.write(chunk)
    except HTTPException:
        tmp_path.unlink(missing_ok=True)
        raise
    except Exception as e:
        tmp_path.unlink(missing_ok=True)
        logger.error("Failed to receive local upload for session %s: %s", session_id, e)
        raise HTTPException(status_code=500, detail="Failed to receive file")

    slug = _session_slug(session.title)
    safe_participant = "".join(c if c.isalnum() or c in "- _" else "_" for c in x_participant).strip()
    if safe_participant:
        remote_path = f"{slug}/local/{safe_participant}/{filename}"
    else:
        remote_path = f"{slug}/local/{filename}"
    item = UploadItem(local_path=tmp_path, remote_path=remote_path)

    upload_id = str(uuid.uuid4())

    # Compute the actual storage keys for R2/B2 backends so we can record them
    # in session.r2_files after a successful upload (needed for editor delivery).
    s3_keys = []
    for b in backends:
        if isinstance(b, S3Backend):
            upload_path = getattr(b, "_upload_path", "").strip("/")
            key = f"{upload_path}/{remote_path}" if upload_path else remote_path
            s3_keys.append(key)

    file_size = tmp_path.stat().st_size

    # Probe duration while the temp file still exists — it's deleted right
    # after upload, and this is the only local copy that will ever exist, so
    # export generation (_resolve_runs) has no other way to learn it.
    duration_s = await _probe_duration_s(tmp_path)
    track_type = "video" if (file.content_type or "").startswith("video/") else "audio"

    async def _run_and_cleanup():
        try:
            await run_upload(upload_id, _local_upload_status, [item], backends)
            result = _local_upload_status.get(upload_id, {})
            if result.get("status") == "done" and s3_keys:
                await _record_local_upload(
                    session_id, session, safe_participant, filename, track_type,
                    file_size, duration_s, s3_keys,
                )
        finally:
            tmp_path.unlink(missing_ok=True)

    task = asyncio.create_task(_run_and_cleanup())
    _local_upload_task_refs.add(task)
    task.add_done_callback(_local_upload_task_refs.discard)

    return JSONResponse({"upload_id": upload_id, "filename": filename})


@router.get("/api/session/{session_id}/local-upload/{upload_id}/status")
async def local_upload_status(
    session_id: str,
    upload_id: str,
    x_upload_token: str = Header(default=""),
):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    _verify_upload_token(session, x_upload_token)

    # Validate upload_id is a UUID to avoid log injection / info leakage.
    try:
        uuid.UUID(upload_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid upload ID")

    status = _local_upload_status.get(upload_id)
    if not status:
        return JSONResponse({"status": "pending"})
    return JSONResponse(status)


# ── Direct-to-cloud upload ─────────────────────────────────────────────────────
# Like the post-stop recording upload (upload.py /cloud/*): the browser PUTs
# the file to the bucket in parts via presigned URLs, straight to the file's
# final key, so it never crosses this server's link on the way in. /complete
# then finishes the upload and returns at once; in the background the server
# reads the duration off the bucket copy and — only if other backends
# (Nextcloud, FileBrowser, a second bucket) are configured — pulls the file down
# to push it to them. The page polls the same status endpoint as before.


def _require_local_key(session, key) -> None:
    """part-url/abort/complete carry a key from /cloud/start — refuse one
    outside this session's local-upload folder."""
    prefix = _bucket_key(f"{_session_slug(session.title)}/local/")
    if not isinstance(key, str) or not key.startswith(prefix):
        raise HTTPException(status_code=403, detail="Key does not belong to this session")


def _direct_or_503() -> None:
    if not direct_cloud_upload_enabled():
        raise HTTPException(status_code=503, detail="Direct-to-cloud upload is not configured")


@router.post("/api/session/{session_id}/local-upload/cloud/start")
@limiter.limit("30/minute")
async def local_cloud_start(
    request: Request,
    session_id: str,
    x_upload_token: str = Header(default=""),
    x_participant: str = Header(default=""),
):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _verify_upload_token(session, x_upload_token)
    _direct_or_503()

    data = await request.json()
    filename = _validate_filename(data.get("filename") or "")
    content_type = data.get("content_type") or ""
    _validate_content_type(content_type, filename)
    try:
        total_size = int(data.get("total_size", 0))
    except (TypeError, ValueError):
        total_size = 0
    if total_size <= 0:
        raise HTTPException(status_code=400, detail="Invalid total_size")
    if total_size > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds maximum allowed size ({MAX_UPLOAD_BYTES // (1024**3)} GB)",
        )
    part_count = -(-total_size // CLOUD_UPLOAD_PART_BYTES)
    if part_count > _S3_MAX_PARTS:
        raise HTTPException(status_code=413, detail="File too large for a cloud upload")

    key = _bucket_key(_remote_path(session, _safe_participant(x_participant), filename))
    try:
        upload_id = await asyncio.to_thread(
            s3.create_multipart_upload, key, content_type.split(";")[0].strip() or "application/octet-stream",
        )
        part_urls = await asyncio.to_thread(lambda: [
            s3.generate_part_upload_url(key, upload_id, n, CLOUD_PART_URL_EXPIRY_S)
            for n in range(1, part_count + 1)
        ])
    except Exception as e:
        logger.error("local cloud start: could not start %s: %s", key, e)
        raise HTTPException(status_code=503, detail="Could not start cloud upload")
    logger.info("local cloud start: session=%s key=%s size=%d parts=%d", session_id, key, total_size, part_count)
    return JSONResponse({
        "key": key, "upload_id": upload_id, "part_size": CLOUD_UPLOAD_PART_BYTES, "part_urls": part_urls,
    })


@router.post("/api/session/{session_id}/local-upload/cloud/part-url")
@limiter.limit("600/minute")
async def local_cloud_part_url(
    request: Request, session_id: str, x_upload_token: str = Header(default=""),
):
    """Fresh presigned URL for one part, if its up-front URL was refused."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _verify_upload_token(session, x_upload_token)
    _direct_or_503()
    data = await request.json()
    key, upload_id = data.get("key"), data.get("upload_id")
    try:
        part_number = int(data.get("part_number"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid part_number")
    if not key or not upload_id or not (1 <= part_number <= _S3_MAX_PARTS):
        raise HTTPException(status_code=400, detail="Missing key/upload_id/part_number")
    _require_local_key(session, key)
    try:
        url = await asyncio.to_thread(s3.generate_part_upload_url, key, upload_id, part_number)
    except Exception as e:
        logger.error("local cloud part-url: failed for %s part %d: %s", key, part_number, e)
        raise HTTPException(status_code=503, detail="Could not generate part upload URL")
    return JSONResponse({"url": url})


@router.post("/api/session/{session_id}/local-upload/cloud/abort")
@limiter.limit("60/minute")
async def local_cloud_abort(
    request: Request, session_id: str, x_upload_token: str = Header(default=""),
):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _verify_upload_token(session, x_upload_token)
    data = await request.json()
    key, upload_id = data.get("key"), data.get("upload_id")
    if not key or not upload_id:
        raise HTTPException(status_code=400, detail="Missing key/upload_id")
    _require_local_key(session, key)
    await asyncio.to_thread(s3.abort_multipart_upload, key, upload_id)
    return JSONResponse({"ok": True})


@router.post("/api/session/{session_id}/local-upload/cloud/complete")
@limiter.limit("60/minute")
async def local_cloud_complete(
    request: Request,
    session_id: str,
    x_upload_token: str = Header(default=""),
    x_participant: str = Header(default=""),
):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _verify_upload_token(session, x_upload_token)
    _direct_or_503()
    data = await request.json()
    key, upload_id = data.get("key"), data.get("upload_id")
    try:
        part_count = int(data.get("part_count"))
        total_size = int(data.get("total_size"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid part_count/total_size")
    if not key or not upload_id:
        raise HTTPException(status_code=400, detail="Missing key/upload_id")
    _require_local_key(session, key)
    filename = _validate_filename(key.rsplit("/", 1)[-1])
    content_type = data.get("content_type") or ""
    track_type = "video" if content_type.startswith("video/") else "audio"

    completed = False
    try:
        parts = await asyncio.to_thread(s3.list_uploaded_parts, key, upload_id)
    except Exception:
        parts = None  # the upload_id is gone once completed — see the retry case below
    if parts is not None:
        landed = sorted(p["part_number"] for p in parts)
        if landed != list(range(1, part_count + 1)) or sum(p["size"] for p in parts) != total_size:
            # Never complete a partial upload; the page falls back to sending
            # the file through the server, which has every byte locally.
            logger.error("local cloud complete: %s parts don't match (%d landed, expected %d)",
                         key, len(landed), part_count)
            raise HTTPException(status_code=409, detail="Uploaded parts don't match — falling back")
        try:
            await asyncio.to_thread(s3.complete_multipart_upload, key, upload_id, parts)
            completed = True
        except Exception as e:
            logger.warning("local cloud complete: complete_multipart_upload failed for %s: %s", key, e)
    if not completed and not await asyncio.to_thread(s3.object_exists, key):
        raise HTTPException(status_code=503, detail="Could not complete cloud upload")

    job_id = str(uuid.uuid4())
    _local_upload_status[job_id] = {
        "status": "uploading", "message": "Processing…", "uploaded": 0, "total": 1, "ts": time.time(),
    }
    task = asyncio.create_task(_process_direct_upload(
        job_id, session_id, key, filename, track_type, _safe_participant(x_participant), total_size,
    ))
    _local_upload_task_refs.add(task)
    task.add_done_callback(_local_upload_task_refs.discard)
    logger.info("local cloud complete: session=%s key=%s (%d bytes)", session_id, key, total_size)
    return JSONResponse({"upload_id": job_id, "filename": filename})


async def _process_direct_upload(
    job_id: str, session_id: str, key: str, filename: str, track_type: str,
    safe_participant: str, file_size: int,
) -> None:
    """Background half of a direct upload: probe the duration, record the file
    (it's already safe in the bucket), then copy it to any other backends.
    A failure after the bucket has the file is reported as a warning on a
    "done" status rather than an error — the upload itself succeeded."""
    session = get_session(session_id)
    tmp_path: Path | None = None
    warning = ""
    try:
        others = [b for b in _get_backends() if not _is_active_bucket(b)]
        duration_s = 0.0
        if others:
            # Nextcloud/FileBrowser/a second bucket can't be written by the
            # browser, so this server pulls the file down once and pushes it on.
            _local_upload_status[job_id]["message"] = "Downloading…"
            fd, tmp_name = tempfile.mkstemp(suffix=Path(filename).suffix, prefix="pb_local_")
            os.close(fd)
            tmp_path = Path(tmp_name)
            try:
                await asyncio.to_thread(s3.download_object_to_path, key, tmp_path)
                duration_s = await _probe_duration_s(tmp_path)
            except Exception as e:
                logger.error("local cloud upload %s: pull-down failed: %s", key, e)
                warning = f"Saved to cloud storage, but copying to other backends failed: {e}"
                tmp_path.unlink(missing_ok=True)
                tmp_path = None
                others = []
        else:
            # Nothing else to feed: read the duration straight off the bucket
            # copy (ffprobe range-reads over HTTPS) rather than downloading it.
            url = await asyncio.to_thread(s3.generate_download_url, key, 3600)
            duration_s = await _probe_duration_s(url)

        # Record the bucket copy now, before the slower pushes to other backends.
        await _record_local_upload(
            session_id, session, safe_participant, filename, track_type, file_size, duration_s, [key],
        )

        if others and tmp_path:
            _local_upload_status[job_id]["message"] = "Copying to other backends…"
            item = UploadItem(local_path=tmp_path, remote_path=_remote_path(session, safe_participant, filename))
            await run_upload(job_id, _local_upload_status, [item], others)
            result = _local_upload_status.get(job_id, {})
            if result.get("status") == "done":
                extra = [_bucket_key_for(b, session, safe_participant, filename)
                         for b in others if isinstance(b, S3Backend)]
                if extra:  # duration 0: the run was already registered above
                    await _record_local_upload(
                        session_id, session, safe_participant, filename, track_type, file_size, 0, extra,
                    )
            else:
                warning = f"Saved to cloud storage, but not copied everywhere: {result.get('message', 'unknown error')}"
        if warning:
            logger.warning("local cloud upload %s: %s", key, warning)
            _local_upload_status[job_id] = {
                "status": "done", "message": "Uploaded 1 file(s)", "warning": warning,
                "uploaded": 1, "total": 1, "ts": time.time(),
            }
        elif _local_upload_status.get(job_id, {}).get("status") != "done":
            _local_upload_status[job_id] = {
                "status": "done", "message": "Uploaded 1 file(s)", "uploaded": 1, "total": 1, "ts": time.time(),
            }
    except Exception as e:
        logger.error("local cloud upload %s failed after reaching the bucket: %s", key, e)
        _local_upload_status[job_id] = {
            "status": "error", "message": f"Processing failed: {e}", "uploaded": 0, "total": 1, "ts": time.time(),
        }
    finally:
        if tmp_path:
            tmp_path.unlink(missing_ok=True)


def _bucket_key_for(backend: S3Backend, session, participant: str, filename: str) -> str:
    path = _remote_path(session, participant, filename)
    return f"{backend._upload_path}/{path}" if backend._upload_path else path
