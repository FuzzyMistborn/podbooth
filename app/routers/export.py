"""NLE/DAW project file export: OpenTimelineIO, FCPXML, Reaper RPP."""

import asyncio
import json
import math
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from app.auth import require_host
from app.config import settings
from app.models import get_session
from app.utils import _safe_name

router = APIRouter()

RATE = 48000  # audio sample rate used as shared timebase
_SKIP_RE = re.compile(r'_noaudio|_source|_chunk_')


def _xml_escape(value: str) -> str:
    return (value
            .replace("&", "&amp;")
            .replace('"', "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;"))


_FFMPEG_TIME_RE = re.compile(r'time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)')


async def _probe_duration_s(path: Path) -> float:
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        val = stdout.decode().strip()
        dur = float(val) if val else 0.0
    except Exception:
        dur = 0.0
    if dur > 0:
        return dur
    return await _probe_duration_slow(path)


async def _probe_duration_slow(path: Path) -> float:
    """Fallback for containers with no duration in the header — e.g. raw
    MediaRecorder WebM output uploaded via the participant local-upload
    endpoint, which is never server-side remuxed the way the WebRTC
    chunk-merge pipeline's output is. Decodes the whole file and reads the
    last "time=" progress line ffmpeg prints, which reflects what was
    actually decoded regardless of container metadata."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-i", str(path), "-f", "null", "-",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        matches = _FFMPEG_TIME_RE.findall(stderr.decode(errors="replace"))
        if not matches:
            return 0.0
        h, m, s = matches[-1]
        return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        return 0.0


def _read_metadata(session) -> list[dict]:
    path = Path(settings.recordings_dir) / session.dir_name / "recording_metadata.json"
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text()).get("runs", [])
    except Exception:
        return []


# "- [h:mm:ss] label" or "- [m:ss] label" — written by create_marker in sessions.py.
_MARKER_RE = re.compile(r'^-\s*\[(\d+):(\d{2})(?::(\d{2}))?\]\s*(.*)$')


def _read_markers(session) -> list[dict]:
    """Parse markers.txt (host- or guest-created chapter markers) into timeline
    markers, sorted by time. recording_time_s is elapsed time from the client
    that stamped it, treated here as an absolute offset from show start."""
    path = Path(settings.recordings_dir) / session.dir_name / "markers.txt"
    if not path.exists():
        return []
    markers = []
    try:
        for line in path.read_text().splitlines():
            m = _MARKER_RE.match(line.strip())
            if not m:
                continue
            a, b, c, label = m.groups()
            if c is not None:
                time_s = int(a) * 3600 + int(b) * 60 + int(c)
            else:
                time_s = int(a) * 60 + int(b)
            markers.append({"time_s": float(time_s), "label": label or "marker"})
    except Exception:
        return []
    markers.sort(key=lambda mk: mk["time_s"])
    return markers


def _extract_take(stem: str, ftype: str) -> int:
    """Return take number from slug-based or epoch-based filename stem."""
    try:
        base = stem
        if ftype in ("video", "screen"):
            suffix = f"_{ftype}"
            if stem.endswith(suffix):
                base = stem[: -len(suffix)]
            else:
                return 1  # epoch-based (e.g. video_abc123)
        parts = base.rsplit("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            return int(parts[1])
    except Exception:
        pass
    return 1


def _enumerate_runs(session_path: Path) -> list[dict]:
    """Fallback when no recording_metadata.json: enumerate participant dirs."""
    runs = []
    for pdir in sorted(session_path.iterdir()):
        if not pdir.is_dir():
            continue
        participant = pdir.name
        take_tracks: dict[int, dict[str, str]] = {}

        for fpath in sorted(pdir.iterdir()):
            if not fpath.is_file() or _SKIP_RE.search(fpath.name):
                continue
            stem, suffix = fpath.stem, fpath.suffix
            if suffix == ".wav":
                take = _extract_take(stem, "audio")
                take_tracks.setdefault(take, {})["audio"] = fpath.name
            elif suffix == ".mp4" and ("_video" in stem or stem == "video" or stem.startswith("video_")):
                take = _extract_take(stem, "video")
                take_tracks.setdefault(take, {})["video"] = fpath.name
            elif suffix == ".mp4" and ("_screen" in stem or stem == "screen" or stem.startswith("screen_")):
                take = _extract_take(stem, "screen")
                take_tracks.setdefault(take, {})["screen"] = fpath.name

        for take, tracks in sorted(take_tracks.items()):
            runs.append({
                "participant": participant,
                "slug": participant,
                "take": take,
                "start_ms": 0,
                "tracks": tracks,
            })
    return runs


async def _resolve_runs(session) -> list[dict]:
    """Return runs with resolved absolute Paths and probed durations."""
    base = Path(settings.recordings_dir)
    session_path = base / session.dir_name
    raw_runs = _read_metadata(session) or _enumerate_runs(session_path)

    result = []
    for run in raw_runs:
        resolved_tracks: dict[str, dict] = {}
        for track_type, filename in run.get("tracks", {}).items():
            path = session_path / run["participant"] / filename
            if path.exists():
                dur = await _probe_duration_s(path)
                if dur > 0:
                    resolved_tracks[track_type] = {
                        "path": path,
                        "filename": filename,
                        "duration_s": dur,
                    }
                    continue
            # Cloud-only tracks (e.g. the participant local-recording-upload
            # endpoint, which never writes a local copy) still carry a known
            # duration recorded at upload time — use that instead of skipping
            # the track entirely.
            known_dur = run.get("durations", {}).get(filename)
            if known_dur:
                resolved_tracks[track_type] = {
                    "path": path,
                    "filename": filename,
                    "duration_s": known_dur,
                }
        if resolved_tracks:
            result.append({
                "participant": run["participant"],
                "slug": run.get("slug", run["participant"]),
                "take": run["take"],
                "start_ms": run.get("start_ms", 0),
                "tracks": resolved_tracks,
            })
    return result


# ── OpenTimelineIO ────────────────────────────────────────────────────────────

def _rt(value: int) -> dict:
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": RATE, "value": value}


def _tr(start: int, duration: int) -> dict:
    return {"OTIO_SCHEMA": "TimeRange.1", "start_time": _rt(start), "duration": _rt(duration)}


def _build_otio_json(title: str, runs: list[dict], markers: list[dict] | None = None) -> str:
    base_ms = min((r["start_ms"] for r in runs), default=0)
    tracks = []

    for run in runs:
        offset_s = max(0.0, (run["start_ms"] - base_ms) / 1000.0)
        offset_frames = round(offset_s * RATE)

        for track_type in ("audio", "video", "screen"):
            if track_type not in run["tracks"]:
                continue
            info = run["tracks"][track_type]
            dur_frames = round(info["duration_s"] * RATE)

            label = run["participant"]
            if run["take"] > 1:
                label += f" Take {run['take']}"
            if track_type != "audio":
                label += f" ({track_type})"

            children = []
            if offset_frames > 0:
                children.append({
                    "OTIO_SCHEMA": "Gap.1",
                    "metadata": {}, "name": "", "effects": [], "markers": [], "enabled": True,
                    "source_range": _tr(0, offset_frames),
                })

            children.append({
                "OTIO_SCHEMA": "Clip.1",
                "metadata": {}, "effects": [], "markers": [], "enabled": True,
                "name": info["filename"],
                "source_range": _tr(0, dur_frames),
                "media_reference": {
                    "OTIO_SCHEMA": "ExternalReference.1",
                    "metadata": {}, "name": "", "available_image_bounds": None,
                    "target_url": f"{run['participant']}/{info['filename']}",
                    "available_range": _tr(0, dur_frames),
                },
                "active_media_reference_key": "DEFAULT_MEDIA",
            })

            tracks.append({
                "OTIO_SCHEMA": "Track.1",
                "metadata": {}, "source_range": None, "effects": [], "markers": [], "enabled": True,
                "name": label,
                "kind": "Audio" if track_type == "audio" else "Video",
                "children": children,
            })

    otio_markers = [
        {
            "OTIO_SCHEMA": "Marker.2",
            "name": mk["label"],
            "color": "RED",
            "marked_range": _tr(round(mk["time_s"] * RATE), 0),
            "metadata": {},
        }
        for mk in (markers or [])
    ]

    timeline = {
        "OTIO_SCHEMA": "Timeline.1",
        "metadata": {},
        "name": title,
        "global_start_time": None,
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "metadata": {}, "name": "tracks", "source_range": None,
            "effects": [], "markers": otio_markers, "enabled": True,
            "children": tracks,
        },
    }
    return json.dumps(timeline, indent=2)


# ── FCPXML ────────────────────────────────────────────────────────────────────

def _fcpxml_time(seconds: float) -> str:
    if seconds == 0:
        return "0s"
    frames = round(seconds * RATE)
    g = math.gcd(frames, RATE)
    return f"{frames // g}/{RATE // g}s"


def _build_fcpxml(title: str, runs: list[dict], markers: list[dict] | None = None) -> str:
    base_ms = min((r["start_ms"] for r in runs), default=0)
    total_s = max(
        (run["start_ms"] - base_ms) / 1000.0 + info["duration_s"]
        for run in runs
        for info in run["tracks"].values()
    )

    format_id = "r1"
    assets: list[dict] = []
    asset_map: dict[tuple, str] = {}
    counter = 2

    for run in runs:
        for track_type, info in run["tracks"].items():
            aid = f"r{counter}"; counter += 1
            asset_map[(run["participant"], run["take"], track_type)] = aid
            is_audio = track_type == "audio"
            assets.append({
                "id": aid,
                "name": _xml_escape(info["filename"]),
                "uid": uuid.uuid4().hex.upper(),
                "src": _xml_escape(info["path"].resolve().as_uri()),
                "duration": _fcpxml_time(info["duration_s"]),
                "hasAudio": "1" if is_audio else "0",
                "hasVideo": "0" if is_audio else "1",
                "audioSources": "1" if is_audio else "0",
                "audioChannels": "2" if is_audio else "0",
                "audioRate": "48000" if is_audio else "0",
            })

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE fcpxml>',
        '<fcpxml version="1.9">',
        '  <resources>',
        f'    <format id="{format_id}" frameDuration="100/2500s"'
        f' name="FFVideoFormat1080p25" width="1920" height="1080"/>',
    ]
    for a in assets:
        lines.append(
            f'    <asset id="{a["id"]}" name="{a["name"]}" uid="{a["uid"]}"'
            f' src="{a["src"]}" start="0s" duration="{a["duration"]}"'
            f' hasAudio="{a["hasAudio"]}" audioSources="{a["audioSources"]}"'
            f' audioChannels="{a["audioChannels"]}" audioRate="{a["audioRate"]}"'
            f' hasVideo="{a["hasVideo"]}"/>'
        )
    lines += [
        '  </resources>',
        '  <library>',
        f'    <event name="PodBooth">',
        f'      <project name="{_xml_escape(title)}">',
        f'        <sequence format="{format_id}" duration="{_fcpxml_time(total_s)}"'
        f' tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">',
        '          <spine>',
        f'            <gap name="" offset="0s" duration="{_fcpxml_time(total_s)}">',
    ]

    lane = -1
    for run in runs:
        offset_s = max(0.0, (run["start_ms"] - base_ms) / 1000.0)
        for track_type in ("audio", "video", "screen"):
            if track_type not in run["tracks"]:
                continue
            info = run["tracks"][track_type]
            aid = asset_map[(run["participant"], run["take"], track_type)]
            name = run["participant"]
            if run["take"] > 1:
                name += f" Take {run['take']}"
            if track_type != "audio":
                name += f" ({track_type})"
            tag = "audio" if track_type == "audio" else "video"
            role_attr = f' role="dialogue.{_xml_escape(run["participant"])}"' if tag == "audio" else ""
            lines.append(
                f'              <{tag} name="{_xml_escape(name)}" lane="{lane}" ref="{aid}"'
                f' offset="{_fcpxml_time(offset_s)}" duration="{_fcpxml_time(info["duration_s"])}"'
                f' start="0s"{role_attr}/>'
            )
            lane -= 1

    one_frame = _fcpxml_time(1.0 / 25)
    for mk in (markers or []):
        start_s = min(max(0.0, mk["time_s"]), total_s)
        lines.append(
            f'              <chapter-marker start="{_fcpxml_time(start_s)}"'
            f' duration="{one_frame}" value="{_xml_escape(mk["label"])}"/>'
        )

    lines += [
        '            </gap>',
        '          </spine>',
        '        </sequence>',
        '      </project>',
        '    </event>',
        '  </library>',
        '</fcpxml>',
    ]
    return "\n".join(lines)


# ── Reaper RPP ────────────────────────────────────────────────────────────────

def _rpp_guid() -> str:
    return "{" + str(uuid.uuid4()).upper() + "}"


def _build_reaper_rpp(title: str, runs: list[dict], markers: list[dict] | None = None) -> str:
    base_ms = min((r["start_ms"] for r in runs), default=0)

    lines = [
        f'<REAPER_PROJECT 0.1 "6.0" {int(time.time())}',
        f'  TEMPO 120 4 4',
        f'  SAMPLERATE 48000 0 0',
        f'  LOCK 1',
        f'  RECMODE 1',
    ]

    for i, mk in enumerate(markers or [], start=1):
        label = mk["label"].replace('"', "'")
        lines.append(f'  MARKER {i} {mk["time_s"]:.6f} "{label}" 0 0 1 B {_rpp_guid()} 0')

    iid = 1
    for run in runs:
        if "audio" not in run["tracks"]:
            continue
        info = run["tracks"]["audio"]
        offset_s = max(0.0, (run["start_ms"] - base_ms) / 1000.0)
        track_name = run["participant"]
        if run["take"] > 1:
            track_name += f" Take {run['take']}"
        rel_path = f"{run['participant']}/{info['filename']}"

        lines += [
            f'  <TRACK {_rpp_guid()}',
            f'    NAME "{track_name}"',
            f'    NCHAN 2',
            f'    VOLPAN 1 0 -1 -1 1',
            f'    MUTESOLO 0 0 0',
            f'    FX 1',
            f'    MAINSEND 1 0',
            f'    <ITEM',
            f'      POSITION {offset_s:.6f}',
            f'      SNAPOFFS 0',
            f'      LENGTH {info["duration_s"]:.6f}',
            f'      LOOP 0',
            f'      ALLTAKES 0',
            f'      FADEIN 1 0 0 1 0 0 0',
            f'      FADEOUT 1 0 0 1 0 0 0',
            f'      MUTE 0 0',
            f'      IGUID {_rpp_guid()}',
            f'      IID {iid}',
            f'      NAME "{track_name}"',
            f'      VOLPAN 1 0 1 -1',
            f'      SOFFS 0',
            f'      PLAYRATE 1 1 0 -1 0 0.0025',
            f'      CHANMODE 0',
            f'      GUID {_rpp_guid()}',
            f'      <SOURCE WAVE',
            f'        FILE "{rel_path}"',
            f'      >',
            f'    >',
            f'  >',
        ]
        iid += 1

    lines.append('>')
    return "\n".join(lines)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/session/{session_id}/export-otio")
async def export_otio(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    runs = await _resolve_runs(session)
    if not runs:
        raise HTTPException(status_code=404, detail="No recordings available")
    content = _build_otio_json(session.title, runs, _read_markers(session))
    filename = f"{_safe_name(session.title)}.otio"
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/session/{session_id}/export-fcpxml")
async def export_fcpxml(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    runs = await _resolve_runs(session)
    if not runs:
        raise HTTPException(status_code=404, detail="No recordings available")
    content = _build_fcpxml(session.title, runs, _read_markers(session))
    filename = f"{_safe_name(session.title)}.fcpxml"
    return Response(
        content=content,
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/session/{session_id}/export-reaper")
async def export_reaper(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    runs = await _resolve_runs(session)
    if not runs:
        raise HTTPException(status_code=404, detail="No recordings available")
    content = _build_reaper_rpp(session.title, runs, _read_markers(session))
    filename = f"{_safe_name(session.title)}.rpp"
    return Response(
        content=content,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
