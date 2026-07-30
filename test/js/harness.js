// Loads the real, unmodified app/static/js/*.js files into the test's global
// scope, the same way the browser does via multiple <script> tags — these
// files are plain scripts (no modules, no bundler), so this is the only way
// to exercise their real logic instead of reimplementing it as a mock.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.resolve(__dirname, '../../app/static/js');

// Indirect eval (the `(0, eval)` form) runs in global scope rather than the
// caller's local scope — matching how separate <script> tags share one
// global lexical environment in the browser. `function` declarations become
// global bindings this way; re-loading a script later redefines them, which
// is how the XHR stub below overrides the real _xhrUploadChunk after
// upload.js has loaded.
function loadScript(name) {
  const code = fs.readFileSync(path.join(JS_DIR, name), 'utf8');
  (0, eval)(code);
}

class MemoryStorage {
  constructor() { this._data = new Map(); }
  getItem(k) { return this._data.has(k) ? this._data.get(k) : null; }
  setItem(k, v) { this._data.set(k, String(v)); }
  removeItem(k) { this._data.delete(k); }
  key(i) { return [...this._data.keys()][i] ?? null; }
  get length() { return this._data.size; }
}

// Studio.js (not loaded here — it destructures the LiveKit UMD global and
// touches the DOM at import time) is where recordingEpoch, chunkIndex,
// identity, etc. are actually declared in production. Tests stand in for it
// with plain globalThis properties instead, which upload.js/recording.js
// read as free variables exactly the same way.
export function installGlobals(overrides = {}) {
  const defaults = {
    SESSION_ID: 'sess-1',
    SESSION_TITLE: 'Test Session',
    identity: 'identity-1',
    displayName: 'Tester',
    IS_HOST: true,
    room: null,
    isRecording: false,
    recordingStarting: false,
    chunkIndex: { audio: 0, video: 0, screen: 0 },
    recordingEpoch: '',
    screenEpoch: null,
    screenGen: 0,
    screenEpochHistory: [],
    pendingFinalizeMeta: {},
    fsaDirHandle: null,
    fsaOpenPromises: {},
    fsaFailedTracks: {},
    fsaTakeNumberPromise: null,
    _persistQueues: { audio: Promise.resolve(), video: Promise.resolve(), screen: Promise.resolve() },
    uploadPending: false,
    uploadStats: { queued: 0, completed: 0 },
    uploadHasError: false,
    uploadCancelled: false,
    uploadAbortController: null,
    showToast: () => {},
    broadcastData: async () => {},
    handleFatalRecordingError: async () => {},
    // Defined in recording.js, which this harness doesn't load (it needs
    // MediaRecorder/DOM APIs this test environment doesn't provide) — upload.js
    // calls it directly throughout, so it needs its own stub here.
    recLog: () => {},
    localStorage: new MemoryStorage(),
    navigator: { locks: null }, // no Web Locks in this harness — single "tab" per test
    // showUploadBanner/refreshUploadBanner both no-op when the banner element
    // is missing, so a getElementById stub returning null is enough to let
    // real upload.js banner-update calls run harmlessly without a real DOM.
    document: { getElementById: () => null },
  };
  Object.assign(globalThis, defaults, overrides);
}

// Replaces the real XHR-based uploader with one driven by a fetch-shaped
// mock function `impl(url, form) => { ok, status }` so tests don't need a
// real XMLHttpRequest/FormData transport — everything else in upload.js
// (retry loop, throttling, recovery bookkeeping) still runs for real.
export function stubXhrUpload(impl) {
  globalThis._xhrUploadChunk = (form) => Promise.resolve(impl(form));
}

let loaded = false;

// idb-store.js + upload.js only — recording.js needs MediaRecorder/DOM APIs
// this harness doesn't provide, and isn't needed to exercise the
// upload/recovery logic these tests target.
export function loadUploadModules() {
  if (loaded) return; // function declarations are idempotent to re-eval, but skip the work
  loadScript('idb-store.js');
  loadScript('upload.js');
  loaded = true;
}

export function makeBlob(bytes = 1024) {
  return new Blob([new Uint8Array(bytes)]);
}
