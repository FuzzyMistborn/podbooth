"""Coverage for the participant local-recording upload endpoint
(app/routers/localupload.py) — previously untested despite carrying most of
the security logic for this project's one path that accepts arbitrary
participant-supplied files without a host session: token auth, filename/
extension allowlisting, content-type allowlisting, and a hard size cap that
must abort mid-stream rather than after the fact.
"""
from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models import Session, _sessions
from app.routers import localupload


@pytest.fixture
def app():
    api = FastAPI()
    api.include_router(localupload.router)
    return api


@pytest.fixture
def session(recordings_dir):
    # localupload._verify_upload_token compares against session.created_at
    # using naive datetime.now(), matching how the real app creates sessions
    # (models.py's create() uses naive datetime.now(), not an aware one) —
    # the shared conftest `session` fixture is tz-aware and would make every
    # request here raise TypeError on naive-minus-aware subtraction.
    s = Session(
        id="test-session",
        title="Test Session",
        host_token="host-secret",
        created_at=datetime.now(),
        dir_name="test-session",
    )
    _sessions[s.id] = s
    yield s
    _sessions.pop(s.id, None)


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_status():
    from app.limiter import limiter

    localupload._local_upload_status.clear()
    limiter.reset()
    yield
    localupload._local_upload_status.clear()


@pytest.fixture
def one_backend(monkeypatch):
    """Fake a single enabled cloud backend so start_local_upload doesn't 400
    on "No cloud upload configured", and capture what it was asked to upload."""
    uploaded_items = []

    from app.routers.cloudsync import S3Backend

    # Must be an S3Backend (not just anything implementing upload()) —
    # start_local_upload only records r2_files for S3Backend instances, since
    # that's what computes the storage key the editor-delivery flow needs.
    backend = S3Backend(
        backend_name="Fake",
        endpoint_url="https://fake.example",
        access_key_id="id",
        access_key_secret="secret",
        bucket="bucket",
        upload_path="",
    )

    async def _fake_upload(items):
        uploaded_items.append(items)
        return len(items), ""

    monkeypatch.setattr(backend, "upload", _fake_upload)
    monkeypatch.setattr(localupload, "_get_backends", lambda: [backend])
    return uploaded_items


def _upload(client, session, *, filename="clip.wav", content=b"data",
            content_type="audio/wav", token=None, participant="Alice"):
    return client.post(
        f"/api/session/{session.id}/local-upload",
        headers={
            "X-Upload-Token": token if token is not None else session.upload_token,
            "X-Participant": participant,
        },
        files={"file": (filename, content, content_type)},
    )


def test_missing_token_is_rejected(client, session, recordings_dir, one_backend):
    r = _upload(client, session, token="")
    assert r.status_code == 403


def test_wrong_token_is_rejected(client, session, recordings_dir, one_backend):
    r = _upload(client, session, token="not-the-real-token")
    assert r.status_code == 403


def test_expired_token_is_rejected(client, session, recordings_dir, one_backend):
    session.created_at = datetime.now() - timedelta(days=15)
    r = _upload(client, session, token=session.upload_token)
    assert r.status_code == 403
    assert "expired" in r.json()["detail"].lower()


@pytest.mark.parametrize("filename", [
    "../../etc/passwd.wav",
    "..%2f..%2fetc%2fpasswd.wav",
    "a/b.wav",
    "a\\b.wav",
    "..\x00.wav",
])
def test_path_traversal_filenames_are_rejected(client, session, recordings_dir, one_backend, filename):
    r = _upload(client, session, filename=filename)
    # Path.name strips directory components, so some of these resolve to a
    # bare (still-safe) filename rather than a 400 — what must never happen
    # is the file landing outside session/local/. Assert on the concrete
    # invariant instead of a blanket status code.
    if r.status_code == 200:
        assert "/" not in r.json()["filename"]
        assert "\\" not in r.json()["filename"]
    else:
        assert r.status_code == 400


def test_disallowed_extension_is_rejected(client, session, recordings_dir, one_backend):
    r = _upload(client, session, filename="clip.exe", content_type="application/octet-stream")
    assert r.status_code == 400
    assert "not allowed" in r.json()["detail"]


def test_disallowed_content_type_is_rejected(client, session, recordings_dir, one_backend):
    r = _upload(client, session, filename="clip.wav", content_type="text/html")
    assert r.status_code == 415


def test_no_cloud_backend_configured_returns_400(client, session, recordings_dir, monkeypatch):
    monkeypatch.setattr(localupload, "_get_backends", lambda: [])
    r = _upload(client, session)
    assert r.status_code == 400


def test_oversized_upload_is_aborted_mid_stream(client, session, recordings_dir, one_backend, monkeypatch):
    monkeypatch.setattr(localupload, "MAX_UPLOAD_BYTES", 10)
    r = _upload(client, session, content=b"x" * 1000)
    assert r.status_code == 413


def test_successful_upload_records_r2_file_once_backend_reports_done(client, session, recordings_dir, one_backend):
    r = _upload(client, session, filename="clip.wav")
    assert r.status_code == 200
    upload_id = r.json()["upload_id"]

    # The upload runs on a background task; TestClient's sync HTTP call
    # doesn't await it, but starlette's TestClient runs the event loop
    # synchronously enough that by the time the response returns here the
    # background task (a single fast in-process fake backend call) has
    # already been scheduled. Poll briefly to avoid a flaky race.
    import time
    status = {}
    for _ in range(50):
        sr = client.get(
            f"/api/session/{session.id}/local-upload/{upload_id}/status",
            headers={"X-Upload-Token": session.upload_token},
        )
        status = sr.json()
        if status.get("status") == "done":
            break
        time.sleep(0.02)

    assert status.get("status") == "done"
    assert len(session.r2_files) == 1
    assert session.r2_files[0]["filename"] == "clip.wav"
    assert session.r2_files[0]["uploader"] == "Alice"


def test_status_endpoint_rejects_bad_token(client, session, recordings_dir):
    r = client.get(
        f"/api/session/{session.id}/local-upload/{'a' * 32}/status",
        headers={"X-Upload-Token": "wrong"},
    )
    assert r.status_code == 403


def test_status_endpoint_rejects_non_uuid_upload_id(client, session, recordings_dir):
    r = client.get(
        f"/api/session/{session.id}/local-upload/not-a-uuid/status",
        headers={"X-Upload-Token": session.upload_token},
    )
    assert r.status_code == 400
