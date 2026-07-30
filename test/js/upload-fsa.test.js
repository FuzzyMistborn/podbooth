// Coverage for the File System Access (FSA) whole-file upload path in
// _uploadOneTrack — previously entirely untested. When a participant opts
// into local-disk recording, a track isn't chunked through IndexedDB at
// all: it's written to one real local file and uploaded as slices of that
// single file at the end, or (if FSA writes started failing mid-recording)
// as one "chunk 0" whole-file upload that folds in everything captured
// before the failover, with the IndexedDB chunks recorded after the
// failover uploaded normally alongside it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadUploadModules, makeBlob, stubXhrUpload } from './harness.js';

loadUploadModules();

beforeEach(async () => {
  installGlobals({ fsaDirHandle: {} }); // truthy — "FSA is in play for this recording"
  for (const rec of await idbGetAllChunks()) {
    await idbDeleteChunk(rec.sessionId, rec.identity, rec.epoch, rec.trackType, rec.chunkIndex);
  }
});

describe('_uploadOneTrack (FSA whole-file path)', () => {
  it('uploads a clean local-file track as fixed-size slices with sequential indices', async () => {
    const fileSize = 12 * 1024 * 1024; // 12MB -> ceil(12/5) = 3 slices (5, 5, 2 MB)
    const fakeFile = makeBlob(fileSize);
    globalThis.fsaCloseTrackFile = async (track) => track._file;
    const fsaOpenPromises = {
      audio: Promise.resolve({ ext: 'wav', bytesWritten: fileSize, isRawAudio: false, _file: fakeFile }),
    };

    const uploaded = [];
    stubXhrUpload((form) => {
      uploaded.push({
        index: Number(form.get('chunk_index')),
        ext: form.get('ext'),
        epoch: form.get('epoch'),
        size: form.get('file').size,
      });
      return { ok: true, status: 200 };
    });

    const abortController = new AbortController();
    await _uploadOneTrack('audio', fsaOpenPromises, {}, [], abortController, 'epoch1');

    expect(uploaded).toHaveLength(3);
    expect(uploaded.map(u => u.index)).toEqual([0, 1, 2]);
    expect(uploaded.every(u => u.ext === 'wav' && u.epoch === 'epoch1')).toBe(true);
    expect(uploaded.map(u => u.size)).toEqual([5 * 1024 * 1024, 5 * 1024 * 1024, 2 * 1024 * 1024]);
  });

  it('strips the local WAV header before uploading a raw-PCM local file', async () => {
    const payload = new Uint8Array(1000).fill(7);
    const withWavHeader = new Blob([new Uint8Array(44), payload]); // fake 44-byte header + payload
    globalThis.fsaCloseTrackFile = async (track) => track._file;
    const fsaOpenPromises = {
      audio: Promise.resolve({ ext: 'raw', bytesWritten: withWavHeader.size, isRawAudio: true, _file: withWavHeader }),
    };

    let uploadedBlob = null;
    stubXhrUpload((form) => {
      uploadedBlob = form.get('file');
      return { ok: true, status: 200 };
    });

    await _uploadOneTrack('audio', fsaOpenPromises, {}, [], new AbortController(), 'epoch1');

    expect(uploadedBlob.size).toBe(payload.length); // header (44 bytes) stripped
    const bytes = new Uint8Array(await uploadedBlob.arrayBuffer());
    expect(bytes.every(b => b === 7)).toBe(true); // only payload bytes remain, header content is gone
  });

  it('uploads a failed-over track as chunk 0 with subsumes_chunks, plus its trailing IndexedDB chunks at their real indices', async () => {
    // Track failed over from FSA to IndexedDB after 4 chunks had already
    // been written to the local file — chunks 4 and 5 were then captured
    // straight to IndexedDB (see _persistChunk's fallback).
    const salvaged = makeBlob(2048);
    globalThis.fsaCloseTrackFile = async (track) => track._file;
    const fsaFailedTracks = {
      video: { ext: 'webm', bytesWritten: salvaged.size, isRawAudio: false, chunksWritten: 4, _file: salvaged },
    };
    for (const idx of [4, 5]) {
      await idbPutChunk({
        sessionId: SESSION_ID, identity, participant: displayName, epoch: 'epoch1',
        trackType: 'video', chunkIndex: idx, ext: 'webm', meta: {}, blob: makeBlob(500),
      });
    }
    const groupChunks = (await idbGetAllChunks()).filter(c => c.trackType === 'video');

    const uploaded = [];
    let wholeFileMeta = null;
    stubXhrUpload((form) => {
      const index = Number(form.get('chunk_index'));
      uploaded.push(index);
      if (index === 0) wholeFileMeta = JSON.parse(form.get('chunk_meta'));
      return { ok: true, status: 200 };
    });

    await _uploadOneTrack('video', {}, fsaFailedTracks, groupChunks, new AbortController(), 'epoch1');

    // Chunk 0 (the salvaged whole file) plus the two real trailing IndexedDB
    // chunks at their original indices — not renumbered to 0/1/2, which
    // would collide with the real chunk 4/5 files server-side.
    expect(uploaded.sort((a, b) => a - b)).toEqual([0, 4, 5]);
    expect(wholeFileMeta).toEqual({ subsumes_chunks: 4 });

    // The IndexedDB copies of the successfully-uploaded trailing chunks are
    // cleaned up same as the normal (non-FSA) path.
    expect(await idbGetAllChunks()).toHaveLength(0);
  });
});
