// The host's stopRecording() awaits a server POST and a LiveKit broadcast
// *before* stopping local capture and starting the upload pass. Neither had a
// timeout, so one request that never answered meant the host's own recording
// was never uploaded while every guest's (which stop on the broadcast) went
// up fine. Both steps are now time-bounded, and a throw while stopping the
// recorder no longer skips the upload pass.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadRecordingModules } from './harness.js';

loadRecordingModules();

let calls;
beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  installGlobals({
    HOST_TOKEN: 'tok',
    btnStopRec: { disabled: false },
    stopLocalRecording: async () => { calls.push('stopLocal'); },
    setRecordingUI: () => { calls.push('ui'); },
    waitForUploads: async () => { calls.push('upload'); },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A fetch that honours abort (like the real one) but otherwise never answers.
function hangingFetch() {
  return vi.fn((url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
}

describe('stopRecording (host): upload must not depend on the stop request/broadcast', () => {
  it('a /recording POST that never answers is abandoned and the upload still runs', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const p = stopRecording();
    await vi.advanceTimersByTimeAsync(11_000);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(1); // really went through the hanging fetch
    expect(calls).toEqual(['stopLocal', 'ui', 'upload']);
    expect(btnStopRec.disabled).toBe(false);
  });

  it('a broadcast that never resolves is abandoned and the upload still runs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    globalThis.broadcastData = () => new Promise(() => {});
    const p = stopRecording();
    await vi.advanceTimersByTimeAsync(11_000);
    await p;
    expect(calls).toEqual(['stopLocal', 'ui', 'upload']);
  });

  it('stopLocalRecording throwing does not skip the upload pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    globalThis.stopLocalRecording = async () => { throw new Error('recorder exploded'); };
    await stopRecording();
    expect(calls).toEqual(['ui', 'upload']);
  });

  it('re-enables the stop button even if the upload pass throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    globalThis.waitForUploads = async () => { throw new Error('boom'); };
    await expect(stopRecording()).rejects.toThrow('boom');
    expect(btnStopRec.disabled).toBe(false);
  });
});
