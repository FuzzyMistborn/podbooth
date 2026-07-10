// Cloudflare Pages Function: lets an editor upload a finished file back into R2,
// under the session's production folder, so the host can pull it into the show.
//
// Cloudflare's edge caps request bodies at ~100 MB, so large files are uploaded
// as an R2 multipart upload driven by the client:
//   POST /api/upload/{sessionId}?token=...&folder=...                          — small file, multipart/form-data "file" field
//   POST ...&action=create&filename=<name>                                     — start multipart upload → { key, uploadId }
//   POST ...&action=part&filename=<name>&uploadId=<id>&partNumber=<n>          — raw chunk body → { partNumber, etag }
//   POST ...&action=complete&filename=<name>&uploadId=<id>                     — JSON body { parts: [{partNumber, etag}] }
//   POST ...&action=abort&filename=<name>&uploadId=<id>                        — cancel and discard uploaded parts
//
// The destination prefix (manifest.production_prefix) is set server-side by the
// PodBooth backend when the manifest is built, so it matches wherever the
// session's original recordings live (e.g. "PodBooth/1/production").
//
// R2 binding "R2_BUCKET" must be configured in the Pages dashboard (same binding
// used by functions/api/zip/[sessionId].js).

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const ALLOWED_FOLDERS  = new Set(['full', 'speakers']);
const MAX_PARTS        = 1000;

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

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ request, env, params }) {
  const sessionId = params.sessionId;
  const url       = new URL(request.url);
  const token     = url.searchParams.get('token') || '';
  const folder    = url.searchParams.get('folder') || '';
  const action    = url.searchParams.get('action') || '';

  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return err(400, 'Invalid token format');
  if (!ALLOWED_FOLDERS.has(folder)) return err(400, 'folder must be "full" or "speakers"');

  const manifestKey  = `sessions/${sessionId}/manifest.json`;
  const manifestObj = await env.R2_BUCKET.get(manifestKey);
  if (!manifestObj) return err(404, 'Session not found');

  let manifest;
  try { manifest = await manifestObj.json(); } catch { return err(500, 'Corrupt manifest'); }

  if ((await sha256Hex(token)) !== manifest.editor_token_hash) return err(403, 'Access denied');
  if (manifest.expires_at && new Date(manifest.expires_at) < new Date()) return err(410, 'Link expired');

  const productionPrefix = String(manifest.production_prefix || '').replace(/^\/+|\/+$/g, '');
  if (!productionPrefix) return err(500, 'Session has no production_prefix configured');

  // ── Multipart (chunked) upload actions ──
  // The object key is always derived server-side from the validated folder and
  // filename, so the client can never write outside the production prefix.
  if (action) {
    const filename = safeFilename(url.searchParams.get('filename'));
    if (!filename) return err(400, 'Invalid filename');
    const key = `${productionPrefix}/${folder}/${filename}`;

    if (action === 'create') {
      const contentType = url.searchParams.get('contentType') || 'application/octet-stream';
      const upload = await env.R2_BUCKET.createMultipartUpload(key, {
        httpMetadata: { contentType },
      });
      return json({ key, uploadId: upload.uploadId });
    }

    const uploadId = url.searchParams.get('uploadId') || '';
    if (!uploadId) return err(400, 'Missing uploadId');
    const upload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);

    if (action === 'part') {
      const partNumber = parseInt(url.searchParams.get('partNumber'), 10);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
        return err(400, 'Invalid partNumber');
      }
      if (!request.body) return err(400, 'Missing part body');
      try {
        const part = await upload.uploadPart(partNumber, request.body);
        return json({ partNumber: part.partNumber, etag: part.etag });
      } catch (e) {
        return err(400, `Part upload failed: ${e.message}`);
      }
    }

    if (action === 'complete') {
      let body;
      try { body = await request.json(); } catch { return err(400, 'Expected JSON body'); }
      const parts = Array.isArray(body && body.parts) ? body.parts : null;
      if (!parts || parts.length === 0 || parts.length > MAX_PARTS ||
          !parts.every(p => Number.isInteger(p.partNumber) && typeof p.etag === 'string')) {
        return err(400, 'Invalid parts list');
      }
      try {
        const obj = await upload.complete(parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })));
        return json({ ok: true, key, filename, size_bytes: obj.size });
      } catch (e) {
        return err(400, `Complete failed: ${e.message}`);
      }
    }

    if (action === 'abort') {
      try { await upload.abort(); } catch {}
      return json({ ok: true });
    }

    return err(400, 'Unknown action');
  }

  // ── Legacy single-request upload (small files only; Cloudflare rejects
  // request bodies over ~100 MB at the edge before this code runs) ──
  let form;
  try { form = await request.formData(); } catch { return err(400, 'Expected multipart/form-data'); }

  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return err(400, 'Missing file field');
  if (file.size > MAX_UPLOAD_BYTES) return err(413, 'File too large (max 5 GB)');

  const filename = safeFilename(file.name);
  if (!filename) return err(400, 'Invalid filename');

  const key = `${productionPrefix}/${folder}/${filename}`;

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
