# Step 4 plan: Upload and ingest

Status: proposed (architect, 2026-10-08). PRD step: "Build handoff for Claude Code → Build order →
4. Upload and ingest: pre-signed multipart upload, background upload on mobile, EXIF, hashes,
derivatives, age calculation, dedupe, contributor approval queue." Acceptance (verbatim):
"200-photo bulk upload completes; duplicates skipped; HEIC converts; thumbnails visible within
5 s; GPS absent from served derivatives."

PRD sections implemented: "FR-2 Upload" (2.1–2.5, 2.7; 2.6 auto-backup is P2, not here), "FR-3
Parent-supplied details (optional)" (only batch details attached at upload; editing UI is step
5), "FR-4 Metadata extraction" (4.1, 4.2, 4.4; 4.3 only the "home" label, no reverse geocoding),
"FR-6 Storage and indexing" (6.1, 6.2), "FR-10 Data rights" (10.2 trash + hard delete), "AI
pipeline → 1. Ingest" and "Image compression for the model" (the analysis copy is generated now;
nothing is sent to any model until step 6), "Non-functional requirements → Privacy and child
safety" (signed URLs ≤ 1 h scoped to one object, GPS encrypted and stripped from derivatives,
CSAM hash matching seam), "Performance" (500 photos < 5 min, thumbnail < 5 s p95), "Mobile and
Capacitor → Capacitor plugins" (background upload and EXIF-before-upload: seams only, native work
is step 9), "Routing through Cloudflare Tunnel" (parts ≤ 50 MB; `files.` keeps the Host header),
"Compose requirements" (`S3_ENDPOINT` vs `S3_PUBLIC_ENDPOINT`, storage healthchecks, 80 % disk
alert), "Conventions". `CLAUDE.md` clarifications applied: MinIO everywhere; contributors in v1;
AI is paid-tier only and free-tier photos are never sent to a model (no photo of any tier is
sent anywhere in this step). Per the user's instruction there is **no per-step reviewer pass**;
one combined review runs after step 9.

## 1. Goal

Let an admin or contributor pick up to 500 photos (web file picker or drag-and-drop) and send
them straight from the browser to MinIO over pre-signed S3 multipart URLs (parts of 16 MiB, far
under Cloudflare's 100 MB cap), with per-file progress, retry, resume after a reload, exact-
duplicate skipping and a summary line ("482 uploaded, 3 failed, 15 duplicates skipped"). A
pg-boss `photo.ingest` job running as the `pipeline` role then sniffs the real type, hashes
(SHA-256 + pHash), extracts EXIF (capture time and offset, camera, orientation, dimensions; GPS
only ever as pgcrypto ciphertext), computes the baby's age at capture (estimated from upload
time when EXIF is missing), decodes HEIC with `heic-decode`, and writes metadata-free JPEG
derivatives (thumb 320, display 1600, analysis 768) so a thumbnail is visible within 5 s.
Contributor uploads land in an approval queue and nothing of theirs enters the album, the AI
pipeline or any shared album until an admin approves. Derivatives are served only through
signed GET URLs valid ≤ 1 h and scoped to one object; originals are untouched and reachable only
by admins. A scheduled `purge.trash` job hard-deletes photos and babies trashed > 30 days ago,
including every MinIO object version. api and worker stop using the MinIO root key and get
bucket-scoped service accounts. The step's gate is a script that uploads 200 generated photos
(JPEG/PNG/WebP with GPS EXIF, committed HEIC fixtures, 20 exact duplicates, 2 invalid files)
and asserts completion, duplicate skipping, HEIC → JPEG derivatives, thumb visibility p95 < 5 s
and no EXIF/GPS in any served derivative.

## 2. Interfaces first

Everything in this section is a contract; agents build to it without asking each other.
Deviations go through the orchestrator.

### 2.1 Topology

```
browser ──/api/uploads/*──► api ──CreateMultipartUpload/ListParts/Complete──► MinIO (S3_ENDPOINT, api service account)
   │                          └─presign UploadPart/GetObject with a signer client on S3_PUBLIC_ENDPOINT
   ├──PUT part ───────────────────────────────────────────────────────────────► MinIO (S3_PUBLIC_ENDPOINT = localhost:9000 | files.littlelight.tesarsoft.com)
   └──GET thumb/display (signed, ≤ 1 h, one object) ──────────────────────────► MinIO
api ──pg-boss send (littlelight_api, pgboss schema grants) ──► Postgres ──► worker (--scale 3)
worker ──SET LOCAL ROLE pipeline──► photos / photo_exif / photo_derivatives / upload_files
worker ──worker service account──► MinIO: GetObject original, PutObject derivatives, delete versions
```

- Photo bytes never pass through the API (PRD "Architecture"). The API only creates/lists/
  completes/aborts multipart uploads and signs URLs.
- Two S3 clients in the API: the existing `app.s3` on `S3_ENDPOINT` for real calls, and a
  **signer** client configured with `endpoint: S3_PUBLIC_ENDPOINT` used only by
  `getSignedUrl` (never sends a request). SigV4 signs the Host, so the public hostname must be
  the one the client will hit; through Cloudflare Tunnel the `files.` hostname forwards the
  original Host header (step 1 compose, `MINIO_SERVER_URL`).
- MinIO CORS: browser `PUT`s to port 9000 are cross-origin. MinIO's default
  `MINIO_API_CORS_ALLOW_ORIGIN=*` is kept in dev; production sets it to `${PUBLIC_URL}`. Part
  ETags are never needed by the client (2.4 "complete" is server-driven), so no exposed headers
  are required.

### 2.2 Object key layout (`@littlelight/shared` `src/upload.ts`)

| Object | Key | Written by | Read by |
| --- | --- | --- | --- |
| Original | `babies/{babyId}/originals/{photoId}` (no extension; `photos.mime` is the sniffed type) | browser via presigned parts; completed by api | worker (ingest), api (admin original URL), purge |
| Derivative | `babies/{babyId}/derivatives/{photoId}/{thumb\|display\|analysis}.jpg` | worker | api (signed GET for thumb/display only), step 6 batcher (analysis) |

`photoId` is minted at registration (it is the `upload_files.id`, 2.3) so the key is known
before the row in `photos` exists. The baby prefix makes baby purge a prefix delete. Helpers:
`originalKey(babyId, photoId)`, `derivativeKey(babyId, photoId, kind)`, `babyPrefix(babyId)`,
`photoPrefixes(babyId, photoId)`.

### 2.3 Database changes (migration `1791700000100_uploads-and-ingest.sql`, security-engineer)

Conventions as in step 2 (uuid PKs, `text` + CHECK enums, ENABLE + FORCE RLS in the same file,
policies `TO <role>` named `<table>_<role>_<verb>`, column grants, exact down migration).

**`upload_sessions`** — one per picker session (FR-2.1 "up to 500 per session"; FR-3.1 batch
details).

| Column | Type / constraint |
| --- | --- |
| `id` | uuid PK |
| `baby_id` | uuid NOT NULL REFERENCES babies ON DELETE CASCADE |
| `created_by` | uuid NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE |
| `milestone_id` | uuid REFERENCES milestones ON DELETE SET NULL |
| `people` | text[] NOT NULL DEFAULT '{}' |
| `note` | text CHECK (length ≤ 2000) |
| `location_label` | text CHECK (length ≤ 120) |
| `finished_at` | timestamptz |
| `expires_at` | timestamptz NOT NULL DEFAULT now() + interval '24 hours' |
| `created_at`, `updated_at` | as usual (+ `set_updated_at` trigger) |

Index `(baby_id, created_at DESC)`. RLS: `A` SELECT `created_by = auth_uid() OR
is_baby_admin(baby_id)`; INSERT `is_baby_member(baby_id) AND created_by = auth_uid()`; UPDATE
(cols `finished_at, updated_at`) `created_by = auth_uid()`; no DELETE. `P` SELECT USING true
(sweep). `V`: nothing. Trigger `upload_sessions_free_tier_precheck` is **not** added: the
`photos_free_tier_cap` trigger is the hard stop; the API pre-checks for a friendly error.

**`upload_files`** — one per registered file; its `id` becomes `photos.id` on completion.

| Column | Type / constraint |
| --- | --- |
| `id` | uuid PK (= the future `photos.id`) |
| `session_id` | uuid NOT NULL REFERENCES upload_sessions ON DELETE CASCADE |
| `baby_id` | uuid NOT NULL REFERENCES babies ON DELETE CASCADE (denormalised for policies) |
| `client_id` | text CHECK (length ≤ 64) — the browser's handle, echoed back |
| `declared_bytes` | bigint NOT NULL CHECK (> 0 AND ≤ 104857600) |
| `client_sha256` | bytea CHECK (octet_length = 32) — client pre-check only, never trusted |
| `client_mime` | text CHECK (IN the five photo mimes) — hint only |
| `taken_at_hint` | timestamptz; `tz_offset_hint_minutes` smallint |
| `storage_key` | text NOT NULL UNIQUE (= `originalKey`) |
| `multipart_upload_id` | text |
| `part_size` | integer NOT NULL |
| `state` | text NOT NULL DEFAULT 'registered' CHECK IN ('registered','completed','ingested','duplicate','failed','aborted') |
| `error` | text CHECK IN ('unsupported_media_type','file_too_large','decode_failed','free_tier_limit','rejected','expired','storage_error','upload_incomplete') |
| `photo_id` | uuid REFERENCES photos ON DELETE SET NULL |
| `duplicate_of_photo_id` | uuid REFERENCES photos ON DELETE SET NULL |
| `created_at`, `updated_at` | as usual |

Indexes `(session_id)`, `(baby_id, state)`, partial `(state) WHERE state IN ('registered','failed','aborted')` for the sweep. Helper
`upload_session_visible(session_id uuid)` STABLE SECURITY INVOKER (= `EXISTS (SELECT 1 FROM
upload_sessions WHERE id = $1)`, inherits the caller's session policy, like `photo_visible`).
RLS: `A` SELECT `upload_session_visible(session_id)`; INSERT `upload_session_visible(session_id)
AND baby_id = (SELECT baby_id FROM upload_sessions WHERE id = session_id)` — restricted further
by a SECURITY DEFINER trigger `upload_files_session_owner` (the session's `created_by` must be
`auth_uid()`, not expired, not finished, and `count(*) < 500` in the session → else
`check_violation` "upload session is full" / "upload session is closed"); UPDATE (cols `state,
error, photo_id, multipart_upload_id, updated_at`) `upload_session_visible(session_id)` (the
API moves `registered → completed/aborted/failed`); no DELETE. `P` SELECT USING true; UPDATE
(cols `state, error, photo_id, duplicate_of_photo_id, updated_at`) USING true. `V`: nothing.
`service_role`: ALL (default privileges).

**`photos`** (ALTERs):

- `status` CHECK gains `'duplicate'` (transient marker set by ingest right before the row is
  hard-deleted; survives only if the worker dies in between). Down: `DELETE FROM photos WHERE
  status = 'duplicate'` then restore the old CHECK.
- `quarantined_at timestamptz` (CSAM hash match, 2.7). Pipeline UPDATE grant gains
  `quarantined_at`. **Every user-facing SELECT policy gains `AND quarantined_at IS NULL`**:
  `photos_authenticated_select`, `photos_viewer_select` (sharing migration's policy, re-created
  here). Child tables follow through `photo_visible`. `service_role` still sees them (operator
  flow later).
- `photos_pipeline_delete` USING becomes `(deleted_at IS NOT NULL AND deleted_at < now() -
  interval '30 days' AND quarantined_at IS NULL) OR status = 'duplicate'`. Quarantined
  originals are never purged automatically (evidence retention; operator decision).
- `photos_authenticated_insert` unchanged (contributor ⇒ `approval = 'pending'`); the INSERT
  column grant already includes `id, taken_at, taken_at_estimated, mime, bytes`.
- Comment on `photos.duplicate_of_photo_id`: "near-duplicate (pHash within
  `PHASH_NEAR_DUPLICATE_MAX_DISTANCE`) of an earlier live photo; exact duplicates never keep a row".

**`audit_log`**: no DDL; new events in 2.6. The existing `audit_log_pipeline_insert` policy
(`actor_user_id IS NULL`) covers the worker's `safety.hash_match` and `photo.purged` rows.

**pg-boss grants** (bootstrap, `packages/db/src/bootstrap.ts`): the API now enqueues. Verify
that `littlelight_api` has `USAGE ON SCHEMA pgboss` and that the step-2 `ALTER DEFAULT
PRIVILEGES FOR ROLE littlelight_worker IN SCHEMA pgboss` covers every table/sequence/function
pg-boss 12 creates (per-queue partitions are created by `littlelight_worker` at runtime, so
default privileges apply). If pg-boss's `send` needs a function the API lacks, grant it
minimally and document it. The API never creates queues or runs pg-boss maintenance (2.5).

Regenerate `packages/db/src/generated` (`pnpm db:types`); README migration table + a "Uploads
and ingest" section (states, duplicate marker, quarantine, purge policy); the CI stub needs no
change.

### 2.4 API routes (backend-engineer; all under `/api`, zod-validated, errors per `apiErrorSchema`)

Guards: Auth = `requireAuth` + `withClaims`; Consent = `requireConsent`; "member/admin" is
enforced by RLS (the route reads the caller's role only to pick 403 vs 404, as `routes/babies.ts`
does). Every query names its columns (column grants). `uploaded_by`, `created_by` = `ctx.uid`.

| Method, path | File | Request → Response | Behaviour |
| --- | --- | --- | --- |
| `POST /babies/:id/uploads` | `uploads/routes.ts` | `uploadSessionCreate` → 201 `uploadSession` | Member of the baby (contributors too). Pre-check: baby not trashed; free plan and live photo count ≥ 1000 ⇒ 409 `free_tier_limit`. Inserts `upload_sessions` with details; audit `upload.session_created`. |
| `GET /uploads/:sessionId` | `uploads/routes.ts` | → `uploadSession` | Files with `state`, `error`, `duplicateOfPhotoId`, and `photo` (a `photoSummary` incl. a fresh signed `thumbUrl` once ingested) + `summary` counts. The client polls this (1.5 s while any file is `completed`). No part URLs here (see parts). |
| `POST /uploads/:sessionId/files` | `uploads/routes.ts` | `uploadFilesRegister` (1–100 files) → `uploadFilesRegisterResponse` | For each file: 500/session cap ⇒ 409 `upload_session_full`; expired/finished ⇒ 410 `upload_session_expired`; `bytes > UPLOAD_MAX_FILE_BYTES` ⇒ 413 `file_too_large` (per file, in the response, not a request failure); free-tier headroom (live photos + registered-in-session) ⇒ `free_tier_limit`. **Exact-duplicate pre-check**: `clientSha256` matching a live `photos.sha256` of this baby ⇒ state `duplicate` + `duplicateOfPhotoId`, no upload; a repeat of a `clientSha256` already registered in this session ⇒ `duplicate` with `duplicateOfPhotoId = null`. Otherwise: `id = randomUUID()`, `storage_key = originalKey(babyId, id)`, `CreateMultipartUpload` (api service account), insert `upload_files`, presign `UploadPart` for parts 1..`partCount(bytes)` (TTL `SIGNED_URL_TTL_SEC`), return `parts`. S3 calls happen outside the DB transaction; a failed Create ⇒ that file `failed/storage_error`. |
| `GET /uploads/:sessionId/files/:fileId/parts` | `uploads/routes.ts` | → `uploadPartsResponse` | Resume: `ListParts` ⇒ `uploadedPartNumbers`; fresh presigned URLs for the missing parts. State must be `registered`. |
| `POST /uploads/:sessionId/files/:fileId/complete` | `uploads/routes.ts` | → `uploadFile` | Server-driven: `ListParts`; every part 1..N present and `Σ size == declared_bytes` else 409 `upload_incomplete` with `details.missingPartNumbers` (file stays `registered`); `CompleteMultipartUpload` (ETags from ListParts); `HeadObject` ⇒ `ContentLength == declared_bytes` else abort + `failed/upload_incomplete`. Then one `withClaims` transaction: `INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, mime, bytes, approval, taken_at, taken_at_estimated)` with `id = fileId`, `approval = 'approved'` for admins / `'pending'` for contributors (RLS enforces), `taken_at = taken_at_hint` + `taken_at_estimated = true` (ingest overwrites); `INSERT INTO photo_details` when the session has details (`edited_by = ctx.uid`); `UPDATE upload_files SET state='completed', photo_id`. Trigger `free tier photo limit reached` ⇒ `failed/free_tier_limit` + 409 `free_tier_limit`. After commit: `boss.send(JOBS.ingest, {photoId, babyId, uploadFileId, tzHint}, {singletonKey: photoId, retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600})`; a send failure is logged (category only) and left to the reconcile job (2.5). Returns the file (state `completed`, `photo` without thumb yet). |
| `DELETE /uploads/:sessionId/files/:fileId` | `uploads/routes.ts` | → 204 | `AbortMultipartUpload` + state `aborted`. Only while `registered`. |
| `POST /uploads/:sessionId/finish` | `uploads/routes.ts` | → `uploadSession` | `finished_at = now()`; audit `upload.session_finished {count: completed+ingested, duplicates, failed}`. Idempotent. |
| `GET /babies/:id/photos` | `photos/routes.ts` | `photosListQuery` → `photosListResponse` | `view=album` (default): `deleted_at IS NULL AND approval <> 'rejected' AND status <> 'duplicate'` (pending included, flagged; contributors see own pending + approved by RLS); `view=pending`: `approval = 'pending' AND deleted_at IS NULL`; `view=trash` (admin): `deleted_at IS NOT NULL`. Order `COALESCE(taken_at, created_at) DESC, id DESC`; keyset cursor = base64url(`<iso>|<id>`); `limit` ≤ 200 (default 100). Each item gets a signed `thumbUrl` (TTL 3600 s) when a `thumb` derivative row exists. `pendingCount` for the admin badge. |
| `GET /photos/:id` | `photos/routes.ts` | → `photo` | Summary + signed `displayUrl` + `exif` (the authenticated-visible columns of `photo_exif`: never GPS, never `raw_json`) + `details`. |
| `GET /photos/:id/original` | `photos/routes.ts` | → `originalUrlResponse` | **Admins only** (403 `forbidden` for contributors). Signed `GetObject` for `storage_key_original`, TTL 3600 s, `ResponseContentType = photos.mime`, `ResponseContentDisposition = attachment; filename="<photoId>.<ext>"`. Audit `photo.original_downloaded {photo_id}`. The original carries GPS by definition; this is the admin's own data (FR-10.1 export path), never a viewer's. |
| `POST /photos/:id/approve` | `photos/routes.ts` | → `photoSummary` | `UPDATE photos SET approval='approved', approved_by=$uid, approved_at=now() WHERE id=$1 AND approval='pending' AND deleted_at IS NULL` (RLS: admins only; 0 rows ⇒ 403/404/409). Audit `photo.approved {photo_id}`. Ingest already ran; step 6 picks `ingested + approved + paid` photos up from here. |
| `POST /photos/:id/reject` | `photos/routes.ts` | → `photoSummary` | `approval='rejected', deleted_at=now()` (rejected uploads go to the trash and purge after 30 days). Audit `photo.rejected`. |
| `DELETE /photos/:id` | `photos/routes.ts` | → 204 | Soft delete `deleted_at = now()` (admins any photo; contributors their own pending — RLS). Audit `photo.trashed`. Viewers lose access at once (step-2 policies). |
| `POST /photos/:id/restore` | `photos/routes.ts` | → `photoSummary` | `deleted_at = NULL` (admin). Audit `photo.restored`. |

Error mapping additions (`lib/errors.ts` `CHECK_VIOLATIONS`): `free tier photo limit reached` →
409 `free_tier_limit` ("This album is on the free plan, which holds 1,000 photos"); `upload
session is full` → 409 `upload_session_full`; `upload session is closed` → 410
`upload_session_expired`. Request logging: `req.body.files` is never logged (hashes are not
secrets, but bodies of 100 entries are noise); signed URLs are never logged (they are
capability tokens) — add `res.body` is not logged anyway; the `redactUrl` TOKEN_SEGMENT rule
already hides `X-Amz-Signature`-style query strings.

### 2.5 Jobs (`@littlelight/shared` `src/jobs.ts`, re-exported by `apps/worker/src/jobs.ts`)

| Job | Payload (zod) | Producer | Schedule / options | Handler (worker, role `pipeline`) |
| --- | --- | --- | --- | --- |
| `photo.ingest` | `ingestJobSchema {photoId: uuid, babyId: uuid, uploadFileId?: uuid, tzHint?: IANA tz string}` | api (after complete), `ingest.reconcile` | `singletonKey = photoId`, `retryLimit 3`, `retryDelay 30 s`, `retryBackoff`, `expireInSeconds 600`; `INGEST_CONCURRENCY` (default 2) handlers per worker process | 2.6 |
| `ingest.reconcile` | `{}` | worker cron `*/5 * * * *` (singleton) | – | `SELECT id, baby_id FROM photos WHERE status = 'uploaded' AND created_at < now() - interval '2 minutes' LIMIT 500` → `send(photo.ingest)` each (singletonKey dedupes). Covers lost sends, API restarts between commit and send, and worker crashes. |
| `purge.trash` | `{}` | worker cron `7 * * * *` (singleton, `singletonSeconds 3300`) | – | 2.8 |
| `uploads.sweep` | `{}` | worker cron `23,53 * * * *` (singleton) | – | 2.8 |

pg-boss usage rules: the worker owns queue creation (`createQueue` for each name at startup,
idempotent) and scheduling (`schedule`); it keeps `connectionString: DATABASE_URL`
(`littlelight_worker`). The API runs a **send-only** pg-boss instance on its own pool role
(`littlelight_api`, which has grants on the `pgboss` schema): no migrations, no maintenance, no
scheduling (whatever pg-boss 12's option names are: the intent is `migrate: false`,
`supervise: false`, `schedule: false`). `boss.send` is the only database call the API ever
makes outside `runAs` (documented in `plugins/jobs.ts`); it must never run inside a `runAs`
transaction (that transaction is `SET LOCAL ROLE authenticated`, which has no `pgboss` grants).
On a fresh stack the worker may not have created the queue yet when the first send happens:
the API retries once after 1 s, then relies on `ingest.reconcile`. Payloads carry ids and a tz
name only: never keys with signatures, bytes, GPS, notes or emails.

### 2.6 Shared contracts (`@littlelight/shared`, architect-defined, backend-engineer writes in 4.2)

`src/upload.ts`: `UPLOAD_PART_BYTES = 16 MiB`, `UPLOAD_MAX_FILE_BYTES = 100 MiB`,
`UPLOAD_MAX_FILES_PER_SESSION = 500`, `UPLOAD_MAX_FILES_PER_REQUEST = 100`,
`UPLOAD_SESSION_TTL_HOURS = 24`, `UPLOAD_CONCURRENCY = 4` (client files in flight),
`SIGNED_URL_TTL_SEC = 3600`, `ACCEPTED_UPLOAD_MIMES = photoMimeSchema.options`,
`ACCEPTED_UPLOAD_EXTENSIONS = ['.jpg','.jpeg','.png','.heic','.heif','.webp']`,
`DERIVATIVE_LONG_EDGE = { thumb: 320, display: 1600, analysis: 768 } as const`,
`DERIVATIVE_JPEG_QUALITY = 75`, `PHASH_NEAR_DUPLICATE_MAX_DISTANCE = 10` (Hamming, of 64 bits),
`partCount(bytes)`, `originalKey`, `derivativeKey`, `babyPrefix`, `photoPrefixes`,
`uploadFileStateSchema`, `uploadFileErrorSchema` (values exactly as the CHECKs in 2.3),
`extensionForMime(mime)`.

`src/age.ts`: `localCalendarDate(at: Date, tzOffsetMinutes: number | null): string` (`YYYY-MM-DD`
of `at` shifted by the offset; `null` ⇒ UTC) and `ageDays(birthDate: 'YYYY-MM-DD', takenAt:
Date, tzOffsetMinutes: number | null): number` (calendar-day difference; may be negative for
due-date babies — stored as is). Weeks/months formatting is step 5.

`src/jobs.ts`: `JOBS = { ingest: 'photo.ingest', ingestReconcile: 'ingest.reconcile',
purgeTrash: 'purge.trash', uploadsSweep: 'uploads.sweep' } as const`, `ingestJobSchema`.

`src/api/uploads.ts`:
`uploadDetailsSchema {milestoneId: uuid.nullish(), people: array(trim 1..60).max(20).optional(),
note: trim max 2000 nullish, locationLabel: trim max 120 nullish}`;
`uploadSessionCreateSchema {details?: uploadDetails}`;
`uploadFileRegisterSchema {clientId: string 1..64, bytes: int 1..UPLOAD_MAX_FILE_BYTES,
clientSha256?: /^[0-9a-f]{64}$/, mime?: photoMime, takenAt?: isoDateTime, tzOffsetMinutes?: int -840..840}`;
`uploadFilesRegisterRequestSchema {files: array(uploadFileRegister).min(1).max(100)}`;
`uploadPartSchema {partNumber: int ≥ 1, url: url}`;
`uploadFileSchema {id: uuid, clientId: string|null, state: uploadFileState, error: uploadFileError|null,
bytes: int, partSize: int, partCount: int, duplicateOfPhotoId: uuid|null, photo: photoSummary|null,
parts?: uploadPart[]}` (parts only in register/parts responses);
`uploadSummarySchema {registered, completed, ingested, duplicates, failed, aborted}` (ints);
`uploadSessionSchema {id, babyId, createdAt, expiresAt, finishedAt|null, details: uploadDetails,
summary, files: uploadFile[]}`; `uploadFilesRegisterResponseSchema {files}`;
`uploadPartsResponseSchema {uploadedPartNumbers: int[], parts: uploadPart[]}`.

`src/api/photos.ts`:
`photoSummarySchema {id, babyId, status: photoStatus, approval: photoApproval, takenAt: isoDateTime|null,
takenAtEstimated: boolean, ageDays: int|null, width|null, height|null, mime: photoMime|null,
isSensitive: boolean, duplicateOfPhotoId: uuid|null, uploadedBy: uuid|null, createdAt, deletedAt|null,
thumbUrl: url|null, urlExpiresAt: isoDateTime|null}`;
`photoExifSchema {takenAt|null, tzOffsetMinutes|null, cameraMake|null, cameraModel|null, placeLabel|null}`;
`photoDetailsSchema {milestoneId|null, note|null, people: string[], locationLabel|null}`;
`photoSchema = photoSummary & {displayUrl: url|null, exif: photoExif|null, details: photoDetails|null}`;
`photosListQuerySchema {view: enum(album,pending,trash) default album, cursor?: string, limit: int 1..200 default 100}`;
`photosListResponseSchema {photos: photoSummary[], nextCursor: string|null, pendingCount: int}`;
`originalUrlResponseSchema {url, expiresAt}`; `photoIdParamsSchema`, `uploadParamsSchema {sessionId}`, `uploadFileParamsSchema {sessionId, fileId}`.

`src/db-enums.ts`: `photoStatusSchema` gains `"duplicate"` (last). `src/api/errors.ts` gains
`free_tier_limit`, `upload_session_full`, `upload_session_expired`, `upload_incomplete`,
`unsupported_media_type`, `file_too_large`. `src/auth.ts` `AUDIT_EVENTS` gains
`upload.session_created`, `upload.session_finished`, `photo.approved`, `photo.rejected`,
`photo.trashed`, `photo.restored`, `photo.original_downloaded`, `photo.purged`,
`safety.hash_match`; `auditMetadataSchema` gains optional `session_id: uuid`, `photo_id: uuid`,
`count`, `duplicates`, `failed` (ints), `error: uploadFileError`. Still never emails, IPs,
tokens, GPS, notes, URLs. `src/env.ts`: `ingestEnvSchema {INGEST_CONCURRENCY: int 1..8 default 2,
STORAGE_DISK_PATH: string optional, STORAGE_DISK_ALERT_PCT: int 50..99 default 80, CSAM_MATCHER:
enum(none, photodna) default none, PHOTODNA_API_KEY?: string, PHOTODNA_ENDPOINT?: url}`.
`index.ts` re-exports everything.

### 2.7 Ingest pipeline (worker, backend-engineer; `apps/worker/src/ingest/**`)

`apps/worker/src/db.ts` — `runAsPipeline<T>(pool, {dataKey?: string | null}, fn)`: a copy of
the API's `runAs` mechanics (BEGIN; `SET LOCAL ROLE pipeline` from a frozen one-entry map;
`SELECT set_config('app.data_key', $1, true)` as a bind parameter only when `dataKey` is given;
COMMIT/ROLLBACK; then `RESET ROLE; DISCARD ALL` outside any transaction, destroying the client
if that fails). `dataKey` is bound only in the transaction that writes `photo_exif` (GPS) and
reads `babies.home_*_enc`; never in others. Nothing in the worker queries app tables outside
this wrapper (pg-boss and the heartbeat use `littlelight_worker` directly, as today).

`apps/worker/src/storage.ts` — `getObject(key) → Buffer` (fails above
`UPLOAD_MAX_FILE_BYTES`), `putObject(key, buffer, 'image/jpeg', {CacheControl: 'private,
max-age=3600'})`, `deleteAllVersions(prefix)` (`ListObjectVersions` incl. delete markers →
`DeleteObjects` with `VersionId`s, paginated, idempotent), `listMultipartUploads(prefix)`,
`abortMultipartUpload(key, uploadId)`.

`ingestPhoto(deps, payload)` (`ingest/index.ts`), idempotent and safe under `--scale worker=3`
(pg-boss gives a job to one worker; `singletonKey` prevents a second queued copy; every write
is an upsert or a guarded UPDATE):

1. **Load** (pipeline): `SELECT id, baby_id, status, approval, storage_key_original, created_at,
   deleted_at, quarantined_at FROM photos WHERE id = $1`. No row, `deleted_at` set, status
   `ingested`/`queued`/`analyzing`/`ready`/`duplicate` or `quarantined_at` set ⇒ return (done).
   Proceed for `uploaded` and `failed` (manual re-run).
2. **Fetch** the original from `storage_key_original`. Missing object ⇒ fail `storage_error`
   (retryable for 3 attempts, then `status = 'failed'`).
3. **Sniff** (`ingest/sniff.ts`, `file-type`): magic bytes → one of the five mimes
   (`heic`/`heix`/`hevc` brands ⇒ `image/heic`; `mif1`/`heif` ⇒ `image/heif`). The client's
   `mime` hint and extension are ignored. Anything else ⇒ **non-retryable** fail:
   `status = 'failed'`, `upload_files.state = 'failed', error = 'unsupported_media_type'`,
   `deleteAllVersions(originalKey)` (no reason to keep a non-image), return.
4. **Hash + exact dedupe** (`ingest/hash.ts`): `sha256(bytes)`; own transaction `UPDATE photos
   SET sha256 = $1, mime = $2, bytes = $3 WHERE id = $4`. SQLSTATE `23505`
   (`photos_baby_id_sha256_key`) ⇒ **duplicate path**: find the surviving row (`SELECT id FROM
   photos WHERE baby_id = $1 AND sha256 = $2 AND deleted_at IS NULL AND id <> $3`); `UPDATE photos
   SET status = 'duplicate', duplicate_of_photo_id = $existing`; `UPDATE upload_files SET state
   = 'duplicate', duplicate_of_photo_id = $existing WHERE id = $photoId`; COMMIT;
   `deleteAllVersions(originalKey)`; `DELETE FROM photos WHERE id = $1` (policy allows
   `status = 'duplicate'`; cascades `photo_details`); return. The unique partial index is the
   race arbiter for two identical files completing concurrently on different workers.
5. **EXIF** (`ingest/exif.ts`, `exifr` with `reviveValues: false`, `translateKeys: true`,
   blocks `ifd0, exif, gps`): `DateTimeOriginal` (fallback `CreateDate`, `ModifyDate`) parsed
   from the raw `YYYY:MM:DD HH:MM:SS` string with `OffsetTimeOriginal` (fallback `OffsetTime`);
   if no offset tag, interpret the wall time in `payload.tzHint` (the uploader's profile
   timezone, passed by the API because `pipeline` cannot read `profiles.timezone`) and set
   `tz_offset_minutes` to that zone's offset at that instant; if no date at all ⇒ `taken_at =
   photos.created_at`, `taken_at_estimated = true`, offset NULL. GPS: `latitude`/`longitude`
   decimal from exifr's gps block, held only in a local variable. `camera_make`, `camera_model`,
   `orientation`, `ExifImageWidth/Height`. **`raw_json` is a whitelist**, never the parsed
   object: `Make, Model, LensModel, Software, DateTimeOriginal, OffsetTimeOriginal, Orientation,
   ExifImageWidth, ExifImageHeight, FNumber, ExposureTime, ISO, FocalLength, Flash, WhiteBalance,
   ColorSpace` (strings/numbers only). No `UserComment`, `ImageDescription`, `Artist`,
   `Copyright`, no GPS, no MakerNotes (the DB trigger is the tripwire, not the filter).
6. **Decode** (`ingest/decode.ts`): JPEG/PNG/WebP ⇒ `sharp(buf, {limitInputPixels: 80e6,
   failOn: 'error'}).rotate()` (auto-orient from EXIF, then EXIF is gone). HEIC/HEIF ⇒
   `heic-decode` (WASM libheif; primary image) ⇒ RGBA raw ⇒ `sharp(raw, {raw: {width, height,
   channels: 4}})`; libheif applies the container's `irot`/`imir` transforms, so **no second
   rotation** from EXIF `Orientation` (verified by the portrait fixture, R2). Decode failure ⇒
   non-retryable fail `decode_failed` (original kept; admin can delete).
7. **Derivatives** (`ingest/derivatives.ts`): for `thumb` (320), `display` (1600), `analysis`
   (768): `.resize({width: n, height: n, fit: 'inside', withoutEnlargement: true})
   .jpeg({quality: 75, mozjpeg: true, progressive: true})` to sRGB; **no** `withMetadata`,
   `keepExif`, `keepMetadata`, `keepIccProfile` or `withIccProfile` anywhere in the worker (sharp
   strips EXIF/XMP/IPTC/ICC by default; a unit test asserts `metadata().exif === undefined`
   on each output and a grep in CI fails on those method names under `apps/worker/src`).
   Record `width/height/bytes` of each.
8. **Safety** (`ingest/safety.ts`, 2.9): `matcher.check({sha256, image: analysisBuffer, mime:
   'image/jpeg'})`. On `matched` ⇒ `UPDATE photos SET quarantined_at = now(), status =
   'failed'`, `upload_files` `failed/rejected`, audit `safety.hash_match` (actor NULL, `baby_id`,
   metadata `{photo_id}`), **no derivative is uploaded**, the original is kept, return.
9. **Upload thumb first**: `putObject(derivativeKey(…,'thumb'))` then upsert
   `photo_derivatives (photo_id, kind, storage_key, width, height, bytes) ON CONFLICT (photo_id,
   kind) DO UPDATE` in its own short transaction — the thumbnail becomes visible to the API before
   display/analysis exist. Then display, then analysis (the analysis copy is produced for every
   photo of every tier and **never leaves the bucket in this step**; step 6 reads it only for
   `approved` photos of paid babies).
10. **pHash** (`ingest/phash.ts`, in-house, no dependency): grayscale 32×32 via sharp
    (`.greyscale().resize(32, 32, {fit: 'fill'}).raw()`), 2-D DCT, top-left 8×8 minus DC,
    median threshold ⇒ 64 bits as a `'0'/'1'` string for `bit(64)`. Near-duplicate: `SELECT id
    FROM photos WHERE baby_id = $1 AND id <> $2 AND deleted_at IS NULL AND phash IS NOT NULL AND
    bit_count(phash # $3::bit(64)) <= 10 ORDER BY created_at LIMIT 1` ⇒ `duplicate_of_photo_id`
    (flag only; the photo stays).
11. **Final transaction** (pipeline, `dataKey` bound): `INSERT INTO photo_exif (photo_id,
    taken_at, tz_offset_minutes, gps_lat_enc, gps_lng_enc, place_label, camera_make,
    camera_model, orientation, raw_json) VALUES (…, encrypt_coord($lat), encrypt_coord($lng), …)
    ON CONFLICT (photo_id) DO UPDATE` (NULLs when no GPS; lat/lng are bind parameters only);
    `place_label = 'Home'` when the baby has `home_*_enc` and the haversine distance ≤
    `HOME_RADIUS_M` (`decrypt_coord` in SQL, distance computed in SQL so plaintext never reaches
    Node) else NULL (no external reverse geocoding: that would send GPS to a third party, D7);
    `UPDATE photos SET width, height, phash, taken_at, taken_at_estimated, age_days =
    ageDays(babies.birth_date, taken_at, tz_offset_minutes), duplicate_of_photo_id, status =
    'ingested'`; `UPDATE upload_files SET state = 'ingested'`.
12. Logging: `photoId`, `babyId`, mime, byte sizes, durations, error categories (`errorCategory`).
    Never buffers, never EXIF values, never coordinates, never keys with signatures.

Transient errors (storage/DB) throw and let pg-boss retry (3×, backoff); on the last failure
the handler marks `status = 'failed'`, `upload_files.failed/storage_error`. Semantic failures
(steps 3, 6, 8) are marked immediately and do not throw.

### 2.8 Trash purge and sweep (worker, backend-engineer)

`purge.trash` (`apps/worker/src/purge.ts`), hourly, as `pipeline`, in batches of 100, all
object deletions before the row deletion (a crash leaves a row the next run retries):

1. Babies: `SELECT id FROM babies WHERE deleted_at < now() - interval '30 days'` ⇒
   `deleteAllVersions(babyPrefix(id))` ⇒ `DELETE FROM babies WHERE id = $1` (step-2 pipeline
   policy; cascades photos, members, share links, chat). Audit `photo.purged` is not written per
   photo here; one log line with counts.
2. Photos: `SELECT id, baby_id FROM photos WHERE deleted_at < now() - interval '30 days' AND
   quarantined_at IS NULL` ⇒ `deleteAllVersions` of both `photoPrefixes` ⇒ `DELETE FROM photos
   WHERE id = $1` (cascades derivatives, exif, details, search rows — "vector entries" in
   FR-10.2 are rows of `photo_search`, gone with the cascade).
3. Leftover duplicates: `status = 'duplicate'` rows (worker died between the marker and the
   delete) ⇒ same as 2.
4. Orphaned upload objects: `upload_files` in `failed`/`aborted` with `updated_at < now() -
   interval '1 hour'` and an object at `storage_key` ⇒ `deleteAllVersions(storage_key)`;
   mark `error` unchanged.

FR-10.2's "within 24 h (hard delete after 30-day trash)" is satisfied by the hourly schedule.
Versioning: explicit version deletion is the mechanism (deterministic, tested); storage-init
additionally adds a lifecycle backstop (noncurrent versions expire after 7 days, expired delete
markers removed) so a version missed by a bug cannot linger (D6).

`uploads.sweep` (`apps/worker/src/uploads-sweep.ts`), twice an hour: sessions with
`expires_at < now()` ⇒ for their `registered` files: `abortMultipartUpload` (ignore
`NoSuchUpload`), `state = 'aborted', error = 'expired'`; plus `listMultipartUploads(prefix
'babies/')` and abort any initiated > 48 h ago that no `registered` file references.

### 2.9 Safety: CSAM hash matching seam (worker, backend-engineer)

```ts
export interface CsamMatcher {
  readonly name: 'none' | 'photodna';
  check(input: { sha256: Buffer; image: Buffer; mime: 'image/jpeg' }): Promise<{ matched: boolean; reference?: string }>;
}
```
`createCsamMatcher(env)`: `none` ⇒ `NoopCsamMatcher` (always `matched: false`; one startup log
line `CSAM matching disabled (CSAM_MATCHER=none)`, `warn` level in production); `photodna` ⇒
`PhotoDnaMatcher` that fails at startup unless `PHOTODNA_API_KEY` and `PHOTODNA_ENDPOINT` are
set, posts the 768-px analysis JPEG to the Microsoft PhotoDNA Cloud Service match endpoint and
returns `matched` from the response (the call sends image bytes to a third party: it needs the
user's enrolment and DPA, section 5). Never log the image, never log the reference. A positive
match quarantines (2.7 step 8); the NCMEC report flow is an operator procedure outside this step.

### 2.10 Serving derivatives

`apps/api/src/storage/sign.ts`: `signGet(key, {ttlSec = SIGNED_URL_TTL_SEC, contentType?,
contentDisposition?})` and `signUploadPart(key, uploadId, partNumber)` on the signer client
(`S3_PUBLIC_ENDPOINT`). TTL is capped at 3600 s in code (PRD "valid ≤ 1 hour"); every URL is a
presigned `GetObject` for exactly one key (PRD "scoped to one object"). Only `thumb` and
`display` keys are ever signed for users; `analysis` is never signed (step 6 reads it
server-side); originals only through the admin route in 2.4. Viewers (step 8) will reuse
`signGet` for thumb/display only. `urlExpiresAt` accompanies every URL so the SPA refetches
before expiry (TanStack `staleTime` 45 min).

### 2.11 MinIO service accounts, lifecycle, CORS, disk (devops-engineer)

| Item | Dev (`docker-compose.dev.yml`, `.env.dev`) | Prod (`docker-compose.yml`, `.env.example`) |
| --- | --- | --- |
| Root credentials | `x-dev-shared` `s3-root-*` (rename of the existing `s3-access-key`/`s3-secret-key`): only `storage` and `storage-init` | `S3_ROOT_USER`/`S3_ROOT_PASSWORD` in `.env` (rename; `S3_ACCESS_KEY`/`S3_SECRET_KEY` are no longer root): only `storage` and `storage-init` |
| Service accounts | `storage-init` runs `mc admin user add local littlelight-api <secret>` and `… littlelight-worker <secret>` (secrets `dev-api-s3-secret-16`, `dev-worker-s3-secret-16`, literals in `x-dev-shared`), `mc admin policy create local littlelight-api docker/minio/policy-api.json` (bucket name substituted with `sed` into a tmp file), same for worker, `mc admin policy attach … --user …` (tolerate "already attached"). Idempotent on every start | same with `S3_API_ACCESS_KEY`/`S3_API_SECRET_KEY`, `S3_WORKER_ACCESS_KEY`/`S3_WORKER_SECRET_KEY` from `.env` (`openssl rand -hex 8` / `-hex 20`: MinIO access keys 3–20 chars, secrets 8–40) |
| api env | `S3_ACCESS_KEY: littlelight-api`, `S3_SECRET_KEY: <api secret>` (app code unchanged) | `S3_ACCESS_KEY: ${S3_API_ACCESS_KEY:?}` … |
| worker env | `S3_ACCESS_KEY: littlelight-worker`, … ; `INGEST_CONCURRENCY: ${INGEST_CONCURRENCY:-2}`; `STORAGE_DISK_PATH: /storage`; volume `dev-s3:/storage:ro` | same; volume `${STORAGE_PATH}:/storage:ro`; `STORAGE_DISK_ALERT_PCT: ${STORAGE_DISK_ALERT_PCT:-80}`; `CSAM_MATCHER: ${CSAM_MATCHER:-none}`, `PHOTODNA_*: ${…:-}` |
| Policies (`docker/minio/policy-api.json`, `policy-worker.json`) | api: `s3:GetBucketLocation`, `s3:ListBucket`, `s3:ListBucketMultipartUploads` on the bucket; `s3:GetObject`, `s3:PutObject`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts` on `bucket/*`. **No** delete, no version actions. worker: everything api has plus `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:ListBucketVersions`, `s3:GetObjectVersion`. Neither has `admin:*` or other buckets | same files |
| Lifecycle | `mc ilm rule add local/$BUCKET --noncurrent-expire-days 7 --expired-object-delete-marker` (tolerate "already exists") | same |
| CORS | default (`*`) | `MINIO_API_CORS_ALLOW_ORIGIN: ${PUBLIC_URL}` on `storage` |
| Tunnel | – | `docker/cloudflared/config.example.yml`: the `files.` ingress keeps the original Host header and routes only paths under `/${S3_BUCKET}/` to `http://storage:9000` (everything else on that hostname ⇒ 404), so no MinIO admin/metrics path is public |
| Disk alert | heartbeat reads `fs.statfs(STORAGE_DISK_PATH)` each beat (skipped with one log line when unset or not mounted); `details.diskUsedPct`; `warn` once when crossing `STORAGE_DISK_ALERT_PCT`, `info` when back under | same; `SENTRY_DSN` hook later |
| CI `check` job | start MinIO with `docker run -d -p 9000:9000 … $MINIO_IMAGE server /data` (service containers cannot set a command) + env `S3_*` so the worker ingest integration tests run; the test harness creates the bucket if missing | – |
| CI `dev-stack-smoke` | after e2e: `pnpm e2e:upload-gate` (4.9); upload `e2e/report` on failure as today | – |
| Worker image | no OS packages needed (`sharp` prebuilt musl x64/arm64 ≥ 1.2.5 is what `node:22.23.3-alpine` ships; `heic-decode` is WASM); verify `pnpm install` needs no `allowBuilds` entry for sharp 0.34 (it has no install script) | same; `mem_limit: 2g` on `worker` (two concurrent 48 MP HEIC decodes ≈ 800 MB RSS) |

### 2.12 Frontend (frontend-engineer, `apps/mobile-web/src/**`)

- `lib/upload/manager.ts` — `UploadManager` (plain class + `useSyncExternalStore` hook):
  states per file `queued → hashing → registering → uploading(progress 0..1) → completing →
  completed → ingested | duplicate | failed(error) | aborted`; `UPLOAD_CONCURRENCY` files in
  flight, parts of one file sequential; each part PUT via `platform/uploader.ts` (web: `XMLHttpRequest`
  for `upload.onprogress`, `AbortController`-style cancel, 3 retries with backoff; on a 403 —
  signature expired after an hour — refresh URLs via `GET …/parts` and continue); after all parts
  `POST …/complete`; `upload_incomplete` ⇒ re-fetch parts and upload the missing ones; retry
  button per failed file and "Retry failed"; polling `GET /uploads/:id` every 1.5 s while any
  file is `completed`, stops when none is; `POST …/finish` when every file is terminal.
- `lib/upload/hash.ts` — SHA-256 with `crypto.subtle.digest` (whole file, one at a time);
  `lib/upload/exif.ts` — `exifr.parse(file, {pick: ['DateTimeOriginal','OffsetTimeOriginal']})`
  ⇒ `takenAt`/`tzOffsetMinutes` hints (best effort, server is the source of truth; GPS is
  never read in the browser).
- Resume after reload: `localStorage['ll_upload:<babyId>'] = {sessionId, files: [{sha256,
  size, fileId}]}`; on `/upload` with an open session, "Resume previous upload" asks the user to
  pick the files again; files are matched by sha256 + size, completed ones skipped, registered
  ones resumed through `GET …/parts` (browsers cannot hold file handles across reloads).
- `platform/uploader.ts` — step-9 seam: `interface Uploader { putPart(url, blob, {onProgress,
  signal}): Promise<void> }`; web implementation now; the native implementation (background
  URLSession/WorkManager upload of the whole file to the single part URL for files ≤ 16 MiB,
  slicing for larger) is step 9. Part URLs are plain HTTPS `PUT`s with no custom headers, on
  purpose.
- **UploadPage** (`pages/UploadPage.tsx`): `<input type="file" multiple accept=".jpg,.jpeg,.png,.heic,.heif,.webp,image/jpeg,image/png,image/heic,image/heif,image/webp">` behind a 44 px "Choose photos" button, a drag-and-drop zone on pointer devices (`dragover`/`drop`, whole-page highlight), client-side rejection of non-accepted types/sizes with a per-file message; **batch details** (collapsed "Add details to all"): milestone (presets from `MILESTONE_PRESETS` + "Custom…" text), people chips, note, location label ⇒ `POST /babies/:id/uploads {details}` on first file; list rows with filename, size, progress bar, state label, retry/cancel; sticky **summary** "N uploaded, F failed, D duplicates skipped" (i18n key with plural forms) and "View in timeline". `data-testid`s: `upload-input`, `upload-dropzone`, `upload-row-<clientId>`, `upload-retry-<clientId>`, `upload-summary`, `upload-details-toggle`, `upload-milestone`.
- **TimelinePage** (`pages/TimelinePage.tsx`, minimal grid; the age-grouped virtualized timeline is step 5): `useBabyPhotos(babyId, view)` (`useInfiniteQuery` with `nextCursor`), CSS grid of square thumbs (`<img loading="lazy" alt="">` placeholder on error), newest first, "Load more"; a `pending` badge on pending items; admins see a segment "Needs approval (N)" (`view=pending`) with Approve / Reject per item; tap ⇒ action sheet with "Delete" (soft delete, confirm) and, for admins, "Download original". `data-testid`s: `timeline-grid`, `photo-<id>`, `photo-pending-<id>`, `approve-<id>`, `reject-<id>`, `pending-segment`.
- Onboarding **First upload** primer already routes to `/upload`.
- Security notes: signed URLs are used only as `img src`/fetch targets, never persisted; no
  third-party scripts; the client never sends GPS; `clientSha256` is a hint.

### 2.13 Tests and gate (test-engineer; `**/*.test.ts`, `e2e/**`)

- Unit, worker: `ingest/sniff.test.ts` (magic bytes for jpeg/png/webp/heic `ftypheic`/heif
  `ftypmif1`; text/pdf/svg/gif rejected), `ingest/hash.test.ts` (known vector),
  `ingest/phash.test.ts` (same image ⇒ 0; q60 recompression ≤ 10; unrelated noise ≥ 20;
  64-char bit string), `ingest/exif.test.ts` (JPEG built with sharp `withExif` incl. IFD3 GPS:
  GPS extracted to the local variable and absent from the whitelist; offset parsing; missing
  date ⇒ estimated), `ingest/derivatives.test.ts` (sizes incl. `withoutEnlargement`; orientation
  6 input ⇒ rotated dims; `sharp(out).metadata()` has no `exif`, `icc`, `xmp`; JPEG magic),
  `ingest/decode.test.ts` (HEIC fixture ⇒ expected dims; portrait fixture not double-rotated),
  `purge.test.ts` and `uploads-sweep.test.ts` with S3/DB stubs, `disk.test.ts`,
  `db.test.ts` (role map frozen; dataKey bound only when given).
- Unit, shared: `age.test.ts` (`ageDays('2025-06-30', 2026-06-14T23:30Z, -420)` = 349; offset
  crossing midnight; negative before birth), `upload.test.ts` (`partCount`, keys, enums match
  CHECKs), audit metadata additions.
- Unit, api: `uploads/*.test.ts` (register validation and caps; pre-check dedupe; presigned
  URL host = `S3_PUBLIC_ENDPOINT`, TTL ≤ 3600, one key per URL; complete validates parts and
  sizes with a stubbed S3; state machine), `photos/*.test.ts` (cursor encode/decode; `analysis`
  never signed; original route admin-only), `plugins/jobs.test.ts` (send outside `runAs`;
  retry once).
- Integration, db (`packages/db/uploads.integration.test.ts` + additions to
  `rls.integration.test.ts`/`triggers.integration.test.ts`/`migrations.integration.test.ts`):
  stranger 0 rows on both new tables; contributor sees own session + files, not the admin's;
  admin sees all sessions of the baby; a member cannot insert a file into another user's session
  (trigger); 501st file ⇒ "upload session is full"; viewer ⇒ permission denied; pipeline UPDATE
  of `upload_files.state` ok, INSERT denied; `photos.status = 'duplicate'` accepted and
  deletable by pipeline; `quarantined_at` row invisible to admin/contributor/viewer, visible to
  service_role; migration count 11; every table still ENABLE+FORCE; types diff clean.
- Integration, api (`apps/api/src/uploads/uploads.integration.test.ts`,
  `photos/photos.integration.test.ts`; S3 stub + real DB + stubbed pg-boss): session create
  (contributor allowed; free-tier pre-check); register with a seeded sha ⇒ duplicate; complete
  as admin ⇒ `approval = 'approved'`, as the nanny ⇒ `'pending'`; details inserted; list views;
  approve/reject/trash/restore permissions (contributor approve ⇒ 403); original URL admin-only.
- Integration, worker (`apps/worker/src/ingest/ingest.integration.test.ts`, skipped unless
  `DATABASE_URL` and `S3_ENDPOINT` are set; harness creates the bucket): put generated JPEG
  (with GPS), PNG, WebP and the HEIC fixtures into MinIO, insert photo rows as superuser, call
  `ingestPhoto` directly ⇒ derivatives exist with the expected sizes and no metadata;
  `photo_exif.gps_lat_enc IS NOT NULL` and `decrypt_coord` round-trips under `app.data_key`;
  `raw_json` has no GPS keys; `age_days` correct; estimated flag when no EXIF; exact duplicate
  ⇒ row gone and object versions gone; near-duplicate flagged; non-image ⇒ failed +
  `unsupported_media_type`; matcher stub returning `matched` ⇒ quarantined, no derivatives;
  re-running `ingestPhoto` on an ingested photo is a no-op; `purge.trash` on a photo trashed 31
  days ago removes every version and the row.
- **Gate** `e2e/upload/gate.ts` (`pnpm e2e:upload-gate`, `tsx`, cookie-jar fetch helpers from
  `e2e/helpers/api.ts`, Mailpit OTP): signs in a fresh user, consents, creates a baby
  (free plan), creates a session, generates 200 files into a temp dir: 170 JPEG (sharp noise/
  gradient images, unique seeds, 1200–4000 px, 150 with IFD3 GPS via `withExif`), 8 PNG, 5 WebP
  (= 183), of which 20 are byte-exact copies of earlier JPEGs, 3 are q60 recompressions of
  earlier JPEGs (near-duplicates), 5 HEIC fixtures from `e2e/fixtures/heic/` (2.14), and 2
  text files named `.jpg`; so 178 unique valid, 20 exact duplicates, 2 invalid. Registers in
  batches of 100 with client SHA-256 (set `clientSha256` only for half of the duplicates so the
  server-side path is exercised too), uploads parts with concurrency 4, completes, records
  `t0` per file at the complete response, polls the session every 250 ms, records `t1` when
  `photo.thumbUrl` appears and `t2` when a `GET thumbUrl` returns 200. Asserts: wall time
  < 5 min; summary `178 ingested, 2 failed, 20 duplicates`; the 3 near-duplicates have
  `duplicateOfPhotoId` and are not skipped; every HEIC photo has `mime image/heic` and JPEG
  derivatives (magic `FF D8`); p95(`t2 − t0`) < 5 s (prints p50/p95/max); for every ingested
  photo fetch thumb + display: `exifr.parse(buf)` is `undefined`/no `latitude`, `exifr.gps(buf)`
  is `undefined`, `sharp(buf).metadata()` has no `exif`/`xmp`/`icc`; `GET /photos/:id/original`
  bytes hash equals the generated file's sha256 for 5 samples (originals untouched); DB checks as
  superuser: `count(*) FROM photo_exif WHERE gps_lat_enc IS NOT NULL` = 150 + GPS HEICs, and
  no `photos` row with `status = 'duplicate'` remains. Then trashes 3 photos, fast-forwards
  them (`UPDATE photos SET deleted_at = now() - interval '31 days'` as superuser), triggers
  `purge.trash` (`docker compose exec worker pnpm run-job purge.trash`, a tiny CLI in
  `apps/worker/src/run-job.ts`) and asserts rows and all object versions are gone
  (`ListObjectVersions` with the root key).
- Playwright `e2e/upload/upload.spec.ts`: picks 6 files (incl. 1 HEIC, 1 duplicate) through the
  UI, sees per-row progress, the summary "4 uploaded, 0 failed, 1 duplicates skipped" (5 files +
  1 dup ⇒ adjust), thumbs in the grid within 10 s; the nanny (`demo-nanny@littlelight.local`)
  uploads 1 photo ⇒ pending badge; mom sees "Needs approval (1)", approves, badge gone.
- Smoke additions: `storage-init` exited 0 and `docker compose exec api printenv S3_ACCESS_KEY`
  is `littlelight-api` (not the root user); worker log contains `queues ready` and
  `CSAM matching disabled`; `pgmigrations` count 11.

### 2.14 HEIC fixtures (`e2e/fixtures/heic/`, test-engineer with the orchestrator)

No encoder is available in Node (sharp prebuilt cannot write HEIC; `heic-decode` only decodes),
so five small HEIC files are generated **once on the orchestrator's Mac** and committed
(each < 60 KB): `plain-640x480.heic` (sips: `sips -s format heic in.jpg --out …`),
`gps-640x480.heic` (GPS written with `exiftool -GPSLatitude=47.6062 -GPSLatitudeRef=N
-GPSLongitude=122.3321 -GPSLongitudeRef=W`; `brew install exiftool` if missing — ask the user
before installing), `portrait-480x640.heic` (an image whose content is visibly asymmetric, so
rotation errors are detectable), `datetime-tz.heic` (`-DateTimeOriginal='2026:06:14 15:04:05'
-OffsetTimeOriginal='-07:00'`), `heif-mif1.heif` (same pixels with the `mif1` brand if `sips`
produces one; otherwise a copy, noted). `e2e/fixtures/README.md` records the exact commands,
image contents (synthetic gradients, no people) and that they are generated in-repo (no licence
question). Unit tests reference them by path.

## 3. Tasks

Owners per `CLAUDE.md`. Lanes: D = devops, B = backend, S = security, F = frontend, T = test.
Same-lane tasks run in sequence unless noted; lanes run in parallel where paths are disjoint.

### 4.1 Dependencies and root scripts (devops-engineer) — first, alone (serial lockfile change)

- Owned for this task only: every `package.json`, `pnpm-lock.yaml`, `.npmrc` (`allowBuilds` only
  if sharp needs it; it should not), root `vitest.config.ts` (add a `worker-integration` project:
  root `./apps/worker`, `**/*.integration.test.ts`, `fileParallelism: false`, 120 s timeouts;
  `test:integration` runs all three projects), root scripts `e2e:upload-gate`.
- Add, pinned to the latest stable past pnpm 12's release-age gate: `apps/api`:
  `@aws-sdk/s3-request-presigner` (same major as `@aws-sdk/client-s3`), `pg-boss` (same version
  as the worker). `apps/worker`: `sharp`, `heic-decode` (+ `@types/heic-decode` if types are not
  bundled), `exifr`, `file-type`. `apps/mobile-web`: `exifr`. Root devDependencies (gate +
  fixtures): `sharp`, `exifr`, `@aws-sdk/client-s3`. No other additions; justification per dep
  in section 5 D9.
- Done-when: `pnpm install --frozen-lockfile` is a no-op afterwards; `pnpm lint && pnpm typecheck
  && pnpm test` green; `docker compose -f docker-compose.dev.yml build worker api` succeeds and
  `docker compose -f docker-compose.dev.yml run --rm worker node -e "import('sharp').then(s=>console.log(s.default.versions))"`
  prints versions (musl prebuilt loads).

### 4.2 Shared contracts (backend-engineer) — lane B, after 4.1 (parallel with 4.3, 4.4)

- Owned: `packages/shared/src/**` (new `upload.ts`, `age.ts`, `jobs.ts`, `api/uploads.ts`,
  `api/photos.ts`; edits to `db-enums.ts`, `api/errors.ts`, `auth.ts`, `env.ts`, `index.ts`).
- Build 2.6 literally. Only `zod`.
- Done-when: typecheck passes; `ageDays`, `partCount`, key helpers and enum values are unit-
  testable (4.8); `photoStatusSchema` includes `duplicate`.

### 4.3 Migration, bootstrap grants, generated types, README (security-engineer) — lane S, after 4.1

- Owned: `packages/db/migrations/1791700000100_uploads-and-ingest.sql`,
  `packages/db/src/bootstrap.ts` (pgboss grants for `littlelight_api` only if missing),
  `packages/db/src/generated/**`, `packages/db/README.md`.
- Build 2.3. Write into the SQL comments and enforce: ENABLE + FORCE RLS on both new tables;
  `viewer` gets nothing on them; `pipeline` never INSERTs or DELETEs them; the session-owner
  trigger is the 500-cap and "no one uploads into someone else's session" guard; the only
  `photos` SELECT change is `quarantined_at IS NULL` on user roles (re-create the viewer policy
  with the same body plus the clause); the pipeline DELETE policy gains exactly `OR status =
  'duplicate'` and excludes quarantined rows; `GRANT UPDATE (quarantined_at)` to `pipeline`
  only. Down migration is the exact inverse (deletes `status='duplicate'` rows first).
- Done-when: `pnpm db:migrate` on the dev stack applies 11 migrations; second run no-op;
  `pnpm db:migrate:down 1 && pnpm db:migrate` round-trips; against the bare stub it applies;
  `pnpm db:types` committed with no diff on re-run; the step-2 hardening query (every table
  ENABLE+FORCE) returns 0; as `littlelight_api` (no SET ROLE) `SELECT count(*) FROM pgboss.queue`
  works; README documents states, duplicate marker, quarantine and purge rules.

### 4.4 Compose, env, MinIO policies, cloudflared example (devops-engineer) — lane D, after 4.1 (parallel with 4.2, 4.3)

- Owned: `docker-compose.dev.yml`, `docker-compose.yml`, `.env.dev`, `.env.example`,
  `docker/minio/policy-api.json`, `docker/minio/policy-worker.json`,
  `docker/cloudflared/config.example.yml`, `apps/worker/Dockerfile` (only if 4.1 showed a need).
- Build 2.11 (all rows except CI). Keep zero-setup dev: new literals live in `x-dev-shared`;
  no new files for the user. Least privilege: `auth`, `web`, `mail` get no S3 values; `api` and
  `worker` get their own service-account keys and never the root ones; `storage-init` is the
  only consumer of root besides `storage`. Document in `.env.example` how to rotate a service
  account (edit `.env`, `up -d --force-recreate storage-init api worker`).
- Done-when: both `docker compose … config -q` pass; from a clean clone `up -d --build --wait`
  is healthy with `storage-init` exited 0 twice in a row (idempotent); `mc admin user info local
  littlelight-api` (via `docker compose run --rm --entrypoint sh storage-init -c …`) shows the
  policy attached; with the api key, `mc rm --versions` on an object is denied while `mc cp`
  into the bucket works; with the worker key both work; `mc admin info` is denied for both;
  `mc ilm rule ls local/littlelight-dev` shows the noncurrent rule; `docker compose exec worker
  sh -c 'ls /storage'` works and is read-only.

### 4.5 API: storage signer, uploads, photos, jobs (backend-engineer) — lane B, after 4.2 and 4.3

- Owned: `apps/api/src/storage/{sign,multipart}.ts`, `apps/api/src/uploads/{routes,service}.ts`,
  `apps/api/src/photos/{routes,queries}.ts`, `apps/api/src/plugins/jobs.ts`, `apps/api/src/app.ts`
  (register the three modules and the send-only pg-boss; signer client from config),
  `apps/api/src/config.ts` (nothing new unless needed), `apps/api/src/lib/errors.ts` (mapping
  additions). Not owned: `apps/api/src/auth/**`, `apps/api/src/sharing/**`.
- Build 2.4, 2.5 (API side), 2.10. Explicit requirements: the client's `mime`, `clientSha256`,
  `takenAt` are hints only; the API never reads object bytes (only `HeadObject`/`ListParts`);
  every signed URL is one key, TTL ≤ 3600, signed on the public-endpoint client; `analysis`
  derivatives and originals are never signed for non-admins; contributors' photos are inserted
  under their own claims (RLS forces `pending`); approval routes rely on RLS and map 0 rows to
  403/404; every query names its columns; `boss.send` only after commit and outside `runAs`;
  no photo bytes, URLs with signatures, hashes-as-secrets or notes in logs; batch details go
  through `photo_details` INSERT under the user's claims (policy `photo_editable`).
- Done-when: the curl walkthrough in 4.2 of section 4 passes by hand against the dev stack
  (session → register → PUT part to `localhost:9000` → complete → `photos` row; list shows the
  photo; nanny's upload is `pending` and invisible in mom's album view until approved; original
  URL 403 for the nanny); `GET /photos/:id` never contains `gps`, `raw_json` or an `analysis` URL.

### 4.6 Worker: pipeline wrapper, ingest, purge, sweep, disk, run-job CLI (backend-engineer) — lane B, may run in parallel with 4.5 as a second invocation (disjoint paths), after 4.2 and 4.3

- Owned: `apps/worker/src/**` except `apps/worker/src/ai/**` (`db.ts`, `storage.ts`,
  `ingest/**`, `purge.ts`, `uploads-sweep.ts`, `reconcile.ts`, `disk.ts`, `run-job.ts`,
  `jobs.ts`, `main.ts`, `heartbeat.ts`, `config.ts`, `package.json` `run-job` script).
- Build 2.5 (worker side), 2.7, 2.8, 2.9, 2.11 disk row. Explicit requirements: every app-table
  query through `runAsPipeline`; `DATA_ENCRYPTION_KEY` bound only in the EXIF transaction; GPS
  only ever in a local variable → `encrypt_coord` bind parameters, never in `raw_json`, logs,
  job payloads or derivative files; `raw_json` is the whitelist; derivatives are produced
  without any metadata-keeping sharp call; the analysis copy is written to the bucket and
  **nothing is sent to any model or external service** (the only outbound call is the CSAM
  matcher, which is `none` by default); HEIC via `heic-decode`, never a second rotation;
  idempotent handler; non-retryable vs retryable failures as in 2.7; purge deletes every object
  version before the row; quarantined rows are never purged; `--scale worker=3` safe
  (singletonKey, cron singletons, upserts); memory: one decoded image per handler at a time,
  buffers dropped after upload.
- Done-when: on the dev stack with 4.5 in place, uploading a JPEG with GPS, a PNG, a WebP and
  `gps-640x480.heic` through the API yields `status = 'ingested'` rows within 5 s each (worker
  log durations), three derivative objects per photo whose `exiftool -a` output (run on the
  Mac on downloaded derivatives) shows no EXIF/GPS/ICC/XMP, `photo_exif.gps_*_enc` set for the
  GPS files and `raw_json` free of GPS keys, `age_days` correct for the seeded birth date; a
  second upload of the same JPEG ends as `duplicate` with the row gone and
  `mc ls --versions` showing no object; a `.txt` renamed `.jpg` ends `failed/unsupported_media_type`;
  `pnpm --filter @littlelight/worker run-job purge.trash` on a photo with `deleted_at` 31 days
  ago removes rows and versions; `docker compose up --scale worker=3` ingests 30 photos with
  no duplicate derivative writes and no errors; heartbeat `details.diskUsedPct` present.

### 4.7 Frontend: upload screen, grid, approval queue (frontend-engineer) — lane F, after 4.2 (parallel with S/B/D; integrates once 4.5/4.6 are up)

- Owned: `apps/mobile-web/src/**` (`lib/upload/**`, `platform/uploader.ts`,
  `pages/UploadPage.tsx`, `pages/TimelinePage.tsx`, `components/PhotoGrid.tsx`,
  `components/UploadRow.tsx`, `lib/queries.ts` additions, `i18n/en.ts`).
- Build 2.12. Security notes: never store signed URLs or tokens beyond the query cache; the
  client reads only capture time from EXIF (never GPS) and only as a hint; resume state in
  `localStorage` holds hashes/ids only; accepted types are enforced client-side for UX and
  server-side for real; no third-party scripts.
- Done-when: `pnpm --filter @littlelight/mobile-web typecheck && test` green; against the dev
  stack a human can pick 20 files (incl. a HEIC and a duplicate), see per-row progress, the
  summary line, thumbs appearing in the grid without a reload, retry a failed file, reload
  mid-upload and resume by re-picking; the nanny's upload shows the pending badge and mom's
  "Needs approval" segment approves it; the e2e in 4.9 drives these by the listed `data-testid`s.

### 4.8 Unit and integration tests (test-engineer) — lane T, after 4.2–4.6

- Owned: `**/*.test.ts`, `apps/worker/src/testing/*` (harness: bucket create, fixture images
  built with sharp), `packages/db/test/{harness,fixtures}.ts` additions.
- Build the unit and integration rows of 2.13. The worker integration suite is
  `describe.skipIf(!DATABASE_URL || !S3_ENDPOINT)`; CI's `check-integration-report.mjs` guard
  must also cover `apps/worker`. Add a lint-style test
  `apps/worker/src/ingest/no-metadata.test.ts` that reads `apps/worker/src/ingest/*.ts` and
  fails if `withMetadata|keepExif|keepMetadata|keepIccProfile|withIccProfile|withExif` appears.
- Done-when: `pnpm test` and `pnpm test:integration` green against the dev stack (with
  `S3_ENDPOINT=http://localhost:9000 S3_PUBLIC_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=dev
  S3_SECRET_KEY=devdevdev S3_BUCKET=littlelight-test …`) and against bare pgvector + a
  standalone MinIO (CI path).

### 4.9 Fixtures, gate script, Playwright spec, smoke (test-engineer) — lane T, after 4.7 and 4.8

- Owned: `e2e/fixtures/**` (with the orchestrator generating the HEICs per 2.14),
  `e2e/upload/gate.ts`, `e2e/upload/upload.spec.ts`, `e2e/helpers/{images,s3}.ts`,
  `e2e/smoke/dev-stack.sh`.
- Build the gate, Playwright and smoke rows of 2.13. The gate prints a table (ingested, failed,
  duplicates, near-duplicates, p50/p95/max thumb latency, wall time) and exits non-zero on any
  failed assertion; unique emails per run; cleans its temp dir.
- Done-when: `pnpm e2e:upload-gate` passes twice in a row on the dev stack with the stated
  numbers and p95 < 5 s; `pnpm e2e` (incl. `upload.spec.ts`) green; `pnpm smoke` green.

### 4.10 CI (devops-engineer) — lane D, after 4.9

- Owned: `.github/workflows/ci.yml`, `.github/scripts/check-integration-report.mjs`.
- Build the CI rows of 2.11 (standalone MinIO in `check`, `apps/worker` in the report guard,
  `e2e:upload-gate` in `dev-stack-smoke`, `e2e/upload/*.ts` in the e2e typecheck glob).
- Done-when: `actionlint` clean; every job's commands pass locally in order.

### Parallelism summary

| Group | Tasks | Notes |
| --- | --- | --- |
| 0 (serial) | 4.1 (D) | lockfile + vitest projects |
| 1 (parallel) | 4.2 (B) · 4.3 (S) · 4.4 (D) | disjoint paths |
| 2 (parallel) | 4.5 (B, api) · 4.6 (B, worker, second invocation) · 4.7 (F) | after 4.2 and 4.3; `apps/api/**` vs `apps/worker/**` vs `apps/mobile-web/**` |
| 3 (serial) | 4.8 (T) | after 4.5, 4.6 |
| 4 (serial) | 4.9 (T) → 4.10 (D) | 4.9 needs 4.7; HEIC fixtures need the orchestrator's Mac |
| Gate | orchestrator | section 4 |

ai-engineer and mobile-engineer have no step-4 work. Seams for step 9: `platform/uploader.ts`,
the header-free part `PUT`s, `takenAt` hints in `uploadFileRegisterSchema`, bearer transport
already handled by `lib/api.ts`. Seam for step 6: `derivativeKey(…, 'analysis')` objects exist
for every ingested photo; the batcher must select `status = 'ingested' AND approval = 'approved'
AND deleted_at IS NULL AND quarantined_at IS NULL` and `baby_ai_enabled(baby_id)` (the
`photos_status_guard` trigger is the backstop).

## 4. Acceptance checks

Verbatim, PRD step 4: "Check: 200-photo bulk upload completes; duplicates skipped; HEIC
converts; thumbnails visible within 5 s; GPS absent from served derivatives." Run from the repo
root with Docker Desktop running.

### 4.1 The PRD check (gate script)

```sh
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d --build --wait
pnpm install --frozen-lockfile
pnpm e2e:upload-gate
# expected final table: ingested=178 failed=2 duplicates=20 near_duplicates=3 heic=5 (jpeg derivatives)
#   thumb_latency p95 < 5000 ms, wall < 300 s, derivatives_without_exif=356/356, gps_rows=150+N
#   purge: 3 photos → 0 rows, 0 object versions
```

### 4.2 API walkthrough (cookie jar `a.jar` from step 3's 4.2 steps 1–5; `B=http://localhost:8080`, `H='x-littlelight-client: web'`, `BABY=<id>`)

1. `curl -s -b a.jar -H "$H" -X POST $B/api/babies/$BABY/uploads -H 'content-type: application/json' -d '{"details":{"people":["Grandma Rose"]}}'` → 201 `{id: SESSION, summary: {registered:0,…}}`.
2. `SHA=$(shasum -a 256 photo.jpg | cut -d' ' -f1); SIZE=$(stat -f%z photo.jpg)`; `curl … -X POST $B/api/uploads/$SESSION/files -d "{\"files\":[{\"clientId\":\"p1\",\"bytes\":$SIZE,\"clientSha256\":\"$SHA\",\"mime\":\"image/jpeg\"}]}"` → `files[0].state = registered`, `parts[0].url` starts with `http://localhost:9000/littlelight-dev/babies/$BABY/originals/`.
3. `curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary @photo.jpg "<parts[0].url>"` → `200`.
4. `curl … -X POST $B/api/uploads/$SESSION/files/<fileId>/complete` → `state = completed`, `photo.status = uploaded`; within 5 s `curl -s -b a.jar $B/api/uploads/$SESSION` shows `state = ingested` and `photo.thumbUrl`.
5. `curl -s -o thumb.jpg "<thumbUrl>"` → 200; `exiftool thumb.jpg | grep -Ei 'gps|exif version|icc|xmp'` prints nothing; `file thumb.jpg` says JPEG.
6. Repeat steps 2–4 with the same file ⇒ step 2 already answers `state = duplicate, duplicateOfPhotoId = <first photo>`; repeat with the `clientSha256` omitted ⇒ registered, after complete the session shows `duplicate` and `psql -c "select count(*) from photos where status='duplicate'"` → `0`.
7. HEIC: steps 2–4 with `e2e/fixtures/heic/gps-640x480.heic` ⇒ `photo.mime = image/heic`, derivatives JPEG, `exiftool` on display shows no GPS; `psql -c "select gps_lat_enc is not null, place_label from photo_exif where photo_id='<id>'"` → `t | <null or Home>`.
8. Invalid: a text file renamed `.jpg` ⇒ `state = failed, error = unsupported_media_type`.
9. Approval queue: sign in `demo-nanny@littlelight.local` (`n.jar`), upload one photo to Maya ⇒ `GET /api/babies/<maya>/photos` as mom shows it with `approval = pending` and `pendingCount = 1`… as the nanny `view=album` shows it; `POST /api/photos/<id>/approve` with `n.jar` → 403; with `a.jar` (mom) → 200 `approval = approved`; `GET /api/photos/<id>/original` with `n.jar` → 403, with mom → `url`.
10. Trash: `DELETE /api/photos/<id>` → 204; `GET …/photos?view=trash` lists it; `POST …/restore` → 200.
11. Signed URL hygiene: every `thumbUrl`/`displayUrl` has `X-Amz-Expires=3600` or less and names exactly one key; no response ever contains `/analysis.jpg`.

### 4.3 Purge, versions, scaling, privileges

```sh
PSQL="docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d littlelight -Atc"
$PSQL "update photos set deleted_at = now() - interval '31 days' where id = '<trashed id>'"
docker compose -f docker-compose.dev.yml exec -T worker pnpm --silent --filter @littlelight/worker run-job purge.trash
$PSQL "select count(*) from photos where id = '<trashed id>'"                       # 0
docker compose -f docker-compose.dev.yml run --rm --entrypoint sh storage-init -c \
  'mc alias set l http://storage:9000 dev devdevdev >/dev/null && mc ls --versions --recursive l/littlelight-dev/babies/<baby>/ | grep <trashed id>'   # nothing
docker compose -f docker-compose.dev.yml up -d --scale worker=3 --wait && pnpm e2e:upload-gate   # still passes; `docker compose logs worker | grep -c 'ingested'` = 178
docker compose -f docker-compose.dev.yml exec -T api printenv S3_ACCESS_KEY                      # littlelight-api
docker compose -f docker-compose.dev.yml exec -T worker printenv S3_ACCESS_KEY                   # littlelight-worker
docker compose -f docker-compose.dev.yml logs worker | grep -E 'CSAM matching disabled|diskUsedPct'
docker compose -f docker-compose.dev.yml logs api worker | grep -Ei 'X-Amz-Signature|latitude|GPSLatitude' ; echo "no secrets/GPS in logs: exit $?"   # exit 1
```

### 4.4 Suites and hygiene

```sh
pnpm lint && pnpm typecheck && pnpm test
DATABASE_URL=postgres://postgres:dev@localhost:5432/littlelight AUTH_DB_PASSWORD=dev API_DB_PASSWORD=dev \
WORKER_DB_PASSWORD=dev DATA_ENCRYPTION_KEY=dev-only-data-encryption-key-32-chars-min SEED_DEMO_FAMILY=true \
JWT_SECRET=dev-only-jwt-secret-at-least-32-characters PUBLIC_URL=http://localhost:8080 \
MAIL_FROM=noreply@littlelight.local SMTP_HOST=localhost \
S3_ENDPOINT=http://localhost:9000 S3_PUBLIC_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=dev S3_SECRET_KEY=devdevdev \
S3_BUCKET=littlelight-test pnpm test:integration        # db + api + worker projects, incl. RLS cases for upload tables and quarantine
pnpm smoke && pnpm e2e
$PSQL "select count(*) from pgmigrations"                # 11
$PSQL "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)"   # 0
grep -rnE 'withMetadata|keepExif|keepMetadata|keepIccProfile|withIccProfile|withExif' apps/worker/src ; echo "exit $?"   # exit 1
DATABASE_URL=postgres://postgres:dev@localhost:5432/littlelight pnpm --filter @littlelight/db db:types && git diff --exit-code -- packages/db/src/generated
grep -rn 'change-me' .env.dev; git status --porcelain | grep -E '^\?\? \.env(\.local)?$'   # nothing
cp .env.example .env && STORAGE_PATH=/tmp/s BACKUP_PATH=/tmp/b docker compose -f docker-compose.yml config -q; rm .env
```

## 5. Risks and decisions (orchestrator to confirm or override)

- **D1 — Multipart for every file, 16 MiB parts, server-driven complete.** One code path; a
  typical 3–6 MB photo is one part, so for native background uploaders (step 9) it is a plain
  file `PUT` to one URL with no custom headers; resume = `ListParts`. The client never needs
  part ETags (MinIO CORS would otherwise have to expose them): the API lists parts, checks the
  byte total, and completes. Max original 100 MiB (7 parts); parts stay far under Cloudflare's
  100 MB body cap. Alternative: single presigned `PUT` per file (one fewer call) but no
  resume for large files and two paths once multipart is needed.
- **D2 — Two new tables (`upload_sessions`, `upload_files`) and `photos.id = upload_files.id`.**
  Keeps `photos` for real objects only (the free-tier cap, dedupe index and album queries stay
  simple), gives the summary counts and the batch details a home, and lets the object key be
  fixed before completion. Rows in `photos` appear at complete under the uploader's own claims,
  so RLS (not the API) decides `pending` vs `approved`.
- **D3 — Exact duplicates leave no `photos` row.** The unique partial index on `(baby_id,
  sha256)` is the race arbiter; ingest marks the loser `status = 'duplicate'` (new CHECK value),
  deletes its object versions and hard-deletes the row (policy `OR status = 'duplicate'`);
  `upload_files.state = 'duplicate'` carries the fact to the summary. `duplicate_of_photo_id`
  therefore means "near-duplicate of" (pHash Hamming ≤ 10 of 64; flag only).
  Client `clientSha256` is only a pre-check for instant skipping; the server re-hash is the
  source of truth.
- **D4 — `heic-decode` (WASM) for HEIC, as the PRD's stack says**; sharp's prebuilt libvips has
  no HEVC decoder (confirmed in sharp's install docs: JPEG, PNG, Ultra HDR, WebP, AVIF, TIFF,
  GIF, SVG only). Costs: ~1–2 s per 12 MP image, ~5–8 s and ~200 MB RSS for 48 MP; the 5 s thumb
  target is measured on the gate's mixed set (mostly JPEG). Escalation if HEIC p95 is a problem
  later: build the worker image with Alpine's `vips-dev` (libheif + libde265) and sharp from
  source (adds python3/make/g++ to the build stage and an `allowBuilds` entry) — a devops task,
  not a design change. `INGEST_CONCURRENCY` default 2 and `mem_limit 2g` bound memory.
- **D5 — Bucket-scoped MinIO service accounts** (`littlelight-api`: put/get/abort/list parts,
  no delete; `littlelight-worker`: + delete incl. versions) created by `storage-init` with
  `mc admin`, root key confined to `storage`/`storage-init`. Closes the step-1/2/3 open issue.
  Cost: a rename of the dev literals and two new `.env` pairs.
- **D6 — Versioning: explicit version deletion in `purge.trash` + a 7-day noncurrent lifecycle
  backstop.** Closes the step-1 "MinIO versioning keeps old versions after delete" issue. Keys
  are never overwritten (uuid names), so versions arise only from deletes; explicit deletion
  satisfies FR-10.2 deterministically and the lifecycle rule bounds any miss. Alternative:
  lifecycle only (non-deterministic timing, untestable in the gate).
- **D7 — No reverse geocoding and no external calls in ingest.** FR-4.3's place label is P1;
  this step computes only `Home` (within 150 m of the encrypted home location, compared in SQL
  so plaintext coordinates never reach Node) and leaves city/park labels for a later step with
  an explicit decision on which geocoder may receive GPS. `tzHint` (uploader's profile timezone)
  travels in the job payload because `pipeline` cannot read `profiles.timezone`.
- **D8 — CSAM matching is a seam with a no-op default** (`CSAM_MATCHER=none`, warn in
  production). A positive match quarantines the row (hidden from every user role, original kept
  as evidence, no derivatives, audit event). Enrolling in Microsoft PhotoDNA Cloud Service (or an
  equivalent NCMEC-hash provider) and the NCMEC reporting procedure need the user (below). A
  zero-code complement: Cloudflare's CSAM Scanning Tool on the zone that serves `files.` —
  worth enabling by the user, independently of this seam.
- **D9 — New dependencies**: `@aws-sdk/s3-request-presigner` (official presigner for the SDK
  already in use), `pg-boss` in the API (send-only; the alternative of raw inserts into pg-boss's
  partitioned tables is brittle), `sharp` (PRD), `heic-decode` (PRD; D4), `exifr` (PRD; also in
  the browser for the capture-time hint), `file-type` (magic-byte sniffing incl. HEIF brands;
  never trust client mimes). pHash is in-house (~60 lines on sharp's raw output; a DCT is not
  worth a dependency and the threshold is ours to tune). No tus server, no Uppy, no background
  upload library on web.
- **D10 — `photos.quarantined_at` and `status = 'duplicate'` are the only `photos` schema
  changes**; the two new tables are the only new tables. No `storage` or `multipart` state
  lives in `photos`.
- **D11 — The 80 % disk alert reads `statfs` of a read-only mount of the storage volume in the
  worker** (dev: `dev-s3`, prod: `STORAGE_PATH`) from the heartbeat, logging once per crossing
  and exposing `diskUsedPct` in `worker_heartbeats.details`. Alternative: MinIO's Prometheus
  metrics, which would need public metrics auth on a hostname that is tunnelled to the
  internet. The worker already has full S3 access, so the read-only mount adds no new exposure.
- **D12 — Rejected contributor uploads go to the trash** (`approval = 'rejected'` + `deleted_at`)
  and purge after 30 days, instead of being deleted at once; the contributor still sees their own
  row (step-2 policy) but the API hides trashed rows from non-admin views.
- **D13 — Seeded demo photos still have placeholder keys**; the grid shows a placeholder on 404.
  Step 5's 10,000-photo seed should create real derivatives (e.g. one shared tiny JPEG per key,
  uploaded by the seed through the worker service account) — flagged for the step-5 plan.
- **R1 — pg-boss 12 API shape** (queue creation, send-only options, cron singletons,
  per-handler concurrency). The plan states intent; backend-engineer maps it to the actual API
  and reports if the API role needs an extra grant (security-engineer adds it minimally).
- **R2 — HEIC orientation**: libheif applies `irot`/`imir` on decode, so the worker must not
  apply EXIF `Orientation` again for HEIC. The portrait fixture proves it; if a real iPhone file
  behaves differently, the fix is a one-line policy change in `decode.ts`, covered by a test.
- **R3 — Browser hashing and memory**: SHA-256 of 500 files via `crypto.subtle` reads each file
  fully (one at a time, ≤ 100 MiB); fine on desktop, acceptable on phones; step 9's native path
  can skip the hash (server re-hashes anyway).
- **R4 — Thumb < 5 s p95** depends on pg-boss polling (≤ 2 s), worker load and HEIC decode;
  the handler uploads the thumb before display/analysis and the gate measures the real figure.
  If it fails: lower the poll interval to 1 s and raise `INGEST_CONCURRENCY` before touching
  the design.
- **R5 — Transient `send` failures** leave a photo `uploaded` for up to 7 minutes (reconcile
  every 5 min, 2-minute grace). Acceptable; the UI shows "processing".
- **R6 — `deleteAllVersions` relies on `s3:DeleteObjectVersion` and `s3:ListBucketVersions`
  on the worker account**; the devops done-when proves both keys' effective permissions with
  `mc` before any code depends on them.
- **Needs the user (not for the gate):**
  1. CSAM hash matching provider: enrol in Microsoft PhotoDNA Cloud Service (or an NCMEC hash
     provider) → `CSAM_MATCHER=photodna`, `PHOTODNA_API_KEY`, `PHOTODNA_ENDPOINT`; sign the
     provider's terms/DPA; define the NCMEC report procedure (who, how, retention of the
     quarantined original). Optionally enable Cloudflare's CSAM Scanning Tool on the zone.
  2. `brew install exiftool` on the Mac for generating the GPS/datetime HEIC fixtures (ask
     before installing); `sips` is built in.
  3. Production `.env` additions when deploying: `S3_ROOT_USER`/`S3_ROOT_PASSWORD` (rename of
     the root pair), `S3_API_ACCESS_KEY`/`S3_API_SECRET_KEY`, `S3_WORKER_ACCESS_KEY`/
     `S3_WORKER_SECRET_KEY`; Cloudflare Tunnel `files.` ingress limited to `/<bucket>/` paths.
  4. Still open from earlier steps: production credentials (tunnel, SMTP, B2), Apple/Google
     client IDs, Turnstile, legal text.
