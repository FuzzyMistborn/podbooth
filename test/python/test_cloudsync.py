"""Coverage for chunk H6: one cloud backend being unreachable used to raise
straight out of run_upload's asyncio.gather (no return_exceptions=True) and
past NextcloudBackend._ensure_dir's unguarded MKCOL call, which skipped the
status_store update entirely and left the "already uploading" guard wedged
until a process restart. Both are drive-the-real-function tests, not mocks
of the fix itself."""
import httpx
import pytest

from app.routers.cloudsync import NextcloudBackend, UploadItem, run_upload


class _FakeBackend:
    def __init__(self, name, result=None, raises=None):
        self.name = name
        self._result = result
        self._raises = raises

    def is_enabled(self):
        return True

    async def upload(self, items):
        if self._raises:
            raise self._raises
        return self._result


@pytest.mark.asyncio
async def test_one_backend_raising_does_not_wedge_the_others_status_update():
    items = [UploadItem(local_path="/tmp/a.mp4", remote_path="a.mp4")]
    good = _FakeBackend("Good", result=(1, ""))
    bad = _FakeBackend("Bad", raises=httpx.ConnectError("unreachable"))
    status_store = {}

    # Pre-fix, an unhandled exception from `bad` would propagate out of this
    # await entirely — status_store would never be touched, leaving the
    # job's status stuck at whatever the caller set before calling this
    # (normally "uploading" forever).
    await run_upload("job-1", status_store, items, [good, bad])

    assert "job-1" in status_store
    assert status_store["job-1"]["status"] == "error"
    assert "Bad" in status_store["job-1"]["message"]
    # The good backend's work still counted, even though its sibling failed.
    assert status_store["job-1"]["uploaded"] == 1


@pytest.mark.asyncio
async def test_all_backends_succeeding_reports_done_with_correct_totals():
    items = [UploadItem(local_path="/tmp/a.mp4", remote_path="a.mp4"),
             UploadItem(local_path="/tmp/b.mp4", remote_path="b.mp4")]
    b1 = _FakeBackend("One", result=(2, ""))
    b2 = _FakeBackend("Two", result=(2, ""))
    status_store = {}

    await run_upload("job-2", status_store, items, [b1, b2])

    assert status_store["job-2"]["status"] == "done"
    # "Uploaded N file(s)" reports the distinct file count, not summed across
    # backends (2 files x 2 backends must not read as "Uploaded 4 file(s)").
    assert status_store["job-2"]["message"] == "Uploaded 2 file(s)"
    assert status_store["job-2"]["total"] == 4  # 2 files x 2 backends


@pytest.mark.asyncio
async def test_ensure_dir_swallows_a_connection_error_instead_of_raising():
    backend = NextcloudBackend()

    class _RaisingClient:
        async def request(self, method, url):
            raise httpx.ConnectError("DNS failure")

    # Must not raise — pre-fix, this propagated straight out of upload()
    # and past run_upload's gather.
    await backend._ensure_dir(_RaisingClient(), "https://nextcloud.example/dav/x")
