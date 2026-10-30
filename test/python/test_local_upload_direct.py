"""Direct-to-cloud variant of the participant local-recording upload
(app/routers/localupload.py /local-upload/cloud/*): the browser PUTs the file
to the bucket in parts at its final key, so it never crosses this server on
the way in; the server finishes the multipart upload, reads the duration off
the bucket copy, and pulls the file down only when other (non-bucket)
backends need it.

The bucket is an in-memory fake standing in for app.s3's functions.
"""
import time
from datetime import datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import s3
from app.config import settings
from app.models import Session, _sessions
from app.routers import localupload
from app.routers.cloudsync import S3Backend

KEY_DIR = "PodBooth/Test Session/local/Alice/"
KEY = KEY_DIR + "clip.wav"


class FakeBucket:
    def __init__(self):
        self.parts: dict[int, int] = {}
        self.objects: dict[str, bytes] = {}
        self.completed = []
        self.aborted = []
        self.downloads = []
        self.list_raises = False

    def create_multipart_upload(self, key, content_type="application/octet-stream"):
        return "up-1"

    def generate_part_upload_url(self, key, upload_id, part_number, expires_in=3600):
        return f"https://bucket.example/{key}?partNumber={part_number}"

    def generate_download_url(self, key, expires_in=604800):
        return f"https://bucket.example/{key}?get"

    def list_uploaded_parts(self, key, upload_id):
        if self.list_raises:
            raise RuntimeError("NoSuchUpload")
        return [{"part_number": n, "etag": f"e{n}", "size": size} for n, size in sorted(self.parts.items())]

    def complete_multipart_upload(self, key, upload_id, parts):
        self.completed.append((key, [p["part_number"] for p in parts]))
        self.objects[key] = b"\x01" * sum(self.parts.values())

    def object_exists(self, key):
        return key in self.objects

    def abort_multipart_upload(self, key, upload_id):
        self.aborted.append(key)

    def download_object_to_path(self, key, dest, on_progress=None):
        self.downloads.append(key)
        with open(dest, "wb") as f:
            f.write(self.objects[key])
        return len(self.objects[key])


def _s3_backend(name="R2"):
    return S3Backend(backend_name=name, endpoint_url="https://acct.r2.example", access_key_id="i",
                     access_key_secret="s", bucket="bkt", upload_path="PodBooth")


@pytest.fixture
def bucket(monkeypatch):
    b = FakeBucket()
    for name in ("create_multipart_upload", "generate_part_upload_url", "generate_download_url",
                 "list_uploaded_parts", "complete_multipart_upload", "object_exists",
                 "abort_multipart_upload", "download_object_to_path"):
        monkeypatch.setattr(s3, name, getattr(b, name))
    monkeypatch.setattr(s3, "s3_upload_configured", lambda: True)
    monkeypatch.setattr(s3, "upload_prefix", lambda: "PodBooth")
    monkeypatch.setattr(s3, "_active_backend",
                        lambda: ("bkt", "auto", "https://acct.r2.example", "i", "s", None))
    monkeypatch.setattr(settings, "direct_cloud_upload", True)
    monkeypatch.setattr(localupload, "direct_cloud_upload_enabled", lambda: True)
    monkeypatch.setattr(localupload, "_get_backends", lambda: [_s3_backend()])
    probed = []

    async def fake_probe(path):
        probed.append(str(path))
        return 12.5

    monkeypatch.setattr(localupload, "_probe_duration_s", fake_probe)
    monkeypatch.setattr(localupload, "_probe_duration_fast", fake_probe)
    localupload._direct_jobs.clear()
    b.probed = probed
    registered = []

    async def fake_register(session, slug, track_type, filename, duration_s):
        registered.append((slug, track_type, filename, duration_s))

    monkeypatch.setattr(localupload, "_register_local_upload_run", fake_register)
    b.registered = registered
    return b


@pytest.fixture
def session(recordings_dir):
    s = Session(id="test-session", title="Test Session", host_token="host-secret",
                created_at=datetime.now(), dir_name="test-session")
    _sessions[s.id] = s
    yield s
    _sessions.pop(s.id, None)


@pytest.fixture
def client():
    from app.limiter import limiter
    api = FastAPI()
    api.include_router(localupload.router)
    limiter.reset()
    localupload._local_upload_status.clear()
    # As a context manager the client keeps one event loop alive across
    # requests, so the background task /complete schedules can run.
    with TestClient(api) as c:
        yield c
    localupload._local_upload_status.clear()


def _post(client, session, path, body, token=None, participant="Alice"):
    return client.post(
        f"/api/session/{session.id}/local-upload/cloud/{path}", json=body,
        headers={"X-Upload-Token": session.upload_token if token is None else token,
                 "X-Participant": participant},
    )


def _start(client, session, **overrides):
    body = {"filename": "clip.wav", "content_type": "audio/wav", "total_size": 3000}
    body.update(overrides)
    return _post(client, session, "start", body)


def _complete_body(**overrides):
    body = {"key": KEY, "upload_id": "up-1", "part_count": 1, "total_size": 3000, "content_type": "audio/wav"}
    body.update(overrides)
    return body


def _wait_for(client, session, upload_id, want=("done", "error")):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        st = client.get(f"/api/session/{session.id}/local-upload/{upload_id}/status",
                        headers={"X-Upload-Token": session.upload_token}).json()
        if st.get("status") in want:
            return st
        time.sleep(0.02)
    raise AssertionError(f"never reached {want}: {st}")


def test_start_returns_the_final_key_and_presigned_parts(client, session, bucket, monkeypatch):
    monkeypatch.setattr(localupload, "CLOUD_UPLOAD_PART_BYTES", 1000)
    r = _start(client, session)
    assert r.status_code == 200
    body = r.json()
    assert body["key"] == KEY  # same key the through-the-server path writes
    assert body["part_urls"] == [f"https://bucket.example/{KEY}?partNumber={n}" for n in (1, 2, 3)]


@pytest.mark.parametrize("token", ["", "wrong"])
def test_every_endpoint_requires_the_upload_token(client, session, bucket, token):
    for path, body in (("start", {"filename": "clip.wav", "content_type": "audio/wav", "total_size": 10}),
                       ("part-url", {"key": KEY, "upload_id": "u", "part_number": 1}),
                       ("abort", {"key": KEY, "upload_id": "u"}),
                       ("complete", _complete_body())):
        assert _post(client, session, path, body, token=token).status_code == 403, path


def test_start_validates_filename_content_type_and_size(client, session, bucket):
    assert _start(client, session, filename="a\\b.wav").status_code == 400
    assert _start(client, session, filename="x..wav").status_code == 400
    # a directory part is stripped to its basename, never reaching the key
    assert _start(client, session, filename="../../x.wav").json()["key"] == KEY_DIR + "x.wav"
    assert _start(client, session, filename="x.exe").status_code == 400
    assert _start(client, session, content_type="text/html").status_code == 415
    assert _start(client, session, total_size=0).status_code == 400
    assert _start(client, session, total_size=localupload.MAX_UPLOAD_BYTES + 1).status_code == 413


def test_start_is_refused_when_direct_upload_is_off(client, session, bucket, monkeypatch):
    monkeypatch.setattr(localupload, "direct_cloud_upload_enabled", lambda: False)
    assert _start(client, session).status_code == 503


def test_part_url_abort_and_complete_refuse_a_key_outside_the_session(client, session, bucket):
    other = "PodBooth/raw-uploads/other/audio.raw"
    assert _post(client, session, "part-url", {"key": other, "upload_id": "u", "part_number": 1}).status_code == 403
    assert _post(client, session, "abort", {"key": other, "upload_id": "u"}).status_code == 403
    assert _post(client, session, "complete", _complete_body(key=other)).status_code == 403
    assert bucket.completed == [] and bucket.aborted == []


def test_complete_refuses_a_partial_upload(client, session, bucket):
    bucket.parts = {1: 1000, 3: 1000}  # part 2 never landed
    r = _post(client, session, "complete", _complete_body(part_count=3))
    assert r.status_code == 409
    assert bucket.completed == []


def test_complete_with_only_the_bucket_never_downloads_and_records_the_file(client, session, bucket):
    bucket.parts = {1: 3000}
    r = _post(client, session, "complete", _complete_body())
    assert r.status_code == 200
    st = _wait_for(client, session, r.json()["upload_id"])
    assert st["status"] == "done"
    assert bucket.completed == [(KEY, [1])]
    assert bucket.downloads == []                      # never pulled down
    assert bucket.probed == [f"https://bucket.example/{KEY}?get"]  # probed off the bucket copy
    assert [f["key"] for f in session.r2_files] == [KEY]
    assert session.r2_files[0]["size_bytes"] == 3000
    assert bucket.registered == [("Alice", "audio", "clip.wav", 12.5)]


def test_a_transient_listing_error_is_not_mistaken_for_an_already_completed_upload(client, session, bucket, monkeypatch):
    bucket.objects[KEY] = b"stale object from an earlier upload"

    def throttled(key, upload_id):
        raise RuntimeError("SlowDown: please reduce your request rate")

    monkeypatch.setattr(s3, "list_uploaded_parts", throttled)
    assert _post(client, session, "complete", _complete_body()).status_code == 503
    assert session.r2_files == []


def test_a_parts_mismatch_aborts_the_bucket_upload(client, session, bucket):
    bucket.parts = {1: 3000}
    assert _post(client, session, "complete", _complete_body(total_size=10)).status_code == 409
    assert bucket.aborted == [KEY]


def test_a_failure_registering_the_file_is_a_warning_not_an_error(client, session, bucket, monkeypatch):
    bucket.parts = {1: 3000}

    async def broken(*a, **kw):
        raise RuntimeError("disk full")

    monkeypatch.setattr(localupload, "_record_local_upload", broken)
    r = _post(client, session, "complete", _complete_body())
    st = _wait_for(client, session, r.json()["upload_id"])
    assert st["status"] == "done" and "disk full" in st["warning"]


def test_complete_retry_after_a_previous_attempt_already_completed_it(client, session, bucket):
    bucket.list_raises = True  # RuntimeError("NoSuchUpload") in the fake
    bucket.objects[KEY] = b"x" * 3000
    r = _post(client, session, "complete", _complete_body())
    assert r.status_code == 200
    assert _wait_for(client, session, r.json()["upload_id"])["status"] == "done"


def test_complete_fails_when_neither_the_parts_nor_the_object_exist(client, session, bucket):
    bucket.list_raises = True
    assert _post(client, session, "complete", _complete_body()).status_code == 503


def test_other_backends_get_the_file_pulled_down_and_pushed(client, session, bucket, monkeypatch):
    bucket.parts = {1: 3000}
    pushed = []
    other = _s3_backend("B2")
    other._bucket = "other-bucket"  # a different bucket than the one the browser wrote to
    other._upload_path = "Other"

    async def fake_upload(items):
        pushed.append([(i.remote_path, i.local_path.read_bytes()) for i in items])
        return len(items), ""

    monkeypatch.setattr(other, "upload", fake_upload)
    monkeypatch.setattr(localupload, "_get_backends", lambda: [_s3_backend(), other])
    r = _post(client, session, "complete", _complete_body())
    st = _wait_for(client, session, r.json()["upload_id"])
    assert st["status"] == "done"
    assert bucket.downloads == [KEY]
    assert pushed == [[("Test Session/local/Alice/clip.wav", b"\x01" * 3000)]]
    # Both buckets' keys are recorded for editor delivery; the temp file is gone.
    assert [f["key"] for f in session.r2_files] == [KEY, "Other/Test Session/local/Alice/clip.wav"]
    assert not Path(bucket.probed[0]).exists()


def test_a_failing_other_backend_still_records_the_bucket_copy_with_a_warning(client, session, bucket, monkeypatch):
    bucket.parts = {1: 3000}
    other = _s3_backend("B2")
    other._bucket = "other-bucket"

    async def fake_upload(items):
        return 0, "B2: nope"

    monkeypatch.setattr(other, "upload", fake_upload)
    monkeypatch.setattr(localupload, "_get_backends", lambda: [_s3_backend(), other])
    r = _post(client, session, "complete", _complete_body())
    st = _wait_for(client, session, r.json()["upload_id"])
    assert st["status"] == "done"
    assert "B2: nope" in st["warning"]
    assert [f["key"] for f in session.r2_files] == [KEY]  # the R2 copy is still delivered
    assert bucket.registered == [("Alice", "audio", "clip.wav", 12.5)]


def test_a_failed_pull_down_still_records_the_bucket_copy_with_a_warning(client, session, bucket, monkeypatch):
    bucket.parts = {1: 3000}
    other = _s3_backend("B2")
    other._bucket = "other-bucket"
    monkeypatch.setattr(localupload, "_get_backends", lambda: [_s3_backend(), other])

    def broken_download(key, dest, on_progress=None):
        raise RuntimeError("download broke")

    monkeypatch.setattr(s3, "download_object_to_path", broken_download)
    r = _post(client, session, "complete", _complete_body())
    st = _wait_for(client, session, r.json()["upload_id"])
    assert st["status"] == "done" and "download broke" in st["warning"]
    assert [f["key"] for f in session.r2_files] == [KEY]


def test_no_duration_header_falls_back_to_downloading_for_a_full_probe(client, session, bucket, monkeypatch):
    bucket.parts = {1: 3000}
    full = []

    async def no_header(path):
        return 0.0

    async def full_probe(path):
        full.append(str(path))
        return 7.0

    monkeypatch.setattr(localupload, "_probe_duration_fast", no_header)
    monkeypatch.setattr(localupload, "_probe_duration_s", full_probe)
    r = _post(client, session, "complete", _complete_body())
    assert _wait_for(client, session, r.json()["upload_id"])["status"] == "done"
    assert bucket.downloads == [KEY]
    assert len(full) == 1 and not Path(full[0]).exists()  # temp file cleaned up
    assert bucket.registered == [("Alice", "audio", "clip.wav", 7.0)]


def test_a_repeated_complete_joins_the_same_job_instead_of_registering_twice(client, session, bucket):
    bucket.parts = {1: 3000}
    first = _post(client, session, "complete", _complete_body()).json()["upload_id"]
    bucket.list_raises = True  # the upload_id is spent after the first complete
    second = _post(client, session, "complete", _complete_body())
    assert second.status_code == 200 and second.json()["upload_id"] == first
    _wait_for(client, session, first)
    assert len(bucket.registered) == 1


def test_abort_aborts_the_bucket_upload(client, session, bucket):
    assert _post(client, session, "abort", {"key": KEY, "upload_id": "up-1"}).status_code == 200
    assert bucket.aborted == [KEY]
