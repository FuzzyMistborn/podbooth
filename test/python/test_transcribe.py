"""Coverage for app/routers/transcribe.py (CLAUDE.md candidate test #1):

- A participant's transcription failing shouldn't silently mark the session
  "done" — /transcribe-status must distinguish "done", "done_with_errors"
  (naming the missing speaker), and "failed" (every speaker failed).
- `_take_sort_key` orders `Alice_2` before `Alice_10` numerically, not
  lexicographically — a WAV-concat/take-ordering bug that would otherwise
  transcribe takes in the wrong order.
"""
import json

import pytest

from app.config import settings
from app.routers import transcribe
from app.utils import _take_sort_key


# ── _take_sort_key: natural vs lexicographic ordering ───────────────────────

def test_take_sort_key_orders_numerically_not_lexicographically():
    names = ["Alice_10.wav", "Alice_2.wav", "Alice_1.wav"]
    assert sorted(names, key=_take_sort_key) == ["Alice_1.wav", "Alice_2.wav", "Alice_10.wav"]


def test_take_sort_key_handles_video_and_screen_suffixes():
    names = ["Alice_10_video.mp4", "Alice_2_video.mp4"]
    assert sorted(names, key=_take_sort_key) == ["Alice_2_video.mp4", "Alice_10_video.mp4"]


def test_gather_participant_wavs_orders_takes_numerically(recordings_dir):
    session_dir = recordings_dir / "test-session"
    pdir = session_dir / "Alice"
    pdir.mkdir(parents=True)
    for n in (1, 2, 10):
        (pdir / f"Alice_{n}.wav").write_bytes(b"fake-wav")

    result = transcribe._gather_participant_wavs(session_dir)
    assert [p.name for p in result["Alice"]] == ["Alice_1.wav", "Alice_2.wav", "Alice_10.wav"]


# ── Partial transcription failure ────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clean_transcribe_state():
    transcribe._session_transcribing.clear()
    transcribe._session_transcribe_failed.clear()
    yield
    transcribe._session_transcribing.clear()
    transcribe._session_transcribe_failed.clear()


@pytest.mark.asyncio
async def test_one_speaker_failing_marks_done_with_errors_not_silently_done(session, recordings_dir, monkeypatch):
    session_dir = recordings_dir / session.dir_name
    for name in ("Alice", "Bob"):
        pdir = session_dir / name
        pdir.mkdir(parents=True)
        (pdir / f"{name}_1.wav").write_bytes(b"fake-wav")

    monkeypatch.setattr(transcribe, "_wait_for_assembly", _noop_async)
    monkeypatch.setattr(transcribe, "_concat_wavs", _noop_async_true)
    monkeypatch.setattr(transcribe, "_transcode_to_mp3", _noop_async_true)

    async def _fake_transcribe_chunked(client, speaker, audio_path, chunk_secs=600):
        if speaker == "Bob":
            return None  # Bob's transcription failed
        return speaker, {"segments": [{"start": 0.0, "text": "hello"}]}

    monkeypatch.setattr(transcribe, "_transcribe_chunked", _fake_transcribe_chunked)

    await transcribe._run_session_transcription(session.id)

    transcript_path = session_dir / "transcript.txt"
    assert transcript_path.exists()
    assert "hello" in transcript_path.read_text()

    incomplete_path = session_dir / "transcript_incomplete.json"
    assert incomplete_path.exists()
    assert json.loads(incomplete_path.read_text())["failed_speakers"] == ["Bob"]


@pytest.mark.asyncio
async def test_all_speakers_failing_is_reported_as_failed_not_done(session, recordings_dir, monkeypatch):
    session_dir = recordings_dir / session.dir_name
    pdir = session_dir / "Alice"
    pdir.mkdir(parents=True)
    (pdir / "Alice_1.wav").write_bytes(b"fake-wav")

    monkeypatch.setattr(transcribe, "_wait_for_assembly", _noop_async)
    monkeypatch.setattr(transcribe, "_concat_wavs", _noop_async_true)
    monkeypatch.setattr(transcribe, "_transcode_to_mp3", _noop_async_true)

    async def _always_fails(client, speaker, audio_path, chunk_secs=600):
        return None

    monkeypatch.setattr(transcribe, "_transcribe_chunked", _always_fails)

    await transcribe._run_session_transcription(session.id)

    assert not (session_dir / "transcript.txt").exists()
    assert session.id in transcribe._session_transcribe_failed


async def _noop_async(*args, **kwargs):
    return None


async def _noop_async_true(*args, **kwargs):
    return True


# ── /transcribe-status endpoint ──────────────────────────────────────────────

@pytest.fixture
def transcribe_app():
    from fastapi import FastAPI
    api = FastAPI()
    api.include_router(transcribe.router)
    return api


@pytest.fixture
def transcribe_client(transcribe_app):
    from fastapi.testclient import TestClient
    return TestClient(transcribe_app)


def test_status_reports_done_with_errors_and_names_failed_speakers(transcribe_client, session, recordings_dir):
    session_dir = recordings_dir / session.dir_name
    session_dir.mkdir(parents=True)
    (session_dir / "transcript.txt").write_text("some transcript")
    (session_dir / "transcript_incomplete.json").write_text(json.dumps({"failed_speakers": ["Bob"]}))

    r = transcribe_client.get(f"/api/session/{session.id}/transcribe-status")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "done_with_errors"
    assert body["failed_speakers"] == ["Bob"]


def test_status_reports_plain_done_when_no_incomplete_marker(transcribe_client, session, recordings_dir):
    session_dir = recordings_dir / session.dir_name
    session_dir.mkdir(parents=True)
    (session_dir / "transcript.txt").write_text("some transcript")

    r = transcribe_client.get(f"/api/session/{session.id}/transcribe-status")
    assert r.json()["status"] == "done"


def test_status_reports_failed_when_transcription_gave_up(transcribe_client, session, recordings_dir):
    transcribe._session_transcribe_failed.add(session.id)
    r = transcribe_client.get(f"/api/session/{session.id}/transcribe-status")
    assert r.json()["status"] == "failed"


def test_retranscribe_requires_correct_host_token(transcribe_client, session, recordings_dir, monkeypatch):
    monkeypatch.setattr(settings, "whisperx_api_url", "https://whisperx.example.com")
    r = transcribe_client.post(
        f"/api/session/{session.id}/retranscribe",
        json={"host_token": "wrong"},
    )
    assert r.status_code == 403
