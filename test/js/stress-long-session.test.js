// Volume/stress coverage: simulates a long recording session (hundreds of
// chunks across audio/video/screen, several screen-share restarts, and a
// fast retake racing the upload pass) in well under a second instead of by
// actually recording for 30-45 minutes — the class of bug this project has
// kept finding (epoch races, cross-segment corruption) only shows up once
// chunk counts and timing windows get large enough for the race to land,
// which a 2-5 minute manual test rarely hits.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadUploadModules, makeBlob, stubXhrUpload } from './harness.js';

loadUploadModules();

const AUDIO_CHUNKS = 200; // ~200 x 5s timeslices ≈ 16-17 minutes of audio
const VIDEO_CHUNKS = 200;
const SCREEN_SEGMENT_CHUNKS = 60; // 3 restarts x 60 chunks ≈ 15 minutes of screen share

async function enqueueMany(trackType, ext, count, epochOverride) {
  for (let i = 0; i < count; i++) {
    enqueueChunk(makeBlob(256), trackType, ext, {}, epochOverride);
  }
  // enqueueChunk chains onto _persistQueues without awaiting — drain it so
  // every chunk is actually in IndexedDB before the upload pass snapshots it,
  // same guarantee _doUploadAllRecordedChunks itself relies on.
  await _persistQueues[trackType];
}

beforeEach(async () => {
  installGlobals();
  for (const rec of await idbGetAllChunks()) {
    await idbDeleteChunk(rec.sessionId, rec.identity, rec.epoch, rec.trackType, rec.chunkIndex);
  }
});

describe('long-session volume + concurrency', () => {
  it('uploads every chunk under the right (track, epoch) group, finalizes each group once, and survives a mid-upload retake — at hundreds-of-chunks scale', async () => {
    recordingEpoch = 'sess';

    // Screen share used three times this recording (start, restart, restart)
    // — each gets its own sub-epoch, exactly like startScreenRecording does.
    screenEpochHistory = ['sess', 'sess_s1', 'sess_s2'];

    await enqueueMany('audio', 'raw', AUDIO_CHUNKS);
    await enqueueMany('video', 'webm', VIDEO_CHUNKS);
    await enqueueMany('screen', 'webm', SCREEN_SEGMENT_CHUNKS, 'sess');
    await enqueueMany('screen', 'webm', SCREEN_SEGMENT_CHUNKS, 'sess_s1');
    await enqueueMany('screen', 'webm', SCREEN_SEGMENT_CHUNKS, 'sess_s2');

    finalizeTrack('audio', { format: 'pcm', sample_rate: 48000, channels: 2 }, 'sess');
    finalizeTrack('video', { format: 'container' }, 'sess');
    finalizeTrack('screen', { format: 'container' }, 'sess');
    finalizeTrack('screen', { format: 'container' }, 'sess_s1');
    finalizeTrack('screen', { format: 'container' }, 'sess_s2');

    expect((await idbGetAllChunks()).length).toBe(AUDIO_CHUNKS + VIDEO_CHUNKS + 3 * SCREEN_SEGMENT_CHUNKS);

    const uploadedByGroup = new Map(); // "trackType::epoch" -> count
    stubXhrUpload((form) => {
      const key = `${form.get('track_type')}::${form.get('epoch')}`;
      uploadedByGroup.set(key, (uploadedByGroup.get(key) ?? 0) + 1);
      return { ok: true, status: 200 };
    });
    const finalizedGroups = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (String(url).startsWith('/api/upload/finalize')) {
        const body = JSON.parse(opts.body);
        finalizedGroups.push(`${body.track_type}::${body.epoch}`);
        return { ok: true, status: 200, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    // Kick off the real upload pass, capturing epoch/screenEpochs the same
    // way waitForUploads does — then, while it's still in flight uploading
    // hundreds of chunks concurrently, simulate a fast retake exactly like
    // H1's regression test, just under real volume this time.
    const pass = _uploadAllRecordedChunks('sess', ['sess', 'sess_s1', 'sess_s2']);

    recordingEpoch = 'sess2';
    await enqueueMany('audio', 'raw', 5, undefined); // uses the new live recordingEpoch

    await pass;

    // Every chunk of every group landed tagged with its own group's epoch —
    // no cross-contamination between the three screen segments, and none
    // from the concurrent retake.
    expect(uploadedByGroup.get('audio::sess')).toBe(AUDIO_CHUNKS);
    expect(uploadedByGroup.get('video::sess')).toBe(VIDEO_CHUNKS);
    expect(uploadedByGroup.get('screen::sess')).toBe(SCREEN_SEGMENT_CHUNKS);
    expect(uploadedByGroup.get('screen::sess_s1')).toBe(SCREEN_SEGMENT_CHUNKS);
    expect(uploadedByGroup.get('screen::sess_s2')).toBe(SCREEN_SEGMENT_CHUNKS);
    expect(uploadedByGroup.has('audio::sess2')).toBe(false);
    expect(uploadedByGroup.size).toBe(5); // exactly the five groups above, nothing extra

    // Each of the five groups finalized exactly once.
    expect(finalizedGroups.sort()).toEqual([
      'audio::sess', 'screen::sess', 'screen::sess_s1', 'screen::sess_s2', 'video::sess',
    ]);

    // take-1's pass cleaned up every chunk it uploaded...
    const remaining = await idbGetAllChunks();
    // ...but take-2's 5 chunks, enqueued mid-pass, are untouched — this is
    // the volume-scale version of H1: idbDeleteEpoch must never have run
    // against 'sess2', even though this pass was busy with 640 chunks when
    // the retake started.
    expect(remaining).toHaveLength(5);
    expect(remaining.every(c => c.epoch === 'sess2')).toBe(true);
  }, 15000);
});
