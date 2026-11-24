"""Grid export filter graph: each speaker's padded audio feeds both the mixed
track and its own per-speaker output track. ffmpeg lets a filter label be
consumed only once, so reusing [aN] for both failed with "Output with label
'a0' does not exist in any defined filter graph, or was already used
elsewhere" (seen on a session where the host rejoined and had two takes).
Runs the real ffmpeg on tiny clips of different lengths."""
import shutil
import subprocess

import pytest

from app.routers import dashboard

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _clip(path, seconds):
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=size=320x180:rate=15:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=duration={seconds}", "-c:v", "libx264", "-c:a", "aac",
         "-shortest", str(path)],
        check=True, capture_output=True,
    )


def _probe(path, entries, stream=None):
    cmd = ["ffprobe", "-v", "error"]
    if stream:
        cmd += ["-select_streams", stream]
    cmd += ["-show_entries", entries, "-of", "csv=p=0", str(path)]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.split()


@pytest.mark.parametrize("n", [2, 3])
def test_grid_export_runs_and_pads_to_longest(tmp_path, n):
    lengths = [3, 1, 2][:n]
    clips = []
    for i, sec in enumerate(lengths):
        d = tmp_path / f"p{i}"
        d.mkdir()
        c = d / f"p{i}_1_video.mp4"
        _clip(c, sec)
        clips.append(c)
    out = tmp_path / "grid.mp4"
    cmd = dashboard._build_export_cmd(clips, out, durations=[float(s) for s in lengths])
    r = subprocess.run(cmd, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-2000:]
    # mixed + one audio track per speaker
    assert len(_probe(out, "stream=index", "a")) == n + 1
    assert float(_probe(out, "format=duration")[0]) >= max(lengths) - 0.3
    # every tile is constant-frame-rate so VFR browser recordings can't drift
    assert _probe(out, "stream=r_frame_rate", "v") == ["30/1"]
