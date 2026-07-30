// Regression coverage for chunk H2: if startPcmCapture() fails during a
// mid-recording mic-switch restart, the old code silently fell back to
// startOpusFallback() — which kept writing .webm chunks into the very same
// chunkIndex.audio/epoch that already held .raw PCM chunks. The server
// byte-concatenates a track's chunks regardless of extension and picks the
// container format from chunk 0 alone, so mixing formats corrupted the
// whole audio take, not just the tail. The fix treats this as fatal for the
// track instead of silently producing bad data.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadRecordingModules } from './harness.js';

loadRecordingModules();

beforeEach(() => {
  installGlobals({
    isRecording: true,
    // A restart in progress: the old PCM node/source/context are set up as
    // if capture had been running, matching restartPcmCapture's assumptions
    // about what's already live when it's called.
    pcmNode: { port: { onmessage: null }, disconnect: () => {} },
    pcmSource: { disconnect: () => {} },
    pcmCtx: { close: () => {}, sampleRate: 48000 },
    pcmFrames: 0, // skip the flushPcm(false) branch — not what this test covers
  });
});

describe('restartPcmCapture (H2: PCM->Opus fallback)', () => {
  it('treats a startPcmCapture() failure as fatal instead of silently falling back to Opus', async () => {
    globalThis.startPcmCapture = vi.fn(async () => { throw new Error('getUserMedia failed'); });
    const opusFallbackSpy = vi.fn();
    globalThis.startOpusFallback = opusFallbackSpy;
    const fatalSpy = vi.fn(async () => {});
    globalThis.handleFatalRecordingError = fatalSpy;

    await restartPcmCapture();

    expect(fatalSpy).toHaveBeenCalledTimes(1);
    expect(fatalSpy.mock.calls[0][0]).toBe('audio');
    // The bug this regresses: falling through to the Opus fallback instead
    // of surfacing a fatal error, corrupting the track by mixing formats.
    expect(opusFallbackSpy).not.toHaveBeenCalled();
  });

  it('does not touch handleFatalRecordingError when the restart succeeds', async () => {
    globalThis.startPcmCapture = vi.fn(async () => {
      globalThis.pcmCtx = { close: () => {}, sampleRate: 48000 };
    });
    const fatalSpy = vi.fn(async () => {});
    globalThis.handleFatalRecordingError = fatalSpy;

    await restartPcmCapture();

    expect(fatalSpy).not.toHaveBeenCalled();
  });
});
