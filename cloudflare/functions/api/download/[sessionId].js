// Cloudflare Pages Function: streams a single R2 object for an editor's
// per-file "Download" link.
//
// Editor-uploaded production files (functions/api/upload/[sessionId].js)
// have no S3-compatible presigned URL available at the edge — that requires
// the PodBooth backend's S3 credentials (app/s3.py's generate_download_url),
// and the editor upload path deliberately never touches the backend (see
// the note at the top of functions/api/upload/[sessionId].js). So the
// manifest entry the upload Function writes for a new production file
// points its download_url at this endpoint instead, which streams the
// object straight from the R2 binding the same way the ZIP endpoint does.
//
// Route: GET /api/download/{sessionId}?token=...&key=<r2 object key>
//
// R2 binding "R2_BUCKET" must be configured in the Pages dashboard (same
// binding used by functions/api/zip/[sessionId].js and
// functions/api/upload/[sessionId].js).

async function sha256Hex(str) {
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function err(status, msg) {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain' } });
}

export async function onRequestGet({ request, env, params }) {
  const sessionId = params.sessionId;
  const url       = new URL(request.url);
  const token     = url.searchParams.get('token') || '';
  const key       = url.searchParams.get('key') || '';

  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return err(400, 'Invalid token format');
  if (!key) return err(400, 'Missing key');

  const manifestObj = await env.R2_BUCKET.get(`sessions/${sessionId}/manifest.json`);
  if (!manifestObj) return err(404, 'Session not found');

  let manifest;
  try { manifest = await manifestObj.json(); } catch { return err(500, 'Corrupt manifest'); }

  if ((await sha256Hex(token)) !== manifest.editor_token_hash) return err(403, 'Access denied');
  if (manifest.expires_at && new Date(manifest.expires_at) < new Date()) return err(410, 'Link expired');

  // Only ever serve a key that's actually listed in this session's manifest
  // — the token only proves the holder can see this session's file list,
  // not that they can read arbitrary objects out of the bucket.
  const file = (manifest.files || []).find(f => f.key === key);
  if (!file) return err(404, 'File not in this session');

  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return err(404, 'File not found in storage');

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Disposition', `attachment; filename="${(file.filename || key.split('/').pop()).replace(/"/g, '')}"`);
  headers.set('Content-Length', String(obj.size));

  return new Response(obj.body, { headers });
}
