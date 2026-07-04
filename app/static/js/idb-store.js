// ── IndexedDB chunk persistence ──────────────────────────────────────────────
//
// Recording is local-only: every captured chunk is written here the moment
// it's produced, and nothing is sent to the server until the recording
// stops (see _uploadAllRecordedChunks in upload.js), which then reads every
// chunk back out and deletes it once the server ACKs the upload.
//
// recoverOrphanedChunks (upload.js) also reads this store on every join: it
// sweeps whatever's still left here — chunks from a run that never finished
// uploading because a crash/reload/closed tab happened before the post-stop
// upload pass completed — and resends them, making recordings resumable
// across a browser crash or full page reload.
//
// Every function here is best-effort and swallows its own errors — a failure
// to persist a chunk to IndexedDB must never crash recording itself, though
// with recording now local-only, a lost chunk here is a lost chunk (there's
// no in-memory fallback copy once the write-through call has been made).

const IDB_DB_NAME = 'podbooth-recordings';
const IDB_DB_VERSION = 1;
const IDB_STORE = 'chunks';

let _idbPromise = null;

function _idbAvailable() {
  return typeof indexedDB !== 'undefined';
}

function _openIdb() {
  if (!_idbAvailable()) return Promise.resolve(null);
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
    } catch (e) {
      console.warn('IndexedDB unavailable:', e);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('IndexedDB open failed:', req.error);
      resolve(null);
    };
    req.onblocked = () => {
      console.warn('IndexedDB open blocked (another tab holding an old version?)');
      resolve(null);
    };
  });
  return _idbPromise;
}

// Out-of-line composite key as a plain string, rather than an inline array
// keyPath — simpler to prefix-match for epoch cleanup (see idbDeleteEpoch).
function _chunkKey(sessionId, identity, epoch, trackType, chunkIndex) {
  return `${sessionId}::${identity}::${epoch}::${trackType}::${chunkIndex}`;
}

async function idbPutChunk({ sessionId, identity, participant, epoch, trackType, chunkIndex, ext, meta, blob }) {
  try {
    const db = await _openIdb();
    if (!db) return;
    const key = _chunkKey(sessionId, identity, epoch, trackType, chunkIndex);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({
        sessionId, identity, participant, epoch, trackType, chunkIndex, ext, meta, blob,
        size: blob.size, createdAt: Date.now(),
      }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    console.warn(`idbPutChunk failed for ${trackType}#${chunkIndex} (chunk stays upload-queue-only):`, e);
  }
}

async function idbDeleteChunk(sessionId, identity, epoch, trackType, chunkIndex) {
  try {
    const db = await _openIdb();
    if (!db) return;
    const key = _chunkKey(sessionId, identity, epoch, trackType, chunkIndex);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    console.warn(`idbDeleteChunk failed for ${trackType}#${chunkIndex}:`, e);
  }
}

// Read one chunk record back out, blob included — used by the post-stop
// upload pass (see _uploadAllRecordedChunks in upload.js) to fetch a chunk
// immediately before sending it, rather than holding every recorded blob in
// memory at once.
async function idbGetChunk(sessionId, identity, epoch, trackType, chunkIndex) {
  try {
    const db = await _openIdb();
    if (!db) return null;
    const key = _chunkKey(sessionId, identity, epoch, trackType, chunkIndex);
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn(`idbGetChunk failed for ${trackType}#${chunkIndex}:`, e);
    return null;
  }
}

// Sweep every chunk belonging to one recording run (matches by key prefix,
// since chunks are keyed by a composite string rather than an inline range-
// queryable key). Called once a run finishes uploading successfully, as a
// backstop for any individual idbDeleteChunk call that failed along the way.
async function idbDeleteEpoch(sessionId, identity, epoch) {
  try {
    const db = await _openIdb();
    if (!db) return;
    const prefix = `${sessionId}::${identity}::${epoch}::`;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          cursor.delete();
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    console.warn(`idbDeleteEpoch failed for epoch=${epoch}:`, e);
  }
}

// Read metadata for every chunk currently sitting in IndexedDB, across all
// sessions/identities/epochs — blobs excluded so scanning the whole store
// (recoverOrphanedChunks in upload.js, run on every join) never has to hold
// more than one blob in memory at a time. Callers fetch the blob for a
// specific chunk via idbGetChunk right before sending it.
async function idbGetAllChunks() {
  try {
    const db = await _openIdb();
    if (!db) return [];
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).openCursor();
      const out = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(out); return; }
        const { sessionId, identity, participant, epoch, trackType, chunkIndex, ext, size, createdAt } = cursor.value;
        out.push({ sessionId, identity, participant, epoch, trackType, chunkIndex, ext, size, createdAt });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('idbGetAllChunks failed:', e);
    return [];
  }
}

// Best-effort pre-flight check so a browser that's already nearly out of
// storage quota surfaces a warning before recording starts, rather than
// failing silently mid-write later.
async function idbCheckQuota() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    if (quota && usage / quota > 0.9) {
      return { usage, quota };
    }
  } catch (e) {
    // ignore — quota estimation is advisory only
  }
  return null;
}
