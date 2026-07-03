// ── IndexedDB chunk persistence (phase 1: write-through, no behavior change) ──
//
// Every captured chunk is written here the moment it's produced, in addition
// to (not instead of) the existing in-memory upload queue in upload.js. Once
// the queue confirms the server has a chunk, its IndexedDB copy is deleted.
//
// This phase intentionally changes nothing about upload behavior — its only
// job is to validate storage/quota/schema in production. Phase 2 (a future
// change) will make the uploader itself read from IndexedDB instead of
// in-memory closures, which is what actually makes recordings resumable
// across a browser crash or full page reload: the durable copy this phase
// writes will already be there waiting.
//
// Every function here is best-effort and swallows its own errors — a failure
// to persist a chunk to IndexedDB must never affect recording or upload,
// since the in-memory queue remains the source of truth in this phase.

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

async function idbPutChunk({ sessionId, identity, epoch, trackType, chunkIndex, ext, meta, blob }) {
  try {
    const db = await _openIdb();
    if (!db) return;
    const key = _chunkKey(sessionId, identity, epoch, trackType, chunkIndex);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({
        sessionId, identity, epoch, trackType, chunkIndex, ext, meta, blob,
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
