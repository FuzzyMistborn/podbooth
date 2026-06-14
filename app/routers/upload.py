"""
Chunked upload + final assembly.

How assembly works:
  MediaRecorder chunks (after the first) are NOT standalone files — they are a
  continuation of one bytestream. So we byte-concatenate all chunks in index
  order into a single source file, then run ffmpeg ONCE on that file.

  Raw PCM audio (from the AudioWorklet capture path) is interleaved float32;
  ffmpeg reads it with -f f32le and writes lossless 24-bit WAV.

  Video: assembled to video_noaudio.mp4 first (video-only). Once both
  audio.wav and video_noaudio.mp4 exist, they are merged into video.mp4
  (H.264 video + AAC audio). audio.wav is kept as a standalone lossless file.

  Screen: assembled to screen.mp4 (video-only, no audio mixing).
"""

import asyncio
import logging
import re
from pathlib import Path

import aiofiles
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.models import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/upload")

# Keep references to background tasks so they aren't garbage-collected mid-run
_tasks: set[asyncio.Task] = set()

# Per-directory+epoch locks so the merge step runs at most once per epoch.
_merge_locks: dict[str, asyncio.Lock] = {}

# Epoch is client-supplied and ends up in filenames and glob patterns, so it
# must never contain path separators or glob metacharacters.
_EPOCH_RE = re.compile(r"^[A-Za-z0-9_-]{0,64}$")

# Matches chunk files in both epoch and no-epoch forms:
#   audio_abc123_chunk_000000.raw   →  track=audio  epoch=abc123  ext=raw
#   audio_chunk_000000.raw          →  track=audio  epoch=None    ext=raw
# Epoch uses [A-Za-z0-9]+ (no underscores) to avoid ambiguity with _chunk_.
_CHUNK_SCAN_RE = re.compile(
    r'^(audio|video|screen)_(?:([A-Za-z0-9]+)_)?chunk_\d+\.(raw|webm|mp4)$'
)


def _validate_epoch(epoch) -> str:
    if not isinstance(epoch, str) or not _EPOCH_RE.match(epoch):
        raise HTTPException(status_code=400, detail="Invalid epoch")
    return epoch


def _oname(base: str, epoch: str, ext: str, mid: str = "") -> str:
    """Build output filename with optional epoch tag and middle suffix.
    e.g. _oname("audio","abc","wav") → "audio_abc.wav"
         _oname("video","abc","mp4","_noaudio") → "video_abc_noaudio.mp4" """
    if epoch:
        return f"{base}_{epoch}{mid}.{ext}"
    return f"{base}{mid}.{ext}"


def _safe_name(value: str) -> str:
    return "".join(c if c.isalnum() or c in "- " else "_" for c in value).strip()


def participant_dir(session, participant: str, identity: str = "") -> Path:
    # Prefer identity (unique per LiveKit connection) to avoid directory collisions
    # when two display names sanitize to the same string (e.g. "John?" and "John*"
    # both become "John_"). Identity already embeds the display name as a prefix.
    raw = identity if identity else participant
    name = _safe_name(raw)
    if not name:
        raise HTTPException(status_code=400, detail="Invalid participant name")
    path = Path(settings.recordings_dir) / session.dir_name / name
    path.mkdir(parents=True, exist_ok=True)
    return path


@router.post("/chunk")
async def upload_chunk(
    session_id: str = Form(...),
    participant: str = Form(...),
    identity: str = Form(default=""),  # LiveKit identity — unique, used for dir naming
    track_type: str = Form(...),       # "audio", "video", or "screen"
    chunk_index: int = Form(...),
    ext: str = Form(...),              # "raw" (pcm), "webm", or "mp4"
    epoch: str = Form(default=""),     # recording-run identifier to avoid chunk collisions
    chunk_meta: str = Form(default=""),  # optional JSON metadata (e.g. chunk_offset_s)
    file: UploadFile = File(...),
):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if track_type not in ("audio", "video", "screen"):
        raise HTTPException(status_code=400, detail="Invalid track_type")
    if ext not in ("raw", "webm", "mp4"):
        raise HTTPException(status_code=400, detail="Invalid ext")
    _validate_epoch(epoch)

    content = await file.read()
    if len(content) == 0:
        return JSONResponse({"ok": True, "chunk": chunk_index, "skipped": "empty"})

    directory = participant_dir(session, participant, identity)
    prefix = f"{track_type}_{epoch}_" if epoch else f"{track_type}_"
    chunk_path = directory / f"{prefix}chunk_{chunk_index:06d}.{ext}"

    async with aiofiles.open(chunk_path, "wb") as f:
        await f.write(content)

    return JSONResponse({"ok": True, "chunk": chunk_index})


@router.post("/finalize")
async def finalize_track(request: Request):
    """
    Called by the client AFTER all chunks for a track have finished uploading.
    Body: { session_id, participant, track_type,
            format: "pcm" | "container",
            epoch, ext, sample_rate?, channels? }
    """
    data = await request.json()
    session_id = data.get("session_id")
    participant = data.get("participant")
    identity = data.get("identity", "")
    track_type = data.get("track_type")
    fmt = data.get("format", "container")
    epoch = data.get("epoch", "")
    sample_rate = int(data.get("sample_rate") or 48000)
    channels = int(data.get("channels") or 1)

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if track_type not in ("audio", "video", "screen"):
        raise HTTPException(status_code=400, detail="Invalid track_type")
    _validate_epoch(epoch)

    directory = participant_dir(session, participant, identity)

    task = asyncio.create_task(
        assemble_track(directory, track_type, fmt, sample_rate, channels, epoch, session_id, participant)
    )
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)

    return JSONResponse({"ok": True, "assembling": True})


async def assemble_track(
    directory: Path,
    track_type: str,
    fmt: str,
    sample_rate: int,
    channels: int,
    epoch: str = "",
    session_id: str = "",
    participant: str = "",
):
    prefix = f"{track_type}_{epoch}_" if epoch else f"{track_type}_"
    chunks = sorted(directory.glob(f"{prefix}chunk_*"))
    if not chunks:
        logger.warning("No chunks to assemble in %s for %s", directory, track_type)
        return

    # Byte-concatenate chunks in index order into one source file.
    source_ext = chunks[0].suffix  # .raw / .webm / .mp4
    epoch_tag = f"_{epoch}" if epoch else ""
    source = directory / f"{track_type}{epoch_tag}_source{source_ext}"
    async with aiofiles.open(source, "wb") as out:
        for chunk in chunks:
            async with aiofiles.open(chunk, "rb") as f:
                await out.write(await f.read())

    if track_type == "audio":
        output = directory / _oname("audio", epoch, "wav")
        if fmt == "pcm":
            cmd = [
                "ffmpeg", "-y",
                "-f", "f32le",
                "-ar", str(sample_rate),
                "-ac", str(channels),
                "-i", str(source),
                "-c:a", "pcm_s24le",
                str(output),
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-i", str(source),
                "-vn",
                "-c:a", "pcm_s24le",
                "-ar", "48000",
                "-ac", "2",
                str(output),
            ]
        ok = await _run_ffmpeg(cmd, directory, track_type)
        if ok:
            for chunk in chunks:
                chunk.unlink(missing_ok=True)
            source.unlink(missing_ok=True)
            await _try_merge_av(directory, epoch)

    elif track_type == "video":
        noaudio = directory / _oname("video", epoch, "mp4", "_noaudio")
        codec = await _probe_video_codec(source)
        if codec == "h264":
            cmd = [
                "ffmpeg", "-y",
                "-fflags", "+genpts",
                "-i", str(source),
                "-c:v", "copy",
                "-an",
                "-movflags", "+faststart",
                str(noaudio),
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-fflags", "+genpts",
                "-i", str(source),
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-an",
                "-movflags", "+faststart",
                str(noaudio),
            ]
        ok = await _run_ffmpeg(cmd, directory, track_type)
        if ok:
            for chunk in chunks:
                chunk.unlink(missing_ok=True)
            source.unlink(missing_ok=True)
            await _try_merge_av(directory, epoch)

    else:  # screen
        output = directory / _oname("screen", epoch, "mp4")
        codec = await _probe_video_codec(source)
        if codec == "h264":
            cmd = [
                "ffmpeg", "-y",
                "-fflags", "+genpts",
                "-i", str(source),
                "-c:v", "copy",
                "-an",
                "-movflags", "+faststart",
                str(output),
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-fflags", "+genpts",
                "-i", str(source),
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-an",
                "-movflags", "+faststart",
                str(output),
            ]
        ok = await _run_ffmpeg(cmd, directory, track_type)
        if ok:
            for chunk in chunks:
                chunk.unlink(missing_ok=True)
            source.unlink(missing_ok=True)


async def _try_merge_av(directory: Path, epoch: str = ""):
    """Merge epoch-matched video_noaudio + audio → video once both are ready."""
    key = f"{directory}|{epoch}"
    if key not in _merge_locks:
        _merge_locks[key] = asyncio.Lock()

    async with _merge_locks[key]:
        audio = directory / _oname("audio", epoch, "wav")
        video_noaudio = directory / _oname("video", epoch, "mp4", "_noaudio")
        video_out = directory / _oname("video", epoch, "mp4")

        if not audio.exists() or not video_noaudio.exists():
            return
        if video_out.exists():
            return

        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_noaudio),
            "-i", str(audio),
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "320k",
            "-shortest",
            "-movflags", "+faststart",
            str(video_out),
        ]
        ok = await _run_ffmpeg(cmd, directory, "merge")
        if ok:
            video_noaudio.unlink(missing_ok=True)
            _merge_locks.pop(key, None)


async def recover_orphaned_chunks(session) -> int:
    """
    Scan participant dirs for chunk sets that were never finalized — e.g. the
    client crashed or closed the browser before /finalize was sent. Queues
    assembly for each orphaned (track_type, epoch) group found. The filesystem
    scan is fast; actual assembly runs in background tasks tracked by _tasks.
    Returns the number of tracks queued.
    """
    recordings_dir = Path(settings.recordings_dir) / session.dir_name
    if not recordings_dir.is_dir():
        return 0

    queued = 0
    for pdir in recordings_dir.iterdir():
        if not pdir.is_dir():
            continue

        pending: dict[tuple[str, str], str] = {}  # (track_type, epoch) → ext
        for f in pdir.iterdir():
            if not f.is_file():
                continue
            m = _CHUNK_SCAN_RE.match(f.name)
            if not m:
                continue
            track_type = m.group(1)
            epoch = m.group(2) or ""
            ext = m.group(3)
            pending.setdefault((track_type, epoch), ext)

        for (track_type, epoch), ext in pending.items():
            fmt = "pcm" if ext == "raw" else "container"
            logger.info(
                "Recovering orphaned %s chunks in %s/%s (epoch=%r)",
                track_type, session.dir_name, pdir.name, epoch,
            )
            task = asyncio.create_task(
                assemble_track(pdir, track_type, fmt, 48000, 2, epoch, session.id, "")
            )
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
            queued += 1

    return queued


async def _probe_video_codec(source: Path) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(source),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        return stdout.decode().strip()
    except Exception:
        return ""


async def _run_ffmpeg(cmd: list[str], directory: Path, track_type: str) -> bool:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            logger.error("ffmpeg failed (%s/%s): %s", directory.name, track_type, stderr.decode()[-2000:])
            return False
        return True
    except Exception as e:
        logger.error("Assembly failed (%s/%s): %s", directory.name, track_type, e)
        return False
