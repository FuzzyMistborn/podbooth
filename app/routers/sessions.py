from datetime import datetime, timedelta
import asyncio
import json
import logging
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, Request, Form, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from livekit.api import AccessToken, VideoGrants

from app.models import create_session, get_session, end_session, delete_session, touch, title_in_use, list_sessions
from app.routers.upload import recover_orphaned_chunks
from app.config import settings, ASSET_VERSION
from app.auth import require_host

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
templates.env.globals["asset_v"] = ASSET_VERSION


def _is_host(host_token, session) -> bool:
    if not isinstance(host_token, str):
        return False
    return secrets.compare_digest(host_token, session.host_token)


@router.get("/", response_class=HTMLResponse)
async def index(request: Request, _: None = Depends(require_host)):
    error = request.query_params.get("error")
    title = request.query_params.get("title", "")
    return templates.TemplateResponse(request, "index.html", {
        "error": error,
        "prefill_title": title,
    })


@router.post("/session/new")
async def new_session(title: str = Form(...), _: None = Depends(require_host)):
    if title_in_use(title):
        return RedirectResponse(
            url=f"/?error=duplicate&title={title}",
            status_code=303,
        )
    session = create_session(title)
    return RedirectResponse(
        url=f"/join/{session.id}?host_token={session.host_token}",
        status_code=303,
    )


@router.get("/join/{session_id}", response_class=HTMLResponse)
async def join_page(request: Request, session_id: str, host_token: str = ""):
    session = get_session(session_id)
    if not session or session.ended:
        return templates.TemplateResponse(
            request, "error.html",
            {"message": "This session has ended or does not exist."},
            status_code=404,
        )
    is_host = _is_host(host_token, session)
    return templates.TemplateResponse(
        request, "prejoin.html",
        {
            "session": session,
            "host_token": host_token if is_host else "",
        },
    )


@router.get("/studio/{session_id}", response_class=HTMLResponse)
async def studio(request: Request, session_id: str, host_token: str = ""):
    session = get_session(session_id)
    if not session:
        return templates.TemplateResponse(
            request, "error.html",
            {"message": "Session not found."},
            status_code=404,
        )
    is_host = _is_host(host_token, session)
    return templates.TemplateResponse(
        request, "studio.html",
        {
            "session": session,
            "is_host": is_host,
            "host_token": host_token if is_host else "",
            "livekit_url": settings.livekit_public_url,
            "base_url": settings.base_url,
        },
    )


@router.post("/api/token")
async def get_token(request: Request):
    data = await request.json()
    session_id = data.get("session_id")
    identity = data.get("identity")            # unique per connection
    display_name = data.get("display_name")    # what humans see / file naming
    host_token = data.get("host_token", "")

    if not session_id or not identity or not display_name:
        raise HTTPException(status_code=400, detail="Missing session_id, identity, or display_name")

    session = get_session(session_id)
    if not session or session.ended:
        raise HTTPException(status_code=404, detail="Session not found or ended")

    is_host = _is_host(host_token, session)

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
    touch(session_id)

    return JSONResponse({"token": token, "is_host": is_host})


@router.post("/api/session/{session_id}/recording")
async def set_recording(session_id: str, request: Request):
    data = await request.json()
    host_token = data.get("host_token", "")
    action = data.get("action")  # "start", "stop", "pause", or "resume"

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Not authorized")

    if action == "start":
        session.recording = True
        session.paused = False
    elif action == "stop":
        session.recording = False
        session.paused = False
    elif action == "pause":
        session.recording = False
        session.paused = True
    elif action == "resume":
        session.recording = True
        session.paused = False
    else:
        raise HTTPException(status_code=400, detail="action must be 'start', 'stop', 'pause', or 'resume'")

    touch(session_id)
    return JSONResponse({"recording": session.recording, "paused": session.paused})


@router.post("/api/session/{session_id}/end")
async def end_session_route(session_id: str, request: Request):
    data = await request.json()
    host_token = data.get("host_token", "")

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _is_host(host_token, session):
        raise HTTPException(status_code=403, detail="Not authorized")

    end_session(session_id)
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

    delete_session(session_id)
    return JSONResponse({"deleted": True})


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
        "paused": session.paused,
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
    touch(session_id)
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
    touch(session_id)
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
    touch(session_id)
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

    touch(session_id)
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


# ── Assembly status ──────────────────────────────────────────────────────────

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
