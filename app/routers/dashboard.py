import asyncio
import math
import os
import re
import tempfile
import time
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

_VALID_MEDIA_RE = re.compile(r"^[A-Za-z0-9_.-]+\.(wav|mp4|txt)$")

_export_tasks: set[str] = set()          # session IDs currently exporting
_export_task_refs: set[asyncio.Task] = set()  # keep tasks alive
_export_progress: dict[str, dict] = {}  # session_id → progress info


def _safe_name(value: str) -> str:
    return "".join(c if c.isalnum() or c in "- " else "_" for c in value).strip()

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
templates.env.globals["asset_v"] = ASSET_VERSION


def _collect_video_groups(session) -> list[list[Path]]:
    """Return all assembled video*.mp4 per participant, grouped by participant.

    Each inner list contains one or more epoch-tagged files in chronological
    order (base-36 epoch strings sort chronologically as strings).
    """
    recordings_path = Path(settings.recordings_dir)
    session_path = recordings_path / session.dir_name
    groups = []
    if not session_path.is_dir():
        return groups
    for pdir in sorted(session_path.iterdir()):
        if not pdir.is_dir():
            continue
        vfiles = sorted([
            f for f in pdir.iterdir()
            if f.is_file()
            and f.suffix == ".mp4"
            and (f.stem == "video" or f.stem.startswith("video_") or f.stem.endswith("_video"))
            and "_noaudio" not in f.stem
            and "_source" not in f.stem
        ])
        if vfiles:
            groups.append(vfiles)
    return groups


async def _concat_takes(paths: list[Path]) -> Path:
    """Stream-copy multiple mp4 takes into a single temp mp4 (no re-encode)."""
    list_fd, list_path = tempfile.mkstemp(suffix=".txt", prefix="pb_concat_list_")
    out_fd, out_path = tempfile.mkstemp(suffix=".mp4", prefix="pb_concat_")
    os.close(out_fd)
    try:
        with os.fdopen(list_fd, "w") as f:
            for p in paths:
                f.write(f"file '{p}'\n")
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", list_path,
            "-c", "copy",
            out_path,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"Concat failed: {stderr.decode()[-1000:]}")
        return Path(out_path)
    except Exception:
        Path(out_path).unlink(missing_ok=True)
        raise
    finally:
        Path(list_path).unlink(missing_ok=True)


def _build_export_cmd(video_paths: list[Path], output_path: Path, speakers: list[str] | None = None) -> list[str]:
    n = len(video_paths)
    if speakers is None:
        speakers = [vp.parent.name for vp in video_paths]
    cmd = ["ffmpeg", "-y"]
    for vp in video_paths:
        cmd += ["-i", str(vp)]

    if n == 1:
        cmd += [
            "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "320k",
            "-metadata:s:a:0", f"title={speakers[0]}",
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

    # Track 0: mixed audio from all speakers
    audio_refs = "".join(f"[{i}:a]" for i in range(n))
    fc.append(f"{audio_refs}amix=inputs={n}:normalize=0[aout]")

    cmd += ["-filter_complex", ";".join(fc)]
    cmd += ["-map", "[vout]", "-map", "[aout]"]
    # Tracks 1..n: per-speaker audio
    for i in range(n):
        cmd += ["-map", f"{i}:a"]

    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "20"]
    cmd += ["-c:a", "aac", "-b:a", "320k"]
    cmd += ["-metadata:s:a:0", "title=Mixed"]
    for i, name in enumerate(speakers):
        cmd += [f"-metadata:s:a:{i + 1}", f"title={name}"]
    cmd += ["-movflags", "+faststart", "-shortest"]
    cmd += [str(output_path)]
    return cmd


async def _probe_duration(path: Path) -> float:
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        return float(stdout.decode().strip() or 0)
    except Exception:
        return 0.0


async def _run_grid_export(session_id: str, video_groups: list[list[Path]], output_path: Path):
    progress_file = Path(f"/tmp/pb_progress_{session_id}")
    tmp_files: list[Path] = []
    try:
        resolved: list[Path] = []
        speaker_names: list[str] = []
        for group in video_groups:
            speaker_names.append(group[0].parent.name)
            if len(group) == 1:
                resolved.append(group[0])
            else:
                logger.info("Concatenating %d takes for %s", len(group), group[0].parent.name)
                tmp = await _concat_takes(group)
                tmp_files.append(tmp)
                resolved.append(tmp)

        durations = [await _probe_duration(p) for p in resolved]
        total_duration = max(durations) if durations else 0.0

        cmd = _build_export_cmd(resolved, output_path, speakers=speaker_names)
        # Insert -progress flag right after 'ffmpeg -y'
        cmd = [cmd[0], cmd[1], "-progress", str(progress_file)] + cmd[2:]

        _export_progress[session_id] = {
            "start": time.time(),
            "total": total_duration,
            "file": str(progress_file),
        }

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
        for f in tmp_files:
            f.unlink(missing_ok=True)
        progress_file.unlink(missing_ok=True)
        _export_progress.pop(session_id, None)
        _export_tasks.discard(session_id)


@router.get("/api/session/{session_id}/export-progress")
async def grid_export_progress(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session_id not in _export_tasks:
        return JSONResponse({"active": False})

    info = _export_progress.get(session_id)
    if not info:
        return JSONResponse({"active": True, "pct": 0, "elapsed_s": 0, "speed": 0, "remaining_s": None})

    elapsed_s = time.time() - info["start"]
    total_duration = info["total"]
    progress_path = Path(info["file"])

    out_time_us = 0.0
    speed = 0.0
    try:
        if progress_path.exists():
            content = progress_path.read_text()
            for line in content.splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip()
                    if k == "out_time_us":
                        try:
                            out_time_us = float(v)
                        except ValueError:
                            pass
                    elif k == "speed":
                        try:
                            speed = float(v.rstrip("x"))
                        except ValueError:
                            pass
    except Exception:
        pass

    out_time_s = out_time_us / 1_000_000
    pct = 0.0
    remaining_s = None
    if total_duration > 0:
        pct = min(99.0, out_time_s / total_duration * 100)
        if speed > 0:
            remaining_s = (total_duration - out_time_s) / speed

    return JSONResponse({
        "active": True,
        "pct": round(pct, 1),
        "elapsed_s": round(elapsed_s, 1),
        "speed": round(speed, 2),
        "remaining_s": round(remaining_s, 0) if remaining_s is not None else None,
    })


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
            "retention_days": settings.retention_days,
        },
    )


@router.post("/api/session/{session_id}/export-grid")
async def start_grid_export(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session_id in _export_tasks:
        return JSONResponse({"status": "processing"})

    video_groups = _collect_video_groups(session)
    if len(video_groups) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 participants with video for grid export")

    output_path = Path(settings.recordings_dir) / session.dir_name / "video_grid.mp4"
    output_path.unlink(missing_ok=True)

    _export_tasks.add(session_id)
    task = asyncio.create_task(_run_grid_export(session_id, video_groups, output_path))
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


def _parse_take(stem: str, ftype: str) -> int | None:
    """Extract take number from a slug-based filename stem, e.g. Alice_1 → 1, Alice_1_video → 1."""
    try:
        base = stem
        if ftype in ("video", "screen"):
            suffix = f"_{ftype}"
            if stem.endswith(suffix):
                base = stem[: -len(suffix)]
            else:
                return None
        parts = base.rsplit("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            return int(parts[1])
    except Exception:
        pass
    return None


def _get_session_files(session) -> list[dict]:
    """Find assembled files for a session — includes epoch-named files from reconnection runs."""
    recordings_path = Path(settings.recordings_dir)
    session_path = recordings_path / session.dir_name
    files = []

    if not session_path.is_dir():
        return files

    # Topic marker .txt files live directly in the session root (not per-participant)
    for fpath in sorted(session_path.glob("*.txt")):
        if not fpath.is_file():
            continue
        files.append({
            "participant": "",
            "type": "marker",
            "take": None,
            "filename": fpath.name,
            "path": str(fpath.relative_to(recordings_path)),
            "size_mb": None,
        })

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
            # Old epoch names: audio_<epoch>.wav, video_<epoch>.mp4, screen_<epoch>.mp4
            # New slug names:  <Slug>_<take>.wav, <Slug>_<take>_video.mp4, <Slug>_<take>_screen.mp4
            if fpath.suffix == ".wav":
                ftype = "audio"
            elif stem == "video" or stem.startswith("video_") or stem.endswith("_video"):
                ftype = "video"
            elif stem == "screen" or stem.startswith("screen_") or stem.endswith("_screen"):
                ftype = "screen"
            else:
                continue
            size_mb = fpath.stat().st_size / (1024 * 1024)
            files.append({
                "participant": participant_dir.name,
                "type": ftype,
                "take": _parse_take(stem, ftype),
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
                # Markers have no participant subdirectory — put them at the zip root
                arc_name = f["filename"] if f["type"] == "marker" else f"{f['participant']}/{f['filename']}"
                zf.write(str(base / f["path"]), arc_name)

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
