"""Coverage for `purge_expired_r2` (app/models.py) — a destructive, unattended
background sweep that deletes a session's cloud files once r2_expires_at has
passed. No host reviews this before it fires, so a wrong comparison here
means either real data loss (purging early) or files silently never getting
cleaned up. Not tied to a known bug, but this project already hit exactly
this bug shape once this session (localupload.py's naive/aware datetime
comparison), so it's worth confirming this path holds up.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app import models


@pytest.fixture
def two_sessions(recordings_dir):
    from app.models import Session, _sessions

    expired = Session(
        id="expired-session",
        title="Expired Session",
        host_token="host-secret-1",
        created_at=datetime.now(),
        dir_name="expired-session",
    )
    expired.r2_files = [{"key": "sessions/expired-session/clip.wav", "filename": "clip.wav",
                          "size_bytes": 10, "uploaded_at": "2020-01-01T00:00:00+00:00", "uploader": ""}]
    expired.editor_token_hash = "some-hash"
    expired.r2_expires_at = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()

    not_expired = Session(
        id="active-session",
        title="Active Session",
        host_token="host-secret-2",
        created_at=datetime.now(),
        dir_name="active-session",
    )
    not_expired.r2_files = [{"key": "sessions/active-session/clip.wav", "filename": "clip.wav",
                              "size_bytes": 10, "uploaded_at": "2020-01-01T00:00:00+00:00", "uploader": ""}]
    not_expired.editor_token_hash = "another-hash"
    not_expired.r2_expires_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()

    _sessions[expired.id] = expired
    _sessions[not_expired.id] = not_expired
    yield expired, not_expired
    _sessions.pop(expired.id, None)
    _sessions.pop(not_expired.id, None)


@pytest.fixture
def no_r2_session(recordings_dir):
    """A session with no editor link at all — the common case; must be a
    silent no-op, not an error, since r2_expires_at is empty."""
    from app.models import Session, _sessions
    s = Session(
        id="never-linked-session",
        title="Never Linked",
        host_token="host-secret-3",
        created_at=datetime.now(),
        dir_name="never-linked-session",
    )
    _sessions[s.id] = s
    yield s
    _sessions.pop(s.id, None)


def _stub_delete(monkeypatch, deleted_calls):
    def _fake_delete(session_id, extra_prefixes):
        deleted_calls.append((session_id, extra_prefixes))
        return 1

    import app.s3 as s3
    monkeypatch.setattr(s3, "delete_session_objects", _fake_delete)


@pytest.mark.asyncio
async def test_purges_only_the_expired_session(two_sessions, recordings_dir, monkeypatch):
    expired, not_expired = two_sessions
    deleted_calls = []
    _stub_delete(monkeypatch, deleted_calls)

    purged = await models.purge_expired_r2()

    assert purged == [expired.id]
    assert [c[0] for c in deleted_calls] == [expired.id]

    # Editor-link state must be fully cleared on the purged session...
    assert expired.r2_files == []
    assert expired.editor_token_hash == ""
    assert expired.r2_expires_at == ""

    # ...and completely untouched on the one that hasn't expired yet.
    assert not_expired.r2_files != []
    assert not_expired.editor_token_hash == "another-hash"
    assert not_expired.r2_expires_at != ""


@pytest.mark.asyncio
async def test_session_with_no_editor_link_is_a_silent_noop(no_r2_session, recordings_dir, monkeypatch):
    deleted_calls = []
    _stub_delete(monkeypatch, deleted_calls)

    purged = await models.purge_expired_r2()

    assert purged == []
    assert deleted_calls == []


@pytest.mark.asyncio
async def test_malformed_r2_expires_at_is_skipped_not_raised(recordings_dir, monkeypatch):
    from app.models import Session, _sessions
    s = Session(
        id="malformed-session",
        title="Malformed",
        host_token="host-secret-4",
        created_at=datetime.now(),
        dir_name="malformed-session",
    )
    s.r2_expires_at = "not-a-real-timestamp"
    s.r2_files = [{"key": "x", "filename": "x", "size_bytes": 1, "uploaded_at": "", "uploader": ""}]
    _sessions[s.id] = s
    try:
        deleted_calls = []
        _stub_delete(monkeypatch, deleted_calls)

        purged = await models.purge_expired_r2()

        assert purged == []
        assert deleted_calls == []
        # Left alone rather than silently wiped, since we couldn't confirm expiry.
        assert s.r2_files != []
    finally:
        _sessions.pop(s.id, None)


@pytest.mark.asyncio
async def test_naive_r2_expires_at_in_the_past_is_still_purged(recordings_dir, monkeypatch):
    """r2_expires_at is always written as an aware isoformat string by
    s3upload.py, but purge_expired_r2 defensively handles a naive one too
    (`if expires.tzinfo is None: expires = expires.replace(tzinfo=utc)`) —
    confirm that branch actually treats a naive past timestamp as expired
    rather than raising or silently skipping it."""
    from app.models import Session, _sessions
    s = Session(
        id="naive-session",
        title="Naive",
        host_token="host-secret-5",
        created_at=datetime.now(),
        dir_name="naive-session",
    )
    s.r2_expires_at = (datetime.now() - timedelta(days=1)).isoformat()  # no tzinfo
    s.r2_files = [{"key": "x", "filename": "x", "size_bytes": 1, "uploaded_at": "", "uploader": ""}]
    _sessions[s.id] = s
    try:
        deleted_calls = []
        _stub_delete(monkeypatch, deleted_calls)

        purged = await models.purge_expired_r2()

        assert purged == [s.id]
        assert s.r2_files == []
    finally:
        _sessions.pop(s.id, None)
