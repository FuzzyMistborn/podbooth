// Regression test: clicking "Cancel upload" while a chunk is sitting in its
// retry backoff sleep (any network hiccup puts it there) must take effect
// immediately, not only once that backoff timer happens to expire on its
// own. See uploadChunkWithRetry's retry loop in upload.js.
import { describe, it, expect } from 'vitest';
import { installGlobals, loadUploadModules, stubXhrUpload, makeBlob } from './harness.js';

describe('cancel during chunk-upload retry backoff', () => {
  it('resolves promptly on abort instead of waiting out the backoff sleep', async () => {
    installGlobals();
    loadUploadModules();
    // Every attempt fails, forcing uploadChunkWithRetry into its backoff wait.
    stubXhrUpload(() => ({ ok: false, status: 500 }));

    const controller = new AbortController();
    const started = Date.now();
    const resultPromise = uploadChunkWithRetry(
      makeBlob(), 'audio', 0, 'webm', 'epoch1', {}, 'sess-1', 'host', 'Host',
      controller.signal,
    );

    // Give the first (failing) attempt a moment to run and land in its
    // 1000ms backoff sleep, then cancel — well before that sleep would
    // naturally elapse.
    await new Promise(r => setTimeout(r, 50));
    controller.abort();

    const ok = await resultPromise;
    const elapsed = Date.now() - started;

    expect(ok).toBe(false);
    // Without the abort-aware backoff, this would take ~1000ms (the first
    // attempt's backoff) at minimum.
    expect(elapsed).toBeLessThan(500);
  });
});
