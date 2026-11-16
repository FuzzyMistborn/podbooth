#!/usr/bin/env python3
"""Preview the full studio UI — no Docker image, no backend, no LiveKit.

    python3 scripts/studio-demo.py [--host 0.0.0.0] [--port 8100]
    open http://localhost:8100/              (host)
    open http://localhost:8100/?role=guest   (guest)

Renders the REAL app/templates/studio.html and runs the REAL app/static/js/*.js
(re-read on every request, so edits show up on reload). The only fakes:

  * LiveKit  -> scripts/studio-demo/fake-livekit.js (synthetic camera/mic; tabs of
                this page see each other: chat, hands, timer, recording start/stop)
  * /api/*   -> tiny canned responses below. No sessions, no uploads (chunks are
                accepted and discarded), nothing is written to disk.

Add ?bots=3 for always-present fake participants. For the real backend (uploads,
assembly, lobby/admit) use scripts/studio-demo.py instead. Needs only jinja2
(already in requirements.txt).
"""
import argparse
import json
import re
import time
from base64 import urlsafe_b64encode
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
FAKE_JS = ROOT / "scripts" / "studio-demo" / "fake-livekit.js"
SID = "demo"

LIVEKIT_TAG = re.compile(r'<script\s+src="https://cdn\.jsdelivr\.net/npm/livekit-client@[^"]*"([^>]*)></script>')
MIME = {".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png",
        ".ico": "image/x-icon", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2"}

state = {"recording": False, "ended": False}


def render_studio(is_host: bool, base_url: str) -> bytes:
    env = Environment(loader=FileSystemLoader(APP / "templates"), autoescape=select_autoescape(["html"]))
    env.globals.update(asset_v=str(int(time.time())), app_version="demo")
    html = env.get_template("studio.html").render(
        session={"id": SID, "title": "Studio demo", "notes": ""},
        is_host=is_host, host_token="demo-host-token" if is_host else "",
        livekit_url="ws://fake-livekit.invalid", base_url=base_url,
        cloud_upload_enabled=False, direct_cloud_upload_enabled=False,
        outline_enabled=False, outline_doc_id="", upload_token="demo-upload-token",
    )
    return LIVEKIT_TAG.sub(r'<script src="/dev/fake-livekit.js"\1></script>', html).encode()


def fake_token(identity: str, name: str, is_host: bool) -> str:
    """Unsigned JWT-shaped string; fake-livekit.js only reads the claims."""
    claims = {"sub": identity, "name": name, "metadata": json.dumps({"is_host": is_host}), "video": {"room": SID}}
    return "h." + urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".s"


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode())

    def _redirect(self, to):
        self._send(302, b"", extra={"Location": to})

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""  # always drain, even for chunk uploads
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path

        if path in ("/", f"/studio/{SID}", f"/join/{SID}"):
            role = (q.get("role") or ["host"])[0]
            # studio.js bounces to the pre-join page if there is no name
            if "participant_name" not in q:
                name = "Guest" if role == "guest" else "Host"
                qs = {k: v[0] for k, v in q.items()}
                qs.setdefault("role", role)
                qs["participant_name"] = name
                return self._redirect(f"/studio/{SID}?" + "&".join(f"{k}={v}" for k, v in qs.items()))
            if role != "guest":
                state["ended"] = False  # a fresh host load starts a fresh demo session
            host = self.headers.get("Host", "localhost")
            return self._send(200, render_studio(role != "guest", f"http://{host}"), "text/html; charset=utf-8")

        if path == "/dev/fake-livekit.js":
            return self._send(200, FAKE_JS.read_bytes(), "application/javascript; charset=utf-8")

        if path.startswith("/static/"):
            target = (APP / path.lstrip("/")).resolve()
            if not target.is_file() or not target.is_relative_to((APP / "static").resolve()):
                return self._send(404, b"not found", "text/plain")
            return self._send(200, target.read_bytes(), MIME.get(target.suffix, "application/octet-stream"))

        if path == f"/api/session/{SID}/status":
            return self._json({"recording": state["recording"], "ended": state["ended"], "participants": []})
        if path == f"/api/session/{SID}/pending-guests":
            return self._json({"guests": []})
        if path.startswith("/dashboard"):
            return self._send(200, b"<p style='font:16px sans-serif;padding:2em'>Session ended (studio demo) - "
                                   b"<a href='/'>back to the demo</a></p>", "text/html")
        if path.startswith("/api/"):
            return self._json({})
        return self._send(404, b"not found", "text/plain")

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()
        if path == "/api/token":
            return self._json({"token": fake_token(body.get("identity", "user"), body.get("display_name", "User"),
                                                   bool(body.get("host_token")))})
        if path == f"/api/session/{SID}/recording":
            state["recording"] = body.get("action") == "start"
            return self._json({"recording": state["recording"]})
        if path == f"/api/session/{SID}/end":
            state["ended"] = True
            return self._json({"ok": True})
        return self._json({"ok": True})  # markers, uploads, admit/deny, ...: accepted and ignored

    do_PUT = do_POST

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 to reach it from other machines)")
    ap.add_argument("--port", type=int, default=8100)
    a = ap.parse_args()
    shown = "localhost" if a.host in ("127.0.0.1", "0.0.0.0") else a.host
    print(f"Studio demo:  host  http://{shown}:{a.port}/\n              guest http://{shown}:{a.port}/?role=guest"
          f"\n              add ?bots=3 for fake participants")
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
