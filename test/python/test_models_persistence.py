"""Coverage for app/models.py's session persistence (load/_save) —
previously untested. Focuses on the two failure-handling gaps fixed
alongside the direct-cloud-upload branch's follow-up hardening:

- A corrupt (unparseable) .sessions.json used to be silently dropped and
  left in place, so every restart failed the same way forever with no trace.
- One malformed record among many valid ones used to abort the whole load
  loop, silently losing every session after it in the file, not just the
  bad one.
"""
import json

import pytest

from app import models


@pytest.fixture
def isolated_sessions():
    """models._sessions is a shared module-level dict, not per-test state —
    snapshot and restore it so this file's direct models.load() calls can't
    leak session records into other test files that run in the same process."""
    saved = dict(models._sessions)
    models._sessions.clear()
    yield
    models._sessions.clear()
    models._sessions.update(saved)


def test_load_moves_corrupt_store_aside_instead_of_leaving_it_in_place(recordings_dir, isolated_sessions):
    store = models._store_path()
    store.write_text("not valid json{{{")

    models.load()

    assert models._sessions == {}
    assert not store.exists()
    corrupt_files = list(store.parent.glob(".sessions.corrupt-*.json"))
    assert len(corrupt_files) == 1
    assert corrupt_files[0].read_text() == "not valid json{{{"


def test_load_skips_one_malformed_record_but_keeps_the_rest(recordings_dir, isolated_sessions):
    store = models._store_path()
    good_1 = {
        "id": "s1", "title": "Good One", "host_token": "h1",
        "created_at": "2026-01-01T00:00:00", "dir_name": "s1-dir",
    }
    bad = {"id": "s2", "title": "Missing required fields"}  # no host_token/created_at/dir_name
    good_2 = {
        "id": "s3", "title": "Good Two", "host_token": "h3",
        "created_at": "2026-01-02T00:00:00", "dir_name": "s3-dir",
    }
    store.write_text(json.dumps([good_1, bad, good_2]))

    models.load()

    assert set(models._sessions.keys()) == {"s1", "s3"}
