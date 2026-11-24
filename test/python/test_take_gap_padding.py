"""A participant who drops and rejoins has several takes. Stream-copy concat
used to butt them together, deleting the time they were away, so every later
take played early relative to everyone else in the grid. The gap is now filled
with black/silence. Also covers the start_ms those gaps are computed from:
recording_metadata start_ms was decoded from the whole epoch string, random
suffix included (ms * 36**4 + random), and is repaired on read."""
import asyncio
import json
import shutil
import subprocess

import pytest

from app.routers import dashboard
from app.utils import epoch_to_ms, normalize_start_ms


def _b36(n):
    d = "0123456789abcdefghijklmnopqrstuvwxyz"
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = d[r] + s
    return s


MS = 1_790_000_000_000


def test_epoch_to_ms_ignores_random_suffix():
    assert epoch_to_ms(_b36(MS) + "k3x9") == MS
    assert epoch_to_ms(_b36(MS)) == MS
    assert epoch_to_ms("mrv3jq9-s1") is None


def test_normalize_start_ms_repairs_legacy_value_only():
    legacy = int(_b36(MS) + "k3x9", 36)
    assert normalize_start_ms(legacy) == MS
    assert normalize_start_ms(MS) == MS
    assert normalize_start_ms(0) == 0


def _write_takes(tmp_path, starts_ms, legacy=False):
    d = tmp_path / "sess" / "Host"
    d.mkdir(parents=True)
    files, runs = [], []
    for i, st in enumerate(starts_ms, 1):
        f = d / f"Host_{i}_video.mp4"
        files.append(f)
        val = int(_b36(st) + "abcd", 36) if legacy else st
        runs.append({"participant": "Host", "slug": "Host", "take": i,
                     "start_ms": val, "tracks": {"video": f.name}})
    (tmp_path / "sess" / "recording_metadata.json").write_text(json.dumps({"runs": runs}))
    return files


@pytest.mark.parametrize("legacy", [False, True])
def test_take_gaps_from_metadata(tmp_path, monkeypatch, legacy):
    files = _write_takes(tmp_path, [MS, MS + 70_000, MS + 75_000], legacy=legacy)

    async def fake_dur(p):
        return 60.0 if p == files[0] else 5.0

    monkeypatch.setattr(dashboard, "_probe_duration", fake_dur)
    gaps = asyncio.run(dashboard._take_gaps(files))
    assert gaps == pytest.approx([10.0, 0.0])  # 70-60 away; second rejoin was instant


def test_take_gaps_unknown_start_is_no_gap(tmp_path):
    files = _write_takes(tmp_path, [MS, MS + 70_000])
    (tmp_path / "sess" / "recording_metadata.json").unlink()
    assert asyncio.run(dashboard._take_gaps(files)) == [0.0]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_concat_inserts_black_silence_gap(tmp_path):
    def clip(name, sec):
        p = tmp_path / name
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=size=320x180:rate=15:duration={sec}",
             "-f", "lavfi", "-i", f"sine=duration={sec}:sample_rate=48000", "-pix_fmt", "yuv420p",
             "-c:v", "libx264", "-c:a", "aac", "-shortest", str(p)],
            check=True, capture_output=True)
        return p

    a, b = clip("a.mp4", 2), clip("b.mp4", 2)
    out = asyncio.run(dashboard._concat_takes([a, b], [3.0]))
    try:
        def dur(sel):
            r = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", sel, "-show_entries",
                 "stream=duration", "-of", "csv=p=0", str(out)],
                check=True, capture_output=True, text=True)
            return float(r.stdout.split()[0])
        assert dur("v") == pytest.approx(7.0, abs=0.4)
        assert dur("a") == pytest.approx(7.0, abs=0.4)
    finally:
        out.unlink(missing_ok=True)
    # no gap -> plain concat, nothing inserted
    out2 = asyncio.run(dashboard._concat_takes([a, b], [0.0]))
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", str(out2)], capture_output=True, text=True)
        assert float(r.stdout) == pytest.approx(4.0, abs=0.4)
    finally:
        out2.unlink(missing_ok=True)
