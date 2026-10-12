"""Server-side assembly progress — the meter behind the client's post-upload
'Processing recordings…' banner (/assembly-status `progress`/`jobs`).

The client used to stop waiting on assembly after ~2 minutes and show
'✓ Recordings ready' regardless (found by scripts/soak-upload.mjs: even a
3-minute two-person take took ~3 minutes to assemble). These cover the
server half of the fix: ffmpeg's own -progress output turned into a
per-job fraction, and the session-wide figure the client renders.
"""
import asyncio
import shutil
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import sessions, upload


@pytest.fixture(autouse=True)
def _clean_progress():
    upload._assembly_progress.clear()
    yield
    upload._assembly_progress.clear()


@pytest.fixture
def client():
    api = FastAPI()
    api.include_router(sessions.router)
    return TestClient(api)


@pytest.mark.asyncio
async def test_watch_ffmpeg_progress_reports_fraction_from_latest_out_time(tmp_path, monkeypatch):
    progress_file = tmp_path / "progress.txt"
    # ffmpeg appends a block like this every ~0.5s; only the latest counts.
    # out_time_ms is microseconds too (an old ffmpeg naming quirk).
    progress_file.write_text(
        "frame=10\nout_time_ms=5000000\nprogress=continue\n"
        "frame=20\nout_time_us=15000000\nprogress=continue\n"
    )
    seen = []
    real_sleep = asyncio.sleep
    monkeypatch.setattr(upload.asyncio, "sleep", lambda _s: real_sleep(0))

    task = asyncio.create_task(upload._watch_ffmpeg_progress(progress_file, 60.0, seen.append))
    for _ in range(5):
        await real_sleep(0)
    task.cancel()

    assert seen and seen[-1] == pytest.approx(0.25)  # 15s of 60s


@pytest.mark.asyncio
async def test_watch_ffmpeg_progress_caps_at_one(tmp_path, monkeypatch):
    progress_file = tmp_path / "progress.txt"
    progress_file.write_text("out_time_us=90000000\n")  # 90s against a 60s expectation
    seen = []
    real_sleep = asyncio.sleep
    monkeypatch.setattr(upload.asyncio, "sleep", lambda _s: real_sleep(0))

    task = asyncio.create_task(upload._watch_ffmpeg_progress(progress_file, 60.0, seen.append))
    for _ in range(5):
        await real_sleep(0)
    task.cancel()

    assert seen[-1] == 1.0


@pytest.mark.asyncio
@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs a real ffmpeg")
async def test_run_ffmpeg_reports_real_progress_and_cleans_up(tmp_path):
    # -re paces the 3s input at real time so the 1s watcher sees it mid-run.
    out = tmp_path / "out.wav"
    cmd = ["ffmpeg", "-y", "-re", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", str(out)]
    seen = []

    ok = await upload._run_ffmpeg(cmd, tmp_path, "audio", on_progress=seen.append, duration_s=3.0)

    assert ok is True
    assert out.exists()
    assert seen, "no progress reported during a 3s real-time ffmpeg run"
    assert all(0.0 <= f <= 1.0 for f in seen)
    assert seen == sorted(seen)
    # The temp progress file is gone, and nothing was written into the
    # participant directory (the dashboard lists everything there).
    assert sorted(p.name for p in tmp_path.iterdir()) == ["out.wav"]


def _job(session_dir, participant, job, stage, fraction):
    directory = session_dir / participant
    directory.mkdir(parents=True, exist_ok=True)
    upload._report_progress(directory, job, "ep1", stage, fraction)


def test_assembly_status_reports_mean_progress_for_this_session_only(client, session, recordings_dir):
    session_dir = recordings_dir / session.dir_name
    (session_dir / "Alice").mkdir(parents=True)
    (session_dir / "Alice" / "video_ep1_chunk_000000.webm").write_bytes(b"x")  # still assembling
    _job(session_dir, "Alice", "audio", "done", 1.0)
    _job(session_dir, "Alice", "video", "converting", 0.5)
    _job(recordings_dir / "some-other-session", "Bob", "video", "converting", 0.1)

    body = client.get(f"/api/session/{session.id}/assembly-status").json()

    assert body["assembling"] is True
    assert body["progress"] == pytest.approx(0.75)
    assert {(j["participant"], j["job"], j["stage"]) for j in body["jobs"]} == {
        ("Alice", "audio", "done"), ("Alice", "video", "converting"),
    }


def test_assembly_status_progress_is_none_while_a_job_length_is_unknown(client, session, recordings_dir):
    session_dir = recordings_dir / session.dir_name
    _job(session_dir, "Alice", "audio", "converting", 0.4)
    _job(session_dir, "Alice", "video", "converting", None)

    body = client.get(f"/api/session/{session.id}/assembly-status").json()

    assert body["progress"] is None
    assert len(body["jobs"]) == 2


def test_stale_finished_jobs_are_pruned(client, session, recordings_dir):
    session_dir = recordings_dir / session.dir_name
    _job(session_dir, "Alice", "audio", "done", 1.0)
    key = next(iter(upload._assembly_progress))
    upload._assembly_progress[key]["updated"] = time.monotonic() - upload._ASSEMBLY_PROGRESS_KEEP_S - 1

    body = client.get(f"/api/session/{session.id}/assembly-status").json()

    assert body["jobs"] == []
    assert upload._assembly_progress == {}


def test_purge_session_state_drops_progress_entries(recordings_dir):
    _job(recordings_dir / "gone", "Alice", "audio", "done", 1.0)
    _job(recordings_dir / "kept", "Bob", "audio", "done", 1.0)

    upload.purge_session_state(recordings_dir / "gone")

    assert [v["participant"] for v in upload._assembly_progress.values()] == ["Bob"]


def test_assembly_status_stays_true_while_an_assembly_task_runs_with_no_chunks_visible(client, session, recordings_dir):
    # A track's transcode has finished and deleted its chunks, and the A/V
    # merge hasn't registered yet (it's still probing the files) — the task
    # is still running, so the session is still assembling.
    participant_dir = recordings_dir / session.dir_name / "Alice"
    participant_dir.mkdir(parents=True)
    (participant_dir / "audio_ep1.wav").write_bytes(b"done")
    key = (str(participant_dir), "video", "ep1")
    upload._assembly_in_progress.add(key)
    try:
        assert client.get(f"/api/session/{session.id}/assembly-status").json()["assembling"] is True
    finally:
        upload._assembly_in_progress.discard(key)

    assert client.get(f"/api/session/{session.id}/assembly-status").json()["assembling"] is False
