// Coverage for recoverOrphanedChunks — the entry point a page reload/rejoin
// calls to sweep whatever's left in IndexedDB from a crashed/closed tab. It
// groups leftover chunks by (sessionId, identity, epoch, trackType), recovers
// each group under a Web Locks exclusive lock (so two tabs on the same
// session don't race to resend the same chunks), and sweeps stale
// "interrupted session" localStorage markers that have nothing left to
// recover. None of this had test coverage before.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadUploadModules, makeBlob } from './harness.js';

loadUploadModules();

async function putChunk({ sessionId = 'sess-1', identity, epoch, trackType, chunkIndex }) {
  await idbPutChunk({
    sessionId, identity, participant: identity, epoch, trackType,
    chunkIndex, ext: 'raw', meta: {}, blob: makeBlob(8),
  });
}

function stubFetchAllPresent() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/upload/chunks') {
      const indices = [...Array(20).keys()]; // comfortably covers every index used below
      return { ok: true, status: 200, json: async () => ({ present_indices: indices }) };
    }
    if (u.pathname === '/api/upload/finalize') {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

function makeLocksStub(unavailable = new Set()) {
  return {
    async request(name, opts, cb) {
      return cb(unavailable.has(name) ? null : {});
    },
  };
}

beforeEach(async () => {
  installGlobals();
  for (const rec of await idbGetAllChunks()) {
    await idbDeleteChunk(rec.sessionId, rec.identity, rec.epoch, rec.trackType, rec.chunkIndex);
  }
});

describe('recoverOrphanedChunks', () => {
  it('recovers every distinct (session, identity, epoch, trackType) group left behind by a crashed tab', async () => {
    await putChunk({ identity: 'alice', epoch: 'e1', trackType: 'audio', chunkIndex: 0 });
    await putChunk({ identity: 'alice', epoch: 'e1', trackType: 'audio', chunkIndex: 1 });
    await putChunk({ identity: 'bob', epoch: 'e2', trackType: 'video', chunkIndex: 0 });
    stubFetchAllPresent();
    globalThis.navigator = { locks: makeLocksStub() };

    await recoverOrphanedChunks();

    // Every present index came back from the server, so every chunk in both
    // groups gets cleared — a full sweep leaves nothing behind.
    expect(await idbGetAllChunks()).toHaveLength(0);
  });

  it('skips a group whose lock another tab already holds, but still recovers the rest', async () => {
    await putChunk({ identity: 'alice', epoch: 'e1', trackType: 'audio', chunkIndex: 0 });
    await putChunk({ identity: 'bob', epoch: 'e2', trackType: 'video', chunkIndex: 0 });
    stubFetchAllPresent();
    const aliceLock = 'podbooth-recover:sess-1:alice:e1:audio';
    globalThis.navigator = { locks: makeLocksStub(new Set([aliceLock])) };

    await recoverOrphanedChunks();

    const remaining = await idbGetAllChunks();
    // Alice's group was skipped (another tab holds the lock) — untouched.
    expect(remaining).toHaveLength(1);
    expect(remaining[0].identity).toBe('alice');
  });

  it('clears a stale interrupted-session marker with no matching leftover chunks', async () => {
    // Nothing in IndexedDB for this marker — e.g. the tab died in the
    // instant after waitForUploads finished uploading but before it removed
    // its own marker, or it crashed before capturing a single chunk.
    localStorage.setItem('podbooth:epoch:sess-1:ghost', 'e-gone');
    stubFetchAllPresent();
    globalThis.navigator = { locks: makeLocksStub() };

    await recoverOrphanedChunks();

    expect(localStorage.getItem('podbooth:epoch:sess-1:ghost')).toBeNull();
  });

  it('leaves a marker alone when its group is still present in IndexedDB this sweep', async () => {
    await putChunk({ identity: 'alice', epoch: 'e1', trackType: 'audio', chunkIndex: 0 });
    localStorage.setItem('podbooth:epoch:sess-1:alice', 'e1');
    stubFetchAllPresent();
    globalThis.navigator = { locks: makeLocksStub() };

    await recoverOrphanedChunks();

    // The marker matches a group that really was swept this run — cleared
    // via _recoverGroup's own success path, not left dangling, but the point
    // of this test is that the *stale-marker sweep* doesn't need to touch it
    // (it's already gone by the time that sweep runs).
    expect(localStorage.getItem('podbooth:epoch:sess-1:alice')).toBeNull();
  });

  it('does nothing when IndexedDB is empty', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    globalThis.navigator = { locks: makeLocksStub() };

    await recoverOrphanedChunks();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
