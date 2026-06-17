from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
import json
import logging
import secrets
import shutil
import threading

from app.config import settings

logger = logging.getLogger(__name__)


def _safe_name(value: str) -> str:
    return "".join(c if c.isalnum() or c in "- " else "_" for c in value).strip()


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

    @property
    def guest_link_path(self) -> str:
        return f"/join/{self.id}"


_sessions: dict[str, Session] = {}
_lock = threading.Lock()


def _store_path() -> Path:
    return Path(settings.recordings_dir) / ".sessions.json"


def _save():
    """Persist sessions to disk so they survive restarts."""
    try:
        _store_path().parent.mkdir(parents=True, exist_ok=True)
        data = []
        for s in _sessions.values():
            d = asdict(s)
            d["created_at"] = s.created_at.isoformat()
            data.append(d)
        tmp = _store_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(_store_path())
    except Exception as e:
        logger.error("Session persistence failed: %s", e)


def load():
    """Load persisted sessions on startup."""
    path = _store_path()
    if not path.exists():
        return
    try:
        for d in json.loads(path.read_text()):
            d["created_at"] = datetime.fromisoformat(d["created_at"])
            d.setdefault("pending_guests", {})
            d.setdefault("admitted_guests", {})
            d.setdefault("denied_guests", {})
            d.pop("paused", None)  # removed field; old sessions.json may still have it
            session = Session(**d)
            session.recording = False
            _sessions[session.id] = session
    except Exception as e:
        logger.error("Failed to load sessions: %s", e)


def title_in_use(title: str) -> bool:
    """True if any active (non-ended) session has this title (case-insensitive)."""
    needle = title.casefold()
    return any(s.title.casefold() == needle and not s.ended for s in _sessions.values())


def create_session(title: str) -> Session:
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
    with _lock:
        _sessions[session_id] = session
        _save()
    return session


def get_session(session_id: str) -> Optional[Session]:
    return _sessions.get(session_id)


def list_sessions() -> list[Session]:
    return sorted(_sessions.values(), key=lambda s: s.created_at, reverse=True)


def touch(session_id: str):
    """Persist after external mutation of a session object."""
    with _lock:
        _save()


def end_session(session_id: str):
    with _lock:
        session = _sessions.get(session_id)
        if session:
            session.ended = True
            session.recording = False
            _save()


def delete_session(session_id: str):
    with _lock:
        session = _sessions.pop(session_id, None)
        _save()
    if session:
        recordings_dir = Path(settings.recordings_dir) / session.dir_name
        if recordings_dir.is_dir():
            try:
                shutil.rmtree(recordings_dir)
            except Exception as e:
                logger.error("Failed to remove session directory %s: %s", recordings_dir, e)


def purge_expired() -> list[str]:
    """Delete sessions older than retention_days. Returns deleted session IDs."""
    if settings.retention_days <= 0:
        return []
    cutoff = datetime.now() - timedelta(days=settings.retention_days)
    expired = [sid for sid, s in list(_sessions.items()) if s.created_at < cutoff]
    for sid in expired:
        logger.info("Purging expired session %s", sid)
        delete_session(sid)
    return expired
