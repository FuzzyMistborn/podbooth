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
      'audio::epoch1': Promise.resolve({ ext: 'wav', bytesWritten: fileSize, isRawAudio: false, _file: fakeFile }),
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
    await _uploadOneTrack('audio', fsaOpenPromises, {}, [], abortController, 'epoch1', { forceUpload: true });

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
      'audio::epoch1': Promise.resolve({ ext: 'raw', bytesWritten: withWavHeader.size, isRawAudio: true, _file: withWavHeader }),
    };

    let uploadedBlob = null;
    stubXhrUpload((form) => {
      uploadedBlob = form.get('file');
      return { ok: true, status: 200 };
    });

    await _uploadOneTrack('audio', fsaOpenPromises, {}, [], new AbortController(), 'epoch1', { forceUpload: true });

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
      'video::epoch1': { ext: 'webm', bytesWritten: salvaged.size, isRawAudio: false, chunksWritten: 4, _file: salvaged },
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

describe('local-disk recordings: kept on disk at stop, uploaded on demand', () => {
  // A participant who opted into local-disk recording keeps their files on
  // disk when recording stops — nothing is sent automatically. The 'Upload
  // recording' button (uploadLocalRecordings) later sends them through the
  // normal chunk/finalize pipeline, with the finalize payload captured at
  // stop so the server still knows where the take sits on the timeline.
  function localTrack(file, extra = {}) {
    return { ext: 'webm', bytesWritten: file.size, isRawAudio: false, chunksWritten: 3, closed: false, _file: file, ...extra };
  }

  // Records every chunk upload and /finalize body; assembly/verify polling is
  // stubbed out (it sleeps 2s per poll) and recorded as a single call.
  function stubServer({ failFirstChunkByCancelling = false } = {}) {
    const calls = { chunks: [], finalizes: [], assemblyWaits: 0 };
    let cancelled = false;
    stubXhrUpload((form) => {
      if (failFirstChunkByCancelling && !cancelled) {
        cancelled = true;
        cancelUpload();
        return { ok: false, status: 0 };
      }
      calls.chunks.push({ trackType: form.get('track_type'), index: Number(form.get('chunk_index')), epoch: form.get('epoch') });
      return { ok: true, status: 200 };
    });
    globalThis.fetch = vi.fn(async (url, init) => {
      if (url === '/api/upload/finalize') calls.finalizes.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ assembling: false, issues: [] }) };
    });
    globalThis._awaitAssemblyAndVerify = async () => { calls.assemblyWaits++; return true; };
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    return calls;
  }

  function recordBannerStates() {
    const states = [];
    const realShow = globalThis.showUploadBanner;
    globalThis.showUploadBanner = (state) => { states.push(state); realShow(state); };
    return { states, restore: () => { globalThis.showUploadBanner = realShow; } };
  }

  // Each test uses its own epoch names: _uploadAllRecordedChunks caches its
  // pass per epoch (module-private _uploadPass), so reusing one across tests
  // would hand back an earlier test's already-finished pass.
  async function stopTake(epoch, tracks) {
    globalThis.recordingEpoch = epoch;
    globalThis.fsaOpenPromises = {};
    globalThis.pendingFinalizeMeta = {};
    for (const [trackType, track, meta] of tracks) {
      fsaOpenPromises[`${trackType}::${epoch}`] = Promise.resolve(track);
      pendingFinalizeMeta[`${trackType}::${epoch}`] = meta;
    }
    await waitForUploads();
  }

  beforeEach(() => {
    const closed = [];
    globalThis.fsaCloseTrackFile = async (track) => { closed.push(track); track.closed = true; return track._file; };
  });

  it('a stop pass closes local tracks, uploads/finalizes nothing, never shows "Uploading", and queues them', async () => {
    const calls = stubServer();
    const banner = recordBannerStates();
    const audio = localTrack(makeBlob(1024), { ext: 'raw', isRawAudio: true });
    const video = localTrack(makeBlob(1024));
    try {
      await stopTake('epoch1', [
        ['audio', audio, { start_time_ms: 1000 }],
        ['video', video, { start_time_ms: 1010 }],
      ]);
    } finally {
      banner.restore();
    }

    expect(audio.closed && video.closed).toBe(true); // finished on disk (WAV header etc.)
    expect(calls.chunks).toEqual([]);
    expect(calls.finalizes).toEqual([]);
    expect(calls.assemblyWaits).toBe(0);
    expect(banner.states).toEqual(['local']);
    expect(uploadPending).toBe(false);
    expect(hasPendingLocalUploads()).toBe(true);
    expect(_pendingLocalUploads.map(e => [e.trackType, e.epoch, e.meta]).sort()).toEqual([
      ['audio', 'epoch1', { start_time_ms: 1000 }],
      ['video', 'epoch1', { start_time_ms: 1010 }],
    ]);
  });

  it('uploadLocalRecordings sends every queued track as slices, finalizes with the original start time, and empties the queue', async () => {
    const calls = stubServer();
    await stopTake('slices1', [['video', localTrack(makeBlob(12 * 1024 * 1024)), { start_time_ms: 1010 }]]);
    let drained = 0;
    globalThis.onLocalUploadsDrained = () => { drained++; };

    const banner = recordBannerStates();
    try {
      await uploadLocalRecordings();
    } finally {
      banner.restore();
    }

    expect(calls.chunks.map(c => c.index).sort((a, b) => a - b)).toEqual([0, 1, 2]); // 12MB -> 3 x 5MB slices
    expect(calls.chunks.every(c => c.trackType === 'video' && c.epoch === 'slices1')).toBe(true);
    expect(calls.finalizes).toHaveLength(1);
    expect(calls.finalizes[0]).toMatchObject({ track_type: 'video', epoch: 'slices1', start_time_ms: 1010 });
    expect(calls.assemblyWaits).toBe(1);
    expect(banner.states).toEqual(['uploading', 'done']);
    expect(hasPendingLocalUploads()).toBe(false);
    expect(drained).toBe(1);
  });

  it('queues takes across a retake and uploads both under their own epochs in one click', async () => {
    const calls = stubServer();
    await stopTake('take1', [['audio', localTrack(makeBlob(1024), { ext: 'raw', isRawAudio: true }), { start_time_ms: 1 }]]);
    // The retake's startLocalRecording resets fsaOpenPromises/pendingFinalizeMeta
    // (stopTake does the same) — the first take's queued entry must survive it.
    await stopTake('take2', [['audio', localTrack(makeBlob(1024), { ext: 'raw', isRawAudio: true }), { start_time_ms: 2 }]]);

    await uploadLocalRecordings();

    expect(calls.chunks.map(c => c.epoch).sort()).toEqual(['take1', 'take2']);
    expect(calls.finalizes.map(f => [f.epoch, f.start_time_ms]).sort()).toEqual([['take1', 1], ['take2', 2]]);
    expect(hasPendingLocalUploads()).toBe(false);
  });

  it('a cancelled upload leaves the track queued, and the next click uploads it', async () => {
    const calls = stubServer({ failFirstChunkByCancelling: true });
    await stopTake('cancel1', [['video', localTrack(makeBlob(1024)), { start_time_ms: 5 }]]);

    await uploadLocalRecordings();
    expect(calls.finalizes).toEqual([]);
    expect(hasPendingLocalUploads()).toBe(true);

    await uploadLocalRecordings();
    expect(calls.chunks).toHaveLength(1);
    expect(calls.finalizes).toHaveLength(1);
    expect(hasPendingLocalUploads()).toBe(false);
  });

  it('refuses to upload while recording (would compete with the live call)', async () => {
    const calls = stubServer();
    await stopTake('rec1', [['video', localTrack(makeBlob(1024)), {}]]);
    globalThis.isRecording = true;

    await uploadLocalRecordings();

    expect(calls.chunks).toEqual([]);
    expect(hasPendingLocalUploads()).toBe(true);
  });

  it('still uploads a failed-over track at stop — its local file is missing everything after the failure', async () => {
    stubServer();
    const fsaFailedTracks = { 'video::epoch1': localTrack(makeBlob(2048), { chunksWritten: 2 }) };
    await idbPutChunk({
      sessionId: SESSION_ID, identity, participant: displayName, epoch: 'epoch1',
      trackType: 'video', chunkIndex: 2, ext: 'webm', meta: {}, blob: makeBlob(500),
    });
    const groupChunks = await idbGetAllChunks();

    const uploaded = [];
    stubXhrUpload((form) => { uploaded.push(Number(form.get('chunk_index'))); return { ok: true, status: 200 }; });

    await _uploadOneTrack('video', {}, fsaFailedTracks, groupChunks, new AbortController(), 'epoch1');

    expect(uploaded.sort((a, b) => a - b)).toEqual([0, 2]);
    expect(hasPendingLocalUploads()).toBe(false);
  });
});

describe('_fsaTrackFor (H5: screen-share restart gets its own local file)', () => {
  // Regression coverage: a screen-share restart gets its own epoch
  // (screenEpoch in recording.js), but _fsaTrackFor used to key
  // fsaOpenPromises by trackType alone, so a restart's group and the first
  // segment's group both resolved to the very same open file. Because
  // _doUploadAllRecordedChunks processes every group concurrently, both
  // would race to close/upload that one file — either throwing ("Cannot
  // close a closed or closing stream") or finalizing the shared file against
  // only the second segment's (much shorter) duration, so the second screen
  // share effectively never made it into a usable recording.
  it('opens a distinct file (and fsaOpenPromises entry) per epoch for the same track type', async () => {
    const opened = [];
    globalThis.fsaNextTakeNumber = async () => 1;
    globalThis.fsaOpenTrackFile = async (dirHandle, trackType, ext, sessionTitle, participant, take, segment) => {
      const track = {
        fileHandle: { name: `${trackType}${segment > 0 ? ` ${segment + 1}` : ''}.${ext}` },
        writable: {}, bytesWritten: 0, flushedBytes: 0, chunksWritten: 0, closed: false,
        isRawAudio: false, dataBytes: 0,
      };
      opened.push(track.fileHandle.name);
      return track;
    };

    const first = await _fsaTrackFor('screen', 'webm', 'epochA');
    const second = await _fsaTrackFor('screen', 'webm', 'epochA-s1');

    expect(first).not.toBe(second);
    expect(opened).toEqual(['screen.webm', 'screen 2.webm']);
    expect(Object.keys(fsaOpenPromises).sort()).toEqual(['screen::epochA', 'screen::epochA-s1']);
  });

  it('a second call for the same (trackType, epoch) reuses the same open file', async () => {
    globalThis.fsaNextTakeNumber = async () => 1;
    globalThis.fsaOpenTrackFile = async () => ({
      fileHandle: {}, writable: {}, bytesWritten: 0, flushedBytes: 0, chunksWritten: 0,
      closed: false, isRawAudio: false, dataBytes: 0,
    });

    const first = await _fsaTrackFor('audio', 'wav', 'epochA');
    const second = await _fsaTrackFor('audio', 'wav', 'epochA');

    expect(first).toBe(second);
    expect(Object.keys(fsaOpenPromises)).toEqual(['audio::epochA']);
  });
});
