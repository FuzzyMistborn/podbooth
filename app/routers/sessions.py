from datetime import datetime, timedelta
import asyncio
import json
import logging
import secrets
from pathlib import Path

logger = logging.getLogger(__name__)

from urllib.parse import quote

from fastapi import APIRouter, Depends, Request, Form, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from livekit.api import AccessToken, VideoGrants

from app.models import create_session, get_session, end_session, delete_session, touch, title_in_use, list_sessions
from app.routers.upload import recover_orphaned_chunks
from app.config import settings, ASSET_VERSION, APP_VERSION
from app.auth import CSRF_COOKIE, make_csrf_token, require_csrf, require_host
from app.limiter import limiter
from app.routers.cloudsync import cloud_upload_enabled, delete_cloud_session, _session_slug

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
templates.env.globals["asset_v"] = ASSET_VERSION
templates.env.globals["app_version"] = APP_VERSION


def _is_host(host_token, session) -> bool:
    if not isinstance(host_token, str):
        return False
    return secrets.compare_digest(host_token, session.host_token)


def _get_or_create_csrf(request: Request) -> tuple[str, bool]:
    existing = request.cookies.get(CSRF_COOKIE)
    if existing:
        return existing, False
    return make_csrf_token(), True


def _set_csrf_cookie(response, token: str) -> None:
    response.set_cookie(
        CSRF_COOKIE, token,
        httponly=True, samesite="strict",
        secure=settings.base_url.startswith("https"),
        max_age=3600,
    )


@router.get("/", response_class=HTMLResponse)
async def index(request: Request, _: None = Depends(require_host)):
    error = request.query_params.get("error")
    title = request.query_params.get("title", "")
    csrf, is_new = _get_or_create_csrf(request)
    resp = templates.TemplateResponse(request, "index.html", {
        "error": error,
        "prefill_title": title,
        "csrf_token": csrf,
    })
    if is_new:
        _set_csrf_cookie(resp, csrf)
    return resp


def _set_host_cookie(response, session_id: str, host_token: str, max_age: int = 14400) -> None:
    """Attach an HttpOnly cookie carrying the host token."""
    response.set_cookie(
        f"ht_{session_id}",
        host_token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=settings.base_url.startswith("https"),
    )


@router.post("/session/new")
async def new_session(
    title: str = Form(...),
    join_now: str = Form("true"),
    _: None = Depends(require_host),
    _csrf: None = Depends(require_csrf),
):
    if title_in_use(title):
        return RedirectResponse(
            url=f"/?error=duplicate&title={quote(title, safe='')}",
            status_code=303,
        )
    session = await create_session(title)
    if join_now == "false":
        resp = RedirectResponse(url="/dashboard", status_code=303)
    else:
        resp = RedirectResponse(url=f"/join/{session.id}", status_code=303)
    _set_host_cookie(resp, session.id, session.host_token)
    return resp


@router.get("/join/{session_id}", response_class=HTMLResponse)
async def join_page(request: Request, session_id: str, host_token: str = ""):
    session = get_session(session_id)
    if not session or session.ended:
        return templates.TemplateResponse(
            request, "error.html",
            {"message": "This session has ended or does not exist."},
            status_code=404,
        )
    # Prefer the HttpOnly cookie (no URL exposure) over the query param
    if not host_token:
        host_token = request.cookies.get(f"ht_{session_id}", "")
    is_host = _is_host(host_token, session)
    resp = templates.TemplateResponse(
        request, "prejoin.html",
        {
            "session": session,
            "host_token": host_token if is_host else "",
        },
    )
    if is_host:
        _set_host_cookie(resp, session_id, host_token)
    return resp


@router.get("/studio/{session_id}", response_class=HTMLResponse)
async def studio(request: Request, session_id: str, host_token: str = ""):
    session = get_session(session_id)
    if not session:
        return templates.TemplateResponse(
            request, "error.html",
            {"message": "Session not found."},
            status_code=404,
        )
    # Prefer the HttpOnly cookie (no URL exposure) over the query param
    cookie_token = request.cookies.get(f"ht_{session_id}", "")
    if not host_token:
        host_token = cookie_token
    is_host = _is_host(host_token, session)
    resp = templates.TemplateResponse(
        request, "studio.html",
        {
            "session": session,
            "is_host": is_host,
            "host_token": host_token if is_host else "",
            "livekit_url": settings.livekit_public_url,
            "base_url": settings.base_url,
            "cloud_upload_enabled": cloud_upload_enabled(),
            "outline_enabled": bool(settings.outline_api_url and settings.outline_api_key),
            "outline_doc_id": session.outline_doc_id,
            "upload_token": session.upload_token,
        },
    )
    if is_host:
        _set_host_cookie(resp, session_id, host_token)
    elif cookie_token:
        resp.delete_cookie(f"ht_{session_id}")
    return resp


@router.get("/obs/{session_id}", response_class=HTMLResponse)
async def obs_view(request: Request, session_id: str, host_token: str = ""):
    session = get_session(session_id)
    if not session or session.ended:
        return templates.TemplateResponse(
            request, "error.html",
            {"message": "Session not found or ended."},
            status_code=404,
        )
    if not host_token:
        host_token = request.cookies.get(f"ht_{session_id}", "")
    if not _is_host(host_token, session):
        return templates.TemplateResponse(
            request, "error.html",
            {"message": "Access denied."},
            status_code=403,
        )
    return templates.TemplateResponse(
        request, "obs.html",
        {
            "session": session,
            "host_token": host_token,
            "livekit_url": settings.livekit_public_url,
            "base_url": settings.base_url,
        },
    )


@router.get("/api/session/{session_id}/obs-token")
@limiter.limit("20/minute")
async def obs_token(request: Request, session_id: str, host_token: str = ""):
    session = get_session(session_id)
    if not session or session.ended:
        raise HTTPException(status_code=404, detail="Session not found or ended")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Access denied")

    import uuid
    identity = f"obs-{uuid.uuid4().hex[:8]}"
    grants = VideoGrants(
        room_join=True,
        room=session_id,
        can_publish=False,
        can_subscribe=True,
        can_publish_data=False,
    )
    token = (
        AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name("OBS View")
        .with_grants(grants)
        .with_ttl(timedelta(hours=12))
        .to_jwt()
    )
    return JSONResponse({"token": token})


@router.post("/api/token")
@limiter.limit("30/minute")
async def get_token(request: Request):
    data = await request.json()
    session_id = data.get("session_id")
    identity = data.get("identity")            # unique per connection
    display_name = data.get("display_name")    # what humans see / file naming
    host_token = data.get("host_token", "")

    if not session_id or not identity or not display_name:
        raise HTTPException(status_code=400, detail="Missing session_id, identity, or display_name")
    if not isinstance(display_name, str) or len(display_name) > 100:
        raise HTTPException(status_code=400, detail="display_name must be ≤100 characters")

    session = get_session(session_id)
    if not session or session.ended:
        raise HTTPException(status_code=404, detail="Session not found or ended")

    is_host = _is_host(host_token, session)
    if not is_host and len(session.participants) >= 50 and display_name not in session.participants:
        raise HTTPException(status_code=429, detail="Session is full")

    grants = VideoGrants(
        room_join=True,
        room=session_id,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
        room_admin=is_host,
    )

    token = (
        AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(display_name)
        .with_metadata(json.dumps({"is_host": is_host}))
        .with_grants(grants)
        .with_ttl(timedelta(hours=4))
        .to_jwt()
    )

    session.participants[display_name] = datetime.now().isoformat()
    await touch(session_id)

    return JSONResponse({"token": token, "is_host": is_host})


@router.post("/api/session/{session_id}/recording")
async def set_recording(session_id: str, request: Request):
    data = await request.json()
    host_token = data.get("host_token", "")
    action = data.get("action")  # "start" or "stop"

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Not authorized")

    if action == "start":
        session.recording = True
    elif action == "stop":
        session.recording = False
    else:
        raise HTTPException(status_code=400, detail="action must be 'start' or 'stop'")

    await touch(session_id)
    return JSONResponse({"recording": session.recording})


@router.post("/api/session/{session_id}/end")
async def end_session_route(session_id: str, request: Request):
    data = await request.json()
    host_token = data.get("host_token", "")

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Not authorized")

    await end_session(session_id)
    from app.routers.transcribe import schedule_session_transcription
    schedule_session_transcription(session_id)
    return JSONResponse({"ended": True})


@router.post("/api/session/{session_id}/delete")
async def delete_session_route(session_id: str, request: Request):
    data = await request.json()
    host_token = data.get("host_token", "")

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Not authorized")

    slug = _session_slug(session.title)

    # Clean up S3/R2/B2 objects before removing the session record
    if session.editor_token_hash or session.r2_files:
        try:
            from app import s3
            from app.routers.s3upload import _cloudsync_prefixes
            extra_pfx = _cloudsync_prefixes(session.title)
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, lambda: s3.delete_session_objects(session_id, extra_pfx))
        except Exception as e:
            logger.warning("delete_session_route: S3 cleanup failed for %s: %s", session_id, e)

    await delete_session(session_id)

    if data.get("delete_cloud"):
        errors = await delete_cloud_session(slug)
        if errors:
            return JSONResponse({"deleted": True, "cloud_errors": errors})

    return JSONResponse({"deleted": True})


def _parse_take(stem: str, ftype: str) -> int | None:
    """Extract take number from a slug filename, e.g. Alice_1 → 1, Alice_1_video → 1."""
    try:
        base = stem
        if ftype in ("video", "screen"):
            suffix = f"_{ftype}"
            if stem.endswith(suffix):
                base = stem[: -len(suffix)]
            else:
                return None
        parts = base.rsplit("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            return int(parts[1])
    except Exception:
        pass
    return None


@router.get("/api/session/{session_id}/recordings")
async def get_recordings(session_id: str):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    # Trigger orphan recovery so a client crash doesn't require a server
    # restart before the host can see assembled files. Fast scan; assembly
    # runs in background tasks and won't block this response.
    asyncio.ensure_future(recover_orphaned_chunks(session))
    recordings_path = Path(settings.recordings_dir)
    session_path = recordings_path / session.dir_name
    files = []
    if session_path.is_dir():
        # Topic marker files live in the session root
        for fpath in sorted(session_path.glob("*.txt")):
            if fpath.is_file():
                files.append({
                    "participant": "",
                    "type": "marker",
                    "take": None,
                    "filename": fpath.name,
                    "path": str(fpath.relative_to(recordings_path)),
                    "size_mb": None,
                })

        for pdir in sorted(session_path.iterdir()):
            if not pdir.is_dir():
                continue
            for pattern, ftype in [
                ("*.wav", "audio"),
                ("*_video.mp4", "video"),
                ("*_screen.mp4", "screen"),
                # Legacy epoch-based names (orphan recovery / old recordings)
                ("audio*.wav", "audio"),
                ("video*.mp4", "video"),
                ("screen*.mp4", "screen"),
            ]:
                for fpath in sorted(pdir.glob(pattern)):
                    if "_noaudio" in fpath.name or "_source" in fpath.name:
                        continue
                    entry = {
                        "participant": pdir.name,
                        "type": ftype,
                        "take": _parse_take(fpath.stem, ftype),
                        "filename": fpath.name,
                        "path": str(fpath.relative_to(recordings_path)),
                        "size_mb": round(fpath.stat().st_size / (1024 * 1024), 1),
                    }
                    if entry not in files:
                        files.append(entry)
    return JSONResponse({"files": files})


@router.get("/api/session/{session_id}/status")
async def session_status(session_id: str):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse({
        "recording": session.recording,
        "ended": session.ended,
        "participants": list(session.participants.keys()),
    })


# ── Green room / host admit ──────────────────────────────────────────────────

@router.get("/join-denied", response_class=HTMLResponse)
async def join_denied(request: Request):
    return templates.TemplateResponse(
        request, "error.html",
        {"message": "Your request to join was not approved by the host.", "show_home_link": False},
    )

@router.get("/lobby/{session_id}", response_class=HTMLResponse)
async def lobby_page(
    request: Request,
    session_id: str,
    identity: str = "",
    display_name: str = "",
    mic_device_id: str = "",
    cam_device_id: str = "",
):
    session = get_session(session_id)
    if not session or session.ended:
        return templates.TemplateResponse(
            request, "error.html",
            {"message": "This session has ended or does not exist."},
            status_code=404,
        )
    return templates.TemplateResponse(
        request, "lobby.html",
        {
            "session": session,
            "identity": identity,
            "display_name": display_name,
            "mic_device_id": mic_device_id,
            "cam_device_id": cam_device_id,
        },
    )


@router.post("/api/session/{session_id}/request-join")
@limiter.limit("10/minute")
async def request_join(session_id: str, request: Request):
    data = await request.json()
    identity = data.get("identity")
    display_name = data.get("display_name")
    if not identity or not display_name:
        raise HTTPException(status_code=400, detail="Missing identity or display_name")
    session = get_session(session_id)
    if not session or session.ended:
        raise HTTPException(status_code=404, detail="Session not found or ended")
    session.pending_guests[identity] = {
        "display_name": display_name,
        "requested_at": datetime.now().isoformat(),
    }
    await touch(session_id)
    return JSONResponse({"ok": True})


@router.get("/api/session/{session_id}/admission/{identity}")
async def check_admission(session_id: str, identity: str):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse({
        "admitted": identity in session.admitted_guests,
        "denied": identity in session.denied_guests,
        "ended": session.ended,
    })


@router.get("/api/session/{session_id}/pending-guests")
async def pending_guests_list(session_id: str, host_token: str = ""):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Not authorized")
    guests = [
        {"identity": ident, "display_name": info["display_name"]}
        for ident, info in session.pending_guests.items()
        if ident not in session.admitted_guests and ident not in session.denied_guests
    ]
    return JSONResponse({"guests": guests})


@router.post("/api/session/{session_id}/admit/{identity}")
async def admit_guest(session_id: str, identity: str, request: Request):
    data = await request.json()
    host_token = data.get("host_token", "")
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Not authorized")
    session.admitted_guests[identity] = True
    await touch(session_id)
    return JSONResponse({"ok": True})


@router.post("/api/session/{session_id}/deny/{identity}")
async def deny_guest(session_id: str, identity: str, request: Request):
    data = await request.json()
    host_token = data.get("host_token", "")
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Not authorized")
    session.denied_guests[identity] = True
    await touch(session_id)
    return JSONResponse({"ok": True})


# ── Session metadata ─────────────────────────────────────────────────────────

@router.post("/api/session/{session_id}/metadata")
async def update_metadata(session_id: str, request: Request):
    data = await request.json()
    host_token = data.get("host_token", "")

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Not authorized")

    if "description" in data:
        session.description = str(data["description"])[:500]
    if "episode" in data:
        session.episode = str(data["episode"])[:100]
    if "notes" in data:
        session.notes = str(data["notes"])[:2000]
    if "tags" in data:
        raw_tags = data["tags"]
        if isinstance(raw_tags, list):
            session.tags = [str(t)[:50] for t in raw_tags[:20]]

    await touch(session_id)
    return JSONResponse({"ok": True})


# ── Host moderation ───────────────────────────────────────────────────────────

@router.post("/api/session/{session_id}/kick/{p_identity}")
async def kick_participant(session_id: str, p_identity: str, request: Request):
    data = await request.json()
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404)
    if not _is_host(data.get("host_token", ""), session):
        raise HTTPException(status_code=403)
    from livekit import api as lkapi
    try:
        async with lkapi.LiveKitAPI(
            url=settings.livekit_url,
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret,
        ) as lk:
            await lk.room.remove_participant(
                lkapi.RoomParticipantIdentity(room=session_id, identity=p_identity)
            )
    except Exception as e:
        logging.error("LiveKit remove_participant failed for %s: %s", p_identity, e)
        raise HTTPException(status_code=500, detail=f"LiveKit error: {e}")
    return JSONResponse({"ok": True})


@router.post("/api/session/{session_id}/mute/{p_identity}")
async def mute_participant(session_id: str, p_identity: str, request: Request):
    data = await request.json()
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404)
    if not _is_host(data.get("host_token", ""), session):
        raise HTTPException(status_code=403)
    track_sid = data.get("track_sid", "")
    muted = bool(data.get("muted", True))
    if not track_sid:
        raise HTTPException(status_code=400, detail="track_sid required")
    from livekit import api as lkapi
    try:
        async with lkapi.LiveKitAPI(
            url=settings.livekit_url,
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret,
        ) as lk:
            await lk.room.mute_published_track(
                lkapi.MuteRoomTrackRequest(
                    room=session_id,
                    identity=p_identity,
                    track_sid=track_sid,
                    muted=muted,
                )
            )
    except Exception as e:
        logging.error("LiveKit mute_published_track failed for %s (track %s): %s", p_identity, track_sid, e)
        raise HTTPException(status_code=500, detail=f"LiveKit error: {e}")
    return JSONResponse({"ok": True})


# ── Topic markers ────────────────────────────────────────────────────────────

_MAX_MARKERS = 500


@router.post("/api/session/{session_id}/marker")
async def create_marker(session_id: str, request: Request):
    data = await request.json()
    host_token = data.get("host_token", "")
    label = str(data.get("label", "")).strip()[:100]
    recording_time_s = data.get("recording_time_s")

    identity = data.get("identity", "")

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session) and identity not in session.admitted_guests:
        raise HTTPException(status_code=403, detail="Not authorized")

    recordings_path = Path(settings.recordings_dir)
    session_path = recordings_path / session.dir_name
    session_path.mkdir(parents=True, exist_ok=True)

    filename = "markers.txt"
    marker_path = session_path / filename

    if marker_path.is_file():
        try:
            line_count = marker_path.read_text().count("\n")
            if line_count >= _MAX_MARKERS:
                raise HTTPException(status_code=429, detail="Marker limit reached for this session")
        except HTTPException:
            raise
        except Exception:
            pass

    time_str = ""
    if recording_time_s is not None:
        try:
            t = int(recording_time_s)
            m, s = divmod(t, 60)
            time_str = f"[{m}:{s:02d}] "
        except (TypeError, ValueError):
            pass

    line = f"- {time_str}{label}" if label else f"- {time_str}marker"

    with marker_path.open("a") as f:
        f.write(line + "\n")

    return JSONResponse({"ok": True, "filename": filename})


# ── Assembly status ──────────────────────────────────────────────────────────

@router.get("/api/session/{session_id}/verify-recordings")
async def verify_recordings(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session_path = Path(settings.recordings_dir) / session.dir_name
    if not session_path.is_dir():
        return JSONResponse({"issues": []})
    issues = []
    for pdir in sorted(session_path.iterdir()):
        if not pdir.is_dir():
            continue
        participant = pdir.name
        for fpath in sorted(pdir.iterdir()):
            if not fpath.is_file():
                continue
            name = fpath.name
            if "_chunk_" in name or "_noaudio" in name or "_source" in name:
                continue
            if fpath.suffix not in (".wav", ".mp4", ".webm"):
                continue
            try:
                proc = await asyncio.create_subprocess_exec(
                    "ffprobe", "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    str(fpath),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await proc.communicate()
                val = stdout.decode().strip()
                dur = float(val) if val else 0.0
            except Exception:
                dur = 0.0
            if dur == 0.0:
                issues.append({"participant": participant, "file": name, "issue": "empty or unreadable"})
            elif dur < 3.0:
                issues.append({"participant": participant, "file": name, "issue": f"very short ({dur:.1f}s) — may be incomplete"})
    return JSONResponse({"issues": issues})


@router.get("/api/session/{session_id}/assembly-status")
async def assembly_status_route(session_id: str):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    recordings_path = Path(settings.recordings_dir)
    session_path = recordings_path / session.dir_name
    if not session_path.is_dir():
        return JSONResponse({"assembling": False})
    has_chunks = False
    for pdir in session_path.iterdir():
        if not pdir.is_dir():
            continue
        if any("_chunk_" in f.name for f in pdir.iterdir() if f.is_file()):
            has_chunks = True
            break
    return JSONResponse({"assembling": has_chunks})
