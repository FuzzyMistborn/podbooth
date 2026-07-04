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
import json
import logging
import re
import time
import uuid
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

# Directory+epoch keys with an audio+video merge (ffmpeg mux) currently
# running. assembly_status checks this so it doesn't report "done" — and let
# the client probe files for verify-recordings — while the final video is
# still being written.
_merge_in_progress: set[str] = set()


def is_merging(directory: Path) -> bool:
    """True if any epoch under this directory currently has a merge running."""
    prefix = f"{directory}|"
    return any(key.startswith(prefix) for key in _merge_in_progress)

# Tracks (str(directory), track_type, epoch) tuples currently being assembled.
# Prevents recover_orphaned_chunks from queuing duplicate tasks while ffmpeg runs.
_assembly_in_progress: set[tuple[str, str, str]] = set()

# How long a (track_type, epoch) group's chunk files must sit untouched before
# recover_orphaned_chunks will treat it as abandoned rather than mid-upload.
# A single hung attempt can legitimately leave the file untouched for close to
# CHUNK_UPLOAD_TIMEOUT_MS (60s in upload.js) plus up to 15s of backoff before
# the next attempt starts writing again — call it ~75s worst case for one
# retry cycle. This threshold needs comfortable margin above that so a
# still-retrying (not crashed) client isn't mistaken for abandoned mid-upload.
ORPHAN_IDLE_THRESHOLD_S = 180

# Take-number assignment: maps (dir, epoch) → (slug, take) so all tracks for
# the same recording run share a consistent take number.
_epoch_take_map: dict[tuple[str, str], tuple[str, int]] = {}
_dir_take_counter: dict[tuple[str, str], int] = {}  # (dir, slug) → last assigned take
_take_lock = asyncio.Lock()
_metadata_lock = asyncio.Lock()

# Epoch is client-supplied and ends up in filenames and glob patterns, so it
# must never contain path separators or glob metacharacters.
_EPOCH_RE = re.compile(r"^[A-Za-z0-9]{0,64}$")

# Doubles as the cap for a File System Access whole-recording upload (see
# fsa-store.js), which arrives as a single "chunk 0" rather than many small
# MediaRecorder-timeslice pieces — a long take can be several GB.
_MAX_CHUNK_BYTES = 20 * 1024 * 1024 * 1024  # 20 GB

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


_CHUNK_INDEX_RE = re.compile(r'_chunk_(\d+)\.')


def _find_missing_chunk_indices(chunks: list[Path]) -> list[int]:
    """Given chunk files sorted by name, return any gaps in the 0..N index sequence."""
    indices = []
    for c in chunks:
        m = _CHUNK_INDEX_RE.search(c.name)
        if m:
            indices.append(int(m.group(1)))
    if not indices:
        return []
    indices.sort()
    return [i for i in range(indices[0], indices[-1] + 1) if i not in indices]


def _oname(base: str, epoch: str, ext: str, mid: str = "") -> str:
    """Build output filename with optional epoch tag and middle suffix.
    e.g. _oname("audio","abc","wav") → "audio_abc.wav"
         _oname("video","abc","mp4","_noaudio") → "video_abc_noaudio.mp4" """
    if epoch:
        return f"{base}_{epoch}{mid}.{ext}"
    return f"{base}{mid}.{ext}"


def _display_slug(name: str) -> str:
    """Sanitize a display name for use in filenames (e.g. 'Alice Smith' → 'Alice_Smith')."""
    slug = re.sub(r'[^A-Za-z0-9]+', '_', name).strip('_')
    return slug[:40] or 'participant'


async def _assign_take(directory: Path, epoch: str, participant: str) -> tuple[str, int] | None:
    """Return (slug, take_number) for this (directory, epoch), or None if no participant.

    All tracks in the same recording run share an epoch, so they always get the
    same take number.  The counter is seeded from the filesystem on first use so
    a server restart doesn't re-use take numbers.
    """
    if not participant:
        return None
    async with _take_lock:
        key = (str(directory), epoch)
        if key in _epoch_take_map:
            return _epoch_take_map[key]

        slug = _display_slug(participant)
        dir_slug = (str(directory), slug)

        if dir_slug not in _dir_take_counter:
            # Seed from disk: count completed output files for any track type.
            existing = max(
                len(list(directory.glob(f"{slug}_*.wav"))),
                len(list(directory.glob(f"{slug}_*_video.mp4"))),
                len(list(directory.glob(f"{slug}_*_screen.mp4"))),
            )
            _dir_take_counter[dir_slug] = existing

        take = _dir_take_counter[dir_slug] + 1
        _dir_take_counter[dir_slug] = take
        _epoch_take_map[key] = (slug, take)
        return slug, take


def _final_name(track_type: str, slug: str, take: int, ext: str) -> str:
    """Build the final output filename: '{slug}_{take}.ext' for audio, '{slug}_{take}_{type}.ext' for video/screen."""
    if track_type == "audio":
        return f"{slug}_{take}.{ext}"
    return f"{slug}_{take}_{track_type}.{ext}"


def _safe_name(value: str) -> str:
    return "".join(c if c.isalnum() or c in "- " else "_" for c in value).strip()


def _decode_epoch_ms(epoch: str) -> int | None:
    """Decode a base-36 JS Date.now() epoch string to milliseconds."""
    try:
        return int(epoch, 36)
    except Exception:
        return None


async def _save_run_metadata(
    part_dir: Path,
    epoch_ms: int,
    nametake: tuple[str, int],
    track_type: str,
    filename: str,
    expected_duration_s: float | None = None,
):
    """Append/update recording start-time metadata in the session directory."""
    session_dir = part_dir.parent
    metadata_path = session_dir / "recording_metadata.json"
    slug, take = nametake
    participant = part_dir.name

    async with _metadata_lock:
        data: dict = {}
        if metadata_path.exists():
            try:
                data = json.loads(metadata_path.read_text())
            except Exception:
                data = {}

        runs: list = data.setdefault("runs", [])
        run = next((r for r in runs if r["slug"] == slug and r["take"] == take), None)
        if run is None:
            run = {"participant": participant, "slug": slug, "take": take,
                   "start_ms": epoch_ms, "tracks": {}}
            runs.append(run)

        run["tracks"][track_type] = filename
        # Client-reported capture duration, used by verify-recordings to catch
        # truncated output (e.g. one dropped/short chunk with no missing index)
        # that ffprobe's absolute empty/very-short heuristic alone can't see.
        if expected_duration_s is not None:
            run.setdefault("durations", {})[filename] = expected_duration_s
        metadata_path.write_text(json.dumps(data, indent=2))


def participant_dir(session, participant: str, identity: str = "") -> Path:
    name = _display_slug(participant) if participant else _safe_name(identity or "")
    if not name:
        raise HTTPException(status_code=400, detail="Invalid participant name")
    path = Path(settings.recordings_dir) / session.dir_name / name
    path.mkdir(parents=True, exist_ok=True)
    return path


@router.get("/chunks")
async def get_chunk_progress(
    session_id: str,
    identity: str = "",
    participant: str = "",
    track_type: str = "",
    epoch: str = "",
):
    """Return the next chunk index to use for a resumable upload."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if track_type not in ("audio", "video", "screen"):
        raise HTTPException(status_code=400, detail="Invalid track_type")
    _validate_epoch(epoch)

    # Must match participant_dir's naming exactly (participant/display-name
    # slug takes priority over identity) or this looks in the wrong directory
    # and always reports next_chunk=0 even when chunks already landed.
    name = _display_slug(participant) if participant else _safe_name(identity or "")
    if not name:
        return JSONResponse({"next_chunk": 0})

    directory = Path(settings.recordings_dir) / session.dir_name / name
    if not directory.is_dir():
        return JSONResponse({"next_chunk": 0})

    max_index = -1
    for f in directory.iterdir():
        if not f.is_file():
            continue
        m = _CHUNK_SCAN_RE.match(f.name)
        if not m:
            continue
        if m.group(1) != track_type:
            continue
        file_epoch = m.group(2) or ""
        if file_epoch != epoch:
            continue
        # Extract chunk index from the filename
        idx_match = re.search(r'_chunk_(\d+)\.', f.name)
        if idx_match:
            max_index = max(max_index, int(idx_match.group(1)))

    return JSONResponse({"next_chunk": max_index + 1})


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
    expected_size: int = Form(default=-1),  # client-reported blob.size; -1 means unknown/old client
    file: UploadFile = File(...),
):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if track_type not in ("audio", "video", "screen"):
        raise HTTPException(status_code=400, detail="Invalid track_type")
    if ext not in ("raw", "webm", "mp4"):
        raise HTTPException(status_code=400, detail="Invalid ext")
    if chunk_index < 0:
        raise HTTPException(status_code=400, detail="Invalid chunk_index")
    _validate_epoch(epoch)

    directory = participant_dir(session, participant, identity)
    prefix = f"{track_type}_{epoch}_" if epoch else f"{track_type}_"
    chunk_path = directory / f"{prefix}chunk_{chunk_index:06d}.{ext}"

    # Stream to disk rather than `await file.read()` — a normal MediaRecorder
    # chunk is a few MB, but a File System Access whole-recording upload (see
    # fsa-store.js) can be many GB, and buffering that entirely in memory
    # before writing a single byte would be a self-inflicted OOM.
    size = 0
    # Leading dot keeps this out of the chunk_* glob patterns assemble_track
    # and recover_orphaned_chunks use — a large (FSA whole-file) upload can
    # take a while to stream in, and either of those matching a still-being-
    # written file would be the same premature-assembly race fixed above. A
    # random suffix per request (rather than a name derived only from
    # track/epoch/chunk_index) keeps a client retry that fires while the
    # original, still-in-flight request is mid-write from truncating/racing
    # on the same file — each attempt gets its own temp file, and only the
    # attempt that actually finishes and passes validation gets renamed into
    # the real chunk_path.
    tmp_path = chunk_path.with_name(f".{chunk_path.name}.{uuid.uuid4().hex}.part")
    try:
        async with aiofiles.open(tmp_path, "wb") as f:
            while True:
                piece = await file.read(8 * 1024 * 1024)
                if not piece:
                    break
                size += len(piece)
                if size > _MAX_CHUNK_BYTES:
                    raise HTTPException(status_code=413, detail="Chunk exceeds size limit")
                await f.write(piece)
    except HTTPException:
        tmp_path.unlink(missing_ok=True)
        raise

    if size == 0:
        tmp_path.unlink(missing_ok=True)
        logger.info("chunk skip empty: %s/%s #%d", track_type, participant, chunk_index)
        return JSONResponse({"ok": True, "chunk": chunk_index, "skipped": "empty"})
    if expected_size >= 0 and size != expected_size:
        # Bytes arrived but don't match what the browser actually sent — a
        # truncating proxy or a flaky connection can still return 200/close
        # cleanly despite dropping part of the body. Reject so the client's
        # existing retry loop resends the chunk instead of writing a corrupt
        # (short) chunk file that assembly would silently include.
        tmp_path.unlink(missing_ok=True)
        logger.error(
            "chunk size mismatch: %s/%s #%d expected=%d got=%d",
            track_type, participant, chunk_index, expected_size, size,
        )
        raise HTTPException(status_code=400, detail="Chunk size mismatch")

    tmp_path.rename(chunk_path)
    logger.info("chunk saved: %s/%s #%d size=%d epoch=%r", track_type, participant, chunk_index, size, epoch)
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
    try:
        sample_rate = int(data.get("sample_rate") or 48000)
        channels = int(data.get("channels") or 1)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid sample_rate or channels")
    if not (1 <= sample_rate <= 384000):
        raise HTTPException(status_code=400, detail="sample_rate out of range (1–384000)")
    if not (1 <= channels <= 8):
        raise HTTPException(status_code=400, detail="channels out of range (1–8)")
    try:
        expected_duration_s = data.get("expected_duration_s")
        expected_duration_s = float(expected_duration_s) if expected_duration_s is not None else None
    except (TypeError, ValueError):
        expected_duration_s = None

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if track_type not in ("audio", "video", "screen"):
        raise HTTPException(status_code=400, detail="Invalid track_type")
    _validate_epoch(epoch)

    directory = participant_dir(session, participant, identity)

    # Persist start_time_ms so _try_merge_av can align audio to video.
    start_time_ms = data.get("start_time_ms")
    if start_time_ms is not None and epoch:
        try:
            start_time_ms = float(start_time_ms)
            sidecar = directory / f"{track_type}_{epoch}_start.json"
            sidecar.write_text(json.dumps({"start_time_ms": start_time_ms}))
        except (TypeError, ValueError, OSError):
            start_time_ms = None

    logger.info("finalize: %s/%s epoch=%r fmt=%s start_time_ms=%s", track_type, participant, epoch, fmt, start_time_ms)
    in_progress_key = (str(directory), track_type, epoch)
    if in_progress_key not in _assembly_in_progress:
        _assembly_in_progress.add(in_progress_key)
        task = asyncio.create_task(
            assemble_track(directory, track_type, fmt, sample_rate, channels, epoch, session_id, participant,
                           expected_duration_s)
        )
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
        task.add_done_callback(lambda _t, k=in_progress_key: _assembly_in_progress.discard(k))

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
    expected_duration_s: float | None = None,
):
    nametake = await _assign_take(directory, epoch, participant)

    prefix = f"{track_type}_{epoch}_" if epoch else f"{track_type}_"
    chunks = sorted(directory.glob(f"{prefix}chunk_*"))
    if not chunks:
        logger.warning("assemble: no chunks found in %s for %s epoch=%r", directory, track_type, epoch)
        return

    total_bytes = sum(c.stat().st_size for c in chunks)
    logger.info("assemble: %s/%s epoch=%r chunks=%d total_bytes=%d files=%s",
                track_type, directory.name, epoch, len(chunks), total_bytes,
                [c.name for c in chunks])

    epoch_tag = f"_{epoch}" if epoch else ""

    missing = _find_missing_chunk_indices(chunks)
    if missing:
        logger.error(
            "assemble: %s/%s epoch=%r is missing chunk index(es) %s — "
            "source will be corrupt/discontinuous",
            track_type, directory.name, epoch, missing,
        )
        marker = directory / f"{track_type}{epoch_tag}_MISSING_CHUNKS.txt"
        marker.write_text(f"missing chunk indices: {missing}\n")

    # Byte-concatenate chunks in index order into one source file.
    source_ext = chunks[0].suffix  # .raw / .webm / .mp4
    source = directory / f"{track_type}{epoch_tag}_source{source_ext}"
    async with aiofiles.open(source, "wb") as out:
        for chunk in chunks:
            async with aiofiles.open(chunk, "rb") as f:
                await out.write(await f.read())

    if track_type == "audio":
        if nametake:
            output = directory / _final_name("audio", *nametake, "wav")
        else:
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
            logger.info("assemble: audio output %s size=%d", output.name, output.stat().st_size)
            for chunk in chunks:
                chunk.unlink(missing_ok=True)
            source.unlink(missing_ok=True)
            await _try_merge_av(directory, epoch, nametake)
            if epoch and nametake:
                epoch_ms = _decode_epoch_ms(epoch)
                if epoch_ms is not None:
                    await _save_run_metadata(directory, epoch_ms, nametake, "audio", output.name, expected_duration_s)
        else:
            logger.error("assemble: audio ffmpeg failed for %s/%s", directory.name, epoch)
            source.rename(source.with_suffix(source.suffix + ".failed"))

    elif track_type == "video":
        # Keep epoch-based name for the intermediate (no-audio) file.
        noaudio = directory / _oname("video", epoch, "mp4", "_noaudio")
        codec = await _probe_video_codec(source)
        if codec == "h264":
            cmd = [
                "ffmpeg", "-y",
                "-fflags", "+genpts+discardcorrupt",
                "-err_detect", "ignore_err",
                "-i", str(source),
                "-c:v", "copy",
                "-an",
                "-movflags", "+faststart",
                str(noaudio),
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-fflags", "+genpts+discardcorrupt",
                "-err_detect", "ignore_err",
                "-i", str(source),
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-an",
                "-movflags", "+faststart",
                str(noaudio),
            ]
        ok = await _run_ffmpeg(cmd, directory, track_type)
        if ok:
            ok = await _probe_has_video(noaudio)
            if not ok:
                logger.error("assemble: video noaudio %s exists but has no readable video stream — keeping source", noaudio.name)
            else:
                logger.info("assemble: video noaudio %s size=%d", noaudio.name, noaudio.stat().st_size)
                for chunk in chunks:
                    chunk.unlink(missing_ok=True)
                source.unlink(missing_ok=True)
            await _try_merge_av(directory, epoch, nametake)
            if epoch and nametake:
                epoch_ms = _decode_epoch_ms(epoch)
                if epoch_ms is not None:
                    final_video = _final_name("video", nametake[0], nametake[1], "mp4") if nametake else _oname("video", epoch, "mp4")
                    await _save_run_metadata(directory, epoch_ms, nametake, "video", final_video, expected_duration_s)
        else:
            logger.error("assemble: video ffmpeg failed for %s/%s", directory.name, epoch)
            source.rename(source.with_suffix(source.suffix + ".failed"))

    else:  # screen
        if nametake:
            output = directory / _final_name("screen", *nametake, "mp4")
        else:
            output = directory / _oname("screen", epoch, "mp4")
        codec = await _probe_video_codec(source)
        if codec == "h264":
            cmd = [
                "ffmpeg", "-y",
                "-fflags", "+genpts+discardcorrupt",
                "-err_detect", "ignore_err",
                "-i", str(source),
                "-c:v", "copy",
                "-an",
                "-movflags", "+faststart",
                str(output),
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-fflags", "+genpts+discardcorrupt",
                "-err_detect", "ignore_err",
                "-i", str(source),
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-an",
                "-movflags", "+faststart",
                str(output),
            ]
        ok = await _run_ffmpeg(cmd, directory, track_type)
        if ok:
            logger.info("assemble: screen output %s size=%d", output.name, output.stat().st_size)
            for chunk in chunks:
                chunk.unlink(missing_ok=True)
            source.unlink(missing_ok=True)
            if epoch and nametake:
                epoch_ms = _decode_epoch_ms(epoch)
                if epoch_ms is not None:
                    await _save_run_metadata(directory, epoch_ms, nametake, "screen", output.name, expected_duration_s)
        else:
            logger.error("assemble: screen ffmpeg failed for %s/%s", directory.name, epoch)
            source.rename(source.with_suffix(source.suffix + ".failed"))


async def _try_merge_av(directory: Path, epoch: str = "", nametake=None):
    """Merge epoch-matched video_noaudio + audio → video once both are ready."""
    key = f"{directory}|{epoch}"
    if key not in _merge_locks:
        _merge_locks[key] = asyncio.Lock()

    async with _merge_locks[key]:
        if nametake:
            audio = directory / _final_name("audio", *nametake, "wav")
            video_out = directory / _final_name("video", *nametake, "mp4")
        else:
            audio = directory / _oname("audio", epoch, "wav")
            video_out = directory / _oname("video", epoch, "mp4")
        video_noaudio = directory / _oname("video", epoch, "mp4", "_noaudio")

        if not audio.exists() or not video_noaudio.exists():
            logger.info("merge_av: skipping — audio=%s video_noaudio=%s",
                        audio.exists(), video_noaudio.exists())
            return
        if not await _probe_has_video(video_noaudio):
            logger.error("merge_av: %s is not a readable video file (moov atom missing or corrupt) — skipping merge",
                         video_noaudio.name)
            return
        if video_out.exists():
            return
        # Compute A/V start-time offset so the merge is temporally aligned.
        # Both timestamps come from performance.now() on the same client machine,
        # so their difference is the real delay between when video and audio
        # capture began. A positive offset means audio started later than video.
        audio_offset_ms = 0.0
        if epoch:
            try:
                v_meta = json.loads((directory / f"video_{epoch}_start.json").read_text())
                a_meta = json.loads((directory / f"audio_{epoch}_start.json").read_text())
                audio_offset_ms = a_meta["start_time_ms"] - v_meta["start_time_ms"]
            except (FileNotFoundError, KeyError, ValueError, OSError):
                audio_offset_ms = 0.0
        logger.info("merge_av: merging %s + %s → %s (audio_offset_ms=%.1f)",
                    audio.name, video_noaudio.name, video_out.name, audio_offset_ms)

        if audio_offset_ms > 0:
            # Audio started later: pad the front of the audio stream.
            cmd = [
                "ffmpeg", "-y",
                "-i", str(video_noaudio),
                "-i", str(audio),
                "-c:v", "copy",
                "-filter:a", f"adelay={audio_offset_ms:.0f}:all=1",
                "-c:a", "aac", "-b:a", "320k",
                "-movflags", "+faststart",
                str(video_out),
            ]
        elif audio_offset_ms < 0:
            # Audio started earlier: trim the head of the audio stream.
            trim_s = -audio_offset_ms / 1000.0
            cmd = [
                "ffmpeg", "-y",
                "-i", str(video_noaudio),
                "-ss", f"{trim_s:.6f}",
                "-i", str(audio),
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "320k",
                "-movflags", "+faststart",
                str(video_out),
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-i", str(video_noaudio),
                "-i", str(audio),
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "320k",
                "-movflags", "+faststart",
                str(video_out),
            ]
        _merge_in_progress.add(key)
        try:
            ok = await _run_ffmpeg(cmd, directory, "merge")
        finally:
            _merge_in_progress.discard(key)
        if ok:
            logger.info("merge_av: done %s size=%d", video_out.name, video_out.stat().st_size)
            video_noaudio.unlink(missing_ok=True)
            for track in ("audio", "video"):
                (directory / f"{track}_{epoch}_start.json").unlink(missing_ok=True)
            _merge_locks.pop(key, None)
        else:
            logger.error("merge_av: ffmpeg failed for %s", video_out.name)


async def recover_orphaned_chunks(session) -> int:
    """
    Scan participant dirs for chunk sets that were never finalized — e.g. the
    client crashed or closed the browser before /finalize was sent. Queues
    assembly for each orphaned (track_type, epoch) group found. The filesystem
    scan is fast; actual assembly runs in background tasks tracked by _tasks.
    Returns the number of tracks queued.

    Skipped entirely while the session is actively recording: recording is
    local-only until stop (see upload.js/_uploadAllRecordedChunks), so every
    chunk on disk for the live epoch is legitimately unfinalized for the
    whole recording, not abandoned. Without this guard, anything that hits
    /api/session/{id}/recordings mid-recording (e.g. opening the Files
    panel) would "recover" an in-progress take early, consuming its chunks
    (including the container track's header, chunk 0) and leaving every
    chunk captured afterward assembled without one — corrupting the file.
    session.recording flips False as soon as stop is requested — but the
    client's own post-stop upload pass (_uploadAllRecordedChunks in
    upload.js) then sends that track's chunks to the server one at a time,
    so there's still a window, after stop, where chunks for a live epoch
    keep landing on disk well before /finalize arrives. Guarding on
    session.recording alone doesn't cover that window, so a group is also
    only treated as orphaned once none of its chunk files have been
    touched recently — actively-uploading chunks keep pushing that
    timestamp forward, so recovery only fires once the client has genuinely
    gone quiet (crashed, closed tab) rather than just being mid-upload.
    """
    if session.recording:
        return 0

    recordings_dir = Path(settings.recordings_dir) / session.dir_name
    if not recordings_dir.is_dir():
        return 0

    queued = 0
    now = time.time()
    for pdir in recordings_dir.iterdir():
        if not pdir.is_dir():
            continue

        pending: dict[tuple[str, str], tuple[str, float]] = {}  # (track_type, epoch) → (ext, latest_mtime)
        for f in pdir.iterdir():
            if not f.is_file():
                continue
            m = _CHUNK_SCAN_RE.match(f.name)
            if not m:
                continue
            track_type = m.group(1)
            epoch = m.group(2) or ""
            ext = m.group(3)
            mtime = f.stat().st_mtime
            key = (track_type, epoch)
            prev = pending.get(key)
            pending[key] = (ext, max(mtime, prev[1]) if prev else mtime)

        for (track_type, epoch), (ext, latest_mtime) in pending.items():
            if now - latest_mtime < ORPHAN_IDLE_THRESHOLD_S:
                continue
            in_progress_key = (str(pdir), track_type, epoch)
            if in_progress_key in _assembly_in_progress:
                continue
            epoch_tag = f"_{epoch}" if epoch else ""
            source_glob = f"{track_type}{epoch_tag}_source*.failed"
            if any(pdir.glob(source_glob)):
                continue
            fmt = "pcm" if ext == "raw" else "container"
            logger.info(
                "Recovering orphaned %s chunks in %s/%s (epoch=%r)",
                track_type, session.dir_name, pdir.name, epoch,
            )
            _assembly_in_progress.add(in_progress_key)
            task = asyncio.create_task(
                assemble_track(pdir, track_type, fmt, 48000, 2, epoch, session.id, "")
            )
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
            task.add_done_callback(lambda _t, k=in_progress_key: _assembly_in_progress.discard(k))
            queued += 1

    return queued


async def _probe_has_video(path: Path) -> bool:
    """Return True if ffprobe can open the file and finds at least one video stream."""
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_type",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        return stdout.decode().strip() == "video"
    except Exception:
        return False


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
