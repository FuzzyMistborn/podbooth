import asyncio
import math
import os
import re
import tempfile
import zipfile
from pathlib import Path

import logging

from fastapi import APIRouter, Depends, Request, HTTPException
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask

from app.models import list_sessions, get_session

logger = logging.getLogger(__name__)
from app.config import settings, ASSET_VERSION
from app.auth import require_host

_VALID_MEDIA_RE = re.compile(r"^(audio|video|screen)[_a-z0-9]*\.(wav|mp4)$")

_export_tasks: set[str] = set()          # session IDs currently exporting
_export_task_refs: set[asyncio.Task] = set()  # keep tasks alive


def _safe_name(value: str) -> str:
    return "".join(c if c.isalnum() or c in "- " else "_" for c in value).strip()

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
templates.env.globals["asset_v"] = ASSET_VERSION


def _collect_video_paths(session) -> list[Path]:
    """Return one assembled video*.mp4 per participant (latest epoch, no intermediates)."""
    recordings_path = Path(settings.recordings_dir)
    session_path = recordings_path / session.dir_name
    paths = []
    if not session_path.is_dir():
        return paths
    for pdir in sorted(session_path.iterdir()):
        if not pdir.is_dir():
            continue
        vfiles = sorted([
            f for f in pdir.iterdir()
            if f.is_file()
            and f.suffix == ".mp4"
            and (f.stem == "video" or f.stem.startswith("video_"))
            and "_noaudio" not in f.stem
            and "_source" not in f.stem
        ])
        if vfiles:
            paths.append(vfiles[-1])
    return paths


def _build_export_cmd(video_paths: list[Path], output_path: Path) -> list[str]:
    n = len(video_paths)
    cmd = ["ffmpeg", "-y"]
    for vp in video_paths:
        cmd += ["-i", str(vp)]

    if n == 1:
        cmd += [
            "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "320k",
            "-movflags", "+faststart",
            str(output_path),
        ]
        return cmd

    # Grid geometry: target 1920 wide, 16:9 cells
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    cell_w = 1920 // cols
    cell_h = (cell_w * 9) // 16
    total_tiles = cols * rows
    n_blank = total_tiles - n

    fc = []

    # Scale each real video into its cell, preserving aspect ratio with black bars
    for i in range(n):
        fc.append(
            f"[{i}:v]scale={cell_w}:{cell_h}:force_original_aspect_ratio=decrease,"
            f"pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2:black[v{i}]"
        )

    # Blank filler tiles (infinite duration; -shortest ends at the real video)
    for i in range(n_blank):
        fc.append(f"color=black:size={cell_w}x{cell_h}:rate=30[blank{i}]")

    tile_refs = "".join(f"[v{i}]" for i in range(n)) + "".join(f"[blank{i}]" for i in range(n_blank))
    layout = "|".join(
        f"{(idx % cols) * cell_w}_{(idx // cols) * cell_h}"
        for idx in range(total_tiles)
    )
    fc.append(f"{tile_refs}xstack=inputs={total_tiles}:layout={layout}[xstacked]")
    fc.append("[xstacked]pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black[vout]")

    # Mix audio from all real video inputs
    audio_refs = "".join(f"[{i}:a]" for i in range(n))
    fc.append(f"{audio_refs}amix=inputs={n}:normalize=0[aout]")

    cmd += ["-filter_complex", ";".join(fc)]
    cmd += ["-map", "[vout]", "-map", "[aout]"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "20"]
    cmd += ["-c:a", "aac", "-b:a", "320k"]
    cmd += ["-movflags", "+faststart", "-shortest"]
    cmd += [str(output_path)]
    return cmd


async def _run_grid_export(session_id: str, video_paths: list[Path], output_path: Path):
    try:
        cmd = _build_export_cmd(video_paths, output_path)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            logger.error("Grid export failed (%s): %s", session_id, stderr.decode()[-2000:])
    except Exception as e:
        logger.error("Grid export error (%s): %s", session_id, e)
    finally:
        _export_tasks.discard(session_id)


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request, _: None = Depends(require_host)):
    sessions = list_sessions()
    session_files = {s.id: _get_session_files(s) for s in sessions}
    session_video_count = {
        s.id: sum(1 for f in session_files[s.id] if f["type"] == "video")
        for s in sessions
    }
    return templates.TemplateResponse(
        request, "dashboard.html",
        {
            "sessions": sessions,
            "session_files": session_files,
            "session_video_count": session_video_count,
        },
    )


@router.post("/api/session/{session_id}/export-grid")
async def start_grid_export(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session_id in _export_tasks:
        return JSONResponse({"status": "processing"})

    video_paths = _collect_video_paths(session)
    if len(video_paths) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 video files for grid export")

    output_path = Path(settings.recordings_dir) / session.dir_name / "video_grid.mp4"
    output_path.unlink(missing_ok=True)

    _export_tasks.add(session_id)
    task = asyncio.create_task(_run_grid_export(session_id, video_paths, output_path))
    _export_task_refs.add(task)
    task.add_done_callback(_export_task_refs.discard)

    return JSONResponse({"status": "processing"})


@router.get("/api/session/{session_id}/export-status")
async def grid_export_status(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    recordings_path = Path(settings.recordings_dir)
    output_path = recordings_path / session.dir_name / "video_grid.mp4"

    if session_id in _export_tasks:
        return JSONResponse({"status": "processing"})
    if output_path.exists():
        size_mb = round(output_path.stat().st_size / (1024 * 1024), 1)
        return JSONResponse({
            "status": "ready",
            "path": str(output_path.relative_to(recordings_path)),
            "size_mb": size_mb,
        })
    return JSONResponse({"status": "idle"})


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
