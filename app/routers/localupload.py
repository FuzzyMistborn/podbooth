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
import logging
import os
import re
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

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

    async def _run_and_cleanup():
        try:
            await run_upload(upload_id, _local_upload_status, [item], backends)
            result = _local_upload_status.get(upload_id, {})
            if result.get("status") == "done" and s3_keys:
                s = get_session(session_id)
                if s:
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
