"""Volume/stress coverage for the server side of a long recording session:
hundreds of real chunk-upload requests against the actual endpoint (not a
mock), checking nothing pathological happens as the participant's directory
grows — both the aggregate-cap check and get_chunk_progress scan every file
in that directory on every request, so their cost grows with chunk count."""
import time


def _post_chunk(client, *, chunk_index, content=b"x" * 64, track_type="audio", ext="raw", epoch="epoch1"):
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


def test_a_few_hundred_sequential_chunks_all_land_and_progress_is_correct(client, session, recordings_dir):
    # ~300 chunks at a 5s MediaRecorder timeslice is a ~25 minute take —
    # solidly into "long session" territory, run for real against the
    # actual endpoint rather than simulated.
    n = 300
    start = time.monotonic()
    for i in range(n):
        r = _post_chunk(client, chunk_index=i)
        assert r.status_code == 200, f"chunk {i} failed: {r.text}"
    elapsed = time.monotonic() - start

    r = client.get("/api/upload/chunks", params={
        "session_id": "test-session", "identity": "alice-id", "participant": "Alice",
        "track_type": "audio", "epoch": "epoch1",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["next_chunk"] == n
    assert body["present_indices"] == list(range(n))

    # Not a strict benchmark (CI hardware varies), but the per-chunk cost is
    # O(files already on disk) — both the aggregate-cap check and
    # get_chunk_progress list the whole directory every time — so a
    # regression that makes this quadratic-and-slow should still show up as
    # an obviously blown-up wall time long before 300 chunks, not a
    # borderline miss of some precise threshold.
    assert elapsed < 30, f"300 sequential chunk uploads took {elapsed:.1f}s — investigate for a perf regression"


def test_many_small_chunks_across_three_tracks_interleaved(client, session, recordings_dir):
    # A real recording writes audio/video/screen concurrently, not one track
    # at a time — interleave the three to make sure per-track filtering
    # (track_type match in both upload and progress) holds up, not just
    # sequential same-track uploads.
    n_per_track = 80
    for i in range(n_per_track):
        for track_type, ext in (("audio", "raw"), ("video", "webm"), ("screen", "webm")):
            r = _post_chunk(client, chunk_index=i, track_type=track_type, ext=ext, epoch="epoch1")
            assert r.status_code == 200, f"{track_type}#{i} failed: {r.text}"

    for track_type in ("audio", "video", "screen"):
        r = client.get("/api/upload/chunks", params={
            "session_id": "test-session", "identity": "alice-id", "participant": "Alice",
            "track_type": track_type, "epoch": "epoch1",
        })
        body = r.json()
        assert body["present_indices"] == list(range(n_per_track)), f"{track_type} progress mismatch"
