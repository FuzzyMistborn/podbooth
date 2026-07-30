"""Small helpers shared across routers (previously duplicated in each)."""

import secrets


def _safe_name(value: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in "- " else "_" for c in value).strip()
    return cleaned[:100]


def _parse_take(stem: str, ftype: str) -> int | None:
    """Extract take number from a slug-based filename stem, e.g. Alice_1 → 1, Alice_1_video → 1."""
    try:
        base = stem
        if ftype in ("video", "screen"):
            suffix = f"_{ftype}"
            if stem.endswith(suffix):
                base = stem[: -len(suffix)]
            else:
                return None
        parts = base.rsplit("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            return int(parts[1])
    except Exception:
        pass
    return None


def _is_host(host_token, session) -> bool:
    if not isinstance(host_token, str) or not host_token:
        return False
    return secrets.compare_digest(host_token, session.host_token)


def _take_sort_key(filename: str):
    """Sort key for take-numbered filenames (Alice_2.wav, Alice_10.wav, ...) that
    orders by the trailing take number numerically instead of lexicographically."""
    stem = filename.rsplit(".", 1)[0]
    for ftype in ("video", "screen"):
        suffix = f"_{ftype}"
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    parts = stem.rsplit("_", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return (parts[0], int(parts[1]))
    return (stem, -1)
