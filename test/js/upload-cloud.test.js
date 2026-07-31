// Coverage for the direct-to-cloud FSA upload path: when
// DIRECT_CLOUD_UPLOAD_ENABLED, a clean FSA track's whole-file upload bypasses
// this server (slow peering to guests) and PUTs multipart parts straight to
// the configured S3-compatible backend via presigned URLs, then the server
// pulls the finished object back down on its own link — see
// _uploadFsaTrackDirectToCloud / recoverCloudUploads in upload.js.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadUploadModules, makeBlob } from './harness.js';

loadUploadModules();

function fakeResponse(body, opts = {}) {
  return {
    ok: opts.ok !== false,
    status: opts.status ?? 200,
    json: async () => body,
    headers: { get: (name) => (opts.headers || {})[name.toLowerCase()] ?? null },
  };
}

beforeEach(async () => {
  installGlobals({ fsaDirHandle: {}, DIRECT_CLOUD_UPLOAD_ENABLED: true });
  for (const rec of await idbGetAllChunks()) {
    await idbDeleteChunk(rec.sessionId, rec.identity, rec.epoch, rec.trackType, rec.chunkIndex);
  }
});

describe('_uploadOneTrack (direct-to-cloud FSA path)', () => {
  it('uploads a clean local-file track as multipart parts straight to presigned URLs, then completes', async () => {
    const fileSize = 12 * 1024 * 1024; // -> 3 parts at a 5MB part_size the server chose
    const fakeFile = makeBlob(fileSize);
    fakeFile.name = 'Take_1.wav';
    globalThis.fsaCloseTrackFile = async () => fakeFile;
    const fsaOpenPromises = {
      audio: Promise.resolve({ ext: 'wav', bytesWritten: fileSize, isRawAudio: false }),
    };

    const calls = [];
    const puts = [];
    globalThis.fetch = vi.fn((url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET' });
      if (url === '/api/upload/cloud/start') {
        return Promise.resolve(fakeResponse({ key: 'raw-uploads/x/audio_epoch1.wav', upload_id: 'up-1', part_size: 5 * 1024 * 1024 }));
      }
      if (url === '/api/upload/cloud/part-url') {
        const body = JSON.parse(opts.body);
        return Promise.resolve(fakeResponse({ url: `https://bucket.example/part-${body.part_number}` }));
      }
      if (String(url).startsWith('https://bucket.example/part-')) {
        puts.push({ url: String(url), size: opts.body.size });
        const n = url.split('-').pop();
        return Promise.resolve(fakeResponse({}, { headers: { etag: `"etag-${n}"` } }));
      }
      if (url === '/api/upload/cloud/complete') {
        calls[calls.length - 1].body = JSON.parse(opts.body);
        return Promise.resolve(fakeResponse({ ok: true }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const abortController = new AbortController();
    await _uploadOneTrack('audio', fsaOpenPromises, {}, [], abortController, 'epoch1');

    expect(puts).toHaveLength(3);
    expect(puts.map(p => p.size)).toEqual([5 * 1024 * 1024, 5 * 1024 * 1024, 2 * 1024 * 1024]);

    const completeCall = calls.find(c => c.url === '/api/upload/cloud/complete');
    expect(completeCall.body.upload_id).toBe('up-1');
    expect(completeCall.body.parts.sort((a, b) => a.part_number - b.part_number))
      .toEqual([
        { part_number: 1, etag: '"etag-1"' },
        { part_number: 2, etag: '"etag-2"' },
        { part_number: 3, etag: '"etag-3"' },
      ]);

    // No server-proxied chunk upload happened for this track — the whole
    // point of the cloud path is to skip that.
    expect(calls.some(c => c.url === '/api/upload/chunk')).toBe(false);
  });

  it('persists the finalize meta (sample_rate/channels/format) into the resume marker and sends it on /cloud/complete', async () => {
    const fileSize = 2 * 1024 * 1024;
    const fakeFile = makeBlob(fileSize);
    fakeFile.name = 'Take_1.wav';
    globalThis.fsaCloseTrackFile = async () => fakeFile;
    const fsaOpenPromises = {
      audio: Promise.resolve({ ext: 'wav', bytesWritten: fileSize, isRawAudio: false }),
    };
    pendingFinalizeMeta['audio::epoch1'] = { format: 'pcm', sample_rate: 44100, channels: 2, expected_duration_s: 12.3 };

    let completeBody = null;
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === '/api/upload/cloud/start') {
        return Promise.resolve(fakeResponse({ key: 'k', upload_id: 'up-1', part_size: 5 * 1024 * 1024 }));
      }
      if (url === '/api/upload/cloud/part-url') {
        return Promise.resolve(fakeResponse({ url: 'https://bucket.example/part-1' }));
      }
      if (String(url).startsWith('https://bucket.example/')) {
        return Promise.resolve(fakeResponse({}, { headers: { etag: '"etag-1"' } }));
      }
      if (url === '/api/upload/cloud/complete') {
        completeBody = JSON.parse(opts.body);
        return Promise.resolve(fakeResponse({ ok: true }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await _uploadOneTrack('audio', fsaOpenPromises, {}, [], new AbortController(), 'epoch1');

    expect(completeBody.format).toBe('pcm');
    expect(completeBody.sample_rate).toBe(44100);
    expect(completeBody.channels).toBe(2);
    expect(completeBody.expected_duration_s).toBe(12.3);
  });

  it('aborts the multipart upload and clears the marker when the user cancels the upload', async () => {
    const fileSize = 12 * 1024 * 1024;
    const fakeFile = makeBlob(fileSize);
    fakeFile.name = 'Take_1.wav';
    globalThis.fsaCloseTrackFile = async () => fakeFile;
    const fsaOpenPromises = {
      audio: Promise.resolve({ ext: 'wav', bytesWritten: fileSize, isRawAudio: false }),
    };

    // Already cancelled by the time part upload starts (e.g. the user hit
    // "Cancel upload" right after the recording stopped) — no part should
    // ever be PUT, but the multipart upload still needs cleaning up.
    const abortController = new AbortController();
    abortController.abort();

    let abortCalled = null;
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === '/api/upload/cloud/start') {
        return Promise.resolve(fakeResponse({ key: 'k', upload_id: 'up-cancel', part_size: 5 * 1024 * 1024 }));
      }
      if (url === '/api/upload/cloud/abort') {
        abortCalled = JSON.parse(opts.body);
        return Promise.resolve(fakeResponse({ ok: true }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await _uploadOneTrack('audio', fsaOpenPromises, {}, [], abortController, 'epoch1');

    expect(abortCalled).toEqual({ session_id: 'sess-1', key: 'k', upload_id: 'up-cancel' });
    expect(localStorage.getItem('podbooth:cloud:sess-1:identity-1:audio:epoch1')).toBeNull();
  });

  it('falls back to the server-proxied slice path when /cloud/start fails', async () => {
    const fileSize = 6 * 1024 * 1024;
    const fakeFile = makeBlob(fileSize);
    fakeFile.name = 'Take_1.wav';
    globalThis.fsaCloseTrackFile = async () => fakeFile;
    const fsaOpenPromises = {
      audio: Promise.resolve({ ext: 'wav', bytesWritten: fileSize, isRawAudio: false }),
    };

    globalThis.fetch = vi.fn(() => Promise.resolve(fakeResponse({ detail: 'not configured' }, { ok: false, status: 503 })));

    const uploaded = [];
    globalThis._xhrUploadChunk = (form) => {
      uploaded.push(Number(form.get('chunk_index')));
      return Promise.resolve({ ok: true, status: 200 });
    };

    await _uploadOneTrack('audio', fsaOpenPromises, {}, [], new AbortController(), 'epoch1');

    // Fell back to slicing through the app server instead of staying stuck.
    expect(uploaded.sort((a, b) => a - b)).toEqual([0, 1]);
  });
});

describe('recoverCloudUploads', () => {
  it('resumes an interrupted cloud upload, skipping parts the bucket already has', async () => {
    localStorage.setItem(
      'podbooth:cloud:sess-1:identity-1:audio:epoch1',
      JSON.stringify({ key: 'raw-uploads/x/audio_epoch1.wav', uploadId: 'up-2', ext: 'wav', partSize: 5 * 1024 * 1024, fileName: 'Take_1.wav', participant: 'Tester' }),
    );

    const fileSize = 12 * 1024 * 1024; // 3 parts
    const fakeFile = makeBlob(fileSize);
    globalThis.fsaGetDirectory = async () => ({
      getFileHandle: async (name) => {
        expect(name).toBe('Take_1.wav');
        return { getFile: async () => fakeFile };
      },
    });

    const puts = [];
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (String(url).startsWith('/api/upload/cloud/parts')) {
        // Part 1 already landed in the bucket before the crash.
        return Promise.resolve(fakeResponse({ parts: [{ part_number: 1, etag: '"etag-1"', size: 5 * 1024 * 1024 }] }));
      }
      if (url === '/api/upload/cloud/part-url') {
        const body = JSON.parse(opts.body);
        return Promise.resolve(fakeResponse({ url: `https://bucket.example/part-${body.part_number}` }));
      }
      if (String(url).startsWith('https://bucket.example/part-')) {
        const n = url.split('-').pop();
        puts.push(Number(n));
        return Promise.resolve(fakeResponse({}, { headers: { etag: `"etag-${n}"` } }));
      }
      if (url === '/api/upload/cloud/complete') {
        return Promise.resolve(fakeResponse({ ok: true }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await recoverCloudUploads();

    // Only parts 2 and 3 were re-uploaded — part 1 was skipped because
    // /cloud/parts reported it already in the bucket.
    expect(puts.sort()).toEqual([2, 3]);
    expect(localStorage.getItem('podbooth:cloud:sess-1:identity-1:audio:epoch1')).toBeNull();
  });

  it('sends the marker-persisted finalize meta on resume, not server defaults', async () => {
    localStorage.setItem(
      'podbooth:cloud:sess-1:identity-1:audio:epoch1',
      JSON.stringify({
        key: 'raw-uploads/x/audio_epoch1.wav', uploadId: 'up-4', ext: 'wav',
        partSize: 5 * 1024 * 1024, fileName: 'Take_1.wav', participant: 'Tester',
        meta: { format: 'pcm', sample_rate: 44100, channels: 2, expected_duration_s: 5 },
      }),
    );
    const fakeFile = makeBlob(1024);
    globalThis.fsaGetDirectory = async () => ({
      getFileHandle: async () => ({ getFile: async () => fakeFile }),
    });
    let completeBody = null;
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (String(url).startsWith('/api/upload/cloud/parts')) return Promise.resolve(fakeResponse({ parts: [] }));
      if (url === '/api/upload/cloud/part-url') return Promise.resolve(fakeResponse({ url: 'https://bucket.example/part-1' }));
      if (String(url).startsWith('https://bucket.example/')) return Promise.resolve(fakeResponse({}, { headers: { etag: '"etag-1"' } }));
      if (url === '/api/upload/cloud/complete') {
        completeBody = JSON.parse(opts.body);
        return Promise.resolve(fakeResponse({ ok: true }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await recoverCloudUploads();

    expect(completeBody.sample_rate).toBe(44100);
    expect(completeBody.channels).toBe(2);
    expect(completeBody.format).toBe('pcm');
  });

  it('leaves the marker in place if resuming fails, so a later join can retry', async () => {
    localStorage.setItem(
      'podbooth:cloud:sess-1:identity-1:audio:epoch1',
      JSON.stringify({ key: 'raw-uploads/x/audio_epoch1.wav', uploadId: 'up-3', ext: 'wav', partSize: 5 * 1024 * 1024, fileName: 'Take_1.wav', participant: 'Tester' }),
    );
    globalThis.fsaGetDirectory = async () => ({
      getFileHandle: async () => { throw new Error('permission revoked'); },
    });
    globalThis.fetch = vi.fn(() => Promise.resolve(fakeResponse({ parts: [] })));

    await recoverCloudUploads();

    expect(localStorage.getItem('podbooth:cloud:sess-1:identity-1:audio:epoch1')).not.toBeNull();
  });
});
