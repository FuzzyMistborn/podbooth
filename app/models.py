from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
import asyncio
import hashlib
import json
import logging
import os
import secrets
import shutil

from app.config import settings
from app.utils import _safe_name

logger = logging.getLogger(__name__)


@dataclass
class Session:
    id: str
    title: str
    host_token: str          # secret token that grants host privileges
    created_at: datetime
    dir_name: str            # filesystem directory for this session's recordings
    recording: bool = False
    ended: bool = False
    participants: dict = field(default_factory=dict)   # display name -> joined_at iso
    pending_guests: dict = field(default_factory=dict) # identity -> {display_name, requested_at}
    admitted_guests: dict = field(default_factory=dict) # identity -> True
    denied_guests: dict = field(default_factory=dict)   # identity -> True
    description: str = ""
    episode: str = ""
    notes: str = ""
    tags: list = field(default_factory=list)
    upload_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    r2_files: list = field(default_factory=list)
    editor_token_hash: str = ""
    r2_expires_at: str = ""
    outline_doc_id: str = ""

    @property
    def guest_link_path(self) -> str:
        return f"/join/{self.id}"


_sessions: dict[str, Session] = {}
_lock = asyncio.Lock()


def _store_path() -> Path:
    return Path(settings.recordings_dir) / ".sessions.json"


def _save_sync():
    """Synchronous implementation of _save — always run via asyncio.to_thread
    (see _save below), never called directly, so it doesn't block the event
    loop for the duration of the disk write."""
    try:
        _store_path().parent.mkdir(parents=True, exist_ok=True)
        data = []
        for s in _sessions.values():
            d = asdict(s)
            d["created_at"] = s.created_at.isoformat()
            data.append(d)
        tmp = _store_path().with_suffix(".tmp")
        with open(tmp, "w") as f:
            f.write(json.dumps(data, indent=2))
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(_store_path())
    except Exception as e:
        logger.error("Session persistence failed: %s", e)


async def _save():
    """Persist sessions to disk so they survive restarts. Every call site
    holds _lock while calling this, so callers only need `await _save()`."""
    await asyncio.to_thread(_save_sync)


def load():
    """Load persisted sessions on startup."""
    path = _store_path()
    if not path.exists():
        return
    try:
        records = json.loads(path.read_text())
    except Exception as e:
        # A corrupt store previously meant every session silently vanished on
        # restart, with the same corrupt file left in place to fail the same
        # way forever after. Move it aside instead: the server still starts
        # up with no sessions (there's no way to recover data from a file
        # that doesn't parse), but the broken file survives for inspection
        # instead of being overwritten by the next _save().
        logger.error("Failed to load sessions (store may be corrupt): %s", e)
        try:
            path.replace(path.with_suffix(f".corrupt-{int(datetime.now().timestamp())}.json"))
        except OSError as rename_err:
            logger.error("Could not move aside corrupt session store %s: %s", path, rename_err)
        return

    for d in records:
        try:
            d["created_at"] = datetime.fromisoformat(d["created_at"])
            d.setdefault("pending_guests", {})
            d.setdefault("admitted_guests", {})
            d.setdefault("denied_guests", {})
            d.pop("paused", None)           # removed field; old sessions.json may still have it
            d.setdefault("upload_token", secrets.token_urlsafe(32))
            d.setdefault("r2_files", [])
            # Migrate: old sessions stored the raw token; replace with its hash
            old_token = d.pop("editor_token", "")
            if old_token and "editor_token_hash" not in d:
                d["editor_token_hash"] = hashlib.sha256(old_token.encode()).hexdigest()
            d.setdefault("editor_token_hash", "")
            d.setdefault("r2_expires_at", "")
            d.pop("participant_upload_token", None)
            d.pop("participant_token_expires_at", None)
            session = Session(**d)
            session.recording = False
            _sessions[session.id] = session
        except Exception as e:
            # One malformed record (e.g. a field from an even older schema
            # this migration doesn't know about) used to abort the whole
            # loop via the shared try/except — every session after it in the
            # file silently vanished too, not just the bad one.
            logger.error("Failed to load one session record, skipping it: %s", e)


def title_in_use(title: str) -> bool:
    """True if any active (non-ended) session has this title (case-insensitive)."""
    needle = title.casefold()
    return any(s.title.casefold() == needle and not s.ended for s in _sessions.values())


async def create_session(title: str) -> Session:
    session_id = secrets.token_urlsafe(9)   # 72 bits, URL-safe
    host_token = secrets.token_hex(32)      # 256-bit secret
    created_at = datetime.now()
    dir_name = f"{created_at.strftime('%Y-%m-%d')}-{_safe_name(title)}-{session_id[:6]}"
    session = Session(
        id=session_id,
        title=title,
        host_token=host_token,
        created_at=created_at,
        dir_name=dir_name,
    )
    async with _lock:
        _sessions[session_id] = session
        await _save()
    return session


def get_session(session_id: str) -> Optional[Session]:
    return _sessions.get(session_id)


def list_sessions() -> list[Session]:
    return sorted(_sessions.values(), key=lambda s: s.created_at, reverse=True)


async def touch(session_id: str):
    """Persist after external mutation of a session object."""
    async with _lock:
        await _save()


async def end_session(session_id: str):
    async with _lock:
        session = _sessions.get(session_id)
        if session:
            session.ended = True
            session.recording = False
            await _save()


async def delete_session(session_id: str):
    async with _lock:
        session = _sessions.pop(session_id, None)
        await _save()
    if session:
        recordings_dir = Path(settings.recordings_dir) / session.dir_name
        try:
            if recordings_dir.is_dir():
                # A multi-GB recordings directory can take a while to remove;
                # running it synchronously would block the whole event loop
                # (all other requests) for the duration.
                await asyncio.to_thread(shutil.rmtree, recordings_dir)
        except OSError as e:
            logger.error("Failed to remove session directory %s: %s", recordings_dir, e)
        # Deferred import to avoid a models<->upload circular import (same
        # pattern already used for the s3 import in purge_expired_r2 below).
        from app.routers.upload import purge_session_state
        purge_session_state(recordings_dir)


async def purge_expired() -> list[str]:
    """Delete sessions older than retention_days. Returns deleted session IDs."""
    if settings.retention_days <= 0:
        return []
    cutoff = datetime.now() - timedelta(days=settings.retention_days)
    expired = [sid for sid, s in list(_sessions.items()) if s.created_at < cutoff]
    for sid in expired:
        logger.info("Purging expired session %s", sid)
        await delete_session(sid)
    return expired


async def purge_expired_r2() -> list[str]:
    """Delete S3 objects for sessions whose r2_expires_at is in the past."""
    from datetime import timezone
    from app import s3
    from app.routers.s3upload import _cloudsync_prefixes
    loop = asyncio.get_running_loop()
    now = datetime.now(tz=timezone.utc)
    purged = []
    for session in list(_sessions.values()):
        if not session.r2_expires_at:
            continue
        try:
            expires = datetime.fromisoformat(session.r2_expires_at)
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires > now:
                continue
        except Exception:
            continue
        try:
            extra_pfx = _cloudsync_prefixes(session.title)
            n = await loop.run_in_executor(None, lambda: s3.delete_session_objects(session.id, extra_pfx))
            logger.info("purge_expired_r2: deleted %d S3 objects for session %s", n, session.id)
            session.r2_files = []
            session.editor_token_hash = ""
            session.r2_expires_at = ""
            purged.append(session.id)
        except Exception as e:
            logger.error("purge_expired_r2: error for session %s: %s", session.id, e)
    if purged:
        async with _lock:
            await _save()
    return purged
