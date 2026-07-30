// Regression coverage for chunk H3: a screen-share stop→restart mid-recording
// used to keep the same epoch and continue chunkIndex.screen, so the second
// segment's MediaRecorder — which emits its own self-contained WebM with its
// own EBML header — got byte-concatenated onto the first segment server-side,
// corrupting the assembled file partway through. The fix gives each restart
// its own sub-epoch (screenEpoch) and resets chunkIndex.screen, so the two
// segments assemble as independent files.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadRecordingModules, makeRoomWithScreenShare } from './harness.js';

loadRecordingModules();

beforeEach(() => {
  installGlobals({
    isRecording: true,
    recordingEpoch: 'rec-abc',
    room: makeRoomWithScreenShare(),
  });
});

describe('startScreenRecording (H3: restart gets its own sub-epoch)', () => {
  it('first segment uses the recording epoch as-is (unchanged from before restarts existed)', () => {
    startScreenRecording();
    expect(screenEpoch).toBe('rec-abc');
    expect(screenEpochHistory).toEqual(['rec-abc']);
    expect(chunkIndex.screen).toBe(0);
  });

  it('a restart gets a fresh sub-epoch, resets chunkIndex.screen, and both epochs are tracked', () => {
    startScreenRecording();
    chunkIndex.screen = 7; // simulate a few chunks having been captured already
    cleanupLocalScreen(); // user stops sharing (or the browser ends the track)

    startScreenRecording(); // ...then restarts sharing, same recording

    expect(screenEpoch).toBe('rec-abcs1');
    expect(screenEpochHistory).toEqual(['rec-abc', 'rec-abcs1']);
    // The bug this regresses: continuing chunkIndex.screen from the first
    // segment made the restart's first chunk collide/concatenate with the
    // first segment's sequence instead of starting its own.
    expect(chunkIndex.screen).toBe(0);
  });

  it('chunks captured after a restart are tagged with the new sub-epoch, not the recording epoch', () => {
    startScreenRecording();
    cleanupLocalScreen();
    startScreenRecording();

    const enqueued = [];
    globalThis.enqueueChunk = (blob, trackType, ext, meta, epochOverride) => {
      enqueued.push({ trackType, epochOverride });
    };

    screenRecorder.ondataavailable({ data: { size: 100 } });

    expect(enqueued).toEqual([{ trackType: 'screen', epochOverride: 'rec-abcs1' }]);
  });

  it('a second restart increments the generation again', () => {
    startScreenRecording();
    cleanupLocalScreen();
    startScreenRecording();
    cleanupLocalScreen();
    startScreenRecording();

    expect(screenEpoch).toBe('rec-abcs2');
    expect(screenEpochHistory).toEqual(['rec-abc', 'rec-abcs1', 'rec-abcs2']);
  });
});
