// Cloudflare Pages Function: streams a ZIP64 archive of session files from R2.
// Route: GET /api/zip/{sessionId}?token=...&source=<optional>
//
// R2 binding "R2_BUCKET" must be configured in the Pages dashboard:
//   Settings → Functions → R2 bucket bindings → add "R2_BUCKET"

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
function u64(dv, off, v) {
  dv.setUint32(off,     v >>> 0,                          true);
  dv.setUint32(off + 4, Math.floor(v / 0x100000000) >>> 0, true);
}

// ── ZIP64 record builders ─────────────────────────────────────────────────────

function localHeader(nameBytes) {
  const buf = new Uint8Array(30 + nameBytes.length + 20);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x04034b50);
  u16(dv,  4, 45);
  u16(dv,  6, 0x0008);             // data descriptor flag
  u16(dv,  8, 0);                  // store
  u16(dv, 10, 0); u16(dv, 12, 0);
  u32(dv, 14, 0);                  // CRC deferred
  u32(dv, 18, 0xFFFFFFFF);         // compressed size → ZIP64
  u32(dv, 22, 0xFFFFFFFF);         // uncompressed size → ZIP64
  u16(dv, 26, nameBytes.length);
  u16(dv, 28, 20);                 // extra field length
  buf.set(nameBytes, 30);          // filename
  const x = 30 + nameBytes.length; // extra field offset
  u16(dv, x,     0x0001);          // ZIP64 tag
  u16(dv, x + 2, 16);
  u64(dv, x + 4, 0);               // original size deferred
  u64(dv, x + 12, 0);              // compressed size deferred
  return buf;
}

function dataDescriptor(crc, size) {
  const buf = new Uint8Array(24);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x08074b50);
  u32(dv,  4, crc);
  u64(dv,  8, size);
  u64(dv, 16, size);
  return buf;
}

function centralDirEntry({ nameBytes, crc, size, headerOffset }) {
  const buf = new Uint8Array(46 + nameBytes.length + 32);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x02014b50);
  u16(dv,  4, 45); u16(dv, 6, 45);
  u16(dv,  8, 0x0008);
  u16(dv, 10, 0);
  u16(dv, 12, 0); u16(dv, 14, 0);
  u32(dv, 16, crc);
  u32(dv, 20, 0xFFFFFFFF);
  u32(dv, 24, 0xFFFFFFFF);
  u16(dv, 28, nameBytes.length);
  u16(dv, 30, 32);
  u16(dv, 32, 0); u16(dv, 34, 0); u16(dv, 36, 0);
  u32(dv, 38, 0);
  u32(dv, 42, 0xFFFFFFFF);
  buf.set(nameBytes, 46);          // filename
  const x = 46 + nameBytes.length; // extra field offset
  u16(dv, x,      0x0001);
  u16(dv, x +  2, 28);
  u64(dv, x +  4, size);
  u64(dv, x + 12, size);
  u64(dv, x + 20, headerOffset);
  return buf;
}

function zip64EocdRecord(count, cdSize, cdOffset) {
  const buf = new Uint8Array(56);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x06064b50);
  u64(dv,  4, 44);
  u16(dv, 12, 45); u16(dv, 14, 45);
  u32(dv, 16, 0); u32(dv, 20, 0);
  u64(dv, 24, count);
  u64(dv, 32, count);
  u64(dv, 40, cdSize);
  u64(dv, 48, cdOffset);
  return buf;
}

function zip64EocdLocator(zip64EocdOffset) {
  const buf = new Uint8Array(20);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x07064b50);
  u32(dv,  4, 0);
  u64(dv,  8, zip64EocdOffset);
  u32(dv, 16, 1);
  return buf;
}

function endOfCentralDir() {
  const buf = new Uint8Array(22);
  const dv  = new DataView(buf.buffer);
  u32(dv,  0, 0x06054b50);
  u16(dv,  4, 0xFFFF); u16(dv, 6, 0xFFFF);
  u16(dv,  8, 0xFFFF); u16(dv, 10, 0xFFFF);
  u32(dv, 12, 0xFFFFFFFF);
  u32(dv, 16, 0xFFFFFFFF);
  u16(dv, 20, 0);
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

function archivePath(key, sessionId, fallback) {
  const prefix = `sessions/${sessionId}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : fallback;
}

function err(status, msg) {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain' } });
}

// ── Request handler ───────────────────────────────────────────────────────────

export async function onRequestGet({ request, env, params }) {
  const sessionId    = params.sessionId;
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

  async function* generateZip() {
    const central = [];
    let offset    = 0;

    for (const file of files) {
      const obj = await env.R2_BUCKET.get(file.key);
      if (!obj) continue;

      const name         = archivePath(file.key, sessionId, file.filename);
      const nameBytes    = enc.encode(name);
      const headerOffset = offset;

      const hdr = localHeader(nameBytes);
      yield hdr;
      offset += hdr.length;

      let crcState = crcInit();
      let size     = 0;

      const reader = obj.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crcState = crcUpdate(crcState, value);
        size    += value.length;
        yield value;
        offset  += value.length;
      }

      const crc  = crcFinal(crcState);
      const desc = dataDescriptor(crc, size);
      yield desc;
      offset += desc.length;

      central.push({ nameBytes, crc, size, headerOffset });
    }

    const cdStart = offset;
    for (const entry of central) {
      const cde = centralDirEntry(entry);
      yield cde;
      offset += cde.length;
    }
    const cdSize = offset - cdStart;

    const z64Rec = zip64EocdRecord(central.length, cdSize, cdStart);
    const z64RecOffset = offset;
    yield z64Rec;
    offset += z64Rec.length;

    yield zip64EocdLocator(z64RecOffset);
    offset += 20;

    yield endOfCentralDir();
  }

  const stream = ReadableStream.from(generateZip());

  return new Response(stream, {
    headers: {
      'Content-Type':        'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
    },
  });
}
