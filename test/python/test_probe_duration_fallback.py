"""Coverage for export.py's duration-probe fallback. Raw MediaRecorder WebM
output uploaded via the participant local-upload endpoint (app/routers/
localupload.py) is never server-side remuxed the way the WebRTC chunk-merge
pipeline's output is, so it commonly has no duration in its container header
— ffprobe's fast `format=duration` query comes back empty even though the
file plays fine. Before this fallback, that meant no video track ever made
it into the OTIO/FCPXML/Reaper exports for a local-uploaded video/screen
recording, silently (_resolve_runs just drops the track).
"""
import asyncio

import pytest

from app.routers import export


class _FakeProc:
    def __init__(self, stdout: bytes = b"", stderr: bytes = b""):
        self._stdout = stdout
        self._stderr = stderr

    async def communicate(self):
        return self._stdout, self._stderr


def test_fast_probe_used_when_header_has_duration(monkeypatch):
    async def fake_exec(*args, **kwargs):
        assert args[0] == "ffprobe"
        return _FakeProc(stdout=b"12.5\n")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    result = asyncio.run(export._probe_duration_s("clip.wav"))
    assert result == 12.5


def test_falls_back_to_slow_decode_when_header_has_no_duration(monkeypatch):
    calls = []

    async def fake_exec(*args, **kwargs):
        calls.append(args[0])
        if args[0] == "ffprobe":
            return _FakeProc(stdout=b"")  # header has no duration
        assert args[0] == "ffmpeg"
        # ffmpeg -f null - prints periodic progress lines to stderr; the
        # last one reflects how much was actually decoded.
        stderr = (
            b"frame=  100 fps=30 time=00:00:30.00 bitrate=N/A\n"
            b"frame=  200 fps=30 time=00:01:05.50 bitrate=N/A\n"
        )
        return _FakeProc(stderr=stderr)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    result = asyncio.run(export._probe_duration_s("clip.webm"))
    assert result == 65.5
    assert calls == ["ffprobe", "ffmpeg"]


def test_slow_decode_returns_zero_if_no_progress_lines_found(monkeypatch):
    async def fake_exec(*args, **kwargs):
        if args[0] == "ffprobe":
            return _FakeProc(stdout=b"")
        return _FakeProc(stderr=b"some unrelated ffmpeg error output\n")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    result = asyncio.run(export._probe_duration_s("broken.webm"))
    assert result == 0.0
