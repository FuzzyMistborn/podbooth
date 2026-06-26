"""
Outline wiki integration.

Pulls show notes from an Outline document into a session's notes field.
Only the content between the marker tags:

    <!- podbooth -!>
    ...
    <!- /podbooth -!>

is imported.  Anything outside those tags (pre-show planning, post-production
notes, etc.) is intentionally excluded.

Required env vars:
    OUTLINE_API_URL   - Base URL of your Outline instance, e.g. https://wiki.example.com
    OUTLINE_API_KEY   - Outline API token (read-only scope is sufficient)

Optional field added to Session:
    outline_doc_id    - Stored after a successful link so "Refresh" works without
                        re-entering the document ID.
"""

import logging
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from app.auth import require_host
from app.config import settings
from app.models import get_session, touch

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Outline document content extraction
# ---------------------------------------------------------------------------

_TAG_OPEN = "<!- podbooth -!>"
_TAG_CLOSE = "<!- /podbooth -!>"


def _extract_show_notes(text: str) -> str:
    """
    Extract the content between ``<!- podbooth -!>`` and ``<!- /podbooth -!>``
    tags (exclusive of the tag lines themselves).

    Returns the extracted markdown, or raises ValueError if the tags are not
    found or the enclosed content is empty.
    """
    start = text.find(_TAG_OPEN)
    if start == -1:
        raise ValueError(
            f"Could not find opening tag '{_TAG_OPEN}' in document."
        )

    content_start = start + len(_TAG_OPEN)
    end = text.find(_TAG_CLOSE, content_start)
    if end == -1:
        raise ValueError(
            f"Could not find closing tag '{_TAG_CLOSE}' in document."
        )

    extracted = text[content_start:end].strip()

    if not extracted:
        raise ValueError("Extracted content between podbooth tags is empty.")

    return extracted


# ---------------------------------------------------------------------------
# Timer topic extraction
# ---------------------------------------------------------------------------

# Duration pattern: "(10 min)", "(10 mins)", "(10 minutes)", "(1.5 min)" anywhere in heading
_DURATION_IN_HEADING = re.compile(
    r"\(\s*(\d+(?:\.\d+)?)\s*min(?:utes?|s?)?\s*\)",
    re.IGNORECASE,
)

# H2 heading
_H2_RE = re.compile(r"^##\s+(.+)$")

# H3 heading
_H3_RE = re.compile(r"^###\s+(.+)$")

# Links section H3
_LINKS_H3_RE = re.compile(r"^###\s+Links\s*:?\s*$", re.IGNORECASE)

# A line that is a bare URL or a bullet containing only a URL
_URL_LINE_RE = re.compile(r"^\s*[*\-]?\s*<?https?://\S+>?\s*$")


def _parse_timer_topics(notes_text: str) -> list[dict]:
    """
    Parse extracted show-notes markdown into a list of timer topic dicts.

    Each dict has:
        name      - topic heading with duration stripped
        duration  - integer seconds (0 if no duration found in heading)
        notes     - body text with the ### Links section removed

    Only H2 headings are treated as topic boundaries. ### Links sub-sections
    and bare URL lines are excluded from the notes body.
    """
    lines = notes_text.splitlines()
    topics: list[dict] = []

    current_name: str | None = None
    current_duration: int = 0
    current_lines: list[str] = []
    in_links: bool = False

    def _flush() -> None:
        if current_name is None:
            return
        body = "\n".join(current_lines).strip()
        topics.append({"name": current_name, "duration": current_duration, "notes": body})

    for line in lines:
        s = line.rstrip()

        m2 = _H2_RE.match(s)
        if m2:
            _flush()
            heading = m2.group(1).strip()
            dm = _DURATION_IN_HEADING.search(heading)
            current_duration = int(float(dm.group(1)) * 60) if dm else 0
            # Strip duration token and trailing separators from name
            current_name = _DURATION_IN_HEADING.sub("", heading).rstrip(" \t-–—").strip()
            current_lines = []
            in_links = False
            continue

        if current_name is None:
            continue

        if _LINKS_H3_RE.match(s):
            in_links = True
            continue

        if _H3_RE.match(s):
            in_links = False
            current_lines.append(s)
            continue

        if in_links or _URL_LINE_RE.match(s):
            continue

        current_lines.append(s)

    _flush()
    return topics


# ---------------------------------------------------------------------------
# Outline API client helpers
# ---------------------------------------------------------------------------

def _outline_enabled() -> bool:
    return bool(settings.outline_api_url and settings.outline_api_key)


def _parse_doc_id(value: str) -> str:
    """
    Accept either a bare document ID or a full Outline document URL and
    return just the ID portion.

    Outline URLs look like:
      https://wiki.example.com/doc/episode-8-AbCdEfGhIj
      https://app.getoutline.com/doc/some-title-AbCdEfGhIj

    The document ID is the last path segment.
    """
    value = value.strip().rstrip("/")
    if "/" in value:
        value = value.split("/")[-1]
    return value


async def _fetch_outline_document(doc_id: str) -> dict:
    """
    Call the Outline documents.info endpoint and return the parsed JSON.
    Raises HTTPException on auth/network/format errors.
    """
    base = settings.outline_api_url.rstrip("/")
    url = f"{base}/api/documents.info"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {settings.outline_api_key}",
                    "Content-Type": "application/json",
                },
                json={"id": doc_id},
            )
    except httpx.RequestError as exc:
        logger.error("Outline API request failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Could not reach Outline: {exc}")

    if not resp.is_success:
        # Try to extract Outline's own error message for better diagnostics
        outline_msg = ""
        try:
            body = resp.json()
            outline_msg = body.get("error") or body.get("message") or ""
        except Exception:
            outline_msg = resp.text[:200]
        logger.error(
            "Outline API returned HTTP %s for doc %s: %s",
            resp.status_code, doc_id, outline_msg or "(no body)",
        )
        if resp.status_code == 401:
            raise HTTPException(status_code=502, detail="Outline API key is invalid or expired.")
        if resp.status_code == 404:
            raise HTTPException(
                status_code=404,
                detail="Outline document not found. Check the document ID or URL.",
            )
        detail = f"Outline returned HTTP {resp.status_code}"
        if outline_msg:
            detail += f": {outline_msg}"
        raise HTTPException(status_code=502, detail=detail)

    try:
        return resp.json()
    except Exception:
        raise HTTPException(
            status_code=502,
            detail="Outline returned an unexpected response format.",
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/api/session/{session_id}/outline/import")
async def import_outline_notes(
    session_id: str,
    request_data: dict,
    _: None = Depends(require_host),
):
    """
    Fetch an Outline document and import the show notes section into this
    session's notes field.

    Request body:
        host_token  - host authentication token
        doc_id      - Outline document ID or full document URL
    """
    if not _outline_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "Outline integration is not configured. "
                "Set OUTLINE_API_URL and OUTLINE_API_KEY."
            ),
        )

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    doc_id_raw = str(request_data.get("doc_id", "")).strip()
    if not doc_id_raw:
        raise HTTPException(status_code=400, detail="doc_id is required.")

    doc_id = _parse_doc_id(doc_id_raw)
    if not doc_id:
        raise HTTPException(
            status_code=400,
            detail="Could not parse a document ID from the provided value.",
        )

    payload = await _fetch_outline_document(doc_id)

    try:
        doc = payload["data"]
        text: str = doc.get("text", "")
        title: str = doc.get("title", "")
    except (KeyError, TypeError):
        raise HTTPException(
            status_code=502,
            detail="Unexpected Outline API response structure.",
        )

    if not text:
        raise HTTPException(
            status_code=422,
            detail="Outline document has no text content.",
        )

    try:
        notes = _extract_show_notes(text)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    session.notes = notes[:10_000]
    session.outline_doc_id = doc_id
    if title and not session.description:
        session.description = title[:500]

    await touch(session_id)

    topics = _parse_timer_topics(notes)

    logger.info(
        "Imported %d chars of show notes (%d topics) from Outline doc %s into session %s",
        len(notes),
        len(topics),
        doc_id,
        session_id,
    )

    return JSONResponse({
        "ok": True,
        "outline_doc_id": doc_id,
        "outline_title": title,
        "notes_length": len(notes),
        "notes_preview": notes[:300],
        "topics": topics,
    })


@router.post("/api/session/{session_id}/outline/refresh")
async def refresh_outline_notes(
    session_id: str,
    request_data: dict,
    _: None = Depends(require_host),
):
    """
    Re-fetch and re-import from the previously linked Outline document.
    Requires that /outline/import was called at least once.

    Request body:
        host_token  - host authentication token
    """
    if not _outline_enabled():
        raise HTTPException(
            status_code=503,
            detail="Outline integration is not configured.",
        )

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    doc_id = getattr(session, "outline_doc_id", "")
    if not doc_id:
        raise HTTPException(
            status_code=400,
            detail=(
                "No Outline document is linked to this session. "
                "Use /outline/import first."
            ),
        )

    payload = await _fetch_outline_document(doc_id)

    try:
        text: str = payload["data"].get("text", "")
    except (KeyError, TypeError):
        raise HTTPException(
            status_code=502,
            detail="Unexpected Outline API response structure.",
        )

    try:
        notes = _extract_show_notes(text)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    session.notes = notes[:10_000]
    await touch(session_id)

    topics = _parse_timer_topics(notes)

    return JSONResponse({
        "ok": True,
        "outline_doc_id": doc_id,
        "notes_length": len(notes),
        "notes_preview": notes[:300],
        "topics": topics,
    })


@router.get("/api/session/{session_id}/outline/status")
async def outline_status(session_id: str, _: None = Depends(require_host)):
    """Return whether an Outline doc is linked to this session."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    doc_id = getattr(session, "outline_doc_id", "")
    return JSONResponse({
        "enabled": _outline_enabled(),
        "linked": bool(doc_id),
        "outline_doc_id": doc_id or None,
    })


@router.get("/api/session/{session_id}/notes")
async def get_session_notes(session_id: str, _: None = Depends(require_host)):
    """Return the full notes field for a session. Used by the studio UI after an Outline sync."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    return JSONResponse({"notes": session.notes or ""})
