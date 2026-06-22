"""
Automatic transcription via a WhisperX-compatible API server.
Enabled only when WHISPERX_API_URL is set. Triggered when a session ends.

Each participant's audio is sent individually (no diarization needed — speaker
identity is already known from the recording directory structure). The per-track
verbose_json responses are merged chronologically into a single interleaved
transcript saved as transcript.txt in the session directory.
"""

import asyncio
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.config import settings
from app.models import get_session

logger = logging.getLogger(__name__)
router = APIRouter()

_transcribe_tasks: set[asyncio.Task] = set()
_session_transcribing: set[str] = set()


def _gather_participant_wavs(session_dir: Path) -> dict[str, list[Path]]:
    """Return {speaker_label: [wav, ...]} for each participant directory, takes in order."""
    result: dict[str, list[Path]] = {}
    if not session_dir.is_dir():
        return result
    for pdir in sorted(session_dir.iterdir()):
        if not pdir.is_dir():
            continue
        wavs = sorted(
            f for f in pdir.glob("*.wav")
            if "_source" not in f.stem and "_chunk_" not in f.name
        )
        if wavs:
            # Convert directory slug back to display name: Alice_Smith → Alice Smith
            speaker = pdir.name.replace("_", " ")
            result[speaker] = wavs
    return result


async def _concat_wavs(wav_files: list[Path], output: Path) -> bool:
    """Concatenate WAV files in take order into a single output file."""
    if len(wav_files) == 1:
        await asyncio.to_thread(shutil.copy2, wav_files[0], output)
        return True
    cmd = ["ffmpeg", "-y"]
    for w in wav_files:
        cmd += ["-i", str(w)]
    n = len(wav_files)
    fc = "".join(f"[{i}:a]" for i in range(n)) + f"concat=n={n}:v=0:a=1[aout]"
    cmd += ["-filter_complex", fc, "-map", "[aout]", "-c:a", "pcm_s16le", str(output)]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.error("WAV concat failed: %s", stderr.decode()[-1000:])
        return False
    return True


def _fmt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}:{m:02d}:{s:02d}"


def _merge_transcripts(tracks: list[tuple[str, dict]]) -> str:
    """Interleave per-speaker verbose_json segment lists into one transcript.

    Segments are sorted by start time. Consecutive segments from the same
    speaker are grouped under a single speaker header.
    """
    all_segs = []
    for speaker, data in tracks:
        for seg in data.get("segments", []):
            text = seg.get("text", "").strip()
            if text:
                all_segs.append({
                    "start": seg.get("start", 0.0),
                    "text": text,
                    "speaker": speaker,
                })

    all_segs.sort(key=lambda s: s["start"])

    lines: list[str] = []
    prev_speaker: str | None = None
    for seg in all_segs:
        if seg["speaker"] != prev_speaker:
            if lines:
                lines.append("")
            lines.append(f"[{seg['speaker']}]")
            prev_speaker = seg["speaker"]
        lines.append(f"[{_fmt_time(seg['start'])}] {seg['text']}")

    return "\n".join(lines)


async def _transcribe_one(
    client: httpx.AsyncClient,
    speaker: str,
    audio_path: Path,
) -> tuple[str, dict] | None:
    """POST one participant's audio to WhisperX; return (speaker, verbose_json) or None."""
    try:
        logger.info("Sending %s to WhisperX (%s)", speaker, audio_path.name)
        with audio_path.open("rb") as f:
            form: dict = {
                "model": settings.whisperx_model,
                "response_format": "verbose_json",
                "diarize": "false",
                "align": "true",
            }
            if settings.whisperx_language:
                form["language"] = settings.whisperx_language
            r = await client.post(
                f"{settings.whisperx_api_url.rstrip('/')}/v1/audio/transcriptions",
                files={"file": (audio_path.name, f, "audio/wav")},
                data=form,
            )
        if r.status_code != 200:
            logger.error("WhisperX %d for %s: %s", r.status_code, speaker, r.text[:500])
            return None
        return speaker, r.json()
    except Exception as e:
        logger.error("Transcription failed for %s: %s", speaker, e)
        return None


async def _wait_for_assembly(session_dir: Path, timeout_s: int = 600):
    """Poll until no in-flight assembly tasks and no chunk files remain for this session."""
    from app.routers.upload import _assembly_in_progress

    for _ in range(timeout_s // 5):
        session_dir_prefix = str(session_dir) + "/"
        in_flight = any(k[0].startswith(session_dir_prefix) for k in _assembly_in_progress)
        has_chunks = False
        if session_dir.is_dir():
            for pdir in session_dir.iterdir():
                if pdir.is_dir() and any("_chunk_" in f.name for f in pdir.iterdir() if f.is_file()):
                    has_chunks = True
                    break
        if not in_flight and not has_chunks:
            return
        await asyncio.sleep(5)

    logger.warning("Assembly wait timed out for %s", session_dir.name)


async def _run_session_transcription(session_id: str):
    try:
        session = get_session(session_id)
        if not session:
            return

        session_dir = Path(settings.recordings_dir) / session.dir_name
        transcript_path = session_dir / "transcript.txt"
        if transcript_path.exists():
            return

        await _wait_for_assembly(session_dir)

        participant_wavs = _gather_participant_wavs(session_dir)
        if not participant_wavs:
            logger.warning("No audio found for session %s — skipping transcription", session_id)
            return

        logger.info(
            "Transcribing session %s: %d participant(s): %s",
            session_id, len(participant_wavs), list(participant_wavs.keys()),
        )

        tmp_files: list[Path] = []
        to_transcribe: list[tuple[str, Path]] = []

        try:
            for speaker, wavs in participant_wavs.items():
                if len(wavs) == 1:
                    to_transcribe.append((speaker, wavs[0]))
                else:
                    fd, tmp = tempfile.mkstemp(suffix=".wav", prefix="pb_concat_")
                    os.close(fd)
                    tmp_path = Path(tmp)
                    tmp_files.append(tmp_path)
                    logger.info("Concatenating %d takes for %s", len(wavs), speaker)
                    if not await _concat_wavs(wavs, tmp_path):
                        return
                    to_transcribe.append((speaker, tmp_path))

            tracks: list[tuple[str, dict]] = []
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=10.0, read=3600.0, write=300.0, pool=10.0)
            ) as client:
                for speaker, audio_path in to_transcribe:
                    result = await _transcribe_one(client, speaker, audio_path)
                    if result:
                        tracks.append(result)

            if not tracks:
                logger.error("All transcriptions failed for session %s", session_id)
                return

            transcript = _merge_transcripts(tracks)
            transcript_path.write_text(transcript)
            logger.info("Transcript saved for session %s (%d chars)", session_id, len(transcript))

        finally:
            for f in tmp_files:
                f.unlink(missing_ok=True)

    except Exception as e:
        logger.error("Session transcription failed for %s: %s", session_id, e)
    finally:
        _session_transcribing.discard(session_id)


def schedule_session_transcription(session_id: str):
    """Trigger background transcription for a session. No-op if WHISPERX_API_URL is unset."""
    if not settings.whisperx_api_url:
        return
    if session_id in _session_transcribing:
        return
    _session_transcribing.add(session_id)
    task = asyncio.create_task(_run_session_transcription(session_id))
    _transcribe_tasks.add(task)
    task.add_done_callback(_transcribe_tasks.discard)


@router.get("/api/session/{session_id}/transcribe-status")
async def transcription_status(session_id: str):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session_dir = Path(settings.recordings_dir) / session.dir_name
    if (session_dir / "transcript.txt").exists():
        return JSONResponse({"status": "done"})
    if session_id in _session_transcribing:
        return JSONResponse({"status": "transcribing"})
    return JSONResponse({"status": "idle"})
