"""Cookie-based host authentication.

The login form posts the host password; on success we set a signed, expiring
cookie. The signing key is derived from secret_key + host_password, so
changing either invalidates all existing sessions.
"""

import hashlib
import hmac
import secrets
import time
from urllib.parse import quote

from fastapi import HTTPException, Request

from app.config import settings

CSRF_COOKIE = "podbooth_csrf"


def make_csrf_token() -> str:
    return secrets.token_hex(32)


async def require_csrf(request: Request) -> None:
    """FastAPI dependency: verify double-submit CSRF cookie on form POSTs."""
    form = await request.form()
    submitted = str(form.get("csrf_token", ""))
    cookie = request.cookies.get(CSRF_COOKIE, "")
    if not cookie or not submitted or not hmac.compare_digest(submitted, cookie):
        raise HTTPException(status_code=403, detail="CSRF check failed")

COOKIE_NAME = "podbooth_host"
SESSION_TTL_SECONDS = 7 * 24 * 3600


def password_configured() -> bool:
    return bool(settings.host_password)


def check_password(password: str) -> bool:
    if not password_configured():
        return False
    return secrets.compare_digest(password.encode(), settings.host_password.encode())


def _signing_key() -> bytes:
    return hashlib.sha256(
        (settings.secret_key + ":" + settings.host_password).encode()
    ).digest()


def make_session_token() -> str:
    expires = str(int(time.time()) + SESSION_TTL_SECONDS)
    sig = hmac.new(_signing_key(), expires.encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{sig}"


def verify_session_token(token: str) -> bool:
    if not password_configured() or not token or "." not in token:
        return False
    expires, sig = token.split(".", 1)
    expected = hmac.new(_signing_key(), expires.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        return int(expires) > time.time()
    except ValueError:
        return False


def require_host(request: Request) -> None:
    if not password_configured():
        return
    if verify_session_token(request.cookies.get(COOKIE_NAME, "")):
        return
    # Send browsers to the login page; remember where they were headed.
    raise HTTPException(
        status_code=303,
        headers={"Location": f"/login?next={quote(request.url.path)}"},
    )
