# Step 12 plan: Video uploads

Status: proposed (architect, 2026-10-11). Not a PRD build-order step: the PRD lists "Video storage
and analysis" as a v1 non-goal, "planned v2", and its Decisions table asks about "whether to
describe short clips via keyframes". The user asked (2026-10-11): "start working on video uploads
… For video, for free accounts, limit size, and counts toward photo limit. For paid accounts,
advise what limits are reasonable." Starts **after step 11 is committed** (migration 22 follows
`1792400000100_free-tier-abuse.sql`; worker queues follow 16; `import_book_photo` is redefined
again here, so its migration-21 body must be final).

PRD sections touched: FR-2.1–2.5, 2.7 (upload, direct-to-storage resumable, formats, progress,
dedupe, approval queue), FR-4.1–4.4 (metadata, age, GPS encrypted, derivatives stripped), FR-5.1,
5.2, 5.8 ("Free-tier photos are never sent to a model"), FR-6.1 ("Originals stored in object
storage, never modified"), FR-8.1, 8.4 (timeline tiles, viewer), FR-9.5 (sensitive gate), FR-10.1
("Export all originals"), FR-10.2/10.3 (trash, purge), "Pricing" takeaway ("storage is the cost
driver"), "Routing through Cloudflare Tunnel" (100 MB body cap), "Non-functional → Privacy and
child safety / Performance / Reliability", "Conventions". `CLAUDE.md`: MinIO everywhere; AI paid
only; never log photo bytes, GPS or notes (extended to video bytes, QuickTime location tags and
presigned URLs); dev stack zero-setup; RLS on every table. Step 11 family model (section 3 of its
plan) applies unchanged: a video is one **item** in the family's 1,000 approved-item pool.

## 0. Decisions (user, 2026-10-11; all questions closed — the ids Q1–Q9 are referenced below)

**Build starts only after the step-11 commit** (`step 11: free-tier abuse safeguards (family
model)`): migration 22 follows 21, and 2.2 redefines `import_book_photo`, whose migration-21 body
must be final before it is copied into the down migration.

| # | Decision | Value |
| --- | --- | --- |
| Q1 | Free per-clip limits | **60 s and 250 MB** per clip; original kept + 1080p web rendition; **1 video = 1 item** of the family's 1,000 |
| Q2 | Plus per-clip limits | **5 min and 2 GB** per clip (the user chose the conservative alternative over 10 min / 4 GB); original kept at full resolution (4K ok), one 1080p rendition |
| Q3 | Free video volume | **At most 100 videos per free family** (inside the 1,000 items), same trigger pattern as the pool |
| Q4 | Plus fair-use total | **200 GB per family soft cap**, operator report only, no user-facing enforcement |
| Q5 | Live Photos | **Still image only in v1** (the paired MOV is not uploaded); roadmap item D |
| Q6 | Cellular uploads for video on native | **Wi-Fi only by default** for files > 50 MB, per-upload "Use cellular" switch; photos unchanged |
| Q7 | Audio transcription | **No** in v1 (2.7: ~300× the vision cost per clip) |
| Q8 | Where the worker stages large files | **Disk-backed host folder** `WORKER_SCRATCH_PATH` (e.g. `/mnt/data/tinyglow/scratch`) mounted at `/scratch`; the 1 GiB `/tmp` tmpfs cannot hold a 2 GB clip plus its rendition |
| Q9 | Share-link viewers may download videos | **Yes, the web rendition only** (never the original), when the link allows downloads |

## 1. Goal

Let parents and contributors add short videos next to photos through the pipeline that already
exists: the same resumable multipart upload straight to MinIO (web and the native background
uploader, now with per-part ranges), the same `photos` rows (a `media_kind` column), the same
approval queue, trash, purge, export, dedupe, sharing and free-tier pool. The worker gains ffmpeg:
each video gets a poster frame (served as `thumb`/`display`/`analysis` so every existing grid,
viewer and share-link path works unchanged), three keyframes for the AI, and one H.264/AAC
faststart MP4 rendition (≤ 1080p) that every browser and both WebViews play with range requests
straight from MinIO. Metadata (duration, dimensions with rotation, capture time, camera, GPS from
the QuickTime location tag) follows the photo rules: GPS only encrypted, stripped from every
derivative and rendition, never logged. Free families get size- and duration-limited clips that
count as items; Plus families get long, full-resolution originals; videos of free albums never
reach a model, Plus videos are described from poster + keyframes by the existing batch pipeline.

## 2. Interfaces first

### 2.1 Topology

```
client  pick (web: <input accept="image/*,video/*">; native: pickMedia keeps originals; Apple sync: .video assets;
        Google Picker: type VIDEO, baseUrl=dv)
   ─▶ POST /uploads/:sid/files { kind:'video', bytes, durationMs?, clientSha256? }   api: plan limits → parts
   ─▶ PUT parts (16 MiB, presigned, straight to MinIO; native background session, ranged body per part)
   ─▶ POST …/complete → photos row (media_kind 'video', rendition_status 'pending') → photo.ingest
worker  photo.ingest: sniff → video? ─▶ video/ingest.ts: stage to /scratch (sha256 while streaming) → exact dedupe
        → ffprobe (codec, duration, size, rotation, tags) → validate vs plan → poster frame → thumb/display/analysis
        → metadata (creation time, tz, GPS→encrypt_coord, make/model) → status 'ingested' → send video.transcode
        video.transcode: (staged file or re-download) → ffmpeg → /scratch/web.mp4 (H.264/AAC, ≤1080p, faststart,
        -map_metadata -1) → put derivatives/{id}/web.mp4 → keyframe1..3 (768 px) → rendition_status 'ready'
        → (paid, approved) ai.flush picks it up: analysis + keyframe1..3 in one request
clients timeline tile = thumb + duration badge; viewer <video poster=display src=web.mp4 (signed, range)>;
        share viewer same via /share/photos/urls kinds thumb|display|web
```

New dependency: **ffmpeg/ffprobe binaries in the worker image** (`apk add ffmpeg`, +~90 MB). No
new JS library on the server (ffmpeg is spawned with `child_process`); no new service. Client: the
existing `@capawesome/capacitor-file-picker` gains `pickMedia` use (already installed).

### 2.2 Database (security-engineer): migration 22 `1792500000100_video.sql`

Conventions unchanged (reversible; fixed RAISE messages; grants per column; regenerate
`packages/db/src/generated`). `pgmigrations` becomes 22.

**A. `photos`** (the media-item table; D1)

```sql
ALTER TABLE public.photos
  ADD COLUMN media_kind        text NOT NULL DEFAULT 'photo' CHECK (media_kind IN ('photo','video')),
  ADD COLUMN duration_ms       integer CHECK (duration_ms IS NULL OR duration_ms > 0),
  ADD COLUMN video_codec       text CHECK (video_codec IS NULL OR video_codec IN ('h264','hevc')),
  ADD COLUMN has_audio         boolean,
  ADD COLUMN rendition_status  text NOT NULL DEFAULT 'none'
                               CHECK (rendition_status IN ('none','pending','ready','failed'));
ALTER TABLE public.photos DROP CONSTRAINT photos_mime_check;
ALTER TABLE public.photos ADD CONSTRAINT photos_mime_check CHECK (mime IN
  ('image/jpeg','image/png','image/heic','image/heif','image/webp','video/mp4','video/quicktime'));
CREATE INDEX photos_baby_video_idx ON public.photos (baby_id) WHERE media_kind = 'video' AND deleted_at IS NULL;
```

- Trigger `photos_media_shape` BEFORE INSERT OR UPDATE: `media_kind = 'photo'` ⇒ `duration_ms`,
  `video_codec`, `has_audio` NULL and `rendition_status = 'none'`; `media_kind = 'video'` ⇒
  `rendition_status <> 'none'`; message 'media columns inconsistent with media_kind'.
- Grants: `authenticated` INSERT += `media_kind` (the api sets it from the registered kind; the
  worker's sniff is the truth and may flip it); `pipeline` UPDATE += `media_kind, duration_ms,
  video_codec, has_audio, rendition_status`; `viewer` SELECT += `media_kind, duration_ms` (find the
  viewer column grant in `1792100000100_sharing-v1.sql` and extend it). `authenticated` SELECT is
  whole-table already.
- **Pool**: `photos_free_tier_cap` and `photos_pending_cap` (step 11) count rows, so a video is
  one item with no change. **Q3** adds `photos_free_tier_video_cap()` BEFORE INSERT OR UPDATE OF
  `approval, deleted_at, media_kind`: same `counts(r)` predicate AND `media_kind = 'video'`,
  per-family advisory lock class **1015**, limit `free_tier_video_limit()` (SQL default 100,
  GUC `app.free_tier_video_limit` like the pending cap), message 'free tier video limit reached
  (per family)'. `free_tier_pool_videos(p_baby_id)` for the usage line (EXECUTE like
  `free_tier_pool_used`).
- `ai_eligible_photos(...)`: `CREATE OR REPLACE` adding `AND (p.media_kind = 'photo' OR
  p.rendition_status = 'ready')` (keyframes exist only after transcode). Everything else
  verbatim; down restores the step-6 body.
- `FIND_NEAR_DUPLICATE` is worker SQL, not a function: no change here (2.6 restricts it to the
  same `media_kind`).

**B. `photo_derivatives.kind`**: CHECK += `'web','keyframe1','keyframe2','keyframe3'`.
`storage_key` stays UNIQUE. Viewer policy on derivatives: the existing kind filter (thumb/display
only) is extended to `web` **only for photos with `media_kind = 'video'`** (the policy predicate,
not just the API).

**C. `upload_files`**: `declared_bytes` CHECK raised to `<= 2147483648` (2 GiB); `ADD COLUMN
media_kind text NOT NULL DEFAULT 'photo' CHECK (IN ('photo','video'))`, `declared_duration_ms
integer CHECK (> 0)`; `error` CHECK += `'video_too_long','transcode_failed'`. The per-plan byte
limit is **not** a CHECK (plan can change); the api enforces it at register, the worker
re-validates after ffprobe.

**D. `import_items`**: `mime_hint` CHECK += `'video/mp4','video/quicktime'`; `bytes` CHECK raised
to 2 GiB; `error` CHECK += `'video_too_long'`; `ADD COLUMN media_kind … DEFAULT 'photo'`,
`duration_ms_hint integer`. `import_book_photo()` `CREATE OR REPLACE`: inserts `media_kind` and
`rendition_status = CASE media_kind WHEN 'video' THEN 'pending' ELSE 'none' END`; a video for a
**free** album whose `duration_ms_hint > 60000` or `bytes > 262144000` returns `'video_too_long'`
/ `'file_too_large'` before inserting (the worker also checks after download); down restores the
migration-21 body verbatim (hand check compares `pg_get_functiondef` before/after down/up).

**E. Export**: nothing in SQL (`storage_key_original` + new columns read by the worker).

Advisory-lock class 1015 documented in `packages/db/README.md`.

### 2.3 Shared contracts (`@tinyglow/shared`; architect-defined here, backend-engineer writes in 12.1 with orchestrator approval)

- `db-enums.ts`: `mediaKindSchema = z.enum(["photo","video"])`; `videoMimeSchema =
  z.enum(["video/mp4","video/quicktime"])`; `mediaMimeSchema = z.enum([...photoMimeSchema.options,
  ...videoMimeSchema.options])` (**`photos.mime` DTO fields switch to `mediaMimeSchema`**;
  `photoMimeSchema` stays for photo-only call sites); `derivativeKindSchema` +=
  `"web","keyframe1","keyframe2","keyframe3"`; `renditionStatusSchema =
  z.enum(["none","pending","ready","failed"])`; `videoCodecSchema = z.enum(["h264","hevc"])`.
- `video.ts` (new, browser-safe):

  ```ts
  export const VIDEO_LIMITS = {
    free: { maxSeconds: 60,  maxBytes: 250 * MIB },   // Q1
    plus: { maxSeconds: 300, maxBytes: 2 * GIB },     // Q2 (user: 5 min / 2 GB)
  } as const satisfies Record<Plan, { maxSeconds: number; maxBytes: number }>;
  export function videoLimitsFor(plan: Plan) { … }
  export const FREE_TIER_VIDEO_LIMIT = 100;            // Q3; mirror of SQL free_tier_video_limit()
  export const PLUS_FAIR_USE_BYTES_PER_FAMILY = 200 * GIB; // Q4; report only
  export const VIDEO_RENDITION = { kind: "web", longEdge: 1920, videoCodec: "h264", profile: "high",
    pixelFormat: "yuv420p", crf: 23, preset: "veryfast", maxFps: 60, audioCodec: "aac",
    audioBitrateKbps: 128, container: "mp4", faststart: true } as const;
  export const VIDEO_KEYFRAME_KINDS = ["keyframe1","keyframe2","keyframe3"] as const; // at 25/50/75 %
  export const VIDEO_POSTER_SECONDS = 1;               // poster at min(1 s, 10 % of duration)
  export const VIDEO_MAX_DIMENSION = 4096;             // longest edge accepted (8K refused)
  export const VIDEO_LARGE_FILE_BYTES = 50 * MIB;      // Q6: Wi-Fi-only default above this on native
  export const VIDEO_SCRATCH_MIN_FREE_BYTES = 6 * GIB; // transcode defers below this (2 GB original + ~1 GB rendition, headroom)
  export function formatDuration(ms: number): string  // "0:42", "12:05"
  ```
- `upload.ts`: `UPLOAD_MAX_FILE_BYTES` stays the **photo** cap (100 MiB); new
  `UPLOAD_MAX_VIDEO_BYTES = VIDEO_LIMITS.plus.maxBytes` (the `declared_bytes` CHECK mirror);
  `ACCEPTED_UPLOAD_EXTENSIONS` += `.mp4`, `.mov`, `.m4v`; `ACCEPTED_UPLOAD_MIMES` becomes
  `mediaMimeSchema.options`; `uploadFileErrorSchema` += `video_too_long`, `transcode_failed`;
  `derivativeKey(babyId, photoId, kind)` returns `….../web.mp4` for `web` and `.jpg` otherwise
  (`photoPrefixes` unchanged: prefix delete covers it); `MIME_EXTENSIONS` += `mp4`, `mov`.
- `api/uploads.ts`: `uploadFileRegisterSchema` += `kind: mediaKindSchema.default("photo")`,
  `durationMs: int ≥ 1 ≤ 86_400_000 optional`, `mime: mediaMimeSchema.optional()`, `bytes ≤
  UPLOAD_MAX_VIDEO_BYTES` with a `superRefine`: `kind === "photo"` ⇒ `bytes ≤
  UPLOAD_MAX_FILE_BYTES`. `uploadFileSchema` += `kind`.
- `api/photos.ts`: `photoSummarySchema` += `mediaKind`, `durationMs: int|null`,
  `renditionStatus`; `mime: mediaMimeSchema.nullable()`; photo detail response += `videoUrl:
  z.url().nullable()` (signed `web` derivative, ≤ 1 h) and `videoCodec`, `hasAudio`; batch
  signed-URL refresh response += `videoUrl`; timeline filter `media?: z.enum(["photo","video"])`.
- `api/share-viewer.ts`: viewer photo DTO += `mediaKind`, `durationMs`; `POST /share/photos/urls`
  `kinds` enum += `web`; `SHARE_VIEWER_MEDIA_KINDS` += `"web"` (constants.ts); new
  `SHARE_VIDEO_URL_TTL_SEC = 1800` (a 5-minute URL dies mid-playback; the player also re-fetches
  on error).
- `api/search.ts` / `api/chat.ts`: search filters and the `search_photos` tool gain `media:
  z.enum(["photo","video","any"]).default("any")`; `searchResultSchema` += `mediaKind`,
  `durationMs`.
- `search-document.ts`: `buildSearchDocument` appends `"Video clip, 42 seconds."` **only** when
  `mediaKind === "video"` (photo documents stay byte-identical, so no doc-version bump and no
  re-embedding; unit test asserts a photo input's output is unchanged).
- `ai-description.ts`: schema v1 **unchanged**; `aiRequestContextSchema` += `media: { kind:
  "video", durationSeconds, frameCount }` optional (the per-item user text, not the cached
  system prompt, so prompt v1's pinned hash stays).
- `jobs.ts`: `JOBS.videoTranscode = "video.transcode"` (`videoTranscodeJobSchema =
  z.strictObject({ photoId, babyId })`, `exclusive`, `singletonKey = photoId`, `retryLimit 2`,
  `retryDelay 120`, `expireInSeconds 7200`); queues become **17**. `ingest.reconcile` also
  re-sends `video.transcode` for `rendition_status = 'pending'` rows older than 15 min.
- `env.ts` `videoEnvSchema` (worker): `VIDEO_CONCURRENCY` 1..2 default 1; `WORKER_SCRATCH_PATH`
  default `/scratch` (dev: `/tmp/ll-scratch`); `FFMPEG_PATH` default `ffmpeg`, `FFPROBE_PATH`
  default `ffprobe`; `VIDEO_FFMPEG_THREADS` 1..8 default 2; `VIDEO_TRANSCODE_TIMEOUT_SEC` default
  3600. API: none new.
- `imports.ts`: `IMPORT_MAX_FILE_BYTES` → `UPLOAD_MAX_VIDEO_BYTES` for video items (photo items
  keep 100 MiB); Google `mediaDownloadUrl(baseUrl, kind)` returns `baseUrl + "=dv"` for video.
- `api/exports.ts` / export README text: `photos.csv` columns += `media_kind`, `duration_ms`,
  `video_codec`.
- `telemetry.ts`: scrub patterns += `X-Amz-Signature=[^&\s]+`, `/scratch/[^\s"']+`,
  `com\.apple\.quicktime\.location[^\s"']*`.

### 2.4 Upload API (`apps/api/src/uploads/**`, `apps/api/src/photos/**`; backend-engineer)

- `registerFiles`: per file, `kind`; for `video`: read the baby's plan once (`babies.plan` under
  claims), `limits = videoLimitsFor(plan)`; `bytes > limits.maxBytes` ⇒ outcome `failed /
  file_too_large`; `durationMs > limits.maxSeconds * 1000` ⇒ `failed / video_too_long` (a hint
  only; the worker re-checks); Q3: when `plan = 'free'` and `free_tier_pool_videos(baby) +
  registered videos ≥ FREE_TIER_VIDEO_LIMIT` ⇒ `failed / free_tier_limit` with the video copy
  (2.11). Part count = `ceil(bytes / 16 MiB)` (≤ 128 for 2 GiB; S3 allows 10,000). Store
  `media_kind`, `declared_duration_ms`.
- `completeFile`: ListParts total must equal `declared_bytes` (exists); insert `photos` with
  `media_kind`, `rendition_status = CASE kind WHEN 'video' THEN 'pending' ELSE 'none' END`; the
  trigger 23514 'free tier video limit' maps to 409 `free_tier_limit` with `details.kind =
  'video'`.
- `getParts` (resume): unchanged; signed part URLs are re-issued on demand (a 2 GB upload on a
  slow uplink outlives the 1 h signature, so the client re-calls it per part batch).
- `photos/queries.ts` + routes: select the new columns; `videoUrl` = signed GET of the `web`
  derivative when `rendition_status = 'ready'` (one object per URL, ≤ 1 h, `response-content-type
  video/mp4`); admin original download allows video mimes (extension from `extensionForMime`);
  `media` filter on the timeline list and summary; approve/trash/restore unchanged.
- `lib/errors.ts`: `freeTierLimit(kind?)`; `CHECK_VIOLATIONS` += `["free tier video limit
  reached", () => freeTierLimit("video")]`.
- Imports (`apps/api/src/imports/**`): nothing (the worker handles video items).

### 2.5 Sharing API (`apps/api/src/sharing/**`; security-engineer)

- `POST /share/photos/urls`: `kinds` may include `web`; a `web` URL is signed only for
  `media_kind = 'video'` rows the viewer can see (RLS does the gating; the route returns no entry
  otherwise), TTL `SHARE_VIDEO_URL_TTL_SEC`, `Cache-Control: private`, `response-content-type
  video/mp4`. Thumb/display unchanged (poster frames).
- `GET /share/photos/:id/download`: for videos the **web rendition** as `attachment;
  filename="<id>.mp4"` (Q9), never the original; `allow_download` gate unchanged.
- Viewer album/photos payloads carry `mediaKind`, `durationMs`. Sensitive videos (flags from
  poster/keyframes) are blurred exactly like photos and never rule-shared (`shared_photos_gate`
  is media-agnostic; test it with a video row).

### 2.6 Worker: video ingest and transcode (`apps/worker/src/video/**`, `apps/worker/src/ingest/**`, `apps/worker/src/export/**`, `apps/worker/src/import/**`, `apps/worker/src/purge.ts`, `apps/worker/src/reconcile.ts`; backend-engineer)

- `storage.ts`: `getObjectToFile(key, path): Promise<{ bytes, sha256 }>` (streams; hashes while
  writing; no size cap besides `UPLOAD_MAX_VIDEO_BYTES`), `putObjectFromFile(key, path, mime,
  { cacheControl })` (multipart for > 64 MiB). `getObject` keeps its 100 MiB Buffer cap for photos.
- `ingest/sniff.ts`: `sniffMediaMime(buffer)` recognises `video/mp4` (`ftyp` brands isom, mp41,
  mp42, avc1, M4V) and `video/quicktime` (`qt  `) from the first 4 KiB (the worker reads only the
  head object range for the sniff when `upload_files.media_kind = 'video'`, then stages).
- `ingest/index.ts`: after sniff, `if (isVideoMime(mime)) return ingestVideo(deps, photo, payload)`.
  Photos: unchanged. `FIND_NEAR_DUPLICATE_SQL` += `AND media_kind = $5` (poster pHash is compared
  with videos only).
- `video/ingest.ts` (runs inside the `photo.ingest` job; semantics as `ingestPhoto`):
  1. **Stage**: `getObjectToFile(original, ${SCRATCH}/${photoId}.orig)` (sha256 streamed) → exact
     dedupe through `UPDATE_HASH_SQL` (unique index arbiter, same `handleExactDuplicate`).
  2. **Probe**: `ffprobe -v error -print_format json -show_format -show_streams <file>` (args are
     paths only; no URLs anywhere in this module, so nothing to redact). Parse with a zod schema
     (`video/ffprobe.ts`). Require exactly one video stream with `codec_name ∈ {h264, hevc}`;
     audio stream optional (`has_audio`); duration from `format.duration`; `width/height` swapped
     when `side_data_list[].rotation ∈ {±90, ±270}` or `tags.rotate`; refuse `nb_frames`-less
     streams only if duration is also missing. Reject ⇒ `unsupported_media_type`; `max(w,h) >
     VIDEO_MAX_DIMENSION` ⇒ `unsupported_media_type`.
  3. **Plan check**: `babies.plan` → `videoLimitsFor`; `duration > maxSeconds` ⇒ `IngestFailure
     ("video_too_long")`; `bytes > maxBytes` ⇒ `file_too_large` (API already refused; defence in
     depth). Failed rows: `status = 'failed'`, objects deleted (existing path), scratch removed.
  4. **Poster**: `ffmpeg -ss <min(1, 0.1·duration)> -i <file> -frames:v 1 -vf scale=…:-2 -f image2
     -` → RGBA via sharp → `renderDerivative` `thumb`/`display`/`analysis` (metadata-free JPEGs,
     existing code) → CSAM matcher on the analysis copy **before** publishing the thumb (same
     order as photos) → `putDerivative`.
  5. **Metadata** (`video/metadata.ts`): `takenAt` from `format.tags.com.apple.quicktime.creationdate`
     (has offset) else `format.tags.creation_time` (UTC) else `tzHint`-less upload time
     (`taken_at_estimated`); `camera_make/model` from `com.apple.quicktime.make/model` or
     `encoder`; **GPS** from `com.apple.quicktime.location.ISO6709` / `location` (`±DD.DDDD±DDD.DDDD`)
     parsed into a non-enumerable local like `exif.ts` → `UPSERT_EXIF_SQL` (encrypt + Home label)
     with `raw_json` = the whitelisted tags **minus every location key** (the existing
     `photo_exif_no_gps_keys` trigger is the tripwire; add `location`, `ISO6709` to its key list if
     missing — security-engineer confirms). Age at capture as for photos.
  6. **Finish**: `FINISH_VIDEO_SQL` sets `width, height, duration_ms, video_codec, has_audio,
     phash (poster), taken_at…, status = 'ingested', rendition_status = 'pending'`; upload file
     `ingested`; then `enqueueVideoTranscode({ photoId, babyId })`. The staged file stays for the
     transcode (deleted there or by the sweep after 6 h). Log: ids, mime, bytes, durationMs,
     codec, dims, ms — never tags, paths with names, or URLs.
- `video/transcode.ts` (`video.transcode` handler, `VIDEO_CONCURRENCY`, `runAsPipeline`):
  1. Load row; skip unless `media_kind = 'video' AND rendition_status IN ('pending','failed') AND
     deleted_at IS NULL AND quarantined_at IS NULL`. `statfs(SCRATCH)` free `<
     VIDEO_SCRATCH_MIN_FREE_BYTES` ⇒ throw (pg-boss retries; heartbeat alert "scratch low").
  2. Source: the staged `.orig` if present else `getObjectToFile` (sha256 must equal
     `photos.sha256`, else fail `transcode_failed`).
  3. **Remux fast path**: source is MP4, `h264`, `yuv420p`, ≤ 1080p, ≤ 60 fps, audio `aac` or
     none ⇒ `ffmpeg -i in -map 0:v:0 -map 0:a:0? -c copy -map_metadata -1 -map_chapters -1
     -movflags +faststart out.mp4`.
  4. **Transcode** otherwise: `-map 0:v:0 [-map 0:a:0] -c:v libx264 -preset veryfast -crf 23
     -profile:v high -pix_fmt yuv420p -vf "scale='min(1920,iw)':-2[,fps=60]" [-c:a aac -b:a 128k
     -ac 2] -map_metadata -1 -map_chapters -1 -movflags +faststart -threads $VIDEO_FFMPEG_THREADS
     -t <maxSeconds>`; **HDR** (`color_transfer ∈ {smpte2084, arib-std-b67}`) adds a tone-map
     chain (`zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
     Alpine's ffmpeg is built with libzimg — devops verifies in 12.10, else fall back to
     `-vf format=yuv420p` with washed-out colours and a logged `hdr_tonemap: false`). Timeout
     `VIDEO_TRANSCODE_TIMEOUT_SEC` ⇒ kill, retry; after the last attempt `rendition_status =
     'failed'`, upload file error `transcode_failed` (the row stays live: poster, original download
     and export still work; `photos.status` is never set to `failed` by a transcode failure).
  5. Verify: `ffprobe` the output (one h264 stream, no `location*` / `creation_time` tags,
     `moov` before `mdat`: read the first 1 MiB and assert the `moov` box offset < `mdat` offset).
  6. `putObjectFromFile(derivativeKey(…,"web"), out, "video/mp4", { cacheControl: CACHE_CONTROL })`
     → `UPSERT_DERIVATIVE_SQL` (`kind = 'web'`, `bytes`, `width/height` of the rendition).
  7. **Keyframes**: `ffmpeg -ss <25|50|75 % of duration> -i in -frames:v 1` → sharp 768 px JPEG q75,
     metadata-free, ≤ 400 KB (the adapters' cap) → `keyframe1..3` derivatives (a clip < 3 s gets
     one keyframe; the others are skipped, never duplicated).
  8. `rendition_status = 'ready'`; delete scratch files; log `{ photoId, babyId, remux: bool,
     hdr: bool, inBytes, outBytes, ms }`.
- `reconcile.ts` (`ingest.reconcile`): re-send `video.transcode` for `pending` rows older than
  15 min; `uploads.sweep`: delete `/scratch` files older than 6 h whose photo is not `pending`.
- `purge.ts`: nothing (prefix deletes); operator report (`abuse-report.ts`, security-engineer)
  section 3 gains `videos`, `video_bytes` per family and a **fair-use** marker at
  `PLUS_FAIR_USE_BYTES_PER_FAMILY` (Q4).
- `export/content.ts`: `EXT_BY_MIME` += mp4/mov; `photos.csv/json` += `media_kind, duration_ms,
  video_codec`; README line "originals/ … includes videos (.mov/.mp4) as uploaded".
- `import/google/handler.ts`: `type = VIDEO` items are no longer skipped: download `baseUrl=dv`,
  size cap `videoLimitsFor(plan).maxBytes`, `duration_ms_hint` from `mediaFileMetadata.videoMetadata`
  when present; `import_book_photo` outcomes `video_too_long`/`file_too_large` mark the item
  failed and continue (not a batch stop). The fake Google server serves one small MP4 item.
- `demo/`: Maya's seed gains **one** 4-second demo clip rendered in code (SVG frames → ffmpeg)
  so the store-review account and screenshots show a video tile (dev + review baby only;
  worker image already has ffmpeg).

### 2.7 AI (`packages/ai/**`, `apps/worker/src/ai/**`, `apps/api/src/search/**`, `apps/api/src/chat/**`; ai-engineer)

- Vision request for a video: `analysis` (poster) + `keyframe1..3` as **up to four images** in one
  Responses-API item; per-item text adds "These {n} frames are sampled from one {d}-second video
  clip; describe the clip." Schema v1 and the cached system prompt are unchanged (prompt hash
  stays v1). Adapters keep every refusal (non-paid, > 768 px, > 400 KB, coordinate-like context)
  **per image**. Fake provider: deterministic output keyed on the first image.
- `ai/pipeline.ts`: eligibility unchanged (SQL; videos need `rendition_status = 'ready'`); the
  byte-cap packing counts all images of an item; `ai_batch_items` unchanged (one item per video).
- **Cost** (gpt-6-luna Batch, pinned table): ~600 image tokens × 4 + ~100 context = ~2,500
  uncached input ($0.000125) + ~700 cached prompt ($0.0000035) + ~400 output ($0.0001) ≈
  **$0.00023 per video** (≈ 2.3× a photo; step-7 real runs billed ~$0.0001 per photo, so expect
  $0.00015–0.00025). A Plus family with 50 clips/month adds ~$0.01. Budget hard stop
  `AI_BABY_MONTHLY_BUDGET_USD` unchanged. **Q7**: Whisper-class transcription is ~$0.006/min
  ($0.03 for a 5-min clip, ~130× the vision cost) and would add parent voices to the model
  input; not in v1.
- Search: indexer embeds the extended document for videos; `search_photos` tool and `GET
  /babies/:id/search` accept `media`; results carry `mediaKind`/`durationMs`; chat prompt v1
  gains one line ("Items may be photos or short video clips; say 'video' when citing one") — this
  changes the chat prompt hash → re-pin (`CHAT_PROMPT_SHA`), no backfill needed.
- Free albums: `baby_ai_enabled` false ⇒ no items, no `photo_search` rows, no model call (the AI
  gate asserts 0 free video items in the request dump).

### 2.8 Web app (`apps/mobile-web/src/**`; frontend-engineer)

- Picker: `<input accept="image/*,video/mp4,video/quicktime">`; `validateFile` branches on kind
  (photo ≤ 100 MiB; video ≤ plan `maxBytes`, duration via a `<video>` element `loadedmetadata`
  read of the local file ⇒ `durationMs` hint and a client-side "too long for your plan" failure
  with the Plus hint on web). Items show kind, duration, size.
- `UploadManager`: `kind` per item; `register` sends `kind`, `durationMs`; parts re-fetched via
  `getParts` when a part URL is older than 50 min; Q6 on native: items > `VIDEO_LARGE_FILE_BYTES`
  default to `wifiOnly: true` with a per-item "Use cellular" toggle (persisted preference in
  Settings → Uploads).
- Timeline tiles: duration badge (`formatDuration`) bottom-right + small play glyph; `media`
  filter chip (All / Photos / Videos). Viewer: `<video controls playsinline preload="metadata"
  poster={displayUrl} src={videoUrl}>` inside Swiper (swipe disabled while playing); states:
  `pending` → poster + "Preparing video…" (poll detail every 10 s while open); `failed` → poster +
  "This video couldn't be prepared" (+ "Download original" for admins). Re-request `videoUrl` on
  `error` (expired signature). Details panel shows duration, codec, "Original: 4K HEVC, 1.2 GB".
- Approval queue: video cards with duration; `pending_limit`/`free_tier_limit` copies per 2.11.
- Free-tier notice: parent/guest lines gain "({v} of 100 videos)" when `freeTier.videos` is
  present (Q3).
- Share viewer (`/s/:token`): tile badge, player (`web` URL via `/share/photos/urls`), download
  button saves the MP4 when allowed, blurred when sensitive.
- Offline cache: videos excluded. Screenshots: `scripts/screenshots-video.ts` (upload with a
  video, timeline tile, viewer playing, pending/failed states, share viewer) light/dark ×
  phone/desktop per `docs/DESIGN.md`.
- Native upload UI copy: "Videos upload on Wi-Fi by default" + switch.

### 2.9 Native (`apps/mobile-web/ios/**`, `apps/mobile-web/android/**`; mobile-engineer)

- `TinyglowUploader.upload({ url, path, offset?, length?, wifiOnly? })`: **ranged parts from one
  file**. iOS background `URLSession` needs a file body: copy the byte range to
  `Caches/ll-uploads/parts/<uuid>.part` (16 MiB), `uploadTask(with:fromFile:)`, delete on
  completion/error; `done`/`error` events carry the part id. Android `UploadWorker`: stream the
  range from the file (`RandomAccessFile`) into the PUT body; no copy. Both: no extra headers, no
  URL/path logging (the step-9 rules), survives app kill, resumes from the server's
  `uploadedPartNumbers`.
- Picker: `pickMedia({ skipTranscoding: true, limit })` (originals: HEVC MOV kept); `name`,
  `size`, `mimeType`, `duration` returned by the plugin feed the hints. **Q5**: a Live Photo
  picked as a photo uploads the HEIC only.
- `TinyglowPhotoSync.swift`: album enumeration includes `mediaType == .video`; `exportAssets`
  writes `PHAssetResourceType.video` (original, `isNetworkAccessAllowed`), returns `durationMs`
  (`asset.duration`) and `size`; the JS sync lane applies the plan limits **before** export
  (skipped with a new ledger outcome `too_large`/`too_long`, counted in `skipped_count`) and keeps
  Wi-Fi-only; one video at a time on the sync lane.
- Plists: no new permission. `PrivacyInfo.xcprivacy`: no new data type. Android manifest:
  unchanged (Photo Picker). Store copy (`store/**`, fastlane): "photos and short videos"; Data
  Safety: "Photos and videos > Videos" collected; review notes mention a demo clip. `NATIVE.md`:
  ranged uploads, scratch-free device behaviour, cellular switch.

### 2.10 Devops (`apps/worker/Dockerfile`, `docker-compose*.yml`, `.env.*`, `docker/**`, `.github/**`, `docs/PRODUCTION.md`)

- Worker image: `apk add --no-cache ffmpeg` in the `prod` stage **and** the `dev` stage; record
  the added size; CI's integration job installs ffmpeg on the runner (or runs worker tests in the
  image).
- Production compose: `WORKER_SCRATCH_PATH` bind mount at `/scratch` (`create_host_path: false`,
  required when `VIDEO_ENABLED`… no: always required — document `/mnt/data/tinyglow/scratch`);
  `tmpfs /tmp` stays 1g; `mem_limit` 2g → **3g** (libx264 at 1080p + a 4K decode ≈ 1.5 GB);
  `cpus: ${WORKER_CPUS:-}` optional; `VIDEO_CONCURRENCY`, `VIDEO_FFMPEG_THREADS`,
  `VIDEO_TRANSCODE_TIMEOUT_SEC`, `WORKER_SCRATCH_PATH` in the worker block and `.env.example`
  (section "Video (docs/plans/step-12.md; WORKER ONLY)"). Dev compose: a named volume
  `dev-scratch:/scratch`.
- Backups: `docker/backup/offsite-backup.sh` excludes nothing new (renditions are under
  `STORAGE_PATH` and are regenerable but cheap to keep); note growth in the guide. The restic
  exclude list could skip `*/derivatives/*/web.mp4` to halve video backup cost — **decision D9**,
  default **keep** (a restore then needs no re-transcode).
- nginx: no change (bytes bypass nginx); add a comment that video playback uses MinIO range
  requests via `files.`. Cloudflare: `docker/cloudflared/config.example.yml` comment — part size
  16 MiB stays under the 100 MB body cap and the 100 s origin timeout needs ≥ 1.4 Mbps per part.
- CI: `video-hygiene.sh` (no `X-Amz-Signature`/`/scratch/` in logs of the gate; ffmpeg args never
  contain `http`; `apps/worker/src/video/**` never imports `packages/ai`), the video gate in the
  dev-stack job, 3 new required integration suites in `check-integration-report.mjs`.
- `docs/PRODUCTION.md`: Part B adds the scratch folder; Part C4 the video variables; a new Part K
  "Videos": limits table (2.11), disk planning (a Plus family with 5 min of 4K/week ≈ 50–100 GB
  per year originals + ~15 % renditions), the fair-use report column, how to raise/lower the free
  video count (`ALTER DATABASE tinyglow SET app.free_tier_video_limit = '…'`), transcode failures
  ("Preparing video" stuck → `run-job video.transcode`), Cloudflare media note.

### 2.11 Limits and copy

| Plan | Per clip | Stored | Count | Volume |
| --- | --- | --- | --- | --- |
| Free | ≤ 60 s, ≤ 250 MB, H.264/HEVC MP4/MOV, ≤ 4096 px | original + 1080p web rendition + poster/keyframes | 1 video = 1 of the family's 1,000 items | ≤ 100 videos per family (Q3) |
| Plus | ≤ 5 min, ≤ 2 GB, same formats, ≤ 4096 px (4K) | original at full resolution + 1080p rendition + frames | not pooled | 200 GB per family fair use, operator report only (Q4) |

| Where | Code | Text |
| --- | --- | --- |
| register / complete (free, duration) | `video_too_long` | Free albums hold clips up to 1 minute long. Trim the video, or upgrade to Plus for clips up to 5 minutes. |
| register (free, size) | `file_too_large` | This video is {size}; free albums take videos up to 250 MB. Upgrade to Plus for videos up to 2 GB. |
| register / complete (Plus) | `video_too_long` / `file_too_large` | Videos can be up to 5 minutes and 2 GB. |
| Q3 cap | `free_tier_limit` (details.kind video) | Your family's free albums already hold 100 videos. Upgrade to Plus or delete videos to add more. |
| transcode failed | — | This video couldn't be prepared for playback. Parents can still download the original. |
| pending | — | Preparing video… |
| native upload | — | Videos over 50 MB upload on Wi-Fi. Use cellular for this one. |
| usage line (Q3) | — | Your family's free photos and videos: {used} of 1,000 ({v} of 100 videos) |

## 3. Tasks

Owners per `CLAUDE.md`. Groups run in parallel (disjoint paths); later groups depend on earlier.

### Group 0 — contracts, schema, image (parallel)

**12.1 Shared contracts** — backend-engineer (orchestrator approval). Owns
`packages/shared/src/{db-enums,upload,video,jobs,env,imports,search-document,ai-description,telemetry,constants,index}.ts`,
`packages/shared/src/api/{uploads,photos,share-viewer,search,chat,exports}.ts`. Inputs: 2.3. Done
when: every name in 2.3 exists with those shapes; `derivativeKey(...,"web")` ends `.mp4`; a photo
search document is byte-identical to before (test); `pnpm --filter @tinyglow/shared test typecheck`
green.

**12.2 Migration 22, README, generated types, report** — security-engineer. Owns
`packages/db/migrations/1792500000100_video.sql`, `packages/db/README.md`,
`packages/db/src/generated/**`, `packages/db/src/tools/abuse-report.ts`, `packages/db/src/seed.ts`
(demo clip row). Inputs: 2.2, 2.6 (report). Done when: up/down clean on a fresh DB and on a dev DB
with the seeds; `import_book_photo` and `ai_eligible_photos` down bodies equal their previous
`pg_get_functiondef`; viewer SELECT includes `media_kind, duration_ms` and the derivatives policy
admits `web` only for video rows; Q3 trigger + GUC function; lock class 1015 documented; report
shows videos/bytes/fair-use.

**12.3 Worker image + compose + env** — devops-engineer. Owns `apps/worker/Dockerfile`,
`docker-compose.yml`, `docker-compose.dev.yml`, `.env.example`, `.env.dev`,
`docker/cloudflared/config.example.yml`, `docker/nginx/default.conf` (comment only). Inputs:
2.10. Done when: `docker compose -f docker-compose.dev.yml build worker` has `ffmpeg -version`
and `ffprobe -version` with `--enable-libx264 --enable-libzimg` (record if libzimg is absent);
both compose files `config` clean; dev worker has `/scratch` writable; prod `WORKER_SCRATCH_PATH`
required with `create_host_path: false`; `mem_limit 3g`.

### Group 1 — server, clients (parallel; after group 0)

**12.4 Upload + photos API** — backend-engineer. Owns `apps/api/src/uploads/**`,
`apps/api/src/photos/**`, `apps/api/src/lib/errors.ts`, `apps/api/src/plugins/jobs.ts`,
`apps/api/src/config.ts`. Inputs: 2.4, 2.3. Done when: register of `{kind:"video", bytes: 300 MiB}`
on a free album → `failed/file_too_large`; `durationMs: 90000` on free → `failed/video_too_long`;
same on Plus → `registered` with `partCount = ceil(bytes/16 MiB)`; complete inserts
`media_kind='video', rendition_status='pending'`; detail returns `videoUrl` only when ready;
`?media=video` filters; the 101st free video → 409 `free_tier_limit` with `details.kind`.

**12.5 Worker video ingest + transcode + export + import + demo clip** — backend-engineer, same
lane as 12.4 (serial). Owns `apps/worker/src/video/**`, `apps/worker/src/ingest/**` (not
`*.test.ts`), `apps/worker/src/storage.ts`, `apps/worker/src/queues.ts`, `apps/worker/src/reconcile.ts`,
`apps/worker/src/uploads-sweep.ts`, `apps/worker/src/export/**`, `apps/worker/src/import/**`,
`apps/worker/src/demo/**`, `apps/worker/src/config.ts`, `apps/worker/src/heartbeat.ts`
(scratch alert). Inputs: 2.6, 2.3, 2.2. Done when: on the dev stack an uploaded HEVC MOV with a
QuickTime location tag ends `ingested` with thumb/display/analysis within 5 s, `photo_exif`
GPS encrypted and `raw_json` without location keys, then `rendition_status='ready'` with
`derivatives/<id>/web.mp4` (h264/aac, faststart, no tags) and `keyframe1..3`; an H.264 1080p MP4
takes the remux path (`remux: true` in the log); a 70 s clip on a free album fails
`video_too_long` with objects deleted; `run-job video.transcode` works; export ZIP contains the
`.mov`; Google fake video item imports; `grep -r http apps/worker/src/video` finds no ffmpeg
argument.

**12.6 Sharing API** — security-engineer. Owns `apps/api/src/sharing/**`. Inputs: 2.5. Done when:
viewer `POST /share/photos/urls {kinds:["thumb","display","web"]}` returns a `web` URL only for
video rows; download of a video returns the rendition as attachment; a sensitive video is never
rule-shared (test with a `photo_ai` row flagging the poster).

**12.7 AI, search, chat** — ai-engineer. Owns `packages/ai/**`, `apps/worker/src/ai/**`,
`apps/api/src/search/**`, `apps/api/src/chat/**`. Inputs: 2.7, 2.3. Done when: the request dump
of the fake AI gate shows 4 images for a video item and 1 for a photo; adapters refuse a keyframe
> 400 KB; `search_photos(media:"video")` returns only videos; chat cites a video as "video";
`CHAT_PROMPT_SHA` re-pinned; free video → 0 items.

**12.8 Web app** — frontend-engineer. Owns `apps/mobile-web/src/**`,
`apps/mobile-web/scripts/screenshots*.ts`. Inputs: 2.8, 2.11, 2.3. Done when: a video uploads
from the web picker with progress and shows a duration-badged tile, the viewer plays it (and
shows pending/failed states), the share viewer plays and downloads it, filter chips work, free
notices show video counts; unit tests; screenshots reviewed per `docs/DESIGN.md`.

**12.9 Native** — mobile-engineer. Owns `apps/mobile-web/ios/**`, `apps/mobile-web/android/**`,
`apps/mobile-web/NATIVE.md`, `apps/mobile-web/store/**`, `apps/mobile-web/fastlane/**`. Inputs:
2.9. Done when: iOS simulator uploads a 60 MB MOV in 4 ranged background parts (part files
deleted after), survives backgrounding; Android debug build + lint pass with the ranged worker;
`pickMedia` returns HEVC originals with duration; album sync exports a video asset; store copy and
Data Safety updated; `check-ios-plists.ts` passes.

### Group 2 — tests and gate (after group 1)

**12.10 Tests, fixtures, video gate** — test-engineer. Owns `**/*.test.ts(x)`, `e2e/**`,
`packages/db/test/{harness,fixtures}.ts`, `apps/api/src/testing/*`, `apps/worker/src/testing/*`,
root `package.json` script `e2e:video-gate` (orchestrator approves the line). Fixtures
(`e2e/fixtures/video/`, each ≤ 2 MB, generated once with ffmpeg and committed): `h264-1080p-5s.mp4`
(remux path), `hevc-5s.mov` with `com.apple.quicktime.location.ISO6709` + `creationdate` tags,
`hevc-hdr-3s.mov` (smpte2084), `rotated-90.mp4`, `h264-70s-tiny.mp4` (160 px, > 60 s),
`audio-only.m4a`, `fake.mp4` (JPEG bytes renamed). Done when the suites below are green:
- db: migration up/down; `photos_media_shape`; viewer grants (`media_kind`, `duration_ms`
  readable, `web` derivative visible only for video rows of its link); Q3 cap at 100 per family
  (concurrent inserts admit one), GUC override; `ai_eligible_photos` excludes `pending` videos;
  `import_book_photo` video outcomes; pool counts a video as one item; pending cap applies to
  videos.
- api: register/complete matrix (kind × plan × size × duration), detail `videoUrl`, filter,
  share `web` URLs + download, free-tier 409 kind.
- worker: `sniffMediaMime`, ffprobe schema parsing (rotation, HDR, tags), ISO6709 parser (never
  returns coordinates in logs — spy on the logger), remux decision table, tone-map chain
  selection, `getObjectToFile` hashing, transcode output verification (faststart, no tags),
  integration against real MinIO + ffmpeg for all fixtures (`fake.mp4` → `unsupported_media_type`,
  `audio-only` → `unsupported_media_type`, 70 s free → `video_too_long`), export includes `.mov`,
  Google fake video import.
- ai: 4-image request building, adapter per-image refusals, fake output for videos, search doc
  unchanged for photos.
- web: `validateFile` kinds, duration read, badge, viewer states, share viewer player.
- e2e `e2e/video/upload.spec.ts` (web upload → tile → viewer plays, uses the 5 s MP4).
- **gate** `pnpm e2e:video-gate` (`e2e/video/gate.ts`, prints `PASS n/n`): see 4.4.

### Group 3 — CI (after 12.10)

**12.11 CI** — devops-engineer. Owns `.github/**`. Done when: `video-hygiene.sh` in the lint job;
runner has ffmpeg for worker integration; the video gate + log tap in the dev-stack job;
`check-integration-report.mjs` lists the new suites; actionlint clean.

### Group 4 — gate, PROGRESS, commit (orchestrator)

| Group | Tasks |
| --- | --- |
| 0 | 12.1 (backend) ‖ 12.2 (security) ‖ 12.3 (devops) |
| 1 | 12.4 → 12.5 (backend, one lane) ‖ 12.6 (security) ‖ 12.7 (ai) ‖ 12.8 (frontend) ‖ 12.9 (mobile) |
| 2 | 12.10 (test-engineer) |
| 3 | 12.11 (devops) |
| 4 | orchestrator |

No two tasks in one group share a path.

## 4. Acceptance checks

### 4.1 Static, unit, integration

```sh
pnpm lint && pnpm typecheck && pnpm typecheck:e2e
bash .github/scripts/video-hygiene.sh && bash .github/scripts/ai-hygiene.sh && bash .github/scripts/share-hygiene.sh
pnpm test && pnpm test:integration          # worker integration needs ffmpeg + MinIO
pnpm --filter @tinyglow/db db:types && git diff --exit-code packages/db/src/generated
docker compose -f docker-compose.dev.yml exec -T worker ffmpeg -hide_banner -version | head -1
docker compose -f docker-compose.dev.yml exec -T worker sh -c 'ffmpeg -hide_banner -buildconf | grep -E "libx264|libzimg"'
! rg -n "http" apps/worker/src/video --glob '!*.test.ts'       # ffmpeg never gets a URL
```

### 4.2 Database by hand

```sh
D='docker compose -f docker-compose.dev.yml exec -T db psql -U postgres tinyglow -v ON_ERROR_STOP=1'
$D -c "\d photos" | grep -E "media_kind|duration_ms|rendition_status"
$D -c "select media_kind, rendition_status, duration_ms, video_codec from photos where media_kind='video'"
$D -c "select kind, bytes from photo_derivatives where photo_id='<video>' order by kind"   # analysis display keyframe1..3 thumb web
$D -c "select raw_json ? 'location' or raw_json ? 'com.apple.quicktime.location.ISO6709' from photo_exif where photo_id='<video>'"  # f
$D -c "select free_tier_pool_used('<free baby>'), free_tier_pool_videos('<free baby>')"
```

### 4.3 API and storage by hand (`B=http://localhost:8080`, `H='x-tinyglow-client: web'`)

```sh
# free admin: 300 MiB video register → failed/file_too_large; 90 s hint → failed/video_too_long
curl -s -b jar -H "$H" -H 'content-type: application/json' -d '{"files":[{"clientId":"v1","kind":"video","bytes":314572800}]}' $B/api/uploads/$SID/files
# upload e2e/fixtures/video/hevc-5s.mov through the web UI; then:
curl -s -b jar -H "$H" "$B/api/photos/$PID" | jq '{mediaKind,durationMs,renditionStatus,videoUrl}'
curl -s -I -H 'Range: bytes=0-1023' "$VIDEO_URL" | grep -E "^HTTP/1.1 206|Content-Range"      # MinIO range request
curl -s "$VIDEO_URL" -o /tmp/web.mp4 && docker run --rm -v /tmp:/t linuxserver/ffmpeg -v error -show_entries format_tags -of json -i /t/web.mp4 | grep -ci location   # 0
head -c 1048576 /tmp/web.mp4 | grep -obUaP "moov|mdat" | head -2                               # moov before mdat
# share viewer: urls with kinds web → 200 with url for the video only; download → attachment .mp4
```

### 4.4 Gate (`pnpm e2e:video-gate`, dev stack; prints `PASS n/n`)

1. Fresh free family F: upload the 5 fixtures via the API; `hevc-5s.mov` → `ingested` with thumb
   ≤ 5 s (p95 over 5 uploads), `ready` within 60 s; `h264-1080p-5s.mp4` → remux log line;
   `rotated-90.mp4` → `width < height`; `hevc-hdr-3s.mov` → ready (tone-map flag logged);
   `h264-70s-tiny.mp4` → `failed/video_too_long`, 0 objects under its prefixes; `fake.mp4`,
   `audio-only.m4a` → `unsupported_media_type`.
2. Served derivatives of every video (thumb, display, analysis, keyframes, web) have no
   EXIF/XMP/QuickTime location tags (exiftool via Docker + ffprobe); the original's GPS row is
   encrypted (`gps_lat_enc IS NOT NULL`, plaintext never in logs).
3. Pool: `free_tier_pool_used` rises by the number of ingested videos; 100 synthetic video rows
   (superuser) → the next video insert fails with the Q3 prefix; `GET /babies/:id` shows
   `freeTier.videos`.
4. Guest G uploads a video → `pending`, pool unchanged; approve → counts; reject → trash.
5. Plus family P (`db:plan plus`): a 90 s clip is accepted; a tiny 6-min clip (generated at run
   time, 160 px) → `failed/video_too_long`; a 2.5 GB register → `failed/file_too_large` (declared
   bytes only, nothing uploaded); fake AI gate on P: the request dump
   shows 4 images for the video, `cost_usd` recorded, `photo_ai` row; F's video: 0 items.
6. Share link on P with downloads on: viewer `urls` returns `web` for the video, range request
   206, download is the MP4 rendition (not the original's sha256); a sensitive-flagged video has
   0 `shared_photos` rule rows and is blurred in the viewer payload.
7. Export of P contains `originals/<date>_<id>.mov` with the original's sha256 and
   `photos.csv` has `media_kind,duration_ms`.
8. Trash a video → restore → trash → `purge.trash` with the clock advanced (existing helper) →
   0 rows, 0 object versions under both prefixes, scratch empty.
9. Log tap (api + worker): no `X-Amz-Signature`, no coordinates, no `/scratch/` paths with
   names, no QuickTime tag values. Cleanup leaves Maya's media untouched (import-gate lesson).

### 4.5 Gate procedure (orchestrator)

4.1 green → fresh dev stack (`up -d --build --wait`) → smoke → `restart-api.sh` → `pnpm e2e` →
upload/import/share/abuse gates → `pnpm e2e:video-gate` → AI gate (fake) → 4.2/4.3 by hand once →
iOS simulator: ranged background upload of a 60 MB MOV (12.9 check) → screenshots → PROGRESS
(decisions Q1–Q9 as recorded in section 0, D1–D12, image size, open issues) → `git commit -m "step
12: video uploads"`.

## 5. Risks and decisions

### 5.1 Plan limits: the reasoning behind Q1–Q4 (decided; kept for the record)

Storage is the cost driver (PRD "Pricing"). On this self-hosted server a stored GB costs roughly
$0.02/yr of disk (amortised HDD, mirrored) plus ~$0.07/yr of off-site copy (Backblaze B2 at
$6/TB/month), so **~$0.09 per GB-year all-in**, and every GB is kept for years. Plus is $47.88/yr
per album. iPhone footprints: 4K60 HEVC ≈ 400 MB/min, 4K30 ≈ 190 MB/min, 1080p30 ≈ 65 MB/min.
Comparable family apps (from memory; verify before publishing copy): FamilyAlbum/Mitene caps
clips at ~3 min free and ~10 min premium; Tinybeans historically capped free clips at ~30 s and
paid at a few minutes; Google Photos allows 10 GB per video; iCloud has no per-item cap.

| Tier | Option | Per clip | Volume | Yearly cost at heavy use | Notes |
| --- | --- | --- | --- | --- | --- |
| Free | **Chosen by the user (Q1 + Q3)** | 60 s, 250 MB | 100 videos inside 1,000 items | worst case 25 GB originals + ~4 GB renditions ≈ $2.6/yr per free family | 250 MB admits a 1-minute 4K30 clip; rendition makes playback cheap |
| Free | Lean | 30 s, 100 MB, rendition only (original dropped) | 50 videos | ≈ 0.5 GB | breaks "originals never modified" and export of originals; not recommended |
| Free | Count only (user's rule alone) | 60 s, 250 MB | none beyond 1,000 items | worst case 250 GB per free family ≈ $22/yr for $0 revenue | abuse vector; hence Q3 |
| Plus | **Chosen by the user (Q2 + Q4)** | 5 min, 2 GB, original kept (4K ok) | 200 GB soft fair-use, report only | 200 GB ≈ $18/yr ≈ 38 % of revenue at the cap; a typical family (1–2 GB/month) ≈ $2/yr | 2 GB = 5 min of 4K60; a 5-min 4K clip transcodes in ~5–10 CPU-minutes |
| Plus | Orchestrator's first default | 10 min, 4 GB | 200 GB | same per-GB cost, twice the per-clip worst case | rejected by the user (2026-10-11) |
| Plus | Generous | 20 min, 8 GB | 500 GB | ≈ $45/yr at cap (loss) | only with a priced storage add-on later |

Outcome: **Free 60 s / 250 MB / 1 = 1 item with a 100-video sub-cap; Plus 5 min / 2 GB with
originals at full resolution and a 200 GB fair-use column in the report.** Revisit after a month
of real usage data in the report's new columns; raising Plus to 10 min / 4 GB later is a
constants-and-CHECK change (`VIDEO_LIMITS`, `upload_files.declared_bytes`, `import_items.bytes`).

### 5.2 Architecture decisions (architect defaults; the orchestrator confirms or overrides — the user's Q1–Q9 are in section 0)

- **D1 Videos are rows of `photos`** (`media_kind`), not a new table. Every rule that must apply
  to videos already lives on `photos` (RLS, pool and pending caps, approval, trash/purge, sharing
  gate, export, timeline keyset, dedupe index). A separate table would duplicate ~15 policies and
  triggers. Column names stay (`photos`, `photo_*`); DTOs say "item" in copy.
- **D2 Poster served as `thumb`/`display`/`analysis`**, so grids, viewers, share links, AI
  eligibility and the no-metadata checks work with no kind-specific code. New kinds only for the
  rendition (`web`) and the AI keyframes.
- **D3 One progressive MP4 rendition, no HLS.** Clips are ≤ 5 min and MinIO serves byte ranges;
  HLS would add segment objects, a packager and playlist signing for no v1 benefit. Revisit if
  clips get longer or seeking on cellular is poor.
- **D4 Transcode is a separate job** (`video.transcode`, concurrency 1) so `photo.ingest` keeps
  the < 5 s thumbnail target and a 4K clip never blocks photo ingests. AI waits for `ready`.
- **D5 Originals are staged on a disk-backed scratch mount; ffmpeg never sees a URL** (no
  signature can leak through ffmpeg's stderr, and MOVs with a trailing `moov` need a seekable
  input). Q8.
- **D6 HEVC is always transcoded** (Chrome/Firefox/Android WebView lack HEVC); H.264 ≤ 1080p
  sources are remuxed (fast, lossless). HDR is tone-mapped when libzimg is present.
- **D7 Free originals are kept.** Dropping them would save ~60 % but violates FR-6.1/FR-10.1 and
  the user's "stored as the original plus a 1080p rendition".
- **D8 Share-link downloads give the rendition**, never the original (same as photos' display
  copy, step-8 D9). Q9.
- **D9 Renditions are backed up off-site** (simplest restore). Flag if B2 cost matters more than
  restore time.
- **D10 Live Photos: still only.** The paired MOV would double items and confuse the pool; a
  later step can attach it as a derivative of the photo row (roadmap). Q5.
- **D11 Audio is kept in the rendition but never transcribed or sent to a model.** Q7.
- **D12 Near-duplicate flags compare posters with videos only** (a photo and a clip's first frame
  are often near-identical by design).

### 5.3 Risks

- **Cloudflare**: all playback bytes traverse the tunnel. Cloudflare's current terms allow video
  on the proxy, subject to fair use; a few families' worth is fine, but watch the dashboard and
  keep the "Bypass cache" rule for `files.`. The 100 s origin timeout means a 16 MiB part needs
  ≥ 1.4 Mbps; the client's part retry (3 attempts) covers hiccups, and a part-size drop to 8 MiB
  for cellular is a one-constant change if needed.
- **Worker CPU and memory**: libx264 1080p `veryfast` runs ~2–4× realtime on 4 cores for a 1080p
  source and ~0.5–1× for 4K60 HEVC decode; a 5-min 4K clip can occupy the worker for 5–10 min.
  Concurrency 1 and the per-job timeout bound it; the heartbeat alerts on a long queue. Scale
  with `--scale worker=2` only if the host has the cores.
- **Scratch disk**: a 2 GB original + ~1 GB rendition per job; the job defers below 6 GB free
  and the sweep cleans leftovers; the 80 % disk alert covers `STORAGE_PATH`, not scratch — the
  heartbeat gains a scratch statfs.
- **Alpine ffmpeg build flags** (libzimg for tone-mapping, libx264) — verified in 12.3; fallback
  documented.
- **iOS background ranged uploads**: per-part temp files in `Caches` can accumulate if the app is
  killed mid-upload; the uploader prunes `parts/` on launch. Simulator cannot test cellular
  switching (Q6) — real-device item.
- **Timeline keyset and `sort_at`** are unaffected; grids with mixed media must keep paint
  containment (perf spec runs unchanged).
- **Migration 22 redefines two functions from earlier migrations** (`import_book_photo`,
  `ai_eligible_photos`); down must restore both verbatim (hand check in 12.2).
- **Beta/unverified**: real Google Picker video download (`=dv`) semantics and whether
  `mediaFileMetadata.videoMetadata` exists on Picker items — first live run confirms; the fake
  mirrors the documented shape.

### 5.4 Deferred (record in `docs/PROGRESS.md`)

Live Photo pairing; HLS; audio transcription; per-family storage add-on pricing; cellular part
size tuning; Android album sync (roadmap); video trimming in-app; chapter/scene keyframe
selection instead of fixed 25/50/75 %.
