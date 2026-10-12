"""_dir_size_bytes (the per-participant upload cap check in upload_chunk) must
tolerate a file vanishing between iterdir() and stat().

Found by scripts/soak-upload.mjs: with UPLOAD_CONCURRENCY chunk uploads in
flight for one participant, another request's .part temp file was renamed
into place mid-scan, the FileNotFoundError escaped, and an unrelated chunk
upload got a 500 (recovered only by the client's retry/backoff). Assembly
deleting transcoded chunks can race the same way.
"""
from pathlib import Path

from app.routers import upload


def test_vanished_file_is_skipped_not_raised(tmp_path, monkeypatch):
    (tmp_path / "audio_abc_chunk_000000.raw").write_bytes(b"x" * 100)
    (tmp_path / "video_abc_chunk_000000.webm").write_bytes(b"y" * 50)
    # Still there when the scan first looks at it (is_file() is True), gone by
    # the time it's stat()ed — what a concurrent .part → final rename looks
    # like to this scan. A path that's simply missing up front doesn't
    # reproduce it: is_file() swallows FileNotFoundError and returns False.
    class VanishingPath(type(tmp_path)):
        def is_file(self, **kwargs):
            return True

    ghost = VanishingPath(tmp_path / ".video_abc_chunk_000001.webm.deadbeef.part")

    real_iterdir = Path.iterdir

    def iterdir_with_ghost(self):
        yield from real_iterdir(self)
        if self == tmp_path:
            yield ghost

    monkeypatch.setattr(Path, "iterdir", iterdir_with_ghost)

    assert upload._dir_size_bytes(tmp_path) == 150


def test_subdirectories_are_not_counted(tmp_path):
    (tmp_path / "a.raw").write_bytes(b"x" * 10)
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.raw").write_bytes(b"y" * 1000)

    assert upload._dir_size_bytes(tmp_path) == 10
