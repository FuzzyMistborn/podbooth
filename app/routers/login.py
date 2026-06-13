from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.auth import (
    COOKIE_NAME,
    SESSION_TTL_SECONDS,
    check_password,
    make_session_token,
    password_configured,
)
from app.config import settings, ASSET_VERSION

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
templates.env.globals["asset_v"] = ASSET_VERSION


def _safe_next(next_url: str) -> str:
    # Only allow same-site relative paths to avoid open redirects.
    if next_url.startswith("/") and not next_url.startswith("//"):
        return next_url
    return "/"


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, next: str = "/"):
    if not password_configured():
        return RedirectResponse(url=_safe_next(next), status_code=303)
    return templates.TemplateResponse(
        request, "login.html",
        {
            "next": _safe_next(next),
            "error": None,
        },
    )


@router.post("/login")
async def login_submit(request: Request, password: str = Form(...), next: str = Form("/")):
    if not check_password(password):
        return templates.TemplateResponse(
            request, "login.html",
            {
                "next": _safe_next(next),
                "error": "Incorrect password.",
            },
            status_code=401,
        )
    response = RedirectResponse(url=_safe_next(next), status_code=303)
    response.set_cookie(
        COOKIE_NAME,
        make_session_token(),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=settings.base_url.startswith("https"),
    )
    return response


@router.get("/logout")
async def logout():
    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(COOKIE_NAME)
    return response
