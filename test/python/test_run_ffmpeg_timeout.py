"""Coverage for _run_ffmpeg's timeout (app/routers/upload.py) — previously
untested. A hung or maliciously crafted input used to be able to block
proc.communicate() forever, which also wedges that (directory, track_type,
epoch) group's _assembly_in_progress entry and blocks orphan-recovery from
ever retrying it."""
import asyncio

import pytest

from app.config import settings
from app.routers import upload


class _FakeHungProc:
    """Mimics a real Process whose communicate() never returns because the
    child is stuck — kill()/wait() are what a caller uses to actually end it."""
    def __init__(self):
        self.returncode = None
        self.killed = False

    async def communicate(self):
        await asyncio.sleep(3600)  # "never" returns within the test's timeout

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        return self.returncode


class _FakeOkProc:
    def __init__(self, returncode=0, stderr=b""):
        self.returncode = returncode
        self._stderr = stderr

    async def communicate(self):
        return b"", self._stderr


@pytest.mark.asyncio
async def test_run_ffmpeg_kills_a_hung_process_after_the_configured_timeout(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "ffmpeg_timeout_s", 0.05)
    fake = _FakeHungProc()
    monkeypatch.setattr(upload.asyncio, "create_subprocess_exec", lambda *a, **k: _async_return(fake))

    ok = await upload._run_ffmpeg(["ffmpeg", "-i", "x"], tmp_path, "video")

    assert ok is False
    assert fake.killed is True


@pytest.mark.asyncio
async def test_run_ffmpeg_still_succeeds_normally_within_the_timeout(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "ffmpeg_timeout_s", 5.0)
    fake = _FakeOkProc(returncode=0)
    monkeypatch.setattr(upload.asyncio, "create_subprocess_exec", lambda *a, **k: _async_return(fake))

    ok = await upload._run_ffmpeg(["ffmpeg", "-i", "x"], tmp_path, "video")

    assert ok is True


async def _async_return(value):
    return value
