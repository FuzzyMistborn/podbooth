"""Coverage for app/routers/outline.py's host_token check (candidate test #2
from CLAUDE.md's coverage list). /outline/import and /outline/refresh accept
a body-supplied host_token and must reject it via the same _is_host pattern
sessions.py's update_metadata uses — a body-token check that silently no-ops
would let any caller who merely knows the session_id rewrite that session's
notes from an arbitrary Outline document.
"""
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.models import Session, _sessions
from app.routers import outline


@pytest.fixture
def app():
    api = FastAPI()
    api.include_router(outline.router)
    return api


@pytest.fixture
def client(app):
    return TestClient(app)


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
    yield s
    _sessions.pop(s.id, None)


@pytest.fixture(autouse=True)
def _outline_enabled(monkeypatch):
    monkeypatch.setattr(settings, "outline_api_url", "https://wiki.example.com")
    monkeypatch.setattr(settings, "outline_api_key", "fake-key")


def test_import_rejects_missing_host_token(client, session, recordings_dir):
    r = client.post(
        f"/api/session/{session.id}/outline/import",
        json={"doc_id": "some-doc-id"},
    )
    assert r.status_code == 403


def test_import_rejects_wrong_host_token(client, session, recordings_dir):
    r = client.post(
        f"/api/session/{session.id}/outline/import",
        json={"host_token": "not-the-real-token", "doc_id": "some-doc-id"},
    )
    assert r.status_code == 403


def test_import_accepts_correct_host_token(client, session, recordings_dir, monkeypatch):
    async def _fake_fetch(doc_id):
        return {"data": {"text": "<!- podbooth -!>\nShow notes here\n<!- /podbooth -!>", "title": "Ep 1"}}

    monkeypatch.setattr(outline, "_fetch_outline_document", _fake_fetch)

    r = client.post(
        f"/api/session/{session.id}/outline/import",
        json={"host_token": session.host_token, "doc_id": "some-doc-id"},
    )
    assert r.status_code == 200, r.text
    assert session.notes == "Show notes here"
    assert session.outline_doc_id == "some-doc-id"


def test_refresh_rejects_wrong_host_token(client, session, recordings_dir):
    session.outline_doc_id = "linked-doc"
    r = client.post(
        f"/api/session/{session.id}/outline/refresh",
        json={"host_token": "wrong"},
    )
    assert r.status_code == 403


def test_refresh_accepts_correct_host_token(client, session, recordings_dir, monkeypatch):
    session.outline_doc_id = "linked-doc"

    async def _fake_fetch(doc_id):
        assert doc_id == "linked-doc"
        return {"data": {"text": "<!- podbooth -!>\nUpdated notes\n<!- /podbooth -!>"}}

    monkeypatch.setattr(outline, "_fetch_outline_document", _fake_fetch)

    r = client.post(
        f"/api/session/{session.id}/outline/refresh",
        json={"host_token": session.host_token},
    )
    assert r.status_code == 200, r.text
    assert session.notes == "Updated notes"
