import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.config import settings
from app.models import Session, _sessions


@pytest.fixture
def recordings_dir(tmp_path, monkeypatch):
    """Point the app at a throwaway recordings directory for this test only."""
    monkeypatch.setattr(settings, "recordings_dir", str(tmp_path))
    return tmp_path


@pytest.fixture
def session(recordings_dir):
    """A real Session registered in the in-memory session store upload.py reads
    via get_session — same shape a live session created through the app has."""
    s = Session(
        id="test-session",
        title="Test Session",
        host_token="host-secret",
        created_at=datetime.now(timezone.utc),
        dir_name="test-session",
    )
    # Most upload tests act as "Alice"/"alice-id", already joined via
    # /api/token — real clients only reach the chunk/finalize/cloud endpoints
    # after that call succeeds (see _require_joined_participant in
    # upload.py), so pre-seed it here rather than in every test.
    s.participants["Alice"] = datetime.now(timezone.utc).isoformat()
    s.identities["alice-id"] = "Alice"
    s.identities["id-1"] = "Alice"
    _sessions[s.id] = s
    yield s
    _sessions.pop(s.id, None)


@pytest.fixture
def app():
    from fastapi import FastAPI
    from app.routers import upload as upload_router

    api = FastAPI()
    api.include_router(upload_router.router)
    return api


@pytest.fixture
def client(app):
    from fastapi.testclient import TestClient
    return TestClient(app)
