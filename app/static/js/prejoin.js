/**
 * prejoin.js — Device check before entering studio.
 * Forwards host_token through to the studio if present.
 */

const DEVICE_KEY_MIC  = 'podbooth:mic-device';
const DEVICE_KEY_CAM  = 'podbooth:cam-device';
const DEVICE_KEY_SPK  = 'podbooth:spk-device';
const DEVICE_KEY_NAME = 'podbooth:participant-name';

let stream = null;
let audioContext = null;
let analyser = null;
let levelInterval = null;

const preview     = document.getElementById('preview');
const overlay     = document.getElementById('preview-overlay');
const micSelect   = document.getElementById('mic-select');
const camSelect   = document.getElementById('cam-select');
const spkSelect   = document.getElementById('spk-select');
const spkGroup    = document.getElementById('spk-select-group');
const levelFill   = document.getElementById('level-fill');
const nameInput   = document.getElementById('participant-name');
const joinBtn     = document.getElementById('join-btn');

function updateJoinButton() {
  joinBtn.disabled = nameInput.value.trim().length === 0;
}

async function init() {
  try {
    const savedName = localStorage.getItem(DEVICE_KEY_NAME);
    if (savedName) nameInput.value = savedName;
  } catch (e) {}
  await populateDevices();
  await startPreview();
  micSelect.addEventListener('change', startPreview);
  camSelect.addEventListener('change', startPreview);
  nameInput.addEventListener('input', updateJoinButton);
  nameInput.addEventListener('change', updateJoinButton);
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !joinBtn.disabled) joinSession();
  });
  joinBtn.addEventListener('click', joinSession);
  updateJoinButton();
  requestAnimationFrame(updateJoinButton);
  setTimeout(updateJoinButton, 100);
}

async function populateDevices() {
  // Request permissions first so device labels become visible
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    tmp.getTracks().forEach(t => t.stop());
  } catch (e) {}

  const devices = await navigator.mediaDevices.enumerateDevices();
  micSelect.innerHTML = '';
  camSelect.innerHTML = '';

  devices.filter(d => d.kind === 'audioinput').forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${micSelect.options.length + 1}`;
    micSelect.appendChild(opt);
  });

  devices.filter(d => d.kind === 'videoinput').forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${camSelect.options.length + 1}`;
    camSelect.appendChild(opt);
  });

  // Restore saved selections
  try {
    const savedMic = localStorage.getItem(DEVICE_KEY_MIC);
    const savedCam = localStorage.getItem(DEVICE_KEY_CAM);
    if (savedMic && [...micSelect.options].some(o => o.value === savedMic)) micSelect.value = savedMic;
    if (savedCam && [...camSelect.options].some(o => o.value === savedCam)) camSelect.value = savedCam;
  } catch (e) {}

  // Speaker output (Chrome / Edge only — setSinkId not universally supported)
  if (typeof HTMLMediaElement.prototype.setSinkId === 'function' && spkGroup && spkSelect) {
    spkSelect.innerHTML = '';
    devices.filter(d => d.kind === 'audiooutput').forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Speaker ${spkSelect.options.length + 1}`;
      spkSelect.appendChild(opt);
    });
    if (spkSelect.options.length > 0) {
      spkGroup.style.display = '';
      try {
        const savedSpk = localStorage.getItem(DEVICE_KEY_SPK);
        if (savedSpk && [...spkSelect.options].some(o => o.value === savedSpk)) spkSelect.value = savedSpk;
      } catch (e) {}
      spkSelect.addEventListener('change', () => {
        try { localStorage.setItem(DEVICE_KEY_SPK, spkSelect.value); } catch (e) {}
      });
    }
  }

  // Save on change
  micSelect.addEventListener('change', () => {
    try { localStorage.setItem(DEVICE_KEY_MIC, micSelect.value); } catch (e) {}
  });
  camSelect.addEventListener('change', () => {
    try { localStorage.setItem(DEVICE_KEY_CAM, camSelect.value); } catch (e) {}
  });
}

async function startPreview() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioContext) {
    audioContext.close();
    clearInterval(levelInterval);
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: micSelect.value ? { exact: micSelect.value } : undefined },
      video: {
        deviceId: camSelect.value ? { exact: camSelect.value } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    preview.srcObject = stream;
    overlay.classList.add('hidden');

    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const src = audioContext.createMediaStreamSource(stream);
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);

    levelInterval = setInterval(() => {
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      levelFill.style.width = Math.min(100, avg * 2.5) + '%';
    }, 50);

  } catch (err) {
    overlay.classList.remove('hidden');
    overlay.querySelector('span').textContent = 'Camera/mic not available';
    console.error('Preview error:', err);
  }
}

async function joinSession() {
  const name = nameInput.value.trim();
  if (!name) return;
  try { localStorage.setItem(DEVICE_KEY_NAME, name); } catch (e) {}
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioContext) audioContext.close();
  clearInterval(levelInterval);

  const isHost = typeof HOST_TOKEN !== 'undefined' && HOST_TOKEN;

  if (isHost) {
    let url = `/studio/${SESSION_ID}?participant_name=${encodeURIComponent(name)}`;
    if (micSelect.value) url += `&mic_device_id=${encodeURIComponent(micSelect.value)}`;
    if (camSelect.value) url += `&cam_device_id=${encodeURIComponent(camSelect.value)}`;
    // host_token is delivered via HttpOnly cookie — never put it in the URL
    window.location.href = url;
    return;
  }

  // Guest: request admission from host, then wait in the lobby
  const identity = `${name}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    await fetch(`/api/session/${SESSION_ID}/request-join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity, display_name: name }),
    });
  } catch (e) {
    console.warn('request-join failed:', e);
  }

  let url = `/lobby/${SESSION_ID}?identity=${encodeURIComponent(identity)}&display_name=${encodeURIComponent(name)}`;
  if (micSelect.value) url += `&mic_device_id=${encodeURIComponent(micSelect.value)}`;
  if (camSelect.value) url += `&cam_device_id=${encodeURIComponent(camSelect.value)}`;
  window.location.href = url;
}

init();
