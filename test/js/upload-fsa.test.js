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
      'audio::epoch1': Promise.resolve({ ext: 'raw', bytesWritten: withWavHeader.size, isRawAudio: true, _file: withWavHeader }),
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

describe('local-disk recordings: uploaded automatically at stop', () => {
  // A participant who opted into local-disk recording keeps the file in
  // their folder as a backup, but stopping still sends it through the normal
  // chunk/finalize pipeline straight away — no button to click. (For a while
  // these stayed on disk until an 'Upload recording' button was pressed;
  // that was reverted once direct-to-cloud upload made the automatic path
  // reliable.)
  function localTrack(file, extra = {}) {
    return { ext: 'webm', bytesWritten: file.size, isRawAudio: false, chunksWritten: 3, closed: false, _file: file, ...extra };
  }

  // Records every chunk upload and /finalize body; assembly/verify polling is
  // stubbed out (it sleeps 2s per poll) and recorded as a single call.
  function stubServer() {
    const calls = { chunks: [], finalizes: [], assemblyWaits: 0 };
    stubXhrUpload((form) => {
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
    globalThis.fsaCloseTrackFile = async (track) => { track.closed = true; return track._file; };
  });

  it('a stop pass closes the local files and uploads them as slices, finalizing with the start time', async () => {
    const calls = stubServer();
    const banner = recordBannerStates();
    const audio = localTrack(makeBlob(1024), { ext: 'raw', isRawAudio: true });
    const video = localTrack(makeBlob(12 * 1024 * 1024));
    try {
      await stopTake('auto1', [
        ['audio', audio, { start_time_ms: 1000 }],
        ['video', video, { start_time_ms: 1010 }],
      ]);
    } finally {
      banner.restore();
    }

    expect(audio.closed && video.closed).toBe(true); // finished on disk (WAV header etc.) — the backup copy
    const videoIdx = calls.chunks.filter(c => c.trackType === 'video').map(c => c.index).sort((a, b) => a - b);
    expect(videoIdx).toEqual([0, 1, 2]); // 12MB -> 3 x 5MB slices
    expect(calls.chunks.filter(c => c.trackType === 'audio')).toHaveLength(1);
    expect(calls.finalizes.map(f => [f.track_type, f.epoch, f.start_time_ms]).sort()).toEqual([
      ['audio', 'auto1', 1000],
      ['video', 'auto1', 1010],
    ]);
    expect(calls.assemblyWaits).toBe(1);
    expect(banner.states).toEqual(['uploading', 'done']);
  });

  it('each take uploads at its own stop, under its own epoch', async () => {
    const calls = stubServer();
    await stopTake('retake1', [['audio', localTrack(makeBlob(1024), { ext: 'raw', isRawAudio: true }), { start_time_ms: 1 }]]);
    expect(calls.finalizes.map(f => f.epoch)).toEqual(['retake1']);

    await stopTake('retake2', [['audio', localTrack(makeBlob(1024), { ext: 'raw', isRawAudio: true }), { start_time_ms: 2 }]]);
    expect(calls.finalizes.map(f => [f.epoch, f.start_time_ms])).toEqual([['retake1', 1], ['retake2', 2]]);
  });

  it('uploads a failed-over track at stop — its local file is missing everything after the failure', async () => {
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
