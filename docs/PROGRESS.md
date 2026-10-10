# Littlelight build progress

This file is updated by the orchestrator at the end of every completed step (per `CLAUDE.md`'s
"Record" workflow step), right before the commit for that step. It is the main way a human
checking in later — or a fresh orchestrator session — can see what's been built, what was
decided, and what's still open.

Add a new entry per step, in order. Do not rewrite or delete earlier entries.

## Entry template

```
## Step N: <short title>

- **Built**: what shipped in this step (files/features, one or two lines).
- **Decisions**: any PRD ambiguity resolved and the default chosen.
- **Open issues**: anything deferred, blocked, or flagged for the user.
- **Commit**: <git commit hash/message>
```

---

## Step 1: Scaffold (monorepo, Docker Compose, CI)

- **Built**: pnpm 12 monorepo (`@littlelight/{shared,ai,db,api,worker,mobile-web}`), Biome, Vitest,
  TypeScript 7. `packages/db`: GoTrue bootstrap (`supabase_auth_admin`, `auth` schema, NOLOGIN
  `anon`/`authenticated`/`service_role`) + reversible node-pg-migrate SQL migrations (pgvector,
  pgcrypto, `worker_heartbeats` with RLS) + no-op seed. Fastify API with `/healthz` (db + storage).
  pg-boss worker with heartbeat-based healthcheck. `packages/ai` interfaces/stubs only. Ionic React
  tab shell with Vite proxy matching nginx. Multi-stage Dockerfiles (non-root prod), nginx, GoTrue
  OTP email templates, `docker-compose.dev.yml` (zero-setup) and `docker-compose.yml` (prod with
  cloudflared + backups), `.env.dev`, `.env.example`, backup/restore scripts. GitHub Actions CI
  (check, images matrix, dev-stack smoke). 46 unit + 7 db integration tests; `e2e/smoke/dev-stack.sh`.
- **Gate**: orchestrator ran `e2e/smoke/dev-stack.sh` from a clean copy of the committed files:
  all services healthy, one-shots exit 0, app at :8080, `/api/healthz` + `/auth/health` via proxy,
  OTP email with 6-digit code in Mailpit, heartbeat fresh, storage stop → api 503/worker unhealthy
  and recovery. CI jobs' commands all passed locally (actionlint clean); a real GitHub run awaits a
  push (needs user approval).
- **Decisions**:
  - **User decision:** MinIO images `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` + `pgsty/mc:RELEASE.2026-09-16T00-00-00Z`
    (official `minio/minio` images no longer published), behind `MINIO_IMAGE`/`MC_IMAGE`.
  - Pins: `supabase/auth:v2.197.0`, `pgvector/pgvector:0.8.7-pg17`, `node:22.23.3-alpine`; Ionic 9.0.6
    (9.0.7 inside pnpm's minimum-release-age gate); react-router 6.x (Ionic peer range).
  - pnpm 12 `allowBuilds: { esbuild: true }` only. No `.tool-versions` (would break asdf node);
    `.nvmrc` = 22.23.3.
  - GoTrue needs `GOTRUE_MAILER_URLPATHS_*=/auth/verify` (drops the `/auth` prefix otherwise).
  - Dev compose shares JWT/S3/GoTrue-DB values via an `x-dev-shared` block so auth/storage get only
    their own env (least privilege); dev host ports bound to 127.0.0.1 except 8080/9000.
  - Prod Apple/Google sign-in default off until step 3 provides client IDs.
  - Prod `AUTH_DB_PASSWORD` must be ≥16 chars (bootstrap refuses otherwise); secrets via
    `openssl rand -hex 32` (base64 breaks postgres URLs).
- **Open issues**:
  - Needs user before production: Cloudflare Tunnel token + hostnames, SMTP (Postmark/Resend),
    `STORAGE_PATH`/`BACKUP_PATH` on the server, Backblaze B2 bucket/key + restic password.
  - Privacy: MinIO versioning keeps old object versions after delete; photo/account deletion
    (FR-10.2/10.3) must purge versions or add a noncurrent-version lifecycle rule (step 4 / step 3).
  - Review should-fix, deferred: S3 prod services get the whole `.env` → per-service env and a
    bucket-scoped MinIO key (with step 2 app DB role / step 4); S4 public `/api/healthz` exposes
    version/error codes in prod (restrict by step 3); S5 heartbeat prune can delete other workers'
    storage-down rows (needs an always-advancing column).
  - Nice-to-have: nginx `absolute_redirect off`/gzip_proxied, `cap_drop` + non-root for prod
    auth/storage, drop `CREATEROLE` from `supabase_auth_admin` if GoTrue doesn't need it, tests for
    `redact.ts`/password guard/worker `healthcheck.ts`, dedupe api/worker config helpers into shared,
    migrate image size (397 MB), web main chunk ~1.5 MB (code-split later).
  - Step 2: api/worker connect as superuser today; the new app role needs grants on
    `worker_heartbeats`. `EMBED_DIMS` should be checked against `photo_search.embedding` (1024).
  - pnpm 12.10.1 must be on PATH (`npm i -g pnpm@12.10.1` or corepack) for host commands.
- **Commit**: step 1: scaffold monorepo, docker compose, CI

## Step 2: Database (schema, roles, RLS, seed)

- **Built**: 7 reversible migrations (9 total) with every PRD Data-model + Auth-data-model table
  (22 tables), indexes (HNSW cosine on `photo_search.embedding` vector(1024), GIN on tsv/tags),
  ENABLE+FORCE RLS on every table with a per-role policy matrix and column-level grants.
  Roles: `littlelight_api` (SET LOCAL ROLE authenticated|viewer|service_role per transaction),
  `littlelight_worker` (→ `pipeline`), NOLOGIN `viewer`/`pipeline`, `service_role` BYPASSRLS
  (API only). SECURITY DEFINER helpers (`is_baby_member`, `is_baby_admin`, `viewer_can_see_photo`, …)
  with pinned search_path. DB-enforced rules: max 2 admins, last admin can't leave, invite rate
  limit, free tier 1,000 photos, AI only for paid babies, sensitive photos never rule-shared (and
  rule shares removed when a photo is later flagged), contributor uploads pending-only,
  soft-delete only for users, no GPS keys in `photo_exif.raw_json` (recursive trigger), GPS/home
  coords encrypted with pgcrypto (`DATA_ENCRYPTION_KEY` as a transaction-local GUC bind param).
  In-house TS type generator (`packages/db/src/generated`, CI diff check). Idempotent dev-only demo
  seed (2 admins + nanny, baby Maya, 12 photos, share link). Compose order db → db-init → auth →
  migrate → api/worker; api/worker connect as app roles; prod services get per-service env only.
  Shared zod: DB enums, JWT claims (viewer claims strip `sub`), constants. Heartbeat prune uses
  `updated_at` (step-1 S5 fixed). Tests: 98 unit, 193 integration (RLS matrix, triggers, seed,
  migrations, hardening), smoke extended.
- **Gate**: orchestrator ran lint/typecheck/unit (98), `pnpm test:integration` (193) on a fresh
  pgvector DB, and `e2e/smoke/dev-stack.sh` from a clean copy: all services healthy, app roles only,
  seeded-family RLS spot checks (stranger 0 photos, contributor DELETE denied, viewer sees only its
  link's shared photos). PRD check "user cannot read another baby's rows; contributor cannot
  delete; viewer sees only `shared_photos`" is proven by `rls.integration.test.ts`.
- **Decisions**:
  - **User instruction (2026-10-08):** skip the per-step reviewer pass from step 3 on; run one
    combined review of everything after step 9. Step 2's review had already run.
  - Step 2 review (FAIL → fixed): M1 sensitive photo stayed visible to viewers after a later flag →
    viewers see sensitive photos only when `added_by='user'`, rule shares auto-removed on flag,
    viewer can read `is_sensitive` to blur. M2 removed member could rejoin on a live invite →
    `baby_members_consume_invite` trigger consumes the invite on any membership insert.
  - Hardening from review: recursive GPS-key check (as a trigger so Postgres doesn't log the row);
    `encrypt_coord` and `babies.home_*_enc` not available to `authenticated` (home location written
    under `service_role` in step 5 — deviates from plan 2.7); `photo_exif.raw_json` hidden from users;
    trigger functions not executable by PUBLIC; bootstrap errors redact passwords.
  - Approved deviations: contributors see `(approved AND not trashed) OR own uploads`; creator can
    see a new baby before members exist; invites UPDATE admin-only; extra avatar/chat-thread guards;
    `DATA_ENCRYPTION_KEY` ≥32 chars everywhere; no `public.users` (profiles → auth.users).
  - `packages/db/test/{harness,fixtures}.ts` are test-engineer-owned (test helpers, not `*.test.ts`).
  - pnpm 12.10.1 on host lives at `~/.cache/littlelight-pnpm/bin`.
- **Open issues**:
  - Step 3: the claims wrapper must use BEGIN…COMMIT + `SET LOCAL ROLE`, release path
    `RESET ROLE`/`DISCARD ALL`, never plain `SET ROLE`, with a test asserting
    `current_user = 'littlelight_api'` after each call. Seeded GoTrue users only proven to sign in
    once step 3 runs OTP against them (fallback: seed via GoTrue admin API).
  - Step 3: deleting the paying admin (`plan_owner_user_id ON DELETE SET NULL`) must settle
    `babies.plan`/entitlement.
  - Deferred review items: `profiles` co-member SELECT exposes consent fields (view or separate
    table later); `photos` UPDATE could pin `approved_by = auth_uid()` and stop contributors
    clearing `is_sensitive` (API validates for now).
  - Still open from step 1: bucket-scoped MinIO key (step 4), public `/api/healthz` detail (step 3),
    MinIO version purge on delete, production credentials (tunnel, SMTP, B2).
- **Commit**: step 2: database schema, roles, RLS, seed

## Step 3: Auth and onboarding

- **Built**: API fronts GoTrue (browser reaches only `/auth/{health,authorize,callback}`; nginx and
  Vite both 404 the rest). Email 6-digit OTP primary + magic-link fallback (`/signin/callback#token_hash`),
  Apple/Google (PKCE + native id-token) implemented behind flags defaulting off. jose HS256 JWT
  verification; web sessions in httpOnly cookies (`ll_access` Path /api Lax 1 h, `ll_refresh` Path
  /api/auth Strict 30-day sliding) with `X-Littlelight-Client` CSRF header; native bearer tokens.
  `runAs` per-transaction identity (SET LOCAL ROLE + claims GUC, RESET ROLE/DISCARD ALL on release,
  dead clients destroyed); `withClaims` checks the GoTrue session is live on every request, so
  per-device sign-out / account deletion take effect immediately; `withServiceRole(reason)` used in 3
  bounded places. Endpoints: OTP/verify/refresh/sign-out/pkce/id-token/config, sessions list + per-device
  sign-out, me/consent (18+, versions, IP country)/profile, babies CRUD (soft delete, fresh sign-in),
  invites (256-bit hashed token, 7-day expiry, masked mismatch message, admins_full, 20/day), members
  (role change, FR-1.5 removal request → removed admin confirms), account deletion (preview, sole-admin
  block, fresh sign-in, GoTrue hard delete). In-house throttles (5 OTP/h/email, 30/h/IP, 5 verify
  attempts), Turnstile after 3 attempts (inert without keys), audit events, new-device alert email,
  invite emails via nodemailer (Mailpit in dev). Migration 10: SECURITY DEFINER functions over
  `auth.sessions`, removal-request columns, plan reverts to free when the paying admin leaves, is
  deleted or is demoted. GoTrue: refresh rotation with the v2 algorithm (reuse deletes the session),
  90-day inactivity. Frontend: sign-up steps 1–8, invite accept, callback, baby switcher, Family tab,
  settings (devices, delete account), fresh-sign-in gate, i18n, platform/tokenStore seams for step 9.
  `/api/healthz` returns only `{status}` to non-loopback callers in production (step-1 S4 closed).
  Tests: 229 unit, 381 integration (db 229 + api 152), 12 Playwright e2e; CI runs api integration with a
  skip guard, typechecks e2e, and runs smoke + e2e in the dev-stack job.
- **Gate**: orchestrator ran lint, typecheck (incl. e2e), unit (229), integration (381) on a fresh
  pgvector DB, then from a clean copy (no `.env`): `e2e/smoke/dev-stack.sh` passed, API restarted,
  `CI=1 pnpm e2e` 12/12 passed. The PRD check is `e2e/auth/invite.spec.ts`: signs up, creates a baby,
  invites a co-admin from the onboarding step, invitee accepts with the matching email (both see 2
  admins); a different email gets "This invite was sent to o***@example.com". Real GitHub CI run still
  needs a push (user approval).
- **Decisions**:
  - No supabase-js; API is GoTrue's only client. New deps: jose 6.2.12, @fastify/cookie 11.1.2,
    nodemailer 10.0.15, @playwright/test 1.63.0 (newest past pnpm 12's 1-day release-age gate);
    no @types/nodemailer (bundled types); in-house limiter.
  - FR-1.5: removing the other admin creates a request the removed admin confirms; admins can't demote
    each other (only self-demotion), so demote-then-remove can't skip confirmation. Requesting removal,
    leaving, demotion, baby delete and account delete require a sign-in within 10 minutes.
  - Paying admin demoted, removed or deleted → baby reverts to free (DB trigger).
  - Invite accept inserts under `authenticated` (RLS invite branch + consume trigger); only the token
    lookup uses service_role.
  - One-letter email local parts mask as `*@domain`.
  - GoTrue v2 refresh algorithm still accepts the immediately previous refresh token indefinitely
    (returns the current one; not configurable). Accepted as GoTrue's fail-to-save tolerance; any older
    token deletes the session.
  - `MAIL_FROM` must be a bare address (no display name) for now.
  - Dev: GoTrue's own per-IP limits raised to 1000 so the API's limits are what's tested; tsx watch
    uses chokidar polling.
- **Open issues**:
  - Needs user (not for the gate): Apple (App ID, Services ID, .p8 key), Google (web/iOS/Android
    client IDs + web secret), redirect URI `https://littlelight.tesarsoft.com/auth/callback`;
    Turnstile keys; Postmark/Resend SMTP + verified sender; real Terms/Privacy text (placeholders,
    version 2026-10-08).
  - API throttles are in-memory (single instance); e2e uses ~19 OTPs/run against the 30/h/IP limit,
    so CI and local reruns restart the API between smoke and e2e.
  - For the final review: contributor revoke-invite gives 404 vs resend 403; deletion preview lists
    albums for contributors; invite resend has no per-invite throttle; no audit event for declining a
    removal; GoTrue `refresh_token_hmac_key` stored unencrypted unless `GOTRUE_SECURITY_DB_ENCRYPTION_*`
    is set; `apps/api/src/testing/*` are test helpers outside `*.test.ts` (test-engineer-owned).
  - Still open from earlier steps: bucket-scoped MinIO key (step 4), MinIO version purge on delete,
    production credentials (tunnel, B2).
- **Commit**: step 3: auth and onboarding

## Step 4: Upload and ingest

- **Built**: Resumable S3 multipart uploads straight from the client to MinIO (16 MiB parts, presigned
  per-part URLs on `S3_PUBLIC_ENDPOINT`, server-driven complete via ListParts, 100 MiB max, 500 files per
  session, 24 h sessions). Migration 11: `upload_sessions`, `upload_files` (`photos.id = upload_files.id`),
  `photos.status 'duplicate'`, `photos.quarantined_at`, per-baby unique SHA-256, RLS for contributors
  (pending) vs admins, `home_place_label` (Home within 150 m computed in SQL), free-tier count helper
  (excludes failed/duplicate/quarantined/trashed; pending counts), baby purge guard while quarantined
  photos exist. API: upload sessions/register/parts/complete/abort/finish, photos list (signed thumb/display
  URLs ≤ 1 h, one object each; failed/duplicate hidden), photo detail, admin-only original download,
  approve/reject, trash/restore; pg-boss send-only. Worker (pipeline role): sniff (file-type), SHA-256 +
  in-house pHash (near-dup ≤ 10 of 64), EXIF whitelist via exifr, GPS encrypted + Home label, age at
  capture (estimated flag), HEIC via heic-decode, thumb 320 / display 1600 / analysis 768 JPEG q75 with all
  metadata stripped, CSAM matcher seam (no-op default; PhotoDNA client untested), quarantine, exact-dup
  removal incl. object versions, purge.trash (30 days, all versions), uploads.sweep, ingest.reconcile,
  80 % disk alert via read-only storage mount, run-job CLI. MinIO: bucket-scoped `littlelight-api` (no
  delete) and `littlelight-worker` (deletes incl. versions) service accounts from `storage-init`, 7-day
  noncurrent lifecycle, CORS. Web: upload screen (picker, drag-and-drop, per-photo progress, retry,
  resume after reload, summary line, batch details), basic timeline grid, admin approval queue.
  Tests: 561 unit, 544 integration (db 275, api 222, worker 47 against real MinIO), 15 Playwright e2e,
  committed HEIC fixtures, `pnpm e2e:upload-gate`; CI runs worker integration with a MinIO container,
  the no-metadata grep, and the upload gate in the dev-stack job.
- **Gate**: orchestrator ran lint, typecheck (incl. e2e), unit (561), integration (544, none skipped) on
  fresh pgvector + MinIO, then from a clean copy: smoke passed, `pnpm e2e` 15/15, upload gate PASSED:
  ingested 178, failed 2, duplicates 20 skipped, near-duplicates 3, HEIC 5 → JPEG derivatives, thumbnail
  latency p50/p95/max 247/436/615 ms, wall 69.5 s, 356/356 served derivatives without EXIF/GPS, 151 GPS
  rows encrypted, purge 3 photos → 0 rows / 0 object versions.
- **Decisions**:
  - **User decisions (2026-10-08):** cloudflared runs outside Compose (removed with its token); prod
    publishes only `web` → `${WEB_BIND:-127.0.0.1}:${WEB_PORT:-8080}` (littlelight.tesarsoft.com) and
    `storage` → `${STORAGE_BIND:-127.0.0.1}:${STORAGE_PORT:-9000}` (files.littlelight.tesarsoft.com, keep
    Host header, path `^/littlelight/.`); every dev port is env-driven too, with PUBLIC_URL, GoTrue URLs
    and S3_PUBLIC_ENDPOINT derived from them. Host exiftool install was approved but Homebrew needs the
    Xcode license (sudo); exiftool runs via Docker instead.
  - Gate pacing: the gate uploads at 3 photos/s (`GATE_UPLOAD_RATE`, ~1.8× the PRD's 500-in-5-min
    target). A 55/s burst gave p95 37 s at `INGEST_CONCURRENCY=2`; queue wait, not per-photo time.
  - Oversize/unsupported files are rejected client-side and counted as failed; the API keeps strict limits.
  - Failed ingests stay as `status='failed'` rows hidden from album views and excluded from the free cap.
  - Pending contributor uploads count toward the free-tier cap; rejected ones go to trash.
  - No reverse geocoding (only "Home"); city/park labels need a decision on which geocoder may receive GPS.
  - Prod env renames: storage root key → `S3_ROOT_USER`/`S3_ROOT_PASSWORD`; new `S3_API_*` and
    `S3_WORKER_*` pairs.
- **Open issues**:
  - Needs user: CSAM provider enrolment (PhotoDNA or NCMEC hash provider) + NCMEC report procedure;
    production `.env` additions above; configure the external tunnel per
    `docker/cloudflared/config.example.yml`.
  - For the final review: the API MinIO key can list object-version metadata (MinIO grants it with
    `s3:ListBucket`, needed for HeadBucket); `tz.ts` DST-gap comment vs behaviour east of UTC;
    `ingest.reconcile` re-sends without `tzHint` (pipeline can't read profiles.timezone); thumb p95 on
    small CI runners unverified until a real GitHub run.
  - Step 5: photo list sorts by `COALESCE(taken_at, created_at)` without a matching index; grid isn't
    virtualized (needs react-virtuoso); custom milestones need a create endpoint; seed demo photos have
    placeholder keys (10,000-photo seed should create real derivatives).
  - Disk is ~9 GB free; Docker build cache was pruned with the user's OK.
- **Commit**: step 4: upload and ingest

## Step 5: Timeline and viewer

- **Built**: Migration 12: stored `photos.sort_at` (COALESCE(taken_at, created_at)) with index
  `(baby_id, sort_at DESC, id DESC) WHERE deleted_at IS NULL` (keyset bound stays in Index Cond under
  RLS), IMMUTABLE `age_group()` mirroring shared `ageGroupKey`, photos SELECT policy rebuilt on
  set-returning `member_baby_ids()`/`admin_baby_ids()` (membership evaluated once per statement),
  milestones `updated_at` + 200-custom cap + preset-name guard, measurements same-baby guard, milestone
  same-baby guard on photo_details/upload_sessions, and 14 CHECKs on parent-entered text converted to
  `<table>_shape` triggers so violations never echo row data into the Postgres log. API: timeline list
  (older/newer keyset, milestone filter, caption/milestone per item), age-group summary with jump
  cursors, batch signed-URL refresh, photo detail with measurements/canEdit, details PATCH + batch
  details, milestones CRUD, measurements CRUD with server-side metric normalization, `photo.reindex`
  job sent after commit (worker handler is a no-op until step 7), clean 404 for missing originals.
  Worker: reindex queue; `pnpm perf:seed` (10,000 photos over 0–24 months on a free-plan, owner-less
  "Pixel" baby; 48 rendered base images copied per photo; refuses production/non-local; `--remove`).
  Web: react-virtuoso GroupedVirtuoso timeline with sticky age headers, scrubber, bidirectional
  loading, select mode + batch details, Swiper viewer (zoom/virtual/keyboard) via `?photo=`, details
  panel and optimistic edit form, Milestones tab (cards, upcoming presets, custom CRUD), Growth view
  (in-house SVG chart + table, no percentiles), MeasurementSheet (lb+oz), phone / tablet 2-pane /
  desktop 3-pane layouts, Cache-API offline cache of the last 50 opened photos. Shared: age groups and
  `formatAge` (365 days reads "12 months"), units, new DTOs. Tests: 771 unit, 668 integration
  (db 346, api 275, worker 47), 21 Playwright e2e incl. `e2e/timeline/edits.spec.ts`, perf spec
  `pnpm e2e:perf` (phone + desktop); CI seeds the perf baby and runs the perf spec with `PERF_CI=1`.
- **Gate**: orchestrator ran lint, typecheck (incl. e2e), unit (771), integration (668, none skipped)
  on fresh pgvector + MinIO, then from a clean copy: smoke passed, `pnpm e2e` 21/21 (edits persist:
  details, custom milestone, people, location, note, 7 lb 8 oz ↔ 3.40 kg, batch details, milestone
  rename/delete, contributor blocked), upload gate passed (thumb p95 387 ms), `pnpm perf:seed` then
  `pnpm e2e:perf` at local thresholds passed: phone jank 0.33 %, p95 frame 16.8 ms, 60 images, API
  p95 164 ms; desktop jank 4.61 %, p95 frame 16.8 ms, 147 images, API p95 217 ms (host load ~12–15).
- **Decisions**:
  - Keyset on a stored generated `sort_at` column (not an expression) because RLS blocks pushing
    non-leakproof expressions into the index; deep pages 273 ms → 1.4 ms, summary 279 ms → 6 ms.
  - The photos SELECT policy uses set-returning membership helpers that read `baby_members` (same
    source as `is_baby_member`/`is_baby_admin`), so the PRD rule "permissions read baby_members, never
    client claims" still holds.
  - Desktop jank fix: thumbs no longer hit the Cache API on mount (only on error / opened photos);
    rows and cells use paint containment.
  - Perf baby stays free with no owner so it can never reach a model; demo seed keeps placeholder keys.
  - Growth chart is in-house SVG; offline is a minimal cache (full PWA deferred to step 9).
  - Smoke script fixed for SIGPIPE under pipefail (`grep -q` on large logs).
- **Open issues**:
  - For the final review: `?photo=` deep link after reload shows only that photo (needs an
    `around=<photoId>` list option); delete/approve/reject invalidate every loaded timeline page;
    viewer close doesn't restore grid scroll; `formatAge` reads one month ahead of the group header on
    ~12 single days; a `value_metric` overflow (unreachable via API bounds) maps to 500; two
    token-hash length CHECKs remain (hash, not parent text); recommend `log_error_verbosity = terse`
    on the production db; perf API p95 is sensitive to host load.
  - Docker holds ~1.1 GB of unused volumes from throwaway test containers; removing them needs the
    user's OK (`docker volume prune -f`).
  - Still open from earlier steps: production credentials (tunnel config, SMTP, B2, storage keys),
    Apple/Google IDs, Turnstile, legal text, CSAM provider.
- **Commit**: step 5: timeline and viewer

## Step 6: AI batch pipeline

- **Built**: Shared `aiDescriptionV1Schema` (zod) + strict JSON Schema for structured output, prompt/schema
  versions v1, AI job payloads (`ai.flush`, `ai.poll`, `ai.backfill`), `applyAiOverrides`, coordinate
  tripwire for model context. `packages/ai`: OpenAI Batch adapter (plain fetch: Files upload, batch
  create/poll/stream, `/v1/responses` with `reasoning.effort: "none"`, strict `text.format`, base64 768 px
  analysis copy, `store:false`, `prompt_cache_key`; deletes input/output/error files), Anthropic Message
  Batches adapter for `claude-haiku-5-5`, deterministic `fake` provider (refused in production), pinned
  price table + cost math, prompt v1, validation, mock HTTP servers, embedder (no caller yet), bake-off
  skeleton. Every adapter refuses non-paid requests, >768 px / >400 KB images and coordinate-like
  context before any network call. Migration 13: `ai_batch_items` ledger (RLS), `ai_batches` provider
  file/version columns, `photos.ai_retry_requested_at`, `ai_eligible_photos()`, `ai_baby_month_cost_usd()`,
  `record_ai_budget_exceeded()` (insert-if-absent), insert-time guard so items exist only for paid,
  approved, live photos, override shape trigger. `pnpm db:plan <babyId> plus|free` (superuser,
  audited) until billing exists. Worker: flush (claim → budget $3/baby/month, alert 80 % → re-check →
  submit), poll (validate → `photo_ai` → sensitive triggers → cost → delete provider files →
  `photo.reindex`), retry once then failed (AI failure never sets `photos.status='failed'`), upgrade and
  version backfill, AI queue-age heartbeat alert (> 2 h). API: `ai` block on photo detail (raw admin-only),
  `aiStatus` on lists, override PATCH/clear, retry, monthly usage. Web: analyzing/pending/failed states,
  AI panel with tags + milestone suggestions ("Tag it?" pre-fills, nothing auto-saved), sensitive badge,
  admin override form, usage line, Plus upsell. Provider keys reach the worker only.
  Tests: 1,214 unit, 796 integration (db 416, api 319, worker 61), 26 Playwright e2e,
  `pnpm e2e:ai-gate` (fake + real modes); CI runs the fake AI gate and an AI hygiene step.
- **Gate**: orchestrator ran lint, typecheck (incl. e2e), AI hygiene greps, unit (1,214), integration
  (796, none skipped) on fresh pgvector + MinIO; from a clean copy: smoke passed, `pnpm e2e` 26/26, upload
  gate passed, AI gate (fake) PASSED: 50/50 ready, 50/50 schema-valid in API and DB, 1 completed batch,
  `cost_usd` $0.006925 = items sum, provider files deleted, 50 reindex jobs, free baby 0 items / 0 photo_ai,
  request dump 50 paid ids / 0 free ids / 0 GPS, no log leaks. Perf spec: phone passed every run; desktop
  passed 2 of 3 runs (one at 5.25 % jank / p95 33.3 ms, one API p95 305 ms under load).
- **Decisions**:
  - **User decision (2026-10-08):** skip the real-key gate run; the fake-provider gate counts for step 6
    and real-model validation happens in the pre-launch bake-off. No `.env.local` key exists.
  - No provider SDKs (plain fetch with configurable base URLs). AI failures never mark photos failed.
    FR-5.5 real-time priority path deferred (`describeOne` exists, not wired). Near-duplicates are
    described; no local screenshot heuristic yet. Budget hard stop $3/baby/month, alert at 80 %.
  - Budget-exceeded audit is written once per baby/month via a DB helper (pipeline has no audit SELECT).
  - Forced flush never re-claims a photo it released in the same call (byte-cap deferrals excepted);
    one artifact-delete attempt per poll; unsupported prompt version disables flush without spending
    attempts.
  - Viewer edit forms reset only when the photo id changes (fixed forms closing on background refresh).
- **Open issues**:
  - Real-model quality unmeasured (fake provider only): GPT-6 Luna wire details flagged unverified in the
    plan (`store:false` in Batch, usage field names, image-token reporting, cache minimum) surface as a
    failed batch with the provider's code on first real use.
  - Desktop perf margin is thin (jank 3.4–5.3 %, occasional p95 33 ms); API p95 load-sensitive.
  - For the final review: API's AI "failed" threshold uses the constant 2 while the worker reads
    `AI_MAX_ATTEMPTS`; screenshots aren't skipped before batching (PRD cost control); seeded demo photos
    have no analysis copies (never described); `ai.backfill {reason:'version'}` can't narrow to a source
    version.
  - Step 7: chat/search run in the API, so `OPENAI_API_KEY` must be re-added to the api service then.
  - Still open: production credentials, Apple/Google IDs, Turnstile, legal text, CSAM provider; ~1.1 GB
    unused Docker volumes (`docker volume prune -f` with the user's OK).
- **Commit**: step 6: AI batch pipeline

## Step 7: Search and chat

- **Built**: Shared `buildSearchDocument` (no baby name, no coordinates, overrides win, versioned),
  search/chat DTOs, chat tool schemas, citation markers, SSE event format. Migration 14:
  `photo_search` content hash / embed model / doc version / place, read policy on
  `search_baby_ids()` (ARRAY form), guard so only paid, approved, live photos get rows, immediate
  cleanup on trash/quarantine/unapprove, stale marking, `search_stale_photos()`, SECURITY DEFINER
  full-text and tag/people candidate functions (GIN usable under RLS), `ai_spend` ledger folded into
  the monthly budget, one chat thread per user per baby, `chat_turns` ledger with atomic
  `chat_reserve_turn` (clearing history doesn't reset the 100/day limit). `packages/ai`: OpenAI chat
  adapter (Responses API, strict tools, streaming, `reasoning.effort: low`, `store:false`), fake
  embedder (hashed bag-of-words, 1024 dims), rule-based fake chat model, chat prompt v1 (sha pinned).
  Worker: search indexer on `photo.reindex` (batches of 25, hash-skip), `search.reconcile` hourly,
  `search.backfill` after upgrade, `pnpm search:seed` (2k–50k photos with 50 planted golden targets),
  `pnpm search:calibrate`. API: hybrid search (filters → vector/HNSW + full-text + tag/people → RRF k=60
  → relevance floor → top 12), facets, chat SSE with 4 permission-scoped tools, citation validation,
  measurement answers include the linked photo, comparison grids interleaved, age/date windows widened
  ±15 days (one ±45 retry), find-photos fast path when results are confident, thread history and
  clear, plan/budget/rate-limit errors. Web: Chat home tab (suggested prompts, streaming answer, photo
  grid → viewer, history, clear), desktop chat pane, search bar + filter chips, Plus upsell,
  contributor notice. nginx streams the chat endpoint unbuffered. Tests: 1,702 unit, 968 integration
  (db, api, worker), 36 Playwright e2e, `pnpm e2e:search-gate` (fake + real), smoke works with and
  without a provider; CI runs the fake search gate, compose key-placement and hygiene checks.
- **Gate**: orchestrator ran lint, typecheck (incl. e2e), hygiene, unit (1,702), integration (968)
  on fresh pgvector + MinIO; from a clean copy: `pnpm e2e` 36/36, upload gate passed, perf passed
  (phone jank 0.38 %, desktop 2.73 %, p95 frame 16.8 ms), AI gate (fake) passed, search gate (fake)
  passed (search 50/50, chat 50/50, citations 50/50, grounded 50/50, "zebra submarine" finds nothing);
  zero-setup smoke (no key) and fake-provider smoke both passed.
  **Real-model runs (user's key, ~$0.08 total across step 6/7 runs):** step-6 AI gate on gpt-6-luna
  Batch: 50/50 described and schema-valid, $0.005005 (≈ $0.0001/photo), reasoning tokens 0, provider
  files deleted, 0 free-tier items. Step-7 search gate (text-embedding-3-small + gpt-6-luna, 2,000
  photos), final runs: search hit@5 50/50, **chat hit@5 49/50 (98 %)**, citations 50/50 valid,
  chat ≈ $0.00009/turn, first token p50 ≈ 1.5 s / p95 2.3–4.0 s (varies by run), turn p95 2.3–4.4 s.
- **Decisions**:
  - **User decisions (2026-10-09):** the key now lives in git-ignored `.env.local`; a git-ignored
    project `.env` pins `VISION_PROVIDER=fake` so the dev stack never spends unless a real run is
    triggered (`VISION_PROVIDER=openai` on the command line, then restore). Weekly Fable limit hit:
    architect/security-engineer run on Opus until it resets; the final review waits for Fable.
    Find-photos fast path approved (template answer instead of the second model call).
  - Relevance floor: 0.30 for text-embedding-3-small (real calibration: noise p95 0.299 / max 0.364,
    paraphrase p50 0.315; 0.38 would drop 14/16 meaning-only matches), 0.60 for the fake. The fast path
    only fires on confident results (word match, filter-only, 0 results, or similarity ≥ 0.38);
    otherwise the model writes the answer and can say nothing matched.
  - No baby name in embedded text; free tier has no search bar or chat; one thread per user per baby;
    marker citations validated server-side; re-rank off; Anthropic chat adapter deferred; turn ledger
    separate from messages; candidate functions instead of LEAKPROOF catalog changes.
- **Open issues**:
  - Real-model: the search bar still shows weak results for the noisiest nonsense queries
    ("zebra submarine" scores 0.364 > 0.30 floor; chat correctly says nothing matched); first-token p95
    can exceed 2 s (2.3–4.0 s in real runs); one golden miss ("the puddle at 12 months") — diagnose with
    the new `chat tool search_photos` fields (`textCandidates`, `retryLexical`) on the next real run
    (capture `docker compose logs -f api` during the run; the gate recreates the api container).
    Paraphrase recall is only partially measured (11/20 in vector top 5).
  - 50k-photo search p95: text+facet class ~224 ms (max 281) vs the 300 ms target — thin margin.
  - For the final review: trashed babies keep `photo_search` rows until purge (unreachable via
    `search_baby_ids()` — confirm); `chat_turns` is deny-all by design; `log_error_verbosity = terse`
    in production still recommended; search text travels in the GET query string (nginx drops query
    strings from logs); the fake chat has no "Anthropic" path; CI hasn't run on GitHub yet.
  - Still open: production credentials, Apple/Google IDs, Turnstile, legal text, CSAM provider,
    ~1.1 GB unused Docker volumes.
- **Commit**: step 7: search and chat

## Step 8: Sharing

- **Built**: Design system adopted (`docs/DESIGN.md`) and every existing screen restyled to it
  (tokens on `:root` with dark variants, coral accent with dark text on fills and #B14128 for accent
  text so AA holds, Ionic CSS layered under the theme, 44 px targets, filled secondary buttons);
  `apps/mobile-web/scripts/screenshots.ts` + `screenshots-share.ts` capture light/dark × phone/desktop.
  Migration 15 (`sharing-v1`): share links stored as SHA-256 of a 128-bit token, passcode hashes
  (scrypt), 24 h default / 30-day max expiry, 20 links per baby, `share_rules` (only-added / all /
  milestones / tags with include/exclude), `shared_photos` gate trigger (approved, live, not
  quarantined; rule rows only for analysed, non-sensitive photos; takes `FOR SHARE` on the photo),
  `shared_photo_exclusions` so rules never re-add a removed photo, viewer RLS through
  `viewer_photo_ids()`, `viewer_session_check()` on every viewer request, passcode failure ledger
  (5 per IP+token per 15 min, 20 per link per hour then locked until regenerate), session-ending
  triggers on revoke/regenerate/delete/passcode change/trash. Worker: auto-sharer on `photo.reindex`
  (runs before indexing, failure never blocks it), `share.apply` per link and hourly
  `share.reconcile` with a DB-clock watermark (12 queues, 7 schedules); a refused row (race with a
  sensitive flag) is skipped per row in a savepoint, never aborting the batch. API
  (`apps/api/src/sharing/**`): admin routes (create/list/patch/renew/regenerate/revoke/delete, rule
  PUT/DELETE Plus-only, add/remove photos, show a sensitive photo to family, per-photo links);
  viewer token exchange → `ll_viewer` cookie (`Path=/api/share`, HttpOnly, SameSite=Lax, separate
  `littlelight-viewer` JWT audience) or native bearer, album/photos/urls/download/manifest with exact
  payload keys, 5-minute `Cache-Control: private` media URLs, display-copy downloads (60 s, ASCII
  file name). Web: Family screen share-link cards (status, counts, views, passcode lock notice),
  create/settings sheets, URL shown once, manage photos, viewer at `/s/:token` (passcode, album by
  age, hidden tiles, photo view, expired page, install manifest, no-referrer). nginx `/s/`:
  no-referrer, no-store, noindex. CI: sharing hygiene script, required sharing suites, share gate and
  log scan in the dev-stack job. Tests: 1,839 unit, 1,086 integration, 42 Playwright e2e,
  `pnpm e2e:share-gate` (49 checks), smoke step 5g.
- **Gate**: orchestrator ran lint, typecheck, sharing hygiene, unit (1,839; 3 runs clean after an
  `App.test.tsx` Ionic lazy-load teardown race was fixed), integration 1,086/1,086 with MinIO (no
  skips), `pnpm e2e` 42/42, share gate 49/49 (expired, revoked and regenerated links give 410 and the
  expired page; 0 rule rows on sensitive or unanalysed photos, including a held-lock race; viewer
  media has no GPS/EXIF; old media URL 403 after revoke + TTL; passcode lockout; no token, passcode,
  signature or GPS in logs), smoke passed twice, upload gate, AI gate (fake) and search gate (fake)
  passed, perf passed (phone jank 0.09 %, desktop 2.82 %, p95 frame 16.8 ms, API p95 139/189 ms).
  Run on the live dev stack, not a clean copy; CI's dev-stack job does the cold build. Screenshots
  of all screens and the new sharing screens reviewed in light/dark × phone/desktop.
  **Acceptance ("expired or revoked link returns the expired page; sensitive photos never
  auto-share"): passed.**
- **Decisions**:
  - **User decisions (2026-10-09):** adopt `docs/DESIGN.md` and restyle now; share URL shown once
    (hash only stored); 30-day max expiry (24 h / 3 d / 7 d / 30 d); auto-share rules Plus-only;
    viewer downloads are the 1600 px display copy, never originals.
  - A baby that leaves Plus: its rules stop adding photos but still remove ones that stop matching.
    Photos must be ingested before a rule can add them. Deleting a rule keeps what it added.
  - Trashed album: links can be revoked/deleted/trimmed but not created, renewed or extended.
  - One viewer session per browser; native clients re-run the exchange after a renew (step-9 seam).
  - A non-`scrypt$1$` passcode hash never verifies (link stays closed).
- **Open issues**:
  - First perf run after reseeding failed on API p95 (384/442 ms) until `ANALYZE`; after it,
    139/189 ms. The perf seed should analyse its tables.
  - The AI gate can pick up a stray pending photo from other test babies on a shared dev DB (one
    run billed 51 instead of 50); passes on rerun. The gate could scope its flush to its own baby.
  - `index.html` has no static `<meta name="referrer" content="no-referrer">` (added at runtime on
    `/s/`; nginx header covers production).
  - The walkthrough's chat 401 check needs a body (validation runs before auth on that route).
  - Seeded demo photos still have no stored images (matters for the step-9 store demo account).
  - Carried: Cloudflare "Bypass cache" rule for `files.`, production credentials, Apple/Google IDs,
    Turnstile, legal text, CSAM provider, ~1.1 GB unused Docker volumes; final combined review.
- **Commit**: step 8: sharing

## Step 9 (part A): native apps without store accounts

- **Built**: Capacitor 8 iOS (SPM) and Android projects, bundle id `com.tesarsoft.littlelight`,
  iPhone only, portrait. Permission strings, `PrivacyInfo.xcprivacy` (no tracking; precise location
  from photo metadata), entitlements (`applinks:`, `aps-environment`), Android manifest without
  media/storage/location permissions, no backup, cleartext only to localhost in debug, App Links and
  AASA/assetlinks files with placeholder team id and fingerprints, debug-only `littlelight://` scheme.
  In-house `LittlelightUploader` plugin (iOS background `URLSession`, Android WorkManager `dataSync`
  foreground worker): raw-body PUT to presigned MinIO URLs, no extra headers, no URL logging,
  survives backgrounding and app kill (capgo uploader evaluated and dropped). App layer
  (`src/platform/native/**`): API origin via `VITE_API_URL`, tokens only in Keychain/Keystore
  (wiped on first launch after install), session refresh on resume, deep links (invite, share,
  `/signin/native`), photo picker keeping HEIC originals, camera, native share/download sheets, push
  opt-in. UI: OTP-only welcome, native upload screen, push primer after first upload, Settings →
  Notifications (two toggles), share viewer "Done", purchase prompts hidden on native. API: native
  CORS allow-list (no credentials, native header required), `POST/DELETE /me/push-devices`,
  notify prefs on `/me`, `enqueuePush`; static-code store-review sign-in (off unless both env vars
  set; refused for any account in a real family; audited; throttled). Migration 16 (`push_devices`,
  `push_deliveries`, notify prefs, DB-side recipient rules: admins only, live sessions within 90
  days, prefs on, Plus for photos), migration 17 (paid-tier tripwire allows detaching `photo_ai`
  from a deleted batch). Worker: `push.notify` queue (13 queues) with APNs (HTTP/2, ES256 JWT) and FCM
  v1 senders, fake sender in dev, debounce + 60-min per-user gap, generic text only;
  `photos_analyzed` hook on reindex; `share_viewed` on new viewer sessions. Demo media: 12 Maya + 24
  review illustrations drawn in code (SVG → JPEG, no metadata, ~98 KB of TS, no image files), dev
  auto-run, `demo:media --review-baby`. Icons/splash (coral mark), fastlane metadata drafts, App
  Store privacy label, Play Data Safety, age rating, review notes (placeholders) under
  `apps/mobile-web/{fastlane,store}`. `NATIVE.md` runbook incl. pitfalls. CI: native hygiene, Android
  debug build + lint + manifest check, manual iOS sim build, push gate with log tap/secret scan.
  Tests: 2,539 unit, 1,254 integration, 42 web e2e (now self-resetting), push gate, iOS gate, Android
  gate (written).
- **Gate**: orchestrator ran lint, typecheck, share/native/ai hygiene, unit 2,539/2,539, integration
  1,253/1,254 on the used dev DB (the one failure was a dev-state token assertion, since made
  robust; full suite 1,254/1,254 on fresh pgvector + MinIO, CI-style, by test-engineer), push gate
  23/23, share gate passed, smoke passed, Android `assembleDebug` + `lintDebug` + manifest check
  passed (JDK 21), production worker image contains `dist/demo-media.js`, **iOS simulator gate
  45/45** (iPhone 17, iOS 26.4: install, deep links, OTP sign-in, relaunch persistence,
  uninstall→reinstall signed out, share viewer + Done, push permission, device registration,
  `simctl push`, banner tap → Chat, sign-out removes device, log scan). Web e2e 42/42 after the
  order-independence fix (test-engineer ran push gate → share gate → e2e ×2 → smoke back to back).
  **Not run: Android runtime gate.** The emulator (36.1.9) crashes on this macOS 27 host, inside and
  outside the sandbox. **PRD check ("TestFlight and Play internal builds install; invite and share
  links open the app"): pending user credentials (part B).**
- **Decisions**:
  - **User decisions (2026-10-09):** split step 9 into part A (now) and part B (store accounts);
    bundle id `com.tesarsoft.littlelight`; no purchase prompts in the native apps (billing is a
    later step); static-code review account; free disk then install tools; deleted iOS 26.0/26.1
    simulator runtimes (kept 26.4.1; iOS 27 runtime not installed); commit without the Android
    runtime check.
  - In-house uploader instead of `@capgo/capacitor-uploader` (extra headers, no privacy manifest,
    lost events after app kill, per-upload notifications). Simulator builds are ad-hoc signed
    (background URLSession requires it).
  - Push ledger keeps rows when a device is removed (`ON DELETE SET NULL`), so the gap is per user.
  - Review originals live under `babies/<baby>/originals/` so purge and account deletion cover them;
    the review account cannot accept invites while review is enabled.
  - iPad: not supported in v1. Android uploads carry no GPS (Photo Picker strips it).
- **Open issues**:
  - **Android runtime unverified:** background upload, deep links (incl. share-link reload fix),
    push-disabled launch. Run `pnpm e2e:native-android` on a newer emulator or a real phone
    (steps in `e2e/native/android-gate.ts`). Check whether `HttpURLConnection` adds a Content-Type.
  - **Part B (user):** Apple Developer team id + signing, APNs key, App Store Connect app/API key,
    Play Console app + signing fingerprints, Firebase `google-services.json` + FCM service account,
    production deploy of association files, review account mailbox + code, store listings, support
    URL, real privacy/terms text, decide whether to declare the push token as "Device ID".
  - Native social sign-in (Apple/Google) deferred; if Google is added on iOS, Sign in with Apple
    must ship too. Native upload resume after OS kill means re-picking (server dedupes by SHA-256).
  - `appUrlOpen` URLs received while running are not recorded for the once-per-session rule (a
    later full reload can route the last one once; no loop).
  - Gates with `AI_BATCH_FLUSH_MINUTES=0` analyse every ingested photo (worker flush is global); the
    gates now restore Maya's seed state afterwards.
  - For the final review: co-members can read each other's notify prefs (profiles SELECT grant);
    90-day session window hardcoded to GoTrue's inactivity timeout; strict review guard can lock the
    reviewer out if they create a second baby.
- **Commit**: step 9 (part A): native builds without store accounts

## Final review fixes (after step 9)

- **Review**: combined Fable review of steps 1–9 → **PASS, no must-fix**. Should-fix items and user
  decisions are in `docs/plans/review-fixes.md`.
- **Built**:
  - **Export (FR-10.1)**: migration 19 `data_exports` (FORCE RLS; admin-only insert; 3 per album per
    day and one in progress, enforced by a trigger and a unique index; no extending or rewinding).
    API `POST/GET /babies/:id/exports`, `POST …/:exportId/download-url` (requester only, fresh
    sign-in, 10-min signed URL, counted and audited), `DELETE`. Worker `data.export` (14 queues):
    streams originals plus `photos.csv/json`, `album.json`, `milestones.csv`, `measurements.csv` and
    `README.txt` through a zip64 archive and S3 multipart upload. Memory stays bounded (3 GiB
    synthetic: ~160 MB RSS). GPS is decrypted only when "Include photo locations" is on and the
    requester is still an admin. Spreadsheet formula injection is guarded. The email notice has no
    link. Purge removes expired, cancelled, stale and orphaned exports (all object versions). Web:
    Settings → Export your data (admins), with progress polling; native download streams to a file,
    then opens the share sheet.
  - **Sentry**: API, worker and web send errors only, and only when a DSN is set. Settings:
    `defaultIntegrations:false`, `tracesSampleRate:0`, no breadcrumbs, Sentry 11 `dataCollection` all
    off, shared `scrubTelemetryEvent` (145 tests). Web Sentry is lazy and web-origin only; native
    sends nothing. `@sentry/bundler-plugins` is dropped by a pnpm override and Sentry `.map` files are
    stripped from prod images. OpenTelemetry is deferred.
  - **Hardening (migration 18)**: FR-1.5 in RLS (an admin row can only be removed or demoted by its
    owner). `profiles` is self-only, plus a `member_profiles` view (name and relationship). A photo
    guard stops contributors changing `is_sensitive`/`approval`/`approved_by`; on approval
    `approved_by`/`approved_at` are pinned to the actor and `now()`.
  - **Smaller fixes**:
    - Account deletion marks the profile deleted only after GoTrue succeeds, and compensates on
      failure.
    - Downgraded admins can read and clear chat history.
    - The iOS Release Info.plist has no `littlelight://` scheme or local networking (Debug plist via
      xcconfig).
    - Store listings no longer mention Plus.
    - The viewer `takenAt` is date-only.
    - The API trusts only a loopback or private proxy hop.
    - nginx sends a Content-Security-Policy in Report-Only mode (Turnstile allowed) and adds a
      `CF-Connecting-IP` fallback.
    - A members list shows "Former member" for a profile mid-deletion.
  - **CI**: Sentry hygiene, web CSP header check, export gate with log tap and secret scan (coordinate,
    lat/lng and export-key patterns), three new required integration suites, iOS plist checks in the
    manual iOS job.
- **Gate**: orchestrator ran:
  - lint, typecheck, and share/native/ai/sentry hygiene
  - unit tests 2,975/2,975
  - integration 1,358/1,358 (46 files, 0 skipped)
  - `pnpm e2e:export-gate` 44/44, share gate 50/50, push gate 23/23
  - web e2e 42/42 and smoke
  - iOS simulator gate 55/55
  Test-engineer also ran integration on fresh pgvector + MinIO (1,358/1,358), and devops ran the
  CSP image checks and actionlint.
- **Decisions**:
  - **User decisions (2026-10-09/10):** build export now; wire Sentry, scrubbed; drop Plus from the
    store listings; the planner's defaults D1–D20 (locations included by default with a toggle,
    requester-only download, 7-day expiry, email notice without a link, CSP Report-Only first).
  - **Ops (user approved):** the disk filled during image builds and broke Docker Desktop. Cleared npm,
    Gradle and dev-tool caches and simulator data, deleted Docker's VM disk, and the stack rebuilt
    from scratch in one `docker compose up`.
  - Fastify 5 no longer takes `trustProxy: 1`, so a custom hop predicate is used. Sentry 11 replaced
    `sendDefaultPii` with `dataCollection`. The contributor guard raises 42501 (403), not 23514.
- **Open issues**:
  - Sentry is off until the user supplies `SENTRY_DSN`, `SENTRY_WEB_DSN` and
    `WEB_CSP_CONNECT_EXTRA`.
  - CSP should be switched to enforcing after a production observation period (`WEB_CSP_HEADER`).
  - The native export download uses `Filesystem.downloadFile` (deprecated in favour of
    `@capacitor/file-transfer`) and is untested on a device.
  - Demo seed `photos.sha256` values are placeholders (dev only).
  - One transient `run-job ai.poll` hang was seen once in a gate run and not reproduced.
  - The GoTrue audit log keeps deleted users' emails (retention note only).
  - Still open from step 9: Android runtime gate, part B store work, real GitHub CI run.
- **Commit**: review fixes: export, Sentry, RLS hardening

## Step 10: Photo import (Apple Photos album sync + Google Photos Picker)

- **Request (user, 2026-10-09)**: "automatically import photos with metadata from a google photos or
  apple photos album". Platform limits: no server can watch either service's albums (Google removed
  the Library API read scopes in 2025; there is no iCloud shared-album API).
- **Built**:
  - **Apple album sync (iPhone only).** In-house `LittlelightPhotoSync` plugin (PhotoKit):
    - lists user albums
    - exports the original resource (HEIC kept, EXIF + GPS intact) with a native SHA-256
    - keeps an on-device ledger (asset ids never leave the phone; excluded from backup)
    - exports into `Caches/ll-sync-export`
    - uploads over a Wi-Fi-only background session
    - runs on launch, resume, "Sync now" and best-effort `BGAppRefreshTask`

    JS side:
    - `PhotoSyncManager` feeds the `UploadManager` on a low-priority sync lane (2 slots, user
      uploads first). It syncs newest first, 50 photos per foreground batch and 25 per background
      wake. It pauses in Low Power Mode, under thermal pressure and on cellular (Wi-Fi only by
      default), stops at the free-tier cap, and never deletes from Littlelight.
    - UI: Upload → "Album sync" card → "Set up", and Settings → "Photo import". Parents only.
    - Full Photos permission is requested only from setup.
    - Demotion turns sync off; sign-out wipes the ledger.
  - **Google Photos import (web, Android, iPhone).**
    - Server-side OAuth (one web client, HMAC state JWT, picker scope only). The refresh token is
      stored pgcrypto-encrypted, readable only through `service_role` or a SECURITY DEFINER worker
      function. Access tokens live in memory only.
    - Picker sessions are created and polled by the API. The worker job `import.google` lists and
      downloads originals through a host allow-list (https only, no IPs, same-host redirects, at
      most 2), with a size cap, staging, sha256 and mime sniffing. It books each photo through
      `import_book_photo()`: an admin's photo is approved by them, a contributor's goes to pending;
      duplicates and the free cap are handled. Videos are skipped.
    - `import.sweep` re-sends stuck batches, expires abandoned pickers, fails orphaned batches and
      cleans up staging.
    - Disconnect and account deletion revoke at Google.
    - UI: a "Google Photos" card on Upload and in Settings, an import sheet with progress and
      results, a `/import/google/connected` return page, and a line on the deletion screen.
    - A fake Google server (`google-fake`, host port `${GOOGLE_FAKE_PORT:-18099}`) is used in dev
      and CI and refused in production.
  - **Migration 20** (`import_sources`, `google_accounts`, `import_batches`, `import_items`; FORCE RLS,
    rate limits, transition rules). 16 queues.
  - **Store copy and privacy:**
    - Review notes and privacy/Data Safety drafts updated, and `NATIVE.md` updated.
    - Store descriptions mention importing from Apple Photos albums and Google Photos.
    - A leftover "(LITTLELIGHT PLUS)" heading was removed.
  - **Other:**
    - The email logs no longer include `messageId`.
    - Counts are formatted with thousands separators ("1,240").
    - CI: import hygiene (worker never reads `google_accounts` or inserts `photos`, URL guard before
      every fetch, fake refused in production, AI-path drift vs `b3f2b56`), Google token, media-URL
      and picker patterns in the log scan, Google canaries in the compose-keys check, the import gate
      in the dev-stack job, and 3 new required suites.
- **Gate**: orchestrator ran:
  - lint, typecheck, and share/native/ai/sentry/import hygiene;
  - unit tests: 3,562/3,562;
  - integration: 1,534/1,534 (49 files, 0 skipped);
  - `pnpm e2e:import-gate` 42/42, share gate 50/50, push gate 23/23, web e2e 42/42, smoke;
  - export gate: 37/40 on the first run (Maya's export hit `storage_error` right after the
    integration suite had run against the dev DB), then 44/44 on rerun;
  - iOS gate 55/55;
  - iOS album-sync gate 41/41, after test-engineer made the sign-in keyboard-focus step robust (it
    first failed at sign-in on a freshly erased simulator; then passed twice, including straight
    after the iOS gate).

  Test-engineer ran integration on fresh pgvector and MinIO (1,534/1,534) and the import gate three
  times; devops ran actionlint and the negative tests.
- **Decisions**:
  - **User (2026-10-09/10):**
    - build both import paths, as step 10, after the review fixes;
    - full Photos permission only when sync is turned on;
    - Apple sync for parents only; Google import for parents and helpers (helpers' photos pending);
    - available on Free within the photo cap;
    - Wi-Fi only by default;
    - planner defaults D2–D20: never delete from Littlelight; no Android auto-sync; one web OAuth
      client; Google strips GPS and the UI says so; a fake Picker in dev and CI.
  - Encryption functions are `service_role` only. A demotion deletes the user's Apple sync rows.
    Abandoned pickers auto-expire.
  - `feature_unavailable` is 404. The contributor Apple upsert returns `forbidden`. The deletion
    preview gains `googlePhotosConnected`.
- **Open issues**:
  - **Real Google use (user):**
    - a Google Cloud project with the Photos Picker API;
    - an OAuth consent screen with the `photospicker.mediaitems.readonly` scope, test users (7-day
      tokens in Testing), then Google verification;
    - a Web application client with redirect
      `https://littlelight.tesarsoft.com/api/import/google/callback`;
    - production `.env`: `GOOGLE_IMPORT_PROVIDER=live`, `GOOGLE_IMPORT_CLIENT_ID`,
      `GOOGLE_IMPORT_CLIENT_SECRET`;
    - a Google test account for the store review notes.

    The first real run must confirm Google's download semantics (HEIC kept, capture date kept, GPS
    stripped).
  - **Real-device checks:** `BGAppRefresh` (LLDB `_simulateLaunchForTaskWithIdentifier`), Wi-Fi-only
    on cellular, iCloud-only originals, and the limited-access flow. The native export download
    (`Filesystem.downloadFile`) is also untested on a device.
  - **Flaky:**
    - the export gate right after the integration suite runs on the dev DB (seen twice, passes on
      rerun);
    - one unexplained iOS-gate run (48/51) right after the focus fix, which did not recur.
  - Apple sync device label is a generic "iPhone"; Android has no album sync in v1.
  - `syncFlag.ts` localStorage marker (`ll.sync.on` = "1") is allow-listed and needs a review sign-off.
  - Port 8099 on this Mac is used by an unrelated process, so the fake is published on 18099.
  - Still open from earlier: Android runtime gate, part B store work, Sentry DSNs, CSP enforcing, a
    real GitHub CI run.
- **Commit**: step 10: photo import

## Step 10 review fixes

- **Review**: step-10 review (diff `b3f2b56..8298884`) → **PASS, no must-fix**; 5 should-fix, 4 nice-to-have.
- **Fixed**:
  - **OAuth `state` is single-use.** An in-memory consumed-`jti` register is checked before the code
    exchange. States minted before an API restart are refused. A replay, even with another Google
    account, is answered `expired` and the connection is left unchanged.
  - **Per-user Google access-token cache** (in memory, cleared 60 s before expiry, single-flight).
    On a 401 the token is evicted and the call retried once. Disconnect, reconnect and
    `invalid_grant` evict the token. Polls no longer decrypt or refresh each time; 11 polls caused
    1 token call.
  - **Opaque upload `clientId`** (all lanes), so no file name reaches the server.
  - **Sign-out wipes the sync ledger and config before the best-effort PATCH.**
  - **Store and docs:** the privacy label no longer claims a Google account id is stored, and
    `NATIVE.md` no longer mentions a deep link for the Google return.
  - **Telemetry scrub** now covers `ll-sync-export/`, `ll-sync/` and `ll-share/` paths.
- **Gate**: orchestrator ran lint, typecheck, all 5 hygiene checks, unit tests (3,591), the import
  gate (42/42) and web e2e (42/42). Test-engineer ran integration CI-style on fresh pgvector and
  MinIO: 1,540/1,540.
- **Not fixed (nice-to-have, recorded)**:
  - A cancel while `queued` leaves the Google picker session to expire at Google.
  - A requester can set `picking → expired` early (harmless).
  - The worker keeps its own per-job token mint.
- **Commit**: step 10: review fixes
