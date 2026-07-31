// ── Upload pipeline ──────────────────────────────────────────────────────────
//
// Recording is local-only while capture is in progress: every chunk is
// written through the instant it's produced, and nothing is sent to the
// server until the recording stops. Upload of the whole take then happens
// in one pass (see _uploadAllRecordedChunks below). Because nothing is held
// in memory across the whole recording, there's no backpressure concept to
// apply here — MediaRecorder is never paused for upload reasons.
//
// Where a chunk is written through to is bifurcated per track: if this
// participant opted into File System Access on prejoin (fsaDirHandle set —
// see fsa-store.js) and the browser still honors that grant on this page
// load, every chunk for a track is appended to one real local file instead
// of a separate IndexedDB record. Otherwise it falls back to IndexedDB
// exactly as before. A track's choice is made once, on its first chunk, and
// held for the rest of that recording.

// Lazily opens (and caches) the local file for a track the first time one of
// its chunks arrives. Returns null if FSA isn't in play for this recording,
// or if opening the file failed for some reason — either way the caller
// falls back to IndexedDB for that chunk.
function _fsaTakeNumber() {
  if (!fsaTakeNumberPromise) {
    fsaTakeNumberPromise = fsaNextTakeNumber(fsaDirHandle, SESSION_TITLE, displayName);
  }
  return fsaTakeNumberPromise;
}

function _fsaTrackFor(trackType, ext) {
  if (!fsaDirHandle) return Promise.resolve(null);
  if (!fsaOpenPromises[trackType]) {
    fsaOpenPromises[trackType] = _fsaTakeNumber()
      .then(take => fsaOpenTrackFile(fsaDirHandle, trackType, ext, SESSION_TITLE, displayName, take))
      .then(track => { track.ext = ext; return track; })
      .catch(e => {
        console.warn(`_fsaTrackFor: open failed for ${trackType}, falling back to IndexedDB:`, e);
        return null;
      });
  }
  return fsaOpenPromises[trackType];
}

// A chunk's write-through is the only copy of that chunk that will ever
// exist — recording is local-only until stop. If it can't be persisted
// anywhere (FSA write fails mid-track, or IndexedDB rejects it — quota
// exceeded, DB blocked, etc.), continuing to record while silently missing
// data produces a corrupt take the user won't discover until playback. Fail
// loud instead: stop recording immediately and tell the user, same as any
// other unrecoverable capture error.
async function _persistChunk(blob, trackType, ext, index, epoch, sessionId, uploadIdentity, participant, meta) {
  const track = await _fsaTrackFor(trackType, ext);
  if (track) {
    try {
      await fsaWriteChunk(track, blob);
      return;
    } catch (e) {
      // Don't retry FSA for the rest of this track — a mid-recording failure
      // (permission revoked, disk full, drive unplugged) is likely to recur,
      // and mixing backends within one track complicates recovery. Fall back
      // to IndexedDB for every remaining chunk of this track instead.
      console.warn(`_persistChunk: FSA write failed for ${trackType}#${index}, falling back to IndexedDB for rest of track:`, e);
      fsaOpenPromises[trackType] = Promise.resolve(null);
      // Everything already committed to the local file before this failure is
      // real captured data — stash it so _doUploadAllRecordedChunks still
      // uploads it (as chunk 0) instead of silently dropping it once this
      // track's fsaOpenPromises entry is cleared above.
      try {
        await fsaCloseTrackFile(track);
        fsaFailedTracks[trackType] = track;
      } catch (closeErr) {
        console.warn(`_persistChunk: could not close failed FSA file for ${trackType} — data written before the failure is lost:`, closeErr);
      }
    }
  }
  await idbPutChunk({ sessionId, identity: uploadIdentity, participant, epoch, trackType, chunkIndex: index, ext, meta, blob });
}

function enqueueChunk(blob, trackType, ext, meta = {}, epochOverride = null) {
  const index = chunkIndex[trackType]++;
  const epoch = epochOverride || recordingEpoch;
  const sessionId = SESSION_ID, uploadIdentity = identity, participant = displayName;
  uploadStats.queued++;
  refreshUploadBanner();
  // Chain onto this track's queue rather than firing _persistChunk directly —
  // fsaWriteChunk can trigger fsaFlushTrackFile's close()+reopen() cycle,
  // and an overlapping write from the next chunk landing mid-flush would hit
  // a closing/stale writable. Serializing per track (each chunk waits for the
  // previous one to finish persisting) keeps writes and flushes from racing.
  const settled = _persistQueues[trackType]
    .then(() => _persistChunk(blob, trackType, ext, index, epoch, sessionId, uploadIdentity, participant, meta));
  _persistQueues[trackType] = settled.catch(() => {});
  settled
    .then(() => {
      uploadStats.completed++;
      refreshUploadBanner();
    })
    .catch(e => {
      console.error(`enqueueChunk: ${trackType}#${index} could not be persisted anywhere — recording is corrupt from here on:`, e);
      if (typeof handleFatalRecordingError === 'function') handleFatalRecordingError(trackType, e);
    });
}

// ── Crash recovery (resume on reload) ───────────────────────────────────────
// A tab crash, browser close, or hard reload — whether mid-recording or
// mid-upload during the post-stop pass — leaves chunks sitting in
// IndexedDB with nothing left to drive them to the server. On every join,
// sweep the whole store and resend anything still there: it belongs to a
// run that never finished uploading, since a successful run always cleans
// up after itself (idbDeleteChunk / idbDeleteEpoch). The chunks' own stored
// session/identity/epoch are used rather than the current join's — orphaned
// capture is very likely from a previous browser session with a different
// randomized identity.

// Recover one (sessionId, identity, epoch, trackType) group: ask the server
// how far it already got (item 3 — /api/upload/chunks), resend only the
// tail it's missing, then finalize. Returns true if the group is fully
// resolved (nothing left to retry later), so the caller can safely clear
// its interrupted-session marker.
async function _recoverGroup(chunks) {
  chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
  const { sessionId, identity: recIdentity, participant, epoch, trackType, ext: firstExt } = chunks[0];
  const recParticipant = participant || recIdentity;
  // The live finalize path gets start_time_ms/expected_duration_s from
  // pendingFinalizeMeta (set by finalizeTrack at onstop), but that's an
  // in-memory object lost on the reload that triggers recovery. Every chunk
  // now carries start_time_ms in its own meta (see enqueueChunk callers in
  // recording.js) specifically so it survives in IndexedDB — pull it from
  // whichever chunk is still here. expected_duration_s only survives for pcm
  // audio (chunk_offset_s marks each chunk's position in the stream); other
  // track types have no reliable end estimate here, so it's left unset —
  // truncation detection still works, it just can't fire for this recovered
  // take.
  const startTimeMs = chunks.find(c => c.meta && c.meta.start_time_ms != null)?.meta.start_time_ms;
  const lastPcmOffset = chunks.reduce((max, c) => {
    const off = c.meta && c.meta.chunk_offset_s;
    return typeof off === 'number' && off > max ? off : max;
  }, -1);
  const expectedDurationS = lastPcmOffset >= 0 ? lastPcmOffset : undefined;

  // get_chunk_progress 404s if the session itself is gone, which doubles as
  // a cheap "is there anywhere left to recover this into" preflight — no
  // need to discover that mid-upload on a per-chunk basis.
  let presentIndices = null; // null = unknown server progress, resend everything
  let sessionGone = false;
  try {
    const r = await fetch('/api/upload/chunks?' + new URLSearchParams({
      session_id: sessionId, identity: recIdentity, participant: recParticipant,
      track_type: trackType, epoch: epoch || '',
    }));
    if (r.status === 404) {
      sessionGone = true;
    } else if (r.ok) {
      const body = await r.json();
      // Trust only the confirmed-present set, not next_chunk's max+1 —
      // concurrent 4-wide chunk uploads can leave a gap below the max index
      // (one chunk exhausts retries while later ones succeed), and next_chunk
      // alone can't tell a real gap from "everything below here landed".
      presentIndices = new Set(body.present_indices ?? []);
    }
  } catch (e) {
    // Unknown server progress — fall back to resending everything; the
    // server just overwrites same-index files, so this is safe, only wasteful.
  }

  if (sessionGone) {
    for (const c of chunks) idbDeleteChunk(c.sessionId, c.identity, c.epoch, c.trackType, c.chunkIndex);
    try {
      const markerKey = `podbooth:epoch:${sessionId}:${recIdentity}`;
      if (localStorage.getItem(markerKey) === epoch) localStorage.removeItem(markerKey);
    } catch (e) {}
    return true;
  }

  let uploadedAny = !!(presentIndices && presentIndices.size > 0);
  let failed = false;

  for (const c of chunks) {
    if (presentIndices && presentIndices.has(c.chunkIndex)) {
      // Server confirmed it already has this exact index — just clear it.
      idbDeleteChunk(c.sessionId, c.identity, c.epoch, c.trackType, c.chunkIndex);
      continue;
    }
    const rec = await idbGetChunk(c.sessionId, c.identity, c.epoch, c.trackType, c.chunkIndex);
    if (!rec) continue; // already gone — nothing to resend
    // Reuse the same retrying uploader the live pipeline uses, rather than a
    // one-shot POST — a transient network blip during recovery shouldn't
    // abandon the rest of the group any more readily than it would live.
    const ok = await uploadChunkWithRetry(rec.blob, c.trackType, c.chunkIndex, c.ext, c.epoch, rec.meta || {}, sessionId, c.identity, recParticipant);
    if (!ok) {
      console.warn(`recoverOrphanedChunks: gave up resending ${trackType}#${c.chunkIndex}, will retry next join`);
      failed = true;
      break;
    }
    idbDeleteChunk(c.sessionId, c.identity, c.epoch, c.trackType, c.chunkIndex);
    uploadedAny = true;
  }

  if (uploadedAny && !failed) {
    const fmt = trackType === 'audio' && firstExt === 'raw' ? 'pcm' : 'container';
    const body = {
      session_id: sessionId, participant: recParticipant, identity: recIdentity,
      track_type: trackType, format: fmt, epoch: epoch || '',
    };
    if (startTimeMs != null) body.start_time_ms = startTimeMs;
    if (expectedDurationS !== undefined) body.expected_duration_s = expectedDurationS;
    if (fmt === 'pcm') { body.sample_rate = 48000; body.channels = 2; }
    try {
      const r = await fetch('/api/upload/finalize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) console.warn(`recoverOrphanedChunks: finalize failed for ${trackType} (${sessionId}/${recIdentity}/${epoch}): HTTP ${r.status}`);
    } catch (e) {
      console.warn(`recoverOrphanedChunks: finalize request failed for ${trackType}:`, e);
    }
  }

  if (!failed) {
    try {
      const markerKey = `podbooth:epoch:${sessionId}:${recIdentity}`;
      if (localStorage.getItem(markerKey) === epoch) localStorage.removeItem(markerKey);
    } catch (e) {}
  }
  return !failed;
}

async function recoverOrphanedChunks() {
  const all = await idbGetAllChunks();
  // No early return on an empty store: a recording that crashed before a
  // single chunk was ever written to IndexedDB leaves its "interrupted
  // session" localStorage marker behind with nothing to recover it into —
  // returning here before the stale-marker sweep below made that marker
  // (and the recovery banner it drives on prejoin) permanently stuck, since
  // every future join would hit this same empty-store case again.
  if (all.length > 0) {
    recLog('recoverOrphanedChunks: found %d leftover chunk(s) in IndexedDB', all.length);
  }

  const groups = new Map();
  for (const rec of all) {
    const gkey = `${rec.sessionId}::${rec.identity}::${rec.epoch}::${rec.trackType}`;
    if (!groups.has(gkey)) groups.set(gkey, []);
    groups.get(gkey).push(rec);
  }

  // A group's (sessionId, identity, epoch, trackType) tuple only ever comes
  // from one specific browser tab's earlier recording — but if that tab is
  // still alive (e.g. it's mid-retry itself, or the user has the same
  // session open in two tabs), two tabs racing to resend the same chunks
  // would be wasted work at best. Web Locks makes each group exclusive:
  // whichever tab grabs the lock recovers it, the other skips it outright.
  await Promise.all([...groups.values()].map(async (chunks) => {
    const { sessionId, identity: recIdentity, epoch, trackType } = chunks[0];
    const lockName = `podbooth-recover:${sessionId}:${recIdentity}:${epoch}:${trackType}`;
    if (navigator.locks && navigator.locks.request) {
      try {
        await navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
          if (!lock) { recLog('recoverOrphanedChunks: %s held by another tab, skipping', lockName); return; }
          await _recoverGroup(chunks);
        });
      } catch (e) {
        console.warn('recoverOrphanedChunks: lock request failed, recovering unlocked:', e);
        await _recoverGroup(chunks);
      }
    } else {
      await _recoverGroup(chunks);
    }
  }));

  // Anything still marked "interrupted" in localStorage but with no matching
  // IndexedDB chunks either finished uploading in the same instant the tab
  // died (after Promise.all in waitForUploads, before its removeItem call),
  // or never captured a single chunk before crashing. Either way there's
  // nothing to recover — clear it so the banner stops firing forever.
  try {
    const liveMarkers = new Set(
      [...groups.values()].map(chunks => {
        const { sessionId, identity: recIdentity, epoch } = chunks[0];
        return `podbooth:epoch:${sessionId}:${recIdentity}::${epoch}`;
      })
    );
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('podbooth:epoch:')) continue;
      const epoch = localStorage.getItem(key);
      if (!liveMarkers.has(`${key}::${epoch}`)) stale.push(key);
    }
    stale.forEach(k => localStorage.removeItem(k));
  } catch (e) {}
}

// A cloud multipart upload started by _uploadFsaTrackDirectToCloud survives
// entirely outside this page — the bytes already in the bucket don't go away
// if the tab crashes/closes/reloads before /cloud/complete fires — but
// nothing would otherwise ever finish it. On every join, sweep localStorage
// for markers an interrupted cloud upload left behind and resume each one:
// ask the bucket which parts already landed (GET /cloud/parts), reopen the
// same local file via the persisted FSA directory grant, and upload only
// what's still missing.
async function recoverCloudUploads() {
  let markers;
  try {
    markers = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('podbooth:cloud:')) markers.push(k);
    }
  } catch (e) {
    return;
  }
  if (markers.length === 0) return;

  const dirHandle = await fsaGetDirectory();
  for (const markerKey of markers) {
    let parsed;
    try {
      parsed = JSON.parse(localStorage.getItem(markerKey));
    } catch (e) {
      try { localStorage.removeItem(markerKey); } catch (e2) {}
      continue;
    }
    // Format: podbooth:cloud:{sessionId}:{identity}:{trackType}:{epoch} — the
    // trailing three parts are all validated at write time to be
    // colon-free (session/identity are opaque IDs, epoch matches _EPOCH_RE).
    const parts = markerKey.split(':');
    if (parts.length < 6 || !parsed || !parsed.key || !parsed.uploadId || !parsed.fileName) {
      try { localStorage.removeItem(markerKey); } catch (e) {}
      continue;
    }
    const [, , sessionId, forIdentity, trackType, epoch] = parts;

    if (!dirHandle) {
      recLog('recoverCloudUploads: no FSA directory access, cannot resume %s', markerKey);
      continue;
    }
    try {
      const fileHandle = await dirHandle.getFileHandle(parsed.fileName);
      const file = await fileHandle.getFile();

      let alreadyUploaded = [];
      try {
        const r = await fetch('/api/upload/cloud/parts?' + new URLSearchParams({ key: parsed.key, upload_id: parsed.uploadId }));
        ({ parts: alreadyUploaded } = await r.json());
      } catch (e) {
        console.warn(`recoverCloudUploads: could not list existing parts for ${markerKey}:`, e);
      }

      const abortController = new AbortController();
      const uploaded = await _uploadCloudParts(file, parsed.key, parsed.uploadId, parsed.partSize, alreadyUploaded, abortController);
      if (!uploaded) {
        console.warn(`recoverCloudUploads: could not finish resuming ${markerKey}`);
        continue;
      }

      await _postJson('/api/upload/cloud/complete', {
        session_id: sessionId, participant: parsed.participant || '', identity: forIdentity,
        track_type: trackType, epoch: epoch || '', ext: parsed.ext,
        key: parsed.key, upload_id: parsed.uploadId, parts: uploaded,
        ...(parsed.meta || {}),
      });
      try { localStorage.removeItem(markerKey); } catch (e) {}
      recLog('recoverCloudUploads: resumed and completed %s', markerKey);
    } catch (e) {
      console.warn(`recoverCloudUploads: resume failed for ${markerKey}:`, e);
    }
  }
}

// Keep retrying a failing chunk for this long before giving up. The per-track
// upload queue is serial, so as long as a chunk is retrying, later chunks wait
// behind it — retrying until success therefore guarantees strictly in-order,
// gap-free delivery, and a transient network blip can no longer drop a chunk
// and corrupt the assembled recording (missing WebM header / discontinuity).
// The budget bounds the worst case (server genuinely gone) so stopRecording
// can't wedge forever.
const CHUNK_RETRY_BUDGET_MS = 10 * 60 * 1000;

// Chunks currently failing to upload, so the recording status can surface
// trouble without us ever abandoning a chunk mid-flight.
const uploadStruggling = new Set();

let uploadCancelled = false;

// One controller per upload pass, aborted by the banner's "Cancel upload"
// button. Its signal is threaded through every uploadChunkWithRetry call —
// both the FSA whole-file path and the plain IndexedDB chunk path — so
// cancelling stops all in-flight and future chunk requests for this pass,
// not just FSA transfers. Chunks already sent stay uploaded server-side;
// nothing already-persisted locally is deleted, so a later recording attempt
// (or a page reload retry) can still pick the rest up.
let uploadAbortController = null;

function cancelUpload() {
  if (uploadAbortController) uploadAbortController.abort();
  recLog('cancelUpload: cancelling in-progress upload');
}

// A hung TCP connection (common on a flaky VPN/tunnel link) leaves fetch()
// neither resolving nor rejecting — without an explicit timeout, a single
// wedged attempt blocks every retry behind it for good, since the retry loop
// never even gets to see it fail. Abort and retry instead of waiting forever;
// backoff between attempts still applies on the resulting AbortError same as
// any other failure.
const CHUNK_UPLOAD_TIMEOUT_MS = 60 * 1000;

// A normal MediaRecorder chunk is a few MB and always fits comfortably in
// CHUNK_UPLOAD_TIMEOUT_MS, but a File System Access whole-recording upload
// (see fsa-store.js) can be many GB sent as one "chunk" — a fixed 60s timeout
// would abort every attempt on a real connection before the transfer could
// ever finish. Scale the timeout by size using a conservative minimum
// throughput floor, on top of the flat per-request timeout for latency/setup.
const MIN_UPLOAD_BYTES_PER_SEC = 512 * 1024; // 512 KB/s — a deliberately low floor

// Upload speed preference, selectable from the upload banner while chunks are
// in flight and read live here on every chunk — 'low' caps upload bandwidth
// so recording doesn't saturate a home connection shared with a video call;
// 'unlimited' (default) applies no cap.
const UPLOAD_SPEED_KEY = 'podbooth:upload-speed';
const UPLOAD_SPEED_CAPS_BYTES_PER_SEC = { low: 250 * 1024, normal: 1024 * 1024 };

function _uploadSpeedCap() {
  let pref = 'unlimited';
  try { pref = localStorage.getItem(UPLOAD_SPEED_KEY) || 'unlimited'; } catch (e) {}
  return UPLOAD_SPEED_CAPS_BYTES_PER_SEC[pref] || null; // null = unlimited
}

function _uploadTimeoutForSize(bytes) {
  // The floor for the timeout must never be faster than the user's own
  // configured cap, or a deliberately-throttled transfer would abort itself.
  const floor = Math.min(MIN_UPLOAD_BYTES_PER_SEC, _uploadSpeedCap() || Infinity);
  return CHUNK_UPLOAD_TIMEOUT_MS + Math.ceil(bytes / floor) * 1000;
}

// A degraded-but-working connection can still be sending bytes well under
// MIN_UPLOAD_BYTES_PER_SEC — a flat size-scaled timeout can't tell that
// apart from a fully wedged connection, and kills (and restarts from byte 0)
// a transfer that would have finished if just left alone. Track actual
// upload progress instead: only abort when NO bytes have moved for this
// long, not because the transfer as a whole is "slow".
const UPLOAD_STALL_TIMEOUT_MS = 20 * 1000;
// Backstop even for a connection that dribbles just enough progress to keep
// resetting the stall timer forever — without this, a sub-1-byte/sec trickle
// could hold one attempt open indefinitely.
const UPLOAD_STALL_HARD_CAP_MS = 30 * 60 * 1000;

// Rolling window of recent upload byte deltas, shared across every in-flight
// XHR (chunk uploads run with concurrency > 1, so speed must be summed across
// requests, not read off any single one). Samples older than the window are
// dropped each time we recompute, so the reading tracks recent throughput
// rather than an all-time average.
const UPLOAD_SPEED_WINDOW_MS = 4000;
let _uploadByteSamples = [];

function _recordUploadBytes(delta) {
  if (delta <= 0) return;
  const now = performance.now();
  _uploadByteSamples.push({ t: now, bytes: delta });
  const cutoff = now - UPLOAD_SPEED_WINDOW_MS;
  while (_uploadByteSamples.length && _uploadByteSamples[0].t < cutoff) _uploadByteSamples.shift();
}

// Current upload throughput in bytes/sec, averaged over the trailing window.
// Returns 0 once samples age out, so the display naturally falls back to
// "—" between bursts instead of showing a stale number.
function currentUploadSpeedBps() {
  const now = performance.now();
  const cutoff = now - UPLOAD_SPEED_WINDOW_MS;
  while (_uploadByteSamples.length && _uploadByteSamples[0].t < cutoff) _uploadByteSamples.shift();
  if (!_uploadByteSamples.length) return 0;
  const totalBytes = _uploadByteSamples.reduce((sum, s) => sum + s.bytes, 0);
  const spanMs = Math.max(now - _uploadByteSamples[0].t, 250); // avoid a tiny span inflating the rate
  return totalBytes / (spanMs / 1000);
}

function formatUploadSpeed(bps) {
  if (!bps || bps <= 0) return '';
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}

// XHR (not fetch) because only XHR exposes upload progress events — fetch's
// request streaming has no equivalent, so there's no way to distinguish
// "still sending, just slow" from "completely stalled" with fetch alone.
function _xhrUploadChunk(form, cancelSignal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stallTimer = null;
    let hardCapTimer = null;
    let settled = false;
    let lastLoaded = 0;

    const cleanup = () => {
      clearTimeout(stallTimer);
      clearTimeout(hardCapTimer);
      if (cancelSignal) cancelSignal.removeEventListener('abort', onCancel);
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => xhr.abort(), UPLOAD_STALL_TIMEOUT_MS);
    };
    const onCancel = () => xhr.abort();
    if (cancelSignal) cancelSignal.addEventListener('abort', onCancel);

    xhr.upload.addEventListener('progress', resetStallTimer);
    xhr.upload.addEventListener('progress', (event) => {
      _recordUploadBytes(event.loaded - lastLoaded);
      lastLoaded = event.loaded;
    });
    xhr.addEventListener('loadstart', resetStallTimer);
    xhr.addEventListener('load', () => finish(resolve, { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status }));
    xhr.addEventListener('error', () => finish(reject, new Error('network error')));
    xhr.addEventListener('abort', () => finish(reject, new DOMException('aborted', 'AbortError')));

    hardCapTimer = setTimeout(() => xhr.abort(), UPLOAD_STALL_HARD_CAP_MS);

    xhr.open('POST', '/api/upload/chunk');
    xhr.send(form);
  });
}

// Simple token-bucket: before sending `bytes`, wait however long is needed to
// keep the average rate at or under the configured cap. Throttling happens
// between chunks (the natural granularity here — see upload.js header comment)
// rather than mid-transfer, so no change is needed to how a chunk is sent.
let _uploadTokens = 0;
let _uploadTokensAt = Date.now();

async function _throttleForUpload(bytes, cancelSignal = null) {
  const cap = _uploadSpeedCap();
  if (!cap) return;
  const now = Date.now();
  _uploadTokens += ((now - _uploadTokensAt) / 1000) * cap;
  _uploadTokensAt = now;
  _uploadTokens = Math.min(_uploadTokens, cap); // don't let idle time bank unbounded burst
  if (_uploadTokens < bytes) {
    const waitMs = ((bytes - _uploadTokens) / cap) * 1000;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, waitMs);
      if (cancelSignal) cancelSignal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    _uploadTokens = 0;
    _uploadTokensAt = Date.now();
  } else {
    _uploadTokens -= bytes;
  }
}

// How many chunks of one track upload at once. A single TCP flow is the
// worst case for a lossy/congested path — one bad-luck loss burst on the
// only flow in flight tanks the whole transfer's effective throughput
// (severe single-flow TCP degradation under loss/policing on a long-haul
// path), while several independent flows in parallel still add up to much
// higher aggregate throughput even though each one sees the same loss rate.
// Chunks are independent, arrival-order-agnostic files on the server (see
// assemble_track's sorted glob in upload.py) so uploading several at once
// is safe — nothing here depends on chunk N landing before chunk N+1.
const UPLOAD_CONCURRENCY = 4;

// Run `worker(item)` over `items` with at most `concurrency` in flight at
// once. `worker` returns false to mean "stop starting new work, this run
// has failed" (mirrors the old serial loops' `if (!ok) return`) — already
// in-flight workers still finish, but no further items are started.
async function _uploadPoolRun(items, worker, concurrency = UPLOAD_CONCURRENCY) {
  let index = 0;
  let allOk = true;
  async function runNext() {
    while (index < items.length) {
      if (!allOk) return;
      const item = items[index++];
      const ok = await worker(item);
      if (!ok) { allOk = false; return; }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
  await Promise.all(workers);
  return allOk;
}

async function uploadChunkWithRetry(blob, trackType, index, ext, epoch, meta = {}, sessionId = SESSION_ID, uploadIdentity = identity, participant = displayName, cancelSignal = null) {
  await _throttleForUpload(blob.size, cancelSignal);
  if (cancelSignal?.aborted) {
    recLog('uploadChunk: %s #%d cancelled by user during throttle wait', trackType, index);
    return false;
  }
  recLog('uploadChunk: %s #%d size=%d', trackType, index, blob.size);
  const key = `${trackType}#${index}`;
  // For a normal few-MB chunk this is just CHUNK_RETRY_BUDGET_MS. For a large
  // File System Access whole-file upload (a multi-GB video sent as one
  // "chunk"), a single attempt can legitimately take longer than that fixed
  // budget — so scale the budget to guarantee at least a couple of full-length
  // attempts, or a slow/interrupted transfer gets declared permanently lost
  // after just one try with zero retries left.
  const budget = Math.max(CHUNK_RETRY_BUDGET_MS, _uploadTimeoutForSize(blob.size) * 2);
  const deadline = Date.now() + budget;
  let attempt = 0;
  while (true) {
    if (cancelSignal?.aborted) {
      recLog('uploadChunk: %s #%d cancelled by user before attempt %d', trackType, index, attempt + 1);
      return false;
    }
    attempt++;
    try {
      const form = new FormData();
      form.append('session_id', sessionId);
      form.append('participant', participant);
      form.append('identity', uploadIdentity);
      form.append('track_type', trackType);
      form.append('chunk_index', index);
      form.append('ext', ext);
      form.append('epoch', epoch || '');
      form.append('expected_size', blob.size);
      if (Object.keys(meta).length > 0) {
        form.append('chunk_meta', JSON.stringify(meta));
      }
      form.append('file', blob, `chunk_${index}.${ext}`);

      const { ok: httpOk, status } = await _xhrUploadChunk(form, cancelSignal);
      if (httpOk) {
        recLog('uploadChunk: %s #%d ok', trackType, index);
        uploadStruggling.delete(key);
        if (uploadStruggling.size === 0) uploadHasError = false;
        return true;
      }
      throw new Error(`HTTP ${status}`);
    } catch (err) {
      if (cancelSignal?.aborted) {
        recLog('uploadChunk: %s #%d cancelled by user mid-attempt', trackType, index);
        return false;
      }
      // Surface the struggle after a few quick failures, but never stop trying
      // (the bytes stay held in this closure) until the retry budget runs out.
      if (attempt >= 3) {
        uploadStruggling.add(key);
        uploadHasError = true;
      }
      console.warn(`Chunk upload failing (${trackType} #${index}), attempt ${attempt}:`, err);
      if (Date.now() >= deadline) {
        console.error(`Chunk permanently lost after ${Math.round(budget / 1000)}s of retries: ${trackType} #${index}`);
        return false; // let the queue drain so /finalize fires and the server-side gap check flags it
      }
      await new Promise(res => setTimeout(res, Math.min(1000 * attempt, 15000)));
    }
  }
}

// Same retry budget/backoff shape as chunk uploads: a lost/failed finalize
// call means the server never starts assembly even though every chunk landed,
// so it must be retried like any other upload rather than fire-and-forget.
const FINALIZE_RETRY_BUDGET_MS = 10 * 60 * 1000;

async function _sendFinalizeWithRetry(trackType, body) {
  const deadline = Date.now() + FINALIZE_RETRY_BUDGET_MS;
  let attempt = 0;
  while (true) {
    attempt++;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), CHUNK_UPLOAD_TIMEOUT_MS);
    try {
      // keepalive lets this tiny JSON POST survive a tab close that would
      // otherwise abort an in-flight fetch (the queue only reaches finalize
      // after every chunk has uploaded, so there's nothing left to lose but
      // this call itself).
      const r = await fetch('/api/upload/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        signal: abort.signal,
      });
      recLog('finalizeTrack: /finalize %s responded %d', trackType, r.status);
      if (r.ok) return;
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.warn(`Finalize failing for ${trackType}, attempt ${attempt}:`, e);
      if (Date.now() >= deadline) {
        console.error(`Finalize permanently failed after ${Math.round(FINALIZE_RETRY_BUDGET_MS / 1000)}s of retries: ${trackType}`);
        uploadHasError = true;
        return;
      }
      await new Promise(res => setTimeout(res, Math.min(1000 * attempt, 15000)));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function finalizeTrack(trackType, meta, epoch = recordingEpoch) {
  recLog('finalizeTrack: %s epoch=%s meta=%o (deferred until stop)', trackType, epoch, meta);
  // Recording is local-only until the stop — just remember this track's
  // finalize payload. _uploadAllRecordedChunks sends it once every chunk for
  // this (trackType, epoch) group has been uploaded. Keyed by both, not just
  // trackType, so a screen-share restart (a second group under its own
  // epoch — see screenEpoch in recording.js) gets its own finalize instead of
  // clobbering the first segment's.
  pendingFinalizeMeta[`${trackType}::${epoch}`] = meta;
}

// Multiple call sites can each decide the recording needs to be flushed to
// the server for the same epoch — stopRecording's waitForUploads, and then
// (independently) leaveSession/endSession/handleSessionEnded right after.
// Without caching the in-flight/completed run, the second call would redo
// the whole pass: harmless for IndexedDB tracks (their chunks are already
// deleted, so it's just a no-op sweep), but for an FSA track it would try to
// close an already-closed file a second time. Cache by epoch so every caller
// for the same run shares one outcome instead of re-triggering it.
let _uploadPass = { epoch: null, promise: null };

// epoch defaults to a read of the module global at call time — every caller
// invokes this synchronously (no prior await in the same tick) right when it
// decides to flush, so the default-parameter read happens at the right
// instant. Once captured here, epoch is threaded through explicitly for the
// rest of the pass instead of being re-read from the module global, which
// can be reassigned mid-pass by a retake's startLocalRecording.
// screenEpochs defaults to a snapshot of every epoch a screen-share restart
// has used this recording (see screenEpochHistory in recording.js) — like
// `epoch`, read via a default parameter at call time so it reflects the
// state of *this* recording rather than being re-read later mid-pass.
function _uploadAllRecordedChunks(epoch = recordingEpoch, screenEpochs = (typeof screenEpochHistory !== 'undefined' ? screenEpochHistory.slice() : [])) {
  if (_uploadPass.epoch === epoch && _uploadPass.promise) return _uploadPass.promise;
  const promise = _doUploadAllRecordedChunks(epoch, screenEpochs);
  _uploadPass = { epoch, promise };
  return promise;
}

// Upload every chunk this tab captured for the given recording
// (sessionId/identity/epoch), track by track, then finalize each track once
// its chunks are up. This is what turns a stopped local-only recording into
// an actual upload — nothing was sent to the server while capture was live.
// A track that used File System Access (see _fsaTrackFor) uploads as one
// whole-file "chunk 0" instead of many small IndexedDB-backed chunks.
//
// Chunks are grouped by (trackType, epoch) rather than trackType alone: a
// screen-share restart mid-recording produces a second group under its own
// epoch (see screenEpoch in recording.js) so it assembles server-side as its
// own independent take instead of being concatenated onto the first segment.
// Audio/video only ever have one group each, using the pass epoch.
async function _doUploadAllRecordedChunks(epoch, screenEpochs = []) {
  // Captured once per pass and threaded through explicitly (rather than read
  // from the module-level binding inside track callbacks) so a callback that
  // resolves late can never end up checking a *different* pass's controller
  // if the module-level variable has since been reassigned by a newer pass.
  const abortController = uploadAbortController = new AbortController();
  // Drain every track's persist queue BEFORE snapshotting IndexedDB. The
  // final chunk(s) of a track (flushPcm(true), the last ondataavailable) are
  // enqueued but not awaited by stopLocalRecording, so they can still be
  // mid-write here — a snapshot taken first would miss them, upload the
  // track without its tail, report a clean run, and then idbDeleteEpoch's
  // backstop sweep in waitForUploads would delete the unsent chunks for good.
  // (Each queue already swallows its own errors — see enqueueChunk.)
  await Promise.all(Object.values(_persistQueues));
  const all = await idbGetAllChunks();
  // Only screen chunks may belong to one of this pass's known sub-epochs —
  // audio/video must match the pass epoch exactly, so a fast retake's
  // in-progress chunks (a different epoch, from startLocalRecording) can
  // never be swept into this pass.
  const screenEpochSet = new Set(screenEpochs);
  const mine = all.filter(c => c.sessionId === SESSION_ID && c.identity === identity &&
    (c.epoch === epoch || (c.trackType === 'screen' && screenEpochSet.has(c.epoch))));

  const chunksByGroup = new Map(); // `${trackType}::${epoch}` -> chunk records
  for (const rec of mine) {
    const key = `${rec.trackType}::${rec.epoch}`;
    if (!chunksByGroup.has(key)) chunksByGroup.set(key, []);
    chunksByGroup.get(key).push(rec);
  }

  uploadStats.queued = mine.length;
  uploadStats.completed = 0;
  refreshUploadBanner();

  // Union of groups that have a finalize payload, an open/failed FSA file
  // (always keyed under the pass epoch — FSA doesn't support a mid-recording
  // screen restart's extra group), or leftover IndexedDB chunks — a group can
  // have chunks/an open file without finalize ever having been called for it
  // (e.g. its recorder never fired onstop), and those chunks still need to go
  // up even though there's no meta to finalize.
  const groupKeys = new Set([
    ...Object.keys(pendingFinalizeMeta),
    ...Object.keys(fsaOpenPromises).map(t => `${t}::${epoch}`),
    ...Object.keys(fsaFailedTracks).map(t => `${t}::${epoch}`),
    ...chunksByGroup.keys(),
  ]);
  await Promise.all([...groupKeys].map(async (key) => {
    const sep = key.indexOf('::');
    const trackType = key.slice(0, sep);
    const groupEpoch = key.slice(sep + 2);
    try {
      await _uploadOneTrack(trackType, fsaOpenPromises, fsaFailedTracks, chunksByGroup.get(key) || [], abortController, groupEpoch);
    } catch (e) {
      // An uncaught throw here (e.g. from fsaCloseTrackFile on a huge file)
      // used to propagate straight out of Promise.all and abort the whole
      // batch silently — other groups that had already finished stayed
      // finished, but this one vanished with no console trace at all and
      // the generic "may be incomplete" banner gave no hint why. Log it and
      // flag it like any other upload failure instead.
      console.error(`_doUploadAllRecordedChunks: ${key} failed:`, e);
      uploadHasError = true;
    }
  }));
}

// A stalled connection now only costs one slice's worth of restart (see
// UPLOAD_STALL_TIMEOUT_MS in uploadChunkWithRetry) instead of the whole
// recording, but that only helps if the file is actually cut into pieces —
// a multi-GB take sent as a single "chunk" still restarts from byte 0 on
// every retry. 5MB matches the rough granularity the non-FSA IndexedDB path
// already uploads at.
const FSA_UPLOAD_SLICE_BYTES = 5 * 1024 * 1024;

// ── Direct-to-cloud upload (FSA tracks only) ────────────────────────────────
// A clean FSA track (never failed over to IndexedDB) normally slices its
// closed local file and POSTs each slice through this server — but this
// server's link to guests can be much slower than guests' own uplinks (see
// the direct-cloud-upload plan). When DIRECT_CLOUD_UPLOAD_ENABLED, upload
// straight from the browser to the configured S3-compatible backend via
// presigned multipart URLs instead: the server never sees these bytes until
// it pulls the finished object back down over its own link. Falls back to
// the server-proxied slice path (return null) if anything about the cloud
// path can't even get started.

function _cloudMarkerKey(sessionId, forIdentity, trackType, epoch) {
  return `podbooth:cloud:${sessionId}:${forIdentity}:${trackType}:${epoch}`;
}

async function _postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Uploads one part to a presigned URL, retrying on transient failure with the
// same budget/backoff shape as uploadChunkWithRetry. Returns the part's ETag
// on success, or null if cancelled/permanently failed.
async function _uploadCloudPartWithRetry(url, piece, cancelSignal) {
  const budget = Math.max(CHUNK_RETRY_BUDGET_MS, _uploadTimeoutForSize(piece.size) * 2);
  const deadline = Date.now() + budget;
  let attempt = 0;
  while (true) {
    if (cancelSignal?.aborted) return null;
    attempt++;
    try {
      const r = await fetch(url, { method: 'PUT', body: piece, signal: cancelSignal || undefined });
      if (r.ok) {
        const etag = r.headers.get('ETag') || r.headers.get('etag');
        if (!etag) throw new Error('part upload response missing ETag');
        return etag;
      }
      throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      if (cancelSignal?.aborted) return null;
      console.warn(`Cloud part upload failing, attempt ${attempt}:`, err);
      if (Date.now() >= deadline) {
        console.error(`Cloud part permanently lost after ${Math.round(budget / 1000)}s of retries`);
        return null;
      }
      await new Promise(res => setTimeout(res, Math.min(1000 * attempt, 15000)));
    }
  }
}

// Slices `file` into partSize pieces, requests a presigned URL per part not
// already in `alreadyUploaded` (used by the resume sweep — see
// recoverCloudUploads), and PUTs them directly to the bucket with bounded
// concurrency. Returns the full sorted parts list (already-uploaded +
// newly-uploaded) on success, or null if any part is unrecoverable.
async function _uploadCloudParts(file, key, uploadId, partSize, alreadyUploaded, abortController) {
  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  const parts = alreadyUploaded.map(p => ({ part_number: p.part_number, etag: p.etag }));
  const alreadyDone = new Set(alreadyUploaded.map(p => p.part_number));
  const remaining = [];
  for (let i = 1; i <= totalParts; i++) {
    if (!alreadyDone.has(i)) remaining.push(i);
  }
  uploadStats.queued += remaining.length;
  refreshUploadBanner();
  const ok = await _uploadPoolRun(remaining, async (partNumber) => {
    if (abortController.signal.aborted) return false;
    const start = (partNumber - 1) * partSize;
    const piece = file.slice(start, start + partSize);
    let url;
    try {
      ({ url } = await _postJson('/api/upload/cloud/part-url', { key, upload_id: uploadId, part_number: partNumber }));
    } catch (e) {
      console.error(`_uploadCloudParts: could not get part-url for part ${partNumber}:`, e);
      uploadHasError = true;
      return false;
    }
    const etag = await _uploadCloudPartWithRetry(url, piece, abortController.signal);
    if (!etag) {
      if (abortController.signal.aborted) uploadCancelled = true;
      else uploadHasError = true;
      return false;
    }
    parts.push({ part_number: partNumber, etag });
    uploadStats.completed++;
    refreshUploadBanner();
    return true;
  });
  return ok ? parts : null;
}

async function _uploadFsaTrackDirectToCloud(trackType, file, epoch, ext, abortController) {
  const markerKey = _cloudMarkerKey(SESSION_ID, identity, trackType, epoch);
  let key, uploadId, partSize;
  try {
    const started = await _postJson('/api/upload/cloud/start', {
      session_id: SESSION_ID, participant: displayName, identity,
      track_type: trackType, epoch: epoch || '', ext, total_size: file.size,
    });
    ({ key, upload_id: uploadId, part_size: partSize } = started);
  } catch (e) {
    console.warn('_uploadFsaTrackDirectToCloud: /cloud/start failed, falling back to server-proxied upload:', e);
    return null;
  }
  // Snapshot the finalize meta (format/sample_rate/channels/expected_duration_s)
  // now, while it's still in memory, and persist it alongside the marker. If
  // the tab dies before /cloud/complete fires, pendingFinalizeMeta is gone on
  // reload — without this, a resumed upload would transcode with server
  // defaults (48kHz/1ch/"container") instead of the track's real parameters.
  const metaKey = `${trackType}::${epoch}`;
  const meta = pendingFinalizeMeta[metaKey] || {};
  try {
    localStorage.setItem(markerKey, JSON.stringify({ key, uploadId, ext, partSize, fileName: file.name, participant: displayName, meta }));
  } catch (e) {}

  const parts = await _uploadCloudParts(file, key, uploadId, partSize, [], abortController);
  if (!parts) {
    if (abortController.signal.aborted) {
      // Explicit user cancel — abort the multipart upload so the bucket
      // doesn't keep an orphaned incomplete upload around forever, and drop
      // the resume marker since a cancelled recording isn't retried
      // automatically (resuming it would just fail against the now-aborted
      // upload_id).
      try { await _postJson('/api/upload/cloud/abort', { key, upload_id: uploadId }); } catch (e) {}
      try { localStorage.removeItem(markerKey); } catch (e) {}
    }
    return false;
  }

  try {
    await _postJson('/api/upload/cloud/complete', {
      session_id: SESSION_ID, participant: displayName, identity,
      track_type: trackType, epoch: epoch || '', ext, key, upload_id: uploadId, parts,
      ...meta,
    });
  } catch (e) {
    console.error(`_uploadFsaTrackDirectToCloud: /cloud/complete failed for ${trackType}:`, e);
    uploadHasError = true;
    return false;
  }
  delete pendingFinalizeMeta[metaKey];
  try { if (localStorage.getItem(markerKey)) localStorage.removeItem(markerKey); } catch (e) {}
  return true;
}

async function _uploadOneTrack(trackType, fsaOpenPromises, fsaFailedTracks, groupChunks, abortController, epoch) {
  // enqueueChunk's writes are chained onto _persistQueues[trackType] but not
  // awaited by the caller (MediaRecorder's onstop isn't async-aware), so the
  // last chunk(s) of a track can still be mid-write when this runs. Closing
  // the file (below) before that settles silently truncates it — the file
  // still "uploads successfully", just missing its tail (or, if the whole
  // final chunk hadn't landed, effectively empty). Wait for the chain to
  // drain first so close() only ever runs after every chunk is committed.
  await (_persistQueues[trackType] || Promise.resolve());
  const fsaTrack = fsaOpenPromises[trackType] ? await fsaOpenPromises[trackType] : null;
  const failedTrack = fsaFailedTracks[trackType];
  // fsaTrack and failedTrack are mutually exclusive (once a track fails
  // over, its fsaOpenPromises entry is cleared for good — see
  // _persistChunk), but a failed-over track can still have IndexedDB
  // chunks recorded after the failure, so that path isn't an `else`: a
  // local whole-file upload and IndexedDB chunk uploads can both apply to
  // the same track.
  const localTrack = fsaTrack || failedTrack;
  if (localTrack) {
    recLog('_uploadAllRecordedChunks: closing local file and uploading %s whole (%d bytes)', trackType, localTrack.bytesWritten);
    let file = await fsaCloseTrackFile(localTrack);
    // The on-disk copy of a raw-PCM audio track is wrapped in a real WAV
    // header (see fsaOpenTrackFile/_fsaWavHeader in fsa-store.js) so it's
    // playable locally, but the server still expects headerless f32le
    // samples for its own `pcm` ffmpeg conversion (see below) — strip the
    // 44-byte header back off just for the copy we upload.
    if (localTrack.isRawAudio) file = file.slice(44);

    let ok;
    if (failedTrack && failedTrack.chunksWritten === 0) {
      // Failed over before a single chunk was committed to the file — there
      // is nothing salvaged in it (a raw-audio file is just its WAV header).
      // Skip the whole-file upload entirely: uploading it as chunk 0 would
      // collide with the real chunk 0 sitting in IndexedDB below.
      ok = true;
    } else if (failedTrack) {
      // This track failed over from FSA to IndexedDB mid-recording, so the
      // salvaged bytes still have to go up as one whole chunk 0 rather than
      // sliced: the trailing IndexedDB chunks uploaded below reuse their
      // original (non-zero) indices, and `subsumes_chunks` tells the
      // server's gap check that chunk 0 already covers original indices
      // 0..chunksWritten-1 — introducing our own slice numbering here would
      // collide with those real indices, even when only one chunk made it
      // into the file (a >5MB salvaged file would otherwise slice into
      // indices 0..N right on top of them). Slicing is reserved for a clean
      // FSA track, which never has trailing IndexedDB chunks.
      uploadStats.queued++;
      refreshUploadBanner();
      const wholeMeta = { subsumes_chunks: failedTrack.chunksWritten };
      ok = await uploadChunkWithRetry(file, trackType, 0, localTrack.ext, epoch, wholeMeta, SESSION_ID, identity, displayName, abortController.signal);
      if (ok) uploadStats.completed++;
      refreshUploadBanner();
    } else {
      let cloudResult = null;
      if (typeof DIRECT_CLOUD_UPLOAD_ENABLED !== 'undefined' && DIRECT_CLOUD_UPLOAD_ENABLED) {
        cloudResult = await _uploadFsaTrackDirectToCloud(trackType, file, epoch, localTrack.ext, abortController);
      }
      if (cloudResult !== null) {
        // true: uploaded + /cloud/complete already sent (which also cleared
        // pendingFinalizeMeta) — nothing more to do for this track. false:
        // cancelled or permanently failed, same as the server-proxied path.
        ok = cloudResult;
      } else {
        const totalSlices = Math.max(1, Math.ceil(file.size / FSA_UPLOAD_SLICE_BYTES));
        uploadStats.queued += totalSlices;
        refreshUploadBanner();
        const sliceIndices = Array.from({ length: totalSlices }, (_, i) => i);
        ok = await _uploadPoolRun(sliceIndices, async (i) => {
          const start = i * FSA_UPLOAD_SLICE_BYTES;
          const piece = file.slice(start, start + FSA_UPLOAD_SLICE_BYTES);
          const sliceOk = await uploadChunkWithRetry(piece, trackType, i, localTrack.ext, epoch, {}, SESSION_ID, identity, displayName, abortController.signal);
          if (sliceOk) uploadStats.completed++;
          refreshUploadBanner();
          return sliceOk;
        });
      }
    }
    const wasCancelled = abortController.signal.aborted;
    delete fsaFailedTracks[trackType];
    if (!ok) {
      if (wasCancelled) uploadCancelled = true;
      return; // uploadChunkWithRetry already set uploadHasError (unless cancelled); leave this track unfinalized
    }
  }
  if (!fsaTrack) {
    const chunks = groupChunks.slice().sort((a, b) => a.chunkIndex - b.chunkIndex);
    const allOk = await _uploadPoolRun(chunks, async (c) => {
      const rec = await idbGetChunk(c.sessionId, c.identity, c.epoch, c.trackType, c.chunkIndex);
      if (!rec) {
        // The record we just enumerated is gone by the time we go to read
        // it — that's a real chunk permanently missing from the upload,
        // not a normal "nothing to send" case, so it must surface the same
        // way a retry-exhausted chunk does rather than count as completed.
        console.error(`_doUploadAllRecordedChunks: ${trackType}#${c.chunkIndex} vanished from IndexedDB before upload — recording will be missing this chunk`);
        uploadHasError = true;
        uploadStats.completed++;
        refreshUploadBanner();
        return true; // not fatal to the rest of the track — keep going
      }
      const ok = await uploadChunkWithRetry(rec.blob, trackType, c.chunkIndex, c.ext, c.epoch, rec.meta || {}, SESSION_ID, identity, displayName, abortController.signal);
      if (!ok) {
        if (abortController.signal.aborted) uploadCancelled = true;
        return false; // uploadChunkWithRetry already set uploadHasError (unless cancelled); leave this track unfinalized
      }
      idbDeleteChunk(c.sessionId, c.identity, c.epoch, c.trackType, c.chunkIndex);
      uploadStats.completed++;
      refreshUploadBanner();
      return true;
    });
    if (!allOk) return;
  }
  const metaKey = `${trackType}::${epoch}`;
  if (!(metaKey in pendingFinalizeMeta)) return; // chunks uploaded, but no finalize payload was ever recorded
  const meta = pendingFinalizeMeta[metaKey];
  delete pendingFinalizeMeta[metaKey];
  recLog('finalizeTrack: sending /finalize for %s epoch=%s', trackType, epoch);
  await _sendFinalizeWithRetry(trackType, {
    session_id: SESSION_ID,
    participant: displayName,
    identity: identity,
    track_type: trackType,
    epoch: epoch || '',
    ...meta,
  });
}

// Clears the interrupted-session marker only if it still points at this
// exact epoch — guards against clobbering a marker a newer recording pass
// (retake) has since written for its own epoch.
function _clearEpochMarker(forIdentity, epoch) {
  try {
    const key = `podbooth:epoch:${SESSION_ID}:${forIdentity}`;
    if (localStorage.getItem(key) === epoch) localStorage.removeItem(key);
  } catch (e) {}
}

async function waitForUploads() {
  const epoch = recordingEpoch;
  showUploadBanner('uploading');
  const _unloadGuard = e => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', _unloadGuard);
  try {
    await _uploadAllRecordedChunks(epoch);
    _clearEpochMarker(identity, epoch);

    if (uploadCancelled) {
      showUploadBanner('cancelled');
      return;
    }

    // If any chunk exhausted its retry budget, the recording is incomplete —
    // don't tell the user (host or guest) everything is fine.
    if (uploadHasError) {
      showUploadBanner('error');
      return;
    }

    // Every chunk uploaded cleanly, so its IndexedDB copy should already be
    // gone (deleted in _uploadAllRecordedChunks's loop) — this is just a
    // backstop sweep in case any individual delete failed along the way.
    idbDeleteEpoch(SESSION_ID, identity, epoch);

    // Wait for server-side assembly to complete
    showUploadBanner('assembling');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const r = await fetch(`/api/session/${SESSION_ID}/assembly-status`);
        if (r.ok && !(await r.json()).assembling) break;
      } catch (e) {}
    }

    if (IS_HOST) {
      showUploadBanner('verifying');
      try {
        const vr = await fetch(`/api/session/${SESSION_ID}/verify-recordings`);
        if (vr.ok) {
          const { issues } = await vr.json();
          if (issues && issues.length > 0) { showUploadWarnings(issues); return; }
        }
      } catch (e) {}
    }

    showUploadBanner('done');
    setTimeout(() => hideUploadBanner(), 8000);
  } catch (e) {
    showUploadBanner('error');
  } finally {
    window.removeEventListener('beforeunload', _unloadGuard);
  }
}

// ── Upload banner ─────────────────────────────────────────────────────────────

function _buildUploadBanner(banner, state) {
  banner.innerHTML = '';
  const main = document.createElement('div');
  main.className = 'upload-banner-main';

  const lbl = document.createElement('span');
  lbl.className = 'upload-banner-label';

  if (state === 'uploading') {
    const n = uploadStats.completed, t = uploadStats.queued;
    lbl.textContent = t > 0 ? `Uploading ${n}/${t} chunks` : 'Uploading recordings…';
    main.appendChild(lbl);
    const track = document.createElement('div');
    track.className = 'upload-progress-track';
    const fill = document.createElement('div');
    fill.className = 'upload-progress-fill';
    fill.style.width = (t > 0 ? Math.round(n / t * 100) : 0) + '%';
    track.appendChild(fill);
    main.appendChild(track);

    const speedReadout = document.createElement('span');
    speedReadout.className = 'upload-speed-readout';
    speedReadout.textContent = formatUploadSpeed(currentUploadSpeedBps());
    main.appendChild(speedReadout);

    const speedSelect = document.createElement('select');
    speedSelect.className = 'upload-speed-select';
    speedSelect.title = 'Upload speed';
    speedSelect.innerHTML = `
      <option value="unlimited">Unlimited speed</option>
      <option value="normal">Normal (1 MB/s)</option>
      <option value="low">Low (250 KB/s)</option>
    `;
    try {
      const saved = localStorage.getItem(UPLOAD_SPEED_KEY);
      if (saved && [...speedSelect.options].some(o => o.value === saved)) speedSelect.value = saved;
    } catch (e) {}
    speedSelect.addEventListener('change', () => {
      try { localStorage.setItem(UPLOAD_SPEED_KEY, speedSelect.value); } catch (e) {}
    });
    main.appendChild(speedSelect);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'upload-cancel-btn';
    cancelBtn.textContent = 'Cancel upload';
    cancelBtn.title = 'Stop sending this recording to the cloud';
    cancelBtn.addEventListener('click', cancelUpload);
    main.appendChild(cancelBtn);
  } else if (state === 'assembling') {
    lbl.textContent = 'Assembling recordings…';
    main.appendChild(lbl);
    const spin = document.createElement('span');
    spin.className = 'upload-spinner';
    main.appendChild(spin);
  } else if (state === 'verifying') {
    lbl.textContent = 'Verifying recordings…';
    main.appendChild(lbl);
    const spin = document.createElement('span');
    spin.className = 'upload-spinner';
    main.appendChild(spin);
  } else if (state === 'done') {
    lbl.textContent = '✓ Recordings ready';
    main.appendChild(lbl);
  } else if (state === 'cancelled') {
    lbl.textContent = 'Upload cancelled — recording not sent';
    main.appendChild(lbl);
  } else {
    lbl.textContent = '⚠ Upload may be incomplete';
    main.appendChild(lbl);
  }

  banner.appendChild(main);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'upload-banner-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Dismiss';
  closeBtn.addEventListener('click', hideUploadBanner);
  banner.appendChild(closeBtn);
}

let _uploadSpeedTimer = null;

function showUploadBanner(state) {
  uploadPending = (state === 'uploading');
  const banner = document.getElementById('upload-banner');
  if (!banner) return;
  banner.classList.remove('hidden', 'uploading', 'done', 'error', 'assembling', 'cancelled', 'verifying');
  banner.classList.add(state);
  _buildUploadBanner(banner, state);

  clearInterval(_uploadSpeedTimer);
  _uploadSpeedTimer = (state === 'uploading') ? setInterval(refreshUploadBanner, 500) : null;
}

function refreshUploadBanner() {
  const banner = document.getElementById('upload-banner');
  if (!banner || banner.classList.contains('hidden') || !banner.classList.contains('uploading')) return;
  const fill = banner.querySelector('.upload-progress-fill');
  const lbl  = banner.querySelector('.upload-banner-label');
  const speedReadout = banner.querySelector('.upload-speed-readout');
  const { completed: n, queued: t } = uploadStats;
  if (fill && t > 0) fill.style.width = Math.round(n / t * 100) + '%';
  if (lbl)  lbl.textContent = t > 0 ? `Uploading ${n}/${t} chunks` : 'Uploading recordings…';
  if (speedReadout) speedReadout.textContent = formatUploadSpeed(currentUploadSpeedBps());
}

function hideUploadBanner() {
  uploadPending = false;
  clearInterval(_uploadSpeedTimer);
  _uploadSpeedTimer = null;
  const banner = document.getElementById('upload-banner');
  if (!banner) return;
  banner.classList.add('hidden');
  banner.classList.remove('uploading', 'done', 'error', 'assembling', 'cancelled', 'verifying');
}

function showUploadWarnings(issues) {
  const banner = document.getElementById('upload-banner');
  if (!banner) return;
  banner.classList.remove('hidden', 'uploading', 'done', 'error', 'assembling');
  banner.classList.add('warn');
  banner.innerHTML = '';
  const main = document.createElement('div');
  main.className = 'upload-banner-main upload-banner-issues';
  const lbl = document.createElement('span');
  lbl.className = 'upload-banner-label';
  lbl.textContent = `⚠ ${issues.length} recording issue${issues.length > 1 ? 's' : ''} detected`;
  main.appendChild(lbl);
  for (const iss of issues) {
    const row = document.createElement('div');
    row.className = 'upload-issue-row';
    row.textContent = `${iss.participant} / ${iss.file}: ${iss.issue}`;
    main.appendChild(row);
  }
  banner.appendChild(main);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'upload-banner-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Dismiss';
  closeBtn.addEventListener('click', hideUploadBanner);
  banner.appendChild(closeBtn);
}

// ── Recordings files panel ────────────────────────────────────────────────────

let filesPollTimer = null;
let _lastFileCount = -1;
let _stablePolls = 0;

async function fetchFiles() {
  if (!IS_HOST) return;

  const [asmRes, recRes] = await Promise.all([
    fetch(`/api/session/${SESSION_ID}/assembly-status`).catch(() => null),
    fetch(`/api/session/${SESSION_ID}/recordings`).catch(() => null),
  ]);
  if (!recRes?.ok) return null;

  const { assembling } = asmRes?.ok ? await asmRes.json() : { assembling: false };
  const { files } = await recRes.json();

  // Update badge regardless of panel visibility
  const badge = document.getElementById('files-badge');
  if (badge) {
    if (files.length > 0) {
      badge.textContent = files.length;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  // Only repaint the panel if it's open
  if (filesList && filesPanel?.style.display !== 'none') {
    filesList.innerHTML = '';
    if (files.length === 0 && assembling) {
      filesList.innerHTML = '<span class="files-empty">Assembling recordings…</span>';
    } else if (files.length === 0) {
      filesList.innerHTML = '<span class="files-empty">No recordings yet.</span>';
    } else {
      files.forEach(f => {
        const row = document.createElement('div');
        row.className = 'files-row';
        const children = [];
        if (f.participant) {
          const p = document.createElement('span'); p.className = 'files-participant'; p.textContent = f.participant;
          children.push(p);
        }
        if (f.take != null) {
          const tk = document.createElement('span'); tk.className = 'files-take'; tk.textContent = `T${f.take}`;
          children.push(tk);
        }
        const t = document.createElement('span'); t.className = `files-type ${f.type}`; t.textContent = f.type;
        children.push(t);
        if (f.size_mb != null) {
          const s = document.createElement('span'); s.className = 'files-size'; s.textContent = `${f.size_mb} MB`;
          children.push(s);
        }
        const a = document.createElement('a'); a.href = `/download/${f.path}`; a.download = ''; a.textContent = 'Download';
        children.push(a);
        row.append(...children);
        filesList.appendChild(row);
      });
      if (assembling) {
        const note = document.createElement('span');
        note.className = 'files-empty';
        note.style.marginTop = '6px';
        note.textContent = 'More files assembling…';
        filesList.appendChild(note);
      }
    }
  }

  return { fileCount: files.length, assembling };
}

function startFilesPoll() {
  if (!IS_HOST || filesPollTimer) return;
  _lastFileCount = -1;
  _stablePolls = 0;
  filesPollTimer = setInterval(async () => {
    const result = await fetchFiles();
    if (!result) return;
    const { fileCount, assembling } = result;
    if (!assembling && fileCount === _lastFileCount) {
      _stablePolls++;
      if (_stablePolls >= 2) { stopFilesPoll(); return; }
    } else {
      _stablePolls = 0;
    }
    _lastFileCount = fileCount;
  }, 3000);
}

function stopFilesPoll() {
  clearInterval(filesPollTimer);
  filesPollTimer = null;
}
