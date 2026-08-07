"""Session lifecycle smoke tests (CLAUDE.md candidate #4 — reprioritized
above grid-export padding math). Not tied to a specific bug; this is the one
piece of core, untested app functionality with zero coverage that everything
else depends on: create session -> guest requests to join -> host admits ->
guest gets a room token -> host ends the session -> session no longer usable.

The LiveKit/WebRTC join itself isn't practically testable without a real
browser + media stack (get_token only mints a JWT locally — it never
contacts the LiveKit server), so this covers the HTTP/session layer only.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import sessions


@pytest.fixture
def app():
    api = FastAPI()
    api.include_router(sessions.router)
    return api


@pytest.fixture
def client(app):
    return TestClient(app, follow_redirects=False)


@pytest.fixture(autouse=True)
def _clean_rate_limiter():
    from app.limiter import limiter
    limiter.reset()
    yield
    limiter.reset()


@pytest.fixture(autouse=True)
def _clean_sessions():
    # _sessions is process-global in-memory state (models.py), not scoped to
    # a test the way conftest's `session` fixture is — clear out anything
    # this file's tests created so titles/participant counts don't leak
    # across tests.
    from app.models import _sessions
    yield
    _sessions.clear()


def _create_session(client, recordings_dir, title="Test Episode"):
    r = client.post(
        "/api/session",
        json={"title": title},
        headers={"X-API-Key": "test-api-key"},
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(autouse=True)
def _api_key(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "api_key", "test-api-key")


def test_full_lifecycle_create_join_admit_end(client, recordings_dir):
    created = _create_session(client, recordings_dir)
    session_id = created["id"]
    host_token = created["host_token"]

    # Session shows up as not ended, no participants yet.
    r = client.get(f"/api/session/{session_id}/status")
    assert r.status_code == 200
    assert r.json() == {"recording": False, "ended": False, "participants": []}

    # A guest requests to join.
    r = client.post(
        f"/api/session/{session_id}/request-join",
        json={"identity": "guest-1", "display_name": "Alice"},
    )
    assert r.status_code == 200

    # Not admitted yet.
    r = client.get(f"/api/session/{session_id}/admission/guest-1")
    assert r.json() == {"admitted": False, "denied": False, "ended": False}

    # Host sees the pending guest.
    r = client.get(f"/api/session/{session_id}/pending-guests", params={"host_token": host_token})
    assert r.status_code == 200
    assert r.json()["guests"] == [{"identity": "guest-1", "display_name": "Alice"}]

    # Wrong host_token can't see the pending list.
    r = client.get(f"/api/session/{session_id}/pending-guests", params={"host_token": "wrong"})
    assert r.status_code == 403

    # The X-Host-Token header works too (this is what the client actually
    # sends now — see pollPendingGuests in studio.js — so the token isn't
    # sitting in server access logs on every poll).
    r = client.get(f"/api/session/{session_id}/pending-guests", headers={"X-Host-Token": host_token})
    assert r.status_code == 200
    assert r.json()["guests"] == [{"identity": "guest-1", "display_name": "Alice"}]

    # Host admits the guest.
    r = client.post(f"/api/session/{session_id}/admit/guest-1", json={"host_token": host_token})
    assert r.status_code == 200

    r = client.get(f"/api/session/{session_id}/admission/guest-1")
    assert r.json()["admitted"] is True

    # Guest (now admitted) gets a room token.
    r = client.post("/api/token", json={
        "session_id": session_id, "identity": "guest-1", "display_name": "Alice",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["is_host"] is False
    assert body["token"]

    # Participant now shows up in session status.
    r = client.get(f"/api/session/{session_id}/status")
    assert "Alice" in r.json()["participants"]

    # Host starts and stops recording.
    r = client.post(f"/api/session/{session_id}/recording", json={"host_token": host_token, "action": "start"})
    assert r.status_code == 200 and r.json()["recording"] is True
    r = client.post(f"/api/session/{session_id}/recording", json={"host_token": host_token, "action": "stop"})
    assert r.status_code == 200 and r.json()["recording"] is False

    # Host ends the session.
    r = client.post(f"/api/session/{session_id}/end", json={"host_token": host_token})
    assert r.status_code == 200
    assert r.json()["ended"] is True

    r = client.get(f"/api/session/{session_id}/status")
    assert r.json()["ended"] is True

    # A new join attempt against an ended session is refused.
    r = client.post(
        f"/api/session/{session_id}/request-join",
        json={"identity": "guest-2", "display_name": "Bob"},
    )
    assert r.status_code == 404

    # And an already-admitted guest can no longer mint a room token either.
    r = client.post("/api/token", json={
        "session_id": session_id, "identity": "guest-1", "display_name": "Alice",
    })
    assert r.status_code == 404


def test_denied_guest_is_reported_denied_not_admitted(client, recordings_dir):
    created = _create_session(client, recordings_dir)
    session_id, host_token = created["id"], created["host_token"]

    client.post(f"/api/session/{session_id}/request-join",
                json={"identity": "guest-1", "display_name": "Eve"})
    r = client.post(f"/api/session/{session_id}/deny/guest-1", json={"host_token": host_token})
    assert r.status_code == 200

    r = client.get(f"/api/session/{session_id}/admission/guest-1")
    assert r.json() == {"admitted": False, "denied": True, "ended": False}


def test_admit_requires_correct_host_token(client, recordings_dir):
    created = _create_session(client, recordings_dir)
    session_id = created["id"]
    client.post(f"/api/session/{session_id}/request-join",
                json={"identity": "guest-1", "display_name": "Eve"})

    r = client.post(f"/api/session/{session_id}/admit/guest-1", json={"host_token": "wrong"})
    assert r.status_code == 403

    r = client.get(f"/api/session/{session_id}/admission/guest-1")
    assert r.json()["admitted"] is False


def test_duplicate_session_title_is_rejected(client, recordings_dir):
    _create_session(client, recordings_dir, title="My Show")
    r = client.post("/api/session", json={"title": "My Show"}, headers={"X-API-Key": "test-api-key"})
    assert r.status_code == 409


def test_session_full_rejects_new_guest_past_the_cap(client, recordings_dir, monkeypatch):
    created = _create_session(client, recordings_dir)
    session_id, host_token = created["id"], created["host_token"]

    from app.models import get_session
    session = get_session(session_id)
    # Fill the participant cap without needing 50 real token requests.
    session.participants = {f"Guest{i}": "" for i in range(50)}
    session.admitted_guests["new-guest"] = True
    session.admitted_guests["returning"] = True

    r = client.post("/api/token", json={
        "session_id": session_id, "identity": "new-guest", "display_name": "Latecomer",
    })
    assert r.status_code == 429

    # A returning participant already counted in the cap is still let in.
    r = client.post("/api/token", json={
        "session_id": session_id, "identity": "returning", "display_name": "Guest0",
    })
    assert r.status_code == 200

    # The host is exempt from the cap.
    r = client.post("/api/token", json={
        "session_id": session_id, "identity": "host-conn", "display_name": "Host",
        "host_token": host_token,
    })
    assert r.status_code == 200


def test_delete_session_api_removes_it(client, recordings_dir):
    created = _create_session(client, recordings_dir)
    session_id = created["id"]

    r = client.delete(f"/api/session/{session_id}", headers={"X-API-Key": "test-api-key"})
    assert r.status_code == 200
    assert r.json()["deleted"] is True

    r = client.get(f"/api/session/{session_id}/status")
    assert r.status_code == 404


def test_list_sessions_requires_api_key(client, recordings_dir):
    _create_session(client, recordings_dir)
    r = client.get("/api/sessions")
    assert r.status_code == 403


def test_list_sessions_returns_created_sessions(client, recordings_dir):
    first = _create_session(client, recordings_dir, title="Episode One")
    second = _create_session(client, recordings_dir, title="Episode Two")

    r = client.get("/api/sessions", headers={"X-API-Key": "test-api-key"})
    assert r.status_code == 200
    sessions = r.json()["sessions"]
    ids = {s["id"] for s in sessions}
    assert {first["id"], second["id"]} <= ids

    by_id = {s["id"]: s for s in sessions}
    entry = by_id[first["id"]]
    assert entry["title"] == "Episode One"
    assert entry["ended"] is False
    assert entry["recording"] is False
    assert entry["participant_count"] == 0
    assert "host_token" not in entry


def test_list_sessions_does_not_include_deleted_session(client, recordings_dir):
    created = _create_session(client, recordings_dir)
    client.delete(f"/api/session/{created['id']}", headers={"X-API-Key": "test-api-key"})

    r = client.get("/api/sessions", headers={"X-API-Key": "test-api-key"})
    assert r.status_code == 200
    ids = {s["id"] for s in r.json()["sessions"]}
    assert created["id"] not in ids
