let wasAdmitted = false;

async function checkAdmission() {
  try {
    const r = await fetch(`/api/session/${SESSION_ID}/admission/${encodeURIComponent(IDENTITY)}`);
    if (!r.ok) return;
    const data = await r.json();

    if (data.ended) {
      document.getElementById('lobby-status').textContent = 'This session has ended.';
      return;
    }

    if (data.admitted && !wasAdmitted) {
      wasAdmitted = true;
      document.getElementById('lobby-status').textContent = 'Joining session…';
      let url = `/studio/${SESSION_ID}?participant_name=${encodeURIComponent(DISPLAY_NAME)}`;
      if (MIC_DEVICE_ID) url += `&mic_device_id=${encodeURIComponent(MIC_DEVICE_ID)}`;
      if (CAM_DEVICE_ID) url += `&cam_device_id=${encodeURIComponent(CAM_DEVICE_ID)}`;
      window.location.href = url;
      return;
    }
  } catch (e) {
    console.warn('Admission poll error:', e);
  }

  setTimeout(checkAdmission, 2000);
}

checkAdmission();
