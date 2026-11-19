// Each fsaFlushTrackFile (close + reopen with keepExistingData) makes the
// browser copy the whole existing file, so a flat 8MB flush interval cost
// O(file size) every couple of chunks. On a ~74min, ~6GB host video track the
// write queue fell hopelessly behind and the stop-time upload pass sat waiting
// on the backlog. The flush interval must grow with the file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app/static/js');
(0, eval)(fs.readFileSync(path.join(dir, 'fsa-store.js'), 'utf8'));

function fakeTrack() {
  const t = { bytesWritten: 0, flushedBytes: 0, chunksWritten: 0, isRawAudio: false, dataBytes: 0, flushes: 0, copiedBytes: 0 };
  t.writable = { write: async () => {}, close: async () => { t.flushes++; t.copiedBytes += t.bytesWritten; } };
  t.fileHandle = { createWritable: async () => ({ write: async () => {}, close: t.writable.close, seek: async () => {} }) };
  return t;
}

describe('fsaWriteChunk flush cost', () => {
  it('keeps total flush copying bounded over a ~6GB video track', async () => {
    const t = fakeTrack();
    const chunk = { size: 7 * 1024 * 1024 };
    for (let i = 0; i < 890; i++) await fsaWriteChunk(t, chunk);
    // Old behaviour: ~445 flushes, ~1.3TB copied. Must stay well under that.
    expect(t.flushes).toBeLessThan(80);
    // Old behaviour copied ~1.3TB in total; this is ~90GB, spread over ~14
    // flushes minutes apart rather than one every ~10s.
    expect(t.copiedBytes).toBeLessThan(150 * 1024 ** 3);
  });

  it('still flushes small files every ~8MB', async () => {
    const t = fakeTrack();
    for (let i = 0; i < 4; i++) await fsaWriteChunk(t, { size: 5 * 1024 * 1024 });
    expect(t.flushes).toBeGreaterThanOrEqual(2);
  });
});
