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
| `pipeline` | no | Worker job role: cross-baby, but only photo-pipeline tables/columns (`photos` status/metadata/`quarantined_at`, `photo_exif` incl. encrypted GPS, `photo_derivatives`, `photo_ai`, `photo_search`, `ai_batches`, `ai_batch_items`, `upload_files` state, read-only `profiles`/`babies`/`milestones`/`share_rules`, liveness columns of `upload_sessions`). Never invites, tokens, chat, members, viewer sessions, batch-upload notes. Hard-deletes only rows trashed > 30 days (never quarantined ones) and `status = 'duplicate'` markers. |
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

## Timeline and details (step 5)

Migration `1791800000100_timeline-and-details.sql` (docs/plans/step-5.md 2.3). No new table, no
policy body changes, no new grant to `viewer` or `pipeline`; RLS stays ENABLE + FORCE everywhere.

**Timeline sort column and index (D2, stored-column variant).** `photos.sort_at timestamptz
GENERATED ALWAYS AS (COALESCE(taken_at, created_at)) STORED` is the sort key and cursor;
`photos_baby_id_sort_idx (baby_id, sort_at DESC, id DESC) WHERE deleted_at IS NULL` replaces the
step-2 `(baby_id, taken_at DESC)` index. Why a stored column rather than an expression index:
under row-level security the planner only pushes a keyset bound into the index when every
operator in it is leakproof; `COALESCE(...)` is not, so with an expression index the bound stayed
in the post-RLS filter and page N read N × 200 rows (page 49 as `authenticated`: 273 ms vs 0.3 ms
as superuser). With plain columns the row comparison is a btree `Index Cond` for every role.
Contract with the API: `ORDER BY p.sort_at DESC, p.id DESC`, keyset `(p.sort_at, p.id) < ($2,
$3)` for older pages and `> … ORDER BY ASC` for newer (measured on 10k rows as `authenticated`:
deep page 1.4 ms, newer 0.4 ms). `sort_at` is readable by `authenticated`, `pipeline` (table-level
SELECT) and `viewer` (column grant, like `taken_at`); it cannot be inserted or updated. The trash
view (`deleted_at IS NOT NULL`) is outside the partial index on purpose (few rows).
`photos_baby_id_age_days_idx (baby_id, age_days) WHERE deleted_at IS NULL` serves the group summary.

**Membership once per statement (`photos_authenticated_select`).** The step-2/4 policy called
`is_baby_admin(baby_id)` / `is_baby_member(baby_id)` (SECURITY DEFINER SQL functions, one
`baby_members` lookup each) once per candidate row, which made a 10k-row summary `GROUP BY` or a
deep page cost ~270 ms in policy calls alone. Step 5 adds `admin_baby_ids()` / `member_baby_ids()`
(`RETURNS SETOF uuid`, STABLE, SECURITY DEFINER, same `baby_members` read and `auth_uid()` source;
`authenticated`/`service_role` only) and rewrites only the SELECT policy as
`baby_id IN (SELECT public.admin_baby_ids()) OR (baby_id IN (SELECT public.member_baby_ids()) AND
((approval = 'approved' AND deleted_at IS NULL) OR uploaded_by = (SELECT public.auth_uid())))`,
still behind `quarantined_at IS NULL`. The uncorrelated sub-queries become hashed SubPlans /
an InitPlan evaluated once per statement (summary: 279 ms → 6 ms on 10k rows). Semantics are
identical: admins see everything of their babies (trash and approval queue included),
contributors see the approved live album plus their own uploads in any state, strangers see
nothing, a quarantined row exists for nobody. INSERT/UPDATE policies, child-table policies
(`photo_visible`) and every viewer/pipeline policy still use `is_baby_member` / `is_baby_admin`
unchanged. The down migration restores the step-4 policy body verbatim and drops the two helpers.

**`age_group(age_days integer) RETURNS text`** is the SQL twin of `@littlelight/shared`
`ageGroupKey` and must stay identical to it (a test compares the two over `-10..2000`):
`NULL` ⇒ `unknown`, `< 0` ⇒ `pre`, `0..83` ⇒ `w1..w12` (`floor(d/7)+1`), `84..729` ⇒ `m3..m24`
(`floor(d/30.4375)+1`), `≥ 730` ⇒ `y2..` (`floor(d/365)`). IMMUTABLE, SECURITY INVOKER, executable
by `authenticated`, `viewer`, `pipeline`, `service_role`. Group ordering is the client's job
(`ageGroupSortValue`); SQL only labels.

**Milestones.** Presets (`baby_id IS NULL`, the 12 fixed ids) are readable by every member and
viewer and can never be updated or deleted by any user role (the step-2 UPDATE/DELETE policies
require `baby_id IS NOT NULL AND is_baby_admin(baby_id)`; `authenticated` has no UPDATE grant on
`baby_id`, so a custom milestone cannot become a preset either). Custom milestones are admin-only
for INSERT/UPDATE/DELETE; contributors see them, nothing more. New: `updated_at` (+
`set_updated_at` trigger; the `UPDATE` grant is now `name, category, sort_order, updated_at`),
`milestones_cap` (BEFORE INSERT, SECURITY DEFINER, locks the baby row): at most **200** custom
milestones per baby (`check_violation` `milestone limit reached`;
`MAX_CUSTOM_MILESTONES_PER_BABY`), and `milestones_name_guard` (BEFORE INSERT OR UPDATE OF
`name`): a custom milestone may not take a preset's name, case-insensitively (plan D7). The
guard raises **`unique_violation` (23505) on `milestones_baby_id_lower_name_key`**, the same
SQLSTATE and constraint name as a duplicate custom name, so the API's one 409 mapping covers
both. Deleting a custom milestone nulls `photo_details.milestone_id` (existing FK); the photos
keep their other details. Index `photo_details_milestone_id_photo_id_idx (milestone_id,
photo_id) WHERE milestone_id IS NOT NULL` (replaces `photo_details_milestone_id_idx`) serves
the milestone list's counts and cover photos.

**Photo details.** Edits stay governed by `photo_editable` (an admin of the baby, or the uploader
while the photo is pending; never a trashed or quarantined photo). Shape limits: `note` ≤ 2000,
`people` ≤ 20 entries, `location_label` ≤ 120 characters, and `milestone_id` must be NULL, a
preset or a milestone of the photo's own baby (`photo_details.milestone_id must belong to the
same baby`), all enforced by the SECURITY DEFINER trigger `photo_details_shape` (see "Shape
triggers" below); `upload_sessions_shape` applies the same milestone rule to batch details. The
API trims and caps each chip (60 chars) before the row is built.

**Measurements.** Writes stay admin-only; members read; `viewer` has no grant. New trigger
`measurements_photo_same_baby` (BEFORE INSERT OR UPDATE OF `photo_id, baby_id`, SECURITY
DEFINER): `photo_id` is NULL or a live (not trashed, not quarantined) photo of the measurement's
own `baby_id` (`check_violation` `measurement photo must belong to the same baby`). Shape trigger
`measurements_shape`: `note` ≤ 2000, `value_metric` and `value_entered` > 0, `value_metric` ≤
200000 (200 kg / 200 m, a sanity bound; the real input bounds are `MEASUREMENT_LIMITS` in
`@littlelight/shared`, validated by the API through `toMetric`). Index `measurements_photo_id_idx
(photo_id) WHERE photo_id IS NOT NULL` for the photo detail's linked measurements.

**Shape triggers instead of CHECK constraints on parent-entered text.** When a CHECK constraint
fails, Postgres adds `DETAIL: Failing row contains (...)` — the whole row — to the error, and the
server log records it. Postgres omits that DETAIL when row-level security is active for the
user (`ExecBuildSlotValueDescription`), so the app roles (`authenticated`, `viewer`,
`pipeline`; every table is FORCE RLS) were never exposed; connections that bypass RLS are: the
superuser (seed, migrations, operator sessions) and `service_role` (BYPASSRLS). To close that
path, every non-enum CHECK on a table holding parent-entered text is a BEFORE INSERT OR UPDATE
trigger that raises `check_violation` (23514, the SQLSTATE a CHECK raises) with a fixed message
naming no value. Enum CHECKs (`col IN (...)`) stay: their values are API-chosen literals that the
generated row types depend on, and the API validates them first. Converted step-2/4 constraints
(the down migration restores them verbatim): `photo_details_note_check`,
`measurements_note_check`, `measurements_value_metric_check`, `measurements_value_entered_check`,
`milestones_name_check`, `babies_name_check`, `babies_birth_weight_g_check`,
`babies_birth_length_mm_check`, `upload_sessions_note_check`,
`upload_sessions_location_label_check`, `share_links_name_check`, `chat_threads_title_check`,
`invites_email_check`, `photo_ai_overrides_field_path_check`. Triggers: `photo_details_shape`,
`measurements_shape`, `milestones_name_guard` (length + preset rule), `babies_shape`,
`upload_sessions_shape` (also `people` ≤ 20, new), `share_links_shape`, `chat_threads_shape`,
`invites_shape`, `photo_ai_overrides_shape`. Not converted (no parent text in the row, or
enum/hash checks): `audit_log_event_check`, `upload_files_client_id_check`, every `*_token_hash`
/ `sha256` octet-length check, every `IN (...)` check. The other half of the rule lives in the
API and worker: always pass values as bind parameters (`log_min_error_statement` logs the
statement text, and an inlined literal would appear there; parameters are not logged while
`log_parameter_max_length_on_error = 0`, the default).

**Reindex hook (what it is and is not).** The API sends a `photo.reindex` job after committing any
details, milestone or measurement write (step 5 handler: no-op; step 7: embed). There is no
`search_dirty` column: `photo_details.updated_at`, `measurements.updated_at` and
`milestones.updated_at` are the durable "stale" signal that step 7's reconcile compares with
`photo_search.updated_at` (plan D5). pg-boss itself needs no DDL here.

**Error mapping for the API** (`apps/api/src/lib/errors.ts`): `milestone limit reached` ⇒ 409;
`measurement photo must belong to the same baby` ⇒ 409; 23505 on milestones ⇒ 409 "A milestone
with that name already exists" (covers the preset clash); any other 23514 from a shape trigger
(`<table>.<column> …` messages) ⇒ 400 `validation_failed` (the API's zod limits normally stop
these first).

## AI pipeline (step 6)

Migration `1791900000100_ai-pipeline.sql` (docs/plans/step-6.md 2.3). The rule above every
other one: **a photo of a free-tier baby never reaches a model**, and that is a database rule in
three places, not a worker promise: `photos_status_guard` (step 2; `queued`/`analyzing` only for
an approved, live photo of a paid baby), the new `ai_batch_items_guard` (no ledger row for
anything else) and `photo_ai_paid_tier_tripwire` (step 2; no result row either). All three call
`baby_ai_enabled()` (plan `plus`, entitlement not expired, baby not deleted), the same predicate
the API and `ai_eligible_photos` use, so a downgrade, an expired entitlement or a paying admin
leaving (step 3 trigger) stops the pipeline at once.

**Eligibility (`ai_eligible_photos(p_limit, p_prompt_version, p_schema_version, p_baby_id DEFAULT
NULL, p_reprocess DEFAULT false, p_max_attempts DEFAULT 2) RETURNS SETOF uuid`).** The one
definition of "may be claimed into a batch", used by the worker's flush, the upgrade/version
backfill and the tests; oldest `photos.created_at` first, `p_limit NULL` = no limit:

- `approval = 'approved'`, `deleted_at IS NULL`, `quarantined_at IS NULL` (contributors' pending
  uploads, trash and quarantine are out; a restored photo re-enters naturally);
- `status = 'ingested'` (regular) or `'ingested' | 'ready'` (`p_reprocess`, FR-5.7 backfill of a
  new prompt/schema version — a described photo is `ready`);
- the baby is in `SELECT id FROM babies WHERE baby_ai_enabled(id)` (evaluated once per baby, not
  per photo; the perf baby "Pixel" is free and never appears);
- an `analysis` derivative exists (the only copy that may reach a model; the demo seed has none,
  so the seeded photos are not eligible until real derivatives exist);
- regular: no `photo_ai` row; reprocess: a `photo_ai` row whose `(prompt_version,
  schema_version)` differs from the requested pair;
- no `ai_batch_items` row in `pending`/`submitted` (in flight);
- fewer than `p_max_attempts` (`AI_MAX_ATTEMPTS`, default 2) items in `failed` for the requested
  versions created after `COALESCE(photos.ai_retry_requested_at, -infinity)`.

SECURITY INVOKER (runs with the caller's grants; selects no GPS column), executable by `pipeline`
and `service_role` only. The worker re-checks each photo at submit time; the triggers re-check
on every write regardless.

**State machine.** `photos.status`: `ingested → queued` (claimed into a `building` batch) `→
analyzing` (submitted) `→ ready` (`photo_ai` written). A failed attempt goes **back to
`ingested`**, never to `failed`: step 4 uses `failed` for ingest failures and hides those rows
from every album view, and an AI failure must not hide a good photo (plan D4). The API derives
`aiStatus = failed` from the items instead. `ai_batch_items.state`: `pending → submitted →
succeeded | failed (failure_kind: refusal, invalid_output, expired, rate_limited, provider_error,
budget)`; `dropped` = removed before submission (re-check failed, e.g. the baby went free).
`ai_batches.status` is unchanged (`building, submitted, in_progress, completed, failed, expired,
cancelled`); new columns record the provider's input/output/error file ids, `files_deleted_at`
(the PRD's "input files deleted after retrieval"; NULL on a terminal batch = retry), the
prompt/schema versions, `reasoning_tokens`/`image_tokens`, `request_counts` (provider counts
only), `last_polled_at`, `expires_at`, `submitted_bytes`. `ai_batches.error`, `failure_kind` and
`request_counts` hold categories/counts only — never a prompt, a note, a provider message or an
image.

**Retry.** `photos.ai_retry_requested_at` is the admin "Retry" after the attempts are used up:
`authenticated` has `UPDATE (ai_retry_requested_at)` and the step-2/4 `photos_authenticated_update`
policy limits it to admins (and the uploader of a pending photo, which is never eligible); the
pipeline cannot write it. Attempts before the timestamp stop counting.

**Who may write what.**

| Table | `pipeline` | `service_role` | `authenticated` | `viewer` |
| --- | --- | --- | --- | --- |
| `ai_batches` | ALL | ALL | nothing | nothing |
| `ai_batch_items` | ALL | ALL | SELECT `(batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, state, failure_kind, cost_usd, created_at, updated_at)` of items for photos they can see (`photo_visible`; token columns hidden) | nothing |
| `photo_ai` | ALL (tripwire applies) | ALL | SELECT (`photo_visible`) | nothing |
| `photo_ai_overrides` | SELECT | ALL | INSERT/UPDATE/DELETE via `photo_editable` (admins) | nothing |

`ai_batch_items_guard` (BEFORE INSERT OR UPDATE OF `photo_id, baby_id`, SECURITY DEFINER): the
photo exists, `baby_id` is the photo's own, the photo is approved and live and the baby is
`baby_ai_enabled` (`check_violation`, fixed message). A later downgrade leaves the historical
ledger alone. A `failed` item must carry a `failure_kind`; nothing but `failed`/`dropped` may.
Budget-skipped photos get no item at all (the worker writes one `audit_log` `ai.budget_exceeded`
per baby per month instead).

**Budget helper.** `ai_baby_month_cost_usd(baby_id, month date) RETURNS numeric` = `SUM(cost_usd)`
of the baby's items whose `created_at` (claim time, when the worker checks the budget) falls in
the UTC calendar month containing `month`; 0 when none. SECURITY INVOKER: `pipeline` and
`service_role` see everything, `authenticated` only items of photos they can see (a stranger gets
0); `viewer` cannot call it. The worker compares it with `AI_BABY_MONTHLY_BUDGET_USD` before
claiming; the admin usage endpoint shows it.

**Overrides (FR-5.6).** `photo_ai_overrides_shape` now pins `field_path` to `caption`,
`detailed_description`, `search_tags` (`photo_ai_overrides.field_path is not an overridable
field`) and `value` to a JSON string of 1..200 / 1..1200 characters or an array of 1..20 strings
of ≤ 60 characters (`photo_ai_overrides.value must be …`, fixed messages). A trigger, not a CHECK:
the row holds parent text.

**Plan setter (dev/operator; plan D7).** Until billing webhooks exist (they will write the same
columns under `service_role`), `pnpm db:plan` is the only path that changes `babies.plan`:

```sh
pnpm db:plan <babyId> plus|free [--owner <userId>] [--expires <iso>] [--i-know-this-is-production]
docker compose -f docker-compose.dev.yml run --rm migrate pnpm db:plan <babyId> plus   # dev stack
```

Superuser `DATABASE_URL`, one transaction: refuses a missing or trashed baby, an `--owner` who is
not an admin of the baby, and `NODE_ENV=production` without the flag; sets `plan`,
`plan_owner_user_id` (NULL unless `--owner`: a plus plan with no owner is the manual grant the
step-3 `babies_plan_follows_owner` trigger leaves alone — the script first releases the old owner
on a free row so that trigger cannot turn the new grant back into `free`) and
`entitlement_expires_at`; appends `audit_log` `baby.plan_changed` (`actor_user_id` NULL, metadata
`{plan}` + `target_user_id` when an owner was named); prints ids and the plan only, plus the
backfill hint `pnpm --filter @littlelight/worker run-job --enqueue ai.backfill
'{"babyId":"…","reason":"upgrade"}'` (step 7 adds the `search.backfill` line, `searchBackfillHint`;
the `ai.backfill` upgrade job also chains it). Exit 0 done, 1 refused/failed, 2 usage. `src/tools/set-plan.ts`
imports only `pg` and this package's `env`/`redact` helpers (the migrate image holds nothing
else); `setPlan` / `parseSetPlanArgs` are exported for tests.

**Seed.** The bath photo's `photo_ai.description` is a full v1 `aiDescriptionV1Schema` object
(`prompt_version = schema_version = 'v1'`, `sensitive_content = ['bath']`), linked to a completed
demo `ai_batches` row (`…-000000000500`: 1,400/700/400 tokens, `cost_usd 0.00017`,
`files_deleted_at` set) with one `succeeded` `ai_batch_items` row, so the API's `ai` block and the
usage endpoint have data; that photo is seeded with `status = 'ready'` (the other eleven stay
`ingested`). Still idempotent.

## Search and chat (step 7)

Migration `1792000000100_search-and-chat.sql` (docs/plans/step-7.md 2.3). RLS stays ENABLE + FORCE
on every table (two new ones: `ai_spend`, `chat_turns`). `viewer` gains nothing; `pipeline` gains
only `ai_spend` (embed rows), EXECUTE on `search_stale_photos` / `photo_search_orphans` /
`lower_text_array`, and needs no data key for any of it. Every error message below is fixed text.

**`photo_search` columns.** `doc_version` (`SEARCH_DOC_VERSION`), `content_hash` (sha256 hex of
`search_text`; equal hash ⇒ no embedding call; NULL ⇒ rebuild), `embedded_at`, `place` (lower-cased
`photo_details.location_label`, else `photo_exif.place_label`; never coordinates). `taken_at` is
`photos.sort_at` at index time. Unchanged from step 2: `embedding vector(1024)` with HNSW
`vector_cosine_ops` (m 16, ef_construction 64), GIN on `tsv` and `tags`. New indexes:
`photo_search_unembedded_idx (baby_id) WHERE embedding IS NULL`, `photo_search_baby_id_place_idx`,
`photo_search_people_lower_idx USING gin (lower_text_array(people))`. `lower_text_array(text[])` is
IMMUTABLE (lower() per element, order kept, `{}` for empty).

**Who may read `photo_search` (policy rewrite, plan D8).** `search_baby_ids()` (SETOF uuid, STABLE,
SECURITY DEFINER, `authenticated`/`service_role`) = `admin_baby_ids()` filtered by
`baby_ai_enabled`. The SELECT policy is `baby_id = ANY (ARRAY(SELECT public.search_baby_ids()))`:
admins of a paid baby see its rows; contributors, viewers (no grant), strangers, admins of a free
baby or an expired entitlement see 0. Why the ARRAY form rather than step 5's `IN (SELECT ...)`: a
hashed SubPlan is estimated at 50 % selectivity, which made the planner prefer a sequential scan +
sort over the HNSW index; the InitPlan array gives a real estimate and `uuid = ANY(array)` is
leakproof, so it is also a btree Index Cond. `photo_visible(photo_id)` left the policy (three
SECURITY DEFINER calls per row); liveness is a write-time rule instead (guard + cleanup below) and
the API still joins `photos` (its own RLS). The down migration restores the step-2 policy verbatim.

**The GIN legs under RLS: candidate functions.** Postgres never turns a non-leakproof user qual into
an index qual on a table with RLS (`restriction_is_securely_promotable`), and `tsvector @@ tsquery`
(`ts_match_vq`) and `anyarray && anyarray` (`arrayoverlap`) are not leakproof. As `authenticated`
the full-text and tag/people legs therefore scan every row of the baby (measured at 50k rows:
`Bitmap Index Scan on photo_search_baby_id_place_idx` + `Filter: tsv @@ …`). Marking the built-ins
LEAKPROOF was rejected (a global catalog change, lost on dump/restore and extension updates, and
unsound for `arrayoverlap` over element types with leaky equality). Instead two SECURITY DEFINER
functions (plpgsql, no dynamic SQL, `authenticated`/`service_role`) run those legs:

```sql
photo_search_text_candidates(p_baby_id uuid, p_query tsquery, p_limit integer,
  p_taken_from timestamptz DEFAULT NULL, p_taken_to timestamptz DEFAULT NULL,
  p_age_from integer DEFAULT NULL, p_age_to integer DEFAULT NULL, p_milestone_ids uuid[] DEFAULT NULL,
  p_people text[] DEFAULT NULL, p_tags text[] DEFAULT NULL, p_place text DEFAULT NULL)
  RETURNS TABLE (photo_id uuid, rank real)          -- ts_rank_cd, best first
photo_search_term_candidates(p_baby_id uuid, p_terms text[], p_limit integer, <same filters>)
  RETURNS TABLE (photo_id uuid, hits integer)       -- matching tags + 2 x matching people
```

Authorisation inside: `p_baby_id` must be in `search_baby_ids()`, else the result is empty (what RLS
would return). Output is ids and scores of live, approved, unquarantined photos of that baby only:
never `search_text`, a note or any other column. Filters mirror the API's `filterSql` (NULL/empty =
off; dates `[from, to)`, ages inclusive, people case-insensitive, tags lower-case, `place =
lower(p_place)`); `p_limit` clamped to 1..200. Measured at 50k rows as `authenticated`: text leg
uses `Bitmap Index Scan on photo_search_tsv_idx` (selective query 2 ms vs 25 ms under RLS; broad
query 22 ms vs 62 ms), term leg uses `BitmapOr` of `photo_search_tags_idx` and
`photo_search_people_lower_idx` (21–28 ms for 2.5k–5k matches). To EXPLAIN them, load
`auto_explain` with `log_nested_statements` as the superuser. The **vector leg needs no helper**: an
index ORDER BY is not a qual, and with the ARRAY policy the planner picks `Index Scan using
photo_search_embedding_idx` + nested loop to `photos_pkey` under RLS (50k rows, joined to `photos`
like `hybrid.ts`: 16 ms warm, `hnsw.iterative_scan = relaxed_order`, `ef_search` 100). Below
~15k candidates it may choose seq scan + top-N sort instead (73 ms at 5k), which stays under the
300 ms target.

**Write rules.** `photo_search_guard` (BEFORE INSERT OR UPDATE OF `photo_id, baby_id, search_text,
embedding`; SECURITY DEFINER; every role incl. pipeline and the seed): the photo exists, `baby_id` is
its own, `approval = 'approved'`, not trashed, not quarantined, not `failed`/`duplicate`,
`baby_ai_enabled` ⇒ else `check_violation` "search rows can only be stored for approved live photos
of a paid-tier baby". Free-tier babies get no search rows and no vectors (FR-5.8, D3) as a database
rule. Bookkeeping-only updates (`content_hash`, `updated_at`) pass, so stale markers work for
downgraded babies, whose rows are kept (hidden by RLS) for a re-upgrade. `photos_search_cleanup`
(AFTER UPDATE OF `deleted_at, approval, quarantined_at, status` on `photos`) deletes the row the
moment the photo is trashed, un-approved, quarantined, failed or a duplicate marker (a quarantined
photo exists for nobody; restoring from trash makes it "missing"). `photo_search_mark_stale` (AFTER
DELETE on `photo_details`, `photo_ai`, `photo_ai_overrides`, `measurements`; AFTER UPDATE OF
`photo_id` on `measurements`) clears `content_hash`, because `updated_at` comparisons cannot see a
deletion; it skips photos that are themselves being deleted (cascades stay clean).

**Reindex helpers (SECURITY INVOKER, `pipeline`/`service_role`).**
`search_stale_photos(p_limit, p_embed_model, p_doc_version, p_baby_id DEFAULT NULL) RETURNS TABLE
(photo_id, baby_id, reason)`: live approved unquarantined photos with status
`ingested|queued|analyzing|ready` of `baby_ai_enabled` babies where reason = `missing` (no row),
`unembedded` (no vector), `version` (`embed_model`/`doc_version` differ) or `stale` (`content_hash`
NULL, or `photo_search.updated_at` older than any of `photos`, `photo_exif`, `photo_details`,
`photo_ai`, the tagged milestone, the newest override, the newest linked measurement); oldest first,
`p_limit NULL` = no limit; reads only `updated_at` from `photo_exif` (no GPS column).
`photo_search_orphans(p_limit) RETURNS SETOF uuid`: rows whose photo is trashed, not approved,
quarantined, failed, a duplicate marker or of another baby (safety net behind the cleanup trigger).

**`ai_spend` (plan D7).** Ledger for spend that is not a vision batch item: `kind` `embed | chat |
rerank`, `user_id` (chat actor; NULL for embeddings; `ON DELETE SET NULL`), `ref_id` (assistant
message id; no FK so clearing history keeps the spend), `model`, token columns, `item_count`,
`cost_usd numeric(12,8) ≥ 0`, `created_at`. Numbers only, so plain CHECKs. Grants/policies:
`service_role` ALL; `pipeline` INSERT (no `id`/`created_at`) `WITH CHECK (kind = 'embed' AND user_id
IS NULL AND ref_id IS NULL)` and SELECT of every row (`ai_baby_month_cost_usd` is SECURITY INVOKER
and the worker's budget check must include chat spend); `authenticated` INSERT (no `created_at`)
`WITH CHECK (is_baby_admin(baby_id) AND user_id = auth_uid() AND baby_ai_enabled(baby_id) AND kind
IN ('chat','rerank'))` and SELECT `USING (baby_id = ANY (ARRAY(SELECT admin_baby_ids())))`; nobody
below `service_role` may UPDATE or DELETE. `ai_spend_guard` (BEFORE INSERT, every role incl. the
superuser): no row for a baby that is not `baby_ai_enabled`.

**`ai_baby_month_cost_usd(p_baby_id, p_month)`** keeps its signature and grants and now returns
`SUM(ai_batch_items.cost_usd) + SUM(ai_spend.cost_usd)` for the UTC month (down: the step-6 body
verbatim). The step-6 budget check, usage endpoint and alert cover embeddings and chat unchanged.

**Chat tables.** Policies unchanged from step 2: every row is the caller's own and requires
`is_baby_admin`; inserting a thread or message also requires `baby_ai_enabled` (FR-7.7). Reading and
clearing one's own history stays possible after a downgrade (the API answers `plan_required` before
any read). Contributors, viewers and the pipeline have no access. New: unique
`chat_threads_baby_id_user_id_key (baby_id, user_id)` (one thread per user per baby, D4);
`chat_messages.cited_measurement_ids uuid[]`, `cost_usd numeric(12,8)`, `tools_used text[]`,
`status text DEFAULT 'complete' CHECK (status IN ('complete','error'))` with matching `authenticated`
INSERT/UPDATE column grants; `chat_messages_shape` trigger: `content` 1..8000 chars, ≤ 50 cited photo
ids, ≤ 50 cited measurement ids, ≤ 16 tool names, every tool name in `search_photos |
get_measurements | get_milestones | get_photo` (never arguments), `cost_usd ≥ 0`.

**100 turns/day/user (`chat_turns`).** Counted in a ledger that clearing the history does not reset
(rows: `user_id` (CASCADE with the profile), `reserved_xid xid8`, `claimed_at`, `created_at`; no
conversation data; ENABLE + FORCE RLS, no grant below `service_role`). Contract for the API, all in
the transaction that inserts the user message:

1. `SELECT turns, oldest_at, allowed FROM chat_reserve_turn($limit)` (SECURITY DEFINER,
   `authenticated`): takes a transaction-scoped advisory lock on the user (concurrent turns of one
   user queue here), prunes the user's rows older than 24 h and unclaimed reservations of other
   transactions, counts claimed turns in the rolling 24 h, and when `turns < $limit` reserves one for
   this transaction (idempotent). `allowed = false` ⇒ 429, `Retry-After = oldest_at + 24 h - now()`.
2. `INSERT` the `role = 'user'` message: the AFTER INSERT trigger `chat_messages_claim_turn` claims
   the reservation (the turn now counts). From `authenticated`, a user message with no reservation in
   its transaction is refused (`check_violation`), so the limit holds even if the API skips step 1;
   inserts by `service_role` or the superuser (fixtures) are counted without one.

A reservation that is never claimed (e.g. the budget refusal path commits without a message) does
not count. `chat_user_turns_24h()` (STABLE, SECURITY DEFINER, `authenticated`) returns the claimed
count for `turnsLeftToday`. Verified: 100 turns then the 101st refused; two concurrent turns at 99
used ⇒ exactly one allowed; clearing the thread leaves the count at 100.

**Residual (project-wide).** A `col IN (...)` CHECK (allowed by "Writing a migration") still logs
`Failing row contains (...)` when the writer bypasses RLS (superuser, `service_role`); for
`authenticated` and `pipeline` Postgres omits the row. `chat_messages.status`/`role` are such
CHECKs; chat is written only as `authenticated`. Production should run the db with
`log_error_verbosity = terse`.

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
| `pnpm db:plan <babyId> plus\|free [--owner <userId>] [--expires <iso>]` | Dev/operator plan switch, audited (`baby.plan_changed`); refuses in production without `--i-know-this-is-production` (see "AI pipeline") |
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
3 shared photos; 3 measurements; `photo_search` rows for the 9 live approved photos (with `place`;
`embedding`, `embed_model`, `doc_version`, `content_hash` and `embedded_at` NULL, also reset on every
re-seed, so the worker's `search.reconcile` rebuilds and embeds them); one audit row.
Storage keys are placeholders; no image bytes exist.

A separate, dev-only **performance seed** (`pnpm perf:seed`, lives in
`apps/worker/src/tools/perf-seed.ts`, docs/plans/step-5.md 2.8) adds a second baby
(`…-000000000900` "Pixel", free plan, no plan owner) with 10,000 ingested photos, real thumb/display
derivatives in MinIO, milestones, details and measurements, for the step-5 scroll gate. It runs on
the host with the superuser URL and the MinIO root key, never in a container; `--remove` deletes
it. The demo seed does not know about it.

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
- No CHECK constraint other than `col IN (...)` on a table that holds parent-entered text (notes,
  people, labels, names, titles, chat, invitee emails): write a `<table>_shape` BEFORE INSERT OR
  UPDATE trigger raising `check_violation` with a fixed message instead (see "Shape triggers").
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
| `1791900000100_ai-pipeline.sql` | `photos.ai_retry_requested_at` (+ `UPDATE` grant to `authenticated`); `ai_batches` provider file ids, `files_deleted_at`, versions, `reasoning_tokens`/`image_tokens`, `request_counts`, `last_polled_at`, `expires_at`, `submitted_bytes`, `ai_batches_open_idx`; `ai_batch_items` (ENABLE+FORCE RLS, pipeline/service_role ALL, authenticated column-limited SELECT via `photo_visible`, `ai_batch_items_guard`, 3 indexes); `ai_eligible_photos(...)` (pipeline/service_role); `ai_baby_month_cost_usd(...)` (authenticated/pipeline/service_role); `record_ai_budget_exceeded(uuid, text)` (SECURITY DEFINER, pipeline/service_role; inserts the `ai.budget_exceeded` audit row for a baby + `YYYY-MM` once, advisory-locked per (baby, month), returns whether it inserted; `pipeline` still has no SELECT on `audit_log`); `photo_ai_overrides_shape` extended to field/value shape (trigger now also `UPDATE OF value`) | restore the step-5 shape function/trigger verbatim; drop the three helpers, the table + guard, the index and columns; revoke + drop `ai_retry_requested_at` |
| `1791800000100_timeline-and-details.sql` | `photos_baby_id_sort_idx` (replaces `photos_baby_id_taken_at_idx`) + `photos_baby_id_age_days_idx`; `age_group(integer)` (IMMUTABLE; authenticated/viewer/pipeline/service_role); `milestones.updated_at` + trigger, `UPDATE (updated_at)` grant, `milestones_cap` (200 custom per baby), `milestones_name_guard` (1..80 chars, no preset names ⇒ 23505); `photo_details_milestone_id_photo_id_idx` (replaces `photo_details_milestone_id_idx`); `measurements_photo_same_baby` trigger, `measurements_photo_id_idx`; 14 CHECK constraints on parent-entered text dropped and re-stated as shape triggers (`photo_details_shape`, `measurements_shape`, `babies_shape`, `upload_sessions_shape`, `share_links_shape`, `chat_threads_shape`, `invites_shape`, `photo_ai_overrides_shape`; see "Shape triggers") | drop the new indexes/triggers/functions/column, recreate the two step-2 indexes and every dropped CHECK verbatim |
| `1792000000100_search-and-chat.sql` | `photo_search.doc_version/content_hash/embedded_at/place` + unembedded, (baby_id, place) and `lower_text_array(people)` GIN indexes; `lower_text_array(text[])`; `search_baby_ids()` and the `photo_search_authenticated_select` rewrite to `baby_id = ANY (ARRAY(SELECT search_baby_ids()))`; `photo_search_guard`, `photos_search_cleanup`, `photo_search_mark_stale` (5 triggers); `search_stale_photos(...)`, `photo_search_orphans(...)` (pipeline/service_role); `photo_search_text_candidates(...)`, `photo_search_term_candidates(...)` (SECURITY DEFINER, authenticated/service_role); `ai_spend` (ENABLE+FORCE RLS, `ai_spend_guard`); `ai_baby_month_cost_usd` = items + spend; `chat_threads (baby_id, user_id)` unique; `chat_messages.cited_measurement_ids/cost_usd/tools_used/status` + `chat_messages_shape`; `chat_turns` + `chat_reserve_turn(integer)`, `chat_user_turns_24h()`, `chat_messages_claim_turn` | drop all of it; restore the step-2 `photo_search` SELECT policy and the step-6 `ai_baby_month_cost_usd` body verbatim |
