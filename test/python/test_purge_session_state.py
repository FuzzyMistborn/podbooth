"""Coverage for upload.purge_session_state (app/routers/upload.py) —
previously untested. _merge_locks/_epoch_take_map/_dir_take_counter are
keyed by participant directory and were never pruned, so a long-running
server accumulated one entry per (directory, epoch) ever assembled, for the
lifetime of the process. delete_session (models.py) now calls this once a
session's recordings directory is gone for good, bounding growth to
currently-live sessions."""
import asyncio
from pathlib import Path

from app.routers import upload


def test_purge_session_state_drops_only_entries_under_that_session(tmp_path):
    session_a = tmp_path / "2026-01-01-Show-abc123"
    session_b = tmp_path / "2026-01-02-Other-def456"
    alice_a = session_a / "Alice"
    bob_a = session_a / "Bob"
    alice_b = session_b / "Alice"

    upload._merge_locks[f"{alice_a}|ep1"] = asyncio.Lock()
    upload._merge_locks[f"{bob_a}|ep2"] = asyncio.Lock()
    upload._merge_locks[f"{alice_b}|ep1"] = asyncio.Lock()

    upload._epoch_take_map[(str(alice_a), "ep1")] = ("Alice", 1)
    upload._epoch_take_map[(str(alice_b), "ep1")] = ("Alice", 1)

    upload._dir_take_counter[(str(bob_a), "Bob")] = 3
    upload._dir_take_counter[(str(alice_b), "Alice")] = 1

    try:
        upload.purge_session_state(session_a)

        # Everything under session_a is gone...
        assert f"{alice_a}|ep1" not in upload._merge_locks
        assert f"{bob_a}|ep2" not in upload._merge_locks
        assert (str(alice_a), "ep1") not in upload._epoch_take_map
        assert (str(bob_a), "Bob") not in upload._dir_take_counter

        # ...but session_b's entries survive untouched.
        assert f"{alice_b}|ep1" in upload._merge_locks
        assert (str(alice_b), "ep1") in upload._epoch_take_map
        assert (str(alice_b), "Alice") in upload._dir_take_counter
    finally:
        for d in (upload._merge_locks, upload._epoch_take_map, upload._dir_take_counter):
            d.clear()
