"""Video encode limits: libx264 re-encodes (track transcodes and grid
exports) share max_concurrent_video_encodes slots, use the configured
preset/CRF/threads, and run under `nice`.

On a CPU-only box, every participant's webcam track being re-encoded at once
(each ffmpeg grabbing every core, at -preset medium) slowed the whole
container to a crawl after a two-person 15-minute soak test.
"""
import asyncio
from pathlib import Path

import pytest

from app import utils
from app.config import settings
from app.routers import dashboard, upload


@pytest.fixture(autouse=True)
def _fresh_slots(monkeypatch):
    # The semaphore is created lazily from settings; reset it per test so
    # each one's max_concurrent_video_encodes (and event loop) applies.
    monkeypatch.setattr(utils, "_video_encode_slots", None)
    upload._assembly_progress.clear()
    yield
    upload._assembly_progress.clear()


def test_x264_args_follow_settings(monkeypatch):
    monkeypatch.setattr(settings, "video_encode_preset", "veryfast")
    monkeypatch.setattr(settings, "video_encode_crf", 21)
    monkeypatch.setattr(settings, "ffmpeg_threads", 0)
    assert utils.x264_args() == ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]

    monkeypatch.setattr(settings, "ffmpeg_threads", 3)
    assert utils.x264_args(crf=23)[-4:] == ["-crf", "23", "-threads", "3"]


def test_niced_prefixes_only_when_enabled(monkeypatch):
    monkeypatch.setattr(utils.shutil, "which", lambda name: "/usr/bin/nice")
    monkeypatch.setattr(settings, "ffmpeg_nice", 10)
    assert utils.niced(["ffmpeg", "-i", "x"]) == ["nice", "-n", "10", "ffmpeg", "-i", "x"]

    monkeypatch.setattr(settings, "ffmpeg_nice", 0)
    assert utils.niced(["ffmpeg", "-i", "x"]) == ["ffmpeg", "-i", "x"]

    monkeypatch.setattr(settings, "ffmpeg_nice", 10)
    monkeypatch.setattr(utils.shutil, "which", lambda name: None)
    assert utils.niced(["ffmpeg", "-i", "x"]) == ["ffmpeg", "-i", "x"]


def test_grid_export_uses_configured_encoder(monkeypatch):
    monkeypatch.setattr(settings, "video_encode_preset", "faster")
    monkeypatch.setattr(settings, "video_encode_crf", 18)
    cmd = dashboard._build_export_cmd([Path("a.mp4"), Path("b.mp4")], Path("out.mp4"), durations=[10.0, 10.0])
    i = cmd.index("-preset")
    assert cmd[i + 1] == "faster"
    assert cmd[cmd.index("-crf") + 1] == "20"  # grid exports: video_encode_crf + 2
    assert "medium" not in cmd


async def _run_two_video_transcodes(tmp_path, monkeypatch, *, codec="vp9"):
    """Drive the real _transcode_source for two participants' video tracks
    at once, with ffmpeg replaced by a fake that records overlap."""
    running = 0
    peak = 0
    cmds = []
    stages_seen = set()

    async def fake_run_ffmpeg(cmd, directory, track_type, on_progress=None, duration_s=None):
        nonlocal running, peak
        cmds.append(cmd)
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.05)
        # Mid-encode, i.e. after the other participant has had its turn to
        # reach the encode slot.
        for entry in upload._assembly_progress.values():
            stages_seen.add(entry["stage"])
        Path(cmd[-1]).write_bytes(b"x")
        running -= 1
        return True

    async def fake_probe_codec(_source):
        return codec

    async def fake_probe_has_video(_path):
        return True

    async def no_merge(*a, **k):
        return None

    monkeypatch.setattr(upload, "_run_ffmpeg", fake_run_ffmpeg)
    monkeypatch.setattr(upload, "_probe_video_codec", fake_probe_codec)
    monkeypatch.setattr(upload, "_probe_has_video", fake_probe_has_video)
    monkeypatch.setattr(upload, "_try_merge_av", no_merge)

    jobs = []
    for name in ("Alice", "Bob"):
        d = tmp_path / name
        d.mkdir()
        source = d / "video_ep1_source.webm"
        source.write_bytes(b"webm")
        jobs.append(upload._transcode_source(d, "video", "container", 0, 0, "ep1", None, source, [], 60.0))
    await asyncio.gather(*jobs)
    return peak, cmds, stages_seen


@pytest.mark.asyncio
async def test_video_reencodes_run_one_at_a_time_by_default(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "max_concurrent_video_encodes", 1)
    monkeypatch.setattr(settings, "video_encode_preset", "veryfast")

    peak, cmds, stages_seen = await _run_two_video_transcodes(tmp_path, monkeypatch)

    assert peak == 1
    assert "queued" in stages_seen  # the second participant showed as waiting
    assert all(c[c.index("-preset") + 1] == "veryfast" for c in cmds)
    states = {v["participant"]: v["stage"] for v in upload._assembly_progress.values()}
    assert states == {"Alice": "done", "Bob": "done"}


@pytest.mark.asyncio
async def test_concurrency_is_configurable(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "max_concurrent_video_encodes", 2)

    peak, _, _ = await _run_two_video_transcodes(tmp_path, monkeypatch)

    assert peak == 2


@pytest.mark.asyncio
async def test_h264_stream_copy_does_not_wait_for_an_encode_slot(tmp_path, monkeypatch):
    # A copy is cheap — two at once is fine even with a single encode slot.
    monkeypatch.setattr(settings, "max_concurrent_video_encodes", 1)

    peak, cmds, stages_seen = await _run_two_video_transcodes(tmp_path, monkeypatch, codec="h264")

    assert peak == 2
    assert "queued" not in stages_seen
    assert all("copy" in c for c in cmds)
