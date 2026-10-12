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
    # audio 1.0 + video 0.5 + the take's not-yet-started A/V merge 0.0
    assert body["progress"] == pytest.approx(0.5)
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


def test_progress_never_drops_when_the_av_merge_starts():
    # Found on a real 15-minute two-person soak run: the meter went 95% → 81%
    # the moment a take's merge appeared as a brand-new job at 0%. The merge
    # is now counted from the start, so each step only ever moves it forward.
    def jobs(audio, video, merge=None):
        out = [
            {"participant": "Alice", "epoch": "ep1", "job": "audio", "fraction": audio},
            {"participant": "Alice", "epoch": "ep1", "job": "video", "fraction": video},
        ]
        if merge is not None:
            out.append({"participant": "Alice", "epoch": "ep1", "job": "merge", "fraction": merge})
        return out

    sequence = [
        jobs(1.0, 0.0), jobs(1.0, 0.5), jobs(1.0, 0.95),
        jobs(1.0, 1.0, merge=0.0), jobs(1.0, 1.0, merge=0.6), jobs(1.0, 1.0, merge=1.0),
    ]
    readings = [upload._assembly_progress_fraction(j) for j in sequence]

    assert readings == sorted(readings)
    assert readings[-1] == 1.0


def test_audio_only_take_has_no_phantom_merge():
    jobs = [{"participant": "Alice", "epoch": "ep1", "job": "audio", "fraction": 1.0}]
    assert upload._assembly_progress_fraction(jobs) == 1.0


def test_assembly_status_scoped_to_one_participant(client, session, recordings_dir):
    session_dir = recordings_dir / session.dir_name
    # Alice is still mid video transcode; Bob's recording is finished.
    (session_dir / "Alice").mkdir(parents=True)
    (session_dir / "Alice" / "video_ep1_chunk_000000.webm").write_bytes(b"x")
    _job(session_dir, "Alice", "video", "converting", 0.3)
    _job(session_dir, "Bob", "audio", "done", 1.0)

    bob = client.get(f"/api/session/{session.id}/assembly-status",
                     params={"participant": "Bob", "identity": "bob-id"}).json()
    whole = client.get(f"/api/session/{session.id}/assembly-status").json()

    # Bob's banner can finish without waiting on Alice's video...
    assert bob["assembling"] is False
    assert bob["progress"] == 1.0
    assert [j["participant"] for j in bob["jobs"]] == ["Bob"]
    # ...while the host's session-wide view still waits for everyone.
    assert whole["assembling"] is True


def test_resolve_participant_dir_follows_identity_disambiguation_without_creating_anything(session, recordings_dir):
    session_dir = recordings_dir / session.dir_name
    (session_dir / "Alice").mkdir(parents=True)
    (session_dir / "Alice" / ".identity").write_text("first-alice-id")

    second = upload._resolve_participant_dir(session, "Alice", "second-alice-id")
    first = upload._resolve_participant_dir(session, "Alice", "first-alice-id")

    assert second == session_dir / "Alice_ice-id"  # same suffix rule participant_dir applies
    assert first == session_dir / "Alice"
    assert not second.exists()  # read-only: nothing created
    assert upload.participant_dir(session, "Alice", "second-alice-id") == second
