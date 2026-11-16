/**
 * fake-livekit.js — dev-only stand-in for the livekit-client UMD bundle.
 *
 * Served in place of the CDN script by scripts/studio-demo.py, so the REAL
 * studio.js / ui.js / recording.js / upload.js run unmodified with no LiveKit
 * server, camera, or microphone.
 *
 *  - Camera/mic/screen are synthetic: an animated canvas (camera, screen) and a
 *    quiet tone (mic). They are real MediaStreamTracks, so MediaRecorder, the
 *    PCM/Opus capture and the upload pipeline all run for real.
 *  - Other browser tabs on the same origin + same session find each other over a
 *    BroadcastChannel: join/leave, mute, screen share, and the data channel
 *    (chat, timer, hands, recording start/stop, ...). A second tab is a second
 *    participant. Remote participants see a synthetic feed labelled with the
 *    sender's name (media is not streamed between tabs).
 *  - `?bots=N` on the studio URL adds N always-present fake participants.
 *
 * Only the API surface the app actually uses is implemented.
 */
(function () {
  'use strict';

  // ── enums ──────────────────────────────────────────────────────────────────
  const Track = {
    Kind: { Audio: 'audio', Video: 'video' },
    Source: { Microphone: 'microphone', Camera: 'camera', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' },
  };
  const RoomEvent = {};
  for (const n of ['ParticipantConnected', 'ParticipantDisconnected', 'TrackSubscribed', 'TrackUnsubscribed',
    'TrackUnpublished', 'LocalTrackPublished', 'LocalTrackUnpublished', 'TrackMuted', 'TrackUnmuted',
    'ConnectionQualityChanged', 'ActiveSpeakersChanged', 'DataReceived', 'Disconnected',
    'Reconnecting', 'Reconnected']) RoomEvent[n] = n;
  const ConnectionQuality = { Excellent: 'excellent', Good: 'good', Poor: 'poor', Lost: 'lost', Unknown: 'unknown' };
  const VideoPresets = { h180: { width: 320, height: 180 }, h360: { width: 640, height: 360 } };

  class Emitter {
    constructor() { this._h = new Map(); }
    on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, new Set()); this._h.get(ev).add(fn); return this; }
    off(ev, fn) { this._h.get(ev)?.delete(fn); return this; }
    emit(ev, ...args) {
      for (const fn of [...(this._h.get(ev) || [])]) {
        try { const r = fn(...args); if (r && r.catch) r.catch(e => console.error('[fake-livekit]', ev, e)); }
        catch (e) { console.error('[fake-livekit]', ev, e); }
      }
    }
  }

  const rid = () => Math.random().toString(36).slice(2, 10);
  const hueOf = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

  // ── synthetic media ───────────────────────────────────────────────────────
  // One animated canvas per (label, kind); drawn with setInterval, not rAF, so
  // it keeps producing frames when the tab is in the background.
  function makeCanvasSource(label, kind) {
    const w = 640, h = 360;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const hue = kind === 'screen' ? 210 : hueOf(label);
    let t = 0;
    const draw = () => {
      t += 1 / 15;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${hue},45%,22%)`);
      g.addColorStop(1, `hsl(${(hue + 50) % 360},45%,12%)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      if (kind === 'screen') {
        ctx.fillStyle = 'rgba(255,255,255,.08)';
        for (let i = 0; i < 9; i++) ctx.fillRect(30, 30 + i * 36, 580 - ((i * 53 + t * 40) % 300), 18);
        ctx.fillStyle = '#fff'; ctx.font = '600 28px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(`${label} — screen share`, 30, h - 24);
      } else {
        // a bobbing "head" so it's obvious the feed is live
        const cx = w / 2 + Math.sin(t * 1.3) * 18, cy = h / 2 - 20 + Math.cos(t * 1.9) * 8;
        ctx.fillStyle = `hsl(${hue},55%,62%)`;
        ctx.beginPath(); ctx.arc(cx, cy - 34, 42, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(cx, cy + 62, 78, 52, 0, Math.PI, 0); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '600 30px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(label, w / 2, h - 28);
      }
      ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = '14px monospace'; ctx.textAlign = 'right';
      ctx.fillText(new Date().toLocaleTimeString(), w - 12, 24);
    };
    draw();
    const timer = setInterval(draw, 1000 / 15);
    return { canvas: c, newTrack: () => c.captureStream(15).getVideoTracks()[0], stop: () => clearInterval(timer) };
  }

  let _ac = null;
  function audioCtx() {
    if (!_ac) {
      _ac = new (window.AudioContext || window.webkitAudioContext)();
      const resume = () => { if (_ac.state !== 'running') _ac.resume().catch(() => {}); };
      for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, resume, { passive: true });
    }
    return _ac;
  }
  // A quiet, slowly pulsing tone so the waveform meter and "audio OK" checks
  // see real signal. (Silent on the speakers: it goes to a MediaStream only.)
  function makeAudioTrack(seed = 0) {
    const ctx = audioCtx();
    const osc = ctx.createOscillator();
    osc.frequency.value = 180 + (seed % 7) * 30;
    const gain = ctx.createGain(); gain.gain.value = 0.0;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.7 + (seed % 5) * 0.2;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.12;
    const bias = ctx.createConstantSource(); bias.offset.value = 0.14;
    lfo.connect(lfoGain).connect(gain.gain); bias.connect(gain.gain);
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start(); lfo.start(); bias.start();
    return dest.stream.getAudioTracks()[0];
  }
  // Remote audio never needs to be audible or even real signal.
  function makeSilentAudioTrack() {
    const ctx = audioCtx();
    const dest = ctx.createMediaStreamDestination();
    return dest.stream.getAudioTracks()[0];
  }

  // ── tracks / publications ─────────────────────────────────────────────────
  class FakeTrack {
    constructor(kind, mst, source) {
      this.kind = kind; this.mediaStreamTrack = mst; this.source = source;
      this.sid = 'TR_' + rid(); this._els = new Set();
    }
    attach(el) {
      const isVideo = this.kind === Track.Kind.Video;
      el = el || document.createElement(isVideo ? 'video' : 'audio');
      el.srcObject = new MediaStream([this.mediaStreamTrack]);
      el.autoplay = true; el.playsInline = true;
      if (this._remote) el.muted = true; // bots / other tabs: no audible tone
      el.play?.().catch(() => {});
      this._els.add(el);
      return el;
    }
    detach(el) { (el ? [el] : [...this._els]).forEach(e => { e.srcObject = null; this._els.delete(e); }); }
    async replaceTrack(mst) {
      this.mediaStreamTrack = mst;
      for (const el of this._els) { el.srcObject = new MediaStream([mst]); el.play?.().catch(() => {}); }
    }
    stop() { try { this.mediaStreamTrack.stop(); } catch (e) {} }
  }

  class FakePublication {
    constructor(track, source) {
      this.track = track; this.source = source; this.kind = track.kind;
      this.trackSid = track.sid; this.isMuted = false; this.isSubscribed = true; this.isEnabled = true;
    }
  }

  // ── participants ──────────────────────────────────────────────────────────
  class Participant {
    constructor(identity, name, metadata) {
      this.identity = identity; this.name = name; this.metadata = metadata || '';
      this.sid = 'PA_' + rid(); this._level = 0;
      this.videoTrackPublications = new Map();
      this.audioTrackPublications = new Map();
    }
    _add(pub) { (pub.kind === Track.Kind.Video ? this.videoTrackPublications : this.audioTrackPublications).set(pub.trackSid, pub); return pub; }
    _remove(pub) { this.videoTrackPublications.delete(pub.trackSid); this.audioTrackPublications.delete(pub.trackSid); }
    getTrackPublication(source) {
      for (const m of [this.audioTrackPublications, this.videoTrackPublications]) {
        for (const p of m.values()) if (p.source === source) return p;
      }
      return undefined;
    }
    get audioLevel() { return this._level; }
    get isMicrophoneEnabled() { const p = this.getTrackPublication(Track.Source.Microphone); return !!p && !p.isMuted; }
    get isCameraEnabled() { const p = this.getTrackPublication(Track.Source.Camera); return !!p && !p.isMuted; }
    get isScreenShareEnabled() { return !!this.getTrackPublication(Track.Source.ScreenShare); }
  }

  class RemoteParticipant extends Participant {
    constructor(identity, name, metadata, opts = {}) {
      super(identity, name, metadata);
      this._cam = makeCanvasSource(name || identity, 'camera');
      const cam = new FakeTrack(Track.Kind.Video, this._cam.newTrack(), Track.Source.Camera); cam._remote = true;
      const mic = new FakeTrack(Track.Kind.Audio, makeSilentAudioTrack(), Track.Source.Microphone); mic._remote = true;
      this._add(new FakePublication(cam, Track.Source.Camera));
      this._add(new FakePublication(mic, Track.Source.Microphone));
      this.getTrackPublication(Track.Source.Camera).isMuted = opts.cam === false;
      this.getTrackPublication(Track.Source.Microphone).isMuted = opts.mic === false;
    }
    _dispose() {
      this._cam?.stop(); this._screen?.stop();
      for (const m of [this.videoTrackPublications, this.audioTrackPublications]) for (const p of m.values()) p.track.stop();
    }
  }

  class LocalParticipant extends Participant {
    constructor(room, identity, name, metadata) {
      super(identity, name, metadata);
      this._room = room; this._src = null;
    }
    async enableCameraAndMicrophone() {
      await this.setMicrophoneEnabled(true);
      await this.setCameraEnabled(true);
    }
    async setMicrophoneEnabled(on) {
      let pub = this.getTrackPublication(Track.Source.Microphone);
      if (!pub) {
        if (!on) return;
        const t = new FakeTrack(Track.Kind.Audio, makeAudioTrack(hueOf(this.identity)), Track.Source.Microphone);
        pub = this._add(new FakePublication(t, Track.Source.Microphone));
        this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
      } else {
        pub.track.mediaStreamTrack.enabled = on;
        pub.isMuted = !on;
        this._room.emit(on ? RoomEvent.TrackUnmuted : RoomEvent.TrackMuted, pub, this);
      }
      this._room._send({ k: 'mute', id: this.identity, source: 'microphone', muted: !on });
    }
    async setCameraEnabled(on) {
      let pub = this.getTrackPublication(Track.Source.Camera);
      if (!pub) {
        if (!on) return;
        this._src = makeCanvasSource(this.name || this.identity, 'camera');
        const t = new FakeTrack(Track.Kind.Video, this._src.newTrack(), Track.Source.Camera);
        pub = this._add(new FakePublication(t, Track.Source.Camera));
        this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
      } else if (on) {
        // Like real LiveKit: re-enabling after a disable gives the same
        // publication a fresh underlying MediaStreamTrack.
        if (pub.isMuted) await pub.track.replaceTrack(this._src.newTrack());
        pub.isMuted = false;
        this._room.emit(RoomEvent.TrackUnmuted, pub, this);
      } else {
        pub.track.stop(); // stops the underlying track in place
        pub.isMuted = true;
        this._room.emit(RoomEvent.TrackMuted, pub, this);
      }
      this._room._send({ k: 'mute', id: this.identity, source: 'camera', muted: !on });
    }
    async setScreenShareEnabled(on) {
      let pub = this.getTrackPublication(Track.Source.ScreenShare);
      if (on && !pub) {
        this._screenSrc = makeCanvasSource(this.name || this.identity, 'screen');
        const t = new FakeTrack(Track.Kind.Video, this._screenSrc.newTrack(), Track.Source.ScreenShare);
        pub = this._add(new FakePublication(t, Track.Source.ScreenShare));
        this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
        this._room._send({ k: 'screen', id: this.identity, on: true });
      } else if (!on && pub) {
        pub.track.stop(); this._screenSrc?.stop(); this._remove(pub);
        this._room.emit(RoomEvent.LocalTrackUnpublished, pub, this);
        this._room._send({ k: 'screen', id: this.identity, on: false });
      }
    }
    async publishData(data /*, opts */) {
      this._room._send({ k: 'data', id: this.identity, payload: data });
    }
  }

  // ── room ──────────────────────────────────────────────────────────────────
  function decodeJwt(token) {
    try {
      const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b + '='.repeat((4 - b.length % 4) % 4)))));
    } catch (e) { return {}; }
  }

  class Room extends Emitter {
    constructor(opts) {
      super();
      this.options = opts; this.state = 'disconnected';
      this.remoteParticipants = new Map();
      this.localParticipant = null;
      this.engine = { publisher: null, subscriber: null }; // no RTCPeerConnection: stats panel shows "unavailable"
      this._bc = null; this._seen = new Map(); this._timers = [];
    }
    async connect(url, token) {
      const claims = decodeJwt(token);
      const identity = claims.sub || claims.identity || 'user-' + rid();
      const roomName = claims.video?.room || 'room';
      this.localParticipant = new LocalParticipant(this, identity, claims.name || identity, claims.metadata || '');
      this.name = roomName;
      this._bc = new BroadcastChannel('podbooth-fake-livekit:' + roomName);
      this._bc.onmessage = e => this._recv(e.data);
      this.state = 'connected';

      // Always-present fake participants: ?bots=N
      const n = parseInt(new URLSearchParams(location.search).get('bots') || '0', 10) || 0;
      for (let i = 1; i <= n; i++) {
        this._addRemote(`bot-${i}`, `Bot ${i}`, JSON.stringify({ is_host: false }), { mic: i % 3 !== 0 }, true);
      }

      this._announce('join');
      this._timers.push(setInterval(() => this._tick(), 1000));
      window.addEventListener('pagehide', () => this._leave());
      return this;
    }
    _announce(k) {
      const lp = this.localParticipant;
      this._send({ k, id: lp.identity, name: lp.name, meta: lp.metadata, cam: lp.isCameraEnabled, mic: lp.isMicrophoneEnabled, screen: lp.isScreenShareEnabled });
    }
    _send(m) { try { this._bc?.postMessage(m); } catch (e) { console.warn('[fake-livekit] send failed', e); } }
    _leave() { if (this._bc) this._send({ k: 'leave', id: this.localParticipant.identity }); }

    _addRemote(id, name, meta, opts, isBot) {
      if (this.remoteParticipants.has(id)) return this.remoteParticipants.get(id);
      const p = new RemoteParticipant(id, name, meta, opts);
      p._bot = !!isBot;
      this.remoteParticipants.set(id, p);
      this._seen.set(id, Date.now());
      this.emit(RoomEvent.ParticipantConnected, p);
      this.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Excellent, p);
      return p;
    }
    _removeRemote(id) {
      const p = this.remoteParticipants.get(id);
      if (!p) return;
      this.remoteParticipants.delete(id); this._seen.delete(id);
      this.emit(RoomEvent.ParticipantDisconnected, p);
      p._dispose();
    }
    _setRemoteScreen(p, on) {
      const ex = p.getTrackPublication(Track.Source.ScreenShare);
      if (on && !ex) {
        p._screen = makeCanvasSource(p.name || p.identity, 'screen');
        const t = new FakeTrack(Track.Kind.Video, p._screen.newTrack(), Track.Source.ScreenShare); t._remote = true;
        const pub = p._add(new FakePublication(t, Track.Source.ScreenShare));
        this.emit(RoomEvent.TrackSubscribed, t, pub, p);
      } else if (!on && ex) {
        p._screen?.stop(); ex.track.stop(); p._remove(ex);
        this.emit(RoomEvent.TrackUnpublished, ex, p);
      }
    }
    _recv(m) {
      if (!m || !this.localParticipant || m.id === this.localParticipant.identity) return;
      if (m.id) this._seen.set(m.id, Date.now());
      switch (m.k) {
        case 'join':
        case 'hello': {
          const known = this.remoteParticipants.has(m.id);
          const p = this._addRemote(m.id, m.name, m.meta, { cam: m.cam, mic: m.mic });
          if (m.screen) this._setRemoteScreen(p, true);
          if (!known && m.k === 'join') this._announce('hello'); // tell the newcomer we're here
          break;
        }
        case 'leave': this._removeRemote(m.id); break;
        case 'hb': { const p = this.remoteParticipants.get(m.id); if (p) p._level = m.level || 0; break; }
        case 'mute': {
          const p = this.remoteParticipants.get(m.id);
          const pub = p?.getTrackPublication(m.source);
          if (!pub) break;
          pub.isMuted = !!m.muted;
          this.emit(m.muted ? RoomEvent.TrackMuted : RoomEvent.TrackUnmuted, pub, p);
          break;
        }
        case 'screen': { const p = this.remoteParticipants.get(m.id); if (p) this._setRemoteScreen(p, m.on); break; }
        case 'data': this.emit(RoomEvent.DataReceived, m.payload, this.remoteParticipants.get(m.id)); break;
      }
    }
    _tick() {
      const lp = this.localParticipant;
      // fake audio levels: pulsing while a mic is live, so meters/speaker highlight move
      const lvl = (p, i) => (p.isMicrophoneEnabled ? Math.max(0, 0.5 * Math.sin(Date.now() / (700 + i * 130) + i * 2)) : 0);
      lp._level = lvl(lp, 0);
      let i = 1;
      for (const p of this.remoteParticipants.values()) { if (p._bot) p._level = lvl(p, i); i++; }
      this._send({ k: 'hb', id: lp.identity, level: lp._level });

      // drop tabs that vanished without a pagehide (crash, killed process)
      const now = Date.now();
      for (const [id, ts] of this._seen) {
        const p = this.remoteParticipants.get(id);
        if (p && !p._bot && now - ts > 10000) this._removeRemote(id);
      }
      const all = [lp, ...this.remoteParticipants.values()].filter(p => p._level > 0.15).sort((a, b) => b._level - a._level);
      this.emit(RoomEvent.ActiveSpeakersChanged, all.slice(0, 2));
    }
    async switchActiveDevice(kind /*, deviceId */) {
      const lp = this.localParticipant;
      if (kind === 'audioinput') {
        const pub = lp.getTrackPublication(Track.Source.Microphone);
        if (pub) { const old = pub.track.mediaStreamTrack; await pub.track.replaceTrack(makeAudioTrack(Date.now() % 97)); old.stop(); }
      } else if (kind === 'videoinput') {
        const pub = lp.getTrackPublication(Track.Source.Camera);
        if (pub && lp._src) { const old = pub.track.mediaStreamTrack; await pub.track.replaceTrack(lp._src.newTrack()); old.stop(); }
      }
      return true;
    }
    async disconnect() {
      if (this.state === 'disconnected') return;
      this._leave();
      this._timers.forEach(clearInterval);
      this._bc?.close(); this._bc = null;
      this.state = 'disconnected';
      for (const id of [...this.remoteParticipants.keys()]) this._removeRemote(id);
      this.emit(RoomEvent.Disconnected);
    }
  }

  // ── navigator.mediaDevices shim ───────────────────────────────────────────
  // Non-secure origins (http://<lan-ip>) have no navigator.mediaDevices at
  // all, and a headless/remote machine has no real devices — so always present
  // a fixed set of labelled fake ones, and serve getUserMedia from the same
  // synthetic sources (this is what the pre-join page uses for its preview).
  const FAKE_DEVICES = [
    { deviceId: 'fake-mic-1', kind: 'audioinput', label: 'Fake Microphone 1', groupId: 'g1' },
    { deviceId: 'fake-mic-2', kind: 'audioinput', label: 'Fake Microphone 2', groupId: 'g2' },
    { deviceId: 'fake-cam-1', kind: 'videoinput', label: 'Fake Camera 1', groupId: 'g3' },
    { deviceId: 'fake-cam-2', kind: 'videoinput', label: 'Fake Camera 2', groupId: 'g4' },
    { deviceId: 'fake-spk-1', kind: 'audiooutput', label: 'Fake Speakers', groupId: 'g5' },
  ].map(d => Object.assign({ toJSON() { return this; } }, d));
  const md = {
    _t: new EventTarget(),
    enumerateDevices: async () => FAKE_DEVICES,
    getUserMedia: async (c = {}) => {
      const tracks = [];
      if (c.audio) tracks.push(makeAudioTrack(3));
      if (c.video) tracks.push(makeCanvasSource('Preview', 'camera').newTrack());
      return new MediaStream(tracks);
    },
    getDisplayMedia: async () => new MediaStream([makeCanvasSource('Screen', 'screen').newTrack()]),
    getSupportedConstraints: () => ({}),
    addEventListener(...a) { md._t.addEventListener(...a); },
    removeEventListener(...a) { md._t.removeEventListener(...a); },
    dispatchEvent(e) { return md._t.dispatchEvent(e); },
  };
  try { Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); }
  catch (e) { console.warn('[fake-livekit] could not install mediaDevices shim', e); }

  window.LivekitClient = { Room, RoomEvent, Track, ConnectionQuality, VideoPresets, LocalParticipant, RemoteParticipant };
  console.info('%c[studio-demo] using FAKE LiveKit — no media server, synthetic camera/mic', 'color:#e85d00');
})();
