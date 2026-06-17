/**
 * studio.js — Main recording studio (orchestration core)
 *
 * Loads after recording.js, upload.js, chat.js, and ui.js, which contain
 * the implementation of all feature areas. This file holds shared state,
 * DOM refs, room initialisation, LiveKit event wiring, and top-level helpers.
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
let cumulativeElapsedMs = 0;
let recTimerInterval = null;

let videoRecorder = null;
let videoExt = 'webm';

let screenRecorder = null;
let screenExt = 'webm';

let pcmCtx = null;
let pcmNode = null;
let pcmSource = null;
let pcmStream = null;
let pcmCloneTrack = null;
let pcmBuffers = [];
let pcmFrames = 0;
let pcmFramesWritten = 0;
let pcmChannels = 2;
let pcmCapturing = false;
let opusCtx = null;
let audioFormat = 'pcm';
let audioRecorder = null;
let micMuted = false;

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

let videoStartTime = null;
let audioStartTime = null;

let chunkIndex = { audio: 0, video: 0, screen: 0 };
let uploadQueues = { audio: Promise.resolve(), video: Promise.resolve(), screen: Promise.resolve() };
let uploadPending = false;
let recordingEpoch = '';
let recordingStarting = false;

let uploadStats = { queued: 0, completed: 0 };
let uploadHasError = false;

const DEVICE_KEY_MIC = 'podbooth:mic-device';
const DEVICE_KEY_CAM = 'podbooth:cam-device';
const DEVICE_KEY_SPK = 'podbooth:spk-device';
let activeSpkDeviceId = '';
let activeMicDeviceId = '';
let activeCamDeviceId = '';

const TIMER_SHOW_KEY = 'podbooth:timer-show-time';
const timerQueue = [];
let timerState      = { active: false, paused: false, expired: false, topicIndex: -1, remaining: 0, total: 0 };
let timerInterval   = null;
let timerThresholds = { yellow: 120, red: 60 };
let timerShowTime   = true;
let timerEditIndex  = -1;

const raisedHands = new Map();
const handQueue = [];
let handRaised = false;

const remoteAudioTrackSids = new Map();

let viewMode = 'grid';
const VIEW_KEY = 'podbooth:view';
const pinnedIds = new Set();
let activeSpeakerTileId = null;
const tileOrder = [];

const participantLatency = new Map();
let localRttMs = null;
let latencyInterval = null;

let statsInterval = null;
let prevRtcStats = {};

// ── DOM refs ─────────────────────────────────────────────────────────────────

const grid         = document.getElementById('video-grid');
const emptyMsg     = document.getElementById('empty-msg');
const stage        = document.getElementById('stage');
const filmstrip    = document.getElementById('filmstrip');
const btnView      = document.getElementById('btn-view');
const btnMic       = document.getElementById('btn-mic');
const btnCam       = document.getElementById('btn-cam');
const btnScreen    = document.getElementById('btn-screen');
const btnNewTopic  = document.getElementById('btn-new-topic');
const topicGroup   = document.getElementById('topic-group');
const topicInput   = document.getElementById('topic-input');
const btnRaiseHand = document.getElementById('btn-raise-hand');
const btnRecord    = document.getElementById('btn-record');
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

function recLog(fmt, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[rec ${identity || '?'}] ${ts} ${fmt}`, ...args);
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(window.location.search);
  displayName = (params.get('participant_name') || '').trim();
  let micDeviceId = params.get('mic_device_id') || '';
  let camDeviceId = params.get('cam_device_id') || '';
  try {
    if (!micDeviceId) micDeviceId = localStorage.getItem(DEVICE_KEY_MIC) || '';
    if (!camDeviceId) camDeviceId = localStorage.getItem(DEVICE_KEY_CAM) || '';
    activeSpkDeviceId = localStorage.getItem(DEVICE_KEY_SPK) || '';
  } catch (e) {}

  if (!displayName) {
    const suffix = IS_HOST ? `?host_token=${HOST_TOKEN}` : '';
    window.location.href = `/join/${SESSION_ID}${suffix}`;
    return;
  }

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
  // triggered by the status poll.
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

    // Build the PCM source→worklet graph now so it's already flowing real
    // audio by the time startPcmCapture() wants frames. On Firefox,
    // MediaStreamAudioSourceNode can take 10+ seconds before it delivers
    // real frames. Fire-and-forget: startPcmCapture() falls back if not ready.
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
    if (handRaised) {
      broadcastData({ type: 'hand_raised', identity, displayName });
    }
    if (IS_HOST && isRecording) {
      broadcastData({ type: 'recording_started' });
    }
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
    if (!IS_HOST && isRecording && participantIsHost(p)) {
      showToast('Host disconnected — recording stopped');
      await stopLocalRecording();
      setRecordingUI(false);
      await waitForUploads();
    }
  });

  room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;

    // Store microphone SID before any tile check — TrackSubscribed can fire
    // before renderRemoteParticipant creates the tile, and we need the SID for force-mute.
    if (track.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone) {
      const sid = track.sid || pub.trackSid;
      if (sid) remoteAudioTrackSids.set(participant.identity, sid);
    }

    if (pub.source === Track.Source.ScreenShare) {
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
    if (track.kind === Track.Kind.Audio) {
      const audioEl = track.attach();
      if (audioEl && activeSpkDeviceId && typeof audioEl.setSinkId === 'function') {
        audioEl.setSinkId(activeSpkDeviceId).catch(() => {});
      }
    }
    updateMuteIndicator(tile, participant);
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
    // Note: do NOT remove screen tiles here. With adaptiveStream, an active
    // screen share that scrolls out of view can be auto-unsubscribed; removing
    // it here would wrongly drop a live share. Removal is driven by
    // TrackUnpublished / ParticipantDisconnected.
    const tile = document.getElementById(`tile-${participant.identity}`);
    if (tile) updateMuteIndicator(tile, participant);
  });

  room.on(RoomEvent.TrackUnpublished, (pub, participant) => {
    if (pub.source === Track.Source.ScreenShare) {
      removeTile(`tile-${participant.identity}-screen`);
      layoutTiles();
    }
  });

  // Our own screen share ended — covers the browser's native "Stop sharing" bar.
  room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
    if (pub.source === Track.Source.ScreenShare) cleanupLocalScreen();
  });

  room.on(RoomEvent.TrackMuted, (pub, participant) => {
    const tile = document.getElementById(`tile-${participant.identity}`);
    if (tile) updateMuteIndicator(tile, participant);
    if (participant === room.localParticipant && pub.source === Track.Source.Microphone) {
      micMuted = true;
      btnMic?.classList.add('muted');
      btnMic?.closest('.device-btn-group')?.classList.add('muted');
    }
  });

  room.on(RoomEvent.TrackUnmuted, (pub, participant) => {
    const tile = document.getElementById(`tile-${participant.identity}`);
    if (tile) updateMuteIndicator(tile, participant);
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
    const speakingIds = new Set(speakers.map(p => `tile-${p.identity}`));
    for (const id of tileOrder) {
      document.getElementById(id)?.classList.toggle('speaking', speakingIds.has(id));
    }
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
    }
    if (msg.type === 'alert') {
      showAlertBanner(msg.text);
    }
    if (msg.type === 'marker' && !IS_HOST) {
      const t = msg.recording_time_s ?? 0;
      const m = Math.floor(t / 60);
      const s = String(t % 60).padStart(2, '0');
      const timeStr = `${m}:${s}`;
      const text = msg.label ? `New topic at ${timeStr}: "${msg.label}"` : `New topic marked at ${timeStr}`;
      showToast(text, 5000);
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

function onBeforeUnload(e) {
  if (isRecording) {
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

// ── Start ────────────────────────────────────────────────────────────────────

init().catch(err => {
  console.error(err);
  showToast('Failed to join — see console');
});
