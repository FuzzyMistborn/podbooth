// Shared Discord webhook helper for editor-portal Pages Functions.
//
// Leading underscore keeps this out of Cloudflare Pages' file-based routing —
// it's a plain module, not a route.
//
// Mirrors app/discord.py's notify_editor_link on the PodBooth server: same
// webhook-URL validation, same embed shape, same "never throws" contract.
// This one fires from the edge (not the PodBooth server) because the editor's
// upload never touches the PodBooth backend — bytes go straight into R2 via
// the Pages Function. It intentionally reads a *different* env var
// (DISCORD_UPLOAD_WEBHOOK_URL) than PodBooth's DISCORD_WEBHOOK_URL, so
// upload notifications can go to a separate Discord channel.

const VALID_PREFIXES = [
  'https://discord.com/api/webhooks/',
  'https://discordapp.com/api/webhooks/',
];

const EMBED_COLOR = 16737792; // #FF6B00 — matches app/discord.py

// Keep in sync with ALLOWED_FOLDERS in functions/api/upload/[sessionId].js
// and knownSources in index.html.
const FOLDER_LABELS = {
  full: 'Full Mix',
  speakers: 'Speaker Tracks',
  video: 'Video',
};

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

// Fire a Discord webhook when an editor starts uploading production files.
// Only called once per upload "batch" (see the marker check in
// functions/api/upload/[sessionId].js) — the link points at the session's
// production folder rather than any single file, since by the time someone
// clicks it there may be several files there from the same batch. Never throws.
export async function notifyEditorUpload({
  webhookUrl,
  origin,
  sessionId,
  token,
  title,
  episode,
  folder,
  filename,
  sizeBytes,
}) {
  if (!webhookUrl) return;

  if (!VALID_PREFIXES.some((p) => webhookUrl.startsWith(p))) {
    console.warn('DISCORD_UPLOAD_WEBHOOK_URL does not look like a Discord webhook URL — skipping notification');
    return;
  }

  const editorUrl = `${origin}/session/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}#group-production`;
  const folderLabel = FOLDER_LABELS[folder] || folder;

  let embedTitle = '📤 Production files uploading';
  if (episode) embedTitle += ` — Episode ${episode}`;
  else if (title) embedTitle += ` — ${title}`;

  const fields = [];
  if (episode) fields.push({ name: 'Episode', value: episode, inline: true });
  fields.push({ name: 'Category', value: folderLabel, inline: true });
  if (typeof sizeBytes === 'number' && sizeBytes > 0) {
    fields.push({ name: 'Size', value: formatBytes(sizeBytes), inline: true });
  }
  fields.push({ name: 'First file', value: filename });
  fields.push({ name: 'Production folder', value: editorUrl });

  const payload = {
    embeds: [{
      title: embedTitle,
      description: 'An editor started uploading production files. More files may still be in progress — check the folder for the full set.',
      url: editorUrl,
      color: EMBED_COLOR,
      fields,
      footer: { text: 'BitFlip · Podbooth' },
    }],
  };

  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.status !== 200 && r.status !== 204) {
      console.warn(`Discord webhook returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`Discord webhook failed: ${e && e.message}`);
  }
}
