"""Server-side coverage for the chunk-upload/recovery endpoints (H4, M5#12).

These drive the real FastAPI endpoints in app/routers/upload.py directly
(no browser, no real time) so a long-recording scenario — hundreds of
chunks, gaps from concurrent-upload retries, storage caps — can be
reproduced in milliseconds instead of by recording for 45 minutes.
"""
from app.config import settings


def _post_chunk(client, *, chunk_index, content=b"x", track_type="audio", ext="raw", epoch="epoch1"):
    return client.post(
        "/api/upload/chunk",
        data={
            "session_id": "test-session",
            "participant": "Alice",
            "identity": "alice-id",
            "track_type": track_type,
            "chunk_index": chunk_index,
            "ext": ext,
            "epoch": epoch,
        },
        files={"file": (f"chunk_{chunk_index}.{ext}", content)},
    )


def test_chunk_progress_reports_a_gap_not_just_next_index(client, session, recordings_dir):
    # Simulate a long session where chunks 0,2,3,4 landed but 1 permanently
    # failed mid-batch during 4-wide-concurrent upload — the exact scenario
    # H4 fixes: next_chunk = max_index + 1 alone can't distinguish this from
    # "everything below 5 landed".
    for i in (0, 2, 3, 4):
        r = _post_chunk(client, chunk_index=i)
        assert r.status_code == 200, r.text

    r = client.get("/api/upload/chunks", params={
        "session_id": "test-session", "identity": "alice-id", "participant": "Alice",
        "track_type": "audio", "epoch": "epoch1",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["next_chunk"] == 5
    assert body["present_indices"] == [0, 2, 3, 4]  # the gap at 1 is visible


def test_chunk_progress_for_unknown_session_participant_is_empty(client, session, recordings_dir):
    r = client.get("/api/upload/chunks", params={
        "session_id": "test-session", "identity": "nobody", "participant": "",
        "track_type": "audio", "epoch": "epoch1",
    })
    assert r.status_code == 200
    assert r.json()["next_chunk"] == 0


def test_aggregate_upload_cap_rejects_once_participant_exceeds_it(client, session, recordings_dir, monkeypatch):
    # A tiny cap makes this fast to trigger without writing real gigabytes —
    # the mechanism (sum of on-disk file sizes for the participant dir) is
    # the same regardless of the configured threshold.
    monkeypatch.setattr(settings, "max_participant_upload_gb", 20 / (1024 ** 3))  # 20 bytes

    r1 = _post_chunk(client, chunk_index=0, content=b"x" * 25)
    assert r1.status_code == 200, r1.text

    r2 = _post_chunk(client, chunk_index=1, content=b"y" * 10)
    assert r2.status_code == 413


def test_aggregate_cap_disabled_when_zero(client, session, recordings_dir, monkeypatch):
    monkeypatch.setattr(settings, "max_participant_upload_gb", 0)
    r1 = _post_chunk(client, chunk_index=0, content=b"x" * 10_000)
    r2 = _post_chunk(client, chunk_index=1, content=b"y" * 10_000)
    assert r1.status_code == 200
    assert r2.status_code == 200


def test_two_guests_with_same_display_name_get_separate_directories(client, session, recordings_dir):
    # L1 fix: participant_dir used to key purely by display-name slug, so two
    # different guests both named "Bob" would interleave takes in one folder.
    session.participants["Bob"] = "2024-01-01T00:00:00+00:00"
    r1 = client.post(
        "/api/upload/chunk",
        data={
            "session_id": "test-session", "participant": "Bob", "identity": "bob-A",
            "track_type": "audio", "chunk_index": 0, "ext": "raw", "epoch": "e1",
        },
        files={"file": ("c.raw", b"a")},
    )
    r2 = client.post(
        "/api/upload/chunk",
        data={
            "session_id": "test-session", "participant": "Bob", "identity": "bob-B",
            "track_type": "audio", "chunk_index": 0, "ext": "raw", "epoch": "e2",
        },
        files={"file": ("c.raw", b"b")},
    )
    assert r1.status_code == 200 and r2.status_code == 200

    bob_dirs = [p for p in recordings_dir.glob("test-session/Bob*") if p.is_dir()]
    assert len(bob_dirs) == 2, f"expected two separate Bob directories, found {bob_dirs}"
