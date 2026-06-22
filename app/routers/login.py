from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.auth import (
    COOKIE_NAME,
    CSRF_COOKIE,
    SESSION_TTL_SECONDS,
    check_password,
    make_csrf_token,
    make_session_token,
    password_configured,
    require_csrf,
)
from app.config import settings, ASSET_VERSION, APP_VERSION
from app.limiter import limiter

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
templates.env.globals["asset_v"] = ASSET_VERSION
templates.env.globals["app_version"] = APP_VERSION


def _safe_next(next_url: str) -> str:
    # Only allow same-site relative paths to avoid open redirects.
    # Reject // and /\ — both can be normalized to protocol-relative URLs by browsers.
    if next_url.startswith("/") and not next_url.startswith("//") and not next_url.startswith("/\\"):
        return next_url
    return "/"


def _get_or_create_csrf(request: Request) -> tuple[str, bool]:
    """Return (token, is_new). Caller sets the cookie only when is_new is True."""
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


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, next: str = "/"):
    if not password_configured():
        return RedirectResponse(url=_safe_next(next), status_code=303)
    csrf, is_new = _get_or_create_csrf(request)
    resp = templates.TemplateResponse(
        request, "login.html",
        {"next": _safe_next(next), "error": None, "csrf_token": csrf},
    )
    if is_new:
        _set_csrf_cookie(resp, csrf)
    return resp


@router.post("/login")
@limiter.limit("5/minute")
async def login_submit(
    request: Request,
    password: str = Form(...),
    next: str = Form("/"),
    _csrf: None = Depends(require_csrf),
):
    if not check_password(password):
        csrf, is_new = _get_or_create_csrf(request)
        resp = templates.TemplateResponse(
            request, "login.html",
            {"next": _safe_next(next), "error": "Incorrect password.", "csrf_token": csrf},
            status_code=401,
        )
        if is_new:
            _set_csrf_cookie(resp, csrf)
        return resp
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
