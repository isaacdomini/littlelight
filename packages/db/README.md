# @littlelight/db

Database bootstrap, migrations, seed and generated row types for Littlelight. Owned by
`security-engineer` (`CLAUDE.md` file ownership). Runs as the one-shot `db-init` and `migrate`
Compose services (docs/plans/step-2.md).

## What runs, in order

```
db ─► db-init (pnpm db:bootstrap) ─► auth (GoTrue migrates auth.*, then /health)
                                         └─► migrate (pnpm db:migrate [&& pnpm db:seed]) ─► api, worker
```

1. **Bootstrap** (`src/bootstrap.ts`, idempotent script, not a migration): Postgres roles, the
   GoTrue `auth` schema and the pg-boss `pgboss` schema (see "Roles"). Passwords come from
   `AUTH_DB_PASSWORD`, `API_DB_PASSWORD`, `WORKER_DB_PASSWORD` and reach Postgres only as bind
   parameters (`set_config` → `DO` block), so they never appear in statement text or logs; the
   `DO` block re-raises any failure from an `EXCEPTION` handler (message + SQLSTATE, passwords
   masked) so a failing `CREATE/ALTER ROLE … PASSWORD` cannot reach the server log as error
   CONTEXT either. Re-run on every `db:migrate`; a second run changes nothing.
2. **GoTrue migrations** run when the `auth` container starts: `auth.users` must exist before our
   migrations because `profiles.user_id` references it. The first step-2 migration fails with
   `auth.users is missing: start the auth (GoTrue) service before running migrations` otherwise.
3. **Migrations** (`migrations/*.sql`, node-pg-migrate, tracked in `public.pgmigrations`): plain
   SQL with `-- Up Migration` / `-- Down Migration` markers, one transaction per run. Every
   migration has a working down; every RLS policy change needs a test.
4. **Seed** (`src/seed.ts`): the demo family, dev only (`SEED_DEMO_FAMILY=true` and
   `NODE_ENV !== production`), idempotent.

## Roles

| Role | Login | Purpose |
| --- | --- | --- |
| `postgres` | superuser | `db-init`, `migrate`, seed, backups. Never the api/worker. |
| `supabase_auth_admin` | yes | GoTrue only; owns `auth.*`. |
| `littlelight_api` | yes, NOINHERIT | API connection role. Has **no** privileges on app tables: every unit of work must `SET LOCAL ROLE authenticated \| viewer \| service_role`; a query outside that fails with `permission denied`. |
| `littlelight_worker` | yes, NOINHERIT | Worker connection role. Owns `pgboss`; `worker_heartbeats` directly; `SET LOCAL ROLE pipeline` for app tables. |
| `authenticated` | no | Signed-in user. Policies read `request.jwt.claims` through `auth_uid()` / `auth_email()` and membership through `is_baby_member()` / `is_baby_admin()` (SECURITY DEFINER, read `baby_members`, never trust claims beyond `sub`). |
| `viewer` | no | Share-link viewer. Can read only: `shared_photos` of its link, the allow-listed columns of `photos`, `photo_derivatives` (thumb/display), `photo_details` (milestone only), `babies` (id, name, nickname, birth_date), `milestones`, `share_links` (own, no hashes). Nothing else, no writes, and nothing once the link is expired/revoked or the baby is deleted. |
| `pipeline` | no | Worker job role: cross-baby, but only photo-pipeline tables/columns (`photos` status/metadata/`quarantined_at`, `photo_exif` incl. encrypted GPS, `photo_derivatives`, `photo_ai`, `photo_search`, `ai_batches`, `upload_files` state, read-only `profiles`/`babies`/`milestones`/`share_rules`, liveness columns of `upload_sessions`). Never invites, tokens, chat, members, viewer sessions, batch-upload notes. Hard-deletes only rows trashed > 30 days (never quarantined ones) and `status = 'duplicate'` markers. |
| `service_role` | no, **BYPASSRLS** | API-internal, no user context: share-token exchange, viewer sessions, invite redemption, billing, account deletion, audit writes. Reachable from `littlelight_api` only, never from the worker. `audit_log` is append-only even for this role. |
| `anon` | no | No grants (exists only because GoTrue mints the claim). |

Only `postgres` can read `pgmigrations` or `auth.*` (see "Session functions" for the one, narrow
door into `auth.sessions`). Every table in `public` has
`ENABLE` + `FORCE ROW LEVEL SECURITY`; policies are written `TO <role>` and named
`<table>_<role>_<verb>`. Column-level grants mean `SELECT *` fails for `viewer`/`pipeline` on
restricted tables and for `authenticated` on `babies` (no `home_*_enc`), `invites`, `photo_exif`
(no `gps_*_enc`, no `raw_json`) and `share_links`: **always name columns in API code**.

## Per-transaction identity

The API verifies the GoTrue JWT with `JWT_SECRET` and runs every request-scoped unit of work on
one pooled client, **inside one transaction**:

```sql
BEGIN;
SET LOCAL ROLE authenticated;                       -- or viewer / service_role; worker: pipeline
SELECT set_config('request.jwt.claims', $1, true);  -- $1 = JSON string, bind parameter
-- ... queries ...
COMMIT;                                             -- SET LOCAL and the setting vanish
```

Rules for the step-3 claims wrapper (and the worker's job wrapper):
- `BEGIN … COMMIT/ROLLBACK` around every unit of work; `SET LOCAL ROLE`, never plain `SET ROLE`
  (a session-level `SET ROLE` survives the transaction and leaks the role, and the claims, to the
  next request that gets the same pooled connection).
- On the pool's release path run `RESET ROLE` and `DISCARD ALL` (outside any transaction) before
  the client goes back to the pool, so a thrown error or a forgotten `COMMIT` can never hand a
  role or `request.jwt.claims` to another request. Treat a client that fails `DISCARD ALL` as
  broken: destroy it, do not return it.
- Never run a query outside the wrapper: `littlelight_api` has no privileges of its own, so such a
  query fails with `permission denied` rather than returning data.

Claims are always a bind parameter (never interpolated, never logged). Shapes
(`@littlelight/shared` `jwt-claims.ts`): authenticated `{"sub","role":"authenticated","email",...}`,
viewer `{"role":"viewer","share_link_id","exp"}`. SQL reads only `sub`, `role`, `email`,
`share_link_id`.

Notes for API/worker code:
- `INSERT INTO babies ... RETURNING` works: the creator sees the row while it has no members and
  the `babies_add_creator_admin` trigger then adds them as admin.
- Invite redemption runs under `service_role` (users can never read `invites.token_hash`): look
  the invite up by `token_hash`, check it is live, then `INSERT INTO baby_members`. The invitee's
  own `INSERT INTO baby_members` is also allowed by policy while a live invite for their email and
  role exists. Either way **joining consumes the invite**: the `baby_members_consume_invite`
  trigger marks every live invite for that baby and that user's `auth.users` email as accepted
  (`accepted_at`, `accepted_by`), so a removed member cannot rejoin on the invite they already
  used and a directly-added member's pending invite dies with the add. A self-join under
  `SET LOCAL ROLE authenticated` that consumes nothing (the invite was revoked or accepted
  concurrently) fails with `check_violation`; `service_role` inserts are never second-guessed, so
  the API may mark the invite itself first if it prefers.
- Share-token exchange runs under `service_role` (`share_links.token_hash` / `passcode_hash` are
  unreadable to every user role); the API then mints a viewer JWT and uses `SET LOCAL ROLE viewer`.
- Account deletion: delete the GoTrue user (cascades `profiles` → `baby_members`, `chat_*`,
  `auth.sessions`; sets `uploaded_by`/`created_by`/`edited_by` to NULL so photos survive for the
  remaining admin). The `baby_members_keep_last_admin` trigger blocks it while the user is the
  last admin of a live baby: soft-delete the baby (`babies.deleted_at`) or promote a co-admin first.
- **The plan follows the paying admin** (`babies.plan_owner_user_id`; step-3 D5). Two triggers
  make every path agree: `baby_members_release_plan` (AFTER DELETE OR UPDATE OF `role` on
  `baby_members`) clears `plan_owner_user_id` when the owner leaves, is removed, or steps down
  from admin to contributor (only an admin can own a plan), and `babies_plan_follows_owner`
  (BEFORE UPDATE OF `plan_owner_user_id`) turns a `plus` plan into `free` with
  `entitlement_expires_at = NULL` whenever the owner goes from set to NULL, including the FK
  `ON DELETE SET NULL` from a hard-deleted user and a billing update under `service_role`. A
  `plus` plan that never had an owner (seed, manual grant) is left alone, as is a change of
  owner (mom → dad). Consequence: `baby_ai_enabled()` turns false at once (AI queue, `photo_ai`,
  search and chat stop; `photos_status_guard` and the `photo_ai` tripwire keep the photos away
  from any model); photos already above the 1,000 free cap stay but no new ones can be added until
  a remaining admin upgrades.
- Co-admin removal requests (FR-1.5, step-3 D4): `baby_members.removal_requested_by` /
  `removal_requested_at` are written under `service_role` only (`authenticated` keeps its
  column-level `UPDATE (role)` grant, so a member can neither forge nor clear a request; every
  member can read them). `removal_requested_at` is the source of truth (`NULL` = no open request;
  the API ignores requests older than 7 days); `removal_requested_by` becomes NULL if the
  requesting admin's account is deleted while the request is open. The removal itself is a
  plain `DELETE FROM baby_members` once the target confirms, still subject to
  `baby_members_keep_last_admin`.
- Business rules enforced by triggers (all raise `check_violation`, SQLSTATE 23514): max two
  admins, last admin stays, 20 invites/baby/day, free-tier 1,000-photo cap, AI queue and
  `photo_ai` only for approved photos of a paid-tier baby, `shared_photos` only approved live
  photos of the link's baby and never sensitive ones by rule (a photo that later becomes sensitive
  loses its rule-added shares at once; hand-picked shares stay and viewers get `is_sensitive` so
  the grid can blur them), avatar must be an own approved photo, joining consumes the invite,
  `photo_exif.raw_json` can never carry a coordinate-looking key at any depth
  (`jsonb_has_gps_keys`: contains `gps`/`latitude`/`longitude`, word-start `geo`, or exactly
  `lat`/`lng`/`lon`; a trigger rather than a CHECK so the rejected row is never echoed into the
  server log as `DETAIL`), upload sessions hold at most 500 files and only their creator may add
  to them (`upload_files_session_owner`, see "Uploads and ingest").

## Session functions (`auth.sessions`)

GoTrue keeps one `auth.sessions` row per device sign-in and deletes it on sign-out, refresh-token
reuse and user deletion. The API uses that row as the liveness check behind every request (a
deleted session is a `401 session_revoked` within one request, not after the JWT's hour), for the
devices screen and for new-device alerts (PRD "Sessions and tokens"; step-3 D2). Four
SECURITY DEFINER functions, owned by the superuser that runs migrations, are the **only** access
path from an app role into `auth.*`: no table or schema grant on `auth` exists for
`authenticated`, `viewer`, `pipeline`, `service_role`, `littlelight_api` or `littlelight_worker`
(GoTrue also enables RLS with no policies on every `auth` table, so even a stray grant would
return nothing). Each function filters by `auth_uid()`, pins `search_path = pg_catalog, public`
(and schema-qualifies `auth.sessions`), is `REVOKE`d from PUBLIC and executable by
`authenticated` only; without authenticated claims they return nothing / 0 / false.

| Function | Returns | Use |
| --- | --- | --- |
| `auth_session_info(p_session_id uuid)` | `(created_at, refreshed_at timestamptz)` for that session **only if** it belongs to `auth_uid()` and its timebox (`not_after`) has not passed; else no row | First statement of every `withClaims` transaction with the JWT's `session_id`; no row ⇒ 401 `session_revoked`. `created_at` ≤ 10 min ago = fresh sign-in; `refreshed_at` is NULL until the first refresh (`coalesce(refreshed_at, created_at)` for "last active") |
| `list_user_sessions()` | `(id, created_at, updated_at, refreshed_at, user_agent)`, newest first, **no `ip`** | `GET /api/auth/sessions` (the API reduces `user_agent` to a label) |
| `delete_user_session(p_session_id uuid)` | `boolean` | `DELETE /api/auth/sessions/:id`; deletes only the caller's own row (GoTrue cascades `auth.refresh_tokens`, `auth.mfa_amr_claims`); false for a missing or someone else's session, indistinguishably |
| `count_user_sessions()` | `integer` | New-device detection at sign-in |

Coupling: the `auth.sessions` columns of `supabase/auth:v2.197.0` (`refreshed_at` is `timestamp
without time zone` in UTC and is converted to `timestamptz` inside the functions; `ip` is `inet`).
The migration refuses to run without `auth.sessions` (`start the auth (GoTrue) service before
running migrations`); the CI stub mirrors the real columns.

## Encryption of coordinates

`photo_exif.gps_lat_enc/gps_lng_enc` and `babies.home_lat_enc/home_lng_enc` are pgcrypto
ciphertext written by `encrypt_coord(double precision)` and read by `decrypt_coord(bytea)`.
Both are executable by `pipeline` and `service_role` **only**; `authenticated` cannot call either,
cannot read `home_*_enc`/`gps_*_enc` (admins get `place_label` / `home_label`) and cannot write
`home_*_enc`: the API stores a baby's home location under `service_role`. The key is
`DATA_ENCRYPTION_KEY` (≥ 32 chars), supplied per transaction as a bind parameter, and **only in
`service_role` and `pipeline` transactions** (never in a user-role transaction, where nothing can
use it and it would only widen the blast radius of a bug):

```sql
SELECT set_config('app.data_key', $1, true);
```

Both functions raise `data key not set for this transaction` otherwise. Never enable
`log_statement = all` or parameter logging on the production `db`. Key rotation is out of scope:
re-encrypt with `UPDATE … SET col = encrypt_coord(decrypt_coord(col))` under the old then new key.

The "Home" place label (FR-4.3, within `HOME_RADIUS_M` = 150 m) is computed **in SQL** so plaintext
coordinates never reach Node: `home_place_label(baby_id, lat, lng)` (haversine against the
decrypted `babies.home_*_enc`; returns `'Home'` or NULL, NULL when the baby has no home) and the
overload `home_place_label(baby_id, gps_lat_enc, gps_lng_enc)` for re-labelling stored rows later.
Both are SECURITY INVOKER, need `app.data_key`, and are executable by `pipeline` and `service_role`
only. The worker binds the photo's coordinates once and uses them in a single statement:

```sql
INSERT INTO photo_exif (photo_id, gps_lat_enc, gps_lng_enc, place_label, ...)
VALUES ($1, encrypt_coord($2), encrypt_coord($3), home_place_label($4, $2, $3), ...)
```

No branch of either function raises with a coordinate in the message (a wrong key surfaces as
pgcrypto's `Wrong key or corrupt data`).

## Uploads and ingest (step 4)

Migration `1791700000100_uploads-and-ingest.sql` (docs/plans/step-4.md 2.3). Photo bytes never
touch Postgres: the browser uploads straight to MinIO over presigned multipart URLs, the API
only books the upload here, and the worker (`pipeline`) ingests.

**Tables.** `upload_sessions` (one picker session: `baby_id`, `created_by`, batch details
`milestone_id`/`people`/`note`/`location_label`, `finished_at`, `expires_at` default +24 h) and
`upload_files` (one per registered file: `declared_bytes` ≤ 100 MiB, `client_sha256`/`client_mime`/
`taken_at_hint` as **hints only**, `storage_key` = the original's object key, `multipart_upload_id`,
`part_size`, `state`, `error`, `photo_id`, `duplicate_of_photo_id`). **`upload_files.id` is the
future `photos.id`**: the API mints it at registration, so the object key is known before the
`photos` row exists; a CHECK pins `photo_id` to `id`.

| `upload_files.state` | Set by | Meaning |
| --- | --- | --- |
| `registered` | API (insert) | multipart upload created, parts may be PUT |
| `completed` | API | parts verified, object completed, `photos` row inserted with `id = upload_files.id`, `photo.ingest` job sent |
| `ingested` | pipeline | derivatives, EXIF, hashes written (`photos.status = 'ingested'`) |
| `duplicate` | API (pre-check on `client_sha256`) or pipeline (server re-hash) | exact duplicate of a live photo of the baby (`duplicate_of_photo_id`, NULL when it duplicated another file of the same session); no `photos` row survives |
| `failed` | API or pipeline | `error` ∈ `unsupported_media_type`, `file_too_large`, `decode_failed`, `free_tier_limit`, `rejected` (CSAM match), `expired`, `storage_error`, `upload_incomplete` |
| `aborted` | API or sweep | multipart upload aborted (`error = 'expired'` when the sweep did it) |

**Access.** ENABLE + FORCE RLS on both. `authenticated`: a session is visible to its creator and
to the baby's admins (`upload_sessions_authenticated_select`); files follow their session through
`upload_session_visible()` (SECURITY INVOKER, like `photo_visible`); INSERT needs membership and
`created_by = auth_uid()`; UPDATE is limited to `finished_at` on sessions and `state, error,
photo_id, multipart_upload_id` on files; no DELETE for anyone but `service_role`. `pipeline`:
SELECT all files, SELECT only the liveness columns of sessions (`id, baby_id, finished_at,
expires_at, created_at, updated_at`: never the batch note/people/location), UPDATE `state, error,
photo_id, duplicate_of_photo_id` on files; it can never INSERT or DELETE either table. `viewer`:
nothing. The SECURITY DEFINER trigger `upload_files_session_owner` (BEFORE INSERT) enforces, for
every role: the session exists and belongs to the same baby; in a user-context transaction the
caller is the session's creator (`upload session belongs to another user`); the session is neither
finished nor expired (`upload session is closed`); fewer than 500 files are registered
(`upload session is full`; the session row is locked `FOR NO KEY UPDATE` so concurrent
registrations cannot overshoot); and (on INSERT or UPDATE) `duplicate_of_photo_id` is a photo of
the same baby. All raise `check_violation` (23514) with messages that name no value.

**Approval queue (FR-2.7).** The `photos` row is inserted at completion **under the uploader's own
claims**, so `photos_authenticated_insert` (step 2) is what forces a contributor's row to
`approval = 'pending'`; the API never decides this. Pending photos are invisible to other
contributors, to `shared_photos` (gate) and to the AI queue (`photos_status_guard`).

**Exact duplicates leave no `photos` row.** The unique partial index `photos_baby_id_sha256_key`
(`(baby_id, sha256) WHERE sha256 IS NOT NULL AND deleted_at IS NULL`) is the race arbiter: when
the worker's `UPDATE photos SET sha256 = …` hits `23505`, it sets the transient marker
`photos.status = 'duplicate'` (new CHECK value), links `upload_files` (`state = 'duplicate'`,
`duplicate_of_photo_id`), deletes the object versions and hard-deletes the row:
`photos_pipeline_delete` allows `status = 'duplicate'` regardless of trash age. A marker that
survives a worker crash is removed by the hourly `purge.trash` job. Because of this,
`photos.duplicate_of_photo_id` means **near-duplicate** (pHash Hamming ≤ 10 of 64; flag only).

**Quarantine (CSAM hash match).** `photos.quarantined_at` is writable by `pipeline` only. A
quarantined row does not exist for any user role: `photos_authenticated_select`,
`photos_viewer_select` and `photos_authenticated_update` carry `quarantined_at IS NULL`, child
tables follow through `photo_visible`, `photo_editable` and `babies_avatar_guard` refuse it. It is
**never purged automatically** (`photos_pipeline_delete` excludes quarantined rows even after 30
days in the trash; the original is evidence) and `service_role` still sees it for the operator
flow. The pipeline writes an `audit_log` row `safety.hash_match` (`actor_user_id IS NULL`).

**Free-tier cap: what counts.** `free_tier_photo_count(baby_id)` is the one definition of
"counts toward the 1,000-photo cap": not trashed, not quarantined, `status NOT IN ('failed',
'duplicate')`. A failed ingest (unsupported media, decode failure, storage error, CSAM
quarantine) keeps its `photos` row so the uploader sees why, but never eats the allowance;
pending (unapproved) photos do count. The `photos_free_tier_cap` trigger applies the same
predicate unconditionally (hard stop, `check_violation` `free tier photo limit reached`); the API
should call the helper for its friendly pre-check and headroom instead of counting
`deleted_at IS NULL` itself. SECURITY DEFINER: exact for contributors too (RLS would hide other
contributors' pending photos from them); returns 0 for a non-member of the baby and the full
count in a transaction without claims (`pipeline` / `service_role`); `viewer` cannot call it.

**Purge (FR-10.2).** `pipeline` may `DELETE FROM photos` only when
`(deleted_at < now() - 30 days AND quarantined_at IS NULL) OR status = 'duplicate'`, and
`DELETE FROM babies` only when `deleted_at < now() - 30 days AND NOT
baby_has_quarantined_photos(id)`: a trashed baby still holding a quarantined photo is never
purged by the pipeline (the cascade would destroy the evidence row), whatever the worker's own
query says; `service_role` (BYPASSRLS) and the superuser are unaffected, as for every purge
rule, so the operator flow can still remove it. `baby_has_quarantined_photos` is SECURITY
DEFINER, executable by `pipeline` and `service_role` only. Row deletion cascades
`photo_derivatives`, `photo_exif`, `photo_details`, `photo_ai`, `photo_search`, `shared_photos`
and sets `upload_files.photo_id` / `duplicate_of_photo_id` to NULL; object versions are deleted
by the worker before the row.

**pg-boss and the API.** The API enqueues `photo.ingest` itself (send-only pg-boss on
`littlelight_api`). The bootstrap grants `littlelight_api` `USAGE` on `pgboss` plus
`SELECT, INSERT, UPDATE, DELETE` on tables, `USAGE, SELECT` on sequences and `EXECUTE` on
functions, both on existing objects and through `ALTER DEFAULT PRIVILEGES FOR ROLE
littlelight_worker IN SCHEMA pgboss` for everything pg-boss creates at runtime (per-queue
partitions included, since the worker creates them). `littlelight_api` still has no privilege on
any `public` table without `SET LOCAL ROLE`; `boss.send` must therefore run outside the claims
wrapper.

## Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | all scripts | Superuser URL (`db-init`, `migrate`, seed, `db:types`). The api/worker get their own role URLs from Compose. |
| `AUTH_DB_PASSWORD` | bootstrap | `supabase_auth_admin`; must equal the password in `GOTRUE_DB_DATABASE_URL`. |
| `API_DB_PASSWORD` | bootstrap | `littlelight_api`; must equal the api's `DATABASE_URL` password. |
| `WORKER_DB_PASSWORD` | bootstrap | `littlelight_worker`; must equal the worker's `DATABASE_URL` password. |
| `DATA_ENCRYPTION_KEY` | seed (and api/worker) | ≥ 32 chars; `openssl rand -hex 32` in production. |
| `SEED_DEMO_FAMILY` | seed | `true` to seed the demo family (dev only). |

With `NODE_ENV=production` every password must be ≥ 16 characters. Scripts never print a URL,
password or key; errors go through `src/redact.ts`.

## Commands

From the repo root (`pnpm db:*` forwards to this package) or from `packages/db`:

| Command | Effect |
| --- | --- |
| `pnpm db:bootstrap` | Roles + `auth` + `pgboss` schemas (idempotent) |
| `pnpm db:migrate` | Bootstrap, then apply all pending migrations (`up`) |
| `pnpm db:migrate:down [n\|all]` | Revert the last `n` migrations (default 1); `all` reverts everything |
| `pnpm db:seed` | Demo family (needs `SEED_DEMO_FAMILY=true`, `DATA_ENCRYPTION_KEY`; refuses in production) |
| `pnpm --filter @littlelight/db db:types` | Regenerate `src/generated/tables.ts` from the migrated DB (CI diffs it) |
| `pnpm --filter @littlelight/db db:migrate:create <name>` | New empty `migrations/<ms-timestamp>_<name>.sql` |

Programmatic use: `import { runMigrations, bootstrap, seed, ensureAuthSchemaStub, appRoleUrl } from "@littlelight/db"`;
row types from `@littlelight/db/types` (`PhotosRow`, `PhotosInsert`, `TABLE_NAMES`, …; `text`
columns with `CHECK (col IN (...))` are string-literal unions).

### Tests and CI without GoTrue

`ensureAuthSchemaStub(client)` creates a minimal `auth.users` / `auth.identities` /
`auth.sessions` / `auth.refresh_tokens` only when `auth.users` does not exist (bare pgvector in
CI, throwaway containers). The `users`/`identities` column list is exactly what the seed inserts;
`sessions` and `refresh_tokens` carry the same column names and types as `supabase/auth:v2.197.0`
(minus the FK to `auth.oauth_clients`) so the session functions and the API integration tests
(which insert session rows) behave the same on the stub and on the real schema.
`appRoleUrl(databaseUrl, role, password)` rewrites the superuser URL to connect as
`littlelight_api` / `littlelight_worker` for RLS tests.

## Demo seed (`src/seed.ts`)

Fixed ids (`DEMO` export): users `…-000000000001/2/3` = `demo-mom@littlelight.local` (admin, Maria,
Mom), `demo-dad@…` (admin, Dad), `demo-nanny@…` (contributor); baby `…-000000000100` "Maya"
("Mimi", born 2025-06-30, `plan = plus`, encrypted home coordinates); share link `…-000000000200`
"Grandparents" (dev token `demo-grandparents-share-token`, re-upserted so it always expires 24 h
after the last seed run, rule `milestones`); 12 photos `…-0000000003NN`: 8 approved, 1 approved
and sensitive (bath, with a `photo_ai` row), 1 approved and trashed, 2 pending from the nanny;
3 shared photos; 3 measurements; `photo_search` rows for the 9 live approved photos; one audit row.
Storage keys are placeholders; no image bytes exist.

## Writing a migration

- Keep the two markers (node-pg-migrate also treats any comment line matching
  `-- up migration` / `-- down migration` as a marker, so do not write those words at the start
  of a comment). Put DDL under `-- Up Migration` and the exact inverse under `-- Down Migration`.
  Use `IF NOT EXISTS` / `IF EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS`.
- Every new table: `ENABLE` **and** `FORCE ROW LEVEL SECURITY` in the same migration, explicit
  `GRANT` per role and column, policies `TO <role>` built on `is_baby_member` / `is_baby_admin`,
  and a negative test (non-member reads 0 rows) in `packages/db/*.integration.test.ts`.
- SECURITY DEFINER functions: `SET search_path = pg_catalog, public`, no dynamic SQL, read only
  what they must; `REVOKE EXECUTE … FROM PUBLIC` then grant to the roles that need them.
- Migrations run in one transaction; avoid statements that cannot (`CREATE INDEX CONCURRENTLY`).

## Local verification against a throwaway Postgres

```sh
docker run --rm -d --name ll-db-test -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=littlelight pgvector/pgvector:0.8.7-pg17
export DATABASE_URL=postgres://postgres:dev@localhost:55432/littlelight AUTH_DB_PASSWORD=dev \
  API_DB_PASSWORD=dev WORKER_DB_PASSWORD=dev DATA_ENCRYPTION_KEY=dev-only-data-encryption-key-32-chars-min SEED_DEMO_FAMILY=true
pnpm db:bootstrap
# auth.users: either run GoTrue's migrations ...
docker run --rm --network container:ll-db-test -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:dev@localhost:5432/littlelight \
  -e GOTRUE_JWT_SECRET=dev-only-jwt-secret-dev-only-jwt-secret -e GOTRUE_SITE_URL=http://localhost:8080 \
  -e API_EXTERNAL_URL=http://localhost:8080/auth supabase/auth:v2.197.0 auth migrate
# ... or, for a stub, `ensureAuthSchemaStub(client)` from a script/test.
pnpm db:migrate && pnpm db:migrate     # second run: "nothing to do"
pnpm db:seed && pnpm db:seed           # identical counts
pnpm db:migrate:down all && pnpm db:migrate && pnpm db:seed
pnpm --filter @littlelight/db db:types && git diff --exit-code -- packages/db/src/generated
docker stop ll-db-test
```

Spot checks (password `dev` for the app roles):

```sh
PSQL="psql -h localhost -p 55432 -d littlelight -Atv ON_ERROR_STOP=0"
# another user's baby: 0 rows
PGPASSWORD=dev $PSQL -U littlelight_api -c "begin; set local role authenticated; select set_config('request.jwt.claims','{\"sub\":\"00000000-0000-4000-8000-0000000000ff\",\"role\":\"authenticated\"}',true); select count(*) from photos; rollback;"
# contributor cannot delete: permission denied for table photos
PGPASSWORD=dev $PSQL -U littlelight_api -c "begin; set local role authenticated; select set_config('request.jwt.claims','{\"sub\":\"00000000-0000-4000-8000-000000000003\",\"role\":\"authenticated\"}',true); delete from photos; rollback;"
# viewer sees only shared_photos: 3, 3, permission denied for table photo_exif
PGPASSWORD=dev $PSQL -U littlelight_api -c "begin; set local role viewer; select set_config('request.jwt.claims','{\"role\":\"viewer\",\"share_link_id\":\"00000000-0000-4000-8000-000000000200\"}',true); select count(*) from shared_photos; select count(*) from photos; select count(*) from photo_exif; rollback;"
# viewer gets nothing on upload tables: permission denied for table upload_sessions
PGPASSWORD=dev $PSQL -U littlelight_api -c "begin; set local role viewer; select set_config('request.jwt.claims','{\"role\":\"viewer\",\"share_link_id\":\"00000000-0000-4000-8000-000000000200\"}',true); select count(*) from upload_sessions; rollback;"
# Home label in SQL, pipeline only: Home, then <null> 200 m away; never a plaintext coordinate in the result
PGPASSWORD=dev $PSQL -U littlelight_worker -c "begin; set local role pipeline; select set_config('app.data_key','dev-only-data-encryption-key-32-chars-min',true); select home_place_label('00000000-0000-4000-8000-000000000100', 47.6062, -122.3321), home_place_label('00000000-0000-4000-8000-000000000100', 47.6080, -122.3321); rollback;"
```

## Migrations

| Migration | Up | Down |
| --- | --- | --- |
| `1791435700055_extensions.sql` | `vector`, `pgcrypto` | drop both |
| `1791435701234_worker-heartbeats.sql` | `worker_heartbeats` with RLS | drop table |
| `1791520000100_app-roles-and-helpers.sql` | guards (roles, `auth.users`), schema grants, default privileges for `service_role`, claims helpers, recursive `jsonb_has_gps_keys`, `encrypt_coord`/`decrypt_coord` (pipeline/service_role only), `set_updated_at` | drop functions, restore grants |
| `1791520000200_identity.sql` | `profiles`, `babies`, `baby_members`, `invites`; `is_baby_member`, `is_baby_admin`, `shares_baby_with`, `baby_ai_enabled`, `baby_has_members`, `invite_allows_join`; creator-admin, consume-invite, max-two-admins, keep-last-admin, invite-rate-limit triggers; RLS (users never read/write `home_*_enc`) | drop in reverse |
| `1791520000300_photos.sql` | `milestones` (+ 12 presets), `photos`, `photo_derivatives`, `photo_exif` (+ `raw_json` GPS-key trigger), `photo_details`, `measurements`, `photo_ai_overrides`; `babies.avatar_photo_id` FK + guard; `photo_visible`, `photo_editable`; free-tier cap and status-guard triggers; RLS | drop |
| `1791520000400_ai.sql` | `ai_batches`, `photo_ai` (+ paid-tier tripwire, sensitive sync), `photo_search` (+ HNSW/GIN/btree); RLS | drop |
| `1791520000500_sharing.sql` | `share_links`, `share_rules`, `shared_photos` (+ gate), `viewer_sessions`; `is_share_link_active`, `share_link_baby`, `viewer_baby_id`, `viewer_can_see_photo`; `photos_sensitive_unshare_rules` trigger; every `viewer` policy | drop viewer policies, trigger, tables, functions |
| `1791520000600_chat-audit.sql` | `chat_threads`, `chat_messages` (+ thread guard), append-only `audit_log`; RLS | drop |
| `1791520000700_worker-heartbeats-app-role.sql` | `worker_heartbeats.updated_at`, FORCE RLS, grant + policy for `littlelight_worker` | revert |
| `1791600000100_auth-sessions-and-plan.sql` | guard (`auth.sessions`); session functions `auth_session_info`, `list_user_sessions`, `delete_user_session`, `count_user_sessions` (SECURITY DEFINER, `authenticated` only, no grants on `auth.*`); `baby_members.removal_requested_by/_at` (service_role-written); `babies_plan_follows_owner` + `baby_members_release_plan` triggers | drop triggers, functions, columns |
| `1791700000100_uploads-and-ingest.sql` | `photos.status` gains `duplicate`, `photos.quarantined_at` (pipeline-only UPDATE), `quarantined_at IS NULL` on the user SELECT/UPDATE policies and in `photo_editable` / `babies_avatar_guard`, `photos_pipeline_delete` = trash > 30 d and not quarantined OR `status = 'duplicate'`; `free_tier_photo_count` helper + `photos_free_tier_cap` no longer counts failed/duplicate/quarantined rows; `baby_has_quarantined_photos` helper + `babies_pipeline_delete` refuses a baby holding a quarantined photo; `upload_sessions`, `upload_files` (+ `upload_session_visible`, `upload_files_session_owner` trigger, RLS, column grants); `home_place_label` (×2, pipeline/service_role) | drop functions, trigger, tables; restore `babies_pipeline_delete` and the step-2 cap trigger body, drop the two helpers; restore the four photos policies and two functions; drop column; `DELETE … WHERE status = 'duplicate'` then restore the old CHECK |
