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
- **IndexedDB persistence — phase 2 (uploader pump reads from IndexedDB)** —
  `enqueueChunk` no longer closes the promise-chain over the blob itself;
  it writes through to IndexedDB, then queues a lightweight
  `uploadIdbChunkWithRetry` call that fetches the blob back via `idbGetChunk`
  immediately before sending it and deletes it on success. A large
  backpressure backlog now costs disk, not RAM (falls back to holding the
  blob directly only if IndexedDB itself is unavailable). Backpressure
  watermarks still track byte counts, which now mirror the IndexedDB backlog
  1:1 rather than an independent in-memory tally.
- **IndexedDB persistence — phase 3 (resume on reload + multi-tab lock)** —
  `recoverOrphanedChunks()` (`upload.js`) runs on every join. It sweeps all
  leftover IndexedDB chunks (metadata-only scan via `idbGetAllChunks`),
  groups them by `(sessionId, identity, epoch, trackType)`, and resends each
  group — this is what actually fulfills prejoin's "your upload will resume
  automatically" banner, which previously had no code behind it. Each group
  is wrapped in a `navigator.locks.request(..., { ifAvailable: true })` call
  keyed by the group's identity so two tabs recovering the same leftover
  epoch can't double-send (falls back to running unlocked if Web Locks isn't
  available). The interrupted-session marker moved from `sessionStorage` to
  `localStorage` — `sessionStorage` doesn't survive a tab close/reopen, which
  is exactly the crash scenario this exists for, so the recovery banner could
  never actually fire. A marker with no matching IndexedDB chunks (nothing to
  recover, or already-clean) is cleared automatically rather than firing the
  banner forever.
- **Resumable uploads via `/api/upload/chunks`** — `recoverOrphanedChunks`
  calls `get_chunk_progress` before resending a group and skips any chunk
  index the server already has, only resending the tail that's actually
  missing. Fixed a latent bug in `get_chunk_progress` along the way: it
  computed the participant directory using `identity`-first `_safe_name`
  logic that didn't match `participant_dir`'s `participant`-first
  `_display_slug` logic, so it was silently checking the wrong directory and
  always reporting `next_chunk: 0`.

All of the above were verified against real execution (not just read), see
conversation history: FastAPI `TestClient` + real `ffmpeg`/`ffprobe` for the
size-check/duration-check paths, and `fake-indexeddb` in Node for the
IndexedDB put/delete/sweep operations, plus a dedicated Node harness (stubbed
`fetch`/`localStorage`/`navigator.locks`) exercising the live pump, crash
recovery with gap-skip, and concurrent-tab lock contention end-to-end.

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

1. **Live recording health monitoring** — frozen video (via
   `requestVideoFrameCallback`, warn after ~5s with no new frame) and silent
   audio (RMS computed in the existing AudioWorklet, warn on near-zero levels
   for several seconds). A recording that silently captured a black frame or
   dead mic for 40 minutes is worse than an upload failure since there's no
   error at all — this closes that gap. Independent of the IndexedDB work,
   can be done in parallel.

2. **Surface assembly/ffmpeg failures + staged completion status** —
   `assemble_track` already renames failed sources to `.failed` but this is
   only visible in server logs. Extend `verify-recordings` (or a new status
   field) to report those, and split the upload banner's single "done" state
   into the real stages (uploaded → assembled → merged → verified) so a
   transcode failure is visible immediately rather than discoverable only by
   SSHing into the server.

3. **"Panic save" — download raw chunks locally** — the chunks already live
   in a queryable local store (IndexedDB); offering a "download recording
   locally" button when uploads keep failing is now a small feature (zip the
   IndexedDB blobs) rather than a new one.

4. **Safari `ondataavailable`/`onstop` ordering test pass** — needs actual
   Safari testing under a deliberately slow network; can't be resolved by
   reading code. If the final chunk really can arrive after `onstop` in some
   Safari version, the stop handler needs a short grace-period wait for one
   more `dataavailable` before treating the recording as flushed.

5. **Multi-tab lock for the *live* recording epoch, not just recovery** —
   `recoverOrphanedChunks` locks per leftover group, but the live pump
   (`enqueueChunk`/`uploadIdbChunkWithRetry`) doesn't take a Web Lock itself.
   Not currently exploitable (each tab's `identity` includes a random
   per-join suffix, so two tabs never share a live epoch), but if that
   assumption ever changes this gap would let two tabs double-upload.

## Reference: key files

- `app/static/js/upload.js` — chunk/finalize upload pump, retry, backpressure, crash recovery.
- `app/static/js/recording.js` — MediaRecorder/PCM capture, finalize call sites.
- `app/static/js/idb-store.js` — IndexedDB persistence and pump/recovery reads.
- `app/static/js/prejoin.js` — interrupted-session banner (`checkInterruptedSession`).
- `app/routers/upload.py` — chunk/finalize/progress endpoints, ffmpeg assembly, orphan recovery.
- `app/routers/sessions.py::verify_recordings` — post-assembly integrity checks.
