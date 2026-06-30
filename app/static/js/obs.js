const { Room, RoomEvent, Track } = LivekitClient;

const grid     = document.getElementById('grid');
const errorMsg = document.getElementById('error-msg');

// identity → display name (set from metadata or participant name)
const nameMap = new Map();

// ── Layout ────────────────────────────────────────────────────────────────────

function layoutGrid() {
  const tiles = [...grid.querySelectorAll('.obs-tile')];
  const n = tiles.length;
  if (n === 0) { grid.style.gridTemplateColumns = '1fr'; return; }

  if (n === 1) {
    grid.style.gridTemplateColumns = '1fr';
    grid.style.gridTemplateRows   = '1fr';
  } else if (n === 2) {
    grid.style.gridTemplateColumns = '1fr 1fr';
    grid.style.gridTemplateRows   = '1fr';
  } else if (n <= 4) {
    grid.style.gridTemplateColumns = '1fr 1fr';
    grid.style.gridTemplateRows   = '1fr 1fr';
  } else if (n <= 6) {
    grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    grid.style.gridTemplateRows   = '1fr 1fr';
  } else if (n <= 9) {
    grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    grid.style.gridTemplateRows   = 'repeat(3, 1fr)';
  } else {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows   = `repeat(${rows}, 1fr)`;
  }
}

// ── Tile helpers ──────────────────────────────────────────────────────────────

function displayName(participant) {
  return nameMap.get(participant.identity) || participant.name || participant.identity;
}

function createTile(identity, name) {
  const tile = document.createElement('div');
  tile.className = 'obs-tile';
  tile.id = `tile-${identity}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;

  const cover = document.createElement('div');
  cover.className = 'tile-cover';

  const avatar = document.createElement('div');
  avatar.className = 'tile-cover-avatar';
  avatar.textContent = (name || '?').charAt(0);

  const coverName = document.createElement('div');
  coverName.className = 'tile-cover-name';
  coverName.textContent = name || '';

  cover.appendChild(avatar);
  cover.appendChild(coverName);

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = name || identity;

  tile.appendChild(video);
  tile.appendChild(cover);
  tile.appendChild(label);

  grid.appendChild(tile);
  layoutGrid();
  return tile;
}

function removeTile(tileId) {
  const tile = document.getElementById(`tile-${tileId}`);
  if (tile) { tile.remove(); layoutGrid(); }
}

function attachVideo(tileId, track) {
  const tile = document.getElementById(`tile-${tileId}`);
  if (!tile) return;
  const video = tile.querySelector('video');
  track.attach(video);
  const cover = tile.querySelector('.tile-cover');
  if (cover) cover.style.display = 'none';
}

function detachVideo(tileId) {
  const tile = document.getElementById(`tile-${tileId}`);
  if (!tile) return;
  const video = tile.querySelector('video');
  video.srcObject = null;
  const cover = tile.querySelector('.tile-cover');
  if (cover) cover.style.display = '';
}

// ── Room connection ───────────────────────────────────────────────────────────

async function init() {
  let token;
  try {
    const r = await fetch(
      `/api/session/${SESSION_ID}/obs-token?host_token=${encodeURIComponent(HOST_TOKEN)}`
    );
    if (!r.ok) throw new Error(await r.text());
    ({ token } = await r.json());
  } catch (e) {
    errorMsg.textContent = `Failed to get OBS token: ${e.message}`;
    errorMsg.style.display = 'flex';
    return;
  }

  const room = new Room({ adaptiveStream: true, dynacast: true });

  room.on(RoomEvent.ParticipantConnected, p => {
    const name = p.name || p.identity;
    nameMap.set(p.identity, name);
    createTile(p.identity, name);
    p.videoTrackPublications.forEach(pub => {
      if (!pub.track || !pub.isSubscribed) return;
      if (pub.source === Track.Source.Camera) {
        attachVideo(p.identity, pub.track);
      } else if (pub.source === Track.Source.ScreenShare) {
        createTile(`${p.identity}-screen`, `${name} (screen)`);
        attachVideo(`${p.identity}-screen`, pub.track);
      }
    });
  });

  room.on(RoomEvent.ParticipantDisconnected, p => {
    removeTile(p.identity);
    removeTile(`${p.identity}-screen`);
    nameMap.delete(p.identity);
  });

  room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    const name = nameMap.get(participant.identity) || participant.name || participant.identity;
    if (track.kind === Track.Kind.Video) {
      if (pub.source === Track.Source.Camera) {
        attachVideo(participant.identity, track);
      } else if (pub.source === Track.Source.ScreenShare) {
        if (!document.getElementById(`tile-${participant.identity}-screen`)) {
          createTile(`${participant.identity}-screen`, `${name} (screen)`);
        }
        attachVideo(`${participant.identity}-screen`, track);
      }
    }
    if (track.kind === Track.Kind.Audio) {
      track.attach();
    }
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
    if (track.kind === Track.Kind.Video) {
      if (pub.source === Track.Source.Camera) {
        detachVideo(participant.identity);
      } else if (pub.source === Track.Source.ScreenShare) {
        removeTile(`${participant.identity}-screen`);
      }
    }
  });

  try {
    await room.connect(LIVEKIT_URL, token);
  } catch (e) {
    errorMsg.textContent = `Could not connect to room: ${e.message}`;
    errorMsg.style.display = 'flex';
    return;
  }

  // Render participants already in the room
  for (const p of room.remoteParticipants.values()) {
    const name = p.name || p.identity;
    nameMap.set(p.identity, name);
    createTile(p.identity, name);
    p.videoTrackPublications.forEach(pub => {
      if (!pub.track || !pub.isSubscribed) return;
      if (pub.source === Track.Source.Camera) {
        attachVideo(p.identity, pub.track);
      } else if (pub.source === Track.Source.ScreenShare) {
        createTile(`${p.identity}-screen`, `${name} (screen)`);
        attachVideo(`${p.identity}-screen`, pub.track);
      }
    });
    p.audioTrackPublications.forEach(pub => {
      if (pub.track && pub.isSubscribed) pub.track.attach();
    });
  }
}

init();
