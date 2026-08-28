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
//
// On the first successful upload in a batch, fires a Discord notification via
// DISCORD_UPLOAD_WEBHOOK_URL (a Pages secret, separate from PodBooth's own
// DISCORD_WEBHOOK_URL so uploads can post to a different channel) — see
// functions/_discord.js and shouldNotify() below for the batching.

import { notifyEditorUpload } from '../../_discord.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
// Keep in sync with FOLDER_LABELS in functions/_discord.js and knownSources
// in index.html — a folder added here needs the same addition in both, or
// its files silently land in index.html's "other" bucket / show an
// unlabeled Discord notification.
const ALLOWED_FOLDERS  = new Set(['full', 'speakers', 'video']);
// Workers are stateless per-request, so there's no cheap way to track a
// multipart upload's running total across separate 'part' calls. Instead,
// bound the worst case indirectly: cap each part's size and cap the part
// count so count * per-part cap can't exceed MAX_UPLOAD_BYTES — otherwise a
// client could drive an unbounded number of large parts through 'action=part'
// (the single-request path below is the only one MAX_UPLOAD_BYTES itself
// actually gates).
const PART_MAX_BYTES   = 64 * 1024 * 1024; // 64 MB — matches the app server's own multipart part size
const MAX_PARTS        = Math.ceil(MAX_UPLOAD_BYTES / PART_MAX_BYTES); // 80

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

// One Discord message per upload "batch" instead of one per file: an editor
// dropping several production files in close succession (full mix + speaker
// tracks + video) would otherwise fire a separate notification per file. A
// small R2 marker object stands in for state that a per-request Worker can't
// hold itself — R2 was already bound here, so this needs no new binding.
// The first upload in a batch notifies (linking to the production folder,
// not any single file) and stamps the marker; later uploads within
// NOTIFY_WINDOW_MS of it are assumed to belong to the same batch and stay
// quiet. A new notification fires again once the window lapses.
//
// Two uploads landing at nearly the same instant can both read "no recent
// marker" before either writes one, producing two notifications instead of
// one — acceptable here since this is a convenience digest, not something
// that needs to be exactly-once.
const NOTIFY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

async function shouldNotify(env, sessionId) {
  const markerKey = `sessions/${sessionId}/.production_notify_marker`;
  const marker = await env.R2_BUCKET.get(markerKey);
  if (marker && Date.now() - marker.uploaded.getTime() < NOTIFY_WINDOW_MS) {
    return false;
  }
  await env.R2_BUCKET.put(markerKey, String(Date.now()));
  return true;
}

export async function onRequestPost({ request, env, params, waitUntil }) {
  const sessionId = params.sessionId;
  const url       = new URL(request.url);
  const token     = url.searchParams.get('token') || '';
  const folder    = url.searchParams.get('folder') || '';
  const action    = url.searchParams.get('action') || '';

  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return err(400, 'Invalid token format');
  if (!ALLOWED_FOLDERS.has(folder)) return err(400, 'folder must be "full", "speakers", or "video"');

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
      const contentLength = parseInt(request.headers.get('content-length') || '', 10);
      if (!Number.isInteger(contentLength) || contentLength > PART_MAX_BYTES) {
        return err(413, `Part too large (max ${PART_MAX_BYTES} bytes)`);
      }
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
      let obj;
      try {
        obj = await upload.complete(parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })));
      } catch (e) {
        return err(400, `Complete failed: ${e.message}`);
      }
      // Outside the try/catch above: the upload itself already succeeded, so a
      // problem building/dispatching the notification must not be reported to
      // the client as a failed upload.
      waitUntil((async () => {
        if (await shouldNotify(env, sessionId)) {
          await notifyEditorUpload({
            webhookUrl: env.DISCORD_UPLOAD_WEBHOOK_URL,
            origin: url.origin,
            sessionId, token,
            title: manifest.title, episode: manifest.episode,
            folder, filename, sizeBytes: obj.size,
          });
        }
      })());
      return json({ ok: true, key, filename, size_bytes: obj.size });
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

  waitUntil((async () => {
    if (await shouldNotify(env, sessionId)) {
      await notifyEditorUpload({
        webhookUrl: env.DISCORD_UPLOAD_WEBHOOK_URL,
        origin: url.origin,
        sessionId, token,
        title: manifest.title, episode: manifest.episode,
        folder, filename, sizeBytes: file.size,
      });
    }
  })());

  return new Response(JSON.stringify({
    ok: true,
    key,
    filename,
    size_bytes: file.size,
  }), { headers: { 'Content-Type': 'application/json' } });
}
