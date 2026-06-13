/**
 * studio.js — Main recording studio
 *
 *  - LiveKit room connection + video grid (camera & screen share tiles)
 *  - Local recording:
 *      audio → AudioWorklet raw PCM (lossless), Opus MediaRecorder fallback
 *      video → MediaRecorder with browser-appropriate MIME fallback chain
 *  - Serialized chunked upload queues with retry; finalize after queue drains
 *  - Recording-state sync for late joiners (status check on join + polling)
 *  - Host-drop detection via token metadata → guests stop recording
 */

const { Room, RoomEvent, Track, ConnectionQuality } = LivekitClient;

// ── State ────────────────────────────────────────────────────────────────────

let room = null;
let displayName = '';
let identity = '';

let isRecording = false;
let recordingStartTime = null;
let recTimerInterval = null;

// Video recorder
let videoRecorder = null;
let videoExt = 'webm';

// Screen recorder
let screenRecorder = null;
let screenExt = 'webm';

// PCM audio capture
let pcmCtx = null;
let pcmNode = null;
let pcmSource = null;
let pcmStream = null;
let pcmBuffers = [];
let pcmFrames = 0;
let pcmChannels = 2;
let opusCtx = null;
let audioFormat = 'pcm';   // 'pcm' or 'container' (Opus fallback)
let audioRecorder = null;  // fallback only

// Upload queues — serialized per track so chunks arrive in order and
// finalize only fires after everything is flushed.
let chunkIndex = { audio: 0, video: 0, screen: 0 };
let uploadQueues = { audio: Promise.resolve(), video: Promise.resolve(), screen: Promise.resolve() };
// Epoch string prefix per recording run so chunk files from different
// recordings never collide even if the session directory isn't clean.
let recordingEpoch = '';
// Guards a start in progress so overlapping triggers (data-channel message +
// status poll) can't kick off two concurrent startLocalRecording() runs.
let recordingStarting = false;

// Timer
const TIMER_SHOW_KEY = 'podbooth:timer-show-time';
const timerQueue = []; // [{name, duration (s), notes}]
let timerState      = { active: false, paused: false, expired: false, topicIndex: -1, remaining: 0, total: 0 };
let timerInterval   = null;
let timerThresholds = { yellow: 120, red: 60 };
let timerShowTime   = true;
let timerEditIndex  = -1; // -1 = adding new, ≥0 = editing existing

// Raised hands: identity → displayName (lookup) + ordered queue
const raisedHands = new Map();
const handQueue = []; // ordered by raise time: [{identity, displayName}, ...]
let handRaised = false;

// ── View / layout state (per-user, local to this browser) ──
// 'grid' = equal tiles; 'spotlight' = active speaker (or pinned) enlarged,
// everyone else in a thumbnail filmstrip. Persisted as a user preference.
let viewMode = 'grid';
const VIEW_KEY = 'podbooth:view';
// Tile ids the user has pinned to the stage, e.g. 'tile-Alice-x9f2'.
const pinnedIds = new Set();
// Tile id of the current primary (loudest) active speaker, if any.
let activeSpeakerTileId = null;
// Insertion order of tiles so layout placement stays stable across renders.
const tileOrder = [];

// ── DOM refs ─────────────────────────────────────────────────────────────────

const grid         = document.getElementById('video-grid');
const emptyMsg     = document.getElementById('empty-msg');
const stage        = document.getElementById('stage');
const filmstrip    = document.getElementById('filmstrip');
const btnView      = document.getElementById('btn-view');
const btnMic       = document.getElementById('btn-mic');
const btnCam       = document.getElementById('btn-cam');
const btnScreen    = document.getElementById('btn-screen');
const btnSettings  = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');
const studioMicSel = document.getElementById('studio-mic-select');
const studioCamSel = document.getElementById('studio-cam-select');
const btnRaiseHand = document.getElementById('btn-raise-hand');
const btnRecord    = document.getElementById('btn-record');
const recIndicator = document.getElementById('rec-indicator');
const recTime      = document.getElementById('rec-time');
const btnEnd       = document.getElementById('btn-end');
const btnShowShare = document.getElementById('btn-show-share');
const shareWrap    = document.getElementById('share-wrap');
const shareLink    = document.getElementById('share-link');
const btnCopy      = document.getElementById('btn-copy');
const toast        = document.getElementById('toast');
const btnChat      = document.getElementById('btn-chat');
const chatPanel    = document.getElementById('chat-panel');
const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const btnChatSend  = document.getElementById('btn-chat-send');
const btnFiles     = document.getElementById('btn-files');
const filesPanel   = document.getElementById('files-panel');
const filesList    = document.getElementById('files-list');

// Timer DOM refs (host-only elements are null for non-hosts)
const timerBar        = document.getElementById('timer-bar');
const timerTopicEl    = document.getElementById('timer-topic-name');
const timerCountEl    = document.getElementById('timer-countdown');
const timerNotesEl    = document.getElementById('timer-notes-row');
const timerProgressEl = document.getElementById('timer-progress-fill');
const btnTimerEye     = document.getElementById('btn-timer-eye');
const btnTimerBtn   = document.getElementById('btn-timer');
const timerPanel    = document.getElementById('timer-panel');
const timerQueueEl  = document.getElementById('timer-queue-list');
const timerAddName  = document.getElementById('timer-add-name');
const timerAddDur   = document.getElementById('timer-add-dur');
const timerAddNotes = document.getElementById('timer-add-notes');
const btnTimerAdd    = document.getElementById('btn-timer-add');
const btnTimerCancel = document.getElementById('btn-timer-cancel');
const btnTimerSS     = document.getElementById('btn-timer-startstop');
const btnTimerP30   = document.getElementById('btn-timer-plus30');
const btnTimerSkip  = document.getElementById('btn-timer-skip');
const btnTimerStop  = document.getElementById('btn-timer-stop');
const timerYellowIn = document.getElementById('timer-yellow');
const timerRedIn    = document.getElementById('timer-red');

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(window.location.search);
  displayName = (params.get('participant_name') || '').trim();
  const micDeviceId = params.get('mic_device_id') || '';
  const camDeviceId = params.get('cam_device_id') || '';

  if (!displayName) {
    // Everyone (host included) goes through pre-join to pick a name
    const suffix = IS_HOST ? `?host_token=${HOST_TOKEN}` : '';
    window.location.href = `/join/${SESSION_ID}${suffix}`;
    return;
  }

  // Unique identity (LiveKit kicks duplicate identities); display name stays human
  identity = `${displayName}-${Math.random().toString(36).slice(2, 7)}`;

  const resp = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: SESSION_ID,
      identity: identity,
      display_name: displayName,
      host_token: HOST_TOKEN,
    }),
  });
  if (!resp.ok) {
    showToast('Could not join session');
    return;
  }
  const { token } = await resp.json();

  room = new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: {
      deviceId: camDeviceId || undefined,
      resolution: { width: 1920, height: 1080, frameRate: 30 },
    },
    audioCaptureDefaults: {
      deviceId: micDeviceId || undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // Populate share link and attach button listeners immediately —
  // do NOT wait for LiveKit connection, which may fail (e.g. no TURN yet)
  if (IS_HOST && shareLink) {
    shareLink.value = JOIN_LINK;
  }
  setupControls();
  pollSessionStatus();
  pollPendingGuests();
  window.addEventListener('beforeunload', onBeforeUnload);

  attachRoomEvents();

  try {
    await room.connect(LIVEKIT_URL, token);
    await room.localParticipant.enableCameraAndMicrophone();
    setupDevicePanel(micDeviceId, camDeviceId);

    renderLocalParticipant();
    for (const p of room.remoteParticipants.values()) {
      renderRemoteParticipant(p);
    }
  } catch (e) {
    console.error('LiveKit connection failed:', e);
    showToast('Could not connect to room — check TURN/network config');
  }

  // Late joiner: if recording is already in progress, start capturing now
  try {
    const s = await fetch(`/api/session/${SESSION_ID}/status`).then(r => r.json());
    if (s.recording && !isRecording) {
      setRecordingUI(true);
      await startLocalRecording();
      showToast('Recording in progress — your track is being captured');
    }
  } catch (e) {}
}

// ── LiveKit room events ──────────────────────────────────────────────────────

function attachRoomEvents() {
  room.on(RoomEvent.ParticipantConnected, p => {
    showToast(`${labelFor(p)} joined`);
    renderRemoteParticipant(p);
    // Re-announce own raised hand so the new joiner picks up current queue state
    if (handRaised) {
      broadcastData({ type: 'hand_raised', identity, displayName });
    }
    // Host re-broadcasts recording state so late joiners start capturing
    if (IS_HOST && isRecording) {
      broadcastData({ type: 'recording_started' });
    }
    // Host re-broadcasts timer state so late joiners see the current timer
    if (IS_HOST && timerState.active) {
      broadcastTimerState();
    }
  });

  room.on(RoomEvent.ParticipantDisconnected, p => {
    showToast(`${labelFor(p)} left`);
    removeTile(`tile-${p.identity}`);
    removeTile(`tile-${p.identity}-screen`);
    removeFromQueue(p.identity);
    raisedHands.delete(p.identity);
    updateHandQueue();
    layoutTiles();

    // Spec: if the host drops, recording stops. Guests detect this via
    // the is_host flag in the participant's token metadata.
    if (!IS_HOST && isRecording && participantIsHost(p)) {
      showToast('Host disconnected — recording stopped');
      setRecordingUI(false);
      stopLocalRecording();
    }
  });

  room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;

    if (pub.source === Track.Source.ScreenShare) {
      // Screen shares get their own tile instead of replacing the camera
      let tile = document.getElementById(`tile-${participant.identity}-screen`);
      if (!tile && track.kind === Track.Kind.Video) {
        tile = createTile(participant.identity + '-screen', false, `${labelFor(participant)} (screen)`);
        stage.appendChild(tile);
        layoutTiles();
      }
      if (tile && track.kind === Track.Kind.Video) attachVideoToTile(tile, track);
      return;
    }

    const tile = document.getElementById(`tile-${participant.identity}`);
    if (!tile) return;
    if (track.kind === Track.Kind.Video) attachVideoToTile(tile, track);
    if (track.kind === Track.Kind.Audio) track.attach(); // play remote audio
    updateMuteIndicator(tile, participant);
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
    // Note: do NOT remove screen tiles here. With adaptiveStream, an active
    // screen share that scrolls out of view can be auto-unsubscribed; removing
    // it here would wrongly drop a live share. Removal is driven by
    // TrackUnpublished (publisher actually stopped) / ParticipantDisconnected.
    const tile = document.getElementById(`tile-${participant.identity}`);
    if (tile) updateMuteIndicator(tile, participant);
  });

  // Authoritative "the publisher stopped this track" signal — this is what
  // reliably removes a remote screen share (more so than TrackUnsubscribed).
  room.on(RoomEvent.TrackUnpublished, (pub, participant) => {
    if (pub.source === Track.Source.ScreenShare) {
      removeTile(`tile-${participant.identity}-screen`);
      layoutTiles();
    }
  });

  // Our own screen share ended — covers the browser's native "Stop sharing"
  // bar, which never triggers our screen button handler.
  room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
    if (pub.source === Track.Source.ScreenShare) cleanupLocalScreen();
  });

  room.on(RoomEvent.TrackMuted, (pub, participant) => {
    const tile = document.getElementById(`tile-${participant.identity}`);
    if (tile) updateMuteIndicator(tile, participant);
  });

  room.on(RoomEvent.TrackUnmuted, (pub, participant) => {
    const tile = document.getElementById(`tile-${participant.identity}`);
    if (tile) updateMuteIndicator(tile, participant);
  });

  room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
    const tile = document.getElementById(`tile-${participant.identity}`);
    if (tile) updateQualityIndicator(tile, quality);
  });

  room.on(RoomEvent.ActiveSpeakersChanged, speakers => {
    // Glow ring on whoever's currently talking (both view modes).
    const speakingIds = new Set(speakers.map(p => `tile-${p.identity}`));
    for (const id of tileOrder) {
      document.getElementById(id)?.classList.toggle('speaking', speakingIds.has(id));
    }
    // Loudest speaker drives the spotlight focus.
    const primary = speakers.length ? `tile-${speakers[0].identity}` : null;
    if (primary && primary !== activeSpeakerTileId) {
      activeSpeakerTileId = primary;
      if (viewMode === 'spotlight') layoutTiles();
    }
  });

  room.on(RoomEvent.DataReceived, (data) => {
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(data)); } catch (e) { return; }

    if (msg.type === 'recording_started' && !IS_HOST) {
      if (!isRecording) {
        showCountdown().then(() => {
          setRecordingUI(true);
          startLocalRecording();
        });
      }
    }
    if (msg.type === 'recording_stopped' && !IS_HOST && isRecording) {
      setRecordingUI(false);
      stopLocalRecording();
    }
    if (msg.type === 'session_ended' && !IS_HOST) {
      handleSessionEnded();
    }
    if (msg.type === 'chat') {
      appendChatMessage(msg.identity, msg.displayName, msg.text, false);
      if (!chatPanel?.classList.contains('open')) {
        btnChat?.classList.add('chat-unread');
        showToast(`${msg.displayName}: ${msg.text.slice(0, 60)}`);
      }
    }
    if (msg.type === 'hand_raised') {
      if (!raisedHands.has(msg.identity)) {
        handQueue.push({ identity: msg.identity, displayName: msg.displayName });
      }
      raisedHands.set(msg.identity, msg.displayName);
      updateHandIndicator(msg.identity, true);
      updateHandQueue();
      showToast(`✋ ${msg.displayName} raised their hand`);
    }
    if (msg.type === 'hand_lowered') {
      removeFromQueue(msg.identity);
      raisedHands.delete(msg.identity);
      updateHandIndicator(msg.identity, false);
      updateHandQueue();
    }
    if (msg.type === 'timer_update' && !IS_HOST) {
      applyTimerUpdate(msg);
    }
    if (msg.type === 'hand_cleared') {
      removeFromQueue(msg.identity);
      raisedHands.delete(msg.identity);
      updateHandIndicator(msg.identity, false);
      updateHandQueue();
      if (msg.identity === identity) {
        handRaised = false;
        btnRaiseHand?.classList.remove('active');
      }
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    showToast('Disconnected from room');
  });
}

function participantIsHost(p) {
  try {
    return JSON.parse(p.metadata || '{}').is_host === true;
  } catch (e) {
    return false;
  }
}

function labelFor(p) {
  return p.name || p.identity;
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
    if (pub.track && pub.isSubscribed) pub.track.attach();
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

  tileOrder.push(tile.id);
  return tile;
}

function removeTile(id) {
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

async function setupDevicePanel(activeMicId, activeCamId) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    studioMicSel.innerHTML = '';
    studioCamSel.innerHTML = '';

    devices.filter(d => d.kind === 'audioinput').forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${studioMicSel.options.length + 1}`;
      if (d.deviceId === activeMicId) opt.selected = true;
      studioMicSel.appendChild(opt);
    });

    devices.filter(d => d.kind === 'videoinput').forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${studioCamSel.options.length + 1}`;
      if (d.deviceId === activeCamId) opt.selected = true;
      studioCamSel.appendChild(opt);
    });

    studioMicSel.addEventListener('change', () =>
      room.switchActiveDevice('audioinput', studioMicSel.value)
    );
    studioCamSel.addEventListener('change', () =>
      room.switchActiveDevice('videoinput', studioCamSel.value)
    );
  } catch (e) {
    console.warn('Could not enumerate devices for settings panel:', e);
  }
}

function setupControls() {
  btnSettings?.addEventListener('click', e => {
    e.stopPropagation();
    const open = settingsPanel.style.display !== 'none';
    settingsPanel.style.display = open ? 'none' : 'flex';
    btnSettings.classList.toggle('active', !open);
  });
  settingsPanel?.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => {
    if (settingsPanel && settingsPanel.style.display !== 'none') {
      settingsPanel.style.display = 'none';
      btnSettings?.classList.remove('active');
    }
  });

  btnRaiseHand?.addEventListener('click', toggleHand);

  // Restore the user's saved layout preference, then wire the toggle.
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'grid' || saved === 'spotlight') viewMode = saved;
  } catch (e) {}
  btnView?.classList.toggle('active', viewMode === 'spotlight');
  btnView?.addEventListener('click', () => {
    setViewMode(viewMode === 'grid' ? 'spotlight' : 'grid');
    showToast(`Layout: ${viewMode === 'spotlight' ? 'Active speaker' : 'Grid'}`);
  });

  btnChat?.addEventListener('click', () => {
    const open = chatPanel?.classList.toggle('open');
    btnChat.classList.toggle('active', open);
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

  btnMic?.addEventListener('click', async () => {
    const enabled = room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(!enabled);
    btnMic.classList.toggle('muted', enabled);
  });

  btnCam?.addEventListener('click', async () => {
    const enabled = room.localParticipant.isCameraEnabled;
    await room.localParticipant.setCameraEnabled(!enabled);
    btnCam.classList.toggle('muted', enabled);
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

  if (IS_HOST) {
    btnRecord?.addEventListener('click', toggleRecording);
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
}

// ── Recording countdown ───────────────────────────────────────────────────────

function showCountdown() {
  return new Promise(resolve => {
    const overlay = document.getElementById('countdown-overlay');
    const numEl   = document.getElementById('countdown-number');
    overlay.classList.remove('hidden');
    let count = 3;
    function tick() {
      numEl.textContent = count;
      numEl.style.animation = 'none';
      void numEl.offsetWidth; // force reflow to restart CSS animation
      numEl.style.animation = '';
      if (count === 1) {
        setTimeout(() => { overlay.classList.add('hidden'); resolve(); }, 1000);
        return;
      }
      count--;
      setTimeout(tick, 1000);
    }
    tick();
  });
}

// ── Raise hand ───────────────────────────────────────────────────────────────

async function toggleHand() {
  if (handRaised) {
    handRaised = false;
    btnRaiseHand?.classList.remove('active');
    removeFromQueue(identity);
    raisedHands.delete(identity);
    updateHandIndicator(identity, false);
    updateHandQueue();
    await broadcastData({ type: 'hand_lowered', identity });
  } else {
    handRaised = true;
    btnRaiseHand?.classList.add('active');
    if (!raisedHands.has(identity)) {
      handQueue.push({ identity, displayName });
    }
    raisedHands.set(identity, displayName);
    updateHandIndicator(identity, true);
    updateHandQueue();
    await broadcastData({ type: 'hand_raised', identity, displayName });
  }
}

async function clearHand(targetIdentity) {
  removeFromQueue(targetIdentity);
  raisedHands.delete(targetIdentity);
  updateHandIndicator(targetIdentity, false);
  updateHandQueue();
  // Sender never receives their own broadcast, so reset local state directly
  if (targetIdentity === identity) {
    handRaised = false;
    btnRaiseHand?.classList.remove('active');
  }
  await broadcastData({ type: 'hand_cleared', identity: targetIdentity });
}

function removeFromQueue(id) {
  const idx = handQueue.findIndex(h => h.identity === id);
  if (idx !== -1) handQueue.splice(idx, 1);
}

function updateHandQueue() {
  const panel = document.getElementById('hand-queue-panel');
  const list  = document.getElementById('hand-queue-list');
  if (!panel || !list) return;
  list.innerHTML = '';
  handQueue.forEach(({ identity: id, displayName: name }) => {
    const li = document.createElement('li');
    li.className = 'hand-queue-item';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    li.appendChild(nameSpan);
    if (IS_HOST) {
      const btn = document.createElement('button');
      btn.className = 'hand-queue-clear';
      btn.textContent = '×';
      btn.title = 'Lower hand';
      btn.addEventListener('click', () => clearHand(id));
      li.appendChild(btn);
    }
    list.appendChild(li);
  });
  panel.style.display = handQueue.length ? 'flex' : 'none';
}

function updateHandIndicator(participantIdentity, raised) {
  const tile = document.getElementById(`tile-${participantIdentity}`);
  if (!tile) return;
  const hand = tile.querySelector('.tile-hand');
  if (!hand) return;
  hand.style.display = raised ? 'flex' : 'none';
  tile.classList.toggle('hand-raised', raised);
}

// ── Chat ─────────────────────────────────────────────────────────────────────

async function sendChat() {
  const text = chatInput?.value.trim();
  if (!text) return;
  chatInput.value = '';
  appendChatMessage(identity, displayName, text, true);
  await broadcastData({ type: 'chat', identity, displayName, text });
}

function appendChatMessage(senderIdentity, senderName, text, own) {
  if (!chatMessages) return;
  const msg = document.createElement('div');
  msg.className = 'chat-msg' + (own ? ' own' : '');
  const name = document.createElement('div');
  name.className = 'chat-msg-name';
  name.textContent = senderName;
  const body = document.createElement('div');
  body.className = 'chat-msg-text';
  body.textContent = text;
  msg.appendChild(name);
  msg.appendChild(body);
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (chatPanel?.classList.contains('open')) {
    btnChat?.classList.remove('chat-unread');
  }
}

// ── Recordings files panel ────────────────────────────────────────────────────

let filesPollTimer = null;

async function fetchFiles() {
  if (!filesList) return;
  const r = await fetch(`/api/session/${SESSION_ID}/recordings`);
  if (!r.ok) return;
  const { files } = await r.json();
  if (!files.length) {
    filesList.innerHTML = '<span class="files-empty">No recordings yet.</span>';
    return;
  }
  filesList.innerHTML = '';
  files.forEach(f => {
    const row = document.createElement('div');
    row.className = 'files-row';
    const p = document.createElement('span'); p.className = 'files-participant'; p.textContent = f.participant;
    const t = document.createElement('span'); t.className = 'files-type'; t.textContent = f.type;
    const s = document.createElement('span'); s.className = 'files-size'; s.textContent = `${f.size_mb} MB`;
    const a = document.createElement('a'); a.href = `/download/${f.path}`; a.download = ''; a.textContent = '↓ Download';
    row.append(p, t, s, a);
    filesList.appendChild(row);
  });
}

function startFilesPoll() {
  if (!IS_HOST || filesPollTimer) return;
  filesPollTimer = setInterval(async () => {
    if (filesPanel?.style.display !== 'none') await fetchFiles();
  }, 5000);
}

function stopFilesPoll() {
  clearInterval(filesPollTimer);
  filesPollTimer = null;
}

// ── Recording control (host) ─────────────────────────────────────────────────

async function toggleRecording() {
  const action = isRecording ? 'stop' : 'start';

  if (action === 'start') {
    if (btnRecord) btnRecord.disabled = true;
    // Broadcast before the countdown so all participants count down together
    await fetch(`/api/session/${SESSION_ID}/recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: HOST_TOKEN, action }),
    });
    await broadcastData({ type: 'recording_started' });
    await showCountdown();
    if (btnRecord) btnRecord.disabled = false;
    setRecordingUI(true);
    await startLocalRecording();
  } else {
    await fetch(`/api/session/${SESSION_ID}/recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: HOST_TOKEN, action }),
    });
    await broadcastData({ type: 'recording_stopped' });
    setRecordingUI(false);
    stopLocalRecording();
  }
}

function setRecordingUI(recording) {
  isRecording = recording;
  if (recording) {
    btnRecord?.classList.add('recording');
    recIndicator?.classList.add('active');
    recordingStartTime = Date.now();
    recTimerInterval = setInterval(updateRecTimer, 1000);
  } else {
    btnRecord?.classList.remove('recording');
    recIndicator?.classList.remove('active');
    clearInterval(recTimerInterval);
    if (recTime) recTime.textContent = '00:00';
    startFilesPoll();
  }
}

function updateRecTimer() {
  if (!recordingStartTime) return;
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  recTime.textContent = `${m}:${s}`;
}

// ── Local capture ────────────────────────────────────────────────────────────

function getLocalTrack(kind) {
  const pubs = kind === 'audio'
    ? room.localParticipant.audioTrackPublications
    : room.localParticipant.videoTrackPublications;
  for (const pub of pubs.values()) {
    const wantedSource = kind === 'audio' ? Track.Source.Microphone : Track.Source.Camera;
    if (pub.track && pub.source === wantedSource) return pub.track;
  }
  return null;
}

function getScreenTrack() {
  for (const pub of room.localParticipant.videoTrackPublications.values()) {
    if (pub.track && pub.source === Track.Source.ScreenShare) return pub.track;
  }
  return null;
}

// Wait until our mic/camera tracks are actually published before recording.
// The recording-state poll (pollSessionStatus) starts before room.connect()
// and enableCameraAndMicrophone() finish, so a recording that begins right
// after a participant joins can fire startLocalRecording() while no local
// tracks exist yet — every capture path would then start nothing and the
// participant would produce an empty recording.
async function waitForLocalTracks(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getLocalTrack('audio') || getLocalTrack('video')) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return !!(getLocalTrack('audio') || getLocalTrack('video'));
}

// True if any recorder is actually capturing. The recording-state poll uses
// this to self-heal: if the session says "recording" but nothing is actually
// capturing (a previous start attempt failed), it retries startLocalRecording.
function hasActiveRecorders() {
  return !!(
    pcmNode ||
    (audioRecorder && audioRecorder.state !== 'inactive') ||
    (videoRecorder && videoRecorder.state !== 'inactive') ||
    (screenRecorder && screenRecorder.state !== 'inactive')
  );
}

async function startLocalRecording() {
  // Don't run two starts at once (data-channel message + poll can both fire),
  // and don't restart if we're already capturing.
  if (recordingStarting || hasActiveRecorders()) return;
  recordingStarting = true;
  try {
    // Don't start capturing until the local tracks exist, or we'd record
    // nothing. The status poll can fire before LiveKit finishes connecting.
    if (!(await waitForLocalTracks())) {
      showToast('Could not start recording — no microphone or camera');
      return;
    }
    // Recording may have been stopped while we were waiting for tracks.
    if (!isRecording) return;

    recordingEpoch = Date.now().toString(36); // unique prefix per recording run
    chunkIndex = { audio: 0, video: 0, screen: 0 };
    uploadQueues = { audio: Promise.resolve(), video: Promise.resolve(), screen: Promise.resolve() };

    // ── VIDEO first ── start it before audio so a slow/failed microphone
    // capture can never block video from recording.
    startVideoRecording();

    // ── AUDIO: raw PCM via AudioWorklet (lossless), Opus fallback ──
    try {
      await startPcmCapture();
      audioFormat = 'pcm';
    } catch (e) {
      console.warn('PCM capture unavailable, falling back to Opus:', e);
      audioFormat = 'container';
      startOpusFallback();
    }

    // ── SCREEN: record screen share if it's already active ──
    if (getScreenTrack()) {
      startScreenRecording();
    }
  } finally {
    recordingStarting = false;
  }
}

function startVideoRecording() {
  const camTrack = getLocalTrack('video');
  if (!camTrack) return;
  const candidates = [
    ['video/mp4;codecs=avc1', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=h264', 'webm'],
    ['video/webm;codecs=vp9', 'webm'],
    ['video/webm;codecs=vp8', 'webm'],
    ['video/webm', 'webm'],
  ];
  const found = candidates.find(([mime]) => MediaRecorder.isTypeSupported(mime));
  if (!found) {
    showToast('Video recording not supported in this browser');
    return;
  }
  const [mime, ext] = found;
  videoExt = ext;
  const camStream = new MediaStream([camTrack.mediaStreamTrack]);
  videoRecorder = new MediaRecorder(camStream, {
    mimeType: mime,
    videoBitsPerSecond: 12_000_000, // generous for 1080p30
  });
  videoRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) {
      enqueueChunk(e.data, 'video', videoExt);
    }
  };
  videoRecorder.onstop = () => {
    finalizeTrack('video', { format: 'container' });
  };
  videoRecorder.start(5000);
}

// Tear down our own screen share. Safe to call more than once (idempotent):
// runs both when we stop via the screen button AND when the browser's native
// "Stop sharing" bar ends the track (which fires LocalTrackUnpublished but
// never our button handler) — otherwise the tile would freeze and linger.
function cleanupLocalScreen() {
  removeTile(`tile-${identity}-screen`);
  layoutTiles();
  btnScreen?.classList.remove('active');
  if (screenRecorder && screenRecorder.state !== 'inactive') {
    screenRecorder.stop();
  }
  screenRecorder = null;
}

function startScreenRecording() {
  const screenTrack = getScreenTrack();
  if (!screenTrack) return;

  const candidates = [
    ['video/mp4;codecs=avc1', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=h264', 'webm'],
    ['video/webm;codecs=vp9', 'webm'],
    ['video/webm;codecs=vp8', 'webm'],
    ['video/webm', 'webm'],
  ];
  const found = candidates.find(([mime]) => MediaRecorder.isTypeSupported(mime));
  if (!found) {
    showToast('Screen recording not supported in this browser');
    return;
  }
  const [mime, ext] = found;
  screenExt = ext;
  const screenStream = new MediaStream([screenTrack.mediaStreamTrack]);
  screenRecorder = new MediaRecorder(screenStream, {
    mimeType: mime,
    videoBitsPerSecond: 8_000_000,
  });
  screenRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) enqueueChunk(e.data, 'screen', screenExt);
  };
  screenRecorder.onstop = () => {
    finalizeTrack('screen', { format: 'container' });
  };
  screenRecorder.start(5000);
}

async function startPcmCapture() {
  if (!('AudioWorkletNode' in window)) throw new Error('AudioWorklet not supported');

  const micTrack = getLocalTrack('audio');
  if (!micTrack) throw new Error('No local microphone track');

  // Open a dedicated UNPROCESSED stream from the same device for recording.
  // The call keeps echo cancellation / noise suppression; the recording
  // captures the clean source (this is what Riverside-style tools do).
  const deviceId = micTrack.mediaStreamTrack.getSettings().deviceId;
  // Race against a timeout: a second getUserMedia on a device already in use
  // can hang in some browsers, which would otherwise stall the whole start.
  pcmStream = await Promise.race([
    navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: { ideal: 48000 },
      },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('PCM getUserMedia timed out')), 6000)
    ),
  ]);

  pcmCtx = new AudioContext({ sampleRate: 48000 });
  await pcmCtx.audioWorklet.addModule('/static/js/pcm-worklet.js');

  pcmSource = pcmCtx.createMediaStreamSource(pcmStream);
  pcmNode = new AudioWorkletNode(pcmCtx, 'pcm-capture', {
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });

  pcmBuffers = [];
  pcmFrames = 0;

  pcmNode.port.onmessage = (e) => {
    const channels = e.data;
    if (!channels || !channels.length) return;
    pcmChannels = 2; // always stereo; interleave duplicates mono source if needed
    pcmBuffers.push(channels);
    pcmFrames += channels[0].length;
    if (pcmFrames >= pcmCtx.sampleRate * 5) {
      flushPcm(false);
    }
  };

  pcmSource.connect(pcmNode);
  pcmNode.connect(pcmCtx.destination); // worklet outputs silence; needed to keep graph active
}

function flushPcm(isLast) {
  if (pcmFrames > 0) {
    const frames = pcmFrames;
    const ch = pcmChannels;
    const interleaved = new Float32Array(frames * ch);
    let offset = 0;
    for (const block of pcmBuffers) {
      const len = block[0].length;
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < ch; c++) {
          interleaved[(offset + i) * ch + c] = block[Math.min(c, block.length - 1)][i];
        }
      }
      offset += len;
    }
    pcmBuffers = [];
    pcmFrames = 0;
    enqueueChunk(new Blob([interleaved.buffer]), 'audio', 'raw');
  }

  if (isLast) {
    finalizeTrack('audio', {
      format: 'pcm',
      sample_rate: pcmCtx ? pcmCtx.sampleRate : 48000,
      channels: pcmChannels,
    });
  }
}

function startOpusFallback() {
  const micTrack = getLocalTrack('audio');
  if (!micTrack) return;

  const candidates = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/mp4', 'mp4'],   // Safari
  ];
  const found = candidates.find(([mime]) => MediaRecorder.isTypeSupported(mime));
  if (!found) {
    showToast('Audio recording not supported in this browser');
    return;
  }
  const [mime, ext] = found;
  // Upmix to stereo via Web Audio so mono devices still record as 2-channel
  opusCtx = new AudioContext({ sampleRate: 48000 });
  const monoStream = new MediaStream([micTrack.mediaStreamTrack]);
  const opusSource = opusCtx.createMediaStreamSource(monoStream);
  const opusDest = opusCtx.createMediaStreamDestination();
  opusDest.channelCount = 2;
  opusSource.connect(opusDest);
  audioRecorder = new MediaRecorder(opusDest.stream, {
    mimeType: mime,
    audioBitsPerSecond: 320000,
  });
  audioRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) enqueueChunk(e.data, 'audio', ext);
  };
  audioRecorder.onstop = () => {
    finalizeTrack('audio', { format: 'container' });
  };
  audioRecorder.start(5000);
}

function stopLocalRecording() {
  // Video
  if (videoRecorder && videoRecorder.state !== 'inactive') {
    videoRecorder.stop(); // fires final ondataavailable, then onstop → finalize
  }
  videoRecorder = null;

  // PCM audio
  if (pcmNode) {
    pcmNode.port.onmessage = null;
    try { pcmSource.disconnect(); pcmNode.disconnect(); } catch (e) {}
    flushPcm(true);
    pcmCtx?.close();
    pcmStream?.getTracks().forEach(t => t.stop());
    pcmCtx = pcmNode = pcmSource = pcmStream = null;
  }

  // Opus fallback
  if (audioRecorder && audioRecorder.state !== 'inactive') {
    audioRecorder.stop();
  }
  audioRecorder = null;
  opusCtx?.close();
  opusCtx = null;

  // Screen share
  if (screenRecorder && screenRecorder.state !== 'inactive') {
    screenRecorder.stop(); // fires final ondataavailable, then onstop → finalize
  }
  screenRecorder = null;
}

// ── Upload pipeline ──────────────────────────────────────────────────────────

function enqueueChunk(blob, trackType, ext) {
  const index = chunkIndex[trackType]++;
  const epoch = recordingEpoch;
  uploadQueues[trackType] = uploadQueues[trackType].then(() =>
    uploadChunkWithRetry(blob, trackType, index, ext, epoch)
  );
  return uploadQueues[trackType];
}

async function uploadChunkWithRetry(blob, trackType, index, ext, epoch, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const form = new FormData();
      form.append('session_id', SESSION_ID);
      form.append('participant', displayName);
      form.append('track_type', trackType);
      form.append('chunk_index', index);
      form.append('ext', ext);
      form.append('epoch', epoch || '');
      form.append('file', blob, `chunk_${index}.${ext}`);

      const r = await fetch('/api/upload/chunk', { method: 'POST', body: form });
      if (r.ok) return;
      throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      console.warn(`Chunk upload failed (${trackType} #${index}), attempt ${i + 1}:`, err);
      if (i < attempts - 1) await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
  }
  console.error(`Chunk permanently lost: ${trackType} #${index}`);
}

function finalizeTrack(trackType, meta) {
  const epoch = recordingEpoch;
  // Chain finalize onto the upload queue so it only fires after every
  // chunk for this track has been flushed to the server.
  uploadQueues[trackType] = uploadQueues[trackType].then(async () => {
    try {
      await fetch('/api/upload/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: SESSION_ID,
          participant: displayName,
          track_type: trackType,
          epoch: epoch || '',
          ...meta,
        }),
      });
    } catch (e) {
      console.error(`Finalize failed for ${trackType}:`, e);
    }
  });
  return uploadQueues[trackType];
}

// ── Session end ──────────────────────────────────────────────────────────────

async function endSession() {
  if (!confirm('End this session for everyone?')) return;

  if (isRecording) {
    setRecordingUI(false);
    stopLocalRecording();
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

  showToast('Ending session…');
  await Promise.allSettled([uploadQueues.audio, uploadQueues.video, uploadQueues.screen]);

  try { await room?.disconnect(); } catch (e) {}
  window.location.href = '/dashboard';
}

async function handleSessionEnded() {
  showToast('Session ended — uploading your final chunks…');
  if (isRecording) {
    setRecordingUI(false);
    stopLocalRecording();
  }
  // Let the upload queues drain before navigating away
  await Promise.allSettled([uploadQueues.audio, uploadQueues.video, uploadQueues.screen]);
  window.location.href = '/';
}

function onBeforeUnload(e) {
  if (isRecording) {
    // Best effort: stop recorders so final chunks attempt to flush.
    // Browsers don't guarantee async work completes during unload.
    stopLocalRecording();
    e.preventDefault();
    e.returnValue = '';
  }
}

// ── Waiting room (host only) ─────────────────────────────────────────────────

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
  list.innerHTML = '';
  guests.forEach(({ identity: gid, display_name: name }) => {
    const li = document.createElement('li');
    li.className = 'waitroom-item';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    const btn = document.createElement('button');
    btn.className = 'waitroom-admit';
    btn.textContent = 'Admit';
    btn.addEventListener('click', () => admitGuest(gid, li));
    li.appendChild(nameSpan);
    li.appendChild(btn);
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

// ── Status polling (reconciliation safety net) ───────────────────────────────

function pollSessionStatus() {
  setInterval(async () => {
    try {
      const r = await fetch(`/api/session/${SESSION_ID}/status`);
      if (!r.ok) return;
      const data = await r.json();

      if (data.ended && !IS_HOST) {
        handleSessionEnded();
        return;
      }
      // Reconcile missed data-channel messages (guests only). Self-heal:
      // if the session is recording but nothing is actually capturing — a
      // prior start failed, or the start signal set the flag but recorders
      // never came up — (re)start. Keyed on real recorder state, not the
      // isRecording flag, so a latched flag can't strand us with no capture.
      if (!IS_HOST) {
        if (data.recording) {
          if (!isRecording) setRecordingUI(true);
          if (!hasActiveRecorders() && !recordingStarting) {
            await startLocalRecording();
          }
        } else if (isRecording) {
          setRecordingUI(false);
          stopLocalRecording();
        }
      }
    } catch (e) {}
  }, 3000);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function broadcastData(msg) {
  if (!room?.localParticipant) return;
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(msg));
    await room.localParticipant.publishData(encoded, { reliable: true });
  } catch (e) {
    console.warn('broadcastData failed:', e);
  }
}

function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
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
        if (e.target.closest('button')) return; // don't intercept button clicks
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

// ── Start ────────────────────────────────────────────────────────────────────

init().catch(err => {
  console.error(err);
  showToast('Failed to join — see console');
});
