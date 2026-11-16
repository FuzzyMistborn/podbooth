// The dev studio (scripts/studio-demo.py) swaps LiveKit for
// scripts/studio-demo/fake-livekit.js. This checks its cross-tab behaviour — the
// part that decides whether a host tab and a guest tab "see" each other. Media
// (canvas / AudioContext) is stubbed; BroadcastChannel is Node's own.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/studio-demo/fake-livekit.js');
const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));
const noopCtx = new Proxy({}, { get: (t, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
const track = kind => ({ kind, enabled: true, stop() {} });
const node = () => { const n = { frequency: {}, gain: {}, offset: {}, connect: x => x, start() {} }; return n; };

let LK;
beforeAll(() => {
  // defineProperty, not assignment: newer Node versions ship getter-only globals
  // (navigator, ...) that a plain `globalThis.x = ...` throws on (see harness.js).
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true, enumerable: true });
  def('window', globalThis);
  if (typeof globalThis.addEventListener !== 'function') def('addEventListener', () => {});
  def('location', { search: '' });
  def('navigator', {});
  def('MediaStream', class { constructor(t = []) { this.t = t; } getVideoTracks() { return this.t.filter(x => x.kind === 'video'); } getAudioTracks() { return this.t.filter(x => x.kind === 'audio'); } });
  def('AudioContext', class {
    state = 'running';
    createOscillator = node; createGain = node; createConstantSource = node;
    createMediaStreamDestination() { return { stream: new MediaStream([track('audio')]) }; }
  });
  def('document', {
    addEventListener() {},
    createElement: () => ({ width: 0, height: 0, getContext: () => noopCtx, captureStream: () => new MediaStream([track('video')]), play: () => Promise.resolve() }),
  });
  (0, eval)(fs.readFileSync(FILE, 'utf8'));
  LK = globalThis.LivekitClient;
});
afterAll(() => { delete globalThis.LivekitClient; });

const jwt = (identity, name, meta = '{}') =>
  'h.' + Buffer.from(JSON.stringify({ sub: identity, name, metadata: meta, video: { room: 'room-' + Math.random() } })).toString('base64url') + '.s';

async function twoRooms() {
  const room = 'shared-' + Math.random();
  const mk = async (id, name, meta) => {
    const r = new LK.Room();
    const events = [];
    for (const ev of Object.values(LK.RoomEvent)) r.on(ev, (...a) => events.push([ev, ...a]));
    const t = jwt(id, name, meta).split('.');
    t[1] = Buffer.from(JSON.stringify({ sub: id, name, metadata: meta, video: { room } })).toString('base64url');
    await r.connect('ws://x', t.join('.'));
    return { r, events };
  };
  const a = await mk('host-1', 'Host', '{"is_host":true}');
  const b = await mk('guest-1', 'Guest 1', '{"is_host":false}');
  await wait();
  return { a, b };
}

describe('fake LiveKit, two tabs in one session', () => {
  it('each tab sees the other (join + hello), with name and metadata', async () => {
    const { a, b } = await twoRooms();
    expect([...a.r.remoteParticipants.keys()]).toEqual(['guest-1']);
    expect([...b.r.remoteParticipants.keys()]).toEqual(['host-1']);
    const host = b.r.remoteParticipants.get('host-1');
    expect(host.name).toBe('Host');
    expect(JSON.parse(host.metadata).is_host).toBe(true); // guests use this to detect a host drop
    // a remote starts with camera + mic publications, subscribed, so renderRemoteParticipant can attach them
    expect(host.videoTrackPublications.size).toBe(1);
    expect([...host.audioTrackPublications.values()][0].isSubscribed).toBe(true);
    await a.r.disconnect(); await b.r.disconnect();
  });

  it('the data channel reaches the other tab, not the sender', async () => {
    const { a, b } = await twoRooms();
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'timer_update', remaining: 42 }));
    await a.r.localParticipant.publishData(payload, { reliable: true });
    await wait();
    const got = b.events.filter(e => e[0] === 'DataReceived');
    expect(got).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(got[0][1])).remaining).toBe(42);
    expect(a.events.filter(e => e[0] === 'DataReceived')).toHaveLength(0);
    await a.r.disconnect(); await b.r.disconnect();
  });

  it('mute / camera-off propagate as TrackMuted / TrackUnmuted on the right participant', async () => {
    const { a, b } = await twoRooms();
    await a.r.localParticipant.enableCameraAndMicrophone();
    await a.r.localParticipant.setMicrophoneEnabled(false);
    await wait();
    const pub = b.r.remoteParticipants.get('host-1').getTrackPublication(LK.Track.Source.Microphone);
    expect(pub.isMuted).toBe(true);
    expect(b.events.some(e => e[0] === 'TrackMuted' && e[2].identity === 'host-1')).toBe(true);
    await a.r.localParticipant.setMicrophoneEnabled(true);
    await wait();
    expect(pub.isMuted).toBe(false);
    await a.r.disconnect(); await b.r.disconnect();
  });

  it('screen share: remote gets TrackSubscribed (screen source), then TrackUnpublished', async () => {
    const { a, b } = await twoRooms();
    await a.r.localParticipant.setScreenShareEnabled(true);
    await wait();
    const sub = b.events.find(e => e[0] === 'TrackSubscribed' && e[2].source === LK.Track.Source.ScreenShare);
    expect(sub).toBeTruthy();
    expect(a.events.some(e => e[0] === 'LocalTrackPublished')).toBe(true);
    await a.r.localParticipant.setScreenShareEnabled(false);
    await wait();
    expect(b.events.some(e => e[0] === 'TrackUnpublished' && e[1].source === LK.Track.Source.ScreenShare)).toBe(true);
    expect(a.events.some(e => e[0] === 'LocalTrackUnpublished')).toBe(true); // app uses this to clean up its own share
    await a.r.disconnect(); await b.r.disconnect();
  });

  it('disconnect removes the participant on the other tab', async () => {
    const { a, b } = await twoRooms();
    await a.r.disconnect();
    await wait();
    expect(b.r.remoteParticipants.size).toBe(0);
    expect(b.events.some(e => e[0] === 'ParticipantDisconnected' && e[1].identity === 'host-1')).toBe(true);
    await b.r.disconnect();
  });

  it('a late joiner sees someone who is already screen sharing', async () => {
    const room = 'late-' + Math.random();
    const mk = async (id, name) => {
      const r = new LK.Room(); const events = [];
      for (const ev of Object.values(LK.RoomEvent)) r.on(ev, (...x) => events.push([ev, ...x]));
      const t = ['h', Buffer.from(JSON.stringify({ sub: id, name, video: { room } })).toString('base64url'), 's'].join('.');
      await r.connect('ws://x', t); return { r, events };
    };
    const a = await mk('a', 'A'); await a.r.localParticipant.enableCameraAndMicrophone(); await a.r.localParticipant.setScreenShareEnabled(true);
    const b = await mk('b', 'B'); await wait();
    expect(b.events.some(e => e[0] === 'TrackSubscribed' && e[2].source === LK.Track.Source.ScreenShare)).toBe(true);
    await a.r.disconnect(); await b.r.disconnect();
  });
});
