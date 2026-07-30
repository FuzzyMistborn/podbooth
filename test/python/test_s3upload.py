"""Coverage for the S3-backed editor-delivery endpoints
(app/routers/s3upload.py) — previously untested. Focuses on:

- _file_source's path-segment boundary condition (idx + 1 < len(parts) - 1),
  which decides whether a production-subfolder file is labelled
  "production_full"/"production_speakers" or generically "production".
- The editor-link/manifest-refresh "re-list after export upload, fall back to
  the original list on failure" logic (lines ~283-287 and ~358-363 in
  s3upload.py) — if that silently-swallowed exception path were wrong,
  editors would get a manifest missing files with no visible error.
- Filename/content-type validation on the presigned-upload-URL endpoint.
"""
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import s3upload


@pytest.fixture
def app():
    api = FastAPI()
    api.include_router(s3upload.router)
    return api


@pytest.fixture
def client(app):
    return TestClient(app)


# ── _file_source ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("key,expected", [
    ("PodBooth/MySlug/production/full/Alice_video.mp4", "production_full"),
    ("PodBooth/MySlug/production/speakers/Alice_video.mp4", "production_speakers"),
    # "production" is the last path segment before the filename itself —
    # there's no sub-folder component to classify as full/speakers.
    ("PodBooth/MySlug/production/Alice_video.mp4", "production"),
    ("PodBooth/MySlug/local/Alice_video.mp4", "local"),
    ("PodBooth/MySlug/podbooth/Alice/Alice_video.mp4", "podbooth"),
    ("sessions/abc123/exports/Show.otio", "exports"),
    ("sessions/abc123/manifest.json", ""),
])
def test_file_source_classifies_known_prefixes(key, expected):
    assert s3upload._file_source(key) == expected


def test_file_source_production_immediately_before_filename_is_not_full_or_speakers():
    # Regression guard for the idx + 1 < len(parts) - 1 boundary check: a key
    # where "production" is the second-to-last segment (i.e. the file sits
    # directly under production/, not production/full/ or production/speakers/)
    # must not be misclassified as "production_full" just because something
    # happens to be at parts[idx+1].
    key = "PodBooth/MySlug/production/Alice.mp4"
    assert s3upload._file_source(key) == "production"


# ── get_upload_url filename/content-type validation ─────────────────────────

@pytest.fixture
def session(recordings_dir):
    from app.models import Session, _sessions
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


def test_upload_url_rejects_path_traversal_filename(client, session, recordings_dir):
    r = client.post(
        f"/api/session/{session.id}/s3/upload-url",
        json={"filename": "../../etc/passwd", "content_type": "audio/wav"},
    )
    assert r.status_code == 400


def test_upload_url_rejects_disallowed_content_type(client, session, recordings_dir):
    r = client.post(
        f"/api/session/{session.id}/s3/upload-url",
        json={"filename": "clip.wav", "content_type": "application/x-msdownload"},
    )
    assert r.status_code == 400


def test_upload_url_success_records_placeholder_r2_file(client, session, recordings_dir, monkeypatch):
    monkeypatch.setattr(s3upload.s3, "generate_upload_url", lambda key, ct: f"https://fake/{key}")
    r = client.post(
        f"/api/session/{session.id}/s3/upload-url",
        json={"filename": "clip.wav", "content_type": "audio/wav"},
    )
    assert r.status_code == 200
    assert session.r2_files[0]["key"] == f"sessions/{session.id}/clip.wav"


# ── editor-link / manifest-refresh re-list-after-export fallback ────────────

@pytest.fixture
def session_with_file(session):
    session.r2_files = [{
        "key": f"sessions/{session.id}/clip.wav",
        "filename": "clip.wav",
        "size_bytes": 100,
        "uploaded_at": "2026-01-01T00:00:00+00:00",
        "uploader": "Alice",
    }]
    return session


def _stub_common(monkeypatch, *, list_objects, upload_export=None):
    monkeypatch.setattr(s3upload, "_upload_export_files", upload_export or (lambda *a, **k: None))
    monkeypatch.setattr(s3upload.s3, "list_session_objects", list_objects)
    monkeypatch.setattr(s3upload.s3, "generate_download_url", lambda key, expires_in: f"https://fake/{key}")
    monkeypatch.setattr(s3upload.s3, "put_object", lambda *a, **k: None)
    monkeypatch.setattr(s3upload, "notify_editor_link", _noop_async)


async def _noop_async(*args, **kwargs):
    return None


def test_editor_link_falls_back_to_original_listing_when_relist_fails(client, session_with_file, recordings_dir, monkeypatch):
    calls = {"n": 0}

    def _list(session_id, extra, extra_pfx):
        calls["n"] += 1
        if calls["n"] == 1:
            return [{"key": session_with_file.r2_files[0]["key"], "size_bytes": 100,
                      "last_modified": "2026-01-01T00:00:00+00:00"}]
        raise RuntimeError("transient S3 error on re-list")

    async def _export_export_files(*a, **k):
        return None

    _stub_common(monkeypatch, list_objects=_list, upload_export=_export_export_files)

    r = client.post(f"/api/session/{session_with_file.id}/s3/editor-link")
    assert r.status_code == 200, r.text
    assert session_with_file.editor_token_hash


def test_editor_link_with_no_files_returns_400(client, session, recordings_dir, monkeypatch):
    _stub_common(monkeypatch, list_objects=lambda *a, **k: [])
    r = client.post(f"/api/session/{session.id}/s3/editor-link")
    assert r.status_code == 400


def test_manifest_refresh_requires_existing_editor_link(client, session_with_file, recordings_dir, monkeypatch):
    _stub_common(monkeypatch, list_objects=lambda *a, **k: [
        {"key": session_with_file.r2_files[0]["key"], "size_bytes": 100,
         "last_modified": "2026-01-01T00:00:00+00:00"}
    ])
    r = client.post(f"/api/session/{session_with_file.id}/s3/manifest-refresh")
    assert r.status_code == 400
    assert "generate one first" in r.json()["detail"]


def test_manifest_refresh_falls_back_to_original_listing_when_relist_fails(client, session_with_file, recordings_dir, monkeypatch):
    session_with_file.editor_token_hash = "existing-hash"
    calls = {"n": 0}

    def _list(session_id, extra, extra_pfx):
        calls["n"] += 1
        if calls["n"] == 1:
            return [{"key": session_with_file.r2_files[0]["key"], "size_bytes": 100,
                      "last_modified": "2026-01-01T00:00:00+00:00"}]
        raise RuntimeError("transient S3 error on re-list")

    async def _export_export_files(*a, **k):
        return None

    _stub_common(monkeypatch, list_objects=_list, upload_export=_export_export_files)

    r = client.post(f"/api/session/{session_with_file.id}/s3/manifest-refresh")
    assert r.status_code == 200, r.text
    assert r.json()["file_count"] == 1
