// ── Upload pipeline ──────────────────────────────────────────────────────────

function enqueueChunk(blob, trackType, ext, meta = {}) {
  const index = chunkIndex[trackType]++;
  const epoch = recordingEpoch;
  uploadStats.queued++;
  refreshUploadBanner();
  uploadQueues[trackType] = uploadQueues[trackType]
    .then(() => uploadChunkWithRetry(blob, trackType, index, ext, epoch, meta))
    .then(() => { uploadStats.completed++; refreshUploadBanner(); });
  return uploadQueues[trackType];
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

async function uploadChunkWithRetry(blob, trackType, index, ext, epoch, meta = {}) {
  recLog('uploadChunk: %s #%d size=%d', trackType, index, blob.size);
  const key = `${trackType}#${index}`;
  const deadline = Date.now() + CHUNK_RETRY_BUDGET_MS;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const form = new FormData();
      form.append('session_id', SESSION_ID);
      form.append('participant', displayName);
      form.append('identity', identity);
      form.append('track_type', trackType);
      form.append('chunk_index', index);
      form.append('ext', ext);
      form.append('epoch', epoch || '');
      if (Object.keys(meta).length > 0) {
        form.append('chunk_meta', JSON.stringify(meta));
      }
      form.append('file', blob, `chunk_${index}.${ext}`);

      const r = await fetch('/api/upload/chunk', { method: 'POST', body: form });
      if (r.ok) {
        recLog('uploadChunk: %s #%d ok', trackType, index);
        uploadStruggling.delete(key);
        if (uploadStruggling.size === 0) uploadHasError = false;
        return;
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
        return; // let the queue drain so /finalize fires and the server-side gap check flags it
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
    try {
      const r = await fetch('/api/upload/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: SESSION_ID,
          participant: displayName,
          identity: identity,
          track_type: trackType,
          epoch: epoch || '',
          ...meta,
        }),
      });
      recLog('finalizeTrack: /finalize %s responded %d', trackType, r.status);
    } catch (e) {
      console.error(`Finalize failed for ${trackType}:`, e);
    }
  });
  return uploadQueues[trackType];
}

async function waitForUploads() {
  showUploadBanner('uploading');
  const _unloadGuard = e => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', _unloadGuard);
  try {
    await Promise.all(Object.values(uploadQueues));
    sessionStorage.removeItem(`podbooth:epoch:${SESSION_ID}:${identity}`);

    // If any chunk exhausted its retry budget, the recording is incomplete —
    // don't tell the user (host or guest) everything is fine.
    if (uploadHasError) {
      showUploadBanner('error');
      return;
    }

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
