# Step 10 plan: Photo import (Apple Photos album sync on iPhone; Google Photos Picker import)

Status: proposed (architect, 2026-10-10). Not a PRD build-order step: this is the feature the user
asked for after step 9 ("Add this feature at the end, to automatically import photos with metadata
from a google photos or apple photos album"). It starts after the review-fix batch
(`docs/plans/review-fixes.md`) is committed: migrations start at `1792300000300_…`, worker queues
follow 14, and every import path that creates an approved photo must satisfy the new
`photos_authenticated_insert` check (`approved_by = auth_uid()`) and `photos_user_update_guard`.

PRD sections implemented or touched: FR-2.1/2.2 (bulk selection from the camera roll; direct
client → object storage, resumable, background on mobile), FR-2.3 (JPEG/PNG/HEIC/WebP; original
kept untouched), FR-2.4 (progress, retry, summary), FR-2.5 (SHA-256 + pHash dedupe), **FR-2.6
("Optional auto-backup: new camera-roll photos are queued for upload on Wi-Fi (user opt-in)", P2 —
the Apple album sync is this requirement narrowed to one album)**, FR-2.7 (contributor uploads land
in the approval queue), FR-4.1–4.4 (EXIF, age, GPS encrypted, derivatives stripped), FR-5.8 /
"Cost controls" (AI only for paid babies — **this step makes no model call and changes nothing in
the AI gate**), FR-6.1, "Roles and permissions", "Non-functional requirements → Privacy and child
safety / Compliance / Security", "Mobile and Capacitor → Capacitor plugins" ("Request limited/full
Photos access"), "App store requirements" (usage strings, privacy manifest, Data Safety),
"Environment variables" (`GOOGLE_*`), "Conventions" (zod everywhere; never log photo bytes, GPS,
prompts; reversible migrations; RLS changes need a test).

`CLAUDE.md` clarifications applied: storage is MinIO everywhere; AI is paid-tier only and
free-tier photos are never sent to a model (imports flow into the existing ingest → reindex path,
whose plan gate is unchanged); never log photo bytes, GPS or parent notes (extended here to OAuth
tokens, Google media URLs and PhotoKit paths); dev stack stays zero-setup (Google import runs
against a **fake Picker server** in dev, no credentials). User memory applied: no per-step reviewer
pass; dev defaults to fake providers, real runs on demand; `docs/DESIGN.md` screenshot check
before any UI commit; cloudflared runs outside Compose.

User decisions already taken (2026-10-09): build both (1) **Apple Photos album sync, iPhone only
(PhotoKit)**: one album, automatic on open / foreground / `BGAppRefreshTask` (best effort), full
metadata (original bytes, HEIC kept, EXIF, GPS, capture date), through the existing upload →
dedupe → ingest pipeline with the in-house `TinyglowUploader`; (2) **Google Photos import via
the Google Photos Picker API** (web + Android + iPhone), per-batch picking (not automatic),
originals downloaded with metadata, same pipeline, built and tested against a fake Picker server,
real use waiting on the user's Google Cloud credentials. **Permission:** full Photos-library
access is requested only when a parent turns on album sync; the existing picker upload stays as
is; privacy manifest, App Store privacy label, review notes and `NATIVE.md` are updated.

What exists and is reused (verified in the repo):
- Upload pipeline: `POST /babies/:id/uploads` → `POST /uploads/:sid/files` (≤ 100 per request,
  ≤ 500 per session, `clientSha256` instant-duplicate pre-check against live photos of the baby)
  → presigned part PUTs → `POST …/complete` (server lists parts, inserts `photos` under the
  uploader's claims: admin ⇒ `approved`, contributor ⇒ `pending`; the review batch pins
  `approved_by = auth_uid()`) → `photo.ingest` after commit (`apps/api/src/uploads/service.ts`).
  Worker ingest: sniff, SHA-256 (unique per baby, `photos_baby_id_sha256_key`), pHash, EXIF
  whitelist, GPS encrypted + Home label, derivatives without metadata, CSAM seam, quarantine.
- Client: `UploadManager` (`apps/mobile-web/src/lib/upload/manager.ts`) with `addNative(babyId,
  refs, details)`, `NativeFileRef {path,name,mime,size}`, `Uploader.putFile` (native background
  PUT), `copyIntoUploadCache`/`deleteNativeCopy` (`platform/native/files.ts`), `pickPhotos` via
  `@capawesome/capacitor-file-picker` (`skipTranscoding: true`, originals).
- iOS: `TinyglowUploader.swift` (background `URLSession` `com.tesarsoft.tinyglow.upload`,
  `handleEventsForBackgroundURLSession` in `AppDelegate`), `FreshInstall` Keychain wipe,
  `excludeFromBackup()` for `Caches/ll-*`, `Info.plist` + `Info-Debug.plist` kept equal except two
  keys (`check-ios-plists.ts`), `PrivacyInfo.xcprivacy` (Photos, Precise Location declared).
- Secure store `ll.session.v1` (Keychain, `afterFirstUnlockThisDeviceOnly`), `NativeEvents`
  (`appUrlOpen`, `resume`), `bootstrapNative()`.
- Server: `withClaims`/`withServiceRole(app, reason, fn)`, `requireConsent`, `audit()` with strict
  metadata, in-memory `createThrottle`, `redactUrl`, pino redaction; worker `runAsPipeline(pool,
  {dataKey})`, `ObjectStorage.putObjectStream/deleteAllVersions`, `wrapHandler`, `run-job` CLI,
  demo-media renderer (sharp) in the worker image; `encrypt_coord`/`decrypt_coord` with the
  `app.data_key` transaction-local GUC; `export_requester_email()` pattern (SECURITY DEFINER,
  pipeline-only, returns NULL unless the row is in the right state and the requester still an
  admin).
- Gates: `e2e/native/ios-gate.sh` + XCUITest bundle `e2e/native/ios-uitest` (drives the app and
  SpringBoard by bundle id), `e2e/helpers/{api,db,mailpit,native}.ts`, HEIC fixtures in
  `e2e/fixtures/heic/` (`gps-640x480.heic`, `datetime-tz.heic`, `plain-640x480.heic`, …),
  `scan-logs-for-secrets.mjs`, `check-compose-keys.mjs`.

## 1. Goal

Let a parent fill the album from where their photos already are, without changing how photos are
stored, deduplicated, analysed or shared. On iPhone, an admin picks one Apple Photos album; from
then on the app imports every new photo of that album (original bytes, HEIC kept, EXIF, GPS,
capture date) whenever it launches, returns to the foreground, gets background-refresh time, or
the parent taps "Sync now" — through the existing upload session / SHA-256 pre-check / background
PUT / ingest pipeline, Wi-Fi only by default, never deleting anything from Tinyglow, with the
PhotoKit identifiers kept only on the device and the server holding just per-device sync status.
On web, Android and iPhone, any member connects their Google account once (server-side OAuth,
refresh token encrypted at rest, `photospicker.mediaitems.readonly` only), then picks photos in
Google's own Picker per batch; the worker downloads the originals (Google keeps EXIF capture date
and camera but **strips GPS from every download**) and books them for the requester under the
same approval, free-tier and dedupe rules, with a fake Picker server for dev, CI and the gates.
The full-library Photos permission is requested only when album sync is turned on; the privacy
manifest, App Store privacy label, Data Safety answers, review notes and `NATIVE.md` say so.

## 2. Interfaces first

### 2.1 Topology

```
iPhone  TinyglowPhotoSync (Swift, PhotoKit) ── listPendingAssets/exportAssets(sha256) ──▶ src/platform/native/photoSync.ts
        BGAppRefreshTask "com.tesarsoft.tinyglow.sync" ── event backgroundSync ──▶ photoSync.runSync('background')
        photoSync ──▶ UploadManager.addNative(lane:'sync', wifiOnly) ──▶ existing /uploads/* + TinyglowUploader (Wi-Fi-only session)
        photoSync ──▶ POST/PATCH /import-sources (status counters only; no PHAsset ids)

web / Android / iPhone  "Connect Google Photos" ──▶ POST /me/import/google/connect ──▶ system browser (Google consent)
        Google ──▶ GET /api/import/google/callback ──▶ refresh token encrypted (service_role) ──▶ /import/google/connected
        "Choose photos" ──▶ POST /babies/:id/imports/google ──▶ Picker session ──▶ system browser (pickerUri)
        client polls GET /imports/:id ──▶ api polls Google (≥ pollInterval) ──▶ queued ──▶ job import.google
        worker: list mediaItems ──▶ download baseUrl=d (allow-listed hosts) ──▶ sha256 ──▶ MinIO originalKey ──▶ import_book_photo() ──▶ photo.ingest
dev:    google-fake (worker image, :8099): consent page, token endpoint, picker page, sessions, mediaItems, media bytes
```

No new service in production. Dev gains one Compose service (`google-fake`, the worker image with
another command). New client dependency: `@capacitor/browser` (D16). No new server dependency.

### 2.2 Database (security-engineer): one migration `1792300000300_photo-import.sql`

Conventions as before: reversible; `ENABLE` + `FORCE` RLS on every new table; policies `TO
<role>`; column grants; SECURITY DEFINER functions with pinned `search_path` and `REVOKE … FROM
PUBLIC`; fixed error messages that never echo a row; every policy tested (10.13). `pgmigrations`
becomes **20**.

**Secrets at rest** (pgcrypto, same key mechanism as coordinates):

```sql
CREATE FUNCTION public.encrypt_secret(p text) RETURNS bytea  -- pgp_sym_encrypt(p, current_setting('app.data_key'))
CREATE FUNCTION public.decrypt_secret(p bytea) RETURNS text  -- pgp_sym_decrypt(p, current_setting('app.data_key'))
-- STRICT, SECURITY DEFINER, search_path pinned; EXECUTE to service_role and pipeline only.
```

**`import_sources`** (Apple album sync status; one row per device × baby):

```sql
CREATE TABLE public.import_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id         uuid NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('apple_photos')),
  device_id       uuid NOT NULL,                       -- per-install id (Keychain), not the push device
  device_label    text NOT NULL,                       -- "Dad's iPhone" (≤ 60, shape trigger)
  album_title     text NOT NULL,                       -- Apple album title (≤ 120, shape trigger)
  wifi_only       boolean NOT NULL DEFAULT true,
  paused          boolean NOT NULL DEFAULT false,
  last_sync_at    timestamptz,
  last_trigger    text CHECK (last_trigger IN ('launch','resume','manual','background')),
  imported_count  integer NOT NULL DEFAULT 0, duplicate_count integer NOT NULL DEFAULT 0,
  failed_count    integer NOT NULL DEFAULT 0, skipped_count integer NOT NULL DEFAULT 0,
  last_error      text CHECK (last_error IN ('free_tier_limit','permission_denied','album_missing',
                                              'network','storage_error','baby_trashed','signed_out')),
  created_at      timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, baby_id, kind)
);
```

- Grants. `authenticated`: SELECT all; INSERT `(baby_id, user_id, kind, device_id, device_label,
  album_title, wifi_only)`; UPDATE `(device_label, album_title, wifi_only, paused, last_sync_at,
  last_trigger, imported_count, duplicate_count, failed_count, skipped_count, last_error,
  updated_at)`; DELETE. `pipeline`: nothing (the worker never touches Apple sync). `viewer`:
  nothing. `service_role`: ALL.
- Policies. SELECT `USING (user_id = auth_uid() OR is_baby_admin(baby_id))` (both admins see every
  device's sync status; a contributor sees only their own rows). INSERT `WITH CHECK (user_id =
  auth_uid() AND is_baby_member(baby_id) AND (kind <> 'apple_photos' OR is_baby_admin(baby_id)))`
  (**D1: Apple sync is admin-only**). UPDATE `USING/WITH CHECK (user_id = auth_uid())`. DELETE
  `USING (user_id = auth_uid() OR is_baby_admin(baby_id))`.
- Triggers: `import_sources_shape` (parent text: trimmed, no control characters, lengths; raise
  fixed messages like the step-5 `<table>_shape` triggers); `import_sources_cap` (≤ 10 per baby:
  'import source limit reached'); `import_sources_baby_live` ('cannot sync into a trashed album');
  `set_updated_at`.
- **Never stored**: PHAsset local identifiers, hashes of them, file names, paths (D3).

**`google_accounts`** (one Google connection per user):

```sql
CREATE TABLE public.google_accounts (
  user_id                 uuid PRIMARY KEY REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  refresh_token_enc       bytea NOT NULL,              -- encrypt_secret(refresh token)
  scope                   text NOT NULL,
  connected_at            timestamptz NOT NULL DEFAULT now(),
  last_used_at            timestamptz,
  refresh_failures        integer NOT NULL DEFAULT 0,
  needs_reconnect         boolean NOT NULL DEFAULT false,   -- invalid_grant seen (revoked / expired)
  updated_at              timestamptz NOT NULL DEFAULT now()
);
```

- Grants. `authenticated`: SELECT `(user_id, connected_at, last_used_at, needs_reconnect)` only,
  policy `USING (user_id = auth_uid())`; **no** INSERT/UPDATE/DELETE (the api writes and deletes
  under `service_role` because it must call `encrypt_secret` and revoke at Google first).
  `pipeline`: no table grant; it reads through `import_google_refresh_token()` only. `viewer`:
  nothing. `service_role`: ALL. `refresh_token_enc` is never granted to any user role.

**`import_batches`** and **`import_items`** (Google Picker imports):

```sql
CREATE TABLE public.import_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id              uuid NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  requested_by         uuid REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  kind                 text NOT NULL CHECK (kind IN ('google_picker')),
  status               text NOT NULL DEFAULT 'picking'
                       CHECK (status IN ('picking','queued','running','done','failed','cancelled','expired')),
  error                text CHECK (error IN ('google_denied','google_reconnect','session_expired','storage_error',
                                             'requester_not_member','baby_trashed','too_many_items','internal')),
  provider_session_id  text,                            -- Google Picker session id; not granted to users
  poll_interval_sec    integer NOT NULL DEFAULT 5 CHECK (poll_interval_sec BETWEEN 1 AND 60),
  picker_expires_at    timestamptz,
  last_polled_at       timestamptz,
  tz_hint              text,                            -- requester's profile time zone at creation
  items_total          integer, items_imported integer NOT NULL DEFAULT 0, items_duplicate integer NOT NULL DEFAULT 0,
  items_failed         integer NOT NULL DEFAULT 0, items_skipped integer NOT NULL DEFAULT 0,
  cancel_requested_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.import_batches (baby_id, created_at DESC);
CREATE INDEX ON public.import_batches (status) WHERE status IN ('picking','queued','running');

CREATE TABLE public.import_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- becomes photos.id (like upload_files)
  batch_id           uuid NOT NULL REFERENCES public.import_batches (id) ON DELETE CASCADE,
  baby_id            uuid NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  provider_item_id   text NOT NULL,                     -- Google mediaItem id (opaque); not granted to users
  mime_hint          text CHECK (mime_hint IN ('image/jpeg','image/png','image/heic','image/heif','image/webp')),
  width              integer, height integer,
  taken_at_hint      timestamptz,                       -- Google createTime
  bytes              bigint CHECK (bytes IS NULL OR (bytes > 0 AND bytes <= 104857600)),
  sha256             bytea CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','downloaded','booked','duplicate','failed','skipped')),
  error              text CHECK (error IN ('unsupported_media_type','file_too_large','download_failed',
                                           'free_tier_limit','storage_error','not_member','baby_trashed')),
  storage_key        text GENERATED ALWAYS AS ('babies/' || baby_id::text || '/originals/' || id::text) STORED,
  photo_id           uuid REFERENCES public.photos (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_items_photo_id_is_id CHECK (photo_id IS NULL OR photo_id = id),
  UNIQUE (batch_id, provider_item_id)
);
CREATE INDEX ON public.import_items (batch_id);
CREATE INDEX ON public.import_items (status) WHERE status IN ('pending','downloaded');
```

- Grants, `import_batches`. `authenticated`: SELECT every column **except**
  `provider_session_id`; INSERT `(baby_id, requested_by, kind, tz_hint)`; UPDATE `(status,
  provider_session_id, poll_interval_sec, picker_expires_at, last_polled_at, items_total,
  cancel_requested_at, finished_at, updated_at)` — the api writes the Google session id under the
  caller's claims right after creating it (INSERT grant too for `provider_session_id`, SELECT not
  granted). `pipeline`: SELECT all; UPDATE `(status, error, started_at, finished_at,
  items_total, items_imported, items_duplicate, items_failed, items_skipped, updated_at)`.
  `viewer`: nothing. `service_role`: ALL.
- Policies, `import_batches`. SELECT `USING (requested_by = auth_uid() OR is_baby_admin(baby_id))`.
  INSERT `WITH CHECK (requested_by = auth_uid() AND is_baby_member(baby_id) AND status =
  'picking')` (**contributors may import**; their photos land pending, D1). UPDATE `USING/WITH
  CHECK (requested_by = auth_uid())`. `pipeline` SELECT/UPDATE `USING (true)`.
- Trigger `import_batches_user_transitions` BEFORE UPDATE, fires only when `current_user =
  'authenticated'`: allowed `OLD.status → NEW.status`: `picking → picking | queued | cancelled |
  expired`; `queued | running → same` (only `cancel_requested_at` may change); anything else
  raises 'import batch transition not allowed'. Counters and `error` are pipeline-only columns.
- Trigger `import_batches_one_active` BEFORE INSERT: raise 'an import is already in progress for
  this album' when a `picking|queued|running` batch exists for the baby; 'import rate limit
  reached: 20 per album per day' when ≥ `IMPORT_BATCHES_PER_BABY_PER_DAY` rows in 24 h;
  'cannot import into a trashed album'.
- Grants, `import_items`. `authenticated`: SELECT `(id, batch_id, baby_id, status, error,
  photo_id, created_at)` via `import_batch_visible(batch_id)` (SECURITY INVOKER, like
  `upload_session_visible`); no INSERT/UPDATE/DELETE. `pipeline`: INSERT, SELECT all, UPDATE
  `(bytes, sha256, status, error, photo_id, mime_hint, width, height, taken_at_hint, updated_at)`,
  DELETE `USING (status IN ('duplicate','failed','skipped') AND updated_at < now() - interval '30 days')`.
- Function `import_google_refresh_token(p_batch_id uuid) RETURNS text` SECURITY DEFINER, EXECUTE
  to `pipeline` only: returns `decrypt_secret(refresh_token_enc)` of the batch's requester **only**
  when the batch `status IN ('queued','running')`, the requester is still a member of the baby
  (`baby_members`), `profiles.deleted_at IS NULL` and `needs_reconnect = false`; else NULL. The
  caller never logs the value. Requires `app.data_key` in the transaction (the worker's
  `runAsPipeline(pool, {dataKey})`).
- Function `import_mark_reconnect(p_batch_id uuid) RETURNS void` for `pipeline`: sets
  `google_accounts.needs_reconnect = true, refresh_failures = refresh_failures + 1` for the
  requester after Google answered `invalid_grant`.
- Function `import_book_photo(p_item_id uuid) RETURNS text` SECURITY DEFINER, EXECUTE to
  `pipeline` only (**D10**). Reads the item (must be `downloaded` with `bytes`, `sha256`, `mime_hint`
  set) and its batch; then, in order: `profiles.deleted_at IS NULL` and a `baby_members` row for
  `(requested_by, baby_id)` ⇒ else `'not_member'`; `babies.deleted_at IS NULL` ⇒ else
  `'baby_trashed'`; inserts
  `photos (id, baby_id, uploaded_by, storage_key_original, mime, bytes, sha256, approval,
  approved_by, approved_at, taken_at, taken_at_estimated)` = `(item.id, baby_id, requested_by,
  item.storage_key, item.mime_hint, item.bytes, item.sha256, CASE role WHEN 'admin' THEN
  'approved' ELSE 'pending' END, CASE role WHEN 'admin' THEN requested_by END, CASE role WHEN
  'admin' THEN now() END, item.taken_at_hint, true)` — **this mirrors `photos_authenticated_insert`
  exactly: a contributor's import is `pending` with `approved_by NULL`; an admin's import is
  approved by themselves and nobody else; the free-tier trigger `photos_free_tier_cap` fires
  unconditionally** — catches `unique_violation` on `photos_baby_id_sha256_key` ⇒ `'duplicate'`,
  `check_violation` starting 'free tier photo limit' ⇒ `'free_tier_limit'`; on success sets
  `import_items.status = 'booked', photo_id = id` and returns `'booked'`. Any other outcome leaves
  the item `downloaded` for the worker to mark. Fixed messages, no row data.
- Grants audit for the worker (security-engineer verifies, adds missing `pipeline` SELECT):
  `import_batches`, `import_items`, `photos (id, baby_id, sha256, deleted_at, status)` for the
  pre-download duplicate check, `babies (id, deleted_at)`.
- Account deletion: `google_accounts`, `import_sources` cascade from `profiles`;
  `import_batches.requested_by` → NULL (the worker's next `import_book_photo` returns
  `'not_member'` and the batch fails `requester_not_member`). Baby purge: both tables cascade;
  objects under `babies/<id>/` are already prefix-deleted.
- Regenerate `packages/db/src/generated`; README rows (tables, who writes what, retention: items
  of finished batches 30 days, batches kept).

### 2.3 Shared contracts (`@tinyglow/shared`; architect-defined here, **backend-engineer writes in 10.2** with orchestrator approval)

- `src/jobs.ts`: `JOBS.importGoogle = "import.google"` (`importGoogleJobSchema = z.strictObject({
  batchId: z.uuid(), babyId: z.uuid() })`; `exclusive`, `singletonKey = batchId`, `retryLimit 2`,
  `retryDelay 60`, `expireInSeconds 7200`); `JOBS.importSweep = "import.sweep"`
  (`importSweepJobSchema = z.strictObject({})`, cron `37 * * * *`). Worker queues become **16**.
- `src/imports.ts` (new, browser-safe constants): `IMPORT_BATCH_MAX_ITEMS = 500` (parity with
  `UPLOAD_MAX_FILES_PER_SESSION`), `IMPORT_BATCHES_PER_BABY_PER_DAY = 20`,
  `IMPORT_BATCHES_PER_USER_PER_HOUR = 10`, `IMPORT_CONNECTS_PER_USER_PER_HOUR = 10`,
  `IMPORT_PICKER_POLL_MIN_SEC = 3`, `IMPORT_PICKING_TTL_MIN = 30`, `IMPORT_MAX_FILE_BYTES =
  UPLOAD_MAX_FILE_BYTES`, `IMPORT_SOURCES_PER_BABY_MAX = 10`, `IMPORT_DEVICE_LABEL_MAX = 60`,
  `IMPORT_ALBUM_TITLE_MAX = 120`, `SYNC_FOREGROUND_BATCH = 50`, `SYNC_BACKGROUND_BATCH = 25`,
  `SYNC_LANE_CONCURRENCY = 2`, `SYNC_ASSET_MAX_ATTEMPTS = 3`, `SYNC_MIN_INTERVAL_SEC = 60` (a
  resume within a minute of the last run does nothing), `SYNC_BG_TASK_ID =
  "com.tesarsoft.tinyglow.sync"`, `GOOGLE_PICKER_SCOPE =
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"`, `GOOGLE_ENDPOINTS = {
  AUTH: "https://accounts.google.com/o/oauth2/v2/auth", TOKEN:
  "https://oauth2.googleapis.com/token", REVOKE: "https://oauth2.googleapis.com/revoke", PICKER:
  "https://photospicker.googleapis.com" }`, `GOOGLE_MEDIA_HOST_SUFFIX_DEFAULT =
  "googleusercontent.com"`.
- `src/google-photos.ts` (new, browser-safe, zod + URL only): schemas of the Google payloads the
  server consumes — `googleTokenResponseSchema` (`access_token`, `expires_in`, `refresh_token?`,
  `scope`, `token_type`), `googleTokenErrorSchema` (`error`, `error_description?`),
  `pickerSessionSchema` (`id`, `pickerUri: z.url()`, `pollingConfig: { pollInterval: duration
  string, timeoutIn: duration string }`, `expireTime`, `mediaItemsSet: boolean`),
  `pickerMediaItemsPageSchema` (`mediaItems: [{ id, createTime, type: "PHOTO"|"VIDEO", mediaFile:
  { baseUrl: z.url(), mimeType, filename?, mediaFileMetadata?: { width?, height?, cameraMake?,
  cameraModel? } } }]`, `nextPageToken?`), `parseGoogleDuration("5s") → seconds`,
  `mediaDownloadUrl(baseUrl) = baseUrl + "=d"`, `isAllowedMediaUrl(url, hostSuffixes[]): boolean`
  (https only, host equals or ends with `.` + a suffix, no userinfo, no port, no IP literal).
- `src/api/imports.ts` (new DTOs): `importSourceKindSchema = z.enum(["apple_photos"])`,
  `syncTriggerSchema = z.enum(["launch","resume","manual","background"])`,
  `importSourceErrorSchema` (the `last_error` CHECK list), `importSourceSchema = z.strictObject({
  id, babyId, userId, userName: string|null, kind, deviceId, deviceLabel, albumTitle, wifiOnly,
  paused, isMine, isThisDevice: boolean, lastSyncAt|null, lastTrigger|null, importedCount,
  duplicateCount, failedCount, skippedCount, lastError|null, createdAt })`,
  `upsertImportSourceRequestSchema = z.strictObject({ kind, deviceId: z.uuid(), deviceLabel:
  trimmed 1..60, albumTitle: trimmed 1..120, wifiOnly: boolean })`,
  `patchImportSourceRequestSchema = z.strictObject({ albumTitle?, wifiOnly?, paused?, lastSyncAt?:
  isoDateTime, lastTrigger?, importedDelta?: int ≥ 0 ≤ 500, duplicateDelta?, failedDelta?,
  skippedDelta?, lastError?: importSourceError | null }).refine(not empty)`,
  `importSourcesListResponseSchema = { sources: array.max(50) }`, `importSourceResponseSchema = {
  source }`. Google: `googleConnectionSchema = z.strictObject({ available: boolean, connected:
  boolean, connectedAt|null, needsReconnect: boolean })`, `googleConnectRequestSchema =
  z.strictObject({ client: z.enum(["web","native"]), returnTo: z.enum(["/upload",
  "/settings/import"]).default("/upload") })`, `googleConnectResponseSchema = { url: z.url() }`,
  `importBatchStatusSchema`, `importBatchErrorSchema`, `importItemErrorSchema` (the CHECK lists),
  `importBatchSchema = z.strictObject({ id, babyId, kind: "google_picker", status, error|null,
  requestedBy|null, requestedByName|null, isMine, itemsTotal|null, itemsImported, itemsDuplicate,
  itemsFailed, itemsSkipped, pollIntervalSec, pickerExpiresAt|null, createdAt, startedAt|null,
  finishedAt|null })`, `importBatchCreateResponseSchema = { batch, pickerUri: z.url() }` (**the
  only response that carries `pickerUri`; never stored, never logged**), `importBatchResponseSchema
  = { batch }`, `importBatchesListResponseSchema = { batches: array.max(20) }`.
- `src/upload.ts`: nothing (keys reuse `originalKey`).
- `src/auth.ts`: `AUDIT_EVENTS` += `import.source_created`, `import.source_deleted`,
  `import.google_connected`, `import.google_disconnected`, `import.batch_created`,
  `import.batch_finished` (actor NULL, worker), `import.batch_cancelled`, `import.batch_failed`
  (actor NULL); `auditMetadataSchema` += `source_id: uuid?`, `batch_id: uuid?`, `kind: enum?`
  (`count`, `duplicates`, `failed`, `client` exist). Never a token, session id, URL, album title
  or device label.
- `src/env.ts`: `googleImportEnvSchema` (api **and** worker): `GOOGLE_IMPORT_PROVIDER:
  z.enum(["none","fake","live"]).default("none")`, `GOOGLE_IMPORT_CLIENT_ID?`,
  `GOOGLE_IMPORT_CLIENT_SECRET?` (both required when `live`), `GOOGLE_IMPORT_FAKE_URL`
  (internal base, default `http://google-fake:8099`, used only when `fake`),
  `GOOGLE_IMPORT_FAKE_PUBLIC_URL` (browser-facing base, api only, default
  `http://localhost:8099`), `GOOGLE_IMPORT_MEDIA_HOSTS` (comma list of host suffixes, default
  `googleusercontent.com`; in `fake` mode the fake host is added automatically), `IMPORT_CONCURRENCY`
  (worker, 1..4, default 2); `superRefine`: `fake` refused when `NODE_ENV=production` (like
  `PUSH_PROVIDER`); `live` without id + secret fails boot; errors name fields only.
- `src/native.ts`: `SYNC_BG_TASK_ID` re-export; `INSTALL_ID_KEY = "ll.install.v1"`,
  `SYNC_CONFIG_KEY = "ll.sync.v1"` (secure-store entry names).
- `src/telemetry.ts` / API redaction list: `TELEMETRY_SCRUB_PATTERNS` += Google access tokens
  (`ya29\.[A-Za-z0-9_-]+`), refresh tokens (`1//[A-Za-z0-9_-]+`), `googleusercontent\.com/[^\s"']+`,
  `photospicker\.googleapis\.com/v1/sessions/[^\s"']+`, `fake-(access|refresh|code)-[A-Za-z0-9]+`
  (the fake's token shapes), `/ll-uploads/[^\s"']+`.
- `index.ts` re-exports.

### 2.4 iOS native (mobile-engineer): `TinyglowPhotoSync` plugin, BGTask, Wi-Fi-only uploads, plists

New `ios/App/App/TinyglowPhotoSync.swift` (registered in `TinyglowViewController.capacitorDidLoad`
next to the uploader). JS name `TinyglowPhotoSync`. **Nothing in it logs or stores a path, a
file name, a URL or an asset identifier outside the ledger file.**

| Method | Returns | Behaviour |
| --- | --- | --- |
| `authorizationStatus()` | `{ status: "notDetermined" \| "restricted" \| "denied" \| "authorized" \| "limited" }` | `PHPhotoLibrary.authorizationStatus(for: .readWrite)` |
| `requestAuthorization()` | same | `requestAuthorization(for: .readWrite)` — the only level that lets the app enumerate albums; `limited` is returned as is (the UI explains sync needs full access and offers Settings) |
| `listAlbums()` | `{ albums: [{ id, title, count }] }` | user albums only (`.album` / `.albumRegular`), sorted by title; `id` = `localIdentifier` (**never sent to the server**) |
| `listPendingAssets({ albumId, limit })` | `{ assets: [{ id, createdAt: iso \| null }], remaining, albumExists }` | image assets of the album (`mediaType == .image`) not terminal in the ledger (`done`, `duplicate`, `skipped`) and with `attempts < 3`; newest `creationDate` first (D4) |
| `exportAssets({ ids })` | `{ files: [{ id, path, name, mime, size, sha256, takenAt: iso \| null }], failed: [{ id, reason: "unavailable" \| "icloud" \| "write" \| "unsupported" }] }` | writes the **original** resource (`PHAssetResourceType.photo`, D12) via `PHAssetResourceManager.writeData(for:toFile:)` into `Caches/ll-uploads/<uuid>.<ext>` with `isNetworkAccessAllowed = true` (iCloud originals), SHA-256 streamed with CryptoKit while writing, mime from the resource UTI (`heic`/`heif`/`jpeg`/`png`/`webp`; others ⇒ `unsupported`), `size` from the file, `takenAt` = `asset.creationDate`. `name` = `originalFilename` (used only as the item label in the UI; the server never receives file names) |
| `recordOutcomes({ albumId, outcomes: [{ id, outcome: "done" \| "duplicate" \| "failed" \| "skipped" }] })` | `{}` | ledger write; `failed` increments `attempts` (3 ⇒ `skipped`) |
| `ledgerSummary({ albumId })` | `{ done, duplicate, failed, skipped }` | |
| `resetLedger({ albumId? })` | `{}` | one album, or every ledger (sign-out, account deletion) |
| `conditions()` | `{ wifi: boolean, expensive: boolean, lowPowerMode: boolean, thermalState: "nominal" \| "fair" \| "serious" \| "critical" }` | `NWPathMonitor` snapshot + `ProcessInfo` |
| `scheduleBackgroundRefresh()` | `{}` | `BGTaskScheduler.submit(BGAppRefreshTaskRequest(SYNC_BG_TASK_ID))`, `earliestBeginDate` +30 min; errors swallowed (no logging of anything but the error code) |
| `completeBackgroundTask({ taskId, success })` | `{}` | `task.setTaskCompleted(success:)`; re-schedules |
| event `backgroundSync` | `{ taskId }` | emitted when the BG task fires (retained until JS listens, like `done`/`error` of the uploader); the native side arms `expirationHandler` ⇒ marks the task failed and emits `backgroundSyncExpired { taskId }` |

- Ledger: `Library/Application Support/ll-sync/<sha256(albumId) hex>.json` `{ v: 1, entries: {
  "<localIdentifier>": { o: "d"|"u"|"f"|"s", n: attempts } } }`, written atomically, file
  protection `completeUntilFirstUserAuthentication`, directory excluded from backup
  (`AppDelegate.excludeFromBackup()` adds `Application Support/ll-sync`). Identifiers never leave
  the device (D3).
- `AppDelegate`: `BGTaskScheduler.shared.register(forTaskWithIdentifier: SYNC_BG_TASK_ID)` in
  `didFinishLaunching` (before the scene exists), handler ⇒ `LLPhotoSync.shared.handle(task)`;
  `handleEventsForBackgroundURLSession` accepts both uploader identifiers (below).
- `TinyglowUploader.swift`: `upload({ url, path, wifiOnly? })`; when `wifiOnly` is true the
  task goes on a second background session `com.tesarsoft.tinyglow.upload.wifi`
  (`allowsCellularAccess = false`, otherwise identical). `cancel` searches both.
- Plists (**both** `Info.plist` and `Info-Debug.plist`, kept equal; `check-ios-plists.ts` still
  passes): `UIBackgroundModes = [fetch]`, `BGTaskSchedulerPermittedIdentifiers =
  [com.tesarsoft.tinyglow.sync]`, `PHPhotoLibraryPreventAutomaticLimitedAccessAlert = true`
  (the app presents its own flow), `NSPhotoLibraryUsageDescription` rewritten: "Tinyglow uses
  your photo library to upload the photos you choose. If you turn on album sync, it also imports
  new photos from the one album you pick, so you don't have to add them by hand." `project.pbxproj`:
  add the new Swift file; no new entitlement (Background Modes is a plist key).
- `PrivacyInfo.xcprivacy`: no new data type (Photos, Precise Location, User Content already
  declared) and no new required-reason API (PhotoKit is not one); mobile-engineer re-checks and
  records the result in `store/privacy-nutrition-label.md`.
- Android: nothing native. `@capacitor/browser` adds Custom Tabs via `cap sync`
  (`capacitor.build.gradle`, `Package.swift`); the manifest stays without media/location
  permissions (D9).

### 2.5 Web platform layer and upload manager (frontend-engineer, `apps/mobile-web/src/**`)

- `platform/uploader.ts`: `NativeFileRef` gains optional `sha256?: string` (lowercase hex) and
  `takenAt?: string` (ISO); `PutPartOptions.wifiOnly?: boolean`; `nativeUploader.putFile` passes
  `wifiOnly` to the plugin.
- `lib/upload/manager.ts`: `addNative(babyId, refs, details?, opts?: { lane?: "user" | "sync";
  wifiOnly?: boolean })`; `UploadItem.lane` (default `"user"`); prep skips `sha256Hex` and
  `readCaptureHint` when `ref.sha256` is present (sends `clientSha256`, `takenAt` hints; the
  server re-hashes and reads EXIF as always); the upload pump dequeues `user` items first and
  never runs more than `SYNC_LANE_CONCURRENCY` sync items at once; `waitForTerminal(clientIds):
  Promise<Map<clientId, ItemState>>`; `clearFinished(babyId, lane?)`; `summarize(items, lane?)`.
  The Upload screen lists `lane === "user"` only.
- `platform/native/installId.ts`: `getInstallId()` → secure-store `ll.install.v1` (uuid, created
  on demand; the fresh-install Keychain wipe makes a reinstall a new device, by design).
- `platform/native/photoSync.ts` (`PhotoSyncManager`, singleton, `useSyncStatus()` via
  `useSyncExternalStore`): local config in secure-store `ll.sync.v1` = `{ sourceId, babyId,
  albumId, albumTitle, wifiOnly, paused }` (album `localIdentifier` stays on the device). API:
  `authorization()`, `albums()`, `enable({ babyId, albumId, albumTitle, wifiOnly })` ⇒
  `requestAuthorization` (first time only — **the permission prompt happens here and nowhere
  else**) ⇒ `POST /babies/:id/import-sources` (upsert) ⇒ save config ⇒ `runSync("manual")`;
  `setPaused(bool)`, `setWifiOnly(bool)` ⇒ `PATCH`; `disable()` ⇒ `DELETE`, `resetLedger`, clear
  config; `runSync(trigger, { taskId? })` single-flight, no-op within `SYNC_MIN_INTERVAL_SEC` of
  the last run except `manual`:
  1. config present and signed in, else return (`signed_out` is written by the sign-out hook);
     `authorizationStatus` must be `authorized` else `PATCH { lastError: "permission_denied",
     paused: true }`; `conditions()`: skip when `lowPowerMode` or `thermalState ≥ serious`, or
     when `wifiOnly && !wifi` (status "Waiting for Wi-Fi"); `paused` ⇒ return.
  2. loop: `listPendingAssets({ limit: trigger === "background" ? SYNC_BACKGROUND_BATCH :
     SYNC_FOREGROUND_BATCH })`; `albumExists === false` ⇒ `PATCH { lastError: "album_missing",
     paused: true }`; none ⇒ done.
  3. `exportAssets` ⇒ `uploadManager.addNative(babyId, files, undefined, { lane: "sync", wifiOnly })`
     ⇒ `waitForTerminal` ⇒ `recordOutcomes` (`ingested`/`completed` ⇒ `done`; `duplicate` ⇒
     `duplicate`; `failed` + `free_tier_limit` ⇒ `failed` **and** stop the run with `lastError:
     "free_tier_limit"` (the assets stay pending; a later run after an upgrade retries them);
     other `failed` ⇒ `failed`; `unsupported` ⇒ `skipped`) ⇒ `PATCH` deltas + `lastSyncAt`,
     `lastTrigger`. Background runs do one batch then `completeBackgroundTask({ success: true })`;
     `backgroundSyncExpired` ⇒ stop after the current `recordOutcomes`.
  4. After every run `scheduleBackgroundRefresh()`.
- Hooks: `bootstrapNative()` registers the plugin listeners; `NativeEvents` adds `resume` ⇒
  `photoSync.runSync("resume")`, signed-in launch ⇒ `runSync("launch")` (after `me` resolves),
  `backgroundSync` ⇒ `runSync("background", { taskId })`; the sign-out path (`platform/native/
  cleanup.ts`) calls `photoSync.onSignOut()` ⇒ best-effort `PATCH { paused: true, lastError:
  "signed_out" }`, `resetLedger()`, clear config, `wipeNativeFiles()` (exists).
- Google (all platforms): `lib/googleImport.ts`: `connection()`, `connect(returnTo)` ⇒ `POST
  /me/import/google/connect` ⇒ web: `window.location.assign(url)`; native:
  `Browser.open({ url, presentationStyle: "popover" })` (**never the in-app WebView: Google
  refuses embedded user agents**); `startImport(babyId)` ⇒ `POST /babies/:id/imports/google` ⇒
  web: `window.open(pickerUri, "_blank", "noopener")`; native: `Browser.open`; `poll(batchId)`
  every `pollIntervalSec` while `picking|queued|running`; `cancel`; `disconnect`. On native,
  `Browser` `browserFinished` and app `resume` both trigger an immediate poll / connection
  re-check (no deep link needed, D15).

### 2.6 Import API (`apps/api/src/imports/**`, backend-engineer)

All routes: Auth (`requireAuth`), Consent, membership (404 `not_found` for strangers, the same
message as uploads), `baby.deleted_at` ⇒ 409 `baby_trashed`. Run under the caller's claims unless
stated. Logs carry ids, counts and error categories only.

| Method, path | Guards | Request → Response | Behaviour |
| --- | --- | --- | --- |
| `GET /me/import-sources?babyId=` | member | → 200 `importSourcesListResponseSchema` | rows visible under RLS, `LEFT JOIN member_profiles` for `userName`; `isThisDevice` is computed client-side from `deviceId` |
| `POST /babies/:id/import-sources` | **admin** (RLS; non-admin ⇒ 403 `parents_only`) | `upsertImportSourceRequestSchema` → 201/200 `importSourceResponseSchema` | `INSERT … ON CONFLICT (device_id, baby_id, kind) DO UPDATE SET device_label, album_title, wifi_only, paused = false, last_error = NULL` (same `user_id` only; a conflict with another user's row ⇒ 409 `import_source_exists`); audit `import.source_created {source_id, kind}` on insert; triggers map: 'limit reached' ⇒ 409 `import_source_limit`, 'trashed' ⇒ 409 `baby_trashed` |
| `PATCH /import-sources/:id` | owner (RLS UPDATE) | `patchImportSourceRequestSchema` → 200 | deltas applied as `col = col + $n` (no lost updates between devices), `lastError` nullable; 404 when RLS hides the row |
| `DELETE /import-sources/:id` | owner or baby admin | → 204 | audit `import.source_deleted {source_id}` |
| `GET /me/import/google/connection` | Auth | → 200 `googleConnectionSchema` | `available = GOOGLE_IMPORT_PROVIDER !== "none"`; row from `google_accounts` under claims (4 granted columns) |
| `POST /me/import/google/connect` | Auth, Consent, throttle 10/user/h, 404 `feature_unavailable` when provider `none` | `googleConnectRequestSchema` → 200 `googleConnectResponseSchema` | mints `state` = HS256 JWT (HKDF key `google-oauth-state` from `JWT_SECRET`, like the viewer JWT; `aud: tinyglow-google-state`, `sub: uid`, `sid`: GoTrue session id, `client`, `returnTo`, 10-min expiry, random `jti`); URL = `GOOGLE_ENDPOINTS.AUTH` (or `${FAKE_PUBLIC_URL}/o/oauth2/v2/auth`) with `client_id`, `redirect_uri = ${PUBLIC_URL}/api/import/google/callback`, `response_type=code`, `scope=GOOGLE_PICKER_SCOPE`, `access_type=offline`, `prompt=consent`, `include_granted_scopes=false`, `state` (D14) |
| `GET /import/google/callback?code&state` (also `?error=`) | **no session required** (the native flow lands in SFSafariViewController / Custom Tabs with no app credentials): the `state` JWT is the credential; its `sid` must still be a live GoTrue session (step-3 helper) | → 302 | `error=access_denied` ⇒ redirect `${PUBLIC_URL}/import/google/connected?status=denied&client=…`; else exchange `code` at `TOKEN` (`client_secret`, `grant_type=authorization_code`), require `refresh_token` present and the scope granted (else `status=scope_missing`), `withServiceRole(app, "google import connect", …)`: `INSERT … google_accounts (user_id, refresh_token_enc = encrypt_secret($1), scope) ON CONFLICT (user_id) DO UPDATE …, needs_reconnect = false, refresh_failures = 0` with the data-key GUC bound; audit `import.google_connected`; redirect `…/connected?status=ok&client=<web|native>&returnTo=<allow-listed>`. The code, tokens and `state` are never logged (`redactUrl` drops query strings) |
| `DELETE /me/import/google/connection` | Auth, Consent | → 204 | service_role: read `refresh_token_enc`, decrypt, `POST REVOKE token=…` (best effort, 5 s timeout), `DELETE` the row; audit `import.google_disconnected`; also cancels this user's `picking` batches (deletes their Google sessions best effort) |
| `POST /babies/:id/imports/google` | member, Consent, throttle 10/user/h, provider ≠ `none` | `{}` → 201 `importBatchCreateResponseSchema` | `connected` else 409 `google_not_connected`; `needs_reconnect` ⇒ 409 `google_reconnect`; access token: service_role decrypt + `POST TOKEN grant_type=refresh_token` (**held in memory for this request only**; `invalid_grant` ⇒ set `needs_reconnect`, 409 `google_reconnect`); `POST ${PICKER}/v1/sessions` ⇒ under claims `INSERT import_batches (baby_id, requested_by, kind, tz_hint = profiles.timezone)` then `UPDATE provider_session_id, poll_interval_sec = max(IMPORT_PICKER_POLL_MIN_SEC, pollInterval), picker_expires_at = min(expireTime, now() + IMPORT_PICKING_TTL_MIN)`; triggers map: 'already in progress' ⇒ 409 `import_in_progress`, 'rate limit' ⇒ 429 `rate_limited`; audit `import.batch_created {batch_id, kind}`; response carries `pickerUri` once |
| `GET /imports/:batchId` | requester or admin (RLS) | → 200 `importBatchResponseSchema` | when `status = picking` and `now() - last_polled_at ≥ poll_interval_sec`: `GET ${PICKER}/v1/sessions/{id}` (access token as above); `mediaItemsSet` ⇒ `UPDATE status = 'queued'` under claims, then after commit `app.jobs.enqueueImportGoogle({ batchId, babyId })` (a failed enqueue leaves `queued`; `import.sweep` re-sends); `picker_expires_at < now()` ⇒ `expired` + `DELETE` the Google session; a Google 404 on the session ⇒ `expired`. `logLevel: "warn"` like the upload poll |
| `POST /imports/:batchId/cancel` | requester | → 200 `importBatchResponseSchema` | `picking` ⇒ `DELETE` Google session, status `cancelled`; `queued|running` ⇒ `cancel_requested_at = now()` (the worker stops after the current item and finishes as `cancelled`); audit `import.batch_cancelled {batch_id}` |
| `GET /babies/:id/imports?limit=10` | member | → 200 `importBatchesListResponseSchema` | admins see every batch, contributors their own (RLS) |

- `apps/api/src/imports/google/client.ts`: plain `fetch` with 15 s timeouts, base URLs from
  config (`fake` ⇒ `GOOGLE_IMPORT_FAKE_URL`), responses validated with the shared schemas, errors
  mapped to categories (`google_denied`, `google_reconnect`, `network`, `rate_limited`,
  `internal`); the Authorization header value never enters a log line or an error message.
- `plugins/jobs.ts`: `enqueueImportGoogle(job)` with `IMPORT_GOOGLE_SEND_OPTIONS` (`singletonKey
  = batchId`, `retryLimit 2`, `retryDelay 60`, `expireInSeconds 7200`); stub branch in
  `withAllSenders`.
- `app.ts`: `importsRoutes(app)`; pino `redact` += `req.headers.authorization` (exists),
  `*.refresh_token`, `*.access_token`, `*.code`, `*.pickerUri`, `*.baseUrl`; `config.ts` composes
  `googleImportEnvSchema`; `lib/errors.ts` new codes: `feature_unavailable`,
  `google_not_connected`, `google_reconnect`, `import_in_progress`, `import_source_exists`,
  `import_source_limit`.
- `apps/api/src/imports/google/connection.ts` exports `revokeGoogleConnection(app, uid):
  Promise<void>` (best effort; swallows errors; logs `{ revoked: boolean }`) for the account
  deletion hook (2.8).

### 2.7 Worker (`apps/worker/src/import/**`, backend-engineer)

- `import.google` handler, `batchSize 1`, as `pipeline` via `runAsPipeline(pool, { dataKey })`
  (the data key is needed only by `import_google_refresh_token()`; the worker never sees
  `refresh_token_enc`):
  1. Claim: `UPDATE import_batches SET status = 'running', started_at = COALESCE(started_at,
     now()) WHERE id = $1 AND status IN ('queued','running') RETURNING …`; 0 rows ⇒ return.
  2. Token: `SELECT import_google_refresh_token($1)`; NULL ⇒ fail `requester_not_member` (or
     `google_reconnect` when `needs_reconnect`); refresh at `TOKEN` ⇒ access token in memory;
     `invalid_grant` ⇒ `import_mark_reconnect($1)`, fail `google_reconnect`.
  3. List: `GET /v1/mediaItems?sessionId=…&pageSize=100` (+ `pageToken`) until done or
     `IMPORT_BATCH_MAX_ITEMS` reached (the rest ⇒ `items_skipped`, batch `error` stays NULL but
     the UI shows "only the first 500 were imported" from `too_many_items` on the batch when any
     were dropped — set `error = 'too_many_items'` only if **zero** items could be taken);
     `type = VIDEO` or a `mimeType` outside the accepted five ⇒ item `skipped /
     unsupported_media_type`; `INSERT import_items … ON CONFLICT (batch_id, provider_item_id) DO
     NOTHING` with `mime_hint`, `width`, `height`, `taken_at_hint = createTime`; `items_total` set.
     **`baseUrl`s are kept in memory for this run only** (they are valid ~60 min; a retried job
     re-lists the session).
  4. Pre-check: items whose `provider_item_id` already has a `booked|duplicate` row are skipped
     (idempotent retry).
  5. Download, `IMPORT_CONCURRENCY` items at a time: `isAllowedMediaUrl(baseUrl, hosts)` else
     `failed / download_failed` (never fetched — SSRF guard, D6); `GET mediaDownloadUrl(baseUrl)`
     with `Authorization: Bearer`, `redirect: "manual"` (a redirect to a non-allow-listed host is a
     failure), 60 s timeout; stream to `os.tmpdir()/ll-import/<itemId>` while hashing (SHA-256)
     and counting bytes; `Content-Length` or counted bytes > `IMPORT_MAX_FILE_BYTES` ⇒ abort,
     `failed / file_too_large`, temp file removed; sniff the first bytes with the existing
     `sniff` (file-type) ⇒ unsupported ⇒ `skipped / unsupported_media_type`; **the decoded image
     is never logged, never passed to any model**.
  6. Duplicate pre-check (saves the PUT): `SELECT 1 FROM photos WHERE baby_id = $1 AND sha256 =
     $2 AND deleted_at IS NULL AND status <> 'duplicate'` ⇒ item `duplicate` (+ `items_duplicate`),
     temp file removed.
  7. `putObjectStream(storage_key, stream, mime)` ⇒ `UPDATE import_items SET status =
     'downloaded', bytes, sha256, mime_hint = sniffed` ⇒ `SELECT import_book_photo($1)`:
     `'booked'` ⇒ `enqueueIngest({ photoId: itemId, babyId, tzHint })` (`items_imported`);
     `'duplicate'` (race) ⇒ `deleteAllVersions(storage_key)`, item `duplicate`;
     `'free_tier_limit'` ⇒ delete object, item `failed / free_tier_limit` **and stop the batch**
     (remaining items `failed / free_tier_limit`, no further downloads); `'not_member'` /
     `'baby_trashed'` ⇒ delete object, batch fails `requester_not_member` / `baby_trashed`.
     Temp file removed in `finally`.
  8. Between items: re-read `cancel_requested_at` ⇒ finish as `cancelled`.
  9. Finish: `status = 'done'` (or `failed` with `error`), `finished_at`; `DELETE
     /v1/sessions/{id}` best effort; audit `import.batch_finished {batch_id, count: imported,
     duplicates, failed}` (actor NULL, `baby_id` set) or `import.batch_failed {batch_id}`. The job
     rethrows only for `storage_error`/network categories (pg-boss retries twice).
- `import.sweep` (cron `37 * * * *`, `exclusive`): `picking` batches past `picker_expires_at` ⇒
  `expired` (+ Google `DELETE` best effort, needs a token: skip the delete when the requester's
  token is unavailable); `queued` batches older than 10 min with no active job ⇒ re-send the job;
  `running` batches with `updated_at` older than 2 h ⇒ `failed / internal`; `downloaded` items
  older than 1 h with no photo row ⇒ `deleteAllVersions(storage_key)`, item `failed /
  storage_error`; temp dir leftovers older than 1 h removed; `import_items` of finished batches
  older than 30 days deleted (policy). Heartbeat alert when the oldest `queued` batch is older than
  2 h (same channel as the AI queue-age alert).
- Logging: `{ batchId, babyId, itemId?, category, count, bytes, ms }` only. pino redact +=
  `*.baseUrl`, `*.pickerUri`, `*.access_token`, `*.refresh_token`, `*.authorization`. Worker
  `/tmp` must be writable (dev: it is; prod: devops verifies `read_only`/tmpfs, 2.9).
- `queues.ts`: 16 queues (`import.google`, `import.sweep`), schedules += the sweep;
  `run-job import.google '{"batchId":…,"babyId":…}'` and `run-job import.sweep '{}'` work.

### 2.8 Account deletion hook (security-engineer, `apps/api/src/auth/account.ts`)

Before step (3) `gotrue.adminDeleteUser(uid)` of the review-fix order, call
`revokeGoogleConnection(app, uid)` (2.6) so the Google refresh token is revoked while the profile
still exists; the row then goes with the profile cascade. Failure to revoke never blocks the
deletion (logged as `{ revoked: false }`). The deletion preview lists "Google Photos connection"
when a row exists.

### 2.9 Fake Google Picker server (backend-engineer, `apps/worker/src/import/google/fake-server.ts`; CLI `pnpm --filter @tinyglow/worker google-fake`)

Plain `node:http`, in-memory state, port `GOOGLE_FAKE_PORT` (8099), used by dev Compose, unit and
integration tests (in-process on an ephemeral port) and the gates. It mimics only what the real
flow touches, with the **same shapes as the shared schemas**, and produces token values that match
the scrub patterns (`fake-access-…`, `fake-refresh-…`, `fake-code-…`) so log scans catch leaks.

| Path | Behaviour |
| --- | --- |
| `GET /healthz` | `{ status: "ok" }` |
| `GET /o/oauth2/v2/auth?client_id&redirect_uri&scope&state&…` | an HTML consent page (design-system-neutral, English): "Fake Google · Tinyglow wants to see photos you pick" with buttons **Allow** (`302 redirect_uri?code=fake-code-…&state=…`) and **Deny** (`?error=access_denied&state=…`); `?account=<name>` lets tests connect distinct fake users; `?scope_missing=1` grants without the picker scope |
| `POST /token` | `authorization_code` ⇒ `{ access_token: "fake-access-…", expires_in: 3600, refresh_token: "fake-refresh-…", scope, token_type: "Bearer" }`; `refresh_token` ⇒ new access token or `{ error: "invalid_grant" }` when revoked |
| `POST /revoke` | records the token in `/__fake/revocations` |
| `POST /v1/sessions` (Bearer required) | `{ id, pickerUri: "<public base>/picker/<id>", pollingConfig: { pollInterval: "3s", timeoutIn: "1800s" }, expireTime, mediaItemsSet: false }` |
| `GET /v1/sessions/:id`, `DELETE /v1/sessions/:id` | poll / delete (404 after delete) |
| `GET /v1/mediaItems?sessionId&pageSize&pageToken` | the picked items, paginated (`pageSize ≤ 100`) with `createTime`, `type`, `mediaFile { baseUrl: "<internal base>/media/<itemId>", mimeType, filename, mediaFileMetadata }` |
| `GET /picker/:sessionId` | an HTML picker page listing the catalogue with checkboxes and **Done** (sets `mediaItemsSet`); `?autopick=G-1,G-2,…` picks and completes without clicking (gates) |
| `GET /media/:itemId=d` (Bearer required) | the item bytes; `Content-Length` set; **no GPS in any file** (mirrors Google's stripping) |
| `GET /__fake/items`, `GET /__fake/items/:id` (no auth) | catalogue JSON / raw bytes for test fixtures (dev/test only) |
| `POST /__fake/revoke-all`, `GET /__fake/revocations`, `GET /__fake/requests` (methods + paths only, never headers) | test hooks |

Catalogue (rendered at start with sharp, the way `demo-media` draws illustrations; EXIF written
with `withExif`: `Make "Fake"`, `Model "Picker"`, `DateTimeOriginal` 2026-03-01 + i days 10:00,
`OffsetTimeOriginal "+01:00"`; **never a GPS IFD**): `G-1 … G-8` JPEG photos (640×480 / 480×640),
`P-1` PNG, `W-1` WebP, `V-1` a `type: VIDEO` item, `X-1` an item whose `Content-Length` header
claims 200 MiB (the body is cut after 1 MiB) for the size guard, `H-1` the committed
`e2e/fixtures/heic/plain-640x480.heic` bytes **only when the file exists at
`FAKE_GOOGLE_FIXTURES_DIR`** (unit/integration tests pass it; the Compose service has no
fixtures and omits `H-1`). Refused in production: the CLI exits when `NODE_ENV=production`.

### 2.10 Env, Compose, CI (devops-engineer)

| Item | Change |
| --- | --- |
| `.env.dev` | `GOOGLE_IMPORT_PROVIDER=fake` documented (Compose interpolation default `fake`), `GOOGLE_FAKE_PORT=8099`, comments for `GOOGLE_IMPORT_CLIENT_ID/SECRET` (unset; a real dev run sets them plus `GOOGLE_IMPORT_PROVIDER=live` in `.env.local`), `IMPORT_CONCURRENCY=2` |
| `docker-compose.dev.yml` | new service `google-fake` (worker image, `command: ["pnpm","--filter","@tinyglow/worker","google-fake"]`, `ports: "${GOOGLE_FAKE_BIND:-127.0.0.1}:${GOOGLE_FAKE_PORT:-8099}:8099"`, env `GOOGLE_FAKE_PUBLIC_URL=http://localhost:${GOOGLE_FAKE_PORT:-8099}`, `GOOGLE_FAKE_INTERNAL_URL=http://google-fake:8099`, healthcheck `GET /healthz`, no DB/S3 env); `api` and `worker` get `GOOGLE_IMPORT_PROVIDER: ${GOOGLE_IMPORT_PROVIDER:-fake}`, `GOOGLE_IMPORT_FAKE_URL: http://google-fake:8099`, api `GOOGLE_IMPORT_FAKE_PUBLIC_URL: http://localhost:${GOOGLE_FAKE_PORT:-8099}`, `GOOGLE_IMPORT_CLIENT_ID/SECRET` from `.env.local` (empty = unset), worker `IMPORT_CONCURRENCY`; `depends_on: google-fake: service_healthy` for api and worker **only when provider is fake** (Compose cannot express that — make `google-fake` always start in dev; it is tiny) |
| `.env.example`, `docker-compose.yml` | `GOOGLE_IMPORT_PROVIDER` (default `none`), `GOOGLE_IMPORT_CLIENT_ID`, `GOOGLE_IMPORT_CLIENT_SECRET` → **api and worker only** (`check-compose-keys.mjs` learns the two names), `IMPORT_CONCURRENCY` (worker); no fake service in production; worker `tmpfs: /tmp:size=2g` if the service is `read_only` (verify; the download staging needs ≤ `IMPORT_CONCURRENCY × 100 MiB`) |
| Android dev | `NATIVE.md` adds `adb reverse tcp:8099 tcp:8099` |
| CI (10.14) | `import-hygiene.sh`: no `console.log`/`log.*(baseUrl|pickerUri|refresh_token|access_token)` under `apps/api/src/imports`, `apps/worker/src/import`, `apps/mobile-web/src/platform/native/photoSync.ts`; no `print(`/`NSLog(` in `TinyglowPhotoSync.swift`; both iOS plists carry `UIBackgroundModes` + `BGTaskSchedulerPermittedIdentifiers`; `loggingBehavior: "none"` unchanged; `GOOGLE_IMPORT_CLIENT_SECRET` reaches api + worker only; `@capacitor/browser` is the only new dependency (lockfile diff of `package.json` names). Dev-stack job: `google-fake` healthy, `pnpm e2e:import-gate` + log scan; `scan-logs-for-secrets.mjs` patterns of 2.3 |

### 2.11 Frontend screens (frontend-engineer, `apps/mobile-web/src/**`; `docs/DESIGN.md`)

- **Upload screen** (`pages/UploadPage.tsx`, native + web): under the existing picker actions, a
  secondary row "Import from Google Photos" (hidden when `connection.available === false`); on
  iOS (native, admin) a card **Album sync**: empty state "Keep an album in sync — new photos from
  one Apple Photos album are added automatically" + "Set up"; active state: album title, "Up to
  date · 1,240 imported" / "Syncing 12 of 50…" / "Waiting for Wi-Fi" / "Paused" / error copy
  (`free_tier_limit` ⇒ "Free album is full (1,000 photos)"; `permission_denied` ⇒ "Allow full
  photo access in Settings"; `album_missing` ⇒ "That album no longer exists"), actions "Sync now"
  and an overflow with Pause/Resume, Wi-Fi only, Change album, Stop syncing (confirm; copy says
  nothing is deleted from Tinyglow).
- **Set up sync sheet** (iOS): step 1 explanation + "Allow access to Photos" (**this button
  triggers the permission prompt**; `limited`/`denied` ⇒ explanation + "Open Settings" via
  `App.openSettings`?? — not in `@capacitor/app`; use the `app-settings:` URL scheme is rejected
  by review: show instructions instead), step 2 album list (title · count, skeletons), step 3
  baby (current baby preselected, switcher if the user admins several), toggle Wi-Fi only (on),
  primary "Start syncing".
- **Google import sheet**: not connected ⇒ "Connect Google Photos" (+ one line: "Google Photos
  keeps the capture date but removes photo locations from downloads"); connected ⇒ "Choose
  photos" → "Waiting for you to pick photos in Google Photos…" (spinner-free progress, "Reopen
  picker", "Cancel") → "Importing 23 photos · 12 done" → summary "20 added · 2 already in the
  album · 1 skipped (video) · 1 failed"; `google_reconnect` ⇒ "Reconnect Google"; contributor
  notice "Imported photos wait for a parent's approval". `pages/import/GoogleConnectedPage.tsx`
  at `/import/google/connected`: web ⇒ "Connected" + auto-return to `returnTo` after 1 s;
  `client=native` ⇒ "Connected. Return to Tinyglow." (no button needed; the user closes the
  browser sheet); `status=denied|scope_missing` copy.
- **Settings → Photo import** (`pages/settings/ImportPage.tsx`): Google connection row (connected
  since · Disconnect with confirm); "Album sync" list of every `import_sources` row of the current
  baby (device label, album, last sync, counts; "This iPhone" badge; admins may remove other
  devices' rows; a row whose device signed out shows "Paused · signed out"); recent Google imports
  (last 10) with status chips.
- Timeline: nothing new (imported photos are photos). `i18n/en.ts` keys `import.*`, `sync.*`.
  Light/dark × phone/desktop screenshots of Upload (both states), the two sheets, Settings →
  Photo import, Connected page.

### 2.12 iOS gate helpers (test-engineer, `e2e/native/**`)

- `e2e/native/ios-sync-gate.sh` (`pnpm e2e:native-ios-sync`): same preamble as `ios-gate.sh`
  (one simulator, never downloads a runtime, `IOS_GATE_SKIP_BUILD`, screenshots, PASS/FAIL
  lines, manual checklist). Seeds the library with `xcrun simctl addmedia` and uses the XCUITest
  bundle for everything simctl cannot do (section 4.4).
- XCUITest additions (`e2e/native/ios-uitest/LLUITests/LLUITests.swift`, plus
  `INFOPLIST_KEY_NSPhotoLibraryUsageDescription` on the runner target so the **runner** may use
  PhotoKit): `testCreateAlbum` (LL_ALBUM, LL_ALBUM_COUNT: the runner requests Photos access for
  itself — pre-granted by the shell with `simctl privacy grant photos <runner bundle id>` — then
  `PHPhotoLibrary.performChangesAndWait`: create the album if missing, add the N newest assets),
  `testRemoveFromAlbum` (LL_ALBUM, LL_ALBUM_REMOVE_COUNT), `testEnableSync` (Settings → Photo
  import → Set up → "Allow access to Photos" → SpringBoard alert **"Allow Full Access"** → album
  LL_ALBUM → Start syncing → waits for LL_EXPECT), `testBackgroundResume` (home, 3 s, activate),
  `testTapText` (generic: tap the first element whose label contains LL_TAP, then wait for
  LL_EXPECT).

## 3. Tasks

Owners per `CLAUDE.md`. Lanes: D = devops, B = backend, S = security, M = mobile, F = frontend,
T = test, O = orchestrator. Same-lane tasks run in sequence. Ownership exceptions this plan asks
the orchestrator to approve (same as steps 8–9 and the review batch): backend-engineer writes
`packages/shared/**` in 10.2; devops-engineer owns every `package.json` + `pnpm-lock.yaml` in
10.1 only; mobile-engineer owns `apps/mobile-web/scripts/check-ios-plists.ts`, `fastlane/**`,
`store/**`, `NATIVE.md`; test-engineer owns `e2e/native/ios-uitest/**` (under `e2e/**`).
ai-engineer has no task: the step makes no model call and leaves `packages/ai`, `apps/worker/src/ai`,
`apps/api/src/{chat,search}` untouched (the reviewer confirms with `git diff --stat`).

### 10.1 Dependency and scripts (devops-engineer) — group 0, alone (lockfile)

- Owned for this task only: every `package.json`, `pnpm-lock.yaml`.
- Add `@capacitor/browser` to `apps/mobile-web` (newest 8.x past pnpm's release-age gate; report
  the exact pin, D16). Nothing else; stop and report if another package seems needed.
- Scripts: root `e2e:import-gate` (`tsx e2e/import/gate.ts`), `e2e:native-ios-sync` (`bash
  e2e/native/ios-sync-gate.sh`); `apps/worker` `google-fake` (`tsx src/import/google/fake-server.ts`
  in dev; `node dist/import/google/fake-server.js` in the image — match how `run-job` is wired).
- Done-when: `pnpm install --frozen-lockfile` is a no-op afterwards; `pnpm lint && pnpm typecheck
  && pnpm test` green; `pnpm --filter @tinyglow/mobile-web native:sync` updates
  `ios/App/CapApp-SPM/Package.swift` and `android/app/capacitor.build.gradle` with the browser
  plugin (commit those generated files in 10.5).

### 10.2 Shared contracts (backend-engineer, orchestrator approval) — group 0 (parallel with 10.1)

- Owned: `packages/shared/src/{jobs,imports,google-photos,auth,env,native,telemetry,index}.ts`,
  `packages/shared/src/api/imports.ts` (new).
- Build 2.3 literally; browser-safe (zod + URL only). Explicit: payload schemas strict (ids only);
  `isAllowedMediaUrl` rejects http, userinfo, ports, IP literals and hosts that merely contain
  the suffix (`evil-googleusercontent.com`); scrub patterns added to `TELEMETRY_SCRUB_PATTERNS`.
- Done-when: `pnpm typecheck` green; existing shared tests green; a quick fixture shows
  `isAllowedMediaUrl` accepting `https://lh3.googleusercontent.com/x` and rejecting the five
  negative cases above (10.13 expands).

### 10.3 Migration 20, README, types (security-engineer) — group 1 (may start at once; needs only the audit names of 10.2)

- Owned: `packages/db/migrations/1792300000300_photo-import.sql`, `packages/db/src/generated/**`,
  `packages/db/README.md`.
- Build 2.2. Explicit: FORCE RLS on all four tables; `refresh_token_enc`, `provider_session_id`,
  `provider_item_id` never granted to `authenticated`/`viewer`; `encrypt_secret`/`decrypt_secret`
  executable by `service_role` and `pipeline` only; `import_google_refresh_token` returns NULL
  unless `queued|running` + requester still a member + profile live + not `needs_reconnect`;
  `import_book_photo` mirrors `photos_authenticated_insert` (contributor ⇒ `pending`,
  `approved_by NULL`; admin ⇒ `approved_by = requester`, never another id) and lets
  `photos_free_tier_cap` fire; Apple sources admin-only at the INSERT policy; every RAISE names
  no value; reversible; grants audit for the worker query.
- Done-when: `pnpm db:migrate` applies 20, rerun no-op, `db:migrate:down 1 && db:migrate`
  round-trips, applies on the bare stub; `pnpm db:types` committed with no diff; the
  every-table-forced query returns 0; seed idempotent; `psql` as `authenticated` with the demo
  nanny's claims: `INSERT INTO import_sources (… kind 'apple_photos' …)` ⇒ policy violation,
  `INSERT INTO import_batches (…)` ⇒ 1 row; `SELECT refresh_token_enc FROM google_accounts` ⇒
  permission denied.

### 10.4 Env, Compose, fake service wiring (devops-engineer) — group 1 (after 10.1)

- Owned: `.env.dev`, `.env.example`, `docker-compose.dev.yml`, `docker-compose.yml`,
  `apps/worker/Dockerfile` (only if the fake CLI needs an entry), `.github/scripts/check-compose-keys.mjs`.
- Build 2.10 (not the CI steps). Explicit: `GOOGLE_IMPORT_CLIENT_SECRET` to api and worker only;
  production default provider `none`; dev default `fake`; a fresh clone with no env files still
  starts (`google-fake` has no secrets); worker `/tmp` writable in production.
- Done-when: both `docker compose … config -q` pass; `docker compose -f docker-compose.dev.yml up
  -d --wait` ⇒ `google-fake` healthy and `curl -s localhost:8099/healthz` ⇒ `{"status":"ok"}`
  (after 10.9 lands; until then the service may fail to start — coordinate: 10.4's compose change
  can land with 10.9 or with a placeholder command `node -e "…"`; prefer landing 10.4 after 10.9
  is merged); `exec api printenv GOOGLE_IMPORT_PROVIDER` ⇒ `fake`; `node
  .github/scripts/check-compose-keys.mjs` passes with the two new names.

### 10.5 iOS plugin, BGTask, Wi-Fi-only session, plists, privacy manifest (mobile-engineer) — group 1 (parallel; after 10.1 for the browser plugin sync)

- Owned: `apps/mobile-web/ios/**` (`App/App/TinyglowPhotoSync.swift` new, `AppDelegate.swift`,
  `TinyglowUploader.swift`, `Info.plist`, `Info-Debug.plist`, `PrivacyInfo.xcprivacy`,
  `App.xcodeproj/project.pbxproj`, `CapApp-SPM/Package.swift`), `apps/mobile-web/android/**`
  (generated `capacitor.build.gradle` only), `capacitor.config.ts` (nothing expected),
  `apps/mobile-web/scripts/check-ios-plists.ts` (only if the equality check needs the new keys
  listed).
- Build 2.4. Explicit: original resource, not the edited rendition (D12); SHA-256 streamed; no
  `print`/`NSLog`/`os_log` of paths, names, URLs or identifiers; ledger under
  `Application Support/ll-sync` excluded from backup; `requestAuthorization` is only ever called
  from the JS `enable()` path (the plugin has no implicit request); both plists edited together;
  Wi-Fi-only session identifier handled in `handleEventsForBackgroundURLSession`.
- Done-when: `pnpm --filter @tinyglow/mobile-web ios:build:sim` succeeds; `check:ios-plists`
  passes; `PlistBuddy -c 'Print :UIBackgroundModes' …/App.app/Info.plist` lists `fetch` and
  `:BGTaskSchedulerPermittedIdentifiers` lists `com.tesarsoft.tinyglow.sync` on **both**
  configurations; `plutil -lint` on both source plists; `grep -nE 'print\(|NSLog\(|os_log'
  apps/mobile-web/ios/App/App/TinyglowPhotoSync.swift` ⇒ exit 1; a throwaway JS call from the
  simulator (`TinyglowPhotoSync.listAlbums()`) returns `{albums: []}` on a fresh simulator and
  the album created in 4.4 step 3 afterwards.

### 10.6 Store copy, review notes, Data Safety, NATIVE.md (mobile-engineer) — group 2 (after 10.5, same lane)

- Owned: `apps/mobile-web/NATIVE.md`, `apps/mobile-web/store/**`, `apps/mobile-web/fastlane/**`.
- `review-notes.md` + `fastlane/metadata/review_information/notes.txt`: a paragraph "Album sync
  (optional) asks for full Photos access only when the parent turns it on in Upload → Album sync
  → Set up; the regular upload uses the system photo picker and needs no permission. It imports
  only the one album the parent picks, never deletes anything, and can be stopped from the same
  card. Google Photos import uses Google's own picker in the system browser; it requires the
  reviewer's Google account (the review account has none)." `privacy-nutrition-label.md`: same
  data types; add a line that PhotoKit album sync and Google import collect "Photos or Videos"
  under App Functionality (no change to the label); `data-safety.md`: Google import on Android
  uses no media permission; Photos data type unchanged. `fastlane/metadata/en-US/description.txt`
  and `android/en-US/full_description.txt`: one sentence each ("Import from Google Photos, and on
  iPhone keep one album in sync automatically.") within the limits (`store/check-limits.sh`).
  `NATIVE.md`: sections "Album sync (PhotoKit)" (plugin, ledger, BG refresh and how to simulate it
  with LLDB, Wi-Fi-only session, pitfalls), "Google import on devices" (`@capacitor/browser`, dev
  `adb reverse tcp:8099`), privacy notes updated.
- Done-when: `sh apps/mobile-web/store/check-limits.sh` passes; `grep -rn "Plus" fastlane store`
  still matches only "iPhone 14 Plus"; the notes mention when the Photos permission is requested.

### 10.7 Fake Google Picker server (backend-engineer) — group 1 (after 10.2, same lane)

- Owned: `apps/worker/src/import/google/fake-server.ts` (new), `apps/worker/src/import/google/fake-catalogue.ts`
  (new), `apps/worker/package.json` script entry is 10.1's (coordinate the name `google-fake`).
- Build 2.9. Explicit: exits in production; no GPS IFD in any rendered file (assert at start by
  reading back with `exifr`); token/code shapes `fake-(access|refresh|code)-…`; `__fake/requests`
  records method + path only; the catalogue is deterministic (seeded) so tests can assert SHA-256s.
- Done-when: `pnpm --filter @tinyglow/worker google-fake` serves `/healthz`; `curl -s
  localhost:8099/__fake/items | jq length` ⇒ 12 (or 13 with the HEIC fixture dir); `exiftool`
  (via Docker, as in step 4) on `__fake/items/G-1` shows `DateTimeOriginal` and no `GPS*` tags.

### 10.8 Import API (backend-engineer) — group 2 (after 10.3, 10.7)

- Owned: `apps/api/src/imports/**` (new), `apps/api/src/plugins/jobs.ts`, `apps/api/src/app.ts`,
  `apps/api/src/config.ts`, `apps/api/src/lib/errors.ts`.
- Build 2.6. Explicit: routes run under the caller's claims except the three bounded
  `withServiceRole` uses (connect callback write, token refresh read, disconnect); the state JWT
  is HMAC with an HKDF-derived key and 10-minute expiry and binds `sub` + `sid` (live session
  check); access tokens live only in request scope; `pickerUri` only in the create response;
  `redactUrl` covers `/import/google/callback?code=…&state=…`; audit per 2.6; `enqueueImportGoogle`
  after commit; `feature_unavailable` when the provider is `none` (the UI hides the feature).
- Done-when: typecheck/tests green; walkthrough 4.3 steps 1–9 pass against `google-fake`.

### 10.9 Worker: `import.google`, `import.sweep`, queues, run-job, redaction (backend-engineer) — group 2b (after 10.8, same lane)

- Owned: `apps/worker/src/import/**` (new: `google/{handler,client,download}.ts`, `sweep.ts`),
  `apps/worker/src/{queues,main,run-job,config,logger,heartbeat}.ts`.
- Build 2.7. Explicit: `pipeline` role; the worker never selects `refresh_token_enc`
  (`import_google_refresh_token()` only); `isAllowedMediaUrl` before every fetch, `redirect:
  "manual"`; size cap before and during download; `import_book_photo()` for every photo row (**the
  worker never inserts into `photos` directly**); free-tier stop; `enqueueIngest` after booking;
  **no model call, no embedding call** (the ingest → reindex path keeps the paid-tier gate); logs
  carry ids/counts/categories only; `wrapHandler` semantics unchanged.
- Done-when: boot log `queues: 16`; `run-job import.google` on a `queued` batch created through
  the API (4.3) imports the picked items (`photos` rows with `approved_by = requester` for an
  admin, thumbs within seconds); `run-job import.sweep '{}'` expires a back-dated `picking` batch;
  `docker compose logs worker | grep -E 'fake-(access|refresh)|/media/|pickerUri'` ⇒ exit 1.

### 10.10 Account deletion hook (security-engineer) — group 3 (after 10.8)

- Owned: `apps/api/src/auth/account.ts`.
- Build 2.8. Explicit: revoke before the GoTrue delete, failure non-blocking, nothing logged but
  `{ revoked }`; preview lists the connection.
- Done-when: with a fake-connected throwaway user, `DELETE /api/me` ⇒ 204 and `GET
  localhost:8099/__fake/revocations` contains its refresh token; account e2e still green.

### 10.11 Web platform layer, manager, Apple sync UI (frontend-engineer) — group 1 (after 10.1, 10.2; codes against the plugin contract 2.4 and the API contract 2.6 with MSW/stubs)

- Owned: `apps/mobile-web/src/**` (`platform/uploader.ts`, `platform/native/{photoSync,installId,
  nativeUploader,bootstrap,cleanup,NativeEvents}.ts(x)`, `lib/upload/manager.ts`, `lib/api.ts`,
  `pages/UploadPage.tsx`, `components/import/{SyncCard,SetupSyncSheet}.tsx`, `i18n/en.ts`).
- Build 2.5 (Apple part) and the Album-sync rows of 2.11. Explicit: the permission request
  happens only in `enable()`; PHAsset ids and paths never go to the API, logs or telemetry;
  sync items are `lane: "sync"` and hidden from the Upload list; Wi-Fi only default on; low
  power / thermal skip; `free_tier_limit` stops the run; background runs do one batch and call
  `completeBackgroundTask`; sign-out clears config + ledger and pauses the server row best
  effort; `docs/DESIGN.md` (one primary action, skeletons, 44 px, AA chips).
- Done-when: `pnpm --filter @tinyglow/mobile-web typecheck && test` green with a fake plugin
  (unit tests of `PhotoSyncManager`: first run exports/uploads/records, `duplicate` outcome,
  `free_tier_limit` stop, Wi-Fi gate, min-interval skip, background single batch); screenshots
  of the Upload screen states and the setup sheet (light/dark × phone) reviewed.

### 10.12 Web: Google import UI, Settings → Photo import, Connected page (frontend-engineer) — group 3 (after 10.8, 10.11)

- Owned: `apps/mobile-web/src/**` (`lib/googleImport.ts`, `components/import/GoogleImportSheet.tsx`,
  `pages/import/GoogleConnectedPage.tsx`, `pages/settings/ImportPage.tsx`, `SettingsPage.tsx` row,
  `App.tsx` route, `i18n/en.ts`).
- Build the Google rows of 2.5 and 2.11. Explicit: Google pages open in the system browser on
  native (`@capacitor/browser`), never the WebView; `pickerUri` is used immediately and
  discarded (not stored, not logged); polling stops when the batch is terminal; the "no
  locations from Google" line is shown before the first connect; contributors see the approval
  notice; `returnTo` only from the allow-list.
- Done-when: typecheck/test green; `CI=1 pnpm e2e` green; screenshots (light/dark × phone/desktop)
  of the Google sheet states, Connected page and Settings → Photo import reviewed.

### 10.13 Tests and gates (test-engineer) — group 4 (after 10.3–10.12)

- Owned: `**/*.test.ts(x)`, `packages/db/test/**`, `apps/api/src/testing/*`,
  `apps/worker/src/testing/*`, `e2e/**` (incl. `e2e/import/gate.ts`, `e2e/native/ios-sync-gate.sh`,
  `e2e/native/ios-uitest/**`, `e2e/smoke/dev-stack.sh`; proposes the `scan-logs-for-secrets.mjs`
  patterns to devops).
- **Unit, shared**: `imports.test.ts`, `api/imports.test.ts` (strict DTOs, deltas ≤ 500,
  non-empty patch), `google-photos.test.ts` (`isAllowedMediaUrl` positive/negative, duration
  parsing), `jobs.test.ts` (two new strict payloads), `telemetry.test.ts` (fake and real Google
  token shapes, `googleusercontent` URLs, `/ll-uploads/` paths all scrubbed), `env.test.ts`
  (`fake` refused in production; `live` needs id + secret).
- **Unit, api**: `imports/routes.test.ts` (state JWT mint/verify/expiry/aud, callback with
  `error=access_denied`, scope missing, `redactUrl` on the callback URL hides `code` and `state`;
  error mapping), `plugins/jobs.test.ts` (new sender + stub).
- **Unit, worker**: `import/google/handler.test.ts` with the fake server in-process + fake
  storage + a DB stub (list → download → sha → book: `booked`, `duplicate` (pre-check and race),
  `free_tier_limit` stops the batch, `too_many_items`, VIDEO skipped, oversize aborted after
  ≤ 1 MiB read, disallowed host never fetched, redirect to another host rejected, cancel between
  items, `invalid_grant` ⇒ reconnect; temp dir empty afterwards; no log line contains a token or
  URL), `import/sweep.test.ts`, `queues` (16), `fake-server.test.ts` (no GPS; shapes validate).
- **Unit, web**: `photoSync.test.ts` (10.11 list), `manager.native.test.ts` (sync lane
  concurrency and ordering, precomputed sha skips hashing, `wifiOnly` reaches `putFile`),
  `googleImport.test.ts` (native uses `Browser.open`; web uses `window.open`; polling cadence),
  `GoogleConnectedPage.test.tsx`, `ImportPage.test.tsx`, `UploadPage.native.test.tsx` (sync card
  states, Google row hidden when unavailable).
- **Integration, db** (`packages/db/photo-import.integration.test.ts` + `rls.integration.test.ts`):
  migration 20 up/down/up, types diff clean, every table FORCE RLS; `import_sources`: admin
  insert ok, contributor insert denied, co-admin sees the row and may delete it, owner-only
  update, cap 10, trashed baby refused, shape trigger on control chars; `google_accounts`:
  `authenticated` sees 4 columns of its own row only, `refresh_token_enc` not selectable,
  `encrypt_secret` round-trips only with the key and is not executable by `authenticated`;
  `import_batches`: contributor insert ok (pending later), one active per baby, 21st in 24 h
  refused, user transitions allowed/denied per matrix, `provider_session_id` not selectable by
  users, co-admin sees the batch, stranger nothing; `import_items` visibility follows the batch;
  `import_google_refresh_token` NULL while `picking`, set while `queued`, NULL after the
  requester leaves the baby or `needs_reconnect`; `import_book_photo`: admin ⇒ `approved`,
  `approved_by = requester` (and never a supplied id), contributor ⇒ `pending`/NULL, removed
  member ⇒ `not_member`, trashed baby ⇒ `baby_trashed`, duplicate sha ⇒ `duplicate`, 1,000
  existing live rows on a free baby ⇒ `free_tier_limit`; cascades on profile/baby delete.
- **Integration, api** (`imports/imports.integration.test.ts`, fake server in-process): connect
  URL → fake consent Allow → callback → connection `connected:true`; Deny ⇒ redirect `denied`,
  no row; create batch (201 with `pickerUri`) → poll (`picking`, Google polled at most once per
  interval) → autopick → `queued` + job sent (stub) → cancel paths → second active batch 409 →
  contributor allowed, stranger 404 → provider `none` ⇒ `feature_unavailable` and
  `available:false` → disconnect revokes + deletes → `import-sources` upsert/patch deltas/delete
  matrix, contributor `POST` 403 → account deletion revokes (10.10).
- **Integration, worker** (`import/google/import.integration.test.ts`, real DB + MinIO + fake):
  end-to-end batch of G-1…G-6 + V-1 + X-1 with G-3 pre-uploaded ⇒ 5 booked, 1 duplicate, 1
  skipped, 1 failed; `photos.approved_by = requester`; `photo.ingest` sent per booked item;
  objects exist only for booked; sweep after back-dating; worker log scan.
- **Import gate** `e2e/import/gate.ts` (`pnpm e2e:import-gate`, dev stack, Playwright + API
  helpers): section 4.3 as an automated run; writes `e2e/import-gate/results.json`.
- **iOS sync gate** `e2e/native/ios-sync-gate.sh` + XCUITests (2.12): section 4.4 automated
  except the BG-refresh step (manual checklist line).
- **Smoke**: `pgmigrations` 20, `queues: 16`, `google-fake` healthy, `GET /api/me/import/google/connection`
  as demo mom ⇒ `{available:true, connected:false, …}`.
- Done-when: `pnpm test` and `pnpm test:integration` green on the dev stack and on bare pgvector +
  MinIO, none skipped; `pnpm e2e:import-gate` passes twice in a row; `pnpm smoke`, `pnpm e2e`,
  `pnpm e2e:upload-gate`, `pnpm e2e:share-gate`, `pnpm e2e:export-gate` green; the iOS sync gate
  passes on the installed simulator runtime.

### 10.14 CI (devops-engineer) — group 5 (after 10.13)

- Owned: `.github/workflows/ci.yml`, `.github/scripts/**`.
- Add `import-hygiene.sh` (2.10) to `check`; `google-fake` to the dev-stack job + `pnpm
  e2e:import-gate` + log scan (api, worker, google-fake) with the new patterns; the worker
  integration job starts the fake in-process (no service needed); required integration report
  names; `native-hygiene` asserts the plist keys of 2.4 and that `requestAuthorization` appears
  only in `photoSync.ts`'s `enable` path (`grep -c` = 1 in `src/`); `actionlint` clean.
- Done-when: every job's commands pass locally in order.

### 10.15 Gate, PROGRESS, commit (orchestrator) — section 4

### Parallelism summary

| Group | Tasks | Notes |
| --- | --- | --- |
| 0 | 10.1 (D) · 10.2 (B) | lockfile alone; shared alone |
| 1 (parallel) | 10.3 (S) · 10.5 (M) · 10.7 (B, after 10.2) · 10.11 (F, after 10.1 + 10.2) | disjoint paths: db / ios / worker / src |
| 1b | 10.4 (D) | after 10.1; land its `google-fake` service together with 10.9 (or with a placeholder command) |
| 2 (parallel) | 10.8 (B, after 10.3 + 10.7) · 10.6 (M, after 10.5) | api / store docs |
| 2b | 10.9 (B) | after 10.8, same lane |
| 3 (parallel) | 10.10 (S, after 10.8) · 10.12 (F, after 10.8 + 10.11) | account.ts / src |
| 4 | 10.13 (T) | |
| 5 | 10.14 (D) | |
| Gate | 10.15 (O) | section 4 |

## 4. Acceptance checks and gate procedure

No PRD step text applies verbatim; the checks below are the user's decisions made concrete, plus
every earlier gate the touched code could affect. Run from the repo root with Docker running and
`pnpm` 12.10.1 on PATH; dev stack with the fake AI provider, `PUSH_PROVIDER=fake`,
`GOOGLE_IMPORT_PROVIDER=fake` (defaults).

### 4.1 Static, unit, integration

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck
bash .github/scripts/import-hygiene.sh && bash .github/scripts/native-hygiene.sh && bash .github/scripts/ai-hygiene.sh && bash .github/scripts/share-hygiene.sh && bash .github/scripts/sentry-hygiene.sh
pnpm --filter @tinyglow/mobile-web check:ios-plists
node .github/scripts/check-compose-keys.mjs
git diff --stat 23ff8d6.. -- packages/ai apps/worker/src/ai apps/api/src/chat apps/api/src/search   # empty: no AI change
pnpm test
pnpm test:integration          # fresh pgvector + MinIO, same env block as docs/plans/step-8.md 4.5
git diff --exit-code -- packages/db/src/generated
```

### 4.2 Dev stack

```sh
docker compose -f docker-compose.dev.yml down -v && docker compose -f docker-compose.dev.yml up -d --build --wait
PSQL="docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d tinyglow -Atc"
$PSQL "select count(*) from pgmigrations"                                                  # 20
$PSQL "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)"   # 0
docker compose -f docker-compose.dev.yml logs worker | grep 'queues: 16'
curl -s localhost:8099/healthz                                                             # {"status":"ok"}
docker compose -f docker-compose.dev.yml exec api printenv GOOGLE_IMPORT_PROVIDER         # fake
pnpm smoke && CI=1 pnpm e2e
pnpm e2e:import-gate && pnpm e2e:import-gate
pnpm e2e:upload-gate && pnpm e2e:share-gate && pnpm e2e:export-gate && pnpm e2e:push-gate && pnpm e2e:ai-gate
```

### 4.3 Google import walkthrough against the fake (`B=http://localhost:8080`, `G=http://localhost:8099`, cookie jar per user, `H='x-tinyglow-client: web'`)

1. As demo mom: `GET $B/api/me/import/google/connection` ⇒ `{available:true, connected:false,
   needsReconnect:false}`. `POST $B/api/me/import/google/connect -d '{"client":"web"}'` ⇒ `{url}`
   starting with `$G/o/oauth2/v2/auth?` containing `scope=…photospicker.mediaitems.readonly`,
   `access_type=offline`, `redirect_uri=http://localhost:8080/api/import/google/callback`.
2. Open `url` in the browser (Playwright in the gate) ⇒ click **Allow** ⇒ lands on
   `$B/import/google/connected?status=ok&client=web` ⇒ `connection` ⇒ `connected:true`;
   `$PSQL "select octet_length(refresh_token_enc) > 0, scope from google_accounts"` ⇒ `t|…readonly`;
   `$PSQL` as mom's claims `select refresh_token_enc from google_accounts` ⇒ permission denied.
3. Pre-upload fixture: `curl -s $G/__fake/items/G-3 -o g3.jpg` and upload it through the step-4
   helpers as mom (so it is a duplicate below).
4. `POST $B/api/babies/<maya>/imports/google -d '{}'` ⇒ 201 `{batch:{status:"picking",…},
   pickerUri:"$G/picker/<sid>"}`; a second POST at once ⇒ 409 `import_in_progress`.
5. `curl -s "$G/picker/<sid>?autopick=G-1,G-2,G-3,G-4,G-5,G-6,V-1,X-1"`; poll `GET
   $B/api/imports/<id>` ⇒ `queued` within ~3 s, then `running` → `done` within 60 s with
   `itemsTotal 8, itemsImported 5, itemsDuplicate 1, itemsSkipped 1, itemsFailed 1`.
6. `$PSQL "select approval, approved_by = uploaded_by, mime, status from photos where id in (select id from import_items where batch_id='<id>' and status='booked')"` ⇒ 5 rows
   `approved|t|image/jpeg|ingested` (or `ready`/`queued` once the fake AI ran); `$PSQL "select
   count(*) from photo_exif e join import_items i on i.photo_id=e.photo_id where i.batch_id='<id>'
   and e.taken_at is not null"` ⇒ 5; `… and e.gps_lat_enc is not null` ⇒ **0** (Google strips
   location; the fake mirrors it); `GET $B/api/babies/<maya>/photos/<p>` shows `takenAt`
   2026-03-0N 10:00 +01:00 and `exif.cameraMake "Fake"`; `docker compose exec storage mc ls
   local/tinyglow/babies/<maya>/originals/ | wc -l` grew by 5 (no object for the duplicate,
   skipped or failed items).
7. As the nanny (contributor): connect with `?account=nanny` ⇒ import G-7, P-1 ⇒ `done`, 2
   photos `pending`, `approved_by IS NULL`; the approval queue lists them; as mom approve one ⇒
   `approved_by = mom`.
8. Cancel: start a batch, `POST …/cancel` ⇒ `cancelled`; `GET $G/__fake/requests | grep
   'DELETE /v1/sessions/'` ⇒ 1. Deny: open a connect URL and click **Deny** ⇒
   `…/connected?status=denied`, no new row. Reconnect: `POST $G/__fake/revoke-all` ⇒ `POST
   …/imports/google` ⇒ 409 `google_reconnect` and `connection.needsReconnect:true` ⇒ connect
   again ⇒ `false`.
9. `DELETE $B/api/me/import/google/connection` ⇒ 204; `GET $G/__fake/revocations` lists the
   token; `connection.connected:false`. As the nanny: `POST $B/api/babies/<maya>/import-sources
   -d '{"kind":"apple_photos",…}'` ⇒ 403 `parents_only`.
10. Logs: `docker compose logs api worker google-fake | grep -E "fake-(access|refresh|code)-|/media/|pickerUri|X-Amz-Signature|eyJ[A-Za-z0-9_-]{10,}|@tinyglow\.local"; echo "exit $?"` ⇒ exit 1.

### 4.4 iOS album sync gate (`pnpm e2e:native-ios-sync`; needs the installed iOS 26.4 simulator runtime, Xcode; dev stack up)

```sh
UDID=$(xcrun simctl list devices -j | node -e '…same lookup as ios-gate.sh…')   # iPhone 17 / iOS 26.4
pnpm --filter @tinyglow/mobile-web native:sync:ios && pnpm --filter @tinyglow/mobile-web ios:build:sim
xcrun simctl boot "$UDID"; xcrun simctl privacy "$UDID" reset photos com.tesarsoft.tinyglow
xcrun simctl install "$UDID" apps/mobile-web/ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app
# runner may use PhotoKit without a prompt (its bundle id is the UI-test bundle id + ".xctrunner")
xcrun simctl privacy "$UDID" grant photos com.tesarsoft.tinyglow.LLUITests.xctrunner
# 1. seed the library: 3 HEIC (one with GPS, one with a tz offset) + 2 JPEG
xcrun simctl addmedia "$UDID" e2e/fixtures/heic/gps-640x480.heic e2e/fixtures/heic/datetime-tz.heic e2e/fixtures/heic/plain-640x480.heic e2e/fixtures/bakeoff-sample/sample-1-gradient.jpg e2e/fixtures/bakeoff-sample/sample-2-blocks.jpg
uitest testCreateAlbum LL_ALBUM="LL Sync Test" LL_ALBUM_COUNT=5
# 2. one album photo is already in Tinyglow (cross-device dedupe): upload plain-640x480.heic via the API as demo mom
# 3. sign in (ios-gate helper), then enable sync; the permission alert must appear HERE and not earlier
uitest testEnableSync LL_ALBUM="LL Sync Test" LL_EXPECT="4 imported"      # taps "Allow Full Access"
```

Then (`$PSQL` as in 4.2, `M=<maya>`):

- `$PSQL "select imported_count, duplicate_count, failed_count, paused, last_trigger from import_sources where baby_id='$M'"` ⇒ `4|1|0|f|manual`.
- `$PSQL "select count(*) from photos where baby_id='$M' and uploaded_by='<mom>' and approval='approved' and approved_by='<mom>' and created_at > now() - interval '10 min'"` ⇒ 4; mimes: 2 × `image/heic`, 2 × `image/jpeg`.
- `$PSQL "select e.taken_at, e.tz_offset_minutes from photo_exif e join photos p on p.id=e.photo_id where p.baby_id='$M' and p.bytes=<datetime-tz size>"` ⇒ the fixture's EXIF date and offset (step-4 expectations); `… where p.bytes=<gps fixture size>` ⇒ `gps_lat_enc IS NOT NULL` and `place_label` NULL or `Home`.
- Derivatives: `curl -s "<thumb url>" | docker run --rm -i <exiftool image> - | grep -c GPS` ⇒ 0 (step-4 helper).
- Incremental: `xcrun simctl addmedia "$UDID" e2e/fixtures/bakeoff-sample/sample-3-stripes.jpg`;
  `uitest testCreateAlbum LL_ALBUM_COUNT=1`; `uitest testBackgroundResume`; wait ≤ 60 s ⇒
  `imported_count` 5, photos +1.
- Removal never deletes: `uitest testRemoveFromAlbum LL_ALBUM_REMOVE_COUNT=1`; `uitest
  testBackgroundResume` ⇒ photos count unchanged (5 imported), `import_sources` unchanged.
- Re-add is not re-imported: `uitest testCreateAlbum LL_ALBUM_COUNT=1` (re-adds the newest asset)
  ⇒ resume ⇒ counts unchanged (ledger hit; if the ledger were reset, the SHA-256 pre-check would
  return `duplicate` instead — either way no second photo row).
- Pause: `uitest testTapText LL_TAP="Pause" LL_EXPECT="Paused"`; add one more asset + album;
  resume ⇒ no change; `uitest testTapText LL_TAP="Resume" LL_EXPECT="Up to date"` then
  `LL_TAP="Sync now"` ⇒ +1 (6 imported).
- Relaunch (`simctl terminate` + `launch`) ⇒ card shows the album and "Up to date"; `last_trigger`
  becomes `launch` after a run (or the min-interval skip leaves `manual`; accept either within
  60 s of the previous run).
- Sign out (ios-gate helper) ⇒ `paused = t, last_error = 'signed_out'`; the ledger directory is
  gone (`xcrun simctl get_app_container "$UDID" com.tesarsoft.tinyglow data` → no
  `Library/Application Support/ll-sync/*.json`); `Caches/ll-uploads` empty.
- Log scan: `xcrun simctl spawn "$UDID" log show --last 20m --predicate 'process == "App"' |
  grep -E "ll-uploads/|X-Amz-Signature|eyJ[A-Za-z0-9_-]{10,}|-?[0-9]{1,3}\.[0-9]{3,},\s*-?[0-9]{1,3}\.[0-9]{3,}|/var/mobile/Media"; echo "exit $?"` ⇒ exit 1; api + worker logs as in 4.3.10.
- Manual checklist printed by the gate: **background refresh** — with the app running under
  Xcode, pause and run `e -l objc -- (void)[[BGTaskScheduler sharedScheduler]
  _simulateLaunchForTaskWithIdentifier:@"com.tesarsoft.tinyglow.sync"]`, resume ⇒ one batch
  imports and `last_trigger = 'background'`; cannot be automated from the shell (best effort by
  design, D13). Wi-Fi only: Settings → simulate "cellular" is not possible on the simulator; the
  unit test covers the gate; verify on a device in part B.

### 4.5 Gate summary to record in PROGRESS

PASS for 4.1–4.4 (4.4's BG-refresh line as manual); screenshots reviewed (10.11, 10.12); the
decisions of section 5 recorded; the user-blocked list (5.3) copied to open issues. Commit as
`step 10: photo import (apple album sync, google photos picker)`.

## 5. Risks and decisions (orchestrator / user to confirm or override)

### 5.1 Decisions (defaults proposed)

- **D1 — Who can enable.** Apple album sync: **admins only** (an automatic, open-ended flow that
  can move thousands of photos; the approval queue is for hand-picked contributor uploads and
  pending photos count toward the free cap). Google Picker import: **admins and contributors**;
  it is a manual, per-batch pick, so it behaves exactly like a contributor upload (pending,
  FR-2.7). Override: allow contributors to sync too (drop the admin clause in the INSERT policy;
  everything else already handles pending).
- **D2 — Which album and baby.** One Apple album per (device, baby); the album and the baby are
  chosen on the device; the album's `localIdentifier` lives only on the device, its title on the
  server for display. A device may sync different albums into different babies (twins). Status is
  the server row (`import_sources`: last sync, trigger, counters, error), so both admins see every
  device's status in Settings → Photo import and the syncing device shows the live card.
- **D3 — Server-side state.** Counters only. PHAsset identifiers (and hashes of them), file names
  and paths never leave the device; the per-asset ledger is a backup-excluded file under
  `Application Support/ll-sync`. Dedupe across devices and the web is the existing SHA-256
  pre-check + the per-baby unique index, so two phones syncing the same shared album into the
  same baby upload each photo once (both still hash every asset once). Override: a server-side
  table of asset hashes (not needed: the photo's SHA-256 already is that table).
- **D4 — Bulk first sync.** Newest first; batches of 50 in the foreground (one batch of 25 per
  background-refresh wake); the sync lane uses at most 2 of the 4 upload slots and yields to the
  user's own uploads; Wi-Fi only on by default (own background URLSession with
  `allowsCellularAccess = false`); runs are skipped in Low Power Mode or at thermal state ≥
  serious; a `free_tier_limit` stops the run and shows the cap message; a run is at most one per
  minute except "Sync now". A 3,000-photo album at ~3 photos/s is ~17 min of foreground time
  (background PUTs continue after the app is suspended; hashing/exporting needs the app awake).
  Override: oldest first; smaller batches.
- **D5 — Deletions.** Never delete from Tinyglow when a photo leaves the album (the ledger
  keeps it as done; a re-add is a no-op). Stopping sync deletes nothing. Recommended as asked.
- **D6 — Google tokens and downloads.** Server-side OAuth (one Google **web** client; the api
  owns the redirect URI), refresh token encrypted with pgcrypto under `DATA_ENCRYPTION_KEY`
  (`encrypt_secret`), decrypted only by `service_role` (api: session create/poll/revoke) and via
  `import_google_refresh_token()` (worker: downloads), access tokens in memory only, nothing
  client-side. Downloads run in the **worker** (uniform across web/Android/iPhone, continues when
  the user leaves, no CORS dependency on Google, tokens never on a device), with an SSRF guard
  (https, host suffix allow-list, no redirects off the list, 100 MiB cap). Override: client-side
  download (ruled out: Google's media hosts are not CORS-open and the token would live in the
  browser/WebView).
- **D7 — Fake Picker provider.** `GOOGLE_IMPORT_PROVIDER = none | fake | live`; dev defaults to
  `fake` (a tiny service from the worker image), production to `none` until credentials exist;
  `fake` refused in production like `PUSH_PROVIDER=fake`. The fake serves no GPS, mirroring
  Google.
- **D8 — Free vs Plus.** Import and sync are available on Free (not AI); the 1,000-photo cap
  applies through the existing trigger; AI eligibility is untouched (imported photos of paid
  babies are analysed by the existing flush; free-tier photos are never sent to a model). No
  billing/plan code changes.
- **D9 — Android.** Google Picker import: yes (Custom Tabs via `@capacitor/browser`). Album
  auto-sync: **no** in v1 (needs `READ_MEDIA_IMAGES` and a Play photo/video-permission policy
  declaration; the manifest and Data Safety answers say no media permission). Deferred.
- **D10 — `approved_by` pin for imports.** Apple sync uses the existing `bookPhoto` (review-fix
  pin applies unchanged). Google import books through `import_book_photo()` (SECURITY DEFINER,
  pipeline-only) that re-reads membership and role at run time and mirrors the INSERT policy:
  admin ⇒ `approved`, `approved_by = requester`; contributor ⇒ `pending`, NULL; trashed baby /
  removed member ⇒ refused; the free-tier trigger fires. Alternative rejected: the worker
  inserting into `photos` directly (it has no INSERT grant and must not get one).
- **D11 — Picker batch size.** 500 items per batch (parity with upload sessions); extra items are
  skipped and the summary says so; videos and non-accepted types are skipped (FR-2.3).
- **D12 — Which bytes from Apple Photos.** The **original** resource (`PHAssetResourceType.photo`:
  the unedited capture, HEIC kept, EXIF/GPS intact), not the edited rendition; iCloud-only
  originals are downloaded (`isNetworkAccessAllowed`) — iCloud download itself follows the system
  cellular setting. Shared albums (`albumCloudShared`) and smart albums are not offered in v1
  (shared-album assets have no original resource). Override: offer "Favorites".
- **D13 — Background refresh is best effort.** iOS decides when `BGAppRefreshTask` runs (often
  never for rarely-used apps); each wake handles one small batch; the main triggers are launch,
  foreground and "Sync now". The simulator cannot fire it from the shell (LLDB only), so the gate
  records it as a manual check and the unit tests cover the JS path.
- **D14 — OAuth state.** Stateless HMAC JWT (HKDF-derived key, 10 min, bound to the user and the
  live GoTrue session); the callback needs no cookie, which the native flow requires. No PKCE
  (the web client uses its secret; PKCE adds nothing server-to-server). Override: a
  `google_oauth_states` table.
- **D15 — Returning to the app after consent/picking.** The callback redirects to a plain SPA
  page ("Connected. Return to Tinyglow."); the app re-checks the connection on `resume` /
  `browserFinished` and polls batch status, so no deep link or Universal Link is involved and
  the dev simulator works without association. Override: a `/import/google/done` universal link.
- **D16 — New dependency**: `@capacitor/browser` (SFSafariViewController / Custom Tabs). Google
  blocks OAuth and the Picker inside embedded WebViews, so a system browser surface is required.
  No server dependency (plain `fetch`, zod, pgcrypto, sharp already present).
- **D17 — No batch details on imports.** Neither flow attaches milestone/people/note at import
  time (details are editable later in the viewer). Override: let the Google sheet carry batch
  details like the upload screen.
- **D18 — One Google OAuth client.** Only a "Web application" client is needed (the flow runs in
  the system browser against our server's redirect URI). iOS/Android client ids are not used by
  this design; they would only matter for native Google Sign-In (and then Sign in with Apple
  must ship too). This is a departure from the user's list and is flagged.
- **D19 — Picker polling.** The client polls our API at Google's `pollInterval`; the API proxies
  to Google at most once per interval per batch (`last_polled_at`), so an idle tab never exceeds
  Google's polling guidance; `import.sweep` expires abandoned sessions after ≤ 30 min.
- **D20 — Google metadata facts (state in the UI and README).** Per Google's documentation, the
  base-URL download (`=d`) returns the stored file with its EXIF (capture date/time, camera)
  **except location, which Google removes from downloads**; "Original quality" items are the
  uploaded bytes (HEIC stays HEIC), "Storage saver" items are Google's recompressed file. The
  Picker's `mediaFileMetadata` has width/height/camera but no size and no GPS, so Google imports
  never get a Home label. **To verify on the first real run (5.3).**

### 5.2 Deferred (record in `docs/PROGRESS.md`)

Android album sync (D9); shared/smart albums and edited renditions (D12); PhotoKit change
observer for live foreground updates; batch details on imports (D17); push/email "import
finished"; Google Library API features (no longer possible); admin visibility of a device's
pending-asset count (device-only); per-device Wi-Fi-only override from another device;
re-enabling sync without re-hashing (ledger export); a `remove_member` hook that also pauses the
removed member's sync rows (today the next run gets 403/404 and writes `signed_out`-like state —
make it `not_member` if cheap).

### 5.3 Risks and user-blocked items

- **R1 — WKWebView during a background-refresh wake.** The JS orchestration runs while iOS gives
  the process ~30 s; timers are throttled but plugin callbacks and `fetch` work. If it proves
  unreliable, the fallback is to move list → export → register → PUT for one batch into Swift
  (the register call is a plain JSON POST with the bearer token read from the Keychain) and keep
  JS for the UI. The gate's manual BG line will show which.
- **R2 — iCloud originals and large libraries.** `exportAssets` of iCloud-only originals can be
  slow or fail offline (`icloud` reason ⇒ `failed`, retried up to 3 runs). Export writes
  originals into `Caches/ll-uploads` (deleted when the upload ends); 50 originals × ~4 MB is
  fine; the OS may purge Caches under pressure — a purged file fails the PUT (`file-unreadable`)
  and is retried next run.
- **R3 — App Review on full Photos access.** Reviewers push back when PHPicker would do; the
  justification (continuous one-album sync, requested only at opt-in, picker still used
  otherwise) is in the review notes and the usage string. Residual risk accepted by the user's
  decision.
- **R4 — Google specifics unverified until credentials exist**: HEIC/original-quality download
  semantics and the location-stripping statement (D20), `pollingConfig` values, Picker quotas
  (per-project daily request quota), refresh-token expiry **after 7 days while the OAuth app is in
  "Testing"** (users must reconnect weekly until the app is published and verified), and the
  consent-screen verification timeline for the sensitive Picker scope. First real run: connect,
  pick a HEIC with GPS, import, then check `photos.mime = image/heic`, `photo_exif.taken_at` set
  and `gps_lat_enc IS NULL`; record the facts in PROGRESS and adjust the UI line if Google keeps
  GPS after all.
- **R5 — SSRF via `baseUrl`.** Mitigated by the allow-list, https-only, manual redirects, size
  cap and timeouts; the integration test proves a disallowed host is never contacted.
- **R6 — Worker temp disk.** ≤ `IMPORT_CONCURRENCY × 100 MiB` of `/tmp`; production
  `read_only` needs a tmpfs (10.4 verifies). Objects are written only after sha/dup checks, so
  MinIO holds no duplicates.
- **R7 — Two phones syncing the same album.** Both hash every asset once (CPU/battery on both);
  only one uploads. Acceptable for v1; documented in the setup sheet ("one phone per album is
  enough").
- **R8 — Fresh install = new device.** The Keychain wipe makes a reinstall a new `device_id`; the
  old row stays as "signed out / paused" until an admin removes it; the new install re-hashes
  the album (server dedupes). Documented.
- **Needs the user (blocks real Google use, not the gate):**
  1. Google Cloud project (recommend reusing the one planned for Google sign-in) with the
     **Google Photos Picker API** enabled.
  2. OAuth consent screen: External; app name "Tinyglow", support email, logo, home page /
     privacy policy / terms URLs on `tinyglow.app`, authorized domain
     `tinyglow.app`; scope `…/auth/photospicker.mediaitems.readonly` added.
  3. Publishing status **Testing** with test users (≤ 100 Google accounts; refresh tokens
     expire after 7 days in this state), then **In production** + Google's brand/scope
     verification for the sensitive scope (verified domain, privacy policy, possibly a demo
     video; allow days to weeks).
  4. OAuth client, type **Web application**: authorized redirect URIs
     `https://tinyglow.app/api/import/google/callback` and, for a real-Google dev
     run, `http://localhost:8080/api/import/google/callback`. iOS/Android client ids are **not**
     needed for this design (D18).
  5. Production `.env`: `GOOGLE_IMPORT_PROVIDER=live`, `GOOGLE_IMPORT_CLIENT_ID`,
     `GOOGLE_IMPORT_CLIENT_SECRET` (api + worker); dev real run: the same in git-ignored
     `.env.local` + `GOOGLE_IMPORT_PROVIDER=live docker compose … up -d --no-deps api worker`.
  6. Apple: nothing new to buy; TestFlight on a real iPhone is the only place to observe a true
     `BGAppRefreshTask` and the Wi-Fi-only session on cellular (part B).
  7. Approve the dependency `@capacitor/browser` (D16) and the ownership exceptions in section 3.
