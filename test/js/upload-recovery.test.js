// Regression coverage for chunk H4: recovery used to trust next_chunk (=
// max_index + 1) as a contiguous-prefix guarantee, so a chunk that failed in
// the middle of a 4-wide-concurrent upload batch (server has 0,2,3,4 — 1
// never landed) got deleted from IndexedDB as if the server had it too,
// destroying the only copy. The fix has the server report present_indices
// and the client only ever delete confirmed-present chunks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadUploadModules, makeBlob, stubXhrUpload } from './harness.js';

loadUploadModules();
const _realUploadChunkWithRetry = uploadChunkWithRetry;
afterEach(() => { globalThis.uploadChunkWithRetry = _realUploadChunkWithRetry; });

async function putChunk({ epoch = 'epoch-1', trackType = 'audio', chunkIndex, ext = 'raw' }) {
  await idbPutChunk({
    sessionId: SESSION_ID, identity, participant: displayName, epoch,
    trackType, chunkIndex, ext, meta: {}, blob: makeBlob(10),
  });
}

beforeEach(async () => {
  installGlobals();
  // Clear any chunks a previous test left in the shared fake-indexeddb store.
  for (const rec of await idbGetAllChunks()) {
    await idbDeleteChunk(rec.sessionId, rec.identity, rec.epoch, rec.trackType, rec.chunkIndex);
  }
});

describe('_recoverGroup (H4: gap-tolerant recovery)', () => {
  it('only deletes chunks the server confirms it has, and resends a real gap', async () => {
    for (const i of [0, 1, 2, 3, 4]) await putChunk({ chunkIndex: i });
    const chunks = (await idbGetAllChunks()).filter(c => c.trackType === 'audio');
    expect(chunks).toHaveLength(5);

    // Server has everything except index 1 — the "hole below max_index" case
    // the old next_chunk=max_index+1 logic couldn't detect.
    const resent = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith('/api/upload/chunks')) {
        return { ok: true, status: 200, json: async () => ({ present_indices: [0, 2, 3, 4] }) };
      }
      if (String(url).startsWith('/api/upload/finalize')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    stubXhrUpload((form) => {
      resent.push(Number(form.get('chunk_index')));
      return { ok: true, status: 200 };
    });

    const ok = await _recoverGroup(chunks);
    expect(ok).toBe(true);

    // Only the real gap was resent — not the whole prefix.
    expect(resent).toEqual([1]);

    // Every chunk (server-confirmed AND freshly resent) is gone from IDB now.
    const remaining = await idbGetAllChunks();
    expect(remaining).toHaveLength(0);
  });

  it('does not resend or delete anything beyond a permanently-failing chunk, and reports failure', async () => {
    for (const i of [0, 1]) await putChunk({ chunkIndex: i, trackType: 'video' });
    const chunks = (await idbGetAllChunks()).filter(c => c.trackType === 'video');

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith('/api/upload/chunks')) {
        return { ok: true, status: 200, json: async () => ({ present_indices: [] }) };
      }
      throw new Error(`unexpected fetch during a failed recovery: ${url}`);
    }));
    // Stub the retrying uploader itself (rather than driving its real ~10min
    // retry budget via _xhrUploadChunk failures) so this test stays fast —
    // uploadChunkWithRetry's own backoff/budget behavior isn't what H4 is
    // about, and is a global function like _xhrUploadChunk so it's just as
    // overridable here.
    const attempted = [];
    globalThis.uploadChunkWithRetry = async (blob, trackType, index) => {
      attempted.push(index);
      return false;
    };

    const ok = await _recoverGroup(chunks);
    expect(ok).toBe(false);

    // Recovery must not skip ahead past a failing chunk and leave a silent
    // gap of its own — only chunk 0 (index order) was even attempted.
    expect(attempted).toEqual([0]);
    const remaining = await idbGetAllChunks();
    expect(remaining.map(c => c.chunkIndex).sort()).toEqual([0, 1]);
  });
});
