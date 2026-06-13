import asyncio
import os
import re
import tempfile
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, Request, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask

from app.models import list_sessions, get_session
from app.config import settings, ASSET_VERSION
from app.auth import require_host

_VALID_MEDIA_RE = re.compile(r"^(audio|video|screen)[_a-z0-9]*\.(wav|mp4)$")


def _safe_name(value: str) -> str:
    return "".join(c if c.isalnum() or c in "- " else "_" for c in value).strip()

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
templates.env.globals["asset_v"] = ASSET_VERSION


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request, _: None = Depends(require_host)):
    sessions = list_sessions()
    session_files = {s.id: _get_session_files(s) for s in sessions}
    return templates.TemplateResponse(
        request, "dashboard.html",
        {"sessions": sessions, "session_files": session_files},
    )


def _get_session_files(session) -> list[dict]:
    """Find assembled files for a session — includes epoch-named files from reconnection runs."""
    recordings_path = Path(settings.recordings_dir)
    session_path = recordings_path / session.dir_name
    files = []

    if not session_path.is_dir():
        return files

    for participant_dir in sorted(session_path.iterdir()):
        if not participant_dir.is_dir():
            continue
        for fpath in sorted(participant_dir.iterdir()):
            if not fpath.is_file() or fpath.suffix not in (".wav", ".mp4"):
                continue
            stem = fpath.stem
            # Skip intermediate and raw files
            if "_noaudio" in stem or "_source" in stem or "_chunk_" in fpath.name:
                continue
            if stem == "audio" or stem.startswith("audio_"):
                ftype = "audio"
            elif stem == "video" or stem.startswith("video_"):
                ftype = "video"
            elif stem == "screen" or stem.startswith("screen_"):
                ftype = "screen"
            else:
                continue
            size_mb = fpath.stat().st_size / (1024 * 1024)
            files.append({
                "participant": participant_dir.name,
                "type": ftype,
                "filename": fpath.name,
                "path": str(fpath.relative_to(recordings_path)),
                "size_mb": round(size_mb, 1),
            })
    return files


@router.get("/download/{file_path:path}")
async def download_file(file_path: str, _: None = Depends(require_host)):
    base = Path(settings.recordings_dir).resolve()
    full_path = (base / file_path).resolve()

    # Path traversal guard
    if base != full_path and base not in full_path.parents:
        raise HTTPException(status_code=403, detail="Access denied")
    # Allow audio*.wav, video*.mp4, screen*.mp4 — covers epoch-named files from reconnection runs
    if not _VALID_MEDIA_RE.match(full_path.name):
        raise HTTPException(status_code=403, detail="Access denied")
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(full_path, filename=full_path.name)


@router.get("/download-zip/{session_id}")
async def download_session_zip(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    files = _get_session_files(session)
    if not files:
        raise HTTPException(status_code=404, detail="No recordings available yet")

    fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)

    def _write():
        base = Path(settings.recordings_dir)
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
            for f in files:
                zf.write(str(base / f["path"]), f"{f['participant']}/{f['filename']}")

    try:
        await asyncio.to_thread(_write)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail="Failed to create archive")

    filename = f"{_safe_name(session.title)}.zip"
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(os.unlink, tmp_path),
    )
