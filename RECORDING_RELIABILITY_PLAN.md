# Recording/upload reliability plan

Status snapshot as of 2026-07-02. Tracks the improvements identified for the
local recording → chunk upload → server assembly pipeline, what's shipped,
and what's next.

## Done

- **Finalize retry** (`app/static/js/upload.js`) — `/api/upload/finalize` is
  now retried with the same backoff/budget shape as chunk uploads instead of
  having its response ignored. Failing after the budget sets `uploadHasError`.
- **Finalize keepalive** — the finalize fetch sets `keepalive: true` so it can
  survive a tab close after the last chunk has already uploaded.
- **Bounded upload queue / backpressure** — per-track byte watermarks
  (200MB high / 50MB low in `upload.js`) pause the corresponding
  `MediaRecorder` (video/screen/opus-fallback audio) when its unuploaded
  backlog gets too large, and resume it once the queue drains. Prevents
  unbounded memory growth when the uplink can't keep up with capture.
- **Chunk size integrity check** — client sends `blob.size` as
  `expected_size` with every chunk; `app/routers/upload.py` rejects a
  mismatch with 400 (caught by the existing chunk retry loop) instead of
  silently writing a truncated file. Backward compatible (`-1` default for
  old clients).
- **Duration verification** — each track now reports its own capture
  duration (`expected_duration_s`) at finalize time (PCM: frame-count based,
  container tracks: wall-clock). Stored in `recording_metadata.json` per
  output filename. `verify-recordings` (`app/routers/sessions.py`) flags a
  file whose assembled ffprobe duration falls short of the expected duration
  by more than `max(5s, 5%)` — catches a chunk truncated mid-stream with no
  missing index, which the prior empty/very-short heuristic couldn't see.
- **IndexedDB persistence — phase 1 (write-through)** — new
  `app/static/js/idb-store.js` (loaded before `recording.js`/`upload.js` in
  `studio.html`). Every captured chunk is written to IndexedDB the instant
  it's produced, and deleted once the server ACKs the upload; a backstop
  epoch-sweep runs after a clean `waitForUploads()` finish. Also does a
  pre-flight `navigator.storage.estimate()` quota check at recording start.
  This phase is **purely additive** — the uploader still reads from the
  in-memory closures, so no upload behavior has changed yet. Its only job is
  to validate storage/quota/schema in production before phase 2 depends on it.

All of the above were verified against real execution (not just read), see
conversation history: FastAPI `TestClient` + real `ffmpeg`/`ffprobe` for the
size-check/duration-check paths, and `fake-indexeddb` in Node for the
IndexedDB put/delete/sweep operations.

## Not done / deferred, with reasoning

- **Chunk hash (SHA-256) verification** — deferred in favor of the cheaper
  size-check. TCP already guarantees byte-exact delivery for a completed
  request; full hashing is client CPU cost for a rarer failure mode
  (truncating proxy that still returns 200). Revisit only if corruption is
  actually observed in the wild.
- **Chunk retry/finalize budget (10 min)** — intentionally left as a bounded
  budget rather than "retry forever," documented in `upload.js`. Now that
  backpressure prevents the RAM-explosion case, extending the budget further
  is safer than before if long outages turn out to be common — but no
  evidence yet that it's needed.
- **Duplicate/out-of-order chunk index rejection** — not a real risk: chunks
  are written to `chunk_{index:06d}.ext`, so a retried send of the same index
  just overwrites the same file.
- **PCM drain timeout** — already exists (`recording.js`, 500ms race against
  the worklet drain ack). No action needed.
- **Full recording state machine** — current failure modes are narrow enough
  (chained promise queues + epoch tagging) that scattered flags are still
  legible. Revisit only if new failure modes appear that flags can't express.
- **Server-side manifest.json instead of directory scan** — the current
  regex-based directory scan works fine; a manifest mainly earns its keep
  once/if chunk hashing is added, where it'd be a natural side effect rather
  than its own project.

## Next up, in priority order

1. **IndexedDB persistence — phase 2 (uploader reads from IndexedDB)**
   Replace the in-memory promise-chain queue in `upload.js` with an uploader
   pump per track that pulls the oldest un-uploaded chunk from IndexedDB,
   uploads it, and deletes/marks it uploaded on success. Capture writes to
   IndexedDB and returns immediately — never blocked by upload speed.
   Needs: per-track pump loop, backpressure watermark logic ported to read
   IndexedDB backlog size instead of in-memory bytes.

2. **IndexedDB persistence — phase 3 (resume on reload + multi-tab lock)**
   On page load, scan IndexedDB for any `(sessionId, identity, epoch)` with
   un-uploaded chunks and resume the uploader pump automatically — this is
   what turns "recording became unusable after a crash" into "recording
   quietly finishes uploading when the tab reopens." Needs a Web Lock (or
   heartbeat-timestamp ownership flag) so only one tab's pump runs per
   epoch when the same origin is open in multiple tabs. Depends on phase 2.

3. **Resumable uploads via `/api/upload/chunks`** — the server already
   exposes a "next expected chunk index" endpoint
   (`app/routers/upload.py::get_chunk_progress`) that nothing calls today.
   Have the phase-2/3 uploader pump call it on startup/reconnect to detect
   gaps early rather than relying solely on the post-hoc gap check in
   `assemble_track`. Most valuable once phases 1–2 exist (something durable
   to actually resume from after a real crash, not just a network blip).

4. **Live recording health monitoring** — frozen video (via
   `requestVideoFrameCallback`, warn after ~5s with no new frame) and silent
   audio (RMS computed in the existing AudioWorklet, warn on near-zero levels
   for several seconds). A recording that silently captured a black frame or
   dead mic for 40 minutes is worse than an upload failure since there's no
   error at all — this closes that gap. Independent of the IndexedDB work,
   can be done in parallel.

5. **Surface assembly/ffmpeg failures + staged completion status** —
   `assemble_track` already renames failed sources to `.failed` but this is
   only visible in server logs. Extend `verify-recordings` (or a new status
   field) to report those, and split the upload banner's single "done" state
   into the real stages (uploaded → assembled → merged → verified) so a
   transcode failure is visible immediately rather than discoverable only by
   SSHing into the server.

6. **"Panic save" — download raw chunks locally** — once phase 1/2 IndexedDB
   work exists, the chunks already live in a queryable local store; offering
   a "download recording locally" button when uploads keep failing becomes a
   small feature (zip the IndexedDB blobs) rather than a new one.

7. **Safari `ondataavailable`/`onstop` ordering test pass** — needs actual
   Safari testing under a deliberately slow network; can't be resolved by
   reading code. If the final chunk really can arrive after `onstop` in some
   Safari version, the stop handler needs a short grace-period wait for one
   more `dataavailable` before treating the recording as flushed.

## Reference: key files

- `app/static/js/upload.js` — chunk/finalize upload queues, retry, backpressure.
- `app/static/js/recording.js` — MediaRecorder/PCM capture, finalize call sites.
- `app/static/js/idb-store.js` — IndexedDB persistence (phase 1).
- `app/routers/upload.py` — chunk/finalize endpoints, ffmpeg assembly, orphan recovery.
- `app/routers/sessions.py::verify_recordings` — post-assembly integrity checks.
