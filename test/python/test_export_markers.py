"""Coverage for chapter markers reaching the NLE/DAW exports (candidate test
from the plan to wire guest-created topic markers into the editor XML
export). Before this change, export.py never read markers.txt at all, so a
guest's "M" hotkey marker never showed up as a chapter in the FCPXML/OTIO/
Reaper files handed to an editor — this reproduces that gap and confirms
malformed lines are skipped rather than breaking the export.
"""
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.models import Session, _sessions
from app.routers import export


def _async_return(value):
    async def _inner(*_a, **_kw):
        return value
    return _inner


@pytest.fixture
def recordings_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "recordings_dir", str(tmp_path))
    return tmp_path


@pytest.fixture
def session(recordings_dir):
    s = Session(
        id="test-session",
        title="Test Session",
        host_token="host-secret",
        created_at=datetime.now(timezone.utc),
        dir_name="test-session",
    )
    _sessions[s.id] = s

    session_path = recordings_dir / s.dir_name
    (session_path / "Alice").mkdir(parents=True)
    (session_path / "Alice" / "Alice_1.wav").write_bytes(b"x")

    yield s
    _sessions.pop(s.id, None)


@pytest.fixture(autouse=True)
def _fake_probe(monkeypatch):
    monkeypatch.setattr(export, "_probe_duration_s", _async_return(10.0))


@pytest.fixture
def app():
    api = FastAPI()
    api.include_router(export.router)
    return api


@pytest.fixture
def client(app):
    return TestClient(app)


def _write_markers(session, recordings_dir, lines):
    path = recordings_dir / session.dir_name / "markers.txt"
    path.write_text("\n".join(lines) + "\n")


def test_no_markers_file_produces_no_chapter_markers(client, session):
    r = client.get(f"/api/session/{session.id}/export-fcpxml")
    assert r.status_code == 200
    assert "<chapter-marker" not in r.text


def test_fcpxml_includes_guest_chapter_markers(client, session, recordings_dir):
    _write_markers(session, recordings_dir, [
        "- [0:05] Intro",
        "- [1:02:03] Deep dive",
        "not a marker line, skip me",
    ])
    r = client.get(f"/api/session/{session.id}/export-fcpxml")
    assert r.status_code == 200
    body = r.text
    assert body.count("<chapter-marker") == 2
    assert 'value="Intro"' in body
    assert 'value="Deep dive"' in body


def test_otio_includes_guest_chapter_markers(client, session, recordings_dir):
    _write_markers(session, recordings_dir, ["- [0:05] Intro"])
    r = client.get(f"/api/session/{session.id}/export-otio")
    assert r.status_code == 200
    data = r.json()
    stack_markers = data["tracks"]["markers"]
    assert len(stack_markers) == 1
    assert stack_markers[0]["name"] == "Intro"
    assert stack_markers[0]["OTIO_SCHEMA"] == "Marker.2"


def test_reaper_includes_guest_chapter_markers(client, session, recordings_dir):
    _write_markers(session, recordings_dir, ["- [0:05] Intro"])
    r = client.get(f"/api/session/{session.id}/export-reaper")
    assert r.status_code == 200
    assert 'MARKER 1 5.000000 "Intro"' in r.text


def test_malformed_marker_lines_are_skipped(session, recordings_dir):
    _write_markers(session, recordings_dir, [
        "garbage",
        "- no time here",
        "- [0:05] Valid",
    ])
    markers = export._read_markers(session)
    assert markers == [{"time_s": 5.0, "label": "Valid"}]
