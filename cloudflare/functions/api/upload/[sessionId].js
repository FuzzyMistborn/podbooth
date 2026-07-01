// Cloudflare Pages Function: lets an editor upload a finished file back into R2
// under sessions/{sessionId}/production/, so the host can pull it into the show.
// Route: POST /api/upload/{sessionId}?token=...
// Body: multipart/form-data with a single "file" field.
//
// R2 binding "R2_BUCKET" must be configured in the Pages dashboard (same binding
// used by functions/api/zip/[sessionId].js).

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

async function sha256Hex(str) {
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return /^[A-Za-z0-9._\- ]{1,255}$/.test(base) ? base : null;
}

function err(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ request, env, params }) {
  const sessionId = params.sessionId;
  const url       = new URL(request.url);
  const token     = url.searchParams.get('token') || '';

  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return err(400, 'Invalid token format');

  const manifestKey  = `sessions/${sessionId}/manifest.json`;
  const manifestObj = await env.R2_BUCKET.get(manifestKey);
  if (!manifestObj) return err(404, 'Session not found');

  let manifest;
  try { manifest = await manifestObj.json(); } catch { return err(500, 'Corrupt manifest'); }

  if ((await sha256Hex(token)) !== manifest.editor_token_hash) return err(403, 'Access denied');
  if (manifest.expires_at && new Date(manifest.expires_at) < new Date()) return err(410, 'Link expired');

  let form;
  try { form = await request.formData(); } catch { return err(400, 'Expected multipart/form-data'); }

  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return err(400, 'Missing file field');
  if (file.size > MAX_UPLOAD_BYTES) return err(413, 'File too large (max 5 GB)');

  const filename = safeFilename(file.name);
  if (!filename) return err(400, 'Invalid filename');

  const key = `sessions/${sessionId}/production/${filename}`;

  await env.R2_BUCKET.put(key, file, {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  return new Response(JSON.stringify({
    ok: true,
    key,
    filename,
    size_bytes: file.size,
  }), { headers: { 'Content-Type': 'application/json' } });
}
