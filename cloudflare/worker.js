// Cloudflare Worker: streams a ZIP64 archive of session files directly from R2.
// Handles GET /api/zip/{sessionId}?token=...&source=<optional>
// All other requests fall through to the static assets (index.html).
//
// ZIP64 is used throughout so there are no per-file or archive size limits.

// ── CRC-32 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crcInit()         { return 0xFFFFFFFF; }
function crcUpdate(s, buf) { let c = s; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return c; }
function crcFinal(s)       { return (s ^ 0xFFFFFFFF) >>> 0; }

// ── DataView write helpers ────────────────────────────────────────────────────

function u16(dv, off, v) { dv.setUint16(off, v, true); }
function u32(dv, off, v) { dv.setUint32(off, v, true); }

// Write a 64-bit unsigned integer as two 32-bit halves (little-endian).
// Safe for values up to Number.MAX_SAFE_INTEGER (~8 PB), well beyond any
// real session size.
function u64(dv, off, v) {
  dv.setUint32(off,     v >>> 0,                        true);
  dv.setUint32(off + 4, Math.floor(v / 0x100000000) >>> 0, true);
}

// ── ZIP64 record builders ─────────────────────────────────────────────────────

// Local file header.
// Sizes are deferred to the data descriptor (bit 3 flag), so the ZIP64 extra
// field carries zeros here — but its presence signals to unzippers that
// this is a ZIP64 entry and that the data descriptor uses 8-byte fields.
function localHeader(nameBytes) {
  // 30 bytes fixed + 20 bytes ZIP64 extra field + filename
  const buf = new Uint8Array(30 + 20 + nameBytes.length);
  const dv  = new DataView(buf.buffer);

  u32(dv,  0, 0x04034b50);        // local file signature
  u16(dv,  4, 45);                // version needed: 4.5 (ZIP64)
  u16(dv,  6, 0x0008);            // flags: data descriptor present
  u16(dv,  8, 0);                 // compression: store
  u16(dv, 10, 0); u16(dv, 12, 0); // mod time / mod date
  u32(dv, 14, 0);                 // CRC-32 (deferred)
  u32(dv, 18, 0xFFFFFFFF);        // compressed size  → ZIP64
  u32(dv, 22, 0xFFFFFFFF);        // uncompressed size → ZIP64
  u16(dv, 26, nameBytes.length);
  u16(dv, 28, 20);                // extra field length: 20 bytes

  // ZIP64 extra field
  u16(dv, 30, 0x0001);            // tag
  u16(dv, 32, 16);                // data size (two 8-byte fields)
  u64(dv, 34, 0);                 // original size  (deferred)
  u64(dv, 42, 0);                 // compressed size (deferred)

  buf.set(nameBytes, 50);
  return buf;
}

// Data descriptor written after each file's data.
// Uses 8-byte size fields (ZIP64 variant).
function dataDescriptor(crc, size) {
  const buf = new Uint8Array(24);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x08074b50); // signature
  u32(dv,  4, crc);
  u64(dv,  8, size);        // compressed size
  u64(dv, 16, size);        // uncompressed size (same as compressed: store mode)
  return buf;
}

// Central directory entry for one file.
function centralDirEntry({ nameBytes, crc, size, headerOffset }) {
  // 46 bytes fixed + 32 bytes ZIP64 extra field + filename
  const buf = new Uint8Array(46 + 32 + nameBytes.length);
  const dv  = new DataView(buf.buffer);

  u32(dv,  0, 0x02014b50);        // central dir sig
  u16(dv,  4, 45);                // version made by
  u16(dv,  6, 45);                // version needed
  u16(dv,  8, 0x0008);            // flags
  u16(dv, 10, 0);                 // compression: store
  u16(dv, 12, 0); u16(dv, 14, 0); // mod time / date
  u32(dv, 16, crc);
  u32(dv, 20, 0xFFFFFFFF);        // compressed size  → ZIP64
  u32(dv, 24, 0xFFFFFFFF);        // uncompressed size → ZIP64
  u16(dv, 28, nameBytes.length);
  u16(dv, 30, 32);                // extra field length: 32 bytes
  u16(dv, 32, 0);                 // comment length
  u16(dv, 34, 0);                 // disk number start
  u16(dv, 36, 0);                 // internal attrs
  u32(dv, 38, 0);                 // external attrs
  u32(dv, 42, 0xFFFFFFFF);        // local header offset → ZIP64

  // ZIP64 extra field
  u16(dv, 46, 0x0001);            // tag
  u16(dv, 48, 28);                // data size (three 8-byte fields)
  u64(dv, 50, size);              // original size
  u64(dv, 58, size);              // compressed size
  u64(dv, 66, headerOffset);      // local header offset

  buf.set(nameBytes, 78);
  return buf;
}

// ZIP64 end of central directory record.
function zip64EocdRecord(count, cdSize, cdOffset) {
  const buf = new Uint8Array(56);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x06064b50);  // ZIP64 EOCD sig
  u64(dv,  4, 44);          // size of this record after this field (fixed: 44)
  u16(dv, 12, 45);          // version made by
  u16(dv, 14, 45);          // version needed
  u32(dv, 16, 0);           // disk number
  u32(dv, 20, 0);           // disk with CD start
  u64(dv, 24, count);       // entries on this disk
  u64(dv, 32, count);       // total entries
  u64(dv, 40, cdSize);      // central dir size
  u64(dv, 48, cdOffset);    // central dir offset
  return buf;
}

// ZIP64 end of central directory locator.
function zip64EocdLocator(zip64EocdOffset) {
  const buf = new Uint8Array(20);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x07064b50);      // locator sig
  u32(dv,  4, 0);               // disk with ZIP64 EOCD
  u64(dv,  8, zip64EocdOffset); // offset of ZIP64 EOCD record
  u32(dv, 16, 1);               // total disks
  return buf;
}

// Standard EOCD — required even with ZIP64; sentinel values point to ZIP64 records.
function endOfCentralDir() {
  const buf = new Uint8Array(22);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x06054b50);
  u16(dv,  4, 0xFFFF);     // disk number (ZIP64 sentinel)
  u16(dv,  6, 0xFFFF);     // start disk  (ZIP64 sentinel)
  u16(dv,  8, 0xFFFF);     // entries on disk (ZIP64 sentinel)
  u16(dv, 10, 0xFFFF);     // total entries   (ZIP64 sentinel)
  u32(dv, 12, 0xFFFFFFFF); // CD size   (ZIP64 sentinel)
  u32(dv, 16, 0xFFFFFFFF); // CD offset (ZIP64 sentinel)
  u16(dv, 20, 0);          // comment length
  return buf;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sha256Hex(str) {
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeFilename(str) {
  return (str || 'session').replace(/[^\w\s\-]/g, '_').trim().replace(/\s+/g, '_');
}

// Strip sessions/{id}/ prefix so archive paths are relative and meaningful.
//   sessions/{id}/Alice/recording.wav  →  Alice/recording.wav
//   sessions/{id}/exports/show.otio    →  exports/show.otio
function archivePath(key, sessionId, fallback) {
  const prefix = `sessions/${sessionId}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : fallback;
}

function err(status, msg) {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain' } });
}

// ── ZIP stream handler ────────────────────────────────────────────────────────

async function handleZip(request, env, sessionId) {
  const url          = new URL(request.url);
  const token        = url.searchParams.get('token') || '';
  const sourceFilter = url.searchParams.get('source') || null;

  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return err(400, 'Invalid token format');

  const manifestObj = await env.R2_BUCKET.get(`sessions/${sessionId}/manifest.json`);
  if (!manifestObj) return err(404, 'Session not found');

  let manifest;
  try { manifest = await manifestObj.json(); } catch { return err(500, 'Corrupt manifest'); }

  if ((await sha256Hex(token)) !== manifest.editor_token_hash) return err(403, 'Access denied');
  if (manifest.expires_at && new Date(manifest.expires_at) < new Date()) return err(410, 'Link expired');

  let files = (manifest.files || []).filter(f => f.key && f.filename);
  if (sourceFilter) files = files.filter(f => f.source === sourceFilter);
  if (files.length === 0) return err(404, 'No files for this selection');

  const zipName = safeFilename(manifest.title) + '.zip';
  const enc     = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const central = [];
      let offset    = 0;

      for (const file of files) {
        const obj = await env.R2_BUCKET.get(file.key);
        if (!obj) continue;

        const name         = archivePath(file.key, sessionId, file.filename);
        const nameBytes    = enc.encode(name);
        const headerOffset = offset;

        const hdr = localHeader(nameBytes);
        controller.enqueue(hdr);
        offset += hdr.length;

        let crcState = crcInit();
        let size     = 0;

        const reader = obj.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crcState = crcUpdate(crcState, value);
          size    += value.length;
          controller.enqueue(value);
          offset  += value.length;
        }

        const crc  = crcFinal(crcState);
        const desc = dataDescriptor(crc, size);
        controller.enqueue(desc);
        offset += desc.length;

        central.push({ nameBytes, crc, size, headerOffset });
      }

      const cdStart = offset;
      for (const entry of central) {
        const cde = centralDirEntry(entry);
        controller.enqueue(cde);
        offset += cde.length;
      }
      const cdSize = offset - cdStart;

      const z64Rec = zip64EocdRecord(central.length, cdSize, cdStart);
      controller.enqueue(z64Rec);
      const z64RecOffset = offset;
      offset += z64Rec.length;

      controller.enqueue(zip64EocdLocator(z64RecOffset));
      offset += 20;

      controller.enqueue(endOfCentralDir());
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':        'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
    },
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m   = url.pathname.match(/^\/api\/zip\/([A-Za-z0-9_-]+)$/);
    if (m) return handleZip(request, env, m[1]);
    return env.ASSETS.fetch(request);
  },
};
