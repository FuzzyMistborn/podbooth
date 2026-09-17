"""One-off backfill: register recording_metadata.json entries for recordings
that were already uploaded through the participant local-upload endpoint
before it started doing this itself (see app/routers/localupload.py's
_register_local_upload_run).

Without this, editor-link/export generation (_resolve_runs in
app/routers/export.py) can't find those recordings — the whole-file upload
never wrote a local copy or a recording_metadata.json entry, only the R2
object and session.r2_files. This script downloads each such file back from
the currently-active object storage backend, probes its duration, and
registers it, so editor links can be (re)generated without anyone
re-uploading.

Only touches r2_files entries whose key contains "/local/" (the segment
localupload.py always writes) — zip/grid-export uploads use different key
prefixes and are left alone.

Usage:
    .venv/bin/python scripts/backfill_local_upload_metadata.py [--dry-run] [--session ID]
"""
import argparse
import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import models, s3
from app.routers.localupload import _probe_duration_s, _register_local_upload_run

_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}


async def _backfill_one(session, entry: dict, dry_run: bool) -> str:
    key = entry["key"]
    filename = entry["filename"]
    participant = entry.get("uploader") or "guest"
    track_type = "video" if Path(filename).suffix.lower() in _VIDEO_EXTS else "audio"

    if dry_run:
        return f"[dry-run] would backfill {session.id}/{participant}/{filename} (key={key})"

    with tempfile.TemporaryDirectory() as tmp:
        local_path = Path(tmp) / filename
        try:
            s3.get_client().download_file(s3._bucket(), key, str(local_path))
        except Exception as e:
            return f"[skip] {session.id}/{filename}: download failed ({e})"

        duration_s = await _probe_duration_s(local_path)
        if duration_s <= 0:
            return f"[skip] {session.id}/{filename}: ffprobe reported no duration"

        await _register_local_upload_run(session, participant, track_type, filename, duration_s)
        return f"[ok] {session.id}/{participant}/{filename}: registered duration={duration_s:.1f}s"


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="List what would be backfilled without doing it")
    parser.add_argument("--session", help="Only backfill this session ID")
    args = parser.parse_args()

    models.load()
    sessions = models.list_sessions()
    if args.session:
        sessions = [s for s in sessions if s.id == args.session]
        if not sessions:
            print(f"No session found with id {args.session}")
            return

    total = 0
    for session in sessions:
        local_entries = [f for f in session.r2_files if "/local/" in f.get("key", "")]
        for entry in local_entries:
            total += 1
            print(await _backfill_one(session, entry, args.dry_run))

    if total == 0:
        print("No local-upload r2_files entries found across any session.")


if __name__ == "__main__":
    asyncio.run(main())
