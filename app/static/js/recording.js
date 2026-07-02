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


async function stopRecording() {
  if (btnStopRec) btnStopRec.disabled = true;
  await _postRecordingAction('stop');
  await broadcastData({ type: 'recording_stopped' });
  await stopLocalRecording();
  setRecordingUI(false);
  await waitForUploads();
  if (btnStopRec) btnStopRec.disabled = false;
  if (typeof showLocalUploadButton === 'function') showLocalUploadButton();
}

function setRecordingUI(recording) {
  isRecording = recording;

  topicGroup && (topicGroup.style.display = recording ? '' : 'none');
  if (!recording) {
    const popover = document.getElementById('topic-popover');
    if (popover?.classList.contains('open')) {
      popover.classList.remove('open');
      btnNewTopic?.classList.remove('active');
    }
  }
  if (IS_HOST) {
    btnRecord  && (btnRecord.style.display   = recording ? 'none' : '');
    btnStopRec && (btnStopRec.style.display  = recording ? '' : 'none');
  }

  if (recording) {
    recIndicator?.classList.add('active');
    clearInterval(recTimerInterval);
    recordingStartTime = Date.now();
    recTimerInterval = setInterval(updateRecTimer, 1000);
    startRecStatus();
  } else {
    recIndicator?.classList.remove('active');
    cumulativeElapsedMs = 0;
    clearInterval(recTimerInterval);
    if (recTime) recTime.textContent = '00:00';
    stopRecStatus();
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

    // ── Resume interrupted upload ──────────────────────────────────────────
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
      recordingEpoch = Date.now().toString(36);
      chunkIndex = { audio: 0, video: 0, screen: 0 };
      uploadQueues = { audio: Promise.resolve(), video: Promise.resolve(), screen: Promise.resolve() };
      uploadStats = { queued: 0, completed: 0 };
    }

    // Save epoch to sessionStorage so a page reload can resume
    sessionStorage.setItem(`podbooth:epoch:${SESSION_ID}:${identity}`, recordingEpoch);

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
  // NOTE: mp4 is deliberately not offered here. Chrome's fragmented-mp4
  // MediaRecorder output cannot be safely byte-concatenated across chunks
  // (trex/track-id mismatches, missing moov) the way webm/matroska clusters
  // can — see the assembly design note at the top of upload.py. ffmpeg
  // transcodes webm to mp4 at assembly time anyway.
  const candidates = [
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
    videoBitsPerSecond: 12_000_000,
  });
  videoRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) {
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
  // Record the actual capture-start instant here, not in ondataavailable —
  // that callback only fires after the first 5s timeslice flushes, which
  // would make video appear to start ~5s later than audio and cause
  // _try_merge_av (server side) to trim real audio content off the front.
  videoStartTime = performance.now();
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
  if (screenRecorder) {
    if (screenRecorder.state !== 'inactive') {
      screenRecorder.stop(); // onstop → finalizeTrack('screen')
    } else {
      // Recorder was already stopped (browser ended the track before we got here);
      // onstop will never fire, so finalize manually to avoid losing the chunks.
      finalizeTrack('screen', { format: 'container' });
    }
  }
  screenRecorder = null;
}

function startScreenRecording() {
  const screenTrack = getScreenTrack();
  if (!screenTrack) return;

  // See note in startVideoRecording: mp4 chunks can't be safely concatenated.
  const candidates = [
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
    if (e.data && e.data.size > 0) {
      recLog('screen ondataavailable: chunk=%d size=%d bytes', chunkIndex.screen, e.data.size);
      enqueueChunk(e.data, 'screen', screenExt);
    } else {
      recLog('screen ondataavailable: empty chunk (skipped)');
    }
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
    await ready;
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
  audioRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) {
      enqueueChunk(e.data, 'audio', ext);
    }
  };
  audioRecorder.onstop = () => {
    finalizeTrack('audio', { format: 'container', start_time_ms: audioStartTime });
  };
  // Same reasoning as videoStartTime: capture at .start() time, not the
  // delayed first ondataavailable, so the server-side offset vs. video is accurate.
  audioStartTime = performance.now();
  audioRecorder.start(5000);
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

async function restartPcmCapture() {
  pcmNode.port.onmessage = null;
  try { pcmSource.disconnect(); pcmNode.disconnect(); } catch (e) {}
  if (pcmFrames > 0) flushPcm(false); // upload buffered audio without finalizing
  pcmCtx?.close();
  pcmCloneTrack?.stop();
  pcmCtx = pcmNode = pcmSource = pcmStream = pcmCloneTrack = null;
  pcmCapturing = false;
  // Rebuilding the AudioContext/worklet below takes real wall-clock time
  // (addModule, node setup) during which no audio frames are captured. If we
  // don't account for that gap, every frame captured after the restart is
  // shifted earlier than it really occurred, and the recording drifts out of
  // sync with video from this point on. Measure the gap and pad it with
  // silence so the frame count stays wall-clock-accurate.
  const gapStart = performance.now();
  try {
    await startPcmCapture();
    const gapMs = performance.now() - gapStart;
    const channels = pcmChannels || 2;
    const silenceFrames = Math.round((gapMs / 1000) * pcmCtx.sampleRate);
    if (silenceFrames > 0) {
      const silenceBlock = Array.from({ length: channels }, () => new Float32Array(silenceFrames));
      // Safe to mutate here, ahead of any queued worklet messages: this runs
      // synchronously right after startPcmCapture() resolves, before the
      // event loop can deliver the next port.onmessage.
      pcmBuffers.unshift(silenceBlock);
      pcmFrames += silenceFrames;
      recLog('restartPcmCapture: padded %dms gap (%d silence frames)', gapMs, silenceFrames);
    }
  } catch (e) {
    console.warn('Could not restart PCM after mic switch:', e);
    startOpusFallback();
  }
}

// ── Recording status popover ─────────────────────────────────────────────────

let recStatusInterval = null;
let recStatusBroadcastTimer = null;

function startRecStatusBroadcast() {
  if (recStatusBroadcastTimer) return;
  function doBroadcast() {
    const backlog = Math.max(0, uploadStats.queued - uploadStats.completed);
    broadcastData({
      type: 'rec_status',
      identity,
      displayName,
      audioOk: !!(pcmCapturing || (audioRecorder && audioRecorder.state === 'recording')),
      videoOk: !videoRecorder || videoRecorder.state === 'recording',
      screenOk: !screenRecorder || screenRecorder.state === 'recording',
      uploadBacklog: backlog,
      uploadError: uploadHasError,
    });
  }
  doBroadcast();
  recStatusBroadcastTimer = setInterval(doBroadcast, 4000);
}

function stopRecStatusBroadcast() {
  clearInterval(recStatusBroadcastTimer);
  recStatusBroadcastTimer = null;
}

function setRecStatus(key, state) {
  const row = document.getElementById(`rstatus-${key}`);
  if (!row) return;
  row.dataset.state = state;
  const icon = row.querySelector('.rstatus-icon');
  if (icon) icon.textContent = state === 'ok' ? '✓' : state === 'warn' ? '⚠' : state === 'error' ? '✗' : '—';
}

function updateRecStatus() {
  setRecStatus('audio', audioRecorder?.state === 'recording' || pcmCapturing ? 'ok' : isRecording ? 'error' : 'idle');
  setRecStatus('video', videoRecorder ? (videoRecorder.state === 'recording' ? 'ok' : 'warn') : 'idle');
  const uploadBacklog = uploadStats.queued - uploadStats.completed;
  setRecStatus('upload', uploadHasError ? 'error' : uploadBacklog > 10 ? 'warn' : 'ok');
  setRecStatus('livekit', room?.state === 'connected' ? 'ok' : 'error');
}

function startRecStatus() {
  updateRecStatus();
  recStatusInterval = setInterval(updateRecStatus, 1500);
  startRecStatusBroadcast();
}

function stopRecStatus() {
  clearInterval(recStatusInterval);
  recStatusInterval = null;
  ['audio', 'video', 'upload', 'livekit'].forEach(k => setRecStatus(k, 'idle'));
  stopRecStatusBroadcast();
}

// ── Topic markers ─────────────────────────────────────────────────────────────

async function createMarkerWithLabel(label) {
  const elapsedMs = recordingStartTime
    ? (Date.now() - recordingStartTime + cumulativeElapsedMs)
    : cumulativeElapsedMs;
  try {
    const r = await fetch(`/api/session/${SESSION_ID}/marker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host_token: HOST_TOKEN,
        identity: typeof identity !== 'undefined' ? identity : '',
        label,
        recording_time_s: Math.floor(elapsedMs / 1000),
      }),
    });
    if (r.ok) {
      showToast(label ? `Marker: "${label}"` : 'Marker saved');
      await broadcastData({ type: 'marker', label, recording_time_s: Math.floor(elapsedMs / 1000) });
    }
  } catch (e) {}
}

async function createMarker() {
  const label = (topicInput?.value || '').trim();
  const elapsedMs = recordingStartTime
    ? (Date.now() - recordingStartTime + cumulativeElapsedMs)
    : cumulativeElapsedMs;

  try {
    const r = await fetch(`/api/session/${SESSION_ID}/marker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host_token: HOST_TOKEN,
        identity: typeof identity !== 'undefined' ? identity : '',
        label,
        recording_time_s: Math.floor(elapsedMs / 1000),
      }),
    });
    if (r.ok) {
      if (topicInput) topicInput.value = '';
      const topicPopover = document.getElementById('topic-popover');
      topicPopover?.classList.remove('open');
      document.getElementById('btn-new-topic')?.classList.remove('active');
      showToast(label ? `Topic marked: "${label}"` : 'Topic marker saved');
      await broadcastData({ type: 'marker', label, recording_time_s: Math.floor(elapsedMs / 1000) });
    } else {
      showToast('Failed to save marker');
    }
  } catch (e) {
    showToast('Failed to save marker');
  }
}
