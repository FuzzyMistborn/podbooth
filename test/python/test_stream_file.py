"""Coverage for `_stream_file` (CLAUDE.md candidate test #5): the Nextcloud/
FileBrowser backends stream a local recording in fixed-size chunks instead of
reading it whole into memory (cloudsync.py's _UPLOAD_STREAM_CHUNK_BYTES =
8 MiB), so a multi-GB recording doesn't blow up process memory during a
cloud sync. No test previously confirmed the streamed bytes actually
reconstruct the source file, including across a chunk boundary.
"""
import hashlib

import pytest

from app.routers.cloudsync import _UPLOAD_STREAM_CHUNK_BYTES, _stream_file


@pytest.mark.asyncio
async def test_stream_file_reproduces_small_file_exactly(tmp_path):
    src = tmp_path / "small.bin"
    content = b"hello world" * 100
    src.write_bytes(content)

    chunks = [chunk async for chunk in _stream_file(src)]
    assert b"".join(chunks) == content


@pytest.mark.asyncio
async def test_stream_file_reproduces_content_spanning_multiple_chunk_boundaries(tmp_path):
    src = tmp_path / "big.bin"
    # Deliberately not a clean multiple of the chunk size, and large enough to
    # force several reads — a boundary bug (off-by-one on the final partial
    # read, or an accidental truncation) wouldn't show up on a single-chunk
    # file.
    size = _UPLOAD_STREAM_CHUNK_BYTES * 2 + 12345
    content = bytes((i % 251) for i in range(size))
    src.write_bytes(content)

    reassembled = bytearray()
    chunk_count = 0
    async for chunk in _stream_file(src):
        chunk_count += 1
        reassembled.extend(chunk)

    assert chunk_count >= 3  # confirms multiple reads actually happened
    assert bytes(reassembled) == content
    assert hashlib.sha256(reassembled).digest() == hashlib.sha256(content).digest()


@pytest.mark.asyncio
async def test_stream_file_yields_chunks_no_larger_than_the_configured_size(tmp_path):
    src = tmp_path / "big.bin"
    src.write_bytes(b"x" * (_UPLOAD_STREAM_CHUNK_BYTES * 2 + 1))

    async for chunk in _stream_file(src):
        assert len(chunk) <= _UPLOAD_STREAM_CHUNK_BYTES


@pytest.mark.asyncio
async def test_stream_file_empty_file_yields_nothing(tmp_path):
    src = tmp_path / "empty.bin"
    src.write_bytes(b"")

    chunks = [chunk async for chunk in _stream_file(src)]
    assert chunks == []
