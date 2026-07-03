"""
Cloud upload backends: Nextcloud/WebDAV, FileBrowser, Cloudflare R2, Backblaze B2.

All are optional and controlled by environment variables.
Upload is triggered manually via the dashboard (host recordings) or via the
participant local-upload page (OBS recordings).

Remote path layout:
  {upload_path}/{session_slug}/podbooth/{participant}/{filename}  — server recordings
  {upload_path}/{session_slug}/local/{filename}                   — participant OBS uploads
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from app.auth import require_host
from app.config import settings
from app.models import get_session

logger = logging.getLogger(__name__)

router = APIRouter()

# session_id → {"status": "uploading"|"done"|"error", "message": str, "uploaded": int, "total": int}
_upload_status: dict[str, dict] = {}
_upload_task_refs: set[asyncio.Task] = set()


# ── File descriptor ────────────────────────────────────────────────────────────

@dataclass
class UploadItem:
    local_path: Path
    remote_path: str  # relative to upload_path, e.g. "SessionSlug/podbooth/Alice/video.mp4"


# ── Backend base class ─────────────────────────────────────────────────────────

class CloudBackend(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def is_enabled(self) -> bool: ...

    @abstractmethod
    async def upload(self, items: list[UploadItem]) -> tuple[int, str]:
        """Upload items. Returns (count_uploaded, error_message)."""
        ...

    @abstractmethod
    async def delete_folder(self, folder_path: str) -> str:
        """Delete a remote folder. Returns error message or empty string on success."""
        ...


# ── Nextcloud / WebDAV ─────────────────────────────────────────────────────────

class NextcloudBackend(CloudBackend):
    name = "Nextcloud"

    def is_enabled(self) -> bool:
        return bool(settings.nextcloud_url and settings.nextcloud_user and settings.nextcloud_password)

    async def _ensure_dir(self, client: httpx.AsyncClient, url: str) -> None:
        r = await client.request("MKCOL", url)
        if r.status_code not in (201, 405, 301, 302):
            logger.warning("MKCOL %s → %d", url, r.status_code)

    async def delete_folder(self, folder_path: str) -> str:
        base = settings.nextcloud_url.rstrip("/")
        upload_path = settings.nextcloud_upload_path.strip("/")
        dav_root = f"{base}/remote.php/dav/files/{settings.nextcloud_user}"
        auth = (settings.nextcloud_user, settings.nextcloud_password)
        remote = f"{upload_path}/{folder_path}" if upload_path else folder_path
        url = f"{dav_root}/{remote}"
        try:
            async with httpx.AsyncClient(auth=auth, timeout=60) as client:
                r = await client.request("DELETE", url)
                if r.status_code in (200, 204, 404):
                    return ""
                return f"Nextcloud: DELETE {remote} → HTTP {r.status_code}"
        except Exception as e:
            return f"Nextcloud error: {e}"

    async def upload(self, items: list[UploadItem]) -> tuple[int, str]:
        base = settings.nextcloud_url.rstrip("/")
        upload_path = settings.nextcloud_upload_path.strip("/")
        dav_root = f"{base}/remote.php/dav/files/{settings.nextcloud_user}"
        auth = (settings.nextcloud_user, settings.nextcloud_password)
        uploaded = 0

        async with httpx.AsyncClient(auth=auth, timeout=300) as client:
            # Pre-create all needed directories
            dirs_needed: set[str] = set()
            for item in items:
                parts = item.remote_path.split("/")
                for i in range(1, len(parts)):
                    d = "/".join(parts[:i])
                    if upload_path:
                        dirs_needed.add(f"{upload_path}/{d}")
                    else:
                        dirs_needed.add(d)
            if upload_path:
                dirs_needed.add(upload_path)

            for d in sorted(dirs_needed, key=lambda x: x.count("/")):
                await self._ensure_dir(client, f"{dav_root}/{d}")

            for item in items:
                if not item.local_path.is_file():
                    continue
                remote = f"{upload_path}/{item.remote_path}" if upload_path else item.remote_path
                url = f"{dav_root}/{remote}"
                try:
                    with open(item.local_path, "rb") as fh:
                        content = fh.read()
                    r = await client.put(url, content=content)
                    if r.status_code in (200, 201, 204):
                        uploaded += 1
                        logger.info("nextcloud upload ok: %s → %d", remote, r.status_code)
                    else:
                        logger.error("nextcloud upload failed: %s → %d %s", remote, r.status_code, r.text[:200])
                        return uploaded, f"Nextcloud: upload failed for {item.local_path.name}: HTTP {r.status_code}"
                except Exception as e:
                    logger.error("nextcloud upload exception: %s: %s", remote, e)
                    return uploaded, f"Nextcloud error: {e}"

        return uploaded, ""


# ── FileBrowser ────────────────────────────────────────────────────────────────

class FileBrowserBackend(CloudBackend):
    name = "FileBrowser"

    def is_enabled(self) -> bool:
        return bool(settings.filebrowser_url and settings.filebrowser_user and settings.filebrowser_password)

    async def _get_token(self, client: httpx.AsyncClient) -> str:
        base = settings.filebrowser_url.rstrip("/")
        r = await client.post(
            f"{base}/api/login",
            json={"username": settings.filebrowser_user, "password": settings.filebrowser_password},
        )
        if r.status_code != 200:
            raise RuntimeError(f"FileBrowser login failed: HTTP {r.status_code}")
        return r.text.strip('"')

    async def delete_folder(self, folder_path: str) -> str:
        base = settings.filebrowser_url.rstrip("/")
        upload_path = settings.filebrowser_upload_path.strip("/")
        remote = f"{upload_path}/{folder_path}" if upload_path else folder_path
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                token = await self._get_token(client)
                r = await client.delete(
                    f"{base}/api/resources/{remote}?recursive=true",
                    headers={"X-Auth": token},
                )
                if r.status_code in (200, 204, 404):
                    return ""
                return f"FileBrowser: DELETE {remote} → HTTP {r.status_code}"
        except Exception as e:
            return f"FileBrowser error: {e}"

    async def upload(self, items: list[UploadItem]) -> tuple[int, str]:
        base = settings.filebrowser_url.rstrip("/")
        upload_path = settings.filebrowser_upload_path.strip("/")
        uploaded = 0

        async with httpx.AsyncClient(timeout=300) as client:
            try:
                token = await self._get_token(client)
            except Exception as e:
                return 0, str(e)

            headers = {"X-Auth": token}

            async def _mkdir(path: str) -> None:
                r = await client.post(f"{base}/api/resources/{path}/", headers=headers)
                if r.status_code not in (200, 201, 409):
                    logger.warning("filebrowser mkdir %s → %d", path, r.status_code)

            dirs_needed: set[str] = set()
            for item in items:
                parts = item.remote_path.split("/")
                for i in range(1, len(parts)):
                    d = "/".join(parts[:i])
                    dirs_needed.add(f"{upload_path}/{d}" if upload_path else d)
            if upload_path:
                dirs_needed.add(upload_path)

            for d in sorted(dirs_needed, key=lambda x: x.count("/")):
                await _mkdir(d)

            for item in items:
                if not item.local_path.is_file():
                    continue
                remote = f"{upload_path}/{item.remote_path}" if upload_path else item.remote_path
                url = f"{base}/api/resources/{remote}?override=true"
                try:
                    with open(item.local_path, "rb") as fh:
                        content = fh.read()
                    r = await client.post(url, content=content, headers=headers)
                    if r.status_code in (200, 201, 204):
                        uploaded += 1
                        logger.info("filebrowser upload ok: %s → %d", remote, r.status_code)
                    else:
                        logger.error("filebrowser upload failed: %s → %d %s", remote, r.status_code, r.text[:200])
                        return uploaded, f"FileBrowser: upload failed for {item.local_path.name}: HTTP {r.status_code}"
                except Exception as e:
                    logger.error("filebrowser upload exception: %s: %s", remote, e)
                    return uploaded, f"FileBrowser error: {e}"

        return uploaded, ""


# ── S3-compatible (R2 + B2) ────────────────────────────────────────────────────

class S3Backend(CloudBackend):
    """Generic S3-compatible backend. Used for Cloudflare R2 and Backblaze B2."""

    def __init__(
        self,
        backend_name: str,
        endpoint_url: str,
        access_key_id: str,
        access_key_secret: str,
        bucket: str,
        upload_path: str,
        region: str = "auto",
    ):
        self._name = backend_name
        self._endpoint_url = endpoint_url
        self._access_key_id = access_key_id
        self._access_key_secret = access_key_secret
        self._bucket = bucket
        self._upload_path = upload_path.strip("/")
        self._region = region

    @property
    def name(self) -> str:
        return self._name

    def is_enabled(self) -> bool:
        return bool(
            self._endpoint_url
            and self._access_key_id
            and self._access_key_secret
            and self._bucket
        )

    async def delete_folder(self, folder_path: str) -> str:
        try:
            import boto3
            from botocore.exceptions import BotoCoreError, ClientError
        except ImportError:
            return f"{self._name}: boto3 required"

        prefix = f"{self._upload_path}/{folder_path}/" if self._upload_path else f"{folder_path}/"

        def _do_delete() -> str:
            s3 = boto3.client(
                "s3",
                endpoint_url=self._endpoint_url,
                aws_access_key_id=self._access_key_id,
                aws_secret_access_key=self._access_key_secret,
                region_name=self._region,
            )
            try:
                paginator = s3.get_paginator("list_objects_v2")
                to_delete = []
                for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
                    for obj in page.get("Contents", []):
                        to_delete.append({"Key": obj["Key"]})
                if not to_delete:
                    return ""
                # S3 delete_objects accepts up to 1000 keys per call
                for i in range(0, len(to_delete), 1000):
                    s3.delete_objects(
                        Bucket=self._bucket,
                        Delete={"Objects": to_delete[i:i+1000], "Quiet": True},
                    )
                logger.info("%s deleted %d objects under %s", self._name, len(to_delete), prefix)
                return ""
            except (BotoCoreError, ClientError) as e:
                return f"{self._name}: delete error: {e}"

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _do_delete)

    async def upload(self, items: list[UploadItem]) -> tuple[int, str]:
        try:
            import boto3
            from botocore.exceptions import BotoCoreError, ClientError
        except ImportError:
            return 0, f"{self._name}: boto3 is required for S3-compatible uploads (pip install boto3)"

        import functools

        def _do_upload() -> tuple[int, str]:
            s3 = boto3.client(
                "s3",
                endpoint_url=self._endpoint_url,
                aws_access_key_id=self._access_key_id,
                aws_secret_access_key=self._access_key_secret,
                region_name=self._region,
            )
            uploaded = 0
            errors: list[str] = []
            for item in items:
                if not item.local_path.is_file():
                    continue
                key = f"{self._upload_path}/{item.remote_path}" if self._upload_path else item.remote_path
                try:
                    # Never log presigned URLs — they carry embedded credentials.
                    s3.upload_file(str(item.local_path), self._bucket, key)
                    uploaded += 1
                    logger.info("%s upload ok: s3://%s/%s", self._name, self._bucket, key)
                except (BotoCoreError, ClientError) as e:
                    logger.error("%s upload failed: %s: %s", self._name, key, e)
                    errors.append(f"{item.local_path.name}: {e}")
            if errors:
                return uploaded, f"{self._name}: upload failed for {len(errors)} file(s): {'; '.join(errors)}"
            return uploaded, ""

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _do_upload)


# ── Backend registry ───────────────────────────────────────────────────────────

def _get_backends() -> list[CloudBackend]:
    backends: list[CloudBackend] = [
        NextcloudBackend(),
        FileBrowserBackend(),
        S3Backend(
            backend_name="R2",
            endpoint_url=f"https://{settings.r2_account_id}.r2.cloudflarestorage.com" if settings.r2_account_id else "",
            access_key_id=settings.r2_access_key_id,
            access_key_secret=settings.r2_access_key_secret,
            bucket=settings.r2_bucket,
            upload_path=settings.r2_upload_path,
            region="auto",
        ),
        S3Backend(
            backend_name="B2",
            endpoint_url=settings.b2_endpoint_url,
            access_key_id=settings.b2_access_key_id,
            access_key_secret=settings.b2_access_key_secret,
            bucket=settings.b2_bucket,
            upload_path=settings.b2_upload_path,
            region="auto",
        ),
    ]
    return [b for b in backends if b.is_enabled()]


def cloud_upload_enabled() -> bool:
    return bool(_get_backends())


# ── Session slug helper ────────────────────────────────────────────────────────

def _session_slug(title: str) -> str:
    return "".join(c if c.isalnum() or c in "- _" else "_" for c in title).strip()


# ── Upload orchestrator ────────────────────────────────────────────────────────

async def run_upload(
    job_id: str,
    status_store: dict,
    items: list[UploadItem],
    backends: list[CloudBackend],
) -> None:
    """Run items through all backends, updating status_store[job_id] as we go."""
    total = len(items)
    status_store[job_id] = {"status": "uploading", "message": "Uploading…", "uploaded": 0, "total": total}

    errors: list[str] = []
    uploaded = 0

    for backend in backends:
        status_store[job_id]["message"] = f"Uploading to {backend.name}…"
        n, err = await backend.upload(items)
        uploaded += n
        status_store[job_id]["uploaded"] = uploaded
        if err:
            errors.append(err)

    if errors:
        status_store[job_id] = {
            "status": "error",
            "message": "; ".join(errors),
            "uploaded": uploaded,
            "total": total,
        }
    else:
        status_store[job_id] = {
            "status": "done",
            "message": f"Uploaded {uploaded} file(s)",
            "uploaded": uploaded,
            "total": total,
        }


async def delete_cloud_session(session_slug: str) -> list[str]:
    """Delete the session folder on all configured backends. Returns list of errors."""
    errors = []
    for backend in _get_backends():
        err = await backend.delete_folder(session_slug)
        if err:
            logger.error("Cloud delete failed (%s): %s", backend.name, err)
            errors.append(err)
    return errors


def build_podbooth_items(files: list[dict], session_slug: str) -> list[UploadItem]:
    """Convert session file dicts into UploadItems under the podbooth/ subdir."""
    recordings_base = Path(settings.recordings_dir)
    items = []
    for f in files:
        local_path = recordings_base / f["path"]
        if f.get("participant"):
            remote = f"{session_slug}/podbooth/{f['participant']}/{f['filename']}"
        else:
            remote = f"{session_slug}/podbooth/{f['filename']}"
        items.append(UploadItem(local_path=local_path, remote_path=remote))
    return items


# ── Host upload endpoints ──────────────────────────────────────────────────────

@router.post("/api/session/{session_id}/upload-cloud")
async def start_cloud_upload(session_id: str, _: None = Depends(require_host)):
    backends = _get_backends()
    if not backends:
        raise HTTPException(status_code=400, detail="No cloud upload configured")

    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    status = _upload_status.get(session_id, {})
    if status.get("status") == "uploading":
        return JSONResponse({"status": "uploading"})

    from app.routers.dashboard import _get_session_files
    files = _get_session_files(session)
    uploadable = [f for f in files if f["type"] not in ("marker",)]
    if not uploadable:
        raise HTTPException(status_code=400, detail="No files to upload")

    items = build_podbooth_items(uploadable, _session_slug(session.title))
    task = asyncio.create_task(run_upload(session_id, _upload_status, items, backends))
    _upload_task_refs.add(task)
    task.add_done_callback(_upload_task_refs.discard)

    return JSONResponse({"status": "uploading"})


@router.get("/api/session/{session_id}/upload-cloud-status")
async def cloud_upload_status(session_id: str, _: None = Depends(require_host)):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    status = _upload_status.get(session_id)
    if not status:
        return JSONResponse({"status": "idle"})
    return JSONResponse(status)
