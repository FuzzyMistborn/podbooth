// ── Upload pipeline ──────────────────────────────────────────────────────────

// Backpressure: if the upload queue can't keep up with capture (slow uplink,
// 4K video, long recordings), unflushed blobs pile up in memory as closures
// held by the promise chain. Cap how many bytes can be buffered per track —
// once over the high watermark, pause the corresponding MediaRecorder until
// the queue drains back below the low watermark, rather than let RAM grow
// unbounded. PCM audio isn't paused (its worklet can't be paused mid-stream
// and its chunks are small relative to video/screen), only MediaRecorder-based
// tracks (video, screen, opus-fallback audio).
const UPLOAD_QUEUE_HIGH_WATERMARK_BYTES = 200 * 1024 * 1024;
const UPLOAD_QUEUE_LOW_WATERMARK_BYTES = 50 * 1024 * 1024;
const uploadQueuedBytes = { audio: 0, video: 0, screen: 0 };
const uploadPausedByBackpressure = { audio: false, video: false, screen: false };

function _recorderFor(trackType) {
  if (trackType === 'video') return typeof videoRecorder !== 'undefined' ? videoRecorder : null;
  if (trackType === 'screen') return typeof screenRecorder !== 'undefined' ? screenRecorder : null;
  if (trackType === 'audio') return typeof audioRecorder !== 'undefined' ? audioRecorder : null;
  return null;
}

function _applyBackpressure(trackType) {
  if (trackType === 'audio') return; // PCM path can't be paused; opus fallback chunks are small
  const rec = _recorderFor(trackType);
  if (!rec) return;
  if (uploadQueuedBytes[trackType] >= UPLOAD_QUEUE_HIGH_WATERMARK_BYTES && rec.state === 'recording') {
    recLog('backpressure: pausing %s recorder (queued=%d bytes)', trackType, uploadQueuedBytes[trackType]);
    uploadPausedByBackpressure[trackType] = true;
    rec.pause();
  } else if (uploadPausedByBackpressure[trackType] && uploadQueuedBytes[trackType] <= UPLOAD_QUEUE_LOW_WATERMARK_BYTES && rec.state === 'paused') {
    recLog('backpressure: resuming %s recorder (queued=%d bytes)', trackType, uploadQueuedBytes[trackType]);
    uploadPausedByBackpressure[trackType] = false;
    rec.resume();
  }
}

// Fetch a chunk's blob back out of IndexedDB and upload it — the pump reads
// one blob at a time this way instead of the promise chain closing over
// every queued blob directly, so a large backpressure backlog costs disk,
// not RAM. `fallbackBlob` is only non-null when IndexedDB wasn't available
// to write through to in the first place (see enqueueChunk below), in which
// case there's nothing durable to read back and the direct reference is the
// only copy that exists.
async function uploadIdbChunkWithRetry(sessionId, uploadIdentity, epoch, trackType, index, ext, meta, fallbackBlob, participant) {
  let blob = fallbackBlob;
  if (!blob) {
    const rec = await idbGetChunk(sessionId, uploadIdentity, epoch, trackType, index);
    blob = rec ? rec.blob : null;
  }
  if (!blob) {
    console.error(`uploadIdbChunkWithRetry: ${trackType}#${index} missing from IndexedDB — chunk lost`);
    uploadHasError = true;
    return;
  }
  await uploadChunkWithRetry(blob, trackType, index, ext, epoch, meta, sessionId, uploadIdentity, participant);
  idbDeleteChunk(sessionId, uploadIdentity, epoch, trackType, index);
}

function enqueueChunk(blob, trackType, ext, meta = {}) {
  const index = chunkIndex[trackType]++;
  const epoch = recordingEpoch;
  const size = blob.size;
  const sessionId = SESSION_ID, uploadIdentity = identity, participant = displayName;
  uploadStats.queued++;
  uploadQueuedBytes[trackType] += size;
  _applyBackpressure(trackType);
  refreshUploadBanner();
  // Write-through to IndexedDB first — the pump below reads the blob back
  // from there rather than closing over it, so the in-memory queue only
  // needs to retain small scalars, not the backlog's actual bytes. The pump
  // is chained onto this same write promise (not fired independently) so it
  // can never race ahead of the write and find nothing there yet.
  const putPromise = idbPutChunk({ sessionId, identity: uploadIdentity, participant, epoch, trackType, chunkIndex: index, ext, meta, blob });
  const fallbackBlob = _idbAvailable() ? null : blob;
  uploadQueues[trackType] = uploadQueues[trackType]
    .then(() => putPromise)
    .then(() => uploadIdbChunkWithRetry(sessionId, uploadIdentity, epoch, trackType, index, ext, meta, fallbackBlob, participant))
    .then(() => {
      uploadStats.completed++;
      uploadQueuedBytes[trackType] -= size;
      _applyBackpressure(trackType);
      refreshUploadBanner();
    });
  return uploadQueues[trackType];
}

// ── Crash recovery (resume on reload) ───────────────────────────────────────
// A tab crash, browser close, or hard reload during recording abandons
// whatever's still sitting in the in-memory upload queue — but the
// write-through above (idbPutChunk in enqueueChunk) means an on-disk copy
// survives in IndexedDB. On every join, sweep the whole store and resend
// anything still there: it belongs to a run that never finished uploading,
// since a successful run always cleans up after itself (idbDeleteChunk /
// idbDeleteEpoch). The chunks' own stored session/identity/epoch are used
// rather than the current join's — orphaned capture is very likely from a
// previous browser session with a different randomized identity.

// Recover one (sessionId, identity, epoch, trackType) group: ask the server
// how far it already got (item 3 — /api/upload/chunks), resend only the
// tail it's missing, then finalize. Returns true if the group is fully
// resolved (nothing left to retry later), so the caller can safely clear
// its interrupted-session marker.
async function _recoverGroup(chunks) {
  chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
  const { sessionId, identity: recIdentity, participant, epoch, trackType, ext: firstExt } = chunks[0];
  const recParticipant = participant || recIdentity;

  // get_chunk_progress 404s if the session itself is gone, which doubles as
  // a cheap "is there anywhere left to recover this into" preflight — no
  // need to discover that mid-upload on a per-chunk basis.
  let nextChunk = 0;
  let sessionGone = false;
  try {
    const r = await fetch('/api/upload/chunks?' + new URLSearchParams({
      session_id: sessionId, identity: recIdentity, participant: recParticipant,
      track_type: trackType, epoch: epoch || '',
    }));
    if (r.status === 404) {
      sessionGone = true;
    } else if (r.ok) {
      nextChunk = (await r.json()).next_chunk ?? 0;
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

  let uploadedAny = nextChunk > 0;
  let failed = false;

  for (const c of chunks) {
    if (c.chunkIndex < nextChunk) {
      // Server already has this one from before the crash — just clear it.
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
  if (all.length === 0) return;
  recLog('recoverOrphanedChunks: found %d leftover chunk(s) in IndexedDB', all.length);

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

async function uploadChunkWithRetry(blob, trackType, index, ext, epoch, meta = {}, sessionId = SESSION_ID, uploadIdentity = identity, participant = displayName) {
  recLog('uploadChunk: %s #%d size=%d', trackType, index, blob.size);
  const key = `${trackType}#${index}`;
  const deadline = Date.now() + CHUNK_RETRY_BUDGET_MS;
  let attempt = 0;
  while (true) {
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

      const r = await fetch('/api/upload/chunk', { method: 'POST', body: form });
      if (r.ok) {
        recLog('uploadChunk: %s #%d ok', trackType, index);
        uploadStruggling.delete(key);
        if (uploadStruggling.size === 0) uploadHasError = false;
        return true;
      }
      throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      // Surface the struggle after a few quick failures, but never stop trying
      // (the bytes stay held in this closure) until the retry budget runs out.
      if (attempt >= 3) {
        uploadStruggling.add(key);
        uploadHasError = true;
      }
      console.warn(`Chunk upload failing (${trackType} #${index}), attempt ${attempt}:`, err);
      if (Date.now() >= deadline) {
        console.error(`Chunk permanently lost after ${Math.round(CHUNK_RETRY_BUDGET_MS / 1000)}s of retries: ${trackType} #${index}`);
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
    }
  }
}

function finalizeTrack(trackType, meta) {
  const epoch = recordingEpoch;
  recLog('finalizeTrack: %s epoch=%s meta=%o', trackType, epoch, meta);
  // Chain finalize onto the upload queue so it only fires after every
  // chunk for this track has been flushed to the server.
  uploadQueues[trackType] = uploadQueues[trackType].then(async () => {
    recLog('finalizeTrack: sending /finalize for %s', trackType);
    await _sendFinalizeWithRetry(trackType, {
      session_id: SESSION_ID,
      participant: displayName,
      identity: identity,
      track_type: trackType,
      epoch: epoch || '',
      ...meta,
    });
  });
  return uploadQueues[trackType];
}

async function waitForUploads() {
  showUploadBanner('uploading');
  const _unloadGuard = e => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', _unloadGuard);
  try {
    await Promise.all(Object.values(uploadQueues));
    localStorage.removeItem(`podbooth:epoch:${SESSION_ID}:${identity}`);

    // If any chunk exhausted its retry budget, the recording is incomplete —
    // don't tell the user (host or guest) everything is fine.
    if (uploadHasError) {
      showUploadBanner('error');
      return;
    }

    // Every chunk uploaded cleanly, so its IndexedDB copy should already be
    // gone (deleted in enqueueChunk's completion handler) — this is just a
    // backstop sweep in case any individual delete failed along the way.
    idbDeleteEpoch(SESSION_ID, identity, recordingEpoch);

    // Wait for server-side assembly to complete
    showUploadBanner('assembling');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const r = await fetch(`/api/session/${SESSION_ID}/assembly-status`);
        if (r.ok && !(await r.json()).assembling) break;
      } catch (e) {}
    }

    showUploadBanner('done');
    setTimeout(() => hideUploadBanner(), 8000);

    if (IS_HOST) {
      try {
        const vr = await fetch(`/api/session/${SESSION_ID}/verify-recordings`);
        if (vr.ok) {
          const { issues } = await vr.json();
          if (issues && issues.length > 0) showUploadWarnings(issues);
        }
      } catch (e) {}
    }
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
  } else if (state === 'assembling') {
    lbl.textContent = 'Assembling recordings…';
    main.appendChild(lbl);
    const spin = document.createElement('span');
    spin.className = 'upload-spinner';
    main.appendChild(spin);
  } else if (state === 'done') {
    lbl.textContent = '✓ Recordings ready';
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

function showUploadBanner(state) {
  uploadPending = (state === 'uploading');
  const banner = document.getElementById('upload-banner');
  if (!banner) return;
  banner.classList.remove('hidden', 'uploading', 'done', 'error', 'assembling');
  banner.classList.add(state);
  _buildUploadBanner(banner, state);
}

function refreshUploadBanner() {
  const banner = document.getElementById('upload-banner');
  if (!banner || banner.classList.contains('hidden') || !banner.classList.contains('uploading')) return;
  const fill = banner.querySelector('.upload-progress-fill');
  const lbl  = banner.querySelector('.upload-banner-label');
  const { completed: n, queued: t } = uploadStats;
  if (fill && t > 0) fill.style.width = Math.round(n / t * 100) + '%';
  if (lbl)  lbl.textContent = t > 0 ? `Uploading ${n}/${t} chunks` : 'Uploading recordings…';
}

function hideUploadBanner() {
  uploadPending = false;
  const banner = document.getElementById('upload-banner');
  if (!banner) return;
  banner.classList.add('hidden');
  banner.classList.remove('uploading', 'done', 'error', 'assembling');
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
