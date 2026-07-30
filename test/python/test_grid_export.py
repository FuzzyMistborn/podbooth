"""Coverage for chunk H5: ffmpeg failing partway through a grid export used
to leave nothing but a log line — export-status only checked
output_path.exists(), so a truncated/partial video_grid.mp4 (or one from a
previous successful export that a new failed attempt didn't touch) was
reported "ready" and served to the host. The fix writes to a temp path and
only renames into place on a confirmed-good run, tracking failures
explicitly rather than inferring status from file presence alone."""
from pathlib import Path

import pytest

from app.routers import dashboard


class _FakeProc:
    def __init__(self, returncode, stderr=b""):
        self.returncode = returncode
        self._stderr = stderr

    async def communicate(self):
        return b"", self._stderr


@pytest.fixture(autouse=True)
def _clean_export_state():
    dashboard._export_failures.clear()
    dashboard._export_tasks.clear()
    dashboard._export_progress.clear()
    yield
    dashboard._export_failures.clear()
    dashboard._export_tasks.clear()
    dashboard._export_progress.clear()


@pytest.fixture
def video_groups(tmp_path):
    # _run_grid_export only reads these via _probe_duration, which is
    # monkeypatched below — the files don't need to be real videos.
    a = tmp_path / "Alice" / "Alice_1_video.mp4"
    a.parent.mkdir(parents=True)
    a.write_bytes(b"x")
    return [[a]]


async def _run(monkeypatch, session_id, output_path, video_groups, *, returncode, write_output=False):
    monkeypatch.setattr(dashboard, "_probe_duration", lambda p: _async_return(1.0))

    async def fake_subprocess_exec(*cmd, **kwargs):
        if write_output and returncode == 0:
            # The real ffmpeg invocation's actual output path is the tmp
            # path _run_grid_export passes into _build_export_cmd — find it
            # as the command's last argument, matching _build_export_cmd's
            # `cmd += [str(output_path)]`.
            Path(cmd[-1]).write_bytes(b"fake mp4 bytes")
        return _FakeProc(returncode)

    monkeypatch.setattr(dashboard.asyncio, "create_subprocess_exec", fake_subprocess_exec)
    await dashboard._run_grid_export(session_id, video_groups, output_path)


def _async_return(value):
    async def _coro():
        return value
    return _coro()


@pytest.mark.asyncio
async def test_failed_ffmpeg_run_is_reported_as_failed_not_ready(monkeypatch, tmp_path, video_groups):
    session_id = "sess-fail"
    output_path = tmp_path / "video_grid.mp4"

    await _run(monkeypatch, session_id, output_path, video_groups, returncode=1)

    assert not output_path.exists()
    # grid_export_status looks up the session via get_session (needs a
    # registered Session + host auth), which is more than this unit test
    # needs — assert the underlying state directly, the same state that
    # endpoint reads before falling back to output_path.exists().
    assert session_id in dashboard._export_failures


@pytest.mark.asyncio
async def test_ffmpeg_exits_zero_but_writes_no_file_is_still_a_failure(monkeypatch, tmp_path, video_groups):
    # The scenario that used to slip through: returncode 0 (e.g. the process
    # was killed in a way that didn't propagate as a nonzero exit) but no
    # usable output was actually produced.
    session_id = "sess-empty"
    output_path = tmp_path / "video_grid.mp4"

    await _run(monkeypatch, session_id, output_path, video_groups, returncode=0, write_output=False)

    assert not output_path.exists()
    assert session_id in dashboard._export_failures


@pytest.mark.asyncio
async def test_successful_export_is_not_flagged_failed_and_leaves_no_tmp_file(monkeypatch, tmp_path, video_groups):
    session_id = "sess-ok"
    output_path = tmp_path / "video_grid.mp4"

    await _run(monkeypatch, session_id, output_path, video_groups, returncode=0, write_output=True)

    assert output_path.exists()
    assert output_path.read_bytes() == b"fake mp4 bytes"
    assert session_id not in dashboard._export_failures
    tmp_output_path = output_path.with_name(output_path.stem + ".tmp" + output_path.suffix)
    assert not tmp_output_path.exists()


@pytest.mark.asyncio
async def test_a_failed_retry_does_not_leave_a_stale_successful_file_looking_ready(monkeypatch, tmp_path, video_groups):
    # A previous export succeeded, then a re-export attempt fails — the old
    # file must not linger and be reported "ready" for a run that actually
    # failed. _run_grid_export always unlinks output_path before starting
    # (in grid_export, not shown here) — this test instead exercises the
    # narrower guarantee _run_grid_export itself owns: it never leaves a
    # *new*, half-written file behind, and always records the failure.
    session_id = "sess-retry"
    output_path = tmp_path / "video_grid.mp4"
    output_path.write_bytes(b"previous good export")

    await _run(monkeypatch, session_id, output_path, video_groups, returncode=1)

    # _run_grid_export doesn't touch a pre-existing output_path on failure
    # (that unlink is the caller's job before kicking off a new attempt) —
    # what matters here is the failure is recorded so status reporting
    # doesn't just trust file presence.
    assert session_id in dashboard._export_failures
