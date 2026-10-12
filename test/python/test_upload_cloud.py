"""Direct-to-cloud upload endpoints (/api/upload/cloud/*) and the background
pull: browsers upload a stopped recording's raw tracks straight to the
bucket in parts — this server's own peering was the bottleneck for guests —
and the server pulls each finished object down, transcodes it, and deletes
the bucket copy only once that succeeded.

The bucket is an in-memory fake standing in for app.s3's functions.
"""
import asyncio
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import s3
from app.config import settings
from app.routers import upload


class FakeBucket:
    def __init__(self):
        self.parts: dict[int, int] = {}  # part_number -> size
        self.objects: dict[str, bytes] = {}
        self.completed = []
        self.deleted = []
        self.aborted = []
        self.list_raises = False

    def create_multipart_upload(self, key, content_type="application/octet-stream"):
        return "up-1"

    def generate_part_upload_url(self, key, upload_id, part_number, expires_in=3600):
        return f"https://bucket.example/{key}?partNumber={part_number}"

    def list_uploaded_parts(self, key, upload_id):
        if self.list_raises:
            raise RuntimeError("NoSuchUpload")
        return [{"part_number": n, "etag": f"etag{n}", "size": size} for n, size in sorted(self.parts.items())]

    def complete_multipart_upload(self, key, upload_id, parts):
        self.completed.append((key, [p["part_number"] for p in parts]))
        self.objects[key] = b"\x01" * sum(self.parts.values())

    def object_exists(self, key):
        return key in self.objects

    def abort_multipart_upload(self, key, upload_id):
        self.aborted.append(key)

    def download_object_to_path(self, key, dest, on_progress=None):
        data = self.objects[key]
        with open(dest, "wb") as f:
            f.write(data)
        if on_progress:
            on_progress(0.5)
            on_progress(1.0)
        return len(data)

    def delete_object(self, key):
        self.deleted.append(key)
        self.objects.pop(key, None)


@pytest.fixture
def bucket(monkeypatch):
    b = FakeBucket()
    for name in ("create_multipart_upload", "generate_part_upload_url", "list_uploaded_parts",
                 "complete_multipart_upload", "object_exists", "abort_multipart_upload",
                 "download_object_to_path", "delete_object"):
        monkeypatch.setattr(s3, name, getattr(b, name))
    monkeypatch.setattr(s3, "s3_upload_configured", lambda: True)
    monkeypatch.setattr(s3, "upload_prefix", lambda: "PodBooth")
    monkeypatch.setattr(settings, "direct_cloud_upload", True)
    upload._assembly_progress.clear()
    yield b
    upload._assembly_progress.clear()


@pytest.fixture
def live_client():
    # As a context manager the client keeps one event loop running across
    # requests, so the background pull /cloud/complete schedules can run.
    api = FastAPI()
    api.include_router(upload.router)
    with TestClient(api) as c:
        yield c


KEY = "PodBooth/raw-uploads/test-session/Alice/audio_ep1.raw"


def _start(client, **overrides):
    body = {"session_id": "test-session", "participant": "Alice", "identity": "alice-id",
            "track_type": "audio", "epoch": "ep1", "ext": "raw", "total_size": 3000}
    body.update(overrides)
    return client.post("/api/upload/cloud/start", json=body)


def _complete_body(**overrides):
    body = {"session_id": "test-session", "participant": "Alice", "identity": "alice-id",
            "track_type": "audio", "epoch": "ep1", "format": "pcm", "sample_rate": 48000, "channels": 2,
            "start_time_ms": 1234.5, "expected_duration_s": 60,
            "key": KEY, "upload_id": "up-1", "ext": "raw", "part_count": 3, "total_size": 3000}
    body.update(overrides)
    return body


def test_start_is_refused_when_direct_upload_is_off(client, session, bucket, monkeypatch):
    monkeypatch.setattr(settings, "direct_cloud_upload", False)
    assert _start(client).status_code == 503


def test_start_returns_a_session_scoped_key(client, session, bucket):
    r = _start(client)
    assert r.status_code == 200, r.text
    assert r.json() == {"key": KEY, "upload_id": "up-1", "part_size": upload.CLOUD_UPLOAD_PART_BYTES}


def test_start_requires_a_joined_participant(client, session, bucket):
    assert _start(client, identity="someone-else").status_code == 403


def test_part_url_refuses_another_sessions_key(client, session, bucket):
    r = client.post("/api/upload/cloud/part-url", json={
        "session_id": "test-session", "key": "PodBooth/raw-uploads/other-session/Bob/audio_ep1.raw",
        "upload_id": "up-1", "part_number": 1,
    })
    assert r.status_code == 403


def test_complete_refuses_a_partial_upload(live_client, session, bucket):
    bucket.parts = {1: 1000, 3: 1000}  # part 2 never landed

    r = live_client.post("/api/upload/cloud/complete", json=_complete_body())

    assert r.status_code == 409
    assert bucket.completed == []
    assert not upload._assembly_in_progress


def test_complete_finishes_the_upload_and_pulls_transcodes_and_deletes_in_the_background(
        live_client, session, recordings_dir, bucket, monkeypatch):
    bucket.parts = {1: 1000, 2: 1000, 3: 1000}
    transcoded = []

    async def fake_assemble(directory, track_type, fmt, sample_rate, channels, source, epoch, participant, dur):
        transcoded.append((track_type, fmt, source.name, source.stat().st_size, epoch))
        return True

    monkeypatch.setattr(upload, "assemble_from_source", fake_assemble)

    r = live_client.post("/api/upload/cloud/complete", json=_complete_body())

    assert r.status_code == 200, r.text
    assert bucket.completed == [(KEY, [1, 2, 3])]
    # The take's start time is saved for A/V alignment, same as /finalize.
    sidecar = recordings_dir / session.dir_name / "Alice" / "audio_ep1_start.json"
    assert json.loads(sidecar.read_text()) == {"start_time_ms": 1234.5}
    deadline = time.monotonic() + 5
    while bucket.deleted == [] and time.monotonic() < deadline:
        live_client.get("/api/upload/chunks", params={"session_id": "x"})  # let the loop run
        time.sleep(0.01)
    assert transcoded == [("audio", "pcm", "audio_ep1_source.raw", 3000, "ep1")]
    assert bucket.deleted == [KEY]


def test_complete_retry_after_a_previous_attempt_already_completed_it(live_client, session, bucket, monkeypatch):
    # S3 invalidates the upload_id once completed, so listing its parts fails
    # — but the object exists, so the retry carries on to the pull.
    bucket.list_raises = True
    bucket.objects[KEY] = b"x" * 3000

    async def fake_pull(f, key, ext):
        return None

    monkeypatch.setattr(upload, "_pull_cloud_source_and_assemble", fake_pull)

    assert live_client.post("/api/upload/cloud/complete", json=_complete_body()).status_code == 200


def test_complete_fails_when_neither_completable_nor_already_complete(client, session, bucket):
    bucket.list_raises = True
    assert client.post("/api/upload/cloud/complete", json=_complete_body()).status_code == 503


def _finalize(directory):
    return upload._Finalize("test-session", "Alice", "audio", "pcm", "ep1", 48000, 2, 60.0, None, directory)


@pytest.mark.asyncio
async def test_pull_reports_download_progress_and_keeps_the_bucket_copy_if_transcode_fails(
        session, recordings_dir, bucket, monkeypatch):
    directory = recordings_dir / session.dir_name / "Alice"
    directory.mkdir(parents=True)
    bucket.objects[KEY] = b"\x01" * 3000
    stages = []
    real_report = upload._report_progress
    monkeypatch.setattr(upload, "_report_progress",
                        lambda d, job, epoch, stage, fraction: (stages.append(stage), real_report(d, job, epoch, stage, fraction)))

    async def failing_assemble(*a, **k):
        return False

    monkeypatch.setattr(upload, "assemble_from_source", failing_assemble)

    await upload._pull_cloud_source_and_assemble(_finalize(directory), KEY, "raw")

    assert "downloading" in stages
    assert bucket.deleted == []  # still the only complete copy — kept for a retry


@pytest.mark.asyncio
async def test_pull_failure_keeps_the_bucket_copy_and_marks_the_job_failed(session, recordings_dir, bucket, monkeypatch):
    directory = recordings_dir / session.dir_name / "Alice"
    directory.mkdir(parents=True)

    def broken_download(key, dest, on_progress=None):
        raise ConnectionError("reset by peer")

    monkeypatch.setattr(s3, "download_object_to_path", broken_download)

    await upload._pull_cloud_source_and_assemble(_finalize(directory), KEY, "raw")

    assert bucket.deleted == []
    assert not (directory / "audio_ep1_source.raw").exists()
    assert [v["stage"] for v in upload._assembly_progress.values()] == ["failed"]


def test_deleting_a_session_also_clears_its_leftover_raw_uploads(monkeypatch):
    listed = []

    class FakePaginator:
        def paginate(self, Bucket, Prefix):
            listed.append(Prefix)
            return [{"Contents": [{"Key": Prefix + "file"}]}]

    class FakeClient:
        def get_paginator(self, name):
            return FakePaginator()

        def delete_objects(self, Bucket, Delete):
            return {}

    monkeypatch.setattr(s3, "get_client", lambda: FakeClient())
    monkeypatch.setattr(s3, "_bucket", lambda: "bucket")
    monkeypatch.setattr(s3, "upload_prefix", lambda: "PodBooth")

    s3.delete_session_objects("sess-9")

    assert "PodBooth/raw-uploads/sess-9/" in listed
