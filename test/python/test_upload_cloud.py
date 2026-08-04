"""Coverage for the direct-to-cloud FSA upload endpoints
(/api/upload/cloud/start, /part-url, /parts, /complete in app/routers/upload.py)
— previously untested since this is a new feature.

These endpoints let a guest's browser PUT multipart parts straight to the
configured S3-compatible backend (bypassing this app server's link, which can
be much slower than guests' own uplinks), then have the server pull the
finished object back down on its own link before handing off to the existing
ffmpeg transcode pipeline. Real boto3/S3 calls are stubbed via monkeypatch on
`upload.s3.*`, matching the pattern already used in test_s3upload.py — these
tests exercise the endpoints' own validation/orchestration logic, not boto3
itself.
"""
import json

import pytest

from app.config import settings
from app.routers import upload


def _stub_cloud_backend(monkeypatch, *, configured=True):
    monkeypatch.setattr(upload.s3, "s3_upload_configured", lambda: configured)
    monkeypatch.setattr(upload.s3, "create_multipart_upload", lambda key, ct: "fake-upload-id")
    monkeypatch.setattr(upload.s3, "generate_part_upload_url", lambda key, uid, n, expires_in=3600: f"https://bucket.example/{key}/{n}")
    monkeypatch.setattr(upload.s3, "list_uploaded_parts", lambda key, uid: [])
    monkeypatch.setattr(upload.s3, "complete_multipart_upload", lambda key, uid, parts: None)
    monkeypatch.setattr(upload.s3, "delete_object", lambda key: None)


# ── /cloud/start ─────────────────────────────────────────────────────────────

def test_cloud_start_returns_upload_id_and_key(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    r = client.post("/api/upload/cloud/start", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm", "total_size": 1000,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["upload_id"] == "fake-upload-id"
    assert body["key"].endswith("video_ep1.webm")
    assert body["part_size"] == upload.CLOUD_UPLOAD_PART_BYTES


def test_cloud_start_503_when_no_s3_backend_configured(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch, configured=False)
    r = client.post("/api/upload/cloud/start", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm", "total_size": 1000,
    })
    assert r.status_code == 503


def test_cloud_start_rejects_over_participant_cap(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    monkeypatch.setattr(settings, "max_participant_upload_gb", 20 / (1024 ** 3))  # 20 bytes
    r = client.post("/api/upload/cloud/start", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm", "total_size": 1000,
    })
    assert r.status_code == 413


def test_cloud_start_rejects_invalid_ext(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    r = client.post("/api/upload/cloud/start", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "exe", "total_size": 1000,
    })
    assert r.status_code == 400


# ── /cloud/part-url and /cloud/parts ────────────────────────────────────────

def _own_key(session):
    return f"raw-uploads/{session.id}/Alice/audio_ep1.wav"


def test_cloud_part_url_returns_presigned_url(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    key = _own_key(session)
    r = client.post("/api/upload/cloud/part-url", json={"session_id": session.id, "key": key, "upload_id": "fake-upload-id", "part_number": 2})
    assert r.status_code == 200
    assert r.json()["url"] == f"https://bucket.example/{key}/2"


def test_cloud_part_url_rejects_a_key_from_another_session(client, session, recordings_dir, monkeypatch):
    # Without this check a client that somehow learned another session's
    # key+upload_id could get a presigned URL to upload parts into that
    # session's multipart upload.
    _stub_cloud_backend(monkeypatch)
    r = client.post("/api/upload/cloud/part-url", json={
        "session_id": session.id, "key": "raw-uploads/some-other-session/Alice/audio_ep1.wav",
        "upload_id": "fake-upload-id", "part_number": 2,
    })
    assert r.status_code == 403


def test_cloud_parts_lists_uploaded_parts_for_resume(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    monkeypatch.setattr(upload.s3, "list_uploaded_parts", lambda key, uid: [{"part_number": 1, "etag": '"a"', "size": 5}])
    r = client.get("/api/upload/cloud/parts", params={"session_id": session.id, "key": _own_key(session), "upload_id": "u"})
    assert r.status_code == 200
    assert r.json()["parts"] == [{"part_number": 1, "etag": '"a"', "size": 5}]


def test_cloud_parts_rejects_a_key_from_another_session(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    r = client.get("/api/upload/cloud/parts", params={
        "session_id": session.id, "key": "raw-uploads/some-other-session/Alice/audio_ep1.wav", "upload_id": "u",
    })
    assert r.status_code == 403


# ── /cloud/abort ─────────────────────────────────────────────────────────────

def test_cloud_abort_calls_s3_abort(client, session, recordings_dir, monkeypatch):
    # Called when the client cancels an in-progress upload — without this
    # wired up, a cancelled recording leaves an orphaned incomplete
    # multipart upload sitting in the bucket forever.
    _stub_cloud_backend(monkeypatch)
    aborted = []
    monkeypatch.setattr(upload.s3, "abort_multipart_upload", lambda key, uid: aborted.append((key, uid)))
    key = _own_key(session)
    r = client.post("/api/upload/cloud/abort", json={"session_id": session.id, "key": key, "upload_id": "fake-upload-id"})
    assert r.status_code == 200
    assert aborted == [(key, "fake-upload-id")]


def test_cloud_abort_requires_session_key_and_upload_id(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    r = client.post("/api/upload/cloud/abort", json={"session_id": session.id, "key": "", "upload_id": "fake-upload-id"})
    assert r.status_code == 400


def test_cloud_abort_rejects_a_key_from_another_session(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    r = client.post("/api/upload/cloud/abort", json={
        "session_id": session.id, "key": "raw-uploads/some-other-session/Alice/audio_ep1.wav", "upload_id": "u",
    })
    assert r.status_code == 403


# ── /cloud/complete ──────────────────────────────────────────────────────────

def test_cloud_complete_downloads_source_deletes_bucket_object_and_triggers_assembly(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)

    downloaded = {}

    def _fake_download(key, dest):
        downloaded["key"] = key
        downloaded["dest"] = dest
        dest.write_bytes(b"fake video bytes")
        return len(b"fake video bytes")

    monkeypatch.setattr(upload.s3, "download_object_to_path", _fake_download)

    deleted = []
    monkeypatch.setattr(upload.s3, "delete_object", lambda key: deleted.append(key))

    assembled = []

    async def _fake_assemble_from_source(directory, track_type, fmt, sample_rate, channels, source, epoch="", participant="", expected_duration_s=None):
        assembled.append((track_type, epoch, source))

    monkeypatch.setattr(upload, "assemble_from_source", _fake_assemble_from_source)

    key = f"raw-uploads/{session.id}/Alice/video_ep1.webm"
    r = client.post("/api/upload/cloud/complete", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm",
        "key": key, "upload_id": "fake-upload-id",
        "parts": [{"part_number": 1, "etag": '"a"'}, {"part_number": 2, "etag": '"b"'}],
    })
    assert r.status_code == 200
    assert r.json()["assembling"] is True

    assert downloaded["key"] == key
    assert downloaded["dest"].name == "video_ep1_source.webm"
    assert downloaded["dest"].read_bytes() == b"fake video bytes"
    assert deleted == [key]

    # assemble_from_source runs as a background asyncio task — give it a beat
    # to actually run before asserting on it.
    import time
    for _ in range(50):
        if assembled:
            break
        time.sleep(0.02)
    assert assembled == [("video", "ep1", downloaded["dest"])]


def test_cloud_complete_keeps_bucket_object_if_download_fails(client, session, recordings_dir, monkeypatch):
    # If the pull-back to local disk fails, the bucket copy must not be
    # deleted — it's still the only complete copy of the recording, and a
    # retried /cloud/complete needs to be able to download it again.
    _stub_cloud_backend(monkeypatch)

    def _fail_download(key, dest):
        raise RuntimeError("network blip")

    monkeypatch.setattr(upload.s3, "download_object_to_path", _fail_download)
    deleted = []
    monkeypatch.setattr(upload.s3, "delete_object", lambda key: deleted.append(key))

    r = client.post("/api/upload/cloud/complete", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm",
        "key": f"raw-uploads/{session.id}/Alice/video_ep1.webm", "upload_id": "fake-upload-id",
        "parts": [{"part_number": 1, "etag": '"a"'}],
    })
    assert r.status_code == 503
    assert deleted == []


def test_cloud_complete_keeps_bucket_object_if_download_is_empty(client, session, recordings_dir, monkeypatch):
    # A zero-byte download isn't usable as a source file, and it isn't a
    # "the download failed" exception either — the bucket copy must still
    # survive so a retry has something to re-download.
    _stub_cloud_backend(monkeypatch)

    def _empty_download(key, dest):
        dest.write_bytes(b"")
        return 0

    monkeypatch.setattr(upload.s3, "download_object_to_path", _empty_download)
    deleted = []
    monkeypatch.setattr(upload.s3, "delete_object", lambda key: deleted.append(key))
    assembled = []
    monkeypatch.setattr(upload, "assemble_from_source", lambda *a, **k: assembled.append(1))

    r = client.post("/api/upload/cloud/complete", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm",
        "key": f"raw-uploads/{session.id}/Alice/video_ep1.webm", "upload_id": "fake-upload-id",
        "parts": [{"part_number": 1, "etag": '"a"'}],
    })
    assert r.status_code == 503
    assert deleted == []
    assert assembled == []


def test_cloud_complete_retries_download_when_upload_already_completed(client, session, recordings_dir, monkeypatch):
    # S3 invalidates upload_id once complete_multipart_upload succeeds. If a
    # first /cloud/complete call finished the multipart upload but then died
    # on the download-back step, a retry's complete_multipart_upload call
    # fails (NoSuchUpload) even though the object is sitting there ready to
    # download — the retry must fall through to the download instead of
    # erroring out and leaving the track stuck forever.
    _stub_cloud_backend(monkeypatch)

    def _already_completed(key, uid, parts):
        raise RuntimeError("NoSuchUpload: The specified multipart upload does not exist")

    monkeypatch.setattr(upload.s3, "complete_multipart_upload", _already_completed)
    monkeypatch.setattr(upload.s3, "object_exists", lambda key: True)

    def _fake_download(key, dest):
        dest.write_bytes(b"video-bytes")
        return len(b"video-bytes")
    monkeypatch.setattr(upload.s3, "download_object_to_path", _fake_download)
    deleted = []
    monkeypatch.setattr(upload.s3, "delete_object", lambda key: deleted.append(key))
    assembled = []

    async def _fake_assemble_from_source(*a, **k):
        assembled.append(1)

    monkeypatch.setattr(upload, "assemble_from_source", _fake_assemble_from_source)

    r = client.post("/api/upload/cloud/complete", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm",
        "key": f"raw-uploads/{session.id}/Alice/video_ep1.webm", "upload_id": "fake-upload-id",
        "parts": [{"part_number": 1, "etag": '"a"'}],
    })
    assert r.status_code == 200
    assert deleted == [f"raw-uploads/{session.id}/Alice/video_ep1.webm"]

    import time
    for _ in range(50):
        if assembled:
            break
        time.sleep(0.02)
    assert assembled == [1]


def test_cloud_complete_fails_when_upload_not_actually_completed(client, session, recordings_dir, monkeypatch):
    # A genuine complete_multipart_upload failure (object doesn't exist
    # either) must still surface as an error, not be swallowed by the
    # already-completed fallback above.
    _stub_cloud_backend(monkeypatch)

    def _real_failure(key, uid, parts):
        raise RuntimeError("some other S3 error")

    monkeypatch.setattr(upload.s3, "complete_multipart_upload", _real_failure)
    monkeypatch.setattr(upload.s3, "object_exists", lambda key: False)
    downloaded = []
    monkeypatch.setattr(upload.s3, "download_object_to_path", lambda key, dest: downloaded.append(key))

    r = client.post("/api/upload/cloud/complete", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm",
        "key": f"raw-uploads/{session.id}/Alice/video_ep1.webm", "upload_id": "fake-upload-id",
        "parts": [{"part_number": 1, "etag": '"a"'}],
    })
    assert r.status_code == 503
    assert downloaded == []


def test_cloud_complete_rejects_a_key_from_another_session(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    r = client.post("/api/upload/cloud/complete", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm",
        "key": "raw-uploads/some-other-session/Alice/video_ep1.webm", "upload_id": "fake-upload-id",
        "parts": [{"part_number": 1, "etag": '"a"'}],
    })
    assert r.status_code == 403
