"""Small helpers shared across routers (previously duplicated in each)."""

import asyncio
import logging
import secrets
import shutil

from app.config import settings

logger = logging.getLogger(__name__)


async def run_subprocess(cmd: list[str], timeout_s: float, label: str = "") -> tuple[int, bytes, bytes]:
    """Run a subprocess with a hard timeout, killing it if it runs over.

    Returns (returncode, stdout, stderr); returncode is -1 on timeout so
    callers can distinguish a kill from a normal ffmpeg failure.
    """
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        logger.error("subprocess timed out after %.0fs (%s): %s", timeout_s, label, cmd[0])
        proc.kill()
        await proc.wait()
        return -1, b"", b""
    return proc.returncode, stdout, stderr


# Shared by every libx264 caller (track transcodes in upload.py, grid exports
# in dashboard.py) so the configured limit bounds all of them together.
# Created on first use rather than at import so settings overrides (and each
# test's event loop) are respected.
_video_encode_slots: asyncio.Semaphore | None = None


def video_encode_slot() -> asyncio.Semaphore:
    global _video_encode_slots
    if _video_encode_slots is None:
        _video_encode_slots = asyncio.Semaphore(max(1, settings.max_concurrent_video_encodes))
    return _video_encode_slots


def x264_args(crf: int | None = None) -> list[str]:
    """libx264 encoder arguments from settings (see video_encode_* there)."""
    args = ["-c:v", "libx264", "-preset", settings.video_encode_preset,
            "-crf", str(settings.video_encode_crf if crf is None else crf)]
    if settings.ffmpeg_threads > 0:
        args += ["-threads", str(settings.ffmpeg_threads)]
    return args


def niced(cmd: list[str]) -> list[str]:
    """Prefix cmd with `nice` (settings.ffmpeg_nice) so long encodes yield
    the CPU to the web app and live calls. Unchanged if disabled or nice
    isn't installed."""
    if settings.ffmpeg_nice > 0 and shutil.which("nice"):
        return ["nice", "-n", str(settings.ffmpeg_nice), *cmd]
    return cmd


def _safe_name(value: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in "- " else "_" for c in value).strip()
    return cleaned[:100]


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


def _is_host(host_token, session) -> bool:
    if not isinstance(host_token, str) or not host_token:
        return False
    return secrets.compare_digest(host_token, session.host_token)


def _take_sort_key(filename: str):
    """Sort key for take-numbered filenames (Alice_2.wav, Alice_10.wav, ...) that
    orders by the trailing take number numerically instead of lexicographically."""
    stem = filename.rsplit(".", 1)[0]
    for ftype in ("video", "screen"):
        suffix = f"_{ftype}"
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    parts = stem.rsplit("_", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return (parts[0], int(parts[1]))
    return (stem, -1)


# recordingEpoch (recording.js) is Date.now() in base 36 (8 chars until 2059)
# followed by up to 4 random base-36 chars to keep back-to-back takes unique.
_EPOCH_TS_CHARS = 8
_EPOCH_SUFFIX_SCALE = 36 ** 4
_PLAUSIBLE_MAX_MS = 10 ** 14  # year ~5138; anything bigger isn't a real ms timestamp


def epoch_to_ms(epoch: str) -> int | None:
    """Decode a recording epoch to wall-clock ms, ignoring the random suffix.
    None for anything that isn't a plain epoch (e.g. a screen-share sub-epoch)."""
    try:
        int(epoch, 36)
        return int(epoch[:_EPOCH_TS_CHARS], 36)
    except Exception:
        return None


def normalize_start_ms(value: float) -> float:
    """Repair a start_ms written before epoch_to_ms existed, which decoded the
    random suffix as part of the timestamp (value = ms * 36**4 + random)."""
    if value and value > _PLAUSIBLE_MAX_MS:
        return float(int(value) // _EPOCH_SUFFIX_SCALE)
    return value
