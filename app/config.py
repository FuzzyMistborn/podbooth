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
    api_key: str = ""
    retention_days: int = 0
    whisperx_api_url: str = ""
    whisperx_model: str = "large-v3-turbo"
    whisperx_language: str = ""

    # Nextcloud upload (WebDAV)
    nextcloud_url: str = ""
    nextcloud_user: str = ""
    nextcloud_password: str = ""
    nextcloud_upload_path: str = "PodBooth"

    # FileBrowser upload
    filebrowser_url: str = ""
    filebrowser_user: str = ""
    filebrowser_password: str = ""
    filebrowser_upload_path: str = "PodBooth"

    # Cloudflare R2 upload (S3-compatible)
    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_access_key_secret: str = ""
    r2_bucket: str = ""
    r2_upload_path: str = "PodBooth"

    # Backblaze B2 upload (S3-compatible)
    b2_endpoint_url: str = ""
    b2_access_key_id: str = ""
    b2_access_key_secret: str = ""
    b2_bucket: str = ""
    b2_upload_path: str = "PodBooth"

    # S3-compatible object storage (for editor delivery)
    s3_endpoint_url: str = ""
    s3_region: str = "auto"
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""
    s3_bucket_name: str = ""
    s3_public_url: str = ""
    s3_upload_expiry_days: int = 7

    # Editor portal
    editor_portal_url: str = ""

    # Discord notifications
    discord_webhook_url: str = ""

    # Outline wiki integration
    outline_api_url: str = ""
    outline_api_key: str = ""

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
