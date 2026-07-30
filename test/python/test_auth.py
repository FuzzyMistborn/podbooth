"""Coverage for host authentication and CSRF protection (CLAUDE.md candidate
test #4): app/auth.py's signed session-token scheme and app/routers/login.py's
double-submit CSRF check and open-redirect guard. Cheap to test and gates
everything host-only in the app, but had zero coverage.
"""
from datetime import datetime, timezone

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app import auth
from app.config import settings
from app.routers import login


@pytest.fixture(autouse=True)
def _host_password(monkeypatch):
    monkeypatch.setattr(settings, "host_password", "correct-horse-battery-staple")


@pytest.fixture
def app():
    api = FastAPI()
    api.include_router(login.router)

    @api.get("/protected")
    async def protected(_: None = Depends(auth.require_host)):
        return {"ok": True}

    return api


@pytest.fixture
def client(app):
    return TestClient(app, follow_redirects=False)


# ── require_host / session token ─────────────────────────────────────────────

def test_require_host_redirects_to_login_when_unauthenticated(client):
    r = client.get("/protected")
    assert r.status_code == 303
    assert r.headers["location"].startswith("/login?next=")


def test_require_host_allows_a_valid_session_cookie(client):
    token = auth.make_session_token()
    client.cookies.set(auth.COOKIE_NAME, token)
    r = client.get("/protected")
    assert r.status_code == 200


def test_verify_session_token_rejects_tampered_signature():
    token = auth.make_session_token()
    expires, sig = token.split(".", 1)
    tampered = f"{expires}.{'0' * len(sig)}"
    assert not auth.verify_session_token(tampered)


def test_verify_session_token_rejects_expired_token(monkeypatch):
    import time
    real_time = time.time
    # Mint a token as if it were issued a year ago, so its expiry has passed.
    monkeypatch.setattr(time, "time", lambda: real_time() - 365 * 24 * 3600)
    token = auth.make_session_token()
    monkeypatch.setattr(time, "time", real_time)
    assert not auth.verify_session_token(token)


def test_verify_session_token_rejects_junk_input():
    assert not auth.verify_session_token("")
    assert not auth.verify_session_token("not-a-token-at-all")


def test_check_password_rejects_wrong_password():
    assert not auth.check_password("wrong-password")
    assert auth.check_password("correct-horse-battery-staple")


def test_require_host_is_a_noop_when_no_password_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "host_password", "")
    r = client.get("/protected")
    assert r.status_code == 200


# ── require_api_key ───────────────────────────────────────────────────────────

def test_require_api_key_fails_closed_when_unconfigured(monkeypatch):
    from fastapi import Request
    monkeypatch.setattr(settings, "api_key", "")
    scope = {"type": "http", "headers": []}
    req = Request(scope)
    with pytest.raises(Exception) as exc_info:
        auth.require_api_key(req)
    assert exc_info.value.status_code == 503


# ── /login: CSRF + open-redirect ─────────────────────────────────────────────

def test_login_page_sets_csrf_cookie(client):
    r = client.get("/login")
    assert r.status_code == 200
    assert auth.CSRF_COOKIE in r.cookies


def test_login_submit_without_csrf_cookie_is_rejected(client):
    r = client.post("/login", data={"password": "correct-horse-battery-staple", "csrf_token": "whatever"})
    assert r.status_code == 403


def test_login_submit_with_mismatched_csrf_is_rejected(client):
    get_resp = client.get("/login")
    csrf_cookie = get_resp.cookies[auth.CSRF_COOKIE]
    r = client.post(
        "/login",
        data={"password": "correct-horse-battery-staple", "csrf_token": "not-the-cookie-value"},
    )
    assert r.status_code == 403


def test_login_submit_with_matching_csrf_and_correct_password_succeeds(client):
    get_resp = client.get("/login")
    csrf_cookie = get_resp.cookies[auth.CSRF_COOKIE]
    r = client.post(
        "/login",
        data={"password": "correct-horse-battery-staple", "csrf_token": csrf_cookie, "next": "/"},
    )
    assert r.status_code == 303
    assert auth.COOKIE_NAME in r.cookies


def test_login_submit_with_wrong_password_does_not_set_session_cookie(client):
    get_resp = client.get("/login")
    csrf_cookie = get_resp.cookies[auth.CSRF_COOKIE]
    r = client.post(
        "/login",
        data={"password": "wrong", "csrf_token": csrf_cookie},
    )
    assert r.status_code == 401
    assert auth.COOKIE_NAME not in r.cookies


@pytest.mark.parametrize("next_url,expected", [
    ("/dashboard", "/dashboard"),
    ("//evil.com/phish", "/"),
    ("/\\evil.com/phish", "/"),
    ("http://evil.com", "/"),
    ("javascript:alert(1)", "/"),
])
def test_safe_next_blocks_protocol_relative_and_absolute_redirects(next_url, expected):
    assert login._safe_next(next_url) == expected
