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

def test_cloud_part_url_returns_presigned_url(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    r = client.post("/api/upload/cloud/part-url", json={"key": "raw-uploads/x/audio_ep1.wav", "upload_id": "fake-upload-id", "part_number": 2})
    assert r.status_code == 200
    assert r.json()["url"] == "https://bucket.example/raw-uploads/x/audio_ep1.wav/2"


def test_cloud_parts_lists_uploaded_parts_for_resume(client, session, recordings_dir, monkeypatch):
    _stub_cloud_backend(monkeypatch)
    monkeypatch.setattr(upload.s3, "list_uploaded_parts", lambda key, uid: [{"part_number": 1, "etag": '"a"', "size": 5}])
    r = client.get("/api/upload/cloud/parts", params={"key": "k", "upload_id": "u"})
    assert r.status_code == 200
    assert r.json()["parts"] == [{"part_number": 1, "etag": '"a"', "size": 5}]


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

    r = client.post("/api/upload/cloud/complete", json={
        "session_id": session.id, "participant": "Alice", "identity": "id-1",
        "track_type": "video", "epoch": "ep1", "ext": "webm",
        "key": "raw-uploads/x/video_ep1.webm", "upload_id": "fake-upload-id",
        "parts": [{"part_number": 1, "etag": '"a"'}, {"part_number": 2, "etag": '"b"'}],
    })
    assert r.status_code == 200
    assert r.json()["assembling"] is True

    assert downloaded["key"] == "raw-uploads/x/video_ep1.webm"
    assert downloaded["dest"].name == "video_ep1_source.webm"
    assert downloaded["dest"].read_bytes() == b"fake video bytes"
    assert deleted == ["raw-uploads/x/video_ep1.webm"]

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
        "key": "raw-uploads/x/video_ep1.webm", "upload_id": "fake-upload-id",
        "parts": [{"part_number": 1, "etag": '"a"'}],
    })
    assert r.status_code == 503
    assert deleted == []
