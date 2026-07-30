// Regression coverage for chunk H1: _doUploadAllRecordedChunks used to read
// the module-global `recordingEpoch` at several points deep inside a pass
// instead of capturing it once at entry — so a fast retake (stopRecording
// flips the UI back to "Record" before its upload pass finishes, letting
// startLocalRecording reassign recordingEpoch while that pass is still
// running) could finalize/sweep under the *new* take's epoch, destroying its
// still-being-written IndexedDB chunks. The fix threads the pass's captured
// epoch through explicitly instead of re-reading the live global.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadUploadModules, makeBlob, stubXhrUpload } from './harness.js';

loadUploadModules();

beforeEach(async () => {
  installGlobals();
  for (const rec of await idbGetAllChunks()) {
    await idbDeleteChunk(rec.sessionId, rec.identity, rec.epoch, rec.trackType, rec.chunkIndex);
  }
});

describe('_doUploadAllRecordedChunks (H1: epoch isolation across a fast retake)', () => {
  it('never uploads or touches a newer takes chunks even if recordingEpoch is reassigned mid-pass', async () => {
    recordingEpoch = 'take-1';
    await idbPutChunk({
      sessionId: SESSION_ID, identity, participant: displayName, epoch: 'take-1',
      trackType: 'audio', chunkIndex: 0, ext: 'raw', meta: {}, blob: makeBlob(10),
    });

    const uploadedEpochs = [];
    stubXhrUpload((form) => {
      uploadedEpochs.push(form.get('epoch'));
      return { ok: true, status: 200 };
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));

    // Capture the pass's epoch the same way waitForUploads does, *before*
    // simulating the retake — this is the crux of the fix: everything below
    // must keep using this captured value, not the live `recordingEpoch`.
    const pass = _uploadAllRecordedChunks('take-1');

    // Simulate a fast retake starting while take-1's upload pass is still
    // in flight: startLocalRecording's real effect on these globals.
    recordingEpoch = 'take-2';
    await idbPutChunk({
      sessionId: SESSION_ID, identity, participant: displayName, epoch: 'take-2',
      trackType: 'audio', chunkIndex: 0, ext: 'raw', meta: {}, blob: makeBlob(10),
    });

    await pass;

    // take-1's chunk was uploaded tagged with its own epoch, never take-2's.
    expect(uploadedEpochs).toEqual(['take-1']);

    // take-2's chunk — still "recording" from this pass's point of view —
    // must survive untouched in IndexedDB; the bug deleted it.
    const remaining = await idbGetAllChunks();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].epoch).toBe('take-2');
  });
});

describe('_clearEpochMarker (H13: stale "interrupted session" banner)', () => {
  it('only clears the localStorage marker if it still points at the epoch being cleared', () => {
    const key = `podbooth:epoch:${SESSION_ID}:${identity}`;
    localStorage.setItem(key, 'take-2');

    // A late cleanup call for the finished take-1 pass must not clobber the
    // marker a newer take-2 recording has since written for itself.
    _clearEpochMarker(identity, 'take-1');
    expect(localStorage.getItem(key)).toBe('take-2');

    _clearEpochMarker(identity, 'take-2');
    expect(localStorage.getItem(key)).toBeNull();
  });
});
