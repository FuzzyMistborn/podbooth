import os
import subprocess
from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path


def _app_version() -> str:
    if v := os.environ.get("APP_VERSION", "").strip():
        return v
    try:
        tag = subprocess.check_output(
            ["git", "describe", "--tags", "--abbrev=0"],
            cwd=Path(__file__).parent.parent,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return tag if tag else "dev"
    except Exception:
        return "dev"


APP_VERSION = _app_version()


def _asset_version() -> str:
    """Cache-busting token = newest mtime under the static dir. Recomputed at
    import time, i.e. once per process start / container rebuild, so browsers
    fetch fresh CSS/JS after a deploy instead of serving a stale cache."""
    static_dir = Path(__file__).parent / "static"
    latest = 0.0
    for p in static_dir.rglob("*"):
        if p.is_file():
            latest = max(latest, p.stat().st_mtime)
    return str(int(latest))


ASSET_VERSION = _asset_version()


class Settings(BaseSettings):
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "devsecret"
    livekit_url: str = "ws://livekit:7880"
    livekit_public_url: str = "ws://localhost:7880"
    secret_key: str = "change-this"
    recordings_dir: str = "/recordings"
    base_url: str = "http://localhost:8000"
    host_password: str = ""
    retention_days: int = 0

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
