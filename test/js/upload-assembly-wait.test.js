// The post-upload wait on server-side assembly (_awaitAssemblyAndVerify) and
// the progress meters around it.
//
// Found by scripts/soak-upload.mjs: the client polled /assembly-status 60 × 2s
// and then fell through to verify and a green '✓ Recordings ready' whether or
// not the server had finished — even a 3-minute two-person take took ~3
// minutes to assemble, so for a 45-60 minute show the banner was claiming
// success long before the files existed. A failed status poll was also
// silently treated as "keep going" right up to that same fall-through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobals, loadUploadModules, makeBlob, stubXhrUpload } from './harness.js';

loadUploadModules();

// Just enough DOM for the real _buildUploadBanner to render into, so tests
// can read back what the user would actually see.
function fakeElement(tag) {
  const classes = new Set();
  return {
    tagName: tag, textContent: '', title: '', style: {}, children: [],
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    set innerHTML(_v) { this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    querySelector(sel) { return findByClass(this, sel.replace(/^\./, '')); },
  };
}

function allText(el) {
  return [el.textContent, ...el.children.map(allText)].filter(Boolean).join(' | ');
}

function findByClass(el, cls) {
  if (el.classList?.contains(cls)) return el;
  for (const c of el.children || []) {
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

let banner;
let states;

beforeEach(() => {
  banner = fakeElement('div');
  installGlobals({
    IS_HOST: false,
    document: { getElementById: (id) => (id === 'upload-banner' ? banner : null), createElement: fakeElement },
  });
  states = [];
  const realShow = globalThis.showUploadBanner;
  globalThis.showUploadBanner = (state) => { states.push(state); realShow(state); };
  globalThis.showUploadBanner._real = realShow;
});

afterEach(() => {
  globalThis.showUploadBanner = globalThis.showUploadBanner._real;
  vi.useRealTimers();
});

// Server says "still assembling" until `doneAfterMs` has passed (never, if
// null). `failUntilMs` makes every poll before then throw, like a network
// blip or a proxy error page.
function stubAssemblyStatus({ doneAfterMs = null, failUntilMs = 0, status = {} } = {}) {
  const t0 = Date.now();
  const calls = { status: 0, verify: 0 };
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('verify-recordings')) {
      calls.verify++;
      return { ok: true, json: async () => ({ issues: [] }) };
    }
    calls.status++;
    const elapsed = Date.now() - t0;
    if (elapsed < failUntilMs) throw new Error('network error');
    const assembling = doneAfterMs == null || elapsed < doneAfterMs;
    return { ok: true, json: async () => ({ assembling, ...status }) };
  });
  return calls;
}

function track(promise) {
  const state = { settled: false, value: undefined };
  promise.then(v => { state.settled = true; state.value = v; });
  return state;
}

const MIN = 60 * 1000;

describe('_awaitAssemblyAndVerify', () => {
  it('keeps waiting past 2 minutes while the server is still assembling, and says the upload is safe to leave', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    stubAssemblyStatus({ doneAfterMs: 5 * MIN });

    const result = track(_awaitAssemblyAndVerify());

    await vi.advanceTimersByTimeAsync(2 * MIN + 30 * 1000);
    expect(result.settled).toBe(false); // used to give up and report done here
    expect(allText(banner)).toContain('Upload complete');
    expect(allText(banner)).toContain('Safe to close this tab');

    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(result.settled).toBe(true);
    expect(result.value).toBe(true);
  });

  it('never treats a failing status poll as "finished"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    stubAssemblyStatus({ doneAfterMs: 0, failUntilMs: 10 * MIN });

    const result = track(_awaitAssemblyAndVerify());

    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(result.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(result.value).toBe(true);
  });

  it('gives up after the server-side ffmpeg timeout without ever claiming it finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    globalThis.IS_HOST = true;
    const calls = stubAssemblyStatus({ doneAfterMs: null });

    const result = track(_awaitAssemblyAndVerify());
    await vi.advanceTimersByTimeAsync(4 * 60 * MIN + MIN);

    expect(result.value).toBe(false); // caller must not show 'done'
    expect(calls.verify).toBe(0);
    expect(states).not.toContain('verifying');
    expect(allText(banner)).toContain('still processing');
  });

  it('only runs verify (host) once assembly has actually finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    globalThis.IS_HOST = true;
    const calls = stubAssemblyStatus({ doneAfterMs: 4 * MIN });

    const result = track(_awaitAssemblyAndVerify());
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(calls.verify).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(result.value).toBe(true);
    expect(calls.verify).toBe(1);
    expect(states).toEqual(['assembling', 'verifying']);
  });

  it('renders the server-reported progress and the job in progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    stubAssemblyStatus({
      doneAfterMs: null,
      status: { progress: 0.43, jobs: [
        { participant: 'Alice', job: 'audio', stage: 'done', fraction: 1 },
        { participant: 'Alice', job: 'video', stage: 'converting', fraction: 0.43 },
      ] },
    });

    _awaitAssemblyAndVerify();
    await vi.advanceTimersByTimeAsync(3000);

    expect(allText(banner)).toContain('43%');
    expect(allText(banner)).toContain('Converting video — Alice');
    expect(findByClass(banner, 'upload-progress-fill').style.width).toBe('43%');
  });

  it('shows an indeterminate bar while the length is unknown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    stubAssemblyStatus({ doneAfterMs: null, status: { progress: null, jobs: [] } });

    _awaitAssemblyAndVerify();
    await vi.advanceTimersByTimeAsync(3000);

    expect(findByClass(banner, 'upload-progress-fill').classList.contains('indeterminate')).toBe(true);
  });
});

describe('byte-based upload progress', () => {
  it('knows the total bytes up front and counts each chunk once it lands', async () => {
    const epoch = 'bytes1';
    const sizes = [1000, 2500, 400];
    for (const [i, size] of sizes.entries()) {
      await idbPutChunk({
        sessionId: SESSION_ID, identity, participant: displayName, epoch,
        trackType: 'audio', chunkIndex: i, ext: 'raw', meta: {}, blob: makeBlob(size),
      });
    }
    let totalWhileUploading = null;
    stubXhrUpload(() => {
      totalWhileUploading ??= uploadStats.bytesTotal;
      return { ok: true, status: 200 };
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

    await _uploadAllRecordedChunks(epoch);

    expect(totalWhileUploading).toBe(3900); // known before the first chunk went
    expect(uploadStats.bytesDone).toBe(3900);
    expect(_uploadProgress().fraction).toBe(1);
    expect(_uploadProgress().label).toBe('Uploading 4 KB of 4 KB');
  });
});
