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
let isPaused = false;
let recordingStartTime = null;
let cumulativeElapsedMs = 0; // total recorded ms before the current segment
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
let pcmCloneTrack = null; // independent clone() of the mic track; see _clonePcmInputStream
let pcmBuffers = [];
let pcmFrames = 0;
let pcmFramesWritten = 0;  // cumulative frames across all flushed chunks
let pcmChannels = 2;
let pcmCapturing = false;  // true once recording has actually started on the (possibly pre-built) graph
let opusCtx = null;
let audioFormat = 'pcm';   // 'pcm' or 'container' (Opus fallback)
let audioRecorder = null;  // fallback only
let micMuted = false;      // true while local mic is muted; gates PCM/Opus capture

// Pre-warmed AudioContext + addModule promise. Created at init() time so that
// the worklet module is compiled before recording starts — addModule can take
// 10+ seconds on Firefox under load, causing truncated audio if called lazily.
let _warmCtx = null;
let _warmModuleReady = null;

// Firefox creates AudioContexts in a 'suspended' state when there is no
// preceding user-activation on the page (the "Join Session" click happened on
// the prejoin page, a separate navigation, so it doesn't carry over here).
// resume() calls made outside of a real gesture (e.g. from the status poll)
// silently no-op on Firefox, which is why pre-warming alone didn't fix
// truncated audio. Resuming synchronously from inside a real gesture handler
// is the only thing Firefox honors, so listen for the first interaction
// anywhere on the page and resume whichever audio contexts exist at that time.
function _resumeAudioContextsOnGesture() {
  for (const ctx of [_warmCtx, pcmCtx, opusCtx]) {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }
}
['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
  document.addEventListener(evt, _resumeAudioContextsOnGesture, { capture: true, passive: true });
});

// Per-track wall-clock start times (performance.now()) sent in finalize so
// post-processing can align tracks that started at slightly different times.
let videoStartTime = null;
let audioStartTime = null;

// Upload queues — serialized per track so chunks arrive in order and
// finalize only fires after everything is flushed.
let chunkIndex = { audio: 0, video: 0, screen: 0 };
let uploadQueues = { audio: Promise.resolve(), video: Promise.resolve(), screen: Promise.resolve() };
let uploadPending = false;
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

// Host moderation: remote participant identity → audio track SID
const remoteAudioTrackSids = new Map();

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

// Latency tracking: identity → rttMs (reported by each participant)
const participantLatency = new Map();
let localRttMs = null;
let latencyInterval = null;

// Stats panel
let statsInterval = null;
let prevRtcStats = {}; // statId → { ts, bytes }

// ── DOM refs ─────────────────────────────────────────────────────────────────

const grid         = document.getElementById('video-grid');
const emptyMsg     = document.getElementById('empty-msg');
const stage        = document.getElementById('stage');
const filmstrip    = document.getElementById('filmstrip');
const btnView      = document.getElementById('btn-view');
const btnMic       = document.getElementById('btn-mic');
const btnCam       = document.getElementById('btn-cam');
const btnScreen    = document.getElementById('btn-screen');
let activeMicDeviceId = '';
let activeCamDeviceId = '';
const btnRaiseHand = document.getElementById('btn-raise-hand');
const btnRecord    = document.getElementById('btn-record');
const btnPause     = document.getElementById('btn-pause');
const btnResume    = document.getElementById('btn-resume');
const btnStopRec   = document.getElementById('btn-stop-rec');
const recIndicator = document.getElementById('rec-indicator');
const recTime      = document.getElementById('rec-time');
const btnEnd       = document.getElementById('btn-end');
const btnLeave     = document.getElementById('btn-leave');
const btnAlert     = document.getElementById('btn-alert');
const alertPanel   = document.getElementById('alert-panel');
const alertCustom  = document.getElementById('alert-custom-input');
const btnAlertSend = document.getElementById('btn-alert-send');
const alertBanner  = document.getElementById('alert-banner');
const alertBannerText = document.getElementById('alert-banner-text');
const btnAlertDismiss = document.getElementById('btn-alert-dismiss');
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
const latencyWrap  = document.getElementById('latency-indicator-wrap');
const statsPanel   = document.getElementById('stats-panel');
const btnFullscreen = document.getElementById('btn-fullscreen');

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

// ── Debug logging ─────────────────────────────────────────────────────────────
// Prefixes every log line with the participant identity and a ms-precision
// timestamp so logs from two browser tabs on the same machine are easy to
// distinguish and correlate. Filter in DevTools with "[rec".

function recLog(fmt, ...args) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`[rec ${identity || '?'}] ${ts} ${fmt}`, ...args);
}

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
    adaptiveStream: false,
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

  // Pre-warm the PCM worklet module so addModule() is already complete before
  // recording starts. On Firefox, addModule() can take 10+ seconds to compile
  // the worklet, causing only ~2s of audio to be captured when recording is
  // triggered by the status poll. We start the compile here, at init time, and
  // reuse the same context+module in startPcmCapture().
  if ('AudioWorklet' in window) {
    try {
      _warmCtx = new AudioContext({ sampleRate: 48000 });
      _warmModuleReady = _warmCtx.audioWorklet.addModule(`/static/js/pcm-worklet.js?v=${ASSET_V}`);
      _warmModuleReady.catch(() => { _warmCtx = null; _warmModuleReady = null; });
    } catch (e) {
      _warmCtx = null; _warmModuleReady = null;
    }
  }

  attachRoomEvents();

  setupDeviceButtons(micDeviceId, camDeviceId);

  try {
    await room.connect(LIVEKIT_URL, token);
    await room.localParticipant.enableCameraAndMicrophone();

    // Build the PCM source→worklet graph now, as soon as the mic track
    // exists, instead of waiting until recording actually starts. On
    // Firefox, MediaStreamAudioSourceNode can take 10+ seconds after
    // creation before it starts delivering real (non-empty) audio frames —
    // independent of the AudioContext's own state — which is what was
    // truncating recordings to just their last few seconds. Building the
    // graph here lets that warm-up happen during idle time so it's already
    // flowing by the time startPcmCapture() wants frames. Fire-and-forget:
    // if it's not ready yet, startPcmCapture() falls back to building fresh.
    prewarmPcmGraph();

    renderLocalParticipant();
    for (const p of room.remoteParticipants.values()) {
      renderRemoteParticipant(p);
    }
    startLatencyMeasure();
  } catch (e) {
    console.error('LiveKit connection failed:', e);
    if (e?.name === 'NotAllowedError') {
      showToast('Microphone/camera access denied — your reverse proxy may be blocking the Permissions-Policy header');
    } else {
      showToast('Could not connect to room — check TURN/network config');
    }
  }

  // Late joiner: if recording is already in progress, start capturing now
  try {
    const s = await fetch(`/api/session/${SESSION_ID}/status`).then(r => r.json());
    if (s.recording && !isRecording) {
      setRecordingUI(true);
      await startLocalRecording();
      showToast('Recording in progress — your track is being captured');
    } else if (s.paused && !isPaused) {
      setRecordingUI(false, true);
      showToast('Recording is paused');
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
    } else if (IS_HOST && isPaused) {
      broadcastData({ type: 'recording_paused' });
    }
    // Host re-broadcasts timer state so late joiners see the current timer
    if (IS_HOST && timerState.active) {
      broadcastTimerState();
    }
  });

  room.on(RoomEvent.ParticipantDisconnected, async p => {
    showToast(`${labelFor(p)} left`);
    removeTile(`tile-${p.identity}`);
    removeTile(`tile-${p.identity}-screen`);
    removeFromQueue(p.identity);
    raisedHands.delete(p.identity);
    updateHandQueue();
    layoutTiles();

    // Spec: if the host drops, recording stops. Guests detect this via
    // the is_host flag in the participant's token metadata.
    if (!IS_HOST && (isRecording || isPaused) && participantIsHost(p)) {
      showToast('Host disconnected — recording stopped');
      await stopLocalRecording();
      setRecordingUI(false);
      await waitForUploads();
    }
  });

  room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;

    // Store microphone SID before any tile check — TrackSubscribed can fire
    // before renderRemoteParticipant creates the tile (e.g. host joining a room
    // where participants are already present), and we need the SID for force-mute.
    if (track.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone) {
      const sid = track.sid || pub.trackSid;
      if (sid) remoteAudioTrackSids.set(participant.identity, sid);
    }

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
    // When our own mic is muted (user-initiated or host force-mute), sync the button
    if (participant === room.localParticipant && pub.source === Track.Source.Microphone) {
      micMuted = true;
      btnMic?.classList.add('muted');
      btnMic?.closest('.device-btn-group')?.classList.add('muted');
    }
  });

  room.on(RoomEvent.TrackUnmuted, (pub, participant) => {
    const tile = document.getElementById(`tile-${participant.identity}`);
    if (tile) updateMuteIndicator(tile, participant);
    // When our own mic is unmuted (user-initiated or host unmute), sync the button
    if (participant === room.localParticipant && pub.source === Track.Source.Microphone) {
      micMuted = false;
      btnMic?.classList.remove('muted');
      btnMic?.closest('.device-btn-group')?.classList.remove('muted');
    }
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

  room.on(RoomEvent.DataReceived, async (data) => {
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
    if (msg.type === 'recording_paused' && !IS_HOST) {
      setRecordingUI(false, true);
      pauseLocalRecording();
    }
    if (msg.type === 'recording_resumed' && !IS_HOST && isPaused) {
      setRecordingUI(true);
      resumeLocalRecording();
    }
    if (msg.type === 'recording_stopped' && !IS_HOST) {
      await stopLocalRecording();
      setRecordingUI(false);
      await waitForUploads();
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
    if (msg.type === 'force_unmute' && msg.identity === identity) {
      await room.localParticipant.setMicrophoneEnabled(true);
      // TrackUnmuted event will sync btnMic and micMuted
    }
    if (msg.type === 'alert') {
      showAlertBanner(msg.text);
    }
    if (msg.type === 'latency_report') {
      participantLatency.set(msg.identity, msg.rttMs);
      const tile = document.getElementById(`tile-${msg.identity}`);
      updateLatencyBadge(tile, msg.rttMs);
      if (tile && localRttMs != null) {
        const badge = tile.querySelector('.latency-ms');
        if (badge) badge.title = `~${localRttMs + msg.rttMs}ms roundtrip`;
      }
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
    if (pub.track && pub.isSubscribed) {
      pub.track.attach();
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
            muteBtn.classList.remove('active'); // revert on failure
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
          try { await room.switchActiveDevice('audioinput', d.deviceId); } catch (err) {}
          if (isRecording && pcmNode) await restartPcmCapture();
        } else {
          activeCamDeviceId = d.deviceId;
          try { await room.switchActiveDevice('videoinput', d.deviceId); } catch (err) {}
        }
      });
      dropdown.appendChild(btn);
    });
  } catch (e) {
    console.warn('Could not enumerate devices:', e);
  }

  dropdown.classList.add('open');
  document.getElementById(caretId)?.classList.add('open');
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
}

async function restartPcmCapture() {
  pcmNode.port.onmessage = null;
  try { pcmSource.disconnect(); pcmNode.disconnect(); } catch (e) {}
  if (pcmFrames > 0) flushPcm(false); // upload buffered audio without finalizing
  pcmCtx?.close();
  pcmCloneTrack?.stop();
  pcmCtx = pcmNode = pcmSource = pcmStream = pcmCloneTrack = null;
  pcmCapturing = false;
  try {
    await startPcmCapture();
  } catch (e) {
    console.warn('Could not restart PCM after mic switch:', e);
    startOpusFallback();
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

  // Fullscreen API (button / programmatic)
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

  latencyWrap?.addEventListener('click', e => {
    e.stopPropagation();
    const open = statsPanel?.style.display !== 'none';
    if (statsPanel) statsPanel.style.display = open ? 'none' : 'flex';
    latencyWrap.classList.toggle('active', !open);
    if (!open) {
      updateStatsPanel();
      statsInterval = setInterval(updateStatsPanel, 2000);
    } else {
      clearInterval(statsInterval);
      statsInterval = null;
    }
  });
  statsPanel?.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => {
    if (statsPanel && statsPanel.style.display !== 'none') {
      statsPanel.style.display = 'none';
      latencyWrap?.classList.remove('active');
      clearInterval(statsInterval);
      statsInterval = null;
    }
  });

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

  if (IS_HOST) {
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

    btnRecord?.addEventListener('click', startRecording);
    btnPause?.addEventListener('click', pauseRecording);
    btnResume?.addEventListener('click', resumeRecording);
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
        const p = document.createElement('span'); p.className = 'files-participant'; p.textContent = f.participant;
        const t = document.createElement('span'); t.className = `files-type ${f.type}`; t.textContent = f.type;
        const s = document.createElement('span'); s.className = 'files-size'; s.textContent = `${f.size_mb} MB`;
        const a = document.createElement('a'); a.href = `/download/${f.path}`; a.download = ''; a.textContent = '↓';
        const children = [p];
        if (f.take != null) {
          const tk = document.createElement('span'); tk.className = 'files-take'; tk.textContent = `T${f.take}`;
          children.push(tk);
        }
        children.push(t, s, a);
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

// ── Recording control (host) ─────────────────────────────────────────────────

async function _postRecordingAction(action) {
  await fetch(`/api/session/${SESSION_ID}/recording`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host_token: HOST_TOKEN, action }),
  });
}

async function startRecording() {
  if (btnRecord) btnRecord.disabled = true;
  await _postRecordingAction('start');
  await broadcastData({ type: 'recording_started' });
  await showCountdown();
  if (btnRecord) btnRecord.disabled = false;
  setRecordingUI(true);
  await startLocalRecording();
}

async function pauseRecording() {
  if (btnPause) btnPause.disabled = true;
  await _postRecordingAction('pause');
  await broadcastData({ type: 'recording_paused' });
  setRecordingUI(false, true);
  pauseLocalRecording();
  if (btnPause) btnPause.disabled = false;
}

async function resumeRecording() {
  if (btnResume) btnResume.disabled = true;
  await _postRecordingAction('resume');
  await broadcastData({ type: 'recording_resumed' });
  setRecordingUI(true);
  await resumeLocalRecording();
  if (btnResume) btnResume.disabled = false;
}

async function stopRecording() {
  if (btnStopRec) btnStopRec.disabled = true;
  await _postRecordingAction('stop');
  await broadcastData({ type: 'recording_stopped' });
  await stopLocalRecording();
  setRecordingUI(false);
  await waitForUploads();
  if (btnStopRec) btnStopRec.disabled = false;
}

async function waitForUploads() {
  showUploadBanner('uploading');
  const _unloadGuard = e => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', _unloadGuard);
  try {
    await Promise.all(Object.values(uploadQueues));
    sessionStorage.removeItem(`podbooth:epoch:${SESSION_ID}:${identity}`);
    showUploadBanner('done');
    setTimeout(() => hideUploadBanner(), 8000);
  } catch (e) {
    showUploadBanner('error');
  } finally {
    window.removeEventListener('beforeunload', _unloadGuard);
  }
}

function setRecordingUI(recording, paused = false) {
  isRecording = recording;
  isPaused = !recording && paused;

  if (IS_HOST) {
    const idle = !recording && !isPaused;
    btnRecord  && (btnRecord.style.display   = idle       ? '' : 'none');
    btnPause   && (btnPause.style.display    = recording  ? '' : 'none');
    btnResume  && (btnResume.style.display   = isPaused   ? '' : 'none');
    btnStopRec && (btnStopRec.style.display  = !idle      ? '' : 'none');
  }

  if (recording) {
    recIndicator?.classList.add('active');
    recIndicator?.classList.remove('paused');
    clearInterval(recTimerInterval);
    recordingStartTime = Date.now();
    recTimerInterval = setInterval(updateRecTimer, 1000);
  } else if (isPaused) {
    recIndicator?.classList.remove('active');
    recIndicator?.classList.add('paused');
    if (recordingStartTime) {
      cumulativeElapsedMs += Date.now() - recordingStartTime;
      recordingStartTime = null;
    }
    clearInterval(recTimerInterval);
    recTimerInterval = null;
    // leave recTime showing the elapsed value so the host sees total time so far
  } else {
    recIndicator?.classList.remove('active', 'paused');
    cumulativeElapsedMs = 0;
    clearInterval(recTimerInterval);
    if (recTime) recTime.textContent = '00:00';
    startFilesPoll();
  }
}

function updateRecTimer() {
  if (!recordingStartTime) return;
  const elapsed = Math.floor((Date.now() - recordingStartTime + cumulativeElapsedMs) / 1000);
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
    pcmCapturing || // pcmNode can exist pre-warmed-but-idle; pcmCapturing is the real "recording" signal
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
  recLog('startLocalRecording: begin');
  try {
    // Don't start capturing until the local tracks exist, or we'd record
    // nothing. The status poll can fire before LiveKit finishes connecting.
    if (!(await waitForLocalTracks())) {
      recLog('startLocalRecording: no tracks found after timeout');
      showToast('Could not start recording — no microphone or camera');
      return;
    }
    // Recording may have been stopped while we were waiting for tracks.
    if (!isRecording) { recLog('startLocalRecording: aborted — recording stopped while waiting for tracks'); return; }

    // ── Resume interrupted upload (Feature 4) ──────────────────────────────
    const epochKey = `podbooth:epoch:${SESSION_ID}:${identity}`;
    const savedEpoch = sessionStorage.getItem(epochKey);
    let resumedEpoch = false;
    if (savedEpoch) {
      // Check if any chunks exist for this epoch
      const trackTypes = ['audio', 'video', 'screen'];
      const nextChunks = {};
      let anyChunks = false;
      for (const tt of trackTypes) {
        try {
          const r = await fetch(
            `/api/upload/chunks?session_id=${encodeURIComponent(SESSION_ID)}&identity=${encodeURIComponent(identity)}&participant=${encodeURIComponent(displayName)}&track_type=${tt}&epoch=${encodeURIComponent(savedEpoch)}`
          );
          if (r.ok) {
            const { next_chunk } = await r.json();
            nextChunks[tt] = next_chunk;
            if (next_chunk > 0) anyChunks = true;
          } else {
            nextChunks[tt] = 0;
          }
        } catch (e) {
          nextChunks[tt] = 0;
        }
      }
      if (anyChunks) {
        recordingEpoch = savedEpoch;
        chunkIndex = { audio: nextChunks.audio || 0, video: nextChunks.video || 0, screen: nextChunks.screen || 0 };
        uploadQueues = { audio: Promise.resolve(), video: Promise.resolve(), screen: Promise.resolve() };
        resumedEpoch = true;
        showToast(`Resuming upload from chunk ${JSON.stringify(chunkIndex)}`);
      }
    }

    if (!resumedEpoch) {
      recordingEpoch = Date.now().toString(36); // unique prefix per recording run
      chunkIndex = { audio: 0, video: 0, screen: 0 };
      uploadQueues = { audio: Promise.resolve(), video: Promise.resolve(), screen: Promise.resolve() };
    }

    // Save epoch to sessionStorage so a page reload can resume
    sessionStorage.setItem(epochKey, recordingEpoch);

    recLog('startLocalRecording: epoch=%s resumedEpoch=%s chunkIndex=%o', recordingEpoch, resumedEpoch, chunkIndex);

    // ── VIDEO first ── start it before audio so a slow/failed microphone
    // capture can never block video from recording.
    startVideoRecording();

    // ── AUDIO: raw PCM via AudioWorklet (lossless), Opus fallback ──
    try {
      await startPcmCapture();
      audioFormat = 'pcm';
      recLog('startLocalRecording: audio=pcm');
    } catch (e) {
      console.warn('PCM capture unavailable, falling back to Opus:', e);
      audioFormat = 'container';
      startOpusFallback();
      recLog('startLocalRecording: audio=opus-fallback');
    }

    // ── SCREEN: record screen share if it's already active ──
    if (getScreenTrack()) {
      startScreenRecording();
    }
    recLog('startLocalRecording: all recorders started');
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
    ['video/webm;codecs=h264,opus', 'webm'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  const found = candidates.find(([mime]) => MediaRecorder.isTypeSupported(mime));
  if (!found) {
    showToast('Video recording not supported in this browser');
    return;
  }
  const [mime, ext] = found;
  videoExt = ext;

  // Include the live mic track so the browser muxes A/V with shared hardware
  // timestamps — this eliminates clock-rate drift between audio and video.
  // We still record raw PCM separately for full-quality audio; the embedded
  // audio track here is only a sync reference and can be discarded in post.
  const micTrack = getLocalTrack('audio');
  const streamTracks = [camTrack.mediaStreamTrack];
  if (micTrack) streamTracks.push(micTrack.mediaStreamTrack);
  const hasAudioSync = streamTracks.length > 1;

  const camStream = new MediaStream(streamTracks);
  videoRecorder = new MediaRecorder(camStream, {
    mimeType: mime,
    videoBitsPerSecond: 12_000_000, // generous for 1080p30
  });
  videoStartTime = null;
  videoRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) {
      if (videoStartTime === null) videoStartTime = performance.now();
      const idx = chunkIndex.video;
      recLog('video ondataavailable: chunk=%d size=%d bytes', idx, e.data.size);
      enqueueChunk(e.data, 'video', videoExt);
    } else {
      recLog('video ondataavailable: empty chunk (skipped)');
    }
  };
  videoRecorder.onstop = () => {
    recLog('video onstop: finalizing, startTime=%s hasAudioSync=%s', videoStartTime, hasAudioSync);
    finalizeTrack('video', {
      format: 'container',
      start_time_ms: videoStartTime,
      has_audio_sync: hasAudioSync,
    });
  };
  recLog('video recorder started: mime=%s', mime);
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

// Route the worklet's (silent) output through an explicit zero-gain node
// rather than straight to destination. The worklet never writes to its
// output buffer so this is silence either way, but Firefox has reportedly
// been more reliable about continuing to schedule a worklet when its output
// actually reaches a rendering destination through a "real" node, vs. a
// node that processes audio but never produces non-zero samples.
function _connectPcmKeepAlive(node, ctx) {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  node.connect(gain);
  gain.connect(ctx.destination);
}

// Shared message handler for the PCM worklet port — used by both the
// pre-built graph (prewarmPcmGraph) and the fallback build-fresh path in
// startPcmCapture. Buffering is gated on pcmCapturing so the pre-built graph
// can sit connected and "warming up" on Firefox without accumulating audio
// before a recording has actually been requested.
function _onPcmMessage(e) {
  const channels = e.data;
  if (e.data?.type === 'drained') return; // handled by drain handshake
  if (!pcmCapturing) return;
  if (!channels || !channels.length) return;
  if (audioStartTime === null) audioStartTime = performance.now();
  pcmChannels = 2; // always stereo; interleave duplicates mono source if needed
  // Found it: muting goes through room.localParticipant.setMicrophoneEnabled(),
  // which disables the underlying MediaStreamTrack. Chrome keeps delivering
  // silent (zeroed) frames from a disabled track, so the timeline stays
  // correct; Firefox stops delivering ANY frames at all, so every muted
  // second was silently missing from the recording — that's the actual
  // truncation bug, not a worklet-scheduling or warm-up issue. Our PCM tap
  // now runs off an independent clone() that's never disabled (see
  // _clonePcmInputStream), so frames keep arriving in every browser
  // regardless of mute state; we silence them ourselves here so muted
  // periods are real silence (not real audio, not a gap) consistently
  // across browsers instead of depending on browser-specific behavior.
  pcmBuffers.push(micMuted ? channels.map(ch => new Float32Array(ch.length)) : channels);
  pcmFrames += channels[0].length;
  if (pcmFrames >= pcmCtx.sampleRate * 5) {
    flushPcm(false);
  }
}

// Clone the mic track for our own PCM tap instead of sharing LiveKit's
// published track directly. clone() reuses the same underlying capture
// session (no second device open, so no echo-cancellation contention like
// the independent-getUserMedia attempt had) but gives us a track with its
// own independent `enabled` flag — muting the original (via
// setMicrophoneEnabled) leaves our clone untouched, so it keeps delivering
// real frames continuously. We silence them ourselves in _onPcmMessage
// while micMuted is true.
function _clonePcmInputStream(micTrack) {
  pcmCloneTrack = micTrack.mediaStreamTrack.clone();
  return new MediaStream([pcmCloneTrack]);
}

// Build the PCM source→worklet graph ahead of time (called from init() once
// the local mic track exists) so it's already flowing real audio by the time
// a recording starts.
async function prewarmPcmGraph() {
  if (!('AudioWorkletNode' in window)) return;
  if (!_warmCtx || !_warmModuleReady) return;
  const micTrack = getLocalTrack('audio');
  if (!micTrack) return;

  try {
    const ctx = _warmCtx;
    await _warmModuleReady;
    _warmCtx = null;
    _warmModuleReady = null;

    pcmCtx = ctx;
    pcmStream = _clonePcmInputStream(micTrack);
    pcmSource = pcmCtx.createMediaStreamSource(pcmStream);
    pcmNode = new AudioWorkletNode(pcmCtx, 'pcm-capture', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    pcmNode.port.onmessage = _onPcmMessage;
    pcmSource.connect(pcmNode);
    _connectPcmKeepAlive(pcmNode, pcmCtx);
    recLog('prewarmPcmGraph: PCM graph pre-built, ctx.state=%s', pcmCtx.state);
  } catch (e) {
    recLog('prewarmPcmGraph: failed: %s', e);
    try { pcmCtx?.close(); } catch (_e) {}
    pcmCloneTrack?.stop();
    pcmCtx = pcmNode = pcmSource = pcmStream = pcmCloneTrack = null;
  }
}

async function startPcmCapture() {
  if (!('AudioWorkletNode' in window)) throw new Error('AudioWorklet not supported');

  // Common case: prewarmPcmGraph() already built the graph in the background
  // after enableCameraAndMicrophone(), giving Firefox's
  // MediaStreamAudioSourceNode time to start flowing real audio before
  // recording starts. Just reset the counters and flip the capture flag.
  if (pcmCtx && pcmNode && pcmSource) {
    recLog('startPcmCapture: using pre-built graph (ctx.state=%s)', pcmCtx.state);
    if (pcmCtx.state !== 'running') {
      recLog('startPcmCapture: ctx.state=%s — resuming', pcmCtx.state);
      try { await pcmCtx.resume(); } catch (e) { recLog('startPcmCapture: resume() threw: %s', e); }
    }
    pcmBuffers = [];
    pcmFrames = 0;
    pcmFramesWritten = 0;
    audioStartTime = null;
    pcmCapturing = true;
    recLog('PCM capture started (pre-built graph): sampleRate=%d', pcmCtx.sampleRate);
    return;
  }

  // Fallback: prewarm didn't run (e.g. AudioWorklet unsupported at init time)
  // or this is a restart after a mic-device switch — build everything fresh.
  const micTrack = getLocalTrack('audio');
  if (!micTrack) throw new Error('No local microphone track');

  pcmStream = _clonePcmInputStream(micTrack);

  // Reuse the pre-warmed context if available (addModule already ran at init
  // time); otherwise create fresh and pay the compile cost now.
  if (_warmCtx && _warmModuleReady) {
    pcmCtx = _warmCtx;
    const ready = _warmModuleReady;
    _warmCtx = null;
    _warmModuleReady = null;
    recLog('startPcmCapture: using pre-warmed ctx (state=%s)', pcmCtx.state);
    await ready; // no-op if already resolved; waits if still compiling
  } else {
    recLog('startPcmCapture: no pre-warm, calling addModule now');
    pcmCtx = new AudioContext({ sampleRate: 48000 });
    await pcmCtx.audioWorklet.addModule(`/static/js/pcm-worklet.js?v=${ASSET_V}`);
  }

  // Resume if the context started suspended (can happen when triggered without
  // a direct user gesture, e.g. status-poll path for a late joiner).
  if (pcmCtx.state !== 'running') {
    recLog('startPcmCapture: ctx.state=%s — resuming', pcmCtx.state);
    try { await pcmCtx.resume(); } catch (e) { recLog('startPcmCapture: resume() threw: %s', e); }
  }
  recLog('startPcmCapture: ready, ctx.state=%s', pcmCtx.state);

  pcmSource = pcmCtx.createMediaStreamSource(pcmStream);
  pcmNode = new AudioWorkletNode(pcmCtx, 'pcm-capture', {
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });

  pcmBuffers = [];
  pcmFrames = 0;
  pcmFramesWritten = 0;
  audioStartTime = null;
  pcmCapturing = true;

  pcmNode.port.onmessage = _onPcmMessage;
  recLog('PCM capture started: sampleRate=%d', pcmCtx.sampleRate);

  pcmSource.connect(pcmNode);
  _connectPcmKeepAlive(pcmNode, pcmCtx);
}

function flushPcm(isLast) {
  if (pcmFrames > 0) {
    const frames = pcmFrames;
    const ch = pcmChannels;
    // Snapshot the chunk's frame offset before clearing state so the server
    // can reconstruct the exact position of each chunk in the audio timeline
    // and detect clock-rate drift by comparing cumulative frame counts to
    // wall-clock timestamps.
    const chunkOffsetS = pcmFramesWritten / (pcmCtx?.sampleRate ?? 48000);
    const durationS = frames / (pcmCtx?.sampleRate ?? 48000);
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
    pcmFramesWritten += frames;
    const audioIdx = chunkIndex.audio;
    recLog('flushPcm: chunk=%d offsetS=%.2f durationS=%.2f isLast=%s', audioIdx, chunkOffsetS, durationS, isLast);
    enqueueChunk(new Blob([interleaved.buffer]), 'audio', 'raw', { chunk_offset_s: chunkOffsetS });
  } else if (isLast) {
    recLog('flushPcm(last): pcmFrames=0, nothing to flush');
  }

  if (isLast) {
    const totalS = pcmFramesWritten / (pcmCtx?.sampleRate ?? 48000);
    recLog('flushPcm: finalizing audio, totalDurationS=%.2f', totalS);
    finalizeTrack('audio', {
      format: 'pcm',
      sample_rate: pcmCtx ? pcmCtx.sampleRate : 48000,
      channels: pcmChannels,
      start_time_ms: audioStartTime,
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
  audioStartTime = null;
  audioRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) {
      if (audioStartTime === null) audioStartTime = performance.now();
      enqueueChunk(e.data, 'audio', ext);
    }
  };
  audioRecorder.onstop = () => {
    finalizeTrack('audio', { format: 'container', start_time_ms: audioStartTime });
  };
  audioRecorder.start(5000);
}

function pauseLocalRecording() {
  // Recorders keep running so stop() reliably fires onstop → finalize.
  // The pause period will appear in the output file; hosts can trim it in editing.
}

async function resumeLocalRecording() {
  if (!hasActiveRecorders()) {
    // Page was reloaded during a pause — start a fresh take
    await startLocalRecording();
  }
  // Otherwise recorders were never stopped, nothing to do
}

async function stopLocalRecording() {
  micMuted = false;
  recLog('stopLocalRecording: begin');

  // For each MediaRecorder, wrap its onstop so we get an explicit signal that
  // the final ondataavailable (and thus the finalize enqueue) has completed.
  // Without this we're racing against the 100ms delay in waitForUploads, which
  // is fragile when the browser is under load (e.g. two browsers on one machine).
  function stoppedPromise(rec, label) {
    return new Promise(resolve => {
      const prev = rec.onstop;
      rec.onstop = e => { prev?.call(rec, e); recLog('stopLocalRecording: %s onstop resolved', label); resolve(); };
    });
  }

  const stopPromises = [];

  // Video
  if (videoRecorder && videoRecorder.state !== 'inactive') {
    recLog('stopLocalRecording: stopping video recorder (state=%s)', videoRecorder.state);
    stopPromises.push(stoppedPromise(videoRecorder, 'video'));
    videoRecorder.stop();
  } else {
    recLog('stopLocalRecording: video recorder not active (videoRecorder=%s)', videoRecorder ? videoRecorder.state : 'null');
  }
  videoRecorder = null;

  // Screen share
  if (screenRecorder && screenRecorder.state !== 'inactive') {
    recLog('stopLocalRecording: stopping screen recorder');
    stopPromises.push(stoppedPromise(screenRecorder, 'screen'));
    screenRecorder.stop();
  }
  screenRecorder = null;

  // Opus fallback
  if (audioRecorder && audioRecorder.state !== 'inactive') {
    recLog('stopLocalRecording: stopping opus recorder');
    stopPromises.push(stoppedPromise(audioRecorder, 'opus'));
    audioRecorder.stop();
  }
  audioRecorder = null;
  opusCtx?.close();
  opusCtx = null;

  // PCM audio — stop the source so no new audio enters the worklet, then
  // synchronize with it via a drain handshake before flushing. The worklet
  // echoes "drained" only after posting all prior audio-frame messages, so
  // by the time the promise resolves pcmBuffers is complete. We flush first,
  // then null the handler, so any stray frames that squeezed in before the
  // echo still land in pcmBuffers rather than being discarded.
  if (pcmNode) {
    recLog('stopLocalRecording: PCM drain start (pcmFrames=%d pcmFramesWritten=%d)', pcmFrames, pcmFramesWritten);
    try { pcmSource.disconnect(); } catch (e) {}
    const drainAck = new Promise(resolve => {
      const prev = pcmNode.port.onmessage;
      pcmNode.port.onmessage = e => {
        if (e.data?.type === 'drained') { recLog('stopLocalRecording: worklet drain ack received'); resolve(); return; }
        if (prev) prev(e);
      };
      pcmNode.port.postMessage({ type: 'drain' });
    });
    const drained = await Promise.race([drainAck, new Promise(r => setTimeout(r, 500, 'timeout'))]);
    if (drained === 'timeout') recLog('stopLocalRecording: PCM drain timed out — flushing what we have');
    flushPcm(true);
    pcmNode.port.onmessage = null;
    try { pcmNode.disconnect(); } catch (e) {}
    pcmCtx?.close();
    pcmCloneTrack?.stop();
    pcmCtx = pcmNode = pcmSource = pcmStream = pcmCloneTrack = null;
    pcmCapturing = false;
  } else {
    recLog('stopLocalRecording: no PCM node (audioFormat=%s)', audioFormat);
  }

  // Wait for all MediaRecorder onstop events. By the time each onstop fires,
  // the final ondataavailable chunk is already in the upload queue and
  // finalizeTrack has been called, so the queue is fully populated before
  // waitForUploads sees it.
  recLog('stopLocalRecording: waiting for %d recorder onstop(s)', stopPromises.length);
  await Promise.race([
    Promise.all(stopPromises),
    new Promise(r => setTimeout(r, 5000)),
  ]);
  recLog('stopLocalRecording: done');
}

// ── Upload pipeline ──────────────────────────────────────────────────────────

function enqueueChunk(blob, trackType, ext, meta = {}) {
  const index = chunkIndex[trackType]++;
  const epoch = recordingEpoch;
  uploadQueues[trackType] = uploadQueues[trackType].then(() =>
    uploadChunkWithRetry(blob, trackType, index, ext, epoch, meta)
  );
  return uploadQueues[trackType];
}

async function uploadChunkWithRetry(blob, trackType, index, ext, epoch, meta = {}, attempts = 3) {
  recLog('uploadChunk: %s #%d size=%d', trackType, index, blob.size);
  for (let i = 0; i < attempts; i++) {
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
      if (r.ok) { recLog('uploadChunk: %s #%d ok', trackType, index); return; }
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

// ── Session end ──────────────────────────────────────────────────────────────

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

async function leaveSession() {
  const busy = uploadPending || isRecording || isPaused;
  const msg = busy
    ? 'Recordings are still uploading — leaving now may lose data.\n\nLeave anyway?'
    : 'Leave this session?';
  if (!confirm(msg)) return;

  if (isRecording || isPaused) {
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
  const busy = uploadPending || isRecording || isPaused;
  const msg = busy
    ? 'End this session for everyone? Recordings will finish uploading before you are redirected.'
    : 'End this session for everyone?';
  if (!confirm(msg)) return;

  if (isRecording || isPaused) {
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
  if (isRecording || isPaused) {
    await stopLocalRecording();
    setRecordingUI(false);
  }
  showUploadBanner('uploading');
  const _unloadGuard = e => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', _unloadGuard);
  await new Promise(r => setTimeout(r, 100));
  await Promise.allSettled([uploadQueues.audio, uploadQueues.video, uploadQueues.screen]);
  window.removeEventListener('beforeunload', _unloadGuard);
  window.location.href = '/';
}

function onBeforeUnload(e) {
  if (isRecording || isPaused) {
    // Best effort: stop recorders so final chunks attempt to flush.
    // Browsers don't guarantee async work completes during unload.
    stopLocalRecording();
    e.preventDefault();
    e.returnValue = '';
    return;
  }
  if (uploadPending) {
    e.preventDefault();
    e.returnValue = 'Recordings are still uploading. Leave anyway?';
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
        } else if (data.paused) {
          if (isRecording) {
            setRecordingUI(false, true);
            pauseLocalRecording();
          } else if (!isPaused) {
            setRecordingUI(false, true);
          }
        } else if (isRecording || isPaused) {
          await stopLocalRecording();
          setRecordingUI(false);
          await waitForUploads();
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

// ── Upload banner (Feature 7) ─────────────────────────────────────────────────

function showUploadBanner(state) {
  uploadPending = (state === 'uploading');
  const banner = document.getElementById('upload-banner');
  if (!banner) return;
  banner.classList.remove('hidden', 'uploading', 'done', 'error');
  banner.classList.add(state);
  banner.innerHTML = '';

  const label = document.createElement('span');
  if (state === 'uploading') {
    label.textContent = '⬆ Uploading recordings…';
  } else if (state === 'done') {
    label.textContent = '✓ Recordings uploaded';
  } else {
    label.textContent = '⚠ Upload may be incomplete';
  }
  banner.appendChild(label);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'upload-banner-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Dismiss';
  closeBtn.addEventListener('click', hideUploadBanner);
  banner.appendChild(closeBtn);
}

function hideUploadBanner() {
  uploadPending = false;
  const banner = document.getElementById('upload-banner');
  if (!banner) return;
  banner.classList.add('hidden');
  banner.classList.remove('uploading', 'done', 'error');
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

// ── Start ────────────────────────────────────────────────────────────────────

init().catch(err => {
  console.error(err);
  showToast('Failed to join — see console');
});
