# Review-fixes plan: combined-review should-fix batch (after step 9 part A)

Status: proposed (architect, 2026-10-09). Not a PRD build-order step: this batch closes the
should-fix items of the combined review of steps 1–9 (no must-fix items were found) before step
10 (photo import). Latest commit: `23ff8d6 step 9 (part A)`. User decisions already taken: build
FR-10.1 export now (admins only); wire Sentry, scrubbed, off in dev; drop "Littlelight Plus" from
the store listings for the first submission; fix items 3–8 as the reviewer described.

PRD sections implemented or touched: FR-10.1 ("Export all originals + a JSON/CSV of metadata as a
ZIP", P1), "Roles and permissions" ("Delete baby, export data, manage plan: Admin only"), FR-1.5
("Removing an admin requires the other admin's confirmation"), FR-7.6 ("Conversation history kept
per user per baby; can be cleared"), "Account deletion and recovery", "Architecture and tech
stack → Observability (Sentry + OpenTelemetry + Postgres cost tables)", "Environment variables"
(`SENTRY_DSN`: all), "Conventions" (validate inputs with zod; never log photo bytes, GPS, prompts;
each migration reversible; RLS policy changes need a test), "Non-functional requirements →
Privacy and child safety / Security", FR-10.2/10.3 (purge covers the new objects), "Mobile and
Capacitor → App store requirements".

`CLAUDE.md` clarifications applied: AI is paid-tier only and **this batch makes no model call**
(the export copies stored `photo_ai` rows; free-tier babies simply have none); storage is MinIO
everywhere; share links 24 h / viewers get no chat; "Never log photo bytes, GPS, or prompts
containing parent notes" governs the Sentry scrubber and the export worker; dev stack stays
zero-setup (every new env var has a working default or is off). User memory applied: no per-step
reviewer pass (one re-review of this batch is the orchestrator's call); dev defaults to the fake
AI provider; `docs/DESIGN.md` screenshot check (light/dark × phone/desktop) before any UI commit;
cloudflared runs outside Compose.

What exists and is reused (verified in the repo):
- Jobs: `packages/shared/src/jobs.ts` (`JOBS`, strict payload schemas), worker `queues.ts` (13
  queues, `exclusive` policy, `ensureQueues`/`startWorkers`), API send-only `plugins/jobs.ts`
  (`sendWithRetry`, `enqueue*` after commit, outside `runAs`).
- Storage: worker `storage.ts` `ObjectStorage` (`getObject(Buffer)`, `putObject`,
  `deleteAllVersions(prefix)`), `babyPrefix()`/`originalKey()` in `packages/shared/src/upload.ts`;
  `purge.trash` deletes every version under `babies/<id>/` for trashed babies.
- Crypto: `decrypt_coord(bytea)` executable by `pipeline` and `service_role` with the
  `DATA_ENCRYPTION_KEY` transaction-local GUC (the ingest already decrypts for the Home label).
- Mail: `apps/api/src/email/mailer.ts` (`createSmtpMailer`, nodemailer 10.0.15, Mailpit in dev);
  the worker has **no** SMTP settings today (`.env.dev` comment).
- Auth helpers: `withClaims`, `withServiceRole(app, reason, fn)`, `requireFreshSignIn`,
  `requireConsent`, `audit()` with strict `auditMetadataSchema`; in-memory `createThrottle`.
- Logging: API `loggerOptions` redaction list + `redactUrl`; worker pino redact paths.
- Native: `apps/mobile-web/ios/App/App/Info.plist` (release and debug share it; `debug.xcconfig`
  exists, `INFOPLIST_FILE = App/Info.plist` is set at target level for both configurations);
  Android already has `app/src/debug/AndroidManifest.xml` for the debug-only scheme.
- The viewer DTO `packages/shared/src/api/share-viewer.ts` has `takenAt: isoDateTimeSchema`.

## 1. Goal

Close every should-fix item of the combined review in one gated batch, without changing any
behaviour the gates of steps 1–9 proved: (1) build FR-10.1 as an admin-only, audited,
rate-limited background export (`data.export` job) that streams every live original plus
`photos.json`/`photos.csv`/`album.json`/`milestones.csv`/`measurements.csv` into one ZIP under
`babies/<id>/exports/<exportId>.zip`, offered to its requester through a 10-minute signed URL,
announced by email, expiring after 7 days and purged by the existing `purge.trash` sweep (also on
baby purge and account deletion); (2) wire Sentry into api, worker and the web build, errors only,
enabled solely by a DSN, with a shared `beforeSend` scrubber that drops request data, cookies,
headers, breadcrumbs, signed-URL query strings, tokens, GPS-like numbers and emails; (3) move the
FR-1.5 co-admin rule, the co-member profile column exposure, the contributor `is_sensitive` /
`approved_by` leftovers into the database (policies, a trigger, a view) with tests; (4) make a
failed account deletion leave the account whole; (5) let a downgraded admin read and clear chat
history; (6) move the iOS debug-only surface (`NSAllowsLocalNetworking`, `littlelight://`) to Debug
builds via xcconfig; (7) rewrite the store listings without the plan name; plus the cheap
nice-to-haves (`trustProxy: 1` + nginx `CF-Connecting-IP`, a report-only CSP, date-only viewer
`takenAt`). Deferred items are recorded in section 5 for `docs/PROGRESS.md`.

## 2. Interfaces first

### 2.1 Database (security-engineer): two migrations after `1792200000200_…`

Conventions as before: reversible, `ENABLE` + `FORCE` RLS on new tables, policies `TO <role>`,
column grants, SECURITY DEFINER functions with pinned `search_path` and `REVOKE … FROM PUBLIC`,
fixed error messages that never echo a row, every policy change tested (R.12). `pgmigrations`
becomes **19** (17 today).

**Migration A — `1792300000100_review-hardening.sql`** (items 3, 4, 7)

1. FR-1.5 at the DB (item 3, D11). Replace the two `baby_members` policies so an `authenticated`
   actor can delete or demote an **admin** row only when it is their own:
   - `baby_members_authenticated_update`: `USING (is_baby_admin(baby_id) AND (role <> 'admin' OR
     user_id = auth_uid()))`, `WITH CHECK (is_baby_admin(baby_id))` unchanged. Promoting a
     contributor stays allowed; self-demotion stays allowed; demoting the other admin is denied.
   - `baby_members_authenticated_delete`: `USING (user_id = auth_uid() OR (is_baby_admin(baby_id)
     AND role <> 'admin'))`. Removing a contributor stays allowed; "leave" and the FR-1.5
     **confirm** (the target deletes their own row, `apps/api/src/auth/members.ts` ~line 276) stay
     allowed; deleting the other admin directly is denied. The removal request itself is still
     written under `service_role` (unchanged). `baby_members_keep_last_admin` and
     `baby_members_max_two_admins` stay.
2. Co-member profile exposure (item 4, D12). `profiles_authenticated_select` becomes
   `USING (user_id = auth_uid())` (self-reads keep every granted column). New view
   `public.member_profiles (user_id, display_name, relationship_label)` `WITH (security_barrier)`
   defined as `SELECT … FROM public.profiles WHERE deleted_at IS NULL AND (user_id = auth_uid()
   OR shares_baby_with(user_id))`, owned by the migration role (so it reads `profiles` past the
   self-only policy and applies its own WHERE), `GRANT SELECT ON public.member_profiles TO
   authenticated`. `pipeline` keeps its existing 3-column grant on `profiles`. Nothing else may
   read another user's `profiles` row.
3. Photos UPDATE/INSERT leftovers (item 7, D13). `WITH CHECK` cannot see the old row, so:
   - Trigger `photos_user_update_guard` BEFORE UPDATE ON `photos` FOR EACH ROW, fires only when
     `current_user = 'authenticated'` (pipeline/service_role untouched): if `NOT
     is_baby_admin(NEW.baby_id)` then `NEW.is_sensitive`, `NEW.approval`, `NEW.approved_by`,
     `NEW.approved_at` must equal OLD (`IS NOT DISTINCT FROM`), else raise `check_violation`
     'contributors may only trash their own pending uploads'. If admin and `NEW.approval =
     'approved' AND OLD.approval <> 'approved'` then `NEW.approved_by := auth_uid()`,
     `NEW.approved_at := COALESCE(NEW.approved_at, now())` (pinned, not validated); if approval
     unchanged then `NEW.approved_by`/`approved_at` must equal OLD.
   - `photos_authenticated_insert` `WITH CHECK` gains `AND (approval <> 'approved' OR approved_by =
     auth_uid())` (admins' own uploads are approved by themselves; contributors insert pending
     with `approved_by IS NULL`). Security-engineer verifies `apps/api/src/uploads/service.ts`
     already inserts that way and reports if not (then backend fixes the insert in R.8).
4. `packages/db/README.md`: a "GoTrue audit log" note — `auth.audit_log_entries` payloads hold
   actor emails and IPs with no built-in retention; recommend a 90-day prune (deferred, 5.2) and
   list it next to the pg_dump backup retention.

**Migration B — `1792300000200_data-exports.sql`** (item 1)

```sql
CREATE TABLE public.data_exports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id            uuid NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  requested_by       uuid REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  include_location   boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','ready','failed','expired')),
  error              text CHECK (error IN ('storage_error','too_large','requester_not_admin','internal')),
  storage_key        text GENERATED ALWAYS AS ('babies/' || baby_id::text || '/exports/' || id::text || '.zip') STORED,
  photo_count        integer, photos_done integer NOT NULL DEFAULT 0, bytes bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz, finished_at timestamptz,
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '7 days',
  purged_at          timestamptz,
  downloads          integer NOT NULL DEFAULT 0, last_downloaded_at timestamptz
);
CREATE INDEX ON public.data_exports (baby_id, created_at DESC);
CREATE INDEX ON public.data_exports (status) WHERE status IN ('queued','running');
```

- Grants. `authenticated`: SELECT `(id, baby_id, requested_by, include_location, status, error,
  photo_count, photos_done, bytes, created_at, started_at, finished_at, expires_at, purged_at,
  downloads, last_downloaded_at)` (not `storage_key`); INSERT `(baby_id, requested_by,
  include_location)`; UPDATE `(expires_at, downloads, last_downloaded_at)`. `pipeline`: SELECT
  all; UPDATE `(status, error, photo_count, photos_done, bytes, started_at, finished_at,
  purged_at)`; DELETE. `service_role`: ALL. `viewer`: nothing.
- Policies (`FORCE RLS`). `authenticated` SELECT `USING (is_baby_admin(baby_id))` (**both admins
  see every export of their album** — transparency is the safeguard against a quiet full export,
  D3); INSERT `WITH CHECK (is_baby_admin(baby_id) AND requested_by = auth_uid())`; UPDATE
  `USING/WITH CHECK (is_baby_admin(baby_id))` (either admin may expire an export early; the
  download counter is harmless). `pipeline` SELECT/UPDATE `USING (true)`; DELETE `USING
  (purged_at IS NOT NULL AND purged_at < now() - interval '30 days')`.
- Trigger `data_exports_rate_limit` BEFORE INSERT: raise `check_violation` 'an export is already
  in progress for this album' when a `queued`/`running` row exists for the baby; raise 'export
  rate limit reached: 3 per album per day' when ≥ `EXPORTS_PER_BABY_PER_DAY` (3) rows were
  created in the last 24 h. Fixed messages, no row data.
- Trigger `data_exports_baby_live` BEFORE INSERT: raise when `babies.deleted_at IS NOT NULL`
  ('cannot export a trashed album').
- `export_requester_email(p_export_id uuid) RETURNS text` SECURITY DEFINER, EXECUTE to `pipeline`
  only (guard `to_regclass('auth.users')` like migration 10): returns `auth.users.email` of the
  requester **only** when the export's `status IN ('ready','failed')` and the requester is still
  an admin of the baby (`baby_members` role admin) and `profiles.deleted_at IS NULL`; else NULL.
  Never logged by the caller.
- `export_requester_is_admin(p_export_id uuid) RETURNS boolean` SECURITY DEFINER for `pipeline`
  (run-time check before any decryption, 2.3).
- Grants audit for the worker's export query (security-engineer verifies each, adds what is
  missing as `pipeline` SELECT): `babies`, `baby_members`, `profiles(user_id, display_name,
  relationship_label)`, `photos`, `photo_exif`, `photo_details`, `milestones`, `measurements`,
  `photo_ai`, `photo_ai_overrides`, `data_exports`. `audit_log` INSERT exists (purge uses it).
- Regenerate `packages/db/src/generated`; README rows (table, who writes what, retention).

### 2.2 Shared contracts (`@littlelight/shared`; architect-defined here, **backend-engineer writes in R.2** with orchestrator approval)

- `src/jobs.ts`: `JOBS.dataExport = "data.export"`; `dataExportJobSchema = z.strictObject({
  exportId: z.uuid(), babyId: z.uuid() })` (ids only; the worker re-reads everything). Queue
  policy `exclusive`, `singletonKey = exportId`, `retryLimit 1`, `retryDelay 60`,
  `expireInSeconds 14400` (a 50 GB album at ~50 MB/s is ~17 min; 4 h is the ceiling).
- `src/constants.ts`: `EXPORT_TTL_DAYS = 7`, `EXPORTS_PER_BABY_PER_DAY = 3`,
  `EXPORT_URL_TTL_SEC = 600`, `EXPORT_LIST_LIMIT = 10`, `EXPORT_FORMAT_VERSION = "1"`,
  `EXPORT_MAX_BYTES_DEFAULT = 107_374_182_400` (100 GiB), `EXPORT_PROGRESS_EVERY = 50`.
- `src/api/exports.ts` (new): `exportStatusSchema = z.enum(["queued","running","ready","failed",
  "expired"])`, `exportErrorSchema = z.enum(["storage_error","too_large","requester_not_admin",
  "internal"])`, `dataExportSchema = z.strictObject({ id: uuid, babyId: uuid, status,
  includeLocation: boolean, requestedBy: uuid|null, requestedByName: string|null, isMine: boolean,
  photoCount: int|null, photosDone: int, bytes: number|null, error: exportError|null, createdAt,
  startedAt|null, finishedAt|null, expiresAt, canDownload: boolean })`,
  `createExportRequestSchema = z.strictObject({ includeLocation: z.boolean() })`,
  `exportResponseSchema = { export }`, `exportsListResponseSchema = { exports: array.max(10) }`,
  `exportDownloadUrlResponseSchema = { url: z.url(), expiresAt }`.
- `src/env.ts`: `exportEnvSchema` (worker: `EXPORT_MAX_BYTES` int ≥ 1 GiB, default
  `EXPORT_MAX_BYTES_DEFAULT`); `sentryEnvSchema` (api, worker: `SENTRY_DSN` optional
  `z.url()` with `emptyAsUndefined`, `SENTRY_ENVIRONMENT` optional string ≤ 32, default
  `NODE_ENV`); the worker also gains the existing `mailEnvSchema` (SMTP) in its config.
- `src/auth.ts`: `AUDIT_EVENTS` += `export.requested`, `export.ready`, `export.failed`,
  `export.downloaded`, `export.expired` (early expiry by an admin), `export.purged`;
  `auditMetadataSchema` += `export_id: z.uuid().optional()`, `include_location:
  z.boolean().optional()` (the `count` key already exists for photo counts). Never the storage
  key, bytes or a URL.
- `src/telemetry.ts` (new, browser-safe, no deps): `scrubTelemetryEvent<T extends object>(event: T):
  T` — deletes `request`, `user`, `breadcrumbs`, `extra`, `server_name`, `contexts.culture`,
  `contexts.device`, `contexts.app`, `transaction`; deep-walks every remaining string (message,
  exception values, frames' `filename`/`abs_path`/`vars`, tags) and replaces: JWT-like
  `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`, `X-Amz-[A-Za-z-]+=[^&\s"']+`, any URL
  query string or fragment (`?…`/`#…` → `?[redacted]`), path segments after `/invites/`, `/s/`,
  `/share/` and any token-shaped segment (same rules as the API's `redactUrl`, whose regexes move
  here and are re-exported), email addresses, decimal coordinate pairs
  (`-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}`), Bearer/Basic credentials; truncates any string
  above 2,000 chars; drops `exception.values[].stacktrace.frames[].vars` entirely. Exported with
  `TELEMETRY_SCRUB_PATTERNS` for tests. Pure; used by api, worker and web as `beforeSend`.
- `src/api/share-viewer.ts`: `takenAt: z.iso.date().nullable()` (date-only, D19).
- `index.ts` re-exports.

### 2.3 Export worker (`apps/worker/src/export/**`, backend-engineer)

- Handler `handleDataExportJob(deps, job)` for `data.export`, one job at a time per process
  (`batchSize 1`), as `pipeline` through `runAsPipeline(pool, { dataKey })` (the same
  `DATA_ENCRYPTION_KEY` bind the ingest uses) — decryption only inside the SQL that builds the
  metadata rows, and only when `include_location` is true **and**
  `export_requester_is_admin(exportId)` is true at run time (else `failed/requester_not_admin`).
- Steps: claim (`UPDATE … SET status='running', started_at=now() WHERE id=$1 AND status='queued'`;
  0 rows ⇒ already handled, return) → size check (`SUM(bytes)` of the selected photos >
  `EXPORT_MAX_BYTES` ⇒ `failed/too_large`) → stream.
- Which photos (D4): `photos` of the baby with `deleted_at IS NULL AND quarantined_at IS NULL AND
  status NOT IN ('failed','duplicate') AND approval IN ('approved','pending')`, ordered by
  `sort_at, id`, keyset-paginated 200 at a time. Trash, rejected, failed, duplicate and
  quarantined rows are excluded; pending contributor uploads are included with
  `approval = pending`; sensitive photos are included with `is_sensitive = true`.
- Streaming (no buffering, R1): `archiver` (`zlib: {level: 6}`, `forceZip64: true`) piped into
  `@aws-sdk/lib-storage` `Upload({ client, params: { Bucket, Key: storage_key, Body: archive,
  ContentType: "application/zip" }, partSize: 16 MiB, queueSize: 2, leavePartsOnError: false })`.
  Originals are appended one at a time from `storage.getObjectStream(originalKey)` with
  `{ store: true, name, date: taken_at ?? created_at }`; the next object is requested only after
  the previous `entry` event. JSON/CSV entries are appended as incremental streams (`photos.json`
  is written `[` + rows + `]`, `photos.csv` row by row). Peak memory ≈ 2 parts + archiver
  buffers (< 64 MiB) regardless of library size. `photos_done` is updated every 50 photos.
- ZIP layout (`EXPORT_FORMAT_VERSION` 1):
  - `README.txt` (what each file is; "Original files are byte-identical to what was uploaded
    and keep their own embedded metadata, including any location the camera recorded";
    `format_version`, export date, `include_location`).
  - `album.json`: `{ formatVersion, exportedAt, includeLocation, baby: { id, name, nickname,
    birthDate, birthDateIsDueDate, birthWeightG, birthLengthMm, homeLabel }, members:
    [{ displayName, relationshipLabel, role }], counts: { photos, milestones, measurements } }`.
    No plan/billing, no coordinates, no emails.
  - `originals/<YYYY-MM-DD>_<photoId>.<ext>` (`ext` from `mime`: jpg/png/heic/heif/webp; date =
    local capture date when `tz_offset_minutes` is known, else UTC; `created_at` when `taken_at`
    is null).
  - `photos.csv` (RFC 4180, UTF-8 BOM) columns: `file, photo_id, taken_at, taken_at_estimated,
    tz_offset_minutes, age_days, status, approval, is_sensitive, uploaded_by, width, height,
    bytes, mime, sha256, milestone, people, note, location_label, place_label, camera_make,
    camera_model, ai_caption, ai_tags, ai_sensitive_flags, ai_model, gps_lat, gps_lng`.
    `people`/`ai_tags`/`ai_sensitive_flags` are `;`-joined; `uploaded_by` is the display name
    (pipeline's 3-column `profiles` grant); `gps_*` columns are present only when
    `include_location` is true (omitted, not blank, otherwise).
  - `photos.json`: one object per photo with the same fields plus `details` (milestone name +
    category, note, people, locationLabel), `exif` (takenAt, tzOffsetMinutes, placeLabel,
    cameraMake, cameraModel, orientation; `gps: {lat, lng}` only with `include_location`;
    **no `raw_json`**, 5.2), `ai` (`description` with overrides applied via `applyAiOverrides`,
    `overrides` list, `model`, `promptVersion`, `schemaVersion`, `analyzedAt`; no raw output).
  - `milestones.csv` (`id, name, category, is_preset, photo_count`), `measurements.csv`
    (`id, kind, value_metric, value_entered, unit_entered, measured_at, note, photo_file`).
- Finish: `status='ready', finished_at, bytes, photo_count`; audit `export.ready {export_id,
  count}` (actor null, `baby_id` set); email (2.4). Failure: `Upload.abort()` (lib-storage) then
  `storage.deleteAllVersions(storage_key)`, `status='failed', error`, audit `export.failed
  {export_id}`; the job rethrows only for `storage_error` (pg-boss retries once), never for
  `too_large`/`requester_not_admin`.
- Logging: ids, counts, bytes, durations and `errorCategory` only. Never file names with dates?
  (dates are fine; names contain no parent text), never a coordinate, email, key with a
  signature, note or caption. The pino redact list gains `*.email`, `*.gps_lat`, `*.gps_lng`.
- `ObjectStorage` gains `getObjectStream(key): Promise<Readable>` (`GetObject` `Body` as a Node
  stream) and `putObjectStream(key, body, contentType): Promise<void>` (lib-storage `Upload`).
- Purge (`purge.ts`, extend `purge.trash`): step 5 "expired exports": rows with `purged_at IS
  NULL AND (expires_at < now() OR requested_by IS NULL OR status IN ('failed') OR NOT EXISTS
  (admin membership of requested_by))` ⇒ `deleteAllVersions(storage_key)`, `status='expired'`
  (ready ones), `purged_at = now()`, audit `export.purged {export_id}`; step 6: delete rows with
  `purged_at < now() - 30 days`. Baby purge already removes `babies/<id>/exports/` with the
  prefix delete and the rows by cascade; account deletion sets `requested_by` NULL by FK, so the
  requester's ZIP is purged at the next hourly run and nobody can sign a URL for it meanwhile
  (the download route requires `requested_by = auth_uid()`).
- Worker queues become **14**; `run-job data.export '{"exportId":…,"babyId":…}'` works.

### 2.4 Export email (worker; backend-engineer)

`apps/worker/src/email/mailer.ts`: the same nodemailer transport factory as the API's
(`SMTP_HOST/PORT/SECURE/USER/PASS`, `MAIL_FROM`, `mailEnvSchema`), `sendExportReady(to,
{ babyName, expiresAt })` and `sendExportFailed(to, { babyName })` with plain-text + simple HTML
bodies: "Your Littlelight export of <baby name> is ready. Open Littlelight → Settings → Export
album data to download it. The download is available until <date>." **No link, no token, no
signed URL in the email** (the URL is minted in-app, to the requester, after a fresh sign-in).
Recipient from `export_requester_email()`; NULL ⇒ no email, one info line `{exportId,
emailed:false}`. The worker gets SMTP settings in both Compose files (dev: Mailpit, same anchors
as the api). Push for exports is deferred (5.2).

### 2.5 Export API (`apps/api/src/exports/{routes,queries}.ts`, backend-engineer)

| Method, path | Guards | Request → Response | Behaviour |
| --- | --- | --- | --- |
| `POST /babies/:id/exports` | Auth, Consent, admin (`is_baby_admin` via the INSERT policy; a non-admin gets 403 `parents_only`), **fresh sign-in** (`requireFreshSignIn`, D2) | `createExportRequestSchema` → 202 `exportResponseSchema` | under the caller's claims: `INSERT … (baby_id, requested_by, include_location) RETURNING *` (RLS + rate-limit triggers; `check_violation` 'already in progress' → 409 `export_in_progress`, 'rate limit' → 429 `rate_limited`, 'trashed' → 409 `baby_trashed`); audit `export.requested {export_id, include_location}`; after commit `app.jobs.enqueueDataExport({exportId, babyId})` (a failed enqueue marks the row `failed/internal` under service_role and returns 503) |
| `GET /babies/:id/exports` | Auth, Consent, admin | → 200 `exportsListResponseSchema` | last 10 rows (`LEFT JOIN member_profiles` for `requestedByName`), `isMine = requested_by = uid`, `canDownload = isMine AND status='ready' AND expires_at > now() AND purged_at IS NULL` |
| `POST /babies/:id/exports/:exportId/download-url` | Auth, Consent, admin, **requester only** (403 `not_requester`), **fresh sign-in** | → 200 `exportDownloadUrlResponseSchema` | 410 `export_expired` unless ready/unexpired/unpurged; `app.signer` GET for `storage_key` with TTL `EXPORT_URL_TTL_SEC`, `ResponseContentDisposition: attachment; filename="littlelight-<ascii baby name>-<YYYY-MM-DD>.zip"`, `ResponseContentType: application/zip`; `UPDATE downloads = downloads + 1, last_downloaded_at`; audit `export.downloaded {export_id}`. The URL is never logged (`redactUrl` covers the query string) |
| `DELETE /babies/:id/exports/:exportId` | Auth, Consent, admin | → 204 | `UPDATE … SET expires_at = now()` (either admin); audit `export.expired {export_id}`; the hourly sweep purges the object (the API key cannot delete) |

`plugins/jobs.ts`: `enqueueDataExport(job: DataExportJob): Promise<boolean>` with
`DATA_EXPORT_SEND_OPTIONS` (`retryLimit 1`, `retryDelay 60`, `expireInSeconds 14400`,
`singletonKey = exportId`); `withAllSenders` gets the stub branch like the others. The `storage_key`
column is never selected under `authenticated` (no grant); the signer takes it from a
`service_role` read limited to that one column (`withServiceRole(app, "export download", …)`), or
the route recomputes it from `(babyId, exportId)` with a shared `exportKey(babyId, exportId)`
helper in `packages/shared/src/upload.ts` — **use the helper** (no service_role needed; the DB
column is the same expression).

### 2.6 Sentry (D7, D8)

| Service | Package | Init | Capture points |
| --- | --- | --- | --- |
| api | `@sentry/node` | `apps/api/src/plugins/telemetry.ts` `initTelemetry(config)` called first thing in `server.ts` (before `buildApp`), `registerTelemetry(app)` in `app.ts` right after `registerErrorHandling` | `onError` hook: capture when the error is not an `ApiError` or has `statusCode >= 500`, tags `{ service: "api", route: request.routeOptions.url (pattern, never the actual URL), method, status }`; process-level via the two integrations below; `Sentry.close(2000)` in `onClose` |
| worker | `@sentry/node` | `apps/worker/src/telemetry.ts` `initTelemetry(config)` at the top of `main.ts` | `captureJobError(jobName, err)` from a `wrapHandler(name, fn)` used around every `boss.work` callback in `queues.ts` (tags `{ service: "worker", job }`, then rethrow), `boss.on("error")`, `worker failed to start`, process-level; `Sentry.close(2000)` in `shutdown()` |
| web | `@sentry/react` | `apps/mobile-web/src/lib/telemetry.ts` `initTelemetry()` called from `main.tsx` before render; **lazy `import("@sentry/react")` only when `import.meta.env.VITE_SENTRY_DSN` is set and `!isNative()`** (D8: the native WebView sends nothing, so the App Store privacy label and Play Data Safety answers stay as drafted) | `globalHandlersIntegration` (window error/unhandledrejection), React 19 `createRoot(root, { onUncaughtError, onCaughtError })` → `captureException`; tags `{ service: "web" }` |

Common `Sentry.init` options everywhere: `enabled: Boolean(dsn)` (unset ⇒ nothing initialised,
no network), `environment`, `release` = package version, `sendDefaultPii: false`,
`defaultIntegrations: false` with an explicit minimal list (node: `onUncaughtExceptionIntegration({
exitEvenIfOtherHandlersAreRegistered: false })`, `onUnhandledRejectionIntegration`,
`linkedErrorsIntegration`, `dedupeIntegration`; web: `globalHandlersIntegration`,
`linkedErrorsIntegration`, `dedupeIntegration`) — **no** request-data, http/undici/pg/fastify,
console, modules, context or breadcrumb integrations, so no SQL, URL, header, body or env ever
enters an event; `tracesSampleRate: 0` (no performance/tracing), `maxBreadcrumbs: 0`,
`beforeBreadcrumb: () => null`, `beforeSend: (e) => scrubTelemetryEvent(e)` (2.2),
`attachStacktrace: true`, `normalizeDepth: 3`. Dev: `.env.dev` sets nothing ⇒ off; `.env.example`
documents `SENTRY_DSN` (api, worker) and `SENTRY_WEB_DSN` (web build arg `VITE_SENTRY_DSN`,
baked at image build; the native builds never pass it).

OpenTelemetry (D8): **deferred** with a recorded rationale — `@sentry/node` ≥ 8 is built on
OpenTelemetry, so traces are a later config change (`tracesSampleRate` + the http/pg
instrumentations) once a span-attribute scrubber exists; a separate collector adds a service the
single-node deployment does not need now. No `@opentelemetry/*` package is added.

### 2.7 Chat history access (item 5, D15; ai-engineer)

`apps/api/src/search/access.ts`: new `requireChatHistoryAccess(client, uid, babyId)` — admin
membership only (`parentsOnly()` otherwise), no plan check, no model client needed. `GET` and
`DELETE /babies/:id/chat/thread` use it; `POST …/chat/messages` keeps `requireChatAccess` (plan
gate before any model call). A downgraded admin can therefore read and clear history; a
contributor still gets 403.

Frontend (R.7): the free-tier chat screen (Plus upsell) shows "Clear chat history" when
`GET …/chat/thread` returns at least one message, with the existing confirm; i18n `chat.clearHistory`.

### 2.8 Account deletion (item 6, D14; security-engineer, `apps/api/src/auth/account.ts`)

Order becomes: (1) claims tx: fresh sign-in, sole-admin rule, audit `account.deletion_requested`
(unchanged); (2) service_role tx: re-check, `UPDATE profiles SET deleted_at = now()` (keeps
pushes/visibility off while GoTrue works); (3) `gotrue.adminDeleteUser(uid)`; (4) **on success**
service_role tx: audit `account.deleted { client, target_user_id: uid }` with `actorUserId: null`
(the profile row is gone by cascade); (5) **on failure** service_role tx: `UPDATE profiles SET
deleted_at = NULL WHERE user_id = $1` (compensation), log `{status, code}` only, then the existing
503. If the compensation itself fails, log `error` and still return 503 (the next attempt's step 2
is idempotent). `account.deleted` is never written for a failed deletion.

### 2.9 iOS debug-only surface (item 8, D17; mobile-engineer)

Like Android's `src/debug/AndroidManifest.xml`: `App/Info.plist` loses `NSAppTransportSecurity`
and `CFBundleURLTypes` (release content); new `App/Info-Debug.plist` = the release plist plus
exactly those two keys. `INFOPLIST_FILE` is removed from the target-level build settings in
`project.pbxproj` and set in xcconfigs: `debug.xcconfig` → `INFOPLIST_FILE = App/Info-Debug.plist`,
new `release.xcconfig` (added as `baseConfigurationReference` of the Release configuration) →
`INFOPLIST_FILE = App/Info.plist`. `apps/mobile-web/scripts/check-ios-plists.ts` asserts, via
`plutil -convert json`, that `Info-Debug.plist` equals `Info.plist` + `{NSAppTransportSecurity.
NSAllowsLocalNetworking: true, CFBundleURLTypes: [littlelight]}` and nothing else (hygiene, CI).
`NATIVE.md` documents it. The JS router already honours the scheme only with
`VITE_DEEPLINK_DEV_SCHEME=1`.

### 2.10 Store listings (item 9, D18; mobile-engineer)

`fastlane/metadata/en-US/description.txt` and `metadata/android/en-US/full_description.txt`:
the paragraph starting "Littlelight Plus uses AI…" becomes a plan-neutral AI disclosure, e.g.
"Optional AI features use our model provider to describe your photos so you can search them and
ask questions about them. Photos are only analysed when AI features are turned on for an album;
they are never used to train models, and the files are deleted from the provider once the
descriptions are made." No plan name, no price. `store/privacy-nutrition-label.md` "Plus accounts
only" → "albums with AI features enabled"; `store/review-notes.md` "on the Plus plan" → "has AI
features enabled"; `store/screenshots.md` "iPhone 14 Plus" is a device name and stays. Character
limits re-checked (`store/README.md` table).

### 2.11 Nice-to-haves included (D9, D10, D19)

- **`trustProxy: 1`** (`apps/api/src/app.ts`, backend): only the last hop (nginx / Vite) is
  trusted, so `request.ip` can no longer be set by a client's `X-Forwarded-For`;
  `clientIp()` keeps preferring `CF-Connecting-IP`. `healthz` loopback detail still works (the
  container healthcheck hits `127.0.0.1:3000` directly); test-engineer adjusts
  `healthz.test.ts`/`request.test.ts` fixtures that relied on XFF.
- **nginx `CF-Connecting-IP` fallback** (devops): `map $http_cf_connecting_ip $ll_client_ip {
  "" $remote_addr; default $http_cf_connecting_ip; }` and `proxy_set_header CF-Connecting-IP
  $ll_client_ip;` in both proxy blocks, so LAN/dev traffic that bypasses Cloudflare is rate-limited
  per real peer rather than per gateway. Comment updated (the forgery caveat in `.env.example`
  line ~359 stays true and is referenced).
- **CSP, report-only first** (devops): `docker/nginx/templates/csp.conf.template` rendered by the
  nginx image's envsubst into `/etc/nginx/snippets/csp.conf` (`NGINX_ENVSUBST_OUTPUT_DIR`), included
  in the `server` block and repeated in the `/s/` location (nginx drops inherited `add_header`
  there): `add_header ${WEB_CSP_HEADER} "default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data: blob: ${S3_PUBLIC_ENDPOINT}; connect-src 'self'
  ${S3_PUBLIC_ENDPOINT} ${WEB_CSP_CONNECT_EXTRA}; font-src 'self' data:; manifest-src 'self';
  worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self';
  object-src 'none'" always;`. `WEB_CSP_HEADER` defaults to `Content-Security-Policy-Report-Only`
  (flip to `Content-Security-Policy` after a week of clean production consoles),
  `WEB_CSP_CONNECT_EXTRA` is where the Sentry ingest origin goes when `SENTRY_WEB_DSN` is set
  (documented; e.g. `https://o123.ingest.us.sentry.io`). Only the snippet is a template; the
  main config stays static (no nginx `$var` can be mangled). The `/.well-known/` and
  `/email-templates/` responses are not HTML and are unaffected. Native WebViews load from
  `capacitor://localhost` and never see nginx headers (no change).
- **Viewer `takenAt` date-only** (security-engineer + frontend): `apps/api/src/sharing/queries.ts`
  returns `to_char(p.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')` (UTC date; the viewer already
  shows no time, and the viewer role has no `photo_exif` access for the offset — flagged D19);
  `SharedPhotoViewer.takenText` parses `YYYY-MM-DD` as a calendar date (no `Date` tz shift).
- **Contributors and AI captions** (D16): explicit decision, no code change — contributors keep
  seeing the `ai.description` (overrides applied) of photos they can already see, never `raw`,
  `canRetry` or override controls; the admin-only PRD rows are "Chat / AI search", not
  descriptions. Recorded in PROGRESS.
- **GoTrue audit retention**: README note only (2.1 A.4); the prune is deferred (5.2).

### 2.12 Env, compose, images (devops-engineer)

| Item | Change |
| --- | --- |
| `.env.dev` | nothing enabled: comments for `SENTRY_DSN` (unset = off) and the worker's SMTP block (Mailpit, same values as the api's) |
| `docker-compose.dev.yml` | `worker` gets `SMTP_HOST/SMTP_PORT/SMTP_SECURE/MAIL_FROM` (the existing `*dev-smtp-*`/`*dev-mail-from` anchors) and `EXPORT_MAX_BYTES` (default); `web` (Vite) unchanged |
| `.env.example`, `docker-compose.yml` | `SENTRY_DSN` reaches **api and worker only** (check the `x-app` anchor merge; move it out of any anchor shared with web/migrate/db-init/backup), `SENTRY_ENVIRONMENT` optional; `SENTRY_WEB_DSN` → `web.build.args.VITE_SENTRY_DSN` (default empty); worker gets the `SMTP_*`/`MAIL_FROM` lines the api has; `EXPORT_MAX_BYTES` (worker); `WEB_CSP_HEADER` (default report-only), `WEB_CSP_CONNECT_EXTRA` (default empty) and `S3_PUBLIC_ENDPOINT` on the `web` service environment for the template |
| `apps/mobile-web/Dockerfile` | `ARG VITE_SENTRY_DSN=""` in the build stage; prod stage copies `docker/nginx/templates/csp.conf.template` to `/etc/nginx/templates/` with `NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/snippets` (verify the official entrypoint runs with `read_only: true` + tmpfs — if not, pre-render at build with defaults and document) |
| `docker/nginx/default.conf` | 2.11 map/header + `include /etc/nginx/snippets/csp.conf;` in `server` and `/s/` |
| CI (R.13) | export gate in the dev-stack job; `sentry-hygiene` step (2.14); `check-ios-plists` in `native-hygiene`; the web image is run once with `WEB_CSP_HEADER` set and `curl -sI` asserts the header; `plutil -lint` of **both** source plists; integration report names |

### 2.13 Frontend (frontend-engineer, `apps/mobile-web/src/**`)

- Settings → new row "Export album data" (admins of the current baby only; contributors never
  see it) → `pages/settings/ExportPage.tsx`: one paragraph ("A ZIP with every original photo
  plus spreadsheets of dates, milestones, people, notes, measurements and AI descriptions. Ready
  in a few minutes; the download stays available for 7 days."), toggle "Include photo
  locations" (default on, D1; helper text "Original files keep whatever location the camera
  recorded"), primary button "Start export" (fresh-sign-in gate reused from account deletion),
  list of the last exports as cards (requester name, status chip, progress "n of N photos",
  size, expiry; skeletons while loading; polling every 5 s while queued/running), "Download"
  (requester + ready), overflow "Delete". Errors mapped: `export_in_progress`, `rate_limited`,
  `fresh_sign_in_required`. Per `docs/DESIGN.md`; light/dark × phone/desktop screenshots.
- `lib/telemetry.ts` (2.6) and `main.tsx` hook; React root error callbacks.
- Chat free-tier screen "Clear chat history" (2.7).
- Viewer date-only (2.11).
- `i18n/en.ts` keys `export.*`, `chat.clearHistory`.

### 2.14 Tests and gates (test-engineer)

- **Unit, shared**: `telemetry.test.ts` (every pattern; nested objects; a Sentry-shaped fixture
  with request/cookies/breadcrumbs/`X-Amz-Signature`/JWT/email/coords in message, frames and tags
  ⇒ none survive; idempotent), `api/exports.test.ts`, `jobs.test.ts` (strict payload), `auth.test.ts`
  (new audit events/metadata keys), `share-viewer` (date-only accepts `2026-06-14`, rejects
  datetime), `upload.test.ts` (`exportKey`).
- **Unit, api**: `plugins/telemetry.test.ts` (no DSN ⇒ not initialised, no network; 4xx `ApiError`
  not captured, 500 captured with route pattern tag only; captured event passes the scrubber),
  `exports/routes.test.ts` (schemas, error mapping), `app.test.ts` (`trustProxy: 1`: spoofed XFF
  does not change `request.ip`), `lib/request.test.ts` adjustments.
- **Unit, worker**: `export/zip.test.ts` (fake storage returning streams; the handler calls
  `getObjectStream`, never `getObject`; `store` for images, deflate for text; file names; CSV
  escaping; `gps_*` columns omitted when `include_location` false; memory check: 200 synthetic
  20 MiB streams ⇒ `heapUsed` delta < 150 MiB), `export/notify.test.ts` (no email when the
  requester function returns NULL; email has no URL/token), `telemetry.test.ts` (wrapper tags +
  rethrow), `queues` (14), `purge.test.ts` (exports step).
- **Unit, web**: `telemetry.test.ts` (no init without DSN; no init on native; scrubbed), `ExportPage.test.tsx`,
  free-tier chat clear button, `SharedPhotoViewer` date-only.
- **Integration, db** (`packages/db/review-fixes.integration.test.ts` + extensions of
  `rls.integration.test.ts`): migrations 18–19 up/down/up, types diff clean, every table FORCE
  RLS; admin A cannot `UPDATE role` or `DELETE` admin B's row (0 rows), can demote self, can
  remove/promote a contributor, B can delete own row after a request; co-member reads of
  `profiles` return 0 rows, `member_profiles` returns 3 columns for co-members and nothing for
  strangers/deleted profiles, self-read of `profiles` keeps consent/notify columns; contributor
  `UPDATE is_sensitive`/`approval`/`approved_by` on own pending photo raises, own trash works,
  admin approval pins `approved_by` to the actor even when another id is supplied, admin insert
  with a foreign `approved_by` fails; `data_exports`: contributor insert fails, admin insert ok,
  second concurrent insert raises 'already in progress', 4th in 24 h raises the limit, co-admin
  sees the row, `storage_key` not selectable, `pipeline` updates status, `export_requester_email`
  NULL while running / set when ready / NULL after the requester leaves the baby,
  `export_requester_is_admin`, cascade on baby delete, `requested_by` NULL on profile delete.
- **Integration, api**: exports routes end to end with a stub queue (202 → list → 403 for
  co-admin download → 410 for expired → 204 delete sets expiry; fresh sign-in required; audit
  rows), account deletion with a failing GoTrue stub (profile `deleted_at` back to NULL, no
  `account.deleted` row, 503) and a passing one (`account.deleted` with `target_user_id`), chat
  thread GET/DELETE for a free-baby admin (200/204) and a contributor (403), viewer `takenAt`
  date-only, members route: demoting the other admin still 403 (policy denial mapped, not 500).
- **Integration, worker** (`export/export.integration.test.ts`, real DB + MinIO): a baby with 5
  fixture originals (2 with GPS) ⇒ `data.export` produces a ZIP whose entries, CSV rows, JSON and
  `album.json` match; `gps_*` present with values only when `include_location`; free baby ⇒ empty
  `ai_*`; ready row + audit + Mailpit message to the requester containing no URL; `too_large`
  with `EXPORT_MAX_BYTES` tiny; `requester_not_admin` after demotion; `purge.trash` after
  back-dating `expires_at` ⇒ 0 object versions, `status='expired'`, `purged_at`; worker log has no
  coordinate, email, `X-Amz-Signature` or `eyJ`.
- **Export gate** `e2e/export/gate.ts` (`pnpm e2e:export-gate`, dev stack): fresh admin + co-admin
  + contributor via the API helpers, upload 3 GPS fixtures (step-4 helpers), `POST exports`
  (include on) ⇒ poll to `ready` within 120 s ⇒ co-admin lists it but `download-url` ⇒ 403;
  contributor `POST` ⇒ 403; requester `download-url` ⇒ fetch ZIP ⇒ 3 originals byte-identical to
  the fixtures, `photos.csv` has 3 rows with non-empty `gps_lat`, `album.json` has no coordinates;
  a second export with include off ⇒ `gps_lat` column absent; 4th request ⇒ 429; `DELETE` ⇒ sweep
  (`run-job purge.trash`) ⇒ object versions 0; api+worker logs scanned (`scan-logs-for-secrets.mjs`
  with the fixture coordinates added). Writes `e2e/native-results/export-gate.json`.
- **Smoke** (`e2e/smoke/dev-stack.sh`): `pgmigrations` 19, `queues: 14`, api/worker logs contain
  no `sentry` init line (DSN unset), web `GET /` has no CSP header in dev (Vite), `docker compose
  exec worker printenv SMTP_HOST` ⇒ `mail`.
- **Share gate**: `takenAt` values match `^\d{4}-\d{2}-\d{2}$`.
- **Sentry hygiene** (`.github/scripts/sentry-hygiene.sh`): every `Sentry.init` has
  `sendDefaultPii: false`, `defaultIntegrations: false`, `tracesSampleRate: 0`,
  `beforeBreadcrumb`, `beforeSend: scrubTelemetryEvent`; no `@sentry/capacitor`,
  `@sentry/replay`, `@sentry/tracing`, `@opentelemetry/*` in any `package.json`; web init is
  guarded by `isNative()`.

## 3. Tasks

Owners per `CLAUDE.md`. Lanes: D = devops, B = backend, S = security, A = ai, M = mobile, F =
frontend, T = test, O = orchestrator. Same-lane tasks run in sequence. Ownership exceptions
assigned by this plan (orchestrator to approve, as in steps 8–9): backend-engineer writes
`packages/shared/**` in R.2; devops-engineer owns every `package.json` + `pnpm-lock.yaml` in R.1
only; mobile-engineer owns `apps/mobile-web/scripts/check-ios-plists.ts`, `fastlane/**`,
`store/**`, `NATIVE.md` (as in step 9).

### R.1 Dependencies and scripts (devops-engineer) — group 0, alone (lockfile)

- Owned for this task only: every `package.json`, `pnpm-lock.yaml`, `.npmrc`, root
  `vitest.config.ts` (project globs for new test files if needed).
- Add (newest stable past pnpm's release-age gate; **report the exact versions for approval**,
  D7): `@sentry/node` (api, worker; same version), `@sentry/react` (mobile-web; same major as
  `@sentry/node`), `archiver` + dev `@types/archiver` (worker), `@aws-sdk/lib-storage` **pinned to
  `3.1147.0`** (the repo's AWS SDK version), `nodemailer 10.0.15` (worker; already in the
  lockfile for the api). Nothing else; stop and report if one more is needed.
- Scripts: root `e2e:export-gate` (`tsx e2e/export/gate.ts`); `apps/mobile-web`
  `check:ios-plists`.
- Done-when: `pnpm install --frozen-lockfile` is a no-op afterwards; `pnpm lint && pnpm typecheck
  && pnpm test` green; the web bundle (`pnpm --filter @littlelight/mobile-web build` with no
  `VITE_SENTRY_DSN`) grows by < 1 % (Sentry is a lazy chunk).

### R.2 Shared contracts (backend-engineer, orchestrator approval) — group 0 (parallel with R.1)

- Owned: `packages/shared/src/{jobs,constants,env,auth,index}.ts`, `src/api/exports.ts` (new),
  `src/telemetry.ts` (new), `src/api/share-viewer.ts` (`takenAt` only), `src/upload.ts`
  (`exportKey`).
- Build 2.2 literally; browser-safe (zod only); move the `redactUrl` regexes from
  `apps/api/src/app.ts` into `telemetry.ts` and re-export them (app.ts imports them in R.8).
- Done-when: `pnpm typecheck` green; existing shared tests green; `scrubTelemetryEvent` passes a
  fixture containing each pattern of 2.2 (R.12 expands it).

### R.3 Migrations A and B, README, types (security-engineer) — group 1 (after R.2 for the audit event names only; may start at once)

- Owned: `packages/db/migrations/1792300000100_review-hardening.sql`,
  `packages/db/migrations/1792300000200_data-exports.sql`, `packages/db/src/generated/**`,
  `packages/db/README.md`.
- Build 2.1. Explicit: FORCE RLS on `data_exports`; `storage_key` not granted to `authenticated`;
  `export_requester_email` executable by `pipeline` only and NULL unless ready/failed + requester
  still admin + profile live; the photos trigger fires for `authenticated` only and raises fixed
  messages; `member_profiles` excludes deleted profiles; both migrations reversible; grants
  audit of 2.1 B for the worker query; verify `uploads/service.ts` inserts `approved_by =
  auth_uid()` for admin uploads and report.
- Done-when: `pnpm db:migrate` applies 18–19, rerun no-op, `db:migrate:down 2 && db:migrate`
  round-trips, applies on the bare stub; `pnpm db:types` committed with no diff; the
  every-table-forced query returns 0; seed still idempotent; `psql` as `authenticated` with admin
  A's claims: `UPDATE baby_members SET role='contributor' WHERE user_id=<B>` ⇒ 0 rows.

### R.4 Env, compose, nginx, Dockerfile (devops-engineer) — group 1 (parallel; after R.1)

- Owned: `.env.dev`, `.env.example`, `docker-compose.dev.yml`, `docker-compose.yml`,
  `docker/nginx/default.conf`, `docker/nginx/templates/csp.conf.template` (new),
  `apps/mobile-web/Dockerfile`.
- Build 2.11 (nginx items) and 2.12. Explicit: `SENTRY_DSN` to api and worker only; the web DSN
  only as a build arg, default empty; worker SMTP from the same anchors as the api; CSP header
  defaults to report-only; a fresh clone with no env files still starts.
- Done-when: both `docker compose … config -q` pass; `exec worker printenv SMTP_HOST` ⇒ `mail`;
  `exec api printenv SENTRY_DSN` ⇒ empty/unset; `docker build --target prod` of the web image then
  `docker run -e S3_PUBLIC_ENDPOINT=http://localhost:9000 -e WEB_CSP_HEADER=Content-Security-Policy-Report-Only -e WEB_CSP_CONNECT_EXTRA= -p 18080:80 <img>` ⇒ `curl -sI localhost:18080/ | grep -i content-security-policy-report-only` prints the policy with the endpoint substituted and no literal `${`; `curl -sI localhost:18080/s/x` has it too plus `Referrer-Policy: no-referrer`.

### R.5 iOS debug plist via xcconfig; store listings (mobile-engineer) — group 1 (parallel)

- Owned: `apps/mobile-web/ios/**`, `apps/mobile-web/scripts/check-ios-plists.ts`,
  `apps/mobile-web/fastlane/**`, `apps/mobile-web/store/**`, `apps/mobile-web/NATIVE.md`.
- Build 2.9 and 2.10. Explicit: release `Info.plist` has no `NSAppTransportSecurity` and no
  `CFBundleURLTypes`; nothing else moves; no plan name or price anywhere in the listings; the AI
  disclosure stays.
- Done-when: `xcodebuild … -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build`
  and the same with `-configuration Release` both succeed; `PlistBuddy -c 'Print :CFBundleURLTypes'`
  on the Release product fails (key absent) and succeeds on the Debug product;
  `NSAppTransportSecurity` likewise; `plutil -lint` passes on both source plists; `pnpm --filter
  @littlelight/mobile-web check:ios-plists` passes; `grep -rn "Plus" apps/mobile-web/fastlane
  apps/mobile-web/store` matches only the "iPhone 14 Plus" device name; `pnpm e2e:native-ios`
  still passes its static step on a Debug build.

### R.6 Chat history access (ai-engineer) — group 1 (parallel)

- Owned: `apps/api/src/search/access.ts`, `apps/api/src/chat/routes.ts`.
- Build 2.7. Explicit: `POST …/chat/messages` keeps the plan gate before any model call;
  `requireChatHistoryAccess` makes no model or embedding call; contributors stay 403.
- Done-when: typecheck/tests green; `curl -X DELETE …/babies/<free baby>/chat/thread` as its admin
  ⇒ 204 and `chat.cleared` audited; as a contributor ⇒ 403.

### R.7 Web telemetry, viewer date, chat clear (frontend-engineer) — group 1 (after R.1, R.2)

- Owned: `apps/mobile-web/src/**` (this task: `lib/telemetry.ts`, `main.tsx`,
  `components/share/SharedPhotoViewer.tsx`, the free-tier chat screen, `i18n/en.ts`).
- Build the web rows of 2.6, the viewer row of 2.11 and the frontend row of 2.7. Explicit: Sentry
  is a dynamic import guarded by `VITE_SENTRY_DSN` **and** `!isNative()`; `sendDefaultPii: false`,
  `defaultIntegrations: false`, `tracesSampleRate: 0`, `beforeBreadcrumb: () => null`,
  `beforeSend: scrubTelemetryEvent`; no replay, no tracing, no console integration; nothing from
  `/s/<token>` URLs can reach an event (the scrubber drops `request`; add a unit test that an
  event built on a `/s/<token>` page has no token anywhere).
- Done-when: `pnpm --filter @littlelight/mobile-web typecheck && test` green; `CI=1 pnpm e2e`
  green; a dev build with `VITE_SENTRY_DSN` set to a local mock URL shows exactly one scrubbed
  POST on a thrown test error and none without the var.

### R.8 API: telemetry, trustProxy, exports routes, jobs (backend-engineer) — group 2 (after R.2, R.3)

- Owned: `apps/api/src/plugins/telemetry.ts` (new), `apps/api/src/exports/**` (new),
  `apps/api/src/plugins/jobs.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`,
  `apps/api/src/config.ts`, `apps/api/src/lib/errors.ts` (new error codes), `apps/api/src/uploads/service.ts`
  only if R.3 reported the `approved_by` insert needs pinning.
- Build 2.5, the api rows of 2.6, `trustProxy: 1`. Explicit: exports routes run under the
  caller's claims (no `withServiceRole`); `requireFreshSignIn` on request and download-url;
  requester-only download; signed URL TTL 600 s with attachment disposition; the URL never
  logged; audit rows per 2.5; `enqueueDataExport` after commit; the `onError` capture sends
  route **pattern**, method, status and the scrubbed exception only; `Sentry.init` only when the
  DSN is set.
- Done-when: typecheck/tests green; walkthrough 4.3 steps 1–6 pass; `curl -s $B/api/healthz
  -H 'x-forwarded-for: 127.0.0.1'` from the host in production mode returns `{status}` only (not
  the detailed body).

### R.9 API auth and sharing fixes (security-engineer) — group 2 (after R.3; parallel with R.8)

- Owned: `apps/api/src/auth/account.ts`, `apps/api/src/auth/members.ts`,
  `apps/api/src/auth/invites.ts`, `apps/api/src/sharing/queries.ts`.
- Build 2.8; switch the co-member `profiles` joins in `members.ts` (~line 54), `invites.ts` (~473),
  `account.ts` (~55) to `public.member_profiles` (self reads may stay on `profiles`); map a policy
  denial on demote/remove-other-admin to the existing 403 messages (never 500); viewer `takenAt`
  date-only (2.11).
- Done-when: 4.3 steps 7–9 pass; step-3 e2e (`e2e/auth/*.spec.ts`) green; share gate green with
  date-only `takenAt`.

### R.10 Worker: export job, mailer, purge, telemetry (backend-engineer) — group 2 (after R.8, same lane)

- Owned: `apps/worker/src/export/**` (new), `apps/worker/src/email/**` (new),
  `apps/worker/src/telemetry.ts` (new), `apps/worker/src/{queues,main,run-job,config,storage,purge,logger}.ts`.
- Build 2.3, 2.4, the worker rows of 2.6. Explicit: `pipeline` role through `runAsPipeline` with
  the data key; decrypt only when `include_location` and `export_requester_is_admin()`; streams
  only (`getObjectStream`, lib-storage `Upload`), never `getObject` into a Buffer for originals;
  the email has no URL/token; **no model call, no embedding call**; logs carry ids/counts/bytes/
  categories only; `fake`/dev behaviour unchanged for every other queue; `wrapHandler` rethrows
  so pg-boss semantics are unchanged.
- Done-when: boot log `queues: 14`; `run-job data.export` on a row created through the API
  produces a ZIP (`mc ls`/`HeadObject`) whose `unzip -l` lists `README.txt`, `album.json`,
  `photos.json`, `photos.csv`, `milestones.csv`, `measurements.csv`, `originals/…`; Mailpit shows
  the ready email to the requester with no `http` link; `run-job purge.trash` after back-dating
  `expires_at` deletes it.

### R.11 Export UI (frontend-engineer) — group 3 (after R.7, R.8)

- Owned: `apps/mobile-web/src/**` (`pages/settings/ExportPage.tsx`, `SettingsPage.tsx` row,
  `lib/api.ts` client calls, `App.tsx` route, `i18n/en.ts`).
- Build 2.13. Explicit: admins only (hidden for contributors; the API enforces anyway); fresh
  sign-in gate reused; no URL stored (the signed URL is opened/`<a download>` immediately and
  discarded); polling stops when no export is queued/running; `docs/DESIGN.md` (one primary
  action, skeletons, 44 px targets, status chips with AA contrast).
- Done-when: typecheck/test green; `CI=1 pnpm e2e` green; screenshots of Settings and the Export
  page (empty, running, ready, failed) in light/dark × phone/desktop reviewed.

### R.12 Tests (test-engineer) — group 4 (after R.3–R.11)

- Owned: `**/*.test.ts(x)`, `packages/db/test/**`, `apps/api/src/testing/*`,
  `apps/worker/src/testing/*`, `e2e/**` (incl. `e2e/export/gate.ts`, `e2e/smoke/dev-stack.sh`,
  `e2e/sharing/gate.ts` takenAt check, `.github/scripts/scan-logs-for-secrets.mjs` patterns —
  coordinate and email regexes — coordinate with R.13 since `.github/**` is devops-owned: the
  test-engineer proposes the patterns, devops applies them).
- Build 2.14 except the CI steps.
- Done-when: `pnpm test` and `pnpm test:integration` green on the dev stack and on bare pgvector +
  MinIO, none skipped; `pnpm e2e:export-gate` passes twice in a row; `pnpm smoke`, `pnpm e2e`,
  `pnpm e2e:share-gate` green.

### R.13 CI (devops-engineer) — group 5 (after R.12)

- Owned: `.github/workflows/ci.yml`, `.github/scripts/**`.
- Add: export gate + its log scan in the dev-stack job (restart the api between gates as today);
  `sentry-hygiene.sh` (2.14) in `check`; `check:ios-plists` and `plutil -lint` of both source
  plists in `native-hygiene`/`ios-sim-build` (the manual iOS job also builds `Release` and asserts
  the two keys are absent); the web-image CSP header check in `images`; required integration
  report names for the new suites; `actionlint` clean.
- Done-when: every job's commands pass locally in order.

### R.14 Gate, PROGRESS, commit (orchestrator) — section 4

### Parallelism summary

| Group | Tasks | Notes |
| --- | --- | --- |
| 0 | R.1 (D) · R.2 (B) | R.1 alone touches lockfile/package.json; R.2 only `packages/shared` |
| 1 (parallel) | R.3 (S) · R.4 (D) · R.5 (M) · R.6 (A) · R.7 (F) | disjoint paths; R.7 after R.1+R.2; R.4 after R.1 |
| 2 (parallel) | R.8 (B) · R.9 (S) | both after R.3; R.8 after R.2 |
| 2b | R.10 (B) | after R.8 (same lane) |
| 3 | R.11 (F) | after R.7 and R.8 |
| 4 | R.12 (T) | |
| 5 | R.13 (D) | |
| Gate | R.14 (O) | section 4; then step 10 |

Step 10 (photo import) conflict notes: its migrations start at `1792300000300_…`; its worker
queues follow 14; any import path that inserts approved photos must satisfy the new
`photos_authenticated_insert` check (`approved_by = auth_uid()`) and the update guard; it should
not touch `apps/api/src/exports/**`, `apps/worker/src/export/**` or the Sentry files.

## 4. Acceptance checks and gate procedure

No PRD step check applies verbatim (this is a fix batch). The gate re-runs every earlier gate
that the touched code could affect and adds the checks below. Run from the repo root with Docker
running and `pnpm` 12.10.1 on PATH; the dev stack has no `SENTRY_DSN`, the fake AI provider, and
`PUSH_PROVIDER=fake`.

### 4.1 Static, unit, integration

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck
bash .github/scripts/sentry-hygiene.sh && bash .github/scripts/ai-hygiene.sh && bash .github/scripts/share-hygiene.sh && bash .github/scripts/native-hygiene.sh
pnpm --filter @littlelight/mobile-web check:ios-plists
grep -rn "Plus" apps/mobile-web/fastlane apps/mobile-web/store | grep -v "iPhone 14 Plus"; echo "exit $?"   # exit 1
pnpm test
# integration: same env block as docs/plans/step-8.md 4.5, on fresh pgvector + MinIO
pnpm test:integration
git diff --exit-code -- packages/db/src/generated
```

### 4.2 Dev stack

```sh
docker compose -f docker-compose.dev.yml down -v && docker compose -f docker-compose.dev.yml up -d --build --wait
PSQL="docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d littlelight -Atc"
$PSQL "select count(*) from pgmigrations"                                                  # 19
$PSQL "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)"   # 0
$PSQL "select relkind, relname from pg_class where relname='member_profiles'"              # v|member_profiles
docker compose -f docker-compose.dev.yml logs worker | grep 'queues: 14'
docker compose -f docker-compose.dev.yml logs api worker | grep -i sentry; echo "exit $?"   # exit 1 (DSN unset => silent)
docker compose -f docker-compose.dev.yml exec worker printenv SMTP_HOST                   # mail
pnpm smoke && CI=1 pnpm e2e
pnpm e2e:export-gate && pnpm e2e:export-gate
pnpm e2e:share-gate && pnpm e2e:push-gate && pnpm e2e:upload-gate && pnpm e2e:ai-gate
```

### 4.3 API walkthrough (`B=http://localhost:8080`, cookie jar per user; `H='x-littlelight-client: web'`)

1. Sign in as demo mom (OTP via Mailpit; fresh). `POST $B/api/babies/<maya>/exports -d
   '{"includeLocation":true}'` ⇒ 202 `{export:{status:"queued",isMine:true,...}}`; a second POST
   at once ⇒ 409 `export_in_progress`.
2. Poll `GET $B/api/babies/<maya>/exports` until `status:"ready"` (≤ 120 s on the dev stack);
   `photoCount` 12, `bytes > 0`, `canDownload: true`. Mailpit has "Your Littlelight export … is
   ready" to `demo-mom@…` and `grep -c http` on its body ⇒ 0 links other than none.
3. `POST …/exports/<id>/download-url` ⇒ 200 `{url}` with `X-Amz-Expires=600` and
   `response-content-disposition=attachment`; `curl -o maya.zip "$url"` ⇒ `unzip -l maya.zip`
   lists 12 `originals/…`, `photos.csv`, `photos.json`, `album.json`, `milestones.csv`,
   `measurements.csv`, `README.txt`; `unzip -p maya.zip photos.csv | head -1` ends with
   `gps_lat,gps_lng`; `unzip -p maya.zip album.json | grep -c '"lat"'` ⇒ 0.
4. As demo dad (co-admin): `GET …/exports` lists the row with `isMine:false, canDownload:false`;
   `POST …/download-url` ⇒ 403 `not_requester`. As the nanny (contributor): `POST …/exports` ⇒
   403; `GET …/exports` ⇒ 403.
5. Mom without a fresh sign-in (wait 10 min or use a stale session) ⇒ `POST …/exports` 403
   `fresh_sign_in_required`.
6. `DELETE …/exports/<id>` ⇒ 204; `docker compose exec worker pnpm run-job purge.trash` ⇒
   `$PSQL "select status, purged_at is not null from data_exports where id='<id>'"` ⇒
   `expired|t`; `docker compose exec storage mc ls --versions local/littlelight/babies/<maya>/exports/` ⇒ empty.
7. Members: as mom, `PATCH /api/babies/<maya>/members/<dad> {"role":"contributor"}` ⇒ 403 (same
   message as before); `DELETE /api/babies/<maya>/members/<dad>` ⇒ creates a removal request
   (unchanged flow); `$PSQL` as `authenticated` with mom's claims `DELETE FROM baby_members WHERE
   user_id='<dad>' AND baby_id='<maya>'` ⇒ `DELETE 0`.
8. Profiles: `$PSQL` with mom's claims: `SELECT notify_share_viewed FROM profiles WHERE
   user_id='<dad>'` ⇒ 0 rows; `SELECT * FROM member_profiles WHERE user_id='<dad>'` ⇒ 1 row with
   3 columns; `GET /api/babies/<maya>/members` still shows names and relationship labels.
9. Account deletion with GoTrue down: `docker compose stop auth`; as a throwaway user `DELETE
   /api/me` ⇒ 503; `$PSQL "select deleted_at from profiles where user_id='<u>'"` ⇒ NULL;
   `$PSQL "select count(*) from audit_log where event='account.deleted' and
   metadata->>'target_user_id'='<u>'"` ⇒ 0; `docker compose start auth`; repeat ⇒ 204 and the
   audit row exists.
10. Chat history: `pnpm db:plan <maya> free`; as mom `GET /api/babies/<maya>/chat/thread` ⇒ 200,
    `DELETE …/chat/thread` ⇒ 204; as nanny ⇒ 403; `pnpm db:plan <maya> plus` to restore.
11. Viewer: `POST /api/share/session {"token":"demo-grandparents-share-token"}` then
    `GET /api/share/photos` ⇒ every `takenAt` matches `^\d{4}-\d{2}-\d{2}$` or is null.
12. Contributor photo: `$PSQL` with the nanny's claims on her own pending photo: `UPDATE photos
    SET is_sensitive = true WHERE id='<p>'` ⇒ ERROR `contributors may only trash…`; `UPDATE photos
    SET deleted_at = now() WHERE id='<p>'` ⇒ `UPDATE 1`. With mom's claims: `UPDATE photos SET
    approval='approved', approved_by='<dad>' WHERE id='<p2>'` ⇒ `approved_by` reads mom's id.
13. Logs: `docker compose logs api worker | grep -E "X-Amz-Signature|eyJ[A-Za-z0-9_-]{10,}|@littlelight\.local|-?[0-9]{1,3}\.[0-9]{3,},\s*-?[0-9]{1,3}\.[0-9]{3,}"; echo "exit $?"` ⇒ exit 1.

### 4.4 Sentry (manual, with a throwaway DSN or a local mock)

```sh
# api: a mock ingest (e.g. `npx http-echo-server 9009` or any local HTTP sink) and SENTRY_DSN=http://k@localhost:9009/1
SENTRY_DSN=http://k@localhost:9009/1 docker compose -f docker-compose.dev.yml up -d api worker
curl -s -X POST $B/api/__test/boom   # only if a test route exists; otherwise trigger a 500 by stopping storage and calling an upload route
# the mock receives one envelope; `jq` on it: no "request", no "breadcrumbs", no "cookie", no "X-Amz", no "eyJ", no "@"
docker compose -f docker-compose.dev.yml up -d api worker   # back to no DSN
```

Web: `VITE_SENTRY_DSN=http://k@localhost:9009/2 pnpm --filter @littlelight/mobile-web dev`, open
`/s/demo-grandparents-share-token`, run `throw new Error("x")` in the console ⇒ one envelope with
no `request`, no token, no breadcrumbs. Without the var ⇒ no Sentry chunk in the network panel.

### 4.5 iOS (Debug and Release products; needs the installed simulator runtime)

```sh
pnpm --filter @littlelight/mobile-web native:sync:ios
for CFG in Debug Release; do
  xcodebuild -project apps/mobile-web/ios/App/App.xcodeproj -scheme App -configuration $CFG -sdk iphonesimulator -derivedDataPath apps/mobile-web/ios/DerivedData CODE_SIGNING_ALLOWED=NO build
  APP=apps/mobile-web/ios/DerivedData/Build/Products/$CFG-iphonesimulator/App.app
  /usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' "$APP/Info.plist" >/dev/null 2>&1 && echo "$CFG: scheme present" || echo "$CFG: scheme absent"
  /usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsLocalNetworking' "$APP/Info.plist" 2>/dev/null || echo "$CFG: ATS key absent"
done   # Debug: present/true; Release: absent/absent
plutil -lint apps/mobile-web/ios/App/App/Info.plist apps/mobile-web/ios/App/App/Info-Debug.plist
pnpm e2e:native-ios   # static step on the Debug build still passes
```

### 4.6 Gate summary to record in PROGRESS

PASS for 4.1–4.3 and 4.5 (4.4 if a mock was run); screenshots reviewed (R.11); the decisions
of section 5 recorded as taken; the deferred list copied to open issues. Commit as
`review fixes: export, sentry, rls hardening, account deletion, ios debug plist, store copy`.

## 5. Risks and decisions (orchestrator / user to confirm or override)

### 5.1 Decisions (defaults proposed)

- **D1 — GPS in the export: included by default, with an "Include photo locations" toggle.**
  Justification: FR-10.1 is "all originals + metadata", and the originals in the same ZIP are
  byte-identical uploads that already carry the camera's GPS in EXIF (FR-2.3), so omitting
  `gps_*` from the CSV protects nothing while making the export silently incomplete; the real
  control is access: admins only, requester-only download, fresh sign-in, 10-minute URL,
  decryption only at run time and only if the requester is still an admin, 7-day expiry, audit
  on request/ready/download/purge, and the co-admin sees every export in the list. Override:
  default off, or admins-only-with-location never (then drop `include_location`).
- **D2 — Fresh sign-in (≤ 10 min) required to request an export and to mint a download URL**,
  the same rule as the PRD's destructive admin actions: a stolen session must not exfiltrate the
  whole album. Override: fresh sign-in on request only.
- **D3 — Both admins see every export of the album (requester, status, dates); only the
  requester can download.** Transparency between co-parents is the safeguard. Override:
  requester-only visibility.
- **D4 — Photo selection**: live (`deleted_at IS NULL`), not quarantined, not failed/duplicate,
  `approval IN (approved, pending)`; sensitive photos included (flagged in the CSV). Trash is
  excluded (it is scheduled for deletion). Override: include trash with a `trashed_at` column.
- **D5 — Limits**: 7-day availability (`EXPORT_TTL_DAYS`), 3 requests per album per day, one in
  progress per album, `EXPORT_MAX_BYTES` 100 GiB (an export temporarily doubles the album's
  storage footprint; the 80 % disk alert already exists). Early delete by either admin.
- **D6 — Notification by email only** (worker gains SMTP + nodemailer; the message carries no
  link). Push `export_ready` is deferred (it needs a per-user target function). Override: no
  email (in-app status only), or add push now.
- **D7 — New dependencies needing approval** (R.1): `@sentry/node` (api, worker), `@sentry/react`
  (web), `archiver` + `@types/archiver` (worker), `@aws-sdk/lib-storage@3.1147.0` (worker),
  `nodemailer@10.0.15` (worker). Versions for the Sentry SDKs: the newest stable past pnpm's
  release-age gate, same major for both (expected 10.x–11.x at the time of writing); devops
  reports the exact pins. No `@sentry/capacitor`, no `@sentry/replay`/tracing, no
  `@opentelemetry/*`. Alternative for the ZIP: an in-house store-only zip64 writer (~300 lines,
  easy to get wrong) — not recommended.
- **D8 — Sentry scope**: errors only (`tracesSampleRate: 0`), default integrations off, no
  breadcrumbs, scrubbed by one shared pure function; **web client enabled on the web origin
  only** (`!isNative()`), so the native apps ship no telemetry and the drafted privacy label /
  Data Safety answers ("no analytics or crash SDK") stay true. **OpenTelemetry deferred** (the
  Sentry Node SDK is OTel-based; traces are a config flip later; no collector now). Override:
  enable in the native WebView too (then update `store/privacy-nutrition-label.md` and
  `data-safety.md` to declare Crash/Diagnostics data).
- **D9 — CSP ships Report-Only**, env-switchable to enforcing (`WEB_CSP_HEADER`). The dev stack
  serves the SPA through Vite (no nginx), so an enforcing policy would reach production with no
  automated page coverage; report-only is zero-risk and the console shows violations. Flip after
  a week of clean production use. Override: enforce now (then budget a prod-image Playwright pass).
- **D10 — `trustProxy: 1`** plus nginx setting `CF-Connecting-IP` from `$remote_addr` when
  absent. Rate-limit keys for non-Cloudflare traffic become per peer; forging the header without
  Cloudflare in front remains possible (documented since step 4).
- **D11 — FR-1.5 as policy text, not a SECURITY DEFINER function**: `authenticated` may delete or
  demote an admin row only when it is their own; the request/confirm flow and service_role
  writes are unchanged. Smaller surface than a function; the API already behaves this way, so
  no user-visible change. Override: a `remove_member()` SECURITY DEFINER function.
- **D12 — `member_profiles` view** (security_barrier, 3 columns, excludes deleted profiles)
  replaces the co-member branch of the `profiles` SELECT policy. The view's owner reads
  `profiles` past RLS by design (its WHERE is the policy). Alternative: a SECURITY DEFINER
  set-returning function (the repo's pattern for helpers) — equivalent; the view joins more
  naturally in the three API queries.
- **D13 — Photos guard as a trigger**, because pinning `approved_by` and freezing
  `is_sensitive`/`approval` for contributors needs the OLD row, which `WITH CHECK` cannot see;
  the INSERT `WITH CHECK` pins `approved_by` for admin uploads. The API's validation stays as
  defence in depth.
- **D14 — Account deletion**: keep the pre-mark (`deleted_at`) so pushes/visibility stop at once,
  compensate (`deleted_at = NULL`) on GoTrue failure, and write `account.deleted` only after
  success (actor NULL, `target_user_id` in metadata). Override: drop the pre-mark entirely.
- **D15 — Chat history is admin-gated only**; the plan gate stays on sending. The free-tier chat
  screen gets a "Clear chat history" action when history exists.
- **D16 — Contributors keep seeing AI descriptions** (overrides applied) of photos they can see;
  never raw output, retry or override controls. No code change; recorded.
- **D17 — iOS debug surface via two plists + xcconfig `INFOPLIST_FILE`** with a hygiene diff, the
  tool-safe analogue of Android's debug manifest. Alternative: `INFOPLIST_PREPROCESS` with
  `#ifdef` (breaks `plutil -lint` on the source and plist editors) or a Debug-only PlistBuddy
  build phase.
- **D18 — Store copy**: the AI disclosure stays, without "Plus", plan or price wording.
- **D19 — Viewer `takenAt` as a UTC calendar date.** The viewer role cannot read
  `photo_exif.tz_offset_minutes`; a late-evening photo east of UTC can show the next day. The
  viewer already shows no time. Override: expose `age_days`-based grouping only, or add the
  offset to the viewer allow-list (one more column of EXIF exposure).
- **D20 — GoTrue audit log**: note only now; a 90-day prune of `auth.audit_log_entries` (emails,
  IPs in payload) is deferred.

### 5.2 Deferred (record in `docs/PROGRESS.md`)

- OpenTelemetry traces / collector (D8); CSP enforcing mode (D9); push notification for export
  ready (D6); GoTrue audit-log prune (D20); `photo_exif.raw_json` in the export (hidden from
  users today; originals already carry full EXIF); narrowing contributor-visible AI fields (D16);
  Sentry in native WebViews / `@sentry/capacitor` (D8); export of trashed photos (D4);
  per-export email to the co-admin ("your co-parent exported the album" — the list already shows
  it); server-side streaming of the ZIP through the API (not needed: MinIO signed GET).

### 5.3 Risks

- **R1 — Memory and disk during export.** Bounded by streaming (2 × 16 MiB parts + archiver
  buffers); verified by the worker unit test's heap assertion and the integration test. Disk:
  the ZIP temporarily doubles the album's footprint until expiry; `EXPORT_MAX_BYTES` and the
  existing 80 % disk alert cover it. If MinIO's multipart `Upload` from `lib-storage` misbehaves
  with the bucket-scoped worker key (needs `s3:PutObject`, `AbortMultipartUpload`,
  `ListMultipartUploadParts`), devops adjusts the `littlelight-worker` policy (storage-init).
- **R2 — Sentry SDK integration surface.** `@sentry/node` ≥ 8 auto-instruments when default
  integrations are on; the plan turns them off. If a version needs an `--import` preload for
  anything we use (we use none), stay without it. If `defaultIntegrations: false` drops the
  uncaught-exception handlers' exit behaviour, keep `exitEvenIfOtherHandlersAreRegistered: false`
  and the processes' own handlers.
- **R3 — `trustProxy: 1` in dev.** Vite's proxy may or may not add `X-Forwarded-For`; either
  way `clientIp()` prefers `CF-Connecting-IP`, which the e2e helpers set, and the smoke/e2e
  restart the api between runs. If the api integration tests inject `x-forwarded-for` to vary
  IPs, test-engineer switches them to `cf-connecting-ip` (most already do).
- **R4 — Policy denial mapping.** The new `baby_members` policies make an UPDATE/DELETE affect 0
  rows rather than raise; `members.ts` already blocks these cases before the query, so no 500 is
  expected; R.9 adds the row-count check so a bypass would surface as 403, never silent success.
- **R5 — View ownership.** If migrations do not run as a role that can read `profiles` past RLS,
  `member_profiles` returns nothing; R.3's done-when checks the view from an admin's claims, and
  the fallback is the SECURITY DEFINER function of D12.
- **R6 — nginx envsubst with `read_only: true`.** The official image writes rendered templates
  into the output dir at start; with a read-only root it needs that dir on tmpfs. R.4 verifies
  and otherwise pre-renders at build time with the production defaults.
- **R7 — Export of HEIC originals on the web.** Browsers cannot preview HEIC, but the export is
  a download; `README.txt` says so. No conversion is attempted (FR-2.3 originals untouched).
- **R8 — Audit event growth.** `export.*` events add six names to `AUDIT_EVENTS`; the strict
  metadata schema gains two keys; nothing else in the audit path changes.
- **Needs the user:** approve D7 dependencies; confirm D1/D2/D3/D6/D8/D9 defaults; a throwaway
  Sentry DSN (or none — the mock in 4.4 suffices) if a real end-to-end check is wanted. Still
  open from earlier steps: production credentials (tunnel config, SMTP, B2, storage keys),
  Apple/Google IDs, Turnstile, legal text, CSAM provider, step 9 part B.
