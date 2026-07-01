"""
S3-backed editor delivery endpoints.
"""
import asyncio
import hashlib
import json
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app import models, s3
from app.auth import require_host
from app.config import settings
from app.discord import notify_editor_link
from app.limiter import limiter
from app.models import get_session
from app.routers.cloudsync import _session_slug

logger = logging.getLogger(__name__)

router = APIRouter()

# R2/B2 hard-cap on presigned URL lifetime (7 days in seconds)
_PRESIGNED_MAX_SECS = 604800


def _file_source(key: str) -> str:
    """Derive file source label from its storage key path."""
    parts = key.replace("\\", "/").lower().split("/")
    if "local" in parts:
        return "local"
    if "podbooth" in parts:
        return "podbooth"
    if "exports" in parts:
        return "exports"
    if "production" in parts:
        return "production"
    return ""


def _cloudsync_prefixes(session_title: str) -> list[str]:
    """Return the R2/B2 upload prefixes used by the cloudsync local-upload flow."""
    slug = _session_slug(session_title)
    prefixes = []
    if settings.r2_bucket:
        base = settings.r2_upload_path.strip("/")
        prefixes.append(f"{base}/{slug}/" if base else f"{slug}/")
    if settings.b2_bucket:
        base = settings.b2_upload_path.strip("/")
        prefixes.append(f"{base}/{slug}/" if base else f"{slug}/")
    return prefixes


_FILENAME_RE = re.compile(r'^[A-Za-z0-9._\-]+$')


def _validate_filename(name: str) -> None:
    if not name or len(name) > 255:
        raise HTTPException(status_code=400, detail="Filename must be 1–255 characters")
    if ".." in name or "/" in name:
        raise HTTPException(status_code=400, detail="Filename must not contain '..' or '/'")
    if not _FILENAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Filename contains disallowed characters (allowed: A-Za-z0-9 . _ -)")


def _expiry_secs() -> int:
    """Presigned URL lifetime, capped at provider maximum."""
    return min(settings.s3_upload_expiry_days * 86400, _PRESIGNED_MAX_SECS)


async def _build_manifest_files(loop, objs: list[dict], r2_meta: dict, expiry_secs: int) -> list[dict]:
    """Build the files list for a manifest, generating presigned download URLs."""
    manifest_files = []
    for obj in objs:
        key = obj["key"]
        meta = r2_meta.get(key, {})
        try:
            dl_url = await loop.run_in_executor(
                None, lambda k=key: s3.generate_download_url(k, expires_in=expiry_secs)
            )
        except Exception:
            logger.exception("Failed to generate download URL for key %s", key)
            dl_url = ""
        manifest_files.append({
            "key": key,
            "filename": meta.get("filename", key.split("/")[-1]),
            "size_bytes": obj["size_bytes"],
            "download_url": dl_url,
            "uploader": meta.get("uploader", ""),
            "uploaded_at": meta.get("uploaded_at", obj["last_modified"]),
            "source": _file_source(key),
        })
    return manifest_files


async def _upload_export_files(session_id: str, session) -> None:
    """Generate OTIO/FCPXML/Reaper project files and upload to sessions/{id}/exports/."""
    from app.routers.export import _resolve_runs, _build_otio_json, _build_fcpxml, _build_reaper_rpp, _safe_name

    try:
        runs = await _resolve_runs(session)
    except Exception:
        logger.exception("Export generation failed: could not resolve runs for session %s", session_id)
        return

    if not runs:
        return

    safe = _safe_name(session.title)
    exports = {
        f"{safe}.otio":   ("application/json", _build_otio_json(session.title, runs)),
        f"{safe}.fcpxml": ("application/xml",  _build_fcpxml(session.title, runs)),
        f"{safe}.rpp":    ("text/plain",        _build_reaper_rpp(session.title, runs)),
    }

    loop = asyncio.get_running_loop()
    existing_keys = {f["key"] for f in session.r2_files}
    now = datetime.now(tz=timezone.utc).isoformat()
    changed = False

    for filename, (content_type, content) in exports.items():
        key = f"sessions/{session_id}/exports/{filename}"
        try:
            await loop.run_in_executor(None, lambda k=key, c=content, ct=content_type: s3.put_object(k, c, ct))
            logger.info("Uploaded export file: %s", key)
        except Exception:
            logger.exception("Failed to upload export file %s", key)
            continue
        if key not in existing_keys:
            session.r2_files.append({
                "key": key,
                "filename": filename,
                "size_bytes": len(content.encode() if isinstance(content, str) else content),
                "uploaded_at": now,
                "uploader": "podbooth",
            })
            existing_keys.add(key)
            changed = True

    if changed:
        await models.touch(session_id)


class UploadUrlRequest(BaseModel):
    filename: str
    content_type: str


@router.post("/api/session/{session_id}/s3/upload-url")
@limiter.limit("30/minute")
async def get_upload_url(
    request: Request,
    session_id: str,
    body: UploadUrlRequest,
    _: None = Depends(require_host),
):
    """Get a presigned S3 PUT URL."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    _validate_filename(body.filename)
    if body.content_type not in s3.ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Content-type '{body.content_type}' is not allowed. Allowed: {sorted(s3.ALLOWED_CONTENT_TYPES)}",
        )

    key = f"sessions/{session_id}/{body.filename}"

    loop = asyncio.get_running_loop()
    try:
        upload_url = await loop.run_in_executor(
            None, lambda: s3.generate_upload_url(key, body.content_type)
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Record file in session if not already present
    existing_keys = {f["key"] for f in session.r2_files}
    if key not in existing_keys:
        session.r2_files.append({
            "key": key,
            "filename": body.filename,
            "size_bytes": 0,
            "uploaded_at": datetime.now(tz=timezone.utc).isoformat(),
            "uploader": "",
        })
        await models.touch(session_id)

    return {"upload_url": upload_url, "key": key}


@router.get("/api/session/{session_id}/s3/files")
async def list_files(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    loop = asyncio.get_running_loop()
    try:
        extra = [f["key"] for f in session.r2_files]
        extra_pfx = _cloudsync_prefixes(session.title)
        objs = await loop.run_in_executor(None, lambda: s3.list_session_objects(session_id, extra, extra_pfx))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    expiry_secs = _expiry_secs()
    r2_meta = {f["key"]: f for f in session.r2_files}
    files = await _build_manifest_files(loop, objs, r2_meta, expiry_secs)

    return {"files": files}


@router.delete("/api/session/{session_id}/s3")
async def delete_s3_files(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    loop = asyncio.get_running_loop()
    try:
        extra_pfx = _cloudsync_prefixes(session.title)
        n = await loop.run_in_executor(None, lambda: s3.delete_session_objects(session_id, extra_pfx))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    session.r2_files = []
    session.editor_token_hash = ""
    session.r2_expires_at = ""
    await models.touch(session_id)

    return {"deleted": n}


@router.post("/api/session/{session_id}/s3/editor-link")
async def create_editor_link(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    loop = asyncio.get_running_loop()
    try:
        extra = [f["key"] for f in session.r2_files]
        extra_pfx = _cloudsync_prefixes(session.title)
        objs = await loop.run_in_executor(None, lambda: s3.list_session_objects(session_id, extra, extra_pfx))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    if not objs:
        raise HTTPException(status_code=400, detail="No files uploaded for this session")

    editor_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(editor_token.encode()).hexdigest()
    expiry_secs = _expiry_secs()
    expires_at = (datetime.now(tz=timezone.utc) + timedelta(seconds=expiry_secs)).isoformat()

    # Generate and upload NLE/DAW export files before building the manifest
    # so they get presigned download URLs included in it
    await _upload_export_files(session_id, session)

    # Re-list after export upload so export keys are included
    try:
        extra2 = [f["key"] for f in session.r2_files]
        objs = await loop.run_in_executor(None, lambda: s3.list_session_objects(session_id, extra2, extra_pfx))
    except RuntimeError:
        pass  # fall through with original objs list

    r2_meta = {f["key"]: f for f in session.r2_files}
    manifest_files = await _build_manifest_files(loop, objs, r2_meta, expiry_secs)

    manifest = {
        "session_id": session_id,
        "title": session.title,
        "episode": session.episode or "",
        "created_at": session.created_at.isoformat(),
        "editor_token_hash": token_hash,
        "expires_at": expires_at,
        "files": manifest_files,
    }

    manifest_key = f"sessions/{session_id}/manifest.json"
    await loop.run_in_executor(
        None, lambda: s3.put_object(manifest_key, json.dumps(manifest), "application/json")
    )

    # Store only the hash — the raw token is never persisted to disk
    session.editor_token_hash = token_hash
    session.r2_expires_at = expires_at
    await models.touch(session_id)

    editor_url = ""
    if settings.editor_portal_url:
        editor_url = f"{settings.editor_portal_url}/session/{session_id}?token={editor_token}"

    total_bytes = sum(f["size_bytes"] for f in manifest_files)
    asyncio.ensure_future(notify_editor_link(
        session_id=session_id,
        title=session.title,
        episode=session.episode or "",
        editor_url=editor_url,
        file_count=len(manifest_files),
        expires_at=expires_at,
        total_bytes=total_bytes,
    ))

    return {"editor_url": editor_url, "expires_at": expires_at}


@router.post("/api/session/{session_id}/s3/manifest-refresh")
async def manifest_refresh(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if not session.editor_token_hash:
        raise HTTPException(status_code=400, detail="No editor link exists for this session; generate one first")

    loop = asyncio.get_running_loop()
    try:
        extra = [f["key"] for f in session.r2_files]
        extra_pfx = _cloudsync_prefixes(session.title)
        objs = await loop.run_in_executor(None, lambda: s3.list_session_objects(session_id, extra, extra_pfx))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    if not objs:
        raise HTTPException(status_code=400, detail="No files uploaded for this session")

    expiry_secs = _expiry_secs()
    expires_at = (datetime.now(tz=timezone.utc) + timedelta(seconds=expiry_secs)).isoformat()

    # Regenerate export files before building manifest so they get presigned URLs
    await _upload_export_files(session_id, session)

    # Re-list after export upload
    try:
        extra2 = [f["key"] for f in session.r2_files]
        extra_pfx = _cloudsync_prefixes(session.title)
        objs = await loop.run_in_executor(None, lambda: s3.list_session_objects(session_id, extra2, extra_pfx))
    except RuntimeError:
        pass

    r2_meta = {f["key"]: f for f in session.r2_files}
    manifest_files = await _build_manifest_files(loop, objs, r2_meta, expiry_secs)

    manifest = {
        "session_id": session_id,
        "title": session.title,
        "episode": session.episode or "",
        "created_at": session.created_at.isoformat(),
        "editor_token_hash": session.editor_token_hash,
        "expires_at": expires_at,
        "files": manifest_files,
    }

    manifest_key = f"sessions/{session_id}/manifest.json"
    await loop.run_in_executor(
        None, lambda: s3.put_object(manifest_key, json.dumps(manifest), "application/json")
    )

    session.r2_expires_at = expires_at
    await models.touch(session_id)

    return {"ok": True, "file_count": len(manifest_files)}
