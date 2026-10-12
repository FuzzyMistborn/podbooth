// Direct-to-cloud upload after stop (_uploadTrackDirectToCloud and its hooks
// in _uploadOneTrack): each track goes straight to the bucket in parts via
// presigned URLs instead of through the PodBooth server, whose own peering
// was the bottleneck for guests — and anything that keeps a track from going
// that way falls back to the normal server upload with nothing lost.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadUploadModules, stubXhrUpload } from './harness.js';

loadUploadModules();

let calls;
let partBodies;
let epochN = 0;

// Server + bucket stand-ins. part_size is tiny so a few KB of chunks make
// several parts. `behaviour` tweaks individual endpoints per test.
function stubCloud(behaviour = {}) {
  calls = { start: 0, partUrl: 0, complete: [], abort: 0, finalize: [], serverChunks: [] };
  partBodies = new Map();
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (url === '/api/upload/cloud/start') {
      calls.start++;
      return behaviour.start ? behaviour.start(body) : json(200, { key: 'raw/k', upload_id: 'up1', part_size: 1000 });
    }
    if (url === '/api/upload/cloud/part-url') {
      calls.partUrl++;
      return json(200, { url: `https://bucket.example/part/${body.part_number}` });
    }
    if (url === '/api/upload/cloud/complete') {
      calls.complete.push(body);
      return behaviour.complete ? behaviour.complete(body) : json(200, { ok: true });
    }
    if (url === '/api/upload/cloud/abort') { calls.abort++; return json(200, { ok: true }); }
    if (url === '/api/upload/finalize') { calls.finalize.push(body); return json(200, { ok: true }); }
    return json(200, {});
  });
  globalThis._xhrPutPart = behaviour.putPart || (async (url, blob) => {
    partBodies.set(Number(url.split('/').pop()), new Uint8Array(await blob.arrayBuffer()));
    return { ok: true, status: 200 };
  });
  stubXhrUpload((form) => {
    calls.serverChunks.push(Number(form.get('chunk_index')));
    return { ok: true, status: 200 };
  });
}

// Chunks whose bytes are all `fill`, so part contents show their order.
async function putChunks(epoch, trackType, ext, sizes) {
  for (const [i, size] of sizes.entries()) {
    await idbPutChunk({
      sessionId: SESSION_ID, identity, participant: displayName, epoch, trackType, chunkIndex: i, ext,
      meta: {}, blob: new Blob([new Uint8Array(size).fill(i + 1)]),
    });
  }
}

function nextEpoch() { return `cloud${++epochN}`; }

beforeEach(async () => {
  installGlobals({ DIRECT_CLOUD_UPLOAD: true });
  for (const rec of await idbGetAllChunks()) {
    await idbDeleteChunk(rec.sessionId, rec.identity, rec.epoch, rec.trackType, rec.chunkIndex);
  }
});

describe('direct-to-cloud upload', () => {
  it('sends a browser-storage track to the bucket as its chunks concatenated in order, then completes with the finalize payload', async () => {
    stubCloud();
    const epoch = nextEpoch();
    await putChunks(epoch, 'audio', 'raw', [1000, 2500, 400]);
    pendingFinalizeMeta[`audio::${epoch}`] = { format: 'pcm', sample_rate: 48000, channels: 2, start_time_ms: 1234, expected_duration_s: 15 };

    await _uploadAllRecordedChunks(epoch);

    // 3900 bytes in 1000-byte parts: chunk 1 (1000×0x01), then chunk 2's
    // 2500×0x02 across parts 2-3 and into 4, then chunk 3's 400×0x03.
    expect([...partBodies.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(partBodies.get(1).every(b => b === 1)).toBe(true);
    expect(partBodies.get(4).length).toBe(900);
    expect(partBodies.get(4).slice(0, 500).every(b => b === 2)).toBe(true);
    expect(partBodies.get(4).slice(500).every(b => b === 3)).toBe(true);
    expect(calls.complete).toHaveLength(1);
    expect(calls.complete[0]).toMatchObject({
      track_type: 'audio', epoch, ext: 'raw', format: 'pcm', start_time_ms: 1234,
      key: 'raw/k', upload_id: 'up1', part_count: 4, total_size: 3900,
    });
    // Nothing went through the server, no separate finalize, and the local
    // copies are cleaned up like a normal successful upload.
    expect(calls.serverChunks).toEqual([]);
    expect(calls.finalize).toEqual([]);
    expect(`audio::${epoch}` in pendingFinalizeMeta).toBe(false);
    expect((await idbGetAllChunks()).filter(c => c.epoch === epoch)).toEqual([]);
    expect(uploadStats.bytesTotal).toBe(3900);
    expect(uploadStats.bytesDone).toBe(3900);
    expect(uploadHasError).toBe(false);
  });

  it('sends a local-disk recording as its whole file (WAV header stripped, like the server path)', async () => {
    stubCloud();
    const payload = new Uint8Array(2500).fill(7);
    const file = new Blob([new Uint8Array(44), payload]);
    globalThis.fsaCloseTrackFile = async () => file;
    const epoch = nextEpoch();
    const fsaOpenPromises = { [`audio::${epoch}`]: Promise.resolve({ ext: 'raw', bytesWritten: file.size, isRawAudio: true }) };

    const ok = await _uploadOneTrack('audio', fsaOpenPromises, {}, [], new AbortController(), epoch,
      { finalizeMeta: { format: 'pcm', sample_rate: 48000, channels: 2 } });

    expect(ok).toBe(true);
    expect(calls.complete[0]).toMatchObject({ total_size: 2500, part_count: 3, ext: 'raw' });
    const bytes = [...partBodies.keys()].sort().flatMap(n => [...partBodies.get(n)]);
    expect(bytes.length).toBe(2500);
    expect(bytes.every(b => b === 7)).toBe(true);
  });

  it('falls back to the server upload when cloud upload is not available', async () => {
    stubCloud({ start: () => ({ ok: false, status: 503, json: async () => ({}) }) });
    const epoch = nextEpoch();
    await putChunks(epoch, 'video', 'webm', [1000, 1000]);
    pendingFinalizeMeta[`video::${epoch}`] = { format: 'container', start_time_ms: 5 };

    await _uploadAllRecordedChunks(epoch);

    expect(calls.serverChunks.sort()).toEqual([0, 1]);
    expect(calls.finalize).toHaveLength(1);
    expect(calls.finalize[0]).toMatchObject({ track_type: 'video', start_time_ms: 5 });
    expect(uploadStats.bytesTotal).toBe(2000); // counted once, not twice
    expect(uploadStats.bytesDone).toBe(2000);
  });

  it('gives up on an unreachable bucket after two network failures (no CORS rule) and falls back', async () => {
    let attempts = 0;
    stubCloud({ putPart: async () => { attempts++; throw new Error('network error'); } });
    const epoch = nextEpoch();
    await putChunks(epoch, 'video', 'webm', [1000]);
    pendingFinalizeMeta[`video::${epoch}`] = { format: 'container' };

    await _uploadAllRecordedChunks(epoch);

    expect(attempts).toBe(2);
    expect(calls.abort).toBe(1);
    expect(calls.complete).toEqual([]);
    expect(calls.serverChunks).toEqual([0]);
    expect(calls.finalize).toHaveLength(1);
    expect(uploadStats.queued).toBe(1);
    expect(uploadStats.bytesTotal).toBe(1000);
  });

  it('falls back when the server finds the bucket parts do not match (409), never completing a partial upload', async () => {
    stubCloud({ complete: () => ({ ok: false, status: 409, json: async () => ({}) }) });
    const epoch = nextEpoch();
    await putChunks(epoch, 'video', 'webm', [1500]);
    pendingFinalizeMeta[`video::${epoch}`] = { format: 'container' };

    await _uploadAllRecordedChunks(epoch);

    expect(calls.complete).toHaveLength(1); // a 4xx isn't retried
    expect(calls.abort).toBe(1);
    expect(calls.serverChunks).toEqual([0]);
    expect(calls.finalize).toHaveLength(1);
  });

  it('leaves a track with a missing chunk to the server path (its gap check), never uploading a spliced file', async () => {
    stubCloud();
    const epoch = nextEpoch();
    await putChunks(epoch, 'video', 'webm', [1000, 1000, 1000]);
    await idbDeleteChunk(SESSION_ID, identity, epoch, 'video', 1);
    pendingFinalizeMeta[`video::${epoch}`] = { format: 'container' };

    await _uploadAllRecordedChunks(epoch);

    expect(calls.start).toBe(0);
    expect(calls.serverChunks.sort()).toEqual([0, 2]);
  });

  it('a cancel during the cloud upload aborts it and does not fall back to uploading through the server', async () => {
    const controller = new AbortController();
    stubCloud({ putPart: async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); } });
    const epoch = nextEpoch();
    await putChunks(epoch, 'video', 'webm', [1000]);
    const chunks = (await idbGetAllChunks()).filter(c => c.epoch === epoch);
    pendingFinalizeMeta[`video::${epoch}`] = { format: 'container' };

    const ok = await _uploadOneTrack('video', {}, {}, chunks, controller, epoch);

    expect(ok).toBe(false);
    expect(calls.abort).toBe(1);
    expect(calls.serverChunks).toEqual([]);
    expect((await idbGetAllChunks()).filter(c => c.epoch === epoch)).toHaveLength(1); // kept for a retry
  });

  it('does nothing cloud-related when direct upload is off', async () => {
    globalThis.DIRECT_CLOUD_UPLOAD = false;
    stubCloud();
    const epoch = nextEpoch();
    await putChunks(epoch, 'video', 'webm', [1000]);
    pendingFinalizeMeta[`video::${epoch}`] = { format: 'container' };

    await _uploadAllRecordedChunks(epoch);

    expect(calls.start).toBe(0);
    expect(calls.serverChunks).toEqual([0]);
  });
});

describe('direct-to-cloud upload: not depending on the PodBooth server mid-upload', () => {
  const startWithUrls = (partCount) => ({
    ok: true, status: 200,
    json: async () => ({
      key: 'raw/k', upload_id: 'up1', part_size: 1000,
      part_urls: Array.from({ length: partCount }, (_, i) => `https://bucket.example/presigned/${i + 1}`),
    }),
  });

  it('uses the part URLs presigned at start — no per-part requests to the server', async () => {
    stubCloud({ start: () => startWithUrls(3) });
    const putUrls = [];
    const realPut = globalThis._xhrPutPart;
    globalThis._xhrPutPart = async (url, blob) => { putUrls.push(url); return realPut(url, blob); };
    const epoch = nextEpoch();
    await putChunks(epoch, 'video', 'webm', [1000, 1000, 500]);
    pendingFinalizeMeta[`video::${epoch}`] = { format: 'container' };

    await _uploadAllRecordedChunks(epoch);

    expect(calls.partUrl).toBe(0);
    expect(putUrls.sort()).toEqual([1, 2, 3].map(n => `https://bucket.example/presigned/${n}`));
    expect(calls.complete).toHaveLength(1);
  });

  it('refreshes just the one part URL the bucket rejects as expired (403)', async () => {
    let rejected = false;
    stubCloud({
      start: () => startWithUrls(2),
      putPart: async (url) => {
        if (url.endsWith('/presigned/2') && !rejected) { rejected = true; return { ok: false, status: 403 }; }
        return { ok: true, status: 200 };
      },
    });
    const epoch = nextEpoch();
    await putChunks(epoch, 'video', 'webm', [1000, 1000]);
    pendingFinalizeMeta[`video::${epoch}`] = { format: 'container' };

    await _uploadAllRecordedChunks(epoch);

    expect(calls.partUrl).toBe(1); // only part 2's, after the 403
    expect(calls.complete).toHaveLength(1);
    expect(calls.serverChunks).toEqual([]);
  });

  it('a request to the server that never answers times out instead of hanging the upload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      globalThis.fetch = vi.fn((url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));

      const result = _postJson('/api/upload/cloud/part-url', {}).then(() => 'resolved', (e) => e.message);
      await vi.advanceTimersByTimeAsync(30_000 + 1); // SERVER_REQUEST_TIMEOUT_MS

      expect(await result).toMatch(/timed out after 30s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancel still aborts a server request immediately, not after the timeout', async () => {
    globalThis.fetch = vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const controller = new AbortController();

    const result = _postJson('/api/upload/cloud/start', {}, controller.signal).then(() => 'resolved', (e) => e.name);
    controller.abort();

    expect(await result).toBe('AbortError');
  });
});
