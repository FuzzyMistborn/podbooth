// ── Audio waveform state ─────────────────────────────────────────────────────
// Architecture: fast polling captures speech peaks; slow slot commits drive the
// display. Each display slot stores the PEAK of all fast polls within its window,
// giving a clean speech envelope (clear peaks during words, valleys in gaps)
// over a long history. Rendering uses rAF + sub-pixel translate for smooth scroll.
//
// Poll every WAVE_FAST_MS → accumulate peak → commit one slot every WAVE_SLOT_MS
// → 300 slots × 400 ms = 2 minutes of history shown.
const waveBuffers   = new Map(); // tileId → Float32Array committed peak history
const waveHeads     = new Map(); // tileId → next write index
const wavePeakAccum = new Map(); // tileId → running peak for the current slot
const waveLiveLvl   = new Map(); // tileId → fast EMA for the live right-edge preview
const WAVE_BUF_SIZE   = 512;    // circular buffer (must be > WAVE_DISPLAY_N + 2)
const WAVE_FAST_MS    = 50;     // poll interval — fast enough to catch syllable peaks
const WAVE_SLOT_MS    = 400;    // each display column represents this many ms
const WAVE_SLOT_TICKS = WAVE_SLOT_MS / WAVE_FAST_MS; // fast polls per committed slot
const WAVE_DISPLAY_N  = 300;    // columns rendered (300 × 400 ms = 2 min)
let waveTimerId     = null;
let waveRafId       = null;
let waveTickCount   = 0;
let waveLastSlot    = 0;        // performance.now() when the last slot was committed
let waveformEnabled = localStorage.getItem('podbooth:waveform') !== 'false';

function startWaveAnimation() {
  if (waveTimerId || !waveformEnabled) return;
  waveTickCount = 0;
  waveLastSlot  = performance.now();
  waveTimerId   = setInterval(waveTickSample, WAVE_FAST_MS);
  waveRafId     = requestAnimationFrame(waveDrawFrame);
}
function stopWaveAnimation() {
  clearInterval(waveTimerId);
  waveTimerId = null;
  if (waveRafId) { cancelAnimationFrame(waveRafId); waveRafId = null; }
}
function toggleWaveform() {
  waveformEnabled = !waveformEnabled;
  localStorage.setItem('podbooth:waveform', waveformEnabled);
  document.querySelectorAll('.tile-wave').forEach(c => {
    c.style.display = waveformEnabled ? '' : 'none';
  });
  if (waveformEnabled && waveBuffers.size > 0) startWaveAnimation();
  else if (!waveformEnabled) stopWaveAnimation();
  const btn = document.getElementById('btn-wave');
  if (btn) btn.classList.toggle('active', waveformEnabled);
}
function waveTickSample() {
  if (typeof room === 'undefined' || !room) return;
  const levels = new Map();
  const lp = room.localParticipant;
  if (lp) levels.set(`tile-${lp.identity}`, lp.audioLevel || 0);
  room.remoteParticipants?.forEach(p => levels.set(`tile-${p.identity}`, p.audioLevel || 0));

  for (const [tileId] of waveBuffers) {
    const raw = levels.get(tileId) || 0;
    // Peak accumulator: takes the loudest moment within each slot window
    wavePeakAccum.set(tileId, Math.max(wavePeakAccum.get(tileId) || 0, raw));
    // Fast EMA for the live right-edge preview (responds quickly, decays in ~300 ms)
    const prev = waveLiveLvl.get(tileId) || 0;
    waveLiveLvl.set(tileId, raw > prev ? raw : raw * 0.3 + prev * 0.7);
  }

  waveTickCount++;
  if (waveTickCount < WAVE_SLOT_TICKS) return;
  waveTickCount = 0;

  // Commit slot: push accumulated peak into the circular buffer
  for (const [tileId, buf] of waveBuffers) {
    buf[waveHeads.get(tileId) % WAVE_BUF_SIZE] = wavePeakAccum.get(tileId) || 0;
    waveHeads.set(tileId, (waveHeads.get(tileId) || 0) + 1);
    wavePeakAccum.set(tileId, 0);
  }
  waveLastSlot = performance.now();
}
function waveDrawFrame() {
  if (!waveTimerId) return;
  waveRafId = requestAnimationFrame(waveDrawFrame);
  if (!waveBuffers.size) return;

  // Fraction of current slot elapsed — drives the sub-pixel scroll offset
  const frac = Math.min(1, (performance.now() - waveLastSlot) / WAVE_SLOT_MS);
  for (const [tileId, buf] of waveBuffers) {
    _drawWave(tileId, buf, waveHeads.get(tileId) || 0, frac, waveLiveLvl.get(tileId) || 0);
  }
}
function _drawWave(tileId, buf, head, frac, liveLvl) {
  const tile = document.getElementById(tileId);
  if (!tile) return;
  const canvas = tile.querySelector('.tile-wave');
  if (!canvas) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const n   = WAVE_DISPLAY_N;
  const pxS = W / n;          // pixels per sample
  const cy  = H / 2;
  const amp = cy - 2;

  // Centre hairline — visible at silence
  ctx.beginPath();
  ctx.moveTo(0, cy); ctx.lineTo(W, cy);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Map linear level [0,1] → display deviation using a dB scale.
  // Human hearing is logarithmic; a linear or power curve compresses the range
  // so quiet and loud look similar. Floor at -30 dB (lvl ≈ 0.032) = silence.
  const MIN_DB = -30;
  const lvlToDev = lvl => {
    if (lvl < 0.001) return 1;
    const norm = (20 * Math.log10(lvl) - MIN_DB) / -MIN_DB; // 0 at floor, 1 at 0 dBFS
    return Math.max(1, Math.min(amp, norm * amp));
  };

  // Precompute amplitude deviations for n+2 points.
  // n+1 come from the committed buffer; the last is the live preview that fills
  // the right-edge gap introduced by the sub-pixel translate.
  const devs = new Float32Array(n + 2);
  for (let i = 0; i <= n; i++) {
    const si  = ((head - 1 - (n - i)) % WAVE_BUF_SIZE + WAVE_BUF_SIZE * 4) % WAVE_BUF_SIZE;
    devs[i] = lvlToDev(buf[si]);
  }
  devs[n + 1] = lvlToDev(liveLvl);

  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  ctx.translate(-frac * pxS, 0);

  // Filled symmetric waveform: top edge L→R, vertical join, bottom edge R→L, close.
  ctx.beginPath();
  ctx.moveTo(0, cy - devs[0]);
  // Top edge — left to right
  for (let i = 0; i <= n; i++) {
    const mx = (i + 0.5) * pxS;
    const my = (cy - devs[i] + cy - devs[i + 1]) / 2;
    ctx.quadraticCurveTo(i * pxS, cy - devs[i], mx, my);
  }
  ctx.lineTo((n + 1) * pxS, cy - devs[n + 1]);
  // Vertical join at right edge
  ctx.lineTo((n + 1) * pxS, cy + devs[n + 1]);
  // Bottom edge — right to left (mirror)
  for (let i = n + 1; i >= 1; i--) {
    const mx = (i - 0.5) * pxS;
    const my = (cy + devs[i] + cy + devs[i - 1]) / 2;
    ctx.quadraticCurveTo(i * pxS, cy + devs[i], mx, my);
  }
  ctx.lineTo(0, cy + devs[0]);
  ctx.closePath();

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();

  ctx.restore();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderLocalParticipant() {
  emptyMsg?.remove();
  const lp = room.localParticipant;
  const tile = createTile(lp.identity, true, `${labelFor(lp)} (you)`);

  lp.videoTrackPublications.forEach(pub => {
    if (pub.track && pub.source === Track.Source.Camera) {
      attachVideoToTile(tile, pub.track);
    }
  });

  stage.appendChild(tile);
  layoutTiles();
}

function renderRemoteParticipant(participant) {
  if (document.getElementById(`tile-${participant.identity}`)) return;
  const tile = createTile(participant.identity, false, labelFor(participant));

  participant.videoTrackPublications.forEach(pub => {
    if (pub.track && pub.isSubscribed && pub.source === Track.Source.Camera) {
      attachVideoToTile(tile, pub.track);
    }
  });
  participant.audioTrackPublications.forEach(pub => {
    if (pub.track && pub.isSubscribed) {
      const audioEl = pub.track.attach();
      if (audioEl && activeSpkDeviceId && typeof audioEl.setSinkId === 'function') {
        audioEl.setSinkId(activeSpkDeviceId).catch(() => {});
      }
      const sid = pub.track.sid || pub.trackSid;
      if (sid) remoteAudioTrackSids.set(participant.identity, sid);
    }
  });

  stage.appendChild(tile);
  layoutTiles();
  if (raisedHands.has(participant.identity)) {
    updateHandIndicator(participant.identity, true);
  }
}

function createTile(tileId, isLocal, labelText) {
  const tile = document.createElement('div');
  tile.className = 'participant-tile' + (isLocal ? ' local' : '');
  tile.id = `tile-${tileId}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const label = document.createElement('div');
  label.className = 'tile-label';

  const qualDot = document.createElement('span');
  qualDot.className = 'quality-dot unknown';

  label.appendChild(qualDot);
  label.appendChild(document.createTextNode(labelText));
  if (!tileId.endsWith('-screen')) {
    const latencyEl = document.createElement('span');
    latencyEl.className = 'latency-ms';
    label.appendChild(latencyEl);
  }

  const muteIcon = document.createElement('div');
  muteIcon.className = 'tile-muted';
  muteIcon.style.display = 'none';
  muteIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="1" y1="1" x2="23" y2="23"/>
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
    <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
  </svg>`;

  tile.appendChild(video);
  tile.appendChild(label);
  tile.appendChild(muteIcon);

  // Hand indicator — only on camera tiles, not screen-share tiles
  if (!tileId.endsWith('-screen')) {
    const handEl = document.createElement('div');
    handEl.className = 'tile-hand';
    handEl.style.display = 'none';
    handEl.textContent = '✋';
    if (IS_HOST) {
      handEl.title = 'Click to lower hand';
      handEl.addEventListener('click', e => {
        e.stopPropagation();
        clearHand(tileId.replace(/^tile-/, ''));
      });
    }
    tile.appendChild(handEl);
  }

  // Scrolling waveform strip — camera tiles only, full-width at bottom of tile
  if (!tileId.endsWith('-screen')) {
    const waveCanvas = document.createElement('canvas');
    waveCanvas.className = 'tile-wave';
    if (!waveformEnabled) waveCanvas.style.display = 'none';
    tile.appendChild(waveCanvas);
    waveBuffers.set(tile.id, new Float32Array(WAVE_BUF_SIZE));
    waveHeads.set(tile.id, 0);
    wavePeakAccum.set(tile.id, 0);
    waveLiveLvl.set(tile.id, 0);
    startWaveAnimation();
  }

  // Pin / unpin this tile to the stage (per-user, local only)
  const pinBtn = document.createElement('button');
  pinBtn.className = 'tile-pin';
  pinBtn.title = 'Pin to stage';
  pinBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="12" y1="17" x2="12" y2="22"/>
    <path d="M9 10.8V7a3 3 0 0 1 6 0v3.8a2 2 0 0 0 .59 1.42L17 13.5V15H7v-1.5l1.41-1.28A2 2 0 0 0 9 10.8z"/>
  </svg>`;
  pinBtn.addEventListener('click', e => {
    e.stopPropagation();
    togglePin(tile.id);
  });
  tile.appendChild(pinBtn);

  // Moderation overlay (host only, non-self, non-screen tiles)
  if (IS_HOST && !isLocal && !tileId.endsWith('-screen')) {
    const modOverlay = document.createElement('div');
    modOverlay.className = 'mod-overlay';

    const muteBtn = document.createElement('button');
    muteBtn.className = 'mod-btn mod-btn-mute';
    muteBtn.title = 'Mute mic';
    muteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
    muteBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const participantIdentity = tileId;
      const trackSid = remoteAudioTrackSids.get(participantIdentity);
      if (!trackSid) { showToast('Audio track not found — participant may not have a mic active'); return; }
      const newMuted = !muteBtn.classList.contains('active');
      // Optimistic update so rapid clicks don't double-fire the same state
      muteBtn.classList.toggle('active', newMuted);
      muteBtn.title = newMuted ? 'Unmute mic' : 'Mute mic';
      if (!newMuted) {
        // Unmuting: ask the participant to unmute themselves via data channel.
        // LiveKit's server-side unmute requires enable_remote_unmute config;
        // the data-channel approach works regardless.
        await broadcastData({ type: 'force_unmute', identity: participantIdentity });
        showToast(`${labelText} unmuted`);
      } else {
        try {
          const res = await fetch(`/api/session/${SESSION_ID}/mute/${encodeURIComponent(participantIdentity)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host_token: HOST_TOKEN, track_sid: trackSid, muted: true }),
          });
          if (res.ok) showToast(`${labelText} muted`);
          else {
            muteBtn.classList.remove('active');
            muteBtn.title = 'Mute mic';
            showToast('Mute failed');
          }
        } catch (err) {
          muteBtn.classList.remove('active');
          muteBtn.title = 'Mute mic';
          showToast('Mute failed');
        }
      }
    });

    const kickBtn = document.createElement('button');
    kickBtn.className = 'mod-btn mod-btn-kick';
    kickBtn.title = 'Kick participant';
    kickBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    kickBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const participantIdentity = tileId;
      if (!confirm(`Remove ${labelText} from the session?`)) return;
      try {
        const res = await fetch(`/api/session/${SESSION_ID}/kick/${encodeURIComponent(participantIdentity)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host_token: HOST_TOKEN }),
        });
        if (res.ok) showToast(`${labelText} removed`);
        else showToast('Kick failed');
      } catch (err) { showToast('Kick failed'); }
    });

    modOverlay.appendChild(muteBtn);
    modOverlay.appendChild(kickBtn);
    tile.appendChild(modOverlay);
  }

  tileOrder.push(tile.id);
  return tile;
}

function removeTile(id) {
  waveBuffers.delete(id);
  waveHeads.delete(id);
  wavePeakAccum.delete(id);
  waveLiveLvl.delete(id);
  if (waveBuffers.size === 0) stopWaveAnimation();
  document.getElementById(id)?.remove();
  const idx = tileOrder.indexOf(id);
  if (idx !== -1) tileOrder.splice(idx, 1);
  pinnedIds.delete(id);
  if (activeSpeakerTileId === id) activeSpeakerTileId = null;
}

function attachVideoToTile(tile, track) {
  const video = tile.querySelector('video');
  track.attach(video);
}

function updateMuteIndicator(tile, participant) {
  const muteEl = tile.querySelector('.tile-muted');
  if (!muteEl) return;
  let micPubs = [...participant.audioTrackPublications.values()]
    .filter(pub => pub.source === Track.Source.Microphone);
  const muted = micPubs.length === 0 || micPubs.every(pub => pub.isMuted);
  muteEl.style.display = muted ? 'flex' : 'none';
  // Keep the host's force-mute button in sync with the actual track state
  const modMuteBtn = tile.querySelector('.mod-btn-mute');
  if (modMuteBtn) {
    modMuteBtn.classList.toggle('active', muted);
    modMuteBtn.title = muted ? 'Unmute mic' : 'Mute mic';
  }
}

function updateQualityIndicator(tile, quality) {
  const dot = tile.querySelector('.quality-dot');
  if (!dot) return;
  dot.className = 'quality-dot';
  if (quality === ConnectionQuality.Excellent || quality === ConnectionQuality.Good) {
    dot.classList.add('good');
  } else if (quality === ConnectionQuality.Poor) {
    dot.classList.add('fair');
  } else if (quality === ConnectionQuality.Lost) {
    dot.classList.add('poor');
  } else {
    dot.classList.add('unknown');
  }
}

// ── Layout engine ────────────────────────────────────────────────────────────
//
// Tiles live in two regions: #stage (large) and #filmstrip (thumbnails).
// layoutTiles() decides which tiles go where based on the current view mode,
// pins, screen shares and the active speaker, then reparents them. Moving a
// tile element keeps its attached <video> stream playing — no re-subscribe.

function focusTileIds() {
  const ids = tileOrder.filter(id => document.getElementById(id));

  // Grid mode with nothing pinned: every tile is equal — all on the stage.
  if (viewMode === 'grid' && pinnedIds.size === 0) {
    return new Set(ids);
  }

  const focus = new Set();
  // Pinned tiles are always featured.
  for (const id of ids) if (pinnedIds.has(id)) focus.add(id);
  // Screen shares are almost always what you want to watch — auto-feature them.
  for (const id of ids) if (id.endsWith('-screen')) focus.add(id);
  // Spotlight mode features the active speaker when nothing is pinned.
  if (viewMode === 'spotlight' && activeSpeakerTileId && ids.includes(activeSpeakerTileId)) {
    focus.add(activeSpeakerTileId);
  }
  // Always keep at least one tile on the stage.
  if (focus.size === 0) {
    if (viewMode === 'spotlight' && ids.length) focus.add(ids[0]);
    else return new Set(ids);
  }
  return focus;
}

function applyRegion(container, desiredIds) {
  // Skip if the region already holds exactly these tiles in this order —
  // avoids needless reparenting (which can briefly flicker video).
  const current = [...container.children]
    .filter(c => c.classList.contains('participant-tile'))
    .map(c => c.id);
  if (current.length === desiredIds.length && current.every((id, i) => id === desiredIds[i])) {
    return;
  }
  for (const id of desiredIds) {
    const el = document.getElementById(id);
    if (el) container.appendChild(el);
  }
}

function layoutTiles() {
  if (!stage || !filmstrip) return;
  const ids = tileOrder.filter(id => document.getElementById(id));
  const focus = focusTileIds();
  const onStage = ids.filter(id => focus.has(id));
  const thumbs  = ids.filter(id => !focus.has(id));

  applyRegion(stage, onStage);
  applyRegion(filmstrip, thumbs);

  stage.className = 'stage s' + Math.min(Math.max(onStage.length, 1), 6);
  filmstrip.classList.toggle('hidden', thumbs.length === 0);
  grid.className = 'video-grid ' + (thumbs.length ? 'view-stage' : 'view-grid');

  updatePinIndicators();
}

function updatePinIndicators() {
  for (const id of tileOrder) {
    const el = document.getElementById(id);
    if (!el) continue;
    const pinned = pinnedIds.has(id);
    el.classList.toggle('pinned', pinned);
    el.querySelector('.tile-pin')?.classList.toggle('active', pinned);
  }
}

function togglePin(tileId) {
  if (pinnedIds.has(tileId)) pinnedIds.delete(tileId);
  else pinnedIds.add(tileId);
  layoutTiles();
}

function setViewMode(mode) {
  viewMode = mode;
  try { localStorage.setItem(VIEW_KEY, mode); } catch (e) {}
  btnView?.classList.toggle('active', mode === 'spotlight');
  layoutTiles();
}

// ── Controls ─────────────────────────────────────────────────────────────────

function closeAllDeviceDropdowns() {
  document.getElementById('mic-dropdown')?.classList.remove('open');
  document.getElementById('cam-dropdown')?.classList.remove('open');
  document.getElementById('btn-mic-caret')?.classList.remove('open');
  document.getElementById('btn-cam-caret')?.classList.remove('open');
}

async function openDeviceDropdown(kind) {
  const dropdownId = kind === 'audioinput' ? 'mic-dropdown' : 'cam-dropdown';
  const caretId    = kind === 'audioinput' ? 'btn-mic-caret' : 'btn-cam-caret';
  const dropdown   = document.getElementById(dropdownId);
  if (!dropdown) return;

  dropdown.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'device-dropdown-label';
  label.textContent = kind === 'audioinput' ? 'Microphone' : 'Camera';
  dropdown.appendChild(label);

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const activeId = kind === 'audioinput' ? activeMicDeviceId : activeCamDeviceId;
    let idx = 0;
    devices.filter(d => d.kind === kind).forEach(d => {
      const btn = document.createElement('button');
      btn.className = 'device-dropdown-item' + (d.deviceId === activeId ? ' active' : '');
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = d.deviceId === activeId ? '✓' : '';
      btn.appendChild(check);
      const name = document.createTextNode(d.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${++idx}`);
      btn.appendChild(name);
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        closeAllDeviceDropdowns();
        if (kind === 'audioinput') {
          activeMicDeviceId = d.deviceId;
          try { localStorage.setItem(DEVICE_KEY_MIC, d.deviceId); } catch (_e) {}
          try { await room.switchActiveDevice('audioinput', d.deviceId); } catch (err) {}
          if (isRecording && pcmNode) await restartPcmCapture();
        } else {
          activeCamDeviceId = d.deviceId;
          try { localStorage.setItem(DEVICE_KEY_CAM, d.deviceId); } catch (_e) {}
          try { await room.switchActiveDevice('videoinput', d.deviceId); } catch (err) {}
        }
      });
      dropdown.appendChild(btn);
    });
  } catch (e) {
    console.warn('Could not enumerate devices:', e);
  }

  // Append speaker section to mic dropdown if supported
  if (kind === 'audioinput' && typeof HTMLMediaElement.prototype.setSinkId === 'function') {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const outputDevices = allDevices.filter(d => d.kind === 'audiooutput');
      if (outputDevices.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'device-dropdown-divider';
        dropdown.appendChild(divider);
        const spkLabel = document.createElement('div');
        spkLabel.className = 'device-dropdown-label';
        spkLabel.textContent = 'Speaker / Headphones';
        dropdown.appendChild(spkLabel);
        let idx = 0;
        outputDevices.forEach(d => {
          const btn = document.createElement('button');
          btn.className = 'device-dropdown-item' + (d.deviceId === activeSpkDeviceId ? ' active' : '');
          const check = document.createElement('span');
          check.className = 'check';
          check.textContent = d.deviceId === activeSpkDeviceId ? '✓' : '';
          btn.appendChild(check);
          btn.appendChild(document.createTextNode(d.label || `Speaker ${++idx}`));
          btn.addEventListener('click', e => {
            e.stopPropagation();
            closeAllDeviceDropdowns();
            updateSpeakerOutput(d.deviceId);
          });
          dropdown.appendChild(btn);
        });
      }
    } catch (e) {}
  }

  dropdown.classList.add('open');
  document.getElementById(caretId)?.classList.add('open');
}

function updateSpeakerOutput(deviceId) {
  activeSpkDeviceId = deviceId;
  try { localStorage.setItem(DEVICE_KEY_SPK, deviceId); } catch (_e) {}
  document.querySelectorAll('audio').forEach(el => {
    if (typeof el.setSinkId === 'function') {
      el.setSinkId(deviceId).catch(() => {});
    }
  });
}

function setupDeviceButtons(micDeviceId, camDeviceId) {
  activeMicDeviceId = micDeviceId;
  activeCamDeviceId = camDeviceId;

  document.getElementById('btn-mic-caret')?.addEventListener('click', async e => {
    e.stopPropagation();
    const isOpen = document.getElementById('mic-dropdown')?.classList.contains('open');
    closeAllDeviceDropdowns();
    if (!isOpen) await openDeviceDropdown('audioinput');
  });
  document.getElementById('btn-cam-caret')?.addEventListener('click', async e => {
    e.stopPropagation();
    const isOpen = document.getElementById('cam-dropdown')?.classList.contains('open');
    closeAllDeviceDropdowns();
    if (!isOpen) await openDeviceDropdown('videoinput');
  });

  if (typeof HTMLMediaElement.prototype.setSinkId === 'function' && activeSpkDeviceId) {
    updateSpeakerOutput(activeSpkDeviceId);
  }
}

function setupControls() {
  document.addEventListener('click', closeAllDeviceDropdowns);

  btnRaiseHand?.addEventListener('click', toggleHand);

  // Restore the user's saved layout preference, then wire the toggle.
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'grid' || saved === 'spotlight') viewMode = saved;
  } catch (e) {}
  // Waveform toggle — restore saved pref and wire the button
  document.getElementById('btn-wave')?.classList.toggle('active', waveformEnabled);
  document.getElementById('btn-wave')?.addEventListener('click', toggleWaveform);

  btnView?.classList.toggle('active', viewMode === 'spotlight');
  btnView?.addEventListener('click', () => {
    setViewMode(viewMode === 'grid' ? 'spotlight' : 'grid');
    showToast(`Layout: ${viewMode === 'spotlight' ? 'Active speaker' : 'Grid'}`);
  });

  // Fullscreen toggle with auto-hide header/controls on mouse idle
  let fsHideTimer = null;
  const FS_ICON_EXPAND   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
  const FS_ICON_COMPRESS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 0 2-2h3M3 16h3a2 2 0 0 0 2 2v3"/></svg>`;

  function applyFullscreenState(isFS) {
    document.body.classList.toggle('is-fullscreen', isFS);
    btnFullscreen?.classList.toggle('active', isFS);
    if (btnFullscreen) {
      btnFullscreen.innerHTML = isFS ? FS_ICON_COMPRESS : FS_ICON_EXPAND;
      btnFullscreen.title = isFS ? 'Exit fullscreen' : 'Fullscreen';
    }
    if (!isFS) {
      document.body.classList.remove('controls-peek');
      clearTimeout(fsHideTimer);
    }
  }

  btnFullscreen?.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', () => {
    applyFullscreenState(!!document.fullscreenElement);
  });

  document.addEventListener('mousemove', () => {
    if (!document.body.classList.contains('is-fullscreen')) return;
    document.body.classList.add('controls-peek');
    clearTimeout(fsHideTimer);
    fsHideTimer = setTimeout(() => document.body.classList.remove('controls-peek'), 3000);
  });

  btnChat?.addEventListener('click', () => {
    const open = chatPanel?.classList.toggle('open');
    btnChat.classList.toggle('active', open);
    document.querySelector('.studio-layout')?.classList.toggle('chat-open', open);
    if (open) {
      chatInput?.focus();
      btnChat.classList.remove('chat-unread');
    }
  });
  btnChatSend?.addEventListener('click', sendChat);
  chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  btnFiles?.addEventListener('click', e => {
    e.stopPropagation();
    const open = filesPanel.style.display !== 'none';
    filesPanel.style.display = open ? 'none' : 'flex';
    if (!open) fetchFiles();
  });
  filesPanel?.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => {
    if (filesPanel && filesPanel.style.display !== 'none') {
      filesPanel.style.display = 'none';
    }
  });

  recIndicator?.addEventListener('click', e => {
    e.stopPropagation();
    recIndicator.classList.toggle('popover-open');
  });
  document.addEventListener('click', e => {
    if (recIndicator && !recIndicator.contains(e.target)) {
      recIndicator.classList.remove('popover-open');
    }
  });

  let statsHideTimer = null;
  function showStatsPanel() {
    clearTimeout(statsHideTimer);
    if (statsPanel) statsPanel.style.display = 'flex';
    latencyWrap?.classList.add('active');
    if (!statsInterval) {
      updateStatsPanel();
      statsInterval = setInterval(updateStatsPanel, 2000);
    }
  }
  function hideStatsPanel() {
    statsHideTimer = setTimeout(() => {
      if (statsPanel) statsPanel.style.display = 'none';
      latencyWrap?.classList.remove('active');
      clearInterval(statsInterval);
      statsInterval = null;
    }, 150);
  }
  latencyWrap?.addEventListener('mouseenter', showStatsPanel);
  latencyWrap?.addEventListener('mouseleave', hideStatsPanel);
  statsPanel?.addEventListener('mouseenter', () => clearTimeout(statsHideTimer));
  statsPanel?.addEventListener('mouseleave', hideStatsPanel);

  btnMic?.addEventListener('click', async () => {
    const enabled = room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(!enabled);
    micMuted = enabled; // enabled=true → we just muted; false → we just unmuted
    btnMic.classList.toggle('muted', enabled);
    btnMic.closest('.device-btn-group')?.classList.toggle('muted', enabled);
  });

  btnCam?.addEventListener('click', async () => {
    const enabled = room.localParticipant.isCameraEnabled;
    await room.localParticipant.setCameraEnabled(!enabled);
    btnCam.classList.toggle('muted', enabled);
    btnCam.closest('.device-btn-group')?.classList.toggle('muted', enabled);
  });

  btnScreen?.addEventListener('click', async () => {
    const isSharing = room.localParticipant.isScreenShareEnabled;
    try {
      await room.localParticipant.setScreenShareEnabled(!isSharing);
      btnScreen.classList.toggle('active', !isSharing);

      if (!isSharing) {
        // Render our own screen share tile
        room.localParticipant.videoTrackPublications.forEach(pub => {
          if (pub.source === Track.Source.ScreenShare && pub.track) {
            const tile = createTile(identity + '-screen', false, `${displayName} (screen)`);
            stage.appendChild(tile);
            attachVideoToTile(tile, pub.track);
            layoutTiles();
          }
        });
        // Start recording the screen if recording is already in progress
        if (isRecording && !screenRecorder) {
          startScreenRecording();
        }
      } else {
        cleanupLocalScreen();
      }
    } catch (e) {
      // User cancelled the picker or permission denied
    }
  });

  btnLeave?.addEventListener('click', leaveSession);
  btnAlertDismiss?.addEventListener('click', () => alertBanner?.classList.add('hidden'));

  btnAlert?.addEventListener('click', e => {
    e.stopPropagation();
    const open = alertPanel?.style.display !== 'none';
    if (alertPanel) alertPanel.style.display = open ? 'none' : 'flex';
    btnAlert?.classList.toggle('active', !open);
  });
  btnAlertSend?.addEventListener('click', () => {
    const text = alertCustom?.value.trim();
    if (text) { sendAlert(text); alertCustom.value = ''; }
  });
  alertCustom?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const text = alertCustom.value.trim();
      if (text) { sendAlert(text); alertCustom.value = ''; }
    }
  });
  document.addEventListener('click', e => {
    if (alertPanel && alertPanel.style.display !== 'none' && !alertPanel.contains(e.target) && e.target !== btnAlert) {
      alertPanel.style.display = 'none';
      btnAlert?.classList.remove('active');
    }
  });

  const topicPopover = document.getElementById('topic-popover');
  const btnTopicStamp = document.getElementById('btn-topic-stamp');
  btnNewTopic?.addEventListener('click', e => {
    e.stopPropagation();
    const open = topicPopover?.classList.contains('open');
    topicPopover?.classList.toggle('open', !open);
    btnNewTopic.classList.toggle('active', !open);
    if (!open) topicInput?.focus();
  });
  btnTopicStamp?.addEventListener('click', () => createMarker());
  topicInput?.addEventListener('keydown', e => { if (e.key === 'Enter') createMarker(); });
  document.addEventListener('click', e => {
    if (topicPopover?.classList.contains('open') &&
        !topicPopover.contains(e.target) && e.target !== btnNewTopic) {
      topicPopover.classList.remove('open');
      btnNewTopic?.classList.remove('active');
    }
  });

  if (IS_HOST) {
    btnRecord?.addEventListener('click', startRecording);
    btnStopRec?.addEventListener('click', stopRecording);
    btnEnd?.addEventListener('click', endSession);
    btnShowShare?.addEventListener('click', () => {
      shareWrap.style.display = shareWrap.style.display === 'none' ? 'flex' : 'none';
    });
    btnCopy?.addEventListener('click', () => {
      navigator.clipboard.writeText(JOIN_LINK);
      showToast('Link copied!');
    });
  }

  setupTimerBar();
  if (IS_HOST) setupTimerControls();
  setupKeyboardShortcuts();
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (document.activeElement?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        btnMic?.click();
        break;
      case 'm':
      case 'M':
        if (isRecording) { e.preventDefault(); btnNewTopic?.click(); }
        break;
      case 'r':
      case 'R':
        if (IS_HOST) {
          e.preventDefault();
          if (isRecording) btnStopRec?.click();
          else btnRecord?.click();
        }
        break;
      case 'a':
      case 'A':
        e.preventDefault();
        document.getElementById('btn-alert')?.click();
        break;
      case 'c':
      case 'C':
        e.preventDefault();
        document.getElementById('btn-chat')?.click();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        document.getElementById('btn-fullscreen')?.click();
        break;
      case 'h':
      case 'H':
        e.preventDefault();
        document.getElementById('btn-raise-hand')?.click();
        break;
      case 't':
      case 'T':
        if (IS_HOST) { e.preventDefault(); document.getElementById('btn-timer')?.click(); }
        break;
    }
  });
}

// ── Alert ─────────────────────────────────────────────────────────────────────

async function sendAlert(text) {
  if (!text) return;
  await broadcastData({ type: 'alert', text });
  showAlertBanner(text);
  if (alertPanel) alertPanel.style.display = 'none';
  btnAlert?.classList.remove('active');
}

let alertBannerTimer = null;
function showAlertBanner(text) {
  if (!alertBanner || !alertBannerText) return;
  alertBannerText.textContent = text;
  alertBanner.classList.remove('hidden');
  clearTimeout(alertBannerTimer);
  alertBannerTimer = setTimeout(() => alertBanner?.classList.add('hidden'), 8000);
}

// ── Session end ──────────────────────────────────────────────────────────────

async function leaveSession() {
  const busy = uploadPending || isRecording;
  const msg = busy
    ? 'Recordings are still uploading — leaving now may lose data.\n\nLeave anyway?'
    : 'Leave this session?';
  if (!confirm(msg)) return;

  if (isRecording) {
    await stopLocalRecording();
    setRecordingUI(false);
  }

  showUploadBanner('uploading');
  await Promise.allSettled([uploadQueues.audio, uploadQueues.video, uploadQueues.screen]);
  // Clear flag so onBeforeUnload doesn't fire a second confirmation on navigation
  uploadPending = false;

  try { await room?.disconnect(); } catch (e) {}
  window.location.href = '/';
}

async function endSession() {
  const busy = uploadPending || isRecording;
  const msg = busy
    ? 'End this session for everyone? Recordings will finish uploading before you are redirected.'
    : 'End this session for everyone?';
  if (!confirm(msg)) return;

  if (isRecording) {
    await stopLocalRecording();
    setRecordingUI(false);
  }

  // Broadcast and API call are best-effort — don't let either crash the flow
  try { await broadcastData({ type: 'session_ended' }); } catch (e) {}
  try {
    await fetch(`/api/session/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: HOST_TOKEN }),
    });
  } catch (e) { console.warn('End session API failed:', e); }

  showUploadBanner('uploading');
  await Promise.allSettled([uploadQueues.audio, uploadQueues.video, uploadQueues.screen]);
  // Clear flag so onBeforeUnload doesn't fire a second confirmation on navigation
  uploadPending = false;

  try { await room?.disconnect(); } catch (e) {}
  window.location.href = '/dashboard';
}

async function handleSessionEnded() {
  if (isRecording) {
    await stopLocalRecording();
    setRecordingUI(false);
  }
  showUploadBanner('uploading');
  const _unloadGuard = e => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', _unloadGuard);
  await new Promise(r => setTimeout(r, 100));
  await Promise.allSettled([uploadQueues.audio, uploadQueues.video, uploadQueues.screen]);
  window.removeEventListener('beforeunload', _unloadGuard);

  // If cloud upload is configured, send guests to the local upload page so they
  // can upload their own recordings without needing to copy a link separately.
  if (typeof UPLOAD_TOKEN === 'string' && UPLOAD_TOKEN && typeof SESSION_ID === 'string') {
    const params = new URLSearchParams({ token: UPLOAD_TOKEN });
    if (typeof displayName === 'string' && displayName) params.set('participant', displayName);
    window.location.href = `/local-upload/${SESSION_ID}?${params}`;
  } else {
    window.location.href = '/';
  }
}

// ── Waiting room (host only) ─────────────────────────────────────────────────

let _waitroomIdentities = new Set();

function playAdmitChime() {
  try {
    const ctx = new AudioContext();
    const freqs = [880, 1100, 1320];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t);
      osc.stop(t + 0.35);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch (e) {}
}

function pollPendingGuests() {
  if (!IS_HOST) return;
  setInterval(async () => {
    try {
      const r = await fetch(`/api/session/${SESSION_ID}/pending-guests?host_token=${encodeURIComponent(HOST_TOKEN)}`);
      if (!r.ok) return;
      const { guests } = await r.json();
      updateWaitroomPanel(guests);
    } catch (e) {}
  }, 3000);
}

function updateWaitroomPanel(guests) {
  const panel = document.getElementById('waitroom-panel');
  const list  = document.getElementById('waitroom-list');
  if (!panel || !list) return;

  const newIdentities = new Set(guests.map(g => g.identity));
  const hasNew = [...newIdentities].some(id => !_waitroomIdentities.has(id));
  if (hasNew) playAdmitChime();
  _waitroomIdentities = newIdentities;

  list.innerHTML = '';
  guests.forEach(({ identity: gid, display_name: name }) => {
    const li = document.createElement('li');
    li.className = 'waitroom-item';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    const admitBtn = document.createElement('button');
    admitBtn.className = 'waitroom-admit';
    admitBtn.textContent = 'Admit';
    admitBtn.addEventListener('click', () => admitGuest(gid, li));
    const denyBtn = document.createElement('button');
    denyBtn.className = 'waitroom-deny';
    denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', () => denyGuest(gid, li));
    li.appendChild(nameSpan);
    li.appendChild(admitBtn);
    li.appendChild(denyBtn);
    list.appendChild(li);
  });
  panel.style.display = guests.length ? 'flex' : 'none';
}

async function admitGuest(guestIdentity, li) {
  try {
    const r = await fetch(`/api/session/${SESSION_ID}/admit/${encodeURIComponent(guestIdentity)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: HOST_TOKEN }),
    });
    if (r.ok && li) li.remove();
  } catch (e) {
    showToast('Failed to admit guest');
  }
}

async function denyGuest(guestIdentity, li) {
  try {
    const r = await fetch(`/api/session/${SESSION_ID}/deny/${encodeURIComponent(guestIdentity)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: HOST_TOKEN }),
    });
    if (r.ok && li) li.remove();
  } catch (e) {
    showToast('Failed to deny guest');
  }
}

// ── Latency measurement ──────────────────────────────────────────────────────

function startLatencyMeasure() {
  if (latencyInterval) return;
  setTimeout(measureAndBroadcastLatency, 1500);
  latencyInterval = setInterval(measureAndBroadcastLatency, 4000);
}

async function measureAndBroadcastLatency() {
  if (!room?.localParticipant) return;
  let rttMs = null;

  // WebRTC candidate-pair stats give true media-path RTT to the SFU
  try {
    const pc = room?.engine?.publisher?.pc;
    if (pc) {
      const stats = await pc.getStats();
      for (const stat of stats.values()) {
        if (stat.type === 'candidate-pair' && stat.nominated && stat.currentRoundTripTime != null) {
          rttMs = Math.round(stat.currentRoundTripTime * 1000);
          break;
        }
      }
    }
  } catch (e) {}

  // Fallback: HTTP round-trip time
  if (rttMs == null) {
    try {
      const t0 = performance.now();
      await fetch(`/api/session/${SESSION_ID}/status`);
      rttMs = Math.round(performance.now() - t0);
    } catch (e) {}
  }

  if (rttMs == null) return;
  localRttMs = rttMs;

  updateLatencyBadge(document.getElementById(`tile-${identity}`), rttMs);

  const val = document.getElementById('latency-value');
  if (latencyWrap && val) {
    val.textContent = `${rttMs}ms`;
    latencyWrap.classList.remove('good', 'fair', 'poor');
    latencyWrap.title = `Your RTT to server: ${rttMs}ms — click for details`;
    if (rttMs < 80)       latencyWrap.classList.add('good');
    else if (rttMs < 150) latencyWrap.classList.add('fair');
    else                  latencyWrap.classList.add('poor');
  }

  // Refresh roundtrip tooltips on all remote tiles
  for (const [remId, theirRtt] of participantLatency) {
    const badge = document.getElementById(`tile-${remId}`)?.querySelector('.latency-ms');
    if (badge) badge.title = `~${rttMs + theirRtt}ms roundtrip`;
  }

  await broadcastData({ type: 'latency_report', identity, rttMs });
}

function updateLatencyBadge(tile, rttMs) {
  if (!tile) return;
  const badge = tile.querySelector('.latency-ms');
  if (!badge) return;
  badge.textContent = `${rttMs}ms`;
  badge.classList.remove('good', 'fair', 'poor');
  if (rttMs < 80)       badge.classList.add('good');
  else if (rttMs < 150) badge.classList.add('fair');
  else                  badge.classList.add('poor');
}

// ── Stats panel ──────────────────────────────────────────────────────────────

async function updateStatsPanel() {
  const content = document.getElementById('stats-content');
  if (!content) return;

  // pcManager is the correct path in LiveKit v2; fall back to top-level for older builds.
  function resolvePc(transport) {
    if (!transport) return null;
    const candidate = transport.pc ?? transport.peerConnection ?? transport._pc;
    return (candidate && typeof candidate.getStats === 'function') ? candidate : null;
  }
  const engine = room?.engine;
  const pubPc = resolvePc(engine?.pcManager?.publisher) ?? resolvePc(engine?.publisher);
  const subPc = resolvePc(engine?.pcManager?.subscriber) ?? resolvePc(engine?.subscriber);

  const now = performance.now();
  const allStats = new Map();
  // Namespace each PC's stats to prevent ID collisions (pub vs sub generate independent IDs).
  async function collectPc(pc, prefix) {
    if (!pc) return;
    try {
      (await pc.getStats()).forEach((v, k) => {
        const id = prefix + k;
        allStats.set(id, { ...v, id, codecId: v.codecId ? prefix + v.codecId : undefined });
      });
    } catch (e) {}
  }
  await Promise.all([collectPc(pubPc, 'p:'), collectPc(subPc, 's:')]);

  function codecMime(codecId) {
    const c = allStats.get(codecId);
    return c ? (c.mimeType || '').split('/')[1] || '' : '';
  }

  function trackDeltas(statId, bytes, frames) {
    const prev = prevRtcStats[statId];
    const dt = prev?.ts ? (now - prev.ts) / 1000 : null;
    const bitrate = (dt && dt > 0 && prev.bytes != null && bytes != null)
      ? Math.round((bytes - prev.bytes) * 8 / dt / 1000) : null;
    const fps = (dt && dt > 0 && prev.frames != null && frames != null)
      ? Math.round((frames - prev.frames) / dt) : null;
    prevRtcStats[statId] = { ts: now, bytes, frames };
    return { bitrate, fps };
  }

  function fmtKbps(kbps) {
    if (kbps == null || kbps <= 0) return '—';
    return kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : kbps + ' kbps';
  }

  // ── Outbound (what we send) ──
  // LiveKit simulcast produces multiple outbound-rtp video entries (one per layer).
  // Aggregate: sum bitrates, pick resolution/fps from the highest-bitrate active layer.
  const sendVideoLayers = [], sendAudio = [];
  for (const stat of allStats.values()) {
    if (stat.type !== 'outbound-rtp') continue;
    const { bitrate, fps } = trackDeltas(stat.id, stat.bytesSent, stat.framesEncoded ?? null);
    if (stat.kind === 'video') {
      sendVideoLayers.push({ width: stat.frameWidth, height: stat.frameHeight, fps, bitrate, codec: codecMime(stat.codecId) });
    } else {
      sendAudio.push({ bitrate, codec: codecMime(stat.codecId) });
    }
  }
  const sendVideo = [];
  if (sendVideoLayers.length) {
    const totalBitrate = sendVideoLayers.some(v => v.bitrate != null)
      ? sendVideoLayers.reduce((s, v) => s + (v.bitrate || 0), 0) : null;
    const best = sendVideoLayers.reduce((a, b) => (b.bitrate || 0) > (a.bitrate || 0) ? b : a, sendVideoLayers[0]);
    const maxFps = sendVideoLayers.reduce((m, v) => Math.max(m, v.fps || 0), 0);
    sendVideo.push({ width: best.width, height: best.height, fps: maxFps || null, bitrate: totalBitrate, codec: best.codec });
  }

  // ── Remote-inbound (server feedback: loss on our outgoing streams) ──
  let outLossPct = null;
  for (const stat of allStats.values()) {
    if (stat.type !== 'remote-inbound-rtp') continue;
    if (stat.fractionLost != null && outLossPct == null) {
      outLossPct = (stat.fractionLost * 100).toFixed(1);
    }
  }

  // ── Inbound (what we receive) ──
  const recvVideo = [], recvAudio = [];
  for (const stat of allStats.values()) {
    if (stat.type !== 'inbound-rtp') continue;
    const { bitrate, fps } = trackDeltas(stat.id, stat.bytesReceived, stat.framesDecoded ?? null);
    const total = (stat.packetsReceived || 0) + (stat.packetsLost || 0);
    const loss = total > 10 ? ((stat.packetsLost || 0) / total * 100).toFixed(1) : null;
    const jitter = stat.jitter != null ? Math.round(stat.jitter * 1000) : null;
    if (stat.kind === 'video') {
      recvVideo.push({
        width: stat.frameWidth, height: stat.frameHeight,
        fps, bitrate, codec: codecMime(stat.codecId), loss, jitter,
      });
    } else {
      recvAudio.push({ bitrate, codec: codecMime(stat.codecId), loss, jitter });
    }
  }

  // ── Connection path info ──
  let connType = null, connProto = null;
  for (const stat of allStats.values()) {
    if (stat.type === 'candidate-pair' && stat.nominated) {
      const local = allStats.get(stat.localCandidateId);
      if (local) {
        connType = local.candidateType === 'relay' ? 'TURN relay'
                 : local.candidateType === 'srflx' ? 'STUN (srflx)'
                 : 'direct';
        connProto = (local.protocol || '').toUpperCase();
      }
      break;
    }
  }

  // ── Build HTML ──
  function row(label, val) {
    return `<div class="stats-row"><span class="stats-label">${label}</span><span class="stats-val">${val}</span></div>`;
  }
  function section(title) {
    return `<div class="stats-section-title">${title}</div>`;
  }

  let html = '';

  if (sendVideo.length || sendAudio.length) {
    html += section('Send');
    for (const v of sendVideo) {
      const parts = [];
      if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
      if (v.fps != null && v.fps > 0) parts.push(`${v.fps} fps`);
      parts.push(fmtKbps(v.bitrate));
      if (v.codec) parts.push(v.codec.toUpperCase());
      html += row('Video', parts.join(' &middot; '));
    }
    for (const a of sendAudio) {
      const codec = a.codec || (audioFormat === 'pcm' ? 'PCM' : 'Opus');
      html += row('Audio', `${fmtKbps(a.bitrate)} &middot; ${codec.toUpperCase()}`);
    }
    if (outLossPct != null) html += row('Loss', `${outLossPct}%`);
  }

  if (recvVideo.length || recvAudio.length) {
    html += section('Receive');
    for (let i = 0; i < recvVideo.length; i++) {
      const v = recvVideo[i];
      const parts = [];
      if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
      if (v.fps != null && v.fps > 0) parts.push(`${v.fps} fps`);
      parts.push(fmtKbps(v.bitrate));
      if (v.codec) parts.push(v.codec.toUpperCase());
      if (v.loss != null) parts.push(`${v.loss}% loss`);
      if (v.jitter != null) parts.push(`${v.jitter}ms jitter`);
      const label = recvVideo.length > 1 ? `Video ${i + 1}` : 'Video';
      html += row(label, parts.join(' &middot; '));
    }
    for (let i = 0; i < recvAudio.length; i++) {
      const a = recvAudio[i];
      const parts = [fmtKbps(a.bitrate)];
      if (a.codec) parts.push(a.codec.toUpperCase());
      if (a.loss != null) parts.push(`${a.loss}% loss`);
      if (a.jitter != null) parts.push(`${a.jitter}ms jitter`);
      const label = recvAudio.length > 1 ? `Audio ${i + 1}` : 'Audio';
      html += row(label, parts.join(' &middot; '));
    }
  }

  html += section('Connection');
  html += row('RTT', localRttMs != null ? `${localRttMs} ms` : '—');
  if (connType) html += row('Path', connProto ? `${connType} &middot; ${connProto}` : connType);
  html += row('Capture', audioFormat === 'pcm' ? 'PCM (lossless)' : 'Opus (fallback)');

  if (!sendVideo.length && !sendAudio.length && !recvVideo.length && !recvAudio.length && !pubPc && !subPc) {
    html = '<div class="stats-empty">WebRTC stats unavailable in this browser/version</div>' + html;
  }

  content.innerHTML = html || '<div class="stats-empty">Gathering stats…</div>';
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function setupTimerBar() {
  try {
    const v = localStorage.getItem(TIMER_SHOW_KEY);
    if (v !== null) timerShowTime = v !== 'false';
  } catch (e) {}
  applyTimerShowTime();

  btnTimerEye?.addEventListener('click', e => {
    e.stopPropagation();
    timerShowTime = !timerShowTime;
    try { localStorage.setItem(TIMER_SHOW_KEY, String(timerShowTime)); } catch (e) {}
    applyTimerShowTime();
  });
}

function setupTimerControls() {
  btnTimerBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const open = timerPanel?.style.display !== 'none';
    if (timerPanel) timerPanel.style.display = open ? 'none' : 'flex';
    btnTimerBtn.classList.toggle('active', !open);
  });
  timerPanel?.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => {
    if (timerPanel && timerPanel.style.display !== 'none') {
      timerPanel.style.display = 'none';
      btnTimerBtn?.classList.remove('active');
    }
  });

  timerYellowIn?.addEventListener('change', () => {
    timerThresholds.yellow = Math.max(1, parseInt(timerYellowIn.value) || 120);
    timerYellowIn.value = timerThresholds.yellow;
    updateTimerBar();
  });
  timerRedIn?.addEventListener('change', () => {
    timerThresholds.red = Math.max(1, parseInt(timerRedIn.value) || 60);
    timerRedIn.value = timerThresholds.red;
    updateTimerBar();
  });

  btnTimerAdd?.addEventListener('click', addQueueTopic);
  btnTimerCancel?.addEventListener('click', cancelEditTopic);
  timerAddName?.addEventListener('keydown', e => { if (e.key === 'Enter') addQueueTopic(); });

  btnTimerSS?.addEventListener('click', timerStartStop);
  btnTimerP30?.addEventListener('click', timerPlus30);
  btnTimerSkip?.addEventListener('click', timerSkip);
  btnTimerStop?.addEventListener('click', timerStopAll);
}

function addQueueTopic() {
  const name   = timerAddName?.value.trim();
  const durMin = parseFloat(timerAddDur?.value);
  if (!name || !durMin || durMin <= 0) { showToast('Enter a name and duration'); return; }
  const notes = timerAddNotes?.value.trim() || '';
  if (timerEditIndex >= 0 && timerEditIndex < timerQueue.length) {
    timerQueue[timerEditIndex] = { name, duration: Math.round(durMin * 60), notes };
    cancelEditTopic();
  } else {
    timerQueue.push({ name, duration: Math.round(durMin * 60), notes });
    if (timerAddName)  timerAddName.value  = '';
    if (timerAddDur)   timerAddDur.value   = '';
    if (timerAddNotes) timerAddNotes.value = '';
  }
  renderTimerQueue();
}

function startEditTopic(i) {
  timerEditIndex = i;
  const topic = timerQueue[i];
  if (timerAddName)  timerAddName.value  = topic.name;
  if (timerAddDur)   timerAddDur.value   = String(topic.duration / 60);
  if (timerAddNotes) timerAddNotes.value = topic.notes;
  if (btnTimerAdd)   btnTimerAdd.textContent = 'Save Changes';
  if (btnTimerCancel) btnTimerCancel.style.display = '';
  timerAddName?.focus();
  timerAddName?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelEditTopic() {
  timerEditIndex = -1;
  if (timerAddName)   timerAddName.value   = '';
  if (timerAddDur)    timerAddDur.value    = '';
  if (timerAddNotes)  timerAddNotes.value  = '';
  if (btnTimerAdd)    btnTimerAdd.textContent = '+ Add Topic';
  if (btnTimerCancel) btnTimerCancel.style.display = 'none';
}

function jumpToTopic(i) {
  if (!timerState.active || i < 0 || i >= timerQueue.length) return;
  timerState.topicIndex = i;
  timerState.remaining  = timerQueue[i].duration;
  timerState.total      = timerQueue[i].duration;
  timerState.paused     = false;
  timerState.expired    = false;
  if (!timerInterval) startTimerTick();
  broadcastTimerState();
  updateTimerBar();
  syncTimerButtons();
  renderTimerQueue();
}

function renderTimerQueue() {
  if (!timerQueueEl) return;
  // If the topic being edited was removed, clean up the form
  if (timerEditIndex >= timerQueue.length) cancelEditTopic();

  timerQueueEl.innerHTML = '';
  if (!timerQueue.length) {
    const empty = document.createElement('div');
    empty.className = 'timer-queue-empty';
    empty.textContent = 'No topics yet';
    timerQueueEl.appendChild(empty);
    return;
  }
  timerQueue.forEach((topic, i) => {
    const isActive  = timerState.active && timerState.topicIndex === i;
    const isEditing = timerEditIndex === i;
    const row = document.createElement('div');
    row.className = 'timer-queue-row' +
      (isActive  ? ' active'  : '') +
      (isEditing ? ' editing' : '');

    const numEl = document.createElement('span');
    numEl.className = 'timer-queue-num';
    numEl.textContent = (i + 1) + '.';

    const nameEl = document.createElement('span');
    nameEl.className = 'timer-queue-name';
    nameEl.textContent = topic.name;

    const durEl = document.createElement('span');
    durEl.className = 'timer-queue-dur';
    durEl.textContent = fmtTime(topic.duration);

    // Jump to this topic (only when timer is running)
    if (timerState.active) {
      row.classList.add('jumpable');
      row.title = isActive ? 'Currently active' : 'Switch to this topic';
      row.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        if (!isActive) jumpToTopic(i);
      });
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'timer-queue-edit';
    editBtn.title = 'Edit';
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;
    editBtn.addEventListener('click', () => startEditTopic(i));

    const rmBtn = document.createElement('button');
    rmBtn.className = 'timer-queue-remove';
    rmBtn.textContent = '×';
    rmBtn.title = 'Remove';
    rmBtn.addEventListener('click', () => {
      if (timerEditIndex === i) cancelEditTopic();
      timerQueue.splice(i, 1);
      renderTimerQueue();
    });

    row.append(numEl, nameEl, durEl, editBtn, rmBtn);
    timerQueueEl.appendChild(row);
  });
}

function timerStartStop() {
  if (!timerState.active) {
    if (!timerQueue.length) { showToast('Add topics first'); return; }
    timerState.topicIndex = 0;
    timerState.remaining  = timerQueue[0].duration;
    timerState.total      = timerQueue[0].duration;
    timerState.active     = true;
    timerState.paused     = false;
    timerState.expired    = false;
    startTimerTick();
  } else if (timerState.expired) {
    // Restart the current topic with its original duration
    const i = timerState.topicIndex;
    timerState.remaining = timerQueue[i]?.duration ?? timerState.total;
    timerState.total     = timerState.remaining;
    timerState.expired   = false;
    timerState.paused    = false;
    startTimerTick();
  } else if (timerState.paused) {
    timerState.paused = false;
    startTimerTick();
  } else {
    timerState.paused = true;
    clearInterval(timerInterval);
    timerInterval = null;
  }
  broadcastTimerState();
  updateTimerBar();
  syncTimerButtons();
  renderTimerQueue();
}

function timerPlus30() {
  if (!timerState.active) return;
  timerState.remaining += 30;
  broadcastTimerState();
  updateTimerBar();
}

function timerSkip() {
  if (!timerState.active) return;
  const next = timerState.topicIndex + 1;
  if (next >= timerQueue.length) {
    timerStopAll();
    showToast('Timer queue finished');
    return;
  }
  timerState.topicIndex = next;
  timerState.remaining  = timerQueue[next].duration;
  timerState.total      = timerQueue[next].duration;
  timerState.paused     = false;
  timerState.expired    = false;
  if (!timerInterval) startTimerTick();
  broadcastTimerState();
  updateTimerBar();
  syncTimerButtons();
  renderTimerQueue();
}

function timerStopAll() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerState = { active: false, paused: false, expired: false, topicIndex: -1, remaining: 0, total: 0 };
  broadcastTimerState();
  updateTimerBar();
  syncTimerButtons();
  renderTimerQueue();
}

function startTimerTick() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (timerState.remaining > 0) {
      timerState.remaining--;
      if (timerState.remaining === 0) {
        // Expired — stop and wait for host to advance
        clearInterval(timerInterval);
        timerInterval = null;
        timerState.expired = true;
        broadcastTimerState();
        updateTimerBar();
        syncTimerButtons();
        renderTimerQueue();
        return;
      }
    }
    broadcastTimerState();
    updateTimerBar();
  }, 1000);
}

function broadcastTimerState() {
  const i     = timerState.topicIndex;
  const topic = timerState.active && i >= 0 && i < timerQueue.length ? timerQueue[i] : null;
  broadcastData({
    type:       'timer_update',
    active:     timerState.active,
    paused:     timerState.paused,
    expired:    timerState.expired,
    topicName:  topic?.name  || '',
    topicNotes: topic?.notes || '',
    remaining:  timerState.remaining,
    total:      timerState.total,
    yellowAt:   timerThresholds.yellow,
    redAt:      timerThresholds.red,
  });
}

function applyTimerUpdate(msg) {
  timerThresholds.yellow = msg.yellowAt ?? timerThresholds.yellow;
  timerThresholds.red    = msg.redAt    ?? timerThresholds.red;

  if (!msg.active) {
    timerBar?.classList.add('hidden');
    return;
  }
  timerBar?.classList.remove('hidden');
  if (timerTopicEl) timerTopicEl.textContent = msg.topicName;
  if (timerNotesEl) {
    timerNotesEl.textContent    = msg.topicNotes;
    timerNotesEl.style.display  = msg.topicNotes ? '' : 'none';
  }
  if (timerCountEl) timerCountEl.textContent = fmtTime(msg.remaining);
  if (timerProgressEl && msg.total > 0) {
    timerProgressEl.style.width = ((msg.remaining / msg.total) * 100) + '%';
  }
  colorTimerBar(msg.remaining, msg.yellowAt, msg.redAt, msg.expired);
}

function updateTimerBar() {
  const i     = timerState.topicIndex;
  const topic = timerState.active && i >= 0 && i < timerQueue.length ? timerQueue[i] : null;
  if (!timerState.active || !topic) {
    timerBar?.classList.add('hidden');
    return;
  }
  timerBar?.classList.remove('hidden');
  if (timerTopicEl) timerTopicEl.textContent = topic.name;
  if (timerNotesEl) {
    timerNotesEl.textContent   = topic.notes;
    timerNotesEl.style.display = topic.notes ? '' : 'none';
  }
  if (timerCountEl) timerCountEl.textContent = fmtTime(timerState.remaining);
  if (timerProgressEl && timerState.total > 0) {
    timerProgressEl.style.width = ((timerState.remaining / timerState.total) * 100) + '%';
  }
  colorTimerBar(timerState.remaining, timerThresholds.yellow, timerThresholds.red, timerState.expired);
}

function colorTimerBar(remaining, yellowAt, redAt, expired) {
  if (!timerBar) return;
  timerBar.classList.remove('timer-green', 'timer-yellow', 'timer-red', 'timer-expired');
  if (expired) {
    timerBar.classList.add('timer-red', 'timer-expired');
  } else if (remaining <= redAt) {
    timerBar.classList.add('timer-red');
  } else if (remaining <= yellowAt) {
    timerBar.classList.add('timer-yellow');
  } else {
    timerBar.classList.add('timer-green');
  }
}

function applyTimerShowTime() {
  if (timerCountEl) timerCountEl.style.display = timerShowTime ? '' : 'none';
  if (btnTimerEye) {
    btnTimerEye.title = timerShowTime ? 'Hide time' : 'Show time';
    btnTimerEye.classList.toggle('inactive', !timerShowTime);
  }
}

function syncTimerButtons() {
  if (!btnTimerSS) return;
  if (!timerState.active) {
    btnTimerSS.textContent = 'Start';
    btnTimerSS.classList.remove('active');
    btnTimerSkip?.classList.remove('active');
  } else if (timerState.expired) {
    btnTimerSS.textContent = 'Restart';
    btnTimerSS.classList.remove('active');
    btnTimerSkip?.classList.add('active'); // prompt host to advance
  } else if (timerState.paused) {
    btnTimerSS.textContent = 'Resume';
    btnTimerSS.classList.add('active');
    btnTimerSkip?.classList.remove('active');
  } else {
    btnTimerSS.textContent = 'Pause';
    btnTimerSS.classList.add('active');
    btnTimerSkip?.classList.remove('active');
  }
  if (btnTimerSkip) btnTimerSkip.disabled = !timerState.active;
  if (btnTimerStop) btnTimerStop.disabled = !timerState.active;
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
