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
import asyncio
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


# ── manifest auto-refresh (debounced, no editor link required) ──────────────
# A new file landing in R2 (participant local-disk upload / cloudsync) should
# eventually update an already-existing editor manifest without the host
# manually hitting "refresh" — see schedule_manifest_auto_refresh in
# s3upload.py. Exercises the debounce/cancel bookkeeping and the
# no-editor-link no-op directly, without waiting out the real multi-hour
# debounce window (sleep is monkeypatched out; _debounced_manifest_refresh's
# post-sleep body is what actually does the work).

@pytest.mark.asyncio
async def test_auto_refresh_noop_when_no_editor_link_exists(session, recordings_dir, monkeypatch):
    monkeypatch.setattr(s3upload.asyncio, "sleep", _noop_async)
    put_calls = []
    monkeypatch.setattr(s3upload.s3, "put_object", lambda *a, **k: put_calls.append(a))

    def _list_should_not_be_called(*a, **k):
        raise AssertionError("should never list — no editor link to refresh")
    monkeypatch.setattr(s3upload.s3, "list_session_objects", _list_should_not_be_called)

    await s3upload._debounced_manifest_refresh(session.id)

    assert put_calls == []


@pytest.mark.asyncio
async def test_auto_refresh_rewrites_manifest_when_editor_link_exists(session_with_file, recordings_dir, monkeypatch):
    session_with_file.editor_token_hash = "existing-hash"
    monkeypatch.setattr(s3upload.asyncio, "sleep", _noop_async)
    export_calls = []

    async def _track_export(*a, **k):
        export_calls.append(a)

    _stub_common(monkeypatch, list_objects=lambda *a, **k: [
        {"key": session_with_file.r2_files[0]["key"], "size_bytes": 100,
         "last_modified": "2026-01-01T00:00:00+00:00"}
    ], upload_export=_track_export)
    put_calls = []
    monkeypatch.setattr(s3upload.s3, "put_object", lambda key, body, ct: put_calls.append(key))

    await s3upload._debounced_manifest_refresh(session_with_file.id)

    assert put_calls == [f"sessions/{session_with_file.id}/manifest.json"]
    # The auto path must never touch export generation (real ffmpeg work) —
    # only the explicit host-triggered editor-link/manifest-refresh actions do.
    assert export_calls == []


@pytest.mark.asyncio
async def test_schedule_auto_refresh_cancels_previous_pending_task_for_same_session():
    # Real debounce window is hours long; scheduling twice back-to-back must
    # cancel the first pending timer rather than leaving two in flight.
    s3upload.schedule_manifest_auto_refresh("sched-test-session")
    first_task = s3upload._pending_manifest_refresh["sched-test-session"]
    s3upload.schedule_manifest_auto_refresh("sched-test-session")
    second_task = s3upload._pending_manifest_refresh["sched-test-session"]
    assert first_task is not second_task

    # _debounced_manifest_refresh catches CancelledError and returns cleanly
    # (see s3upload.py), so a cancelled task reports done rather than
    # .cancelled() — what matters here is that the *first* timer stopped
    # running once the second one was scheduled.
    await asyncio.sleep(0)  # let the cancellation actually land
    assert first_task.done()

    s3upload.cancel_pending_manifest_refresh("sched-test-session")
    assert "sched-test-session" not in s3upload._pending_manifest_refresh
    await asyncio.sleep(0)
    assert second_task.done()
