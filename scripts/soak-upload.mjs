#!/usr/bin/env node
// Upload soak test: simulates a long (default 60 min) recording's
// post-stop upload against a REAL PodBooth instance, in minutes instead of
// an hour, to reproduce slow/failing uploads that a 5-minute manual test
// never hits.
//
// What's real: app/static/js/upload.js and idb-store.js run unmodified (same
// load-into-global-scope approach as test/js/harness.js, but via
// vm.runInThisContext so their top-level let/const are shared exactly like
// <script> tags), talking over real HTTP to your server, its reverse proxy,
// and its ffmpeg assembly. Chunk counts and sizes match what recording.js
// produces: raw f32le 48kHz stereo PCM audio flushed every 5s (~1.9MB) and a
// 12 Mbps VP8 webm sliced into 5s pieces (~7.5MB) the way MediaRecorder's
// 5000ms timeslice does.
//
// What's simulated: the capture itself (no MediaRecorder/mic/camera), and
// the transport — Node has no XMLHttpRequest, so _xhrUploadChunk is swapped
// for a fetch-based one. Upload progress events don't exist there, so a
// stall is detected by the hard cap only, not the 20s no-progress timer;
// --stall-rate injects stalls that end on that same 20s timeout instead.
//
// Usage:
//   node scripts/soak-upload.mjs --url https://podbooth.example --api-key KEY \
//     [--password HOST_PASSWORD] [--minutes 60] [--guests 1] [--no-video] \
//     [--video-mbps 12] [--speed unlimited|normal|low] \
//     [--fail-rate 0.02] [--stall-rate 0.01] [--out soak-results] [--no-direct-cloud]
//
// Direct-to-cloud: by default participants try the same direct-to-bucket
// upload a browser would (falling back to the server if the instance hasn't
// enabled it with DIRECT_CLOUD_UPLOAD=true and a bucket); --no-direct-cloud
// forces the upload-through-the-server path. Node doesn't enforce CORS, so this can't check the bucket's CORS
// rule — one real browser recording still needs to confirm that.
//
// --url/--api-key/--password can also come from SOAK_URL, SOAK_API_KEY and
// SOAK_PASSWORD, to keep them out of shell history.
//
// Each participant runs in its own child process (upload.js keeps
// per-participant state in globals). Results: a per-chunk timeline
// (<out>/<participant>.jsonl), per-participant summaries, and a final report
// covering server-side assembly time and verify-recordings issues.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..');
const JS_DIR = path.join(REPO, 'app/static/js');

const CHUNK_SECONDS = 5;          // recording.js: MediaRecorder.start(5000), PCM flush at sampleRate*5
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const PCM_CHUNK_BYTES = SAMPLE_RATE * CHUNK_SECONDS * CHANNELS * 4;

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    url: process.env.SOAK_URL || '', apiKey: process.env.SOAK_API_KEY || '',
    password: process.env.SOAK_PASSWORD || '', minutes: 60, guests: 1, video: true, videoMbps: 12,
    speed: 'unlimited', failRate: 0, stallRate: 0, out: 'soak-results', child: '',
    assemblyTimeoutMin: 60, cleanup: false, directCloud: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': args.url = next().replace(/\/+$/, ''); break;
      case '--api-key': args.apiKey = next(); break;
      case '--password': args.password = next(); break;
      case '--minutes': args.minutes = Number(next()); break;
      case '--guests': args.guests = Number(next()); break;
      case '--no-video': args.video = false; break;
      case '--video-mbps': args.videoMbps = Number(next()); break;
      case '--speed': args.speed = next(); break;
      case '--fail-rate': args.failRate = Number(next()); break;
      case '--stall-rate': args.stallRate = Number(next()); break;
      case '--out': args.out = next(); break;
      case '--assembly-timeout-min': args.assemblyTimeoutMin = Number(next()); break;
      case '--cleanup': args.cleanup = true; break;
      case '--no-direct-cloud': args.directCloud = false; break;
      case '--child': args.child = next(); break; // internal: JSON participant spec
      case '-h': case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').split('\nimport ')[0].trim());
        process.exit(0);
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(2);
    }
  }
  return args;
}

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fmtMB = (b) => `${(b / (1024 * 1024)).toFixed(1)} MB`;
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

// ── HTTP helpers (orchestrator) ──────────────────────────────────────────────

async function api(base, method, pathname, { json, headers = {}, cookie = '' } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  if (cookie) init.headers.Cookie = cookie;
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const r = await fetch(base + pathname, init);
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  if (r.status >= 400) throw new Error(`${method} ${pathname} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  return { status: r.status, body, headers: r.headers };
}

function cookiesFrom(headers) {
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') || '').split(/,(?=\s*\w+=)/);
  return raw.filter(Boolean).map(c => c.split(';')[0].trim());
}

// login.py's double-submit CSRF: GET /login sets podbooth_csrf, which must be
// echoed back as the csrf_token form field.
async function hostLogin(base, password) {
  if (!password) return '';
  const page = await fetch(`${base}/login`, { redirect: 'manual' });
  const csrfCookie = cookiesFrom(page.headers).find(c => c.startsWith('podbooth_csrf='));
  if (!csrfCookie) throw new Error('Login page did not set a CSRF cookie');
  const csrf = csrfCookie.split('=')[1];
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: csrfCookie },
    body: new URLSearchParams({ password, next: '/', csrf_token: csrf }),
  });
  const host = cookiesFrom(r.headers).find(c => c.startsWith('podbooth_host='));
  if (!host) throw new Error(`Host login failed (HTTP ${r.status}) — check --password`);
  return host;
}

// ── Test media ───────────────────────────────────────────────────────────────

// A webm long enough for the whole take at roughly the recorder's bitrate.
// Encodes 60s once (noise keeps VP8 from compressing far below the target
// bitrate, which a static test pattern would), then loops it by stream copy
// — fast, and the output is one continuous webm with monotonic timestamps,
// so byte-slicing it reproduces what MediaRecorder's timeslice chunks are.
function ensureVideo(minutes, mbps) {
  const cacheDir = path.join(os.homedir(), '.cache', 'podbooth-soak');
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `video-${minutes}m-${mbps}mbps.webm`);
  if (fs.existsSync(out)) return out;

  const needBytes = (mbps * 1e6 / 8) * minutes * 60 * 1.2;
  const free = fs.statfsSync ? (() => { const s = fs.statfsSync(cacheDir); return s.bavail * s.bsize; })() : Infinity;
  if (free < needBytes) {
    throw new Error(`Need ~${fmtMB(needBytes)} free in ${cacheDir} for the test video, have ${fmtMB(free)}. ` +
      `Use --video-mbps lower, fewer --minutes, or --no-video.`);
  }
  const seg = path.join(cacheDir, `seg-60s-${mbps}mbps.webm`);
  if (!fs.existsSync(seg)) {
    log(`Encoding 60s ${mbps} Mbps test clip (one-time)…`);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30,noise=alls=25:allf=t',
      '-t', '60', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8',
      '-b:v', `${mbps}M`, '-minrate', `${mbps}M`, '-maxrate', `${mbps}M`, '-bufsize', `${mbps}M`,
      '-g', '150', '-an', seg,
    ], { stdio: 'inherit' });
  }
  const list = path.join(cacheDir, `loop-${minutes}.txt`);
  fs.writeFileSync(list, Array.from({ length: Math.ceil(minutes) }, () => `file '${seg}'`).join('\n'));
  log(`Building ${minutes}-minute test video by looping (stream copy)…`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-t', String(minutes * 60), '-c', 'copy', out], { stdio: 'inherit' });
  fs.unlinkSync(list);
  return out;
}

// 5s of a quiet 220Hz tone, interleaved stereo f32le — what flushPcm sends.
// Generated per chunk on demand, so a 60-minute take never sits in memory.
function pcmChunk() {
  const frames = SAMPLE_RATE * CHUNK_SECONDS;
  const buf = new Float32Array(frames * CHANNELS);
  for (let i = 0; i < frames; i++) {
    const v = 0.1 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
    buf[i * 2] = v;
    buf[i * 2 + 1] = v;
  }
  return buf;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

async function orchestrate(args) {
  if (!args.url || !args.apiKey) {
    console.error('--url and --api-key are required (see --help)');
    process.exit(2);
  }
  const outDir = path.resolve(args.out, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });

  const videoPath = args.video ? ensureVideo(args.minutes, args.videoMbps) : null;
  const perParticipant = PCM_CHUNK_BYTES * Math.ceil(args.minutes * 60 / CHUNK_SECONDS) +
    (videoPath ? fs.statSync(videoPath).size : 0);
  log(`Each participant uploads ~${fmtMB(perParticipant)} (${args.minutes} min, ${1 + args.guests} participants, ` +
    `~${fmtMB(perParticipant * (1 + args.guests))} total)`);

  const hostCookie = await hostLogin(args.url, args.password);
  const title = `Soak ${args.minutes}m ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const { body: created } = await api(args.url, 'POST', '/api/session', {
    json: { title }, headers: { 'X-API-Key': args.apiKey },
  });
  const sessionId = created.id;
  const hostToken = created.host_token;
  log(`Session ${sessionId} "${title}"`);

  const participants = [];
  const host = { identity: `soak-host-${Date.now().toString(36)}`, displayName: 'Soak Host', isHost: true };
  await api(args.url, 'POST', '/api/token', {
    json: { session_id: sessionId, identity: host.identity, display_name: host.displayName, host_token: hostToken },
  });
  participants.push(host);
  for (let g = 1; g <= args.guests; g++) {
    const guest = { identity: `soak-guest${g}-${Date.now().toString(36)}`, displayName: `Soak Guest ${g}`, isHost: false };
    await api(args.url, 'POST', `/api/session/${sessionId}/request-join`, {
      json: { identity: guest.identity, display_name: guest.displayName },
    });
    await api(args.url, 'POST', `/api/session/${sessionId}/admit/${guest.identity}`, {
      json: { host_token: hostToken }, headers: { 'X-Host-Token': hostToken },
    });
    await api(args.url, 'POST', '/api/token', {
      json: { session_id: sessionId, identity: guest.identity, display_name: guest.displayName },
    });
    participants.push(guest);
  }

  // Same server-side recording start/stop the host's buttons send. The
  // "recording" happens instantly; the upload pass is what's under test.
  // Clients and the server log both get these timestamps for correlating.
  await api(args.url, 'POST', `/api/session/${sessionId}/recording`, { json: { host_token: hostToken, action: 'start' } });
  await api(args.url, 'POST', `/api/session/${sessionId}/recording`, { json: { host_token: hostToken, action: 'stop' } });

  log(`Stop pressed — ${participants.length} participant(s) uploading…`);
  const t0 = Date.now();
  const results = await Promise.all(participants.map(p => runChild(args, {
    ...p, sessionId, sessionTitle: title, hostToken: p.isHost ? hostToken : '',
    hostCookie: p.isHost ? hostCookie : '', videoPath, outDir,
  })));
  const uploadMs = Date.now() - t0;

  // The client only waits ~2 minutes for assembly before moving on (see
  // _awaitAssemblyAndVerify); keep watching to see how long it really takes.
  log('All participants finished their upload pass — watching server-side assembly…');
  const asmStart = Date.now();
  let assemblyMs = null;
  while (Date.now() - asmStart < args.assemblyTimeoutMin * 60_000) {
    try {
      const { body } = await api(args.url, 'GET', `/api/session/${sessionId}/assembly-status`);
      if (!body.assembling) { assemblyMs = Date.now() - asmStart; break; }
    } catch (e) { log(`assembly-status poll failed: ${e.message}`); }
    await new Promise(r => setTimeout(r, 5000));
  }

  let issues = null;
  let recordings = null;
  try {
    issues = (await api(args.url, 'GET', `/api/session/${sessionId}/verify-recordings`, { cookie: hostCookie })).body.issues;
    recordings = (await api(args.url, 'GET', `/api/session/${sessionId}/recordings`, { cookie: hostCookie })).body;
  } catch (e) {
    log(`verify/recordings check failed (pass --password if the instance has one): ${e.message}`);
  }

  const report = { sessionId, title, args: { ...args, apiKey: '***', password: args.password ? '***' : '' },
    uploadMs, assemblyMs, participants: results, verifyIssues: issues, recordings };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n══════════════ Soak report ══════════════');
  console.log(`Session:   ${args.url}/studio/${sessionId}  (${title})`);
  console.log(`Upload:    ${fmtDur(uploadMs)} wall clock for all participants`);
  for (const r of results) {
    if (!r) continue;
    console.log(`  ${r.displayName.padEnd(14)} final banner: ${String(r.finalBanner).padEnd(10)} ` +
      `${fmtMB(r.bytesUploaded)} in ${fmtDur(r.uploadMs)} (${fmtMB(r.bytesUploaded / Math.max(1, r.uploadMs / 1000))}/s), ` +
      `via ${r.cloudParts && r.serverChunks ? `cloud (${r.cloudParts} parts) + server (${r.serverChunks} chunks, fallback)` : r.cloudParts ? `cloud (${r.cloudParts} parts)` : `server (${r.serverChunks} chunks)`}, ` +
      `${r.retries} retried attempts, ${r.failedAttempts} failed attempts` +
      (r.lostChunks.length ? `, LOST: ${r.lostChunks.join(' ')}` : '') +
      (r.uploadHasError ? ', uploadHasError=true' : ''));
    if (r.clientAssemblyWaitMs != null) {
      console.log(`  ${''.padEnd(14)} client waited ${fmtDur(r.clientAssemblyWaitMs)} for assembly, whole Stop→final banner ${fmtDur(r.uploadPassMs)}`);
    }
  }
  console.log(`Assembly:  ${assemblyMs == null ? `STILL RUNNING after ${args.assemblyTimeoutMin} min` : fmtDur(assemblyMs)} after every client finished`);
  // Clients only finish once they've stopped waiting on assembly, so the
  // server should already be done (or nearly) by then. Still assembling
  // well after means a client showed its final banner — possibly
  // '✓ Recordings ready' — before the files existed.
  if (assemblyMs == null || assemblyMs > 10_000) {
    const claimedDone = results.filter(r => r && r.finalBanner === 'done').map(r => r.displayName);
    console.log(`  ⚠ server was still assembling after the clients finished` +
      (claimedDone.length ? ` — ${claimedDone.join(', ')} showed "done" early` : ''));
  }
  if (issues) {
    console.log(`Verify:    ${issues.length ? `${issues.length} issue(s)` : 'no issues'}`);
    for (const i of issues) console.log(`  - ${i.participant}/${i.file}: ${i.issue}`);
  }
  console.log(`Details:   ${outDir}`);

  if (args.cleanup) {
    try {
      await api(args.url, 'POST', `/api/session/${sessionId}/delete`, { json: { host_token: hostToken }, cookie: hostCookie });
      log('Session deleted (--cleanup)');
    } catch (e) { log(`Cleanup failed: ${e.message}`); }
  }
}

function runChild(args, spec) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', __filename, ...process.argv.slice(2), '--child', JSON.stringify(spec)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const prefix = `[${spec.displayName}]`;
    const pipe = (stream, sink) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          sink(`${prefix} ${buf.slice(0, nl)}`);
          buf = buf.slice(nl + 1);
        }
      });
    };
    pipe(child.stdout, console.log);
    pipe(child.stderr, console.error);
    child.on('exit', (code) => {
      const summaryPath = path.join(spec.outDir, `${spec.identity}.summary.json`);
      if (code !== 0 || !fs.existsSync(summaryPath)) {
        console.error(`${prefix} exited with code ${code} and no summary`);
        resolve(null);
        return;
      }
      resolve(JSON.parse(fs.readFileSync(summaryPath, 'utf8')));
    });
  });
}

// ── Participant (child process) ──────────────────────────────────────────────

class MemoryStorage {
  constructor() { this._data = new Map(); }
  getItem(k) { return this._data.has(k) ? this._data.get(k) : null; }
  setItem(k, v) { this._data.set(k, String(v)); }
  removeItem(k) { this._data.delete(k); }
  key(i) { return [...this._data.keys()][i] ?? null; }
  get length() { return this._data.size; }
}

async function participant(args, spec) {
  await import('fake-indexeddb/auto');
  const timeline = fs.createWriteStream(path.join(spec.outDir, `${spec.identity}.jsonl`));
  const event = (obj) => timeline.write(JSON.stringify({ t: Date.now(), ...obj }) + '\n');
  const plog = (...a) => log(...a);

  // Browser globals upload.js touches, plus a stand-in for the state
  // studio.js declares (as top-level `let`s, so they share the global lexical
  // scope with upload.js exactly like separate <script> tags).
  const storage = new MemoryStorage();
  storage.setItem('podbooth:upload-speed', args.speed);
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  globalThis.document = { getElementById: () => null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.recLog = (fmt, ...rest) => {
    let i = 0;
    const msg = String(fmt).replace(/%[sdoif]/g, () => {
      const v = rest[i++];
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
    event({ type: 'recLog', msg });
  };
  globalThis.showToast = (msg) => plog(`toast: ${msg}`);
  globalThis.handleFatalRecordingError = (t, e) => plog(`FATAL ${t}: ${e}`);
  globalThis.showUploadWarnings = (issues) => {
    event({ type: 'banner', state: 'warnings', issues });
  };

  vm.runInThisContext(`
    let SESSION_ID = ${JSON.stringify(spec.sessionId)};
    let SESSION_TITLE = ${JSON.stringify(spec.sessionTitle)};
    let IS_HOST = ${spec.isHost};
    let HOST_TOKEN = ${JSON.stringify(spec.hostToken)};
    let identity = ${JSON.stringify(spec.identity)};
    let displayName = ${JSON.stringify(spec.displayName)};
    let isRecording = false;
    let chunkIndex = { audio: 0, video: 0, screen: 0 };
    let recordingEpoch = '';
    let screenEpochHistory = [];
    let pendingFinalizeMeta = {};
    let fsaDirHandle = null;
    let fsaOpenPromises = {};
    let fsaTakeNumberPromise = null;
    let fsaFailedTracks = {};
    let DIRECT_CLOUD_UPLOAD = ${args.directCloud};
    let _pendingLocalUploads = [];
    let _localUploadRun = null;
    let onLocalUploadsDrained = null;
    let _persistQueues = { audio: Promise.resolve(), video: Promise.resolve(), screen: Promise.resolve() };
    let uploadPending = false;
    let uploadStats = { queued: 0, completed: 0 };
    let uploadHasError = false;
  `, { filename: 'studio-state.js' });
  for (const name of ['idb-store.js', 'upload.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(JS_DIR, name), 'utf8'), { filename: name });
  }
  const g = (expr) => vm.runInThisContext(expr);

  // Relative URLs upload.js fetches ('/api/...') go to the instance; the host
  // carries its login cookie so verify-recordings works like in a browser.
  // keepalive is dropped: it's a tab-close concern that Node's fetch doesn't
  // need (and older undici rejects on bodies over 64KB anyway).
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    const relative = typeof url === 'string' && url.startsWith('/');
    const full = relative ? args.url + url : url;
    const { keepalive, ...rest } = init;
    const headers = { ...(rest.headers || {}) };
    if (spec.hostCookie && relative) headers.Cookie = spec.hostCookie;
    const res = realFetch(full, { ...rest, headers });
    if (typeof url === 'string' && url.includes('/assembly-status')) {
      // Mirror the processing meter the user would see, at most every 30s.
      res.then(r => r.clone().json()).then((body) => {
        if (Date.now() - lastAssemblyLog < 30_000) return;
        lastAssemblyLog = Date.now();
        const pct = typeof body.progress === 'number' ? `${Math.round(body.progress * 100)}%` : '…';
        plog(`server processing ${pct} ${_assemblyJobLabel(body.jobs || [])}`);
      }).catch(() => {});
    }
    return res;
  };
  let lastAssemblyLog = 0;

  // ── Transport: fetch-based stand-in for _xhrUploadChunk ───────────────────
  const STALL_MS = g('UPLOAD_STALL_TIMEOUT_MS');
  const HARD_CAP_MS = g('UPLOAD_STALL_HARD_CAP_MS');
  const stats = { attempts: 0, failedAttempts: 0, bytesUploaded: 0, perChunk: new Map(), cloudParts: 0, serverChunks: 0 };
  const attemptsFor = (key) => stats.perChunk.get(key) || 0;

  // One upload attempt over fetch, with the same fault injection and
  // per-attempt timeline for server chunks and direct-to-bucket parts.
  const attempt = async (kind, key, size, cancelSignal, send) => {
    const n = attemptsFor(key) + 1;
    stats.perChunk.set(key, n);
    stats.attempts++;
    const started = Date.now();
    const abort = new AbortController();
    const onCancel = () => abort.abort();
    cancelSignal?.addEventListener('abort', onCancel);
    const hardCap = setTimeout(() => abort.abort(), HARD_CAP_MS);
    const record = (outcome, extra = {}) => event({ type: kind, key, attempt: n, size, ms: Date.now() - started, outcome, ...extra });
    try {
      if (Math.random() < args.stallRate) {
        // A connection that stops making progress: the real XHR's stall
        // timer aborts it after UPLOAD_STALL_TIMEOUT_MS of no progress events.
        await new Promise((res) => { const t = setTimeout(res, STALL_MS); abort.signal.addEventListener('abort', () => { clearTimeout(t); res(); }); });
        throw new DOMException('aborted', 'AbortError');
      }
      if (Math.random() < args.failRate) throw new Error('network error (injected)');
      const r = await send(abort.signal);
      const body = r.ok ? '' : (await r.text()).slice(0, 200);
      if (r.ok) {
        stats.bytesUploaded += size;
        stats[kind === 'part' ? 'cloudParts' : 'serverChunks']++;
        _recordUploadBytes(size);
      } else {
        stats.failedAttempts++;
      }
      record(r.ok ? 'ok' : 'http_error', { status: r.status, body });
      return { ok: r.ok, status: r.status };
    } catch (e) {
      stats.failedAttempts++;
      record(e.name === 'AbortError' ? 'aborted' : 'error', { error: String(e.message || e) });
      throw e.name === 'AbortError' ? new DOMException('aborted', 'AbortError') : new Error('network error');
    } finally {
      clearTimeout(hardCap);
      cancelSignal?.removeEventListener('abort', onCancel);
    }
  };

  globalThis._xhrUploadChunk = (form, cancelSignal) => attempt(
    'chunk', `${form.get('track_type')}#${form.get('chunk_index')}`, form.get('file')?.size ?? 0, cancelSignal,
    (signal) => realFetch(`${args.url}/api/upload/chunk`, { method: 'POST', body: form, signal }),
  );
  globalThis._xhrPutPart = (url, blob, cancelSignal) => attempt(
    'part', `part#${new URL(url).searchParams.get('partNumber')}@${new URL(url).pathname.split('/').pop()}`, blob.size, cancelSignal,
    (signal) => realFetch(url, { method: 'PUT', body: blob, signal, duplex: 'half' }),
  );

  // Banner state transitions, timestamped — this is what the user would see.
  const banners = [];
  const realShow = globalThis.showUploadBanner;
  globalThis.showUploadBanner = (state) => {
    banners.push({ t: Date.now(), state });
    event({ type: 'banner', state, completed: g('uploadStats').completed, queued: g('uploadStats').queued });
    plog(`banner → ${state} (${g('uploadStats').completed}/${g('uploadStats').queued})`);
    realShow(state);
  };
  for (const level of ['warn', 'error']) {
    const orig = console[level];
    console[level] = (...a) => {
      event({ type: `console.${level}`, msg: a.map(String).join(' ') });
      if (level === 'error') orig(...a);
    };
  }

  // ── Fill IndexedDB the way capture would, without holding GBs in memory ──
  // Chunks are stored as empty placeholder blobs through the real
  // enqueueChunk → _persistChunk → idbPutChunk path; idbGetChunk is wrapped
  // to materialize the real bytes only when the uploader reads a chunk.
  const epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  g(`recordingEpoch = ${JSON.stringify(epoch)}`);
  const startTimeMs = 1000;
  const audioChunks = Math.ceil(args.minutes * 60 / CHUNK_SECONDS);
  const pcm = Buffer.from(pcmChunk().buffer);
  const videoSlices = [];
  let videoFd = null;
  let videoDurationS = 0;
  if (spec.videoPath) {
    const size = fs.statSync(spec.videoPath).size;
    const sliceBytes = Math.round(args.videoMbps * 1e6 / 8 * CHUNK_SECONDS);
    for (let off = 0; off < size; off += sliceBytes) videoSlices.push([off, Math.min(size, off + sliceBytes)]);
    videoFd = fs.openSync(spec.videoPath, 'r');
    videoDurationS = args.minutes * 60;
  }

  const empty = new Blob([]);
  for (let i = 0; i < audioChunks; i++) {
    enqueueChunk(empty, 'audio', 'raw', { chunk_offset_s: i * CHUNK_SECONDS, start_time_ms: startTimeMs });
  }
  for (let i = 0; i < videoSlices.length; i++) {
    enqueueChunk(empty, 'video', 'webm', { start_time_ms: startTimeMs });
  }
  finalizeTrack('audio', {
    format: 'pcm', sample_rate: SAMPLE_RATE, channels: CHANNELS,
    start_time_ms: startTimeMs, expected_duration_s: audioChunks * CHUNK_SECONDS,
  });
  if (videoSlices.length) {
    finalizeTrack('video', {
      format: 'container', start_time_ms: startTimeMs, has_audio_sync: false, expected_duration_s: videoDurationS,
    });
  }
  await Promise.all(Object.values(g('_persistQueues')));

  // The placeholders are stored with size 0; report each chunk's real size
  // so upload.js's byte-based progress (bytesTotal) matches a real browser.
  const realGetAll = globalThis.idbGetAllChunks;
  globalThis.idbGetAllChunks = async (...a) => (await realGetAll(...a)).map((c) => {
    if (c.identity !== spec.identity) return c;
    if (c.trackType === 'audio') return { ...c, size: pcm.length };
    if (c.trackType === 'video' && videoSlices[c.chunkIndex]) {
      const [start, end] = videoSlices[c.chunkIndex];
      return { ...c, size: end - start };
    }
    return c;
  });

  const realGet = globalThis.idbGetChunk;
  globalThis.idbGetChunk = async (...a) => {
    const rec = await realGet(...a);
    if (!rec) return rec;
    if (rec.trackType === 'audio') {
      rec.blob = new Blob([pcm]);
    } else if (rec.trackType === 'video') {
      const [start, end] = videoSlices[rec.chunkIndex];
      const buf = Buffer.alloc(end - start);
      fs.readSync(videoFd, buf, 0, buf.length, start);
      rec.blob = new Blob([buf]);
    }
    return rec;
  };

  const totalChunks = audioChunks + videoSlices.length;
  plog(`${audioChunks} audio + ${videoSlices.length} video chunks queued (speed=${args.speed}, ` +
    `fail-rate=${args.failRate}, stall-rate=${args.stallRate}) — pressing Stop`);

  // ── Stop → the real post-stop pass ────────────────────────────────────────
  const progress = setInterval(() => {
    const s = g('uploadStats');
    const p = _uploadProgress();
    plog(`${p.label} (${s.completed}/${s.queued} chunks) · ${_uploadSpeedText(p.remaining) || '—'} · ` +
      `${stats.failedAttempts} failed attempts`);
  }, 30_000);
  const passStart = Date.now();
  await waitForUploads();
  clearInterval(progress);
  const uploadPassMs = Date.now() - passStart;

  const finalBanner = banners.at(-1)?.state ?? null;
  // The upload itself ends when the banner first leaves 'uploading' (to
  // assembling/local/error/cancelled) — everything after is waiting on the
  // server, so it mustn't count toward upload throughput.
  const uploadEndAt = banners.find(b => b.state !== 'uploading')?.t ?? Date.now();
  const uploadMs = uploadEndAt - passStart;
  const assemblingAt = banners.find(b => b.state === 'assembling')?.t;
  const afterAssembling = banners.find(b => assemblingAt && b.t > assemblingAt && b.state !== 'assembling')?.t;
  const retries = [...stats.perChunk.values()].reduce((n, a) => n + Math.max(0, a - 1), 0);
  const lost = (await idbGetAllChunks())
    .filter(c => c.sessionId === spec.sessionId && c.identity === spec.identity)
    .map(c => `${c.trackType}#${c.chunkIndex}`);

  const summary = {
    displayName: spec.displayName, identity: spec.identity, epoch, chunks: totalChunks,
    bytesUploaded: stats.bytesUploaded, attempts: stats.attempts, retries, failedAttempts: stats.failedAttempts,
    cloudParts: stats.cloudParts, serverChunks: stats.serverChunks,
    lostChunks: lost, uploadHasError: g('uploadHasError'), finalBanner, uploadMs, uploadPassMs,
    clientAssemblyWaitMs: assemblingAt && afterAssembling ? afterAssembling - assemblingAt : null,
    banners,
  };
  fs.writeFileSync(path.join(spec.outDir, `${spec.identity}.summary.json`), JSON.stringify(summary, null, 2));
  await new Promise((r) => timeline.end(r));
  if (videoFd != null) fs.closeSync(videoFd);
  plog(`done: banner=${finalBanner}, ${fmtMB(stats.bytesUploaded)} uploaded in ${fmtDur(uploadMs)}, ${retries} retries, lost=${lost.length}`);
}

// ── Entry ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.child) {
  participant(args, JSON.parse(args.child)).then(() => process.exit(0), (e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
} else {
  orchestrate(args).catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
