// ── File System Access recording (opt-in, Chromium-only) ────────────────────
//
// Bifurcated with the IndexedDB pipeline in idb-store.js/upload.js: if the
// user granted a local folder on the prejoin screen (and the browser
// supports the API — no Firefox/Safari), each track is written straight to
// one real file in that folder as it's captured, instead of many chunk
// records in IndexedDB. At recording stop, that one file is uploaded whole
// (as chunk index 0, reusing the existing /api/upload/chunk + /finalize
// endpoints — see uploadFsaTrack in upload.js) rather than as many small
// chunk POSTs. Every function here is best-effort: any failure falls back
// to the caller treating FSA as unavailable for that track, so a participant
// who never opted in (or whose browser doesn't support it) is unaffected.

const FSA_DB_NAME = 'podbooth-fsa';
const FSA_DB_VERSION = 1;
const FSA_STORE = 'handles';
const FSA_DIR_KEY = 'recording-dir';

function fsaSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function _openFsaDb() {
  return new Promise((resolve) => {
    if (!fsaSupported()) { resolve(null); return; }
    let req;
    try {
      req = indexedDB.open(FSA_DB_NAME, FSA_DB_VERSION);
    } catch (e) {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FSA_STORE)) db.createObjectStore(FSA_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

// Prompts the user (must be called from a real click — prejoin's "Enable
// local recording" button) and persists the resulting directory handle so a
// later full page navigation (prejoin → studio is a real navigation, not a
// SPA transition) can pick it back up without needing another gesture.
async function fsaChooseDirectory() {
  if (!fsaSupported()) return false;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const db = await _openFsaDb();
    if (!db) return false;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FSA_STORE, 'readwrite');
      tx.objectStore(FSA_STORE).put(handle, FSA_DIR_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) {
    // User cancelled the picker, or the browser refused — either way, no
    // local-recording folder is available for this session.
    console.warn('fsaChooseDirectory: not enabled:', e);
    return false;
  }
}

// Re-acquires the folder handle chosen on prejoin. Chrome persists a
// same-origin directory grant across the navigation from prejoin to studio,
// so queryPermission (unlike requestPermission) can succeed here without a
// fresh user gesture — but if it can't, this returns null and the caller
// silently falls back to IndexedDB for this participant.
async function fsaGetDirectory() {
  if (!fsaSupported()) return null;
  try {
    const db = await _openFsaDb();
    if (!db) return null;
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(FSA_STORE, 'readonly');
      const req = tx.objectStore(FSA_STORE).get(FSA_DIR_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!handle) return null;
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      console.warn('fsaGetDirectory: permission not granted (%s) — falling back to IndexedDB', perm);
      return null;
    }
    return handle;
  } catch (e) {
    console.warn('fsaGetDirectory failed:', e);
    return null;
  }
}

// Opens one real file for a track and returns a handle wrapper. `write()`
// appends sequentially at the stream's current position, so calling this
// once per track and writing each captured chunk to it as it arrives is
// exactly equivalent to what the old per-chunk IndexedDB writes did — just
// landing in one continuous file instead of many keyed records.
// Purely cosmetic: names the local file sitting in the user's own folder.
// It happens to look like the server's own _display_slug()
// (app/routers/upload.py), but the two aren't required to match — the server
// never reads this filename back, it derives the final assembled output name
// from its own participant string at assembly time. Don't chase parity if one
// side's rules change.
function fsaSlug(name) {
  return (name || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'participant';
}

// A FileSystemWritableFileStream buffers everything written to it in a swap
// file and only persists to the real on-disk file when close() is called —
// per spec, a crash or killed tab before that close() discards the buffer
// entirely, which would make "local recording" lose the whole take on the
// exact failure mode it exists to survive. To bound that loss, the track is
// flushed periodically: close the current writable (which commits the swap
// file to disk), then immediately reopen with keepExistingData so the next
// write continues right where the last one left off. Worst case data loss
// after a crash is capped at one flush interval's worth of chunks instead of
// the entire recording.
const FSA_FLUSH_THRESHOLD_BYTES = 8 * 1024 * 1024;

// The 'raw' audio track is headerless interleaved 32-bit-float PCM (see
// flushPcm in recording.js — always 2ch/48kHz). That's fine for the server,
// which wraps it in a real WAV at assembly time, but a local FSA file never
// goes through that step, so without a header of its own it's an unplayable
// blob of samples on the user's disk. Give it a real WAV container locally:
// reserve a 44-byte placeholder header up front, then patch the size fields
// in on close once the final byte count is known.
const FSA_WAV_SAMPLE_RATE = 48000;
const FSA_WAV_CHANNELS = 2;
const FSA_WAV_BITS_PER_SAMPLE = 32; // IEEE float

function _fsaWavHeader(dataBytes) {
  const blockAlign = FSA_WAV_CHANNELS * (FSA_WAV_BITS_PER_SAMPLE / 8);
  const byteRate = FSA_WAV_SAMPLE_RATE * blockAlign;
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // 3 = IEEE float
  view.setUint16(22, FSA_WAV_CHANNELS, true);
  view.setUint32(24, FSA_WAV_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, FSA_WAV_BITS_PER_SAMPLE, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  return buf;
}

async function fsaOpenTrackFile(dirHandle, trackType, epoch, ext, participant) {
  const isRawAudio = trackType === 'audio' && ext === 'raw';
  const fileExt = isRawAudio ? 'wav' : ext;
  const name = `${fsaSlug(participant)}_${trackType}_${epoch}.${fileExt}`;
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  const track = { fileHandle, writable, bytesWritten: 0, flushedBytes: 0, chunksWritten: 0, closed: false, isRawAudio, dataBytes: 0 };
  if (isRawAudio) {
    // Placeholder header — sizes get patched to their real values on close.
    await writable.write(_fsaWavHeader(0));
    track.bytesWritten = 44;
    track.flushedBytes = 44;
  }
  return track;
}

async function fsaWriteChunk(track, blob) {
  await track.writable.write(blob);
  track.bytesWritten += blob.size;
  if (track.isRawAudio) track.dataBytes += blob.size;
  // Count only chunks that actually landed in the file (incremented after the
  // write resolves). If a later write fails and the track fails over to
  // IndexedDB, this is exactly how many original chunk indices the salvaged
  // file already holds — the upload path passes it to the server as
  // subsumes_chunks so the gap check doesn't flag the folded indices missing.
  track.chunksWritten += 1;
  if (track.bytesWritten - track.flushedBytes >= FSA_FLUSH_THRESHOLD_BYTES) {
    await fsaFlushTrackFile(track);
  }
}

// Commits everything written so far to the real on-disk file without ending
// the track — the writable is closed (which is what actually persists the
// swap file) and immediately replaced with a fresh one continuing from the
// same offset, so callers can keep writing as if nothing happened.
async function fsaFlushTrackFile(track) {
  await track.writable.close();
  track.writable = await track.fileHandle.createWritable({ keepExistingData: true });
  await track.writable.seek(track.bytesWritten);
  track.flushedBytes = track.bytesWritten;
}

async function fsaCloseTrackFile(track) {
  // Guards against a second close() on the same track (e.g. a redundant
  // post-stop upload pass) — closing an already-closed writable throws and
  // would otherwise abort the whole upload batch for no reason, since the
  // file itself is already finished and safe to re-read.
  if (!track.closed) {
    if (track.isRawAudio) {
      // Patch the placeholder header's size fields now that the final byte
      // count is known, so the file left on disk is a self-contained,
      // playable WAV rather than headerless raw samples.
      await track.writable.close();
      track.writable = await track.fileHandle.createWritable({ keepExistingData: true });
      await track.writable.seek(0);
      await track.writable.write(_fsaWavHeader(track.dataBytes));
    }
    await track.writable.close();
    track.closed = true;
  }
  return track.fileHandle.getFile();
}
