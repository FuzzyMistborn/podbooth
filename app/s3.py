"""
S3-compatible object storage client for Podbooth editor delivery.

Supports Cloudflare R2, Backblaze B2, or any S3-compatible backend.
Uses boto3 with a lazily-initialized cached client.
"""
import logging
import re
from datetime import datetime, timezone
from app.config import settings

logger = logging.getLogger(__name__)

_client = None

ALLOWED_CONTENT_TYPES = frozenset({
    "audio/wav", "audio/x-wav",
    "video/mp4", "video/quicktime", "video/webm",
})

_KEY_RE = re.compile(r'^[A-Za-z0-9._\-/ ]+$')
_MAX_KEY_LEN = 512


def _validate_key(key: str) -> None:
    if not key or len(key) > _MAX_KEY_LEN:
        raise ValueError(f"Key must be 1–{_MAX_KEY_LEN} characters")
    if ".." in key or "//" in key:
        raise ValueError("Key must not contain '..' or '//'")
    if not _KEY_RE.match(key):
        raise ValueError("Key contains disallowed characters (allowed: A-Za-z0-9 . _ - /)")


def _active_backend() -> tuple[str, str, str | None, str | None, str | None, str | None]:
    """Return (bucket, region, endpoint_url, access_key_id, secret_access_key, public_url)
    for whichever storage backend is configured (S3 → R2 → B2 priority)."""
    if settings.s3_bucket_name:
        return (
            settings.s3_bucket_name,
            settings.s3_region,
            settings.s3_endpoint_url or None,
            settings.s3_access_key_id or None,
            settings.s3_secret_access_key or None,
            settings.s3_public_url or None,
        )
    if settings.r2_bucket:
        endpoint = f"https://{settings.r2_account_id}.r2.cloudflarestorage.com" if settings.r2_account_id else None
        return (
            settings.r2_bucket,
            "auto",
            endpoint,
            settings.r2_access_key_id or None,
            settings.r2_access_key_secret or None,
            None,
        )
    if settings.b2_bucket:
        return (
            settings.b2_bucket,
            "auto",
            settings.b2_endpoint_url or None,
            settings.b2_access_key_id or None,
            settings.b2_access_key_secret or None,
            None,
        )
    raise RuntimeError("No object storage configured (set S3_BUCKET_NAME, R2_BUCKET, or B2_BUCKET)")


def _bucket() -> str:
    return _active_backend()[0]


def upload_prefix() -> str:
    """Return the upload path prefix for the active backend (e.g. 'PodBooth')."""
    if settings.s3_bucket_name:
        return ""
    if settings.r2_bucket:
        return settings.r2_upload_path.strip("/")
    if settings.b2_bucket:
        return settings.b2_upload_path.strip("/")
    return ""


def get_client():
    """Return cached boto3 S3 client. Raises RuntimeError if not configured."""
    global _client
    if _client is None:
        _, region, endpoint_url, access_key_id, secret_access_key, _ = _active_backend()
        import boto3
        _client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name=region,
        )
    return _client


def generate_upload_url(key: str, content_type: str, expires_in: int = 3600) -> str:
    """Presigned PUT URL for direct browser upload."""
    _validate_key(key)
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise ValueError(f"Content-type '{content_type}' is not allowed. Allowed: {sorted(ALLOWED_CONTENT_TYPES)}")
    s3 = get_client()
    # Never log the returned URL — it is a bearer token
    url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": _bucket(),
            "Key": key,
            "ContentType": content_type,
        },
        ExpiresIn=expires_in,
    )
    return url


def generate_download_url(key: str, expires_in: int = 604800) -> str:
    """Presigned GET URL."""
    _validate_key(key)
    s3 = get_client()
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": _bucket(), "Key": key},
        ExpiresIn=expires_in,
    )
    return url


def delete_object(key: str) -> None:
    """Delete a single object. Logs warning on error but does not raise."""
    try:
        _validate_key(key)
        s3 = get_client()
        s3.delete_object(Bucket=_bucket(), Key=key)
    except Exception as e:
        logger.warning("S3 delete_object failed for %s: %s", key, e)


def delete_session_objects(session_id: str, extra_prefixes: list[str] | None = None) -> int:
    """Delete all objects under sessions/{session_id}/ and any extra_prefixes. Returns count deleted."""
    from botocore.exceptions import BotoCoreError, ClientError
    s3 = get_client()
    bucket = _bucket()
    prefixes = [f"sessions/{session_id}/"] + (extra_prefixes or [])
    deleted = 0
    try:
        paginator = s3.get_paginator("list_objects_v2")
        to_delete = []
        seen = set()
        for prefix in prefixes:
            for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    if key not in seen:
                        seen.add(key)
                        to_delete.append({"Key": key})
        for i in range(0, len(to_delete), 1000):
            resp = s3.delete_objects(
                Bucket=bucket,
                Delete={"Objects": to_delete[i:i+1000], "Quiet": True},
            )
            deleted += len(to_delete[i:i+1000]) - len(resp.get("Errors", []))
            for err in resp.get("Errors", []):
                logger.warning("S3 delete_objects error: key=%s code=%s message=%s", err.get("Key"), err.get("Code"), err.get("Message"))
        logger.info("S3 deleted %d objects under %s", deleted, prefixes)
    except (BotoCoreError, ClientError) as e:
        logger.warning("S3 delete_session_objects failed for %s: %s", session_id, e)
    return deleted


def list_session_objects(
    session_id: str,
    extra_keys: list[str] | None = None,
    extra_prefixes: list[str] | None = None,
) -> list[dict]:
    """List objects for a session.

    Searches the canonical sessions/{session_id}/ prefix, plus any extra_prefixes
    (e.g. the cloudsync upload path). If all prefix searches yield nothing and
    extra_keys are provided, falls back to head_object lookups on those keys.
    """
    canonical_prefix = f"sessions/{session_id}/"
    manifest_key = f"{canonical_prefix}manifest.json"
    s3 = get_client()
    bucket = _bucket()
    objects = []
    seen_keys: set[str] = set()

    prefixes = [canonical_prefix] + (extra_prefixes or [])
    paginator = s3.get_paginator("list_objects_v2")
    for prefix in prefixes:
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key == manifest_key or key in seen_keys:
                    continue
                seen_keys.add(key)
                last_modified: datetime = obj["LastModified"]
                objects.append({
                    "key": key,
                    "size_bytes": obj["Size"],
                    "last_modified": last_modified.astimezone(timezone.utc).isoformat(),
                })

    if not objects and extra_keys:
        from botocore.exceptions import ClientError
        for key in extra_keys:
            if key == manifest_key or key in seen_keys:
                continue
            seen_keys.add(key)
            try:
                head = s3.head_object(Bucket=bucket, Key=key)
                objects.append({
                    "key": key,
                    "size_bytes": head["ContentLength"],
                    "last_modified": head["LastModified"].astimezone(timezone.utc).isoformat(),
                })
            except ClientError:
                logger.warning("s3 head_object: key not found: %s", key)

    return objects


_CONTENT_TYPES = {
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".txt": "text/plain",
    ".otio": "application/json",
    ".fcpxml": "application/xml",
    ".rpp": "text/plain",
}


def upload_file(key: str, local_path) -> int:
    """Server-side upload of a local file to the editor bucket. Returns size in bytes."""
    from pathlib import Path as _Path
    p = _Path(local_path)
    _validate_key(key)
    content_type = _CONTENT_TYPES.get(p.suffix.lower(), "application/octet-stream")
    client = get_client()
    client.upload_file(str(p), _bucket(), key, ExtraArgs={"ContentType": content_type})
    return p.stat().st_size


def put_object(key: str, body: str | bytes, content_type: str = "application/json") -> None:
    """Write a small object directly (used for manifest.json)."""
    _validate_key(key)
    s3 = get_client()
    if isinstance(body, str):
        body = body.encode()
    s3.put_object(
        Bucket=_bucket(),
        Key=key,
        Body=body,
        ContentType=content_type,
    )
