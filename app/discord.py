import logging
from datetime import datetime

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_VALID_PREFIXES = (
    "https://discord.com/api/webhooks/",
    "https://discordapp.com/api/webhooks/",
)

_EMBED_COLOR = 16737792  # #FF6B00


def _format_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} PB"


def _format_expiry(iso: str) -> str:
    try:
        dt = datetime.fromisoformat(iso)
        return dt.strftime("%B %-d, %Y")
    except Exception:
        return iso


async def notify_editor_link(
    *,
    session_id: str,
    title: str,
    episode: str,
    editor_url: str,
    file_count: int,
    expires_at: str,
    total_bytes: int = 0,
) -> None:
    """Fire a Discord webhook when an editor link is generated. Never raises."""
    if not settings.discord_webhook_url:
        return

    if not any(settings.discord_webhook_url.startswith(p) for p in _VALID_PREFIXES):
        logger.warning(
            "DISCORD_WEBHOOK_URL does not look like a Discord webhook URL — skipping notification"
        )
        return

    embed_title = "📁 Editor files ready"
    if episode:
        embed_title += f" — Episode {episode}"
    elif title:
        embed_title += f" — {title}"

    fields = []
    if episode:
        fields.append({"name": "Episode", "value": episode, "inline": True})
    fields.append({"name": "Files", "value": f"{file_count} file{'s' if file_count != 1 else ''}", "inline": True})
    if total_bytes > 0:
        fields.append({"name": "Size", "value": _format_bytes(total_bytes), "inline": True})
    fields.append({"name": "Download link", "value": editor_url})
    fields.append({"name": "Expires", "value": _format_expiry(expires_at), "inline": True})

    payload = {
        "embeds": [{
            "title": embed_title,
            "description": "The editor download link has been generated.",
            "url": editor_url,
            "color": _EMBED_COLOR,
            "fields": fields,
            "footer": {"text": "BitFlip · Podbooth"},
        }]
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(settings.discord_webhook_url, json=payload)
        if r.status_code not in (200, 204):
            logger.warning(
                "Discord webhook returned HTTP %d: %s",
                r.status_code,
                r.text[:200],
            )
    except Exception as e:
        logger.warning("Discord webhook failed: %s", e)
