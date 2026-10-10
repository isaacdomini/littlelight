# @tinyglow/db

Database bootstrap, migrations, seed and generated row types for Tinyglow. Owned by
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
| `tinyglow_api` | yes, NOINHERIT | API connection role. Has **no** privileges on app tables: every unit of work must `SET LOCAL ROLE authenticated \| viewer \| service_role`; a query outside that fails with `permission denied`. |
| `tinyglow_worker` | yes, NOINHERIT | Worker connection role. Owns `pgboss`; `worker_heartbeats` directly; `SET LOCAL ROLE pipeline` for app tables. |
| `authenticated` | no | Signed-in user. Policies read `request.jwt.claims` through `auth_uid()` / `auth_email()` and membership through `is_baby_member()` / `is_baby_admin()` (SECURITY DEFINER, read `baby_members`, never trust claims beyond `sub`). Reads only its **own** `profiles` row; co-members' names come from the `member_profiles` view (see "Review hardening and data exports"). |
| `viewer` | no | Share-link viewer. Can read only: `shared_photos` of its link (no parent user ids), the allow-listed columns of `photos`, `photo_derivatives` (thumb/display, and never those of a hidden sensitive photo), `photo_details` (milestone only), `babies` (id, name, nickname, birth_date), `milestones`, `share_links` (own, no hashes). Its only writes go through `viewer_session_check()`. Nothing else, and nothing once the link is expired/revoked or the baby is deleted (see "Sharing (step 8)"). |
| `pipeline` | no | Worker job role: cross-baby, but only photo-pipeline tables/columns (`photos` status/metadata/`quarantined_at`, `photo_exif` incl. encrypted GPS, `photo_derivatives`, `photo_ai`, `photo_search`, `ai_batches`, `ai_batch_items`, `upload_files` state, read-only `profiles`/`babies`/`milestones`, `share_rules` (+ `evaluated_at`), `shared_photo_exclusions`, insert/delete of its own `rule` rows in `shared_photos`, liveness columns of `upload_sessions`; EXECUTE on the four push functions `push_targets`, `push_photos_analyzed_count`, `push_link_baby`, `push_record_delivery` and no grant on the push tables; for the FR-10.1 export: `data_exports` progress/result/purge columns, the `babies` profile columns (no billing), `baby_members (baby_id, user_id, role, joined_at)` read-only, EXECUTE on `export_requester_is_admin` / `export_requester_email`; for step-10 Google imports: `import_batches` read + progress/result columns, `import_items` insert/read/progress columns and 30-day retention delete, EXECUTE on `import_batch_requester_state`, `import_google_refresh_token`, `import_mark_reconnect`, `import_book_photo`, and no grant on `import_sources` or `google_accounts`). Never invites, tokens, chat, removal requests or `invited_by`, viewer sessions, passcode failures, batch-upload notes. Hard-deletes only rows trashed > 30 days (never quarantined ones) and `status = 'duplicate'` markers. |
| `service_role` | no, **BYPASSRLS** | API-internal, no user context: share-token exchange, viewer sessions, passcode failures, invite redemption, billing, account deletion, audit writes, Google connections (`google_accounts`, `encrypt_secret`/`decrypt_secret`). Reachable from `tinyglow_api` only, never from the worker. `audit_log` is append-only even for this role. |
| `anon` | no | No grants (exists only because GoTrue mints the claim). |

Only `postgres` can read `pgmigrations` or `auth.*` (see "Session functions" and "Native push" for
the narrow doors into `auth.sessions`). Every table in `public` has
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
- Never run a query outside the wrapper: `tinyglow_api` has no privileges of its own, so such a
  query fails with `permission denied` rather than returning data.

Claims are always a bind parameter (never interpolated, never logged). Shapes
(`@tinyglow/shared` `jwt-claims.ts`): authenticated `{"sub","role":"authenticated","email",...}`,
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
  unreadable to every user role); the API then mints a viewer JWT and uses `SET LOCAL ROLE viewer`,
  whose first statement is `viewer_session_check(jti)` (see "Sharing (step 8)").
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
  `baby_members_keep_last_admin`. Since migration 18 the policies enforce FR-1.5 themselves: an
  `authenticated` actor can `UPDATE` (demote) or `DELETE` an **admin** row only when it is their
  own; another admin's row affects 0 rows (no error), so the API must check the row count.
- Business rules enforced by triggers (all raise `check_violation`, SQLSTATE 23514): max two
  admins, last admin stays, 20 invites/baby/day, free-tier 1,000-photo cap, AI queue and
  `photo_ai` only for approved photos of a paid-tier baby, `shared_photos` only approved live
  unquarantined photos of the link's baby and never sensitive, unanalysed or admin-excluded ones
  by rule (a photo that later becomes sensitive loses its rule-added shares at once; hand-picked
  shares stay as hidden tiles until an admin releases them per link; see "Sharing (step 8)"),
  revoked links are never renewed or un-revoked with the old token, avatar must be an own approved photo, joining consumes the invite,
  `photo_exif.raw_json` can never carry a coordinate-looking key at any depth
  (`jsonb_has_gps_keys`: contains `gps`/`latitude`/`longitude`, word-start `geo`, or exactly
  `lat`/`lng`/`lon`; a trigger rather than a CHECK so the rejected row is never echoed into the
  server log as `DETAIL`), upload sessions hold at most 500 files and only their creator may add
  to them (`upload_files_session_owner`, see "Uploads and ingest"), an admin approval pins
  `approved_by` (`photos_user_update_guard`; its contributor branch raises 42501, not 23514), one
  export in progress and 3 exports per album per day
  (`data_exports_rate_limit`), never for a trashed album (`data_exports_baby_live`), and an
  export's expiry can only be shortened from a user role (`data_exports_user_update_guard`); see
  "Review hardening and data exports".

## Session functions (`auth.sessions`)

GoTrue keeps one `auth.sessions` row per device sign-in and deletes it on sign-out, refresh-token
reuse and user deletion. The API uses that row as the liveness check behind every request (a
deleted session is a `401 session_revoked` within one request, not after the JWT's hour), for the
devices screen and for new-device alerts (PRD "Sessions and tokens"; step-3 D2). Four
SECURITY DEFINER functions, owned by the superuser that runs migrations, are the access path
from an app role into `auth.*` (the step-9 push functions also read `auth.sessions`, through the
internal, ungranted `push_session_live`; see "Native push"): no table or schema grant on `auth` exists for
`authenticated`, `viewer`, `pipeline`, `service_role`, `tinyglow_api` or `tinyglow_worker`
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
`tinyglow_api`). The bootstrap grants `tinyglow_api` `USAGE` on `pgboss` plus
`SELECT, INSERT, UPDATE, DELETE` on tables, `USAGE, SELECT` on sequences and `EXECUTE` on
functions, both on existing objects and through `ALTER DEFAULT PRIVILEGES FOR ROLE
tinyglow_worker IN SCHEMA pgboss` for everything pg-boss creates at runtime (per-queue
partitions included, since the worker creates them). `tinyglow_api` still has no privilege on
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

**`age_group(age_days integer) RETURNS text`** is the SQL twin of `@tinyglow/shared`
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
`@tinyglow/shared`, validated by the API through `toMetric`). Index `measurements_photo_id_idx
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

The tripwire's single exemption (migration `1792200000200`): an UPDATE that only clears
`photo_ai.batch_id` is allowed for any baby, because batches mix babies and `ai_batches` deletes
null that FK. It adds no AI content; any other column change is still refused.

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
backfill hint `pnpm --filter @tinyglow/worker run-job --enqueue ai.backfill
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

## Sharing (step 8)

Migration `1792100000100_sharing-v1.sql` (docs/plans/step-8.md 2.3; PRD "FR-9 Sharing",
"Share-link viewers (no account)"). RLS stays ENABLE + FORCE everywhere (two new tables:
`shared_photo_exclusions`, `share_passcode_failures`). Every error message below is fixed text: none
echoes a token, hash, passcode, IP, link name or tag.

**Tokens, passcodes, expiry.** A share token is 128-bit random; only `share_links.token_hash =
sha256(token)` is stored and the plaintext URL is shown once (D1). `passcode_hash` holds the API's
`scrypt$1$N$r$p$salt$dk` string (D7; the step-2 `argon2id$` form is still accepted); anything else,
such as a plaintext 6-digit code, is refused (`share_links.passcode_hash has an unknown format`).
`has_passcode` (generated) is what users read. `ttl_hours` (1..720, default 24) is the validity
"Renew" re-applies; `expires_at` may be at most 30 days ahead (`share link expiry must be within 30
days`, D2). Shape checks live in the `share_links_shape` trigger (the row holds a parent-entered
name). At most 20 links per baby (`share_links_cap`, baby row locked; `share link limit reached`).

**Lifecycle, every role (`share_links_lifecycle`, D13).** `token_rotated_at` is set by the database
whenever `token_hash` changes and cannot be written by anyone (a forged value is replaced by the
old one). A revoked link cannot be renewed (`a revoked share link cannot be renewed`) and cannot be
un-revoked with the same token (`a revoked share link can only be reactivated with a new token`):
regenerate = new `token_hash` + `revoked_at = NULL` + new `expires_at` in one UPDATE.

**Sessions end as a database rule.** `share_links_end_sessions` (AFTER UPDATE OF `token_hash,
passcode_hash, revoked_at`): a new token, a new non-NULL passcode or a revoke sets `revoked_at` on
every open `viewer_sessions` row of the link in the same transaction. `viewer_sessions_guard`
(BEFORE INSERT): a session can only be opened on an active link and its `expires_at` is clamped to
the link's (`share link is not active`). Admins read `viewer_sessions.revoked_at` (active viewers =
`revoked_at IS NULL AND expires_at > now()`); hashes stay unreadable.

**`viewer_session_check(p_session_id uuid) RETURNS TABLE (share_link_id, baby_id, link_name,
baby_name, baby_nickname, expires_at, allow_download)`**, VOLATILE, SECURITY DEFINER, `viewer` and
`service_role`. The first statement of every viewer request, with the JWT's `jti`. One row iff the
claims carry `role=viewer` + `share_link_id`, the session belongs to that link and is not revoked,
and the link is active (not revoked, not expired, baby not trashed); no row ⇒ the API answers 410
`share_link_expired`. Side effects (the viewer role's only write path): `last_seen_at` (at most once
a minute); one visit (`share_links.view_count + 1`, `last_viewed_at`) when the previous
`last_seen_at` is NULL or older than 30 minutes (`SHARE_VISIT_GAP_MIN`; concurrent requests count
once); the session's `expires_at` follows a renewed link (the returned `expires_at` is the link's,
for re-minting the cookie). Reads no hash column. The RLS policies re-check link liveness on every
statement regardless.

**The sensitive gate (FR-9.5), four places.**
1. `shared_photos_gate` (BEFORE INSERT OR UPDATE, SECURITY DEFINER) locks the photo row `FOR SHARE`,
   which conflicts with the row lock of `UPDATE photos SET is_sensitive = true`: whichever commits
   second sees the other, so a rule row and a sensitive flag never both survive (verified with two
   connections in both orders). Every row: same baby, approved, not trashed, not quarantined (one
   message for all three). `rule` rows also: not sensitive (`sensitive photos are never
   auto-shared`), analysed (`only analysed photos can be auto-shared`: a `photo_ai` row; free-tier
   photos are never analysed, D3), not excluded (`photo was removed from this album by an admin`),
   never released. A write that only withdraws a release or re-attributes a row is not re-gated.
2. `photos_sensitive_unshare_rules`: a photo that becomes sensitive loses its rule rows and every
   earlier release at once.
3. Viewers never see a sensitive photo through a rule row (`viewer_photo_ids`, step-2 rule).
4. A hand-shared sensitive photo is a **hidden tile** until an admin releases it for that link
   (`shared_photos.sensitive_released_at/_by`, D4): the viewer lists it (id, dates, `is_sensitive`)
   but cannot read its `photo_derivatives` rows, so the API cannot sign it even by mistake. A
   release is forced to NULL on a non-sensitive photo, and from `authenticated` it must name the
   releasing admin (`a sensitive photo can only be shown by the admin releasing it`).

**Viewer visibility, once per statement (R4).** The viewer policies on `photos`, `shared_photos`,
`photo_details` and `photo_derivatives` use three SECURITY DEFINER set helpers (`viewer`,
`service_role`): `viewer_link_id()` (the claims' link when active, else NULL),
`viewer_photo_ids()` (photos of that link that are approved, live, unquarantined and not
sensitive-by-rule: the old `viewer_can_see_photo` + photos policy) and `viewer_media_photo_ids()`
(the same, minus unreleased sensitive photos: `viewer_can_see_media`). Form: `col IN (SELECT f())`,
a hashed SubPlan built once per statement; not the step-7 `= ANY (ARRAY(...))` form, because an
array of thousands of ids is not hashed and would be scanned per row. Measured as `viewer` with
10,000 shared photos (200 runs each, p50 / p95): first page of 101 rows 24 / 37 ms, keyset page
near the end 18 / 25 ms, album counts 19 / 29 ms (3,436 ms with the per-row policies), thumbs for a
page 8 / 15 ms; a link sharing 1 % of the baby's photos: first page 6–11 ms. The single-photo helpers
`viewer_can_see_photo(uuid)` / `viewer_can_see_media(uuid)` stay (download / URL checks).

**Exclusions.** `shared_photo_exclusions (share_link_id, photo_id, excluded_by, created_at)`: an admin
removed the photo from that album, so rules never re-add it (gate). `authenticated`: admins of the
link's baby SELECT / DELETE, INSERT with `excluded_by = auth_uid()`; `pipeline` SELECT;
`service_role` ALL; `viewer` and contributors nothing. `shared_photo_exclusions_guard`: the photo
belongs to the link's baby. Adding the photo back by hand deletes the exclusion (API).

**Auto-share rules (D3, D5).** `share_rules_shape` (SECURITY DEFINER, every role): ≤ 20 tags per
list, each 1..60 characters, NFC, trimmed, single inner spaces, lower-case (`normalizeShareTag` is
the writer; this is the backstop), `mode = 'tags'` needs an include tag, and the baby must be
`baby_ai_enabled` (`auto-share rules need the paid plan`). DELETE is always allowed (a downgraded
baby can remove its rule). `authenticated` may write only `mode, include_tags, exclude_tags` (+
`share_link_id` on insert). `evaluated_at` is the worker's sync watermark: `pipeline` may UPDATE only
that column, and it does not move `updated_at` (that trigger now fires on rule columns only), so
"rule changed since the last full sync" = `evaluated_at IS NULL OR evaluated_at < updated_at`.

**Passcode failures (D8).** `share_passcode_failures (id, share_link_id, ip_hash bytea(32),
created_at)`, `service_role` only (no other grant). Limits, counted only after `token_rotated_at`
(so regenerate clears both): 5 per (link, IP hash) per 15 minutes ⇒ `rate_limited`, 20 per link per
60 minutes ⇒ `passcode_locked`. The exchange calls **`share_passcode_lock_state(p_share_link_id uuid,
p_ip_hash bytea) RETURNS TABLE (ip_failures integer, ip_retry_at timestamptz, link_failures integer,
link_retry_at timestamptz)`** (service_role; takes a transaction-scoped advisory lock on the link so
concurrent attempts serialise, then returns both counts and, at or above each limit, when it lifts),
checks both limits before verifying, inserts a failure row on a wrong code, prunes that link's rows
older than 24 h and commits. **`share_link_passcode_locked(p_share_link_id uuid) RETURNS boolean`**
(`authenticated`, `service_role`): the admin card's "Passcode locked"; false unless the caller
administers the link's baby (or is `service_role`).

**Who may write what.**

| Table | `authenticated` (admins of the baby) | `viewer` | `pipeline` | `service_role` |
| --- | --- | --- | --- | --- |
| `share_links` | INSERT/UPDATE/DELETE (hash columns write-only; never `token_rotated_at`), SELECT without hashes | SELECT own active row (no hashes) | SELECT id, baby_id, expires_at, revoked_at | ALL |
| `share_rules` | SELECT/DELETE; INSERT/UPDATE of the rule columns (paid babies) | – | SELECT, UPDATE (`evaluated_at`) | ALL |
| `shared_photos` | SELECT/DELETE; INSERT/UPDATE as `user` rows attributed to themselves | SELECT (no user ids), visible rows only | SELECT, INSERT + DELETE of `rule` rows | ALL |
| `shared_photo_exclusions` | SELECT/INSERT/DELETE | – | SELECT | ALL |
| `viewer_sessions` | SELECT (no hashes) | via `viewer_session_check()` only | – | ALL |
| `share_passcode_failures` | – (`share_link_passcode_locked()` only) | – | – | ALL |

Contributors gain nothing: every sharing policy requires `is_baby_admin`.

**Error mapping for the API** (`apps/api/src/lib/errors.ts`): `share link limit reached` ⇒ 409;
`a revoked share link cannot be renewed` / `a revoked share link can only be reactivated with a new
token` ⇒ 409; `auto-share rules need the paid plan` ⇒ 403 `plan_required`; `share rule needs at least
one include tag`, `share_rules tags …`, `share_links.…`, `share link expiry must be within 30 days`
⇒ 400 `validation_failed`; the gate's messages on a manual add (`photo does not belong …`, `only
approved, non-deleted photos …`, `a sensitive photo can only be shown …`) ⇒ 409; `share link is not
active` (session insert raced a revoke) ⇒ 410 `share_link_expired`.

## Native push (step 9)

Migration `1792200000100_native-push.sql` (docs/plans/step-9.md 2.8, 2.9). Push is opt-in on the
device (OS permission + "Turn on notifications"); the two `profiles` booleans are per-kind
opt-outs. Text is generic and fixed in `@tinyglow/shared` `pushMessage(kind, count)`; nothing
in these tables or functions carries a name, caption or note.

**Tables.** `push_devices` (one row per GoTrue session that turned notifications on: `user_id`,
`session_id`, `platform` ios|android, `provider` apns|fcm with ios⇔apns, `token` 8..4096 chars
without whitespace, `app_version`, `created_at`, `last_registered_at`, `disabled_at` +
`disabled_reason` 'invalid_token'). Uniqueness is on `digest(token, 'sha256')` (a btree on the raw
token would reject tokens above ~2,700 bytes, and a violation's DETAIL would print the token).
`push_devices_shape` (BEFORE INSERT/UPDATE) checks every shape rule with fixed text before the
CHECKs run, so no error ever echoes a token. `push_deliveries` (ledger: device, user, baby,
optional share link, `kind` photos_analyzed|share_viewed, `status`
sent|fake|failed|invalid_token|unconfigured, `item_count`, `created_at`). Ledger rows are per
user: when a device row goes (unregister, sign-out prune, token moved) `device_id` becomes NULL and
the row stays, so `push_targets`' `last_sent_at` (latest `sent`/`fake` row for user + baby + kind)
and therefore the `PUSH_MIN_GAP_MIN` gap survive signing out and back in. Rows are deleted with
the profile (account deletion) or the baby, and each delivery prunes that user's rows older than
30 days (NULL-device rows included). Both ENABLE + FORCE RLS.

**Functions** (SECURITY DEFINER, `search_path` pinned, REVOKEd from PUBLIC, fixed error text):

| Function | Granted to | Behaviour |
| --- | --- | --- |
| `register_push_device(p_platform text, p_provider text, p_token text, p_app_version text) RETURNS uuid` | `authenticated` | Needs `auth_uid()` and the claims' `session_id` with a live session, else `push registration needs a session` (42501); shape errors are `check_violation`. Advisory-locked per token. A token held by another user or session moves here (old row deleted); other rows of this session are replaced (one device per session); the same token from the same session keeps its id, refreshes `app_version`/`last_registered_at` and clears a disable. Also deletes the caller's rows of dead sessions. Returns `push_devices.id`. |
| `unregister_push_devices_for_session() RETURNS integer` | `authenticated` | Deletes the caller's rows for the claims' `session_id`; 0 without claims. |
| `push_targets(p_baby_id uuid, p_kind text) RETURNS TABLE (device_id uuid, user_id uuid, provider text, token text, last_sent_at timestamptz)` | `pipeline`, `service_role` | Unknown kind ⇒ `unknown push kind`. First deletes every device row whose session is no longer live (VOLATILE for that reason). Returns enabled devices of **admins** of the baby (never contributors), baby `deleted_at IS NULL`, profile `deleted_at IS NULL`, the kind's `notify_*` true, session live (row in `auth.sessions` for that user, `not_after` not passed, used within 90 days = `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT`); `photos_analyzed` also needs `baby_ai_enabled()` (else no rows). `last_sent_at` = latest `sent`/`fake` delivery to that user for (baby, kind). |
| `push_photos_analyzed_count(p_baby_id uuid, p_since timestamptz) RETURNS integer` | `pipeline`, `service_role` | `photo_ai` rows created after `p_since` for approved, live, unquarantined, non-duplicate photos of the baby. |
| `push_link_baby(p_share_link_id uuid) RETURNS uuid` | `pipeline` | The link's baby while that baby is live, else NULL. |
| `push_record_delivery(p_device_id uuid, p_baby_id uuid, p_share_link_id uuid, p_kind text, p_status text, p_count integer) RETURNS void` | `pipeline` | Validates kind/status/count and that the link belongs to the baby (`invalid_parameter_value`); a device deleted meanwhile records nothing; inserts the ledger row (user from the device); `invalid_token` ⇒ `disabled_at = now()`, `disabled_reason = 'invalid_token'`; prunes that user's rows older than 30 days (including rows whose device is gone). |

Sign-out, sign-out everywhere, per-device sign-out, idle expiry and account deletion all stop
pushes with no extra code path (the session row disappears or ages out; profiles cascade).

**Who may read/write what.**

| Table | `authenticated` | `viewer` | `pipeline` | `service_role` |
| --- | --- | --- | --- | --- |
| `push_devices` | own rows: SELECT `id, platform, provider, app_version, created_at, last_registered_at, disabled_at` (never `token`, `session_id`, `user_id`, `disabled_reason`; `SELECT *` fails), DELETE; INSERT/UPDATE only through the functions | – | – (functions only) | ALL |
| `push_deliveries` | – | – | – (functions only) | ALL |
| `profiles.notify_photos_analyzed`, `notify_share_viewed` | SELECT (existing policy), UPDATE own row | – | – | ALL |

**Error mapping for the API**: `push registration needs a session` / `needs a profile` ⇒ 401
`session_revoked` (or 403); `push registration has an invalid platform or provider`,
`push_devices.token has an invalid shape`, `push_devices.app_version has an invalid shape` ⇒ 400
`validation_failed` (the request schema rejects these first).

## Review hardening and data exports

Migrations `1792300000100_review-hardening.sql` and `1792300000200_data-exports.sql`
(docs/plans/review-fixes.md 2.1, D11–D13; PRD FR-1.5, FR-10.1, "Roles and permissions").

**FR-1.5 in policy text (D11).** `baby_members_authenticated_update` is
`USING (is_baby_admin(baby_id) AND (role <> 'admin' OR user_id = auth_uid()))`,
`baby_members_authenticated_delete` is
`USING (user_id = auth_uid() OR (is_baby_admin(baby_id) AND role <> 'admin'))`. Promoting or
removing a contributor, stepping down, leaving and confirming a removal request (the target
deletes their own row) still work; demoting or deleting the other admin directly affects 0 rows.

**Profiles (D12).** `profiles_authenticated_select` is `USING (user_id = auth_uid())`: a self-read
keeps every granted column (consent versions, timezone, units, `notify_*`), nobody else's row is
visible. Co-member display data comes only from the view

```sql
public.member_profiles (user_id uuid, display_name text, relationship_label text)
  -- WITH (security_barrier); rows: deleted_at IS NULL AND (user_id = auth_uid() OR shares_baby_with(user_id))
```

`GRANT SELECT` to `authenticated` only (not `viewer`, `pipeline`, `service_role`; under
`service_role` it returns nothing because `auth_uid()` is NULL). The view is owned by the
migration superuser, so it reads `profiles` past RLS and its WHERE is the policy. Join it as
`LEFT JOIN public.member_profiles mp ON mp.user_id = …` wherever API code shows another member's
name. `pipeline` keeps its 3-column `profiles` grant. Not in the generated types (views are not
generated).

**Photos approval columns (D13).** `photos_user_update_guard` (BEFORE INSERT OR UPDATE, function
`photos_user_write_guard`, SECURITY INVOKER) acts only when `current_user = 'authenticated'`:

| Actor | Write | Result |
| --- | --- | --- |
| contributor (not admin) | UPDATE changing `is_sensitive`, `approval`, `approved_by` or `approved_at` | **42501** `contributors may only trash their own pending uploads` (same SQLSTATE as the RLS denial it replaces, so the API's 403 mapping holds) |
| contributor | UPDATE `deleted_at` of own pending upload | allowed (policy unchanged) |
| admin | UPDATE to `approval = 'approved'` from anything else | `approved_by := auth_uid()`, `approved_at := now()` whatever was supplied |
| admin | any other UPDATE changing `approved_by` / `approved_at` | 23514 `approved_by and approved_at are set by the database when a photo is approved` |
| admin | INSERT `approved` with `approved_by` NULL | filled with `auth_uid()` / `now()` (the upload path inserts this shape) |
| anyone | INSERT `approved` with another `approved_by`, or non-approved with any `approved_by` | `new row violates row-level security policy` (`photos_authenticated_insert`) |

`pipeline`, `service_role`, the superuser and SECURITY DEFINER functions (e.g. the AI sensitive
sync) are not affected.

**`data_exports` (FR-10.1).** One row per export request; the ZIP is at the generated
`storage_key = babies/<baby_id>/exports/<id>.zip`. `status` queued → running → ready | failed,
then expired once purged; `error` storage_error | too_large | requester_not_admin | internal.
`expires_at` defaults to `now() + 7 days`. ENABLE + FORCE RLS.

| Role | Read | Write |
| --- | --- | --- |
| `authenticated` | admins of the baby (both admins see every export, D3): every column **except** `storage_key` (`SELECT *` / `RETURNING *` fail: name columns) | INSERT `(baby_id, requested_by, include_location)` with `is_baby_admin(baby_id) AND requested_by = auth_uid()`; UPDATE `(expires_at, downloads, last_downloaded_at)` as admin, where `expires_at` may only move earlier and the counter only forward; no DELETE |
| `viewer` | – | – |
| `pipeline` | all rows, all columns | UPDATE `(status, error, photo_count, photos_done, bytes, started_at, finished_at, purged_at)`; DELETE only rows with `purged_at` older than 30 days |
| `service_role` | ALL | ALL |

Triggers (fixed messages, 23514): `data_exports_baby_live` `cannot export a trashed album`;
`data_exports_rate_limit` (locks the baby row `FOR NO KEY UPDATE`) `an export is already in
progress for this album` (a queued/running row exists; the partial unique index
`data_exports_one_active_per_baby` is the backstop) and `export rate limit reached: 3 per album
per day` (≥ 3 rows created in the last 24 h, any status); `data_exports_user_update_guard`
`an export cannot be extended` / `export download history cannot be rewritten`.
FKs: `baby_id` ON DELETE CASCADE (baby purge removes the rows), `requested_by` ON DELETE SET NULL
(account deletion; the hourly purge then deletes the ZIP).

Worker functions (SECURITY DEFINER, pinned `search_path`, EXECUTE to `pipeline` only):

| Function | Returns |
| --- | --- |
| `export_requester_is_admin(p_export_id uuid) RETURNS boolean` | true while the requester has a live profile and is an admin of the export's baby; the gate before any GPS decryption |
| `export_requester_email(p_export_id uuid) RETURNS text` | `auth.users.email` of the requester only when `status IN ('ready','failed')`, the requester is still an admin and the profile is live; else NULL. Never log it |

Export worker read grants added: `babies (name, nickname, birth_date_is_due_date,
birth_weight_g, birth_length_mm, home_label)` and `baby_members (baby_id, user_id, role,
joined_at)` with `baby_members_pipeline_select USING (true)`. Everything else it reads
(`profiles` 3 columns, `photos`, `photo_exif`, `photo_details`, `milestones`, `measurements`,
`photo_ai`, `photo_ai_overrides`, `audit_log` INSERT with actor NULL) was already granted.

**Retention.**

| Data | Where | Retention |
| --- | --- | --- |
| Postgres backups | `pg_dump` by the `backup` service (`docker/backup/pg-backup.sh`) | `BACKUP_RETENTION_DAYS` (default 35) |
| GoTrue audit log | `auth.audit_log_entries` (GoTrue-owned); payloads hold actor **emails and IP addresses** | **no built-in retention.** Recommended: prune rows older than 90 days (`DELETE FROM auth.audit_log_entries WHERE created_at < now() - interval '90 days'` as the superuser, e.g. from the backup job). Deferred (review-fixes D20); until then it grows forever and every backup carries it |
| Export ZIPs | MinIO `babies/<id>/exports/` | until `expires_at` (7 days), or earlier on admin expiry, requester removal/deletion or a failed export; removed by `purge.trash` (all versions), which sets `purged_at` |
| `data_exports` rows | Postgres | deleted by `purge.trash` 30 days after `purged_at`; immediately with the baby |

## Photo import (step 10)

Migration `1792300000300_photo-import.sql` (docs/plans/step-10.md 2.2, decisions D1, D3, D6, D8,
D10; PRD FR-2.1–2.7, FR-4, "Roles and permissions", "Privacy and child safety"). Four tables, all
ENABLE + FORCE RLS, none granted to `viewer`.

**Secrets at rest.** `encrypt_secret(text) → bytea` / `decrypt_secret(bytea) → text`: pgcrypto
(`aes256`) under `app.data_key`, exactly like `encrypt_coord` (SECURITY INVOKER, STRICT, raise
`data key not set for this transaction` without the key). EXECUTE to **`service_role` only**: the
API connects / disconnects Google under `service_role` with the data-key GUC bound; the worker
never encrypts and decrypts only through `import_google_refresh_token()`. Never log either side.

**`import_sources`** (Apple Photos album sync status; one row per `(device_id, baby_id, kind)`).
Counters, last run, last trigger, last error, `wifi_only`, `paused`, `device_label`, `album_title`.
**Never** PHAsset identifiers, hashes of them, file names or paths (D3). `kind` is
`apple_photos` only.

| Role | Read | Write |
| --- | --- | --- |
| `authenticated` | admins of the baby: every row; others: their own rows | INSERT `(baby_id, user_id, kind, device_id, device_label, album_title, wifi_only)` with `user_id = auth_uid()`, member, and **admin for `apple_photos` (D1)**; UPDATE status columns of own rows (an `apple_photos` row only while still admin); DELETE own rows or any row of a baby they admin |
| `pipeline`, `viewer` | – | – |
| `service_role` | ALL | ALL |

- The owner must stay a member: composite FK `(baby_id, user_id) → baby_members` ON DELETE
  CASCADE (leaving, removal and account deletion drop the row). Demotion from admin deletes the
  user's `apple_photos` rows of that baby (`baby_members_drop_apple_sync`, AFTER UPDATE OF role).
  The client must treat a 404 on `PATCH /import-sources/:id` as "sync turned off".
- Upserts: `INSERT … ON CONFLICT (device_id, baby_id, kind) DO UPDATE SET … WHERE
  import_sources.user_id = auth_uid() RETURNING id` returns **0 rows** when another user owns that
  device row (map to 409 `import_source_exists`); without the `WHERE` it raises `new row violates
  row-level security policy (USING expression)`.
- Triggers (23514, fixed messages): `import_sources_shape` (`device_label` 1–60, `album_title`
  1–120, trimmed, no control characters; counters ≥ 0; all parent text, so no non-enum CHECK),
  `import_sources_insert_guard` (`cannot sync into a trashed album`; `import source limit reached`
  at 10 per baby, not counting the row an upsert would update), `set_updated_at`.

**`google_accounts`** (one Google Photos Picker connection per user).

| Role | Read | Write |
| --- | --- | --- |
| `authenticated` | own row, columns `user_id, connected_at, last_used_at, needs_reconnect` only | – |
| `pipeline`, `viewer` | – (no table grant) | – |
| `service_role` | ALL | ALL (connect upsert with `encrypt_secret`, disconnect delete) |

`refresh_token_enc` is never granted to a user role or to `pipeline`. `google_accounts_shape`
(trigger, not CHECKs: the only writer bypasses RLS, so a failing CHECK would log the row) raises
fixed messages for a NULL/oversized ciphertext (e.g. `encrypt_secret(NULL)`), an empty scope or a
negative `refresh_failures`. FK `user_id → profiles` ON DELETE CASCADE.

**`import_batches`** (one Google Picker session per batch). `status`: `picking → queued → running →
done | failed`; `picking → cancelled | expired`; `queued | running → cancelled` once
`cancel_requested_at` is set (the worker finishes it). `error`: `google_denied`,
`google_reconnect`, `session_expired`, `storage_error`, `requester_not_member`, `baby_trashed`,
`too_many_items`, `internal`.

| Role | Read | Write |
| --- | --- | --- |
| `authenticated` | admins: every batch of the baby; others: their own while a member. Every column **except `provider_session_id`** (`SELECT *` / `RETURNING *` fail: name columns) | INSERT `(baby_id, requested_by, kind, tz_hint, provider_session_id)` with `requested_by = auth_uid()`, member (**contributors too**, D1), `status = 'picking'`; UPDATE `(status, provider_session_id, poll_interval_sec, picker_expires_at, last_polled_at, cancel_requested_at, finished_at, updated_at)` of own batches, per the transition matrix |
| `pipeline` | all rows, all columns | UPDATE `(status, error, started_at, finished_at, items_total, items_imported, items_duplicate, items_failed, items_skipped, updated_at)` |
| `viewer` | – | – |
| `service_role` | ALL | ALL |

- `import_batches_user_transitions` (BEFORE UPDATE, `authenticated` only, 23514 `import batch
  transition not allowed`): `picking → picking | queued | cancelled | expired`;
  `provider_session_id` is set once; `queued` requires it; `finished_at` only when leaving to
  `cancelled`/`expired`. `queued | running`: only `cancel_requested_at` may change, and only from
  NULL. Terminal statuses: nothing. Counters, `items_total` and `error` are not granted to users.
- `import_batches_one_active` (BEFORE INSERT, every role; locks the baby row `FOR NO KEY
  UPDATE`): `cannot import into a trashed album`; then any `picking` batch of the baby past
  `picker_expires_at` (or 30 min old without one) is set `expired` so an abandoned picker does not
  block the album; then `an import is already in progress for this album` (one
  picking/queued/running batch per baby; partial unique index `import_batches_one_active_per_baby`
  is the backstop) and `import rate limit reached: 20 per album per day`.
- FKs: `baby_id` ON DELETE CASCADE; `requested_by` ON DELETE SET NULL (the worker's next
  `import_book_photo` returns `not_member`).
- `poll_interval_sec` CHECK 1..60: the API clamps Google's `pollInterval` to
  `[IMPORT_PICKER_POLL_MIN_SEC, 60]`.

**`import_items`** (one picked media item; `id` becomes `photos.id`; `storage_key` generated
`babies/<baby_id>/originals/<id>`; `photo_id` CHECK `= id`).

| Role | Read | Write |
| --- | --- | --- |
| `authenticated` | `(id, batch_id, baby_id, status, error, photo_id, created_at)` of visible batches (`import_batch_visible`, SECURITY INVOKER); never `provider_item_id` | – |
| `pipeline` | all | INSERT; UPDATE `(bytes, sha256, status, error, photo_id, mime_hint, width, height, taken_at_hint, updated_at)`; DELETE when not `downloaded`, last changed > 30 days ago, and terminal or of a finished batch |
| `viewer` | – | – |

`import_items_batch_guard` (BEFORE INSERT): the item's batch must be `queued`/`running` and of the
same baby (`import item must belong to an active batch of the same album`), so an object key and
the photo it becomes can never land in another album.

**Worker functions** (SECURITY DEFINER, pinned `search_path`, EXECUTE to `pipeline` only):

| Function | Returns |
| --- | --- |
| `import_batch_requester_state(p_batch_id uuid) RETURNS text` | `ok`, `not_active` (missing or not queued/running), `not_member` (requester NULL, profile deleted or not a member), `baby_trashed`, `not_connected`, `reconnect`. No secret; lets the worker choose the batch error |
| `import_google_refresh_token(p_batch_id uuid) RETURNS text` | the requester's decrypted refresh token only while the batch is `queued`/`running`, the requester is a live member of the live baby and `needs_reconnect = false`; else NULL. Needs `app.data_key` (`runAsPipeline(pool, { dataKey })`), raises `data key not set for this transaction` without it. **Never log the result** |
| `import_mark_reconnect(p_batch_id uuid) RETURNS void` | sets `needs_reconnect = true`, `refresh_failures + 1` for the requester of an active batch (after `invalid_grant`) |
| `import_book_photo(p_item_id uuid) RETURNS text` | `booked` / `duplicate` / `free_tier_limit` / `not_member` / `baby_trashed` (D10, below) |

`import_book_photo` reads only the item and its batch (nothing from the caller but the id), takes
the requester's `baby_members` row `FOR SHARE` (role at run time; profile must be live), checks the
baby is live, then inserts `photos (id = item.id, baby_id, uploaded_by = requester,
storage_key_original = item.storage_key, mime = mime_hint, bytes, sha256, taken_at = taken_at_hint,
taken_at_estimated = true)` with **admin ⇒ `approved`, `approved_by = requester`, `approved_at =
now()`; contributor ⇒ `pending`, `approved_by` NULL**, the same shape `photos_authenticated_insert`
allows. `photos_free_tier_cap` fires (⇒ `free_tier_limit`); a `photos_baby_id_sha256_key`
violation ⇒ `duplicate`. On `booked` the item becomes `booked` with `photo_id = id`; every other
result leaves it `downloaded` for the worker to mark (and delete the object). Raises (fixed
messages): `import item not found` (P0002), `import item is not ready to book` (23514: not
`downloaded`, or bytes/sha256/mime_hint missing; also a second call on a booked item),
`import batch is not running` (23514), `import item could not be booked` (23505/23514, any other
constraint). Ingest then re-hashes and sets the same `sha256`, and its `upload_files` updates
match no row.

Worker read grants: nothing new was needed (`photos (id, baby_id, sha256, deleted_at, status)`
and `babies (id, deleted_at)` were already readable by `pipeline`).

**Retention.**

| Data | Retention |
| --- | --- |
| `google_accounts` | until disconnect or account deletion (the API revokes at Google first) |
| `import_sources` | until the owner turns sync off, leaves / is removed / is demoted (admin) or deletes the account; with the baby |
| `import_batches` | kept (ids, counts, status; no Google ids readable by users); with the baby |
| `import_items` | 30 days after the last change once terminal / the batch finished (`import.sweep`); with the batch or the baby |


## Store-review family (`src/review-family.ts`)

`pnpm db:review-family --email <address> [--confirm-production]` (one transaction;
docs/plans/step-9.md 2.9 item 6, 2.11, D4). It needs the **superuser** `DATABASE_URL` (it reads
`auth.users` and writes past RLS, like `db:plan`): the `migrate` container already has it; on
the host export it yourself (the api/worker role URLs are refused by RLS and grants). For an **existing** GoTrue user with a
live profile it creates or refreshes baby "Sunny" (born 10 months before the first run; the birth
date is kept on re-runs), the user as admin, plan `plus` owned by that user (no billing), 24 photo
rows (`uploaded`, approved, `image/jpeg`, originals `babies/<babyId>/originals/<photoId>.jpg`,
the demo seed's pattern, `created_at` spread over the 10 months so ingest's no-EXIF fallback gives
plausible ages), parent details on 8 photos
(First smile / First food / First steps, people "Grandma" and "Dad", short notes) and 4
measurements, plus `baby.created` / `baby.plan_changed` audit rows (`actor_user_id` NULL). Every id
is `reviewId(userId, label)` (sha256-derived, UUID version 8), so re-runs touch the same rows;
existing photo rows are never reset. Prints ids and counts only.

Every review object lives under the baby prefix `babies/<babyId>/`, like any uploaded photo, so
the worker's `purge.trash` removes it with a purged photo (`photoPrefixes`: the original key
starts with `babies/<babyId>/originals/<photoId>`) or a purged baby (`babyPrefix`). Account
deletion covers it the same way: the review account is the sole admin of "Sunny", so deleting
the account first requires trashing the album (409 `sole_admin` otherwise), which `purge.trash`
then hard-deletes, objects included, within the 30-day window. No key outside `babies/` is
ever written for the review family.

Refusals: `NODE_ENV=production` without `--confirm-production`; no GoTrue user for the email; no
live profile; in production, any membership of the account in another baby (the review sign-in
must never open a real family; outside production this is a warning so the dev check can use
`demo-dad@tinyglow.local`). Exit codes 0 / 1 refused or failed / 2 usage.

The id rule lives in `src/review-ids.ts` (only `node:crypto`), exported as the subpath
`@tinyglow/db/review` (`reviewId`, `reviewBabyId`, `reviewPhotoId`) so the api can import it
without the package root (`pg`, `node-pg-migrate`). The api's review sign-in
(`apps/api/src/auth/review.ts`, task 9.10) refuses, in **every** environment, an account that
belongs to any baby other than `reviewBabyId(userId)` (403 before any session exists), and while
the review account is enabled it cannot accept invites. So the script's dev-only warning case
(`demo-dad`, who is in the demo families) can be provisioned but cannot use the review sign-in;
try the sign-in in dev with a fresh account instead (sign up once, then run the script for it).

Runbook (production needs the user's approval, plan 5.2 U12):
1. Sign up once in the app with the review email (normal email code) and accept the terms.
2. `docker compose run --rm migrate pnpm db:review-family --email <review email> --confirm-production`
   (the `migrate` container has the superuser `DATABASE_URL`; from the host, export it first).
3. `docker compose exec worker node apps/worker/dist/demo-media.js --review-baby <babyId> --confirm-production`
   (worker, task 9.12; the production worker image has no `pnpm`) writes the 24 illustrations and
   runs the normal ingest. In dev: `docker compose -f docker-compose.dev.yml exec worker pnpm demo:media --review-baby <babyId>`. Until it runs, the worker's `ingest.reconcile` cron
   retries these `uploaded` rows every 5 minutes and logs a fetch failure (ids only); once the
   objects exist reconcile alone would ingest them.
4. Set `REVIEW_ACCOUNT_EMAIL` and `REVIEW_ACCOUNT_CODE_HASH` (`sh docker/tools/review-code-hash.sh`)
   on the api only. If App Review deletes the account, repeat from step 1.

## Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | all scripts | Superuser URL (`db-init`, `migrate`, seed, `db:types`). The api/worker get their own role URLs from Compose. |
| `AUTH_DB_PASSWORD` | bootstrap | `supabase_auth_admin`; must equal the password in `GOTRUE_DB_DATABASE_URL`. |
| `API_DB_PASSWORD` | bootstrap | `tinyglow_api`; must equal the api's `DATABASE_URL` password. |
| `WORKER_DB_PASSWORD` | bootstrap | `tinyglow_worker`; must equal the worker's `DATABASE_URL` password. |
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
| `pnpm db:review-family --email <addr> [--confirm-production]` | Store-review family for an existing user (see "Store-review family"); refuses in production without the flag |
| `pnpm --filter @tinyglow/db db:types` | Regenerate `src/generated/tables.ts` from the migrated DB (CI diffs it) |
| `pnpm --filter @tinyglow/db db:migrate:create <name>` | New empty `migrations/<ms-timestamp>_<name>.sql` |

Programmatic use: `import { runMigrations, bootstrap, seed, ensureAuthSchemaStub, appRoleUrl } from "@tinyglow/db"`;
row types from `@tinyglow/db/types` (`PhotosRow`, `PhotosInsert`, `TABLE_NAMES`, …; `text`
columns with `CHECK (col IN (...))` are string-literal unions, including the single-value form Postgres stores as `CHECK ((col = 'x'::text))`).

### Tests and CI without GoTrue

`ensureAuthSchemaStub(client)` creates a minimal `auth.users` / `auth.identities` /
`auth.sessions` / `auth.refresh_tokens` only when `auth.users` does not exist (bare pgvector in
CI, throwaway containers). The `users`/`identities` column list is exactly what the seed inserts;
`sessions` and `refresh_tokens` carry the same column names and types as `supabase/auth:v2.197.0`
(minus the FK to `auth.oauth_clients`) so the session functions and the API integration tests
(which insert session rows) behave the same on the stub and on the real schema.
`appRoleUrl(databaseUrl, role, password)` rewrites the superuser URL to connect as
`tinyglow_api` / `tinyglow_worker` for RLS tests.

## Demo seed (`src/seed.ts`)

Fixed ids (`DEMO` export): users `…-000000000001/2/3` = `demo-mom@tinyglow.local` (admin, Maria,
Mom), `demo-dad@…` (admin, Dad), `demo-nanny@…` (contributor); baby `…-000000000100` "Maya"
("Mimi", born 2025-06-30, `plan = plus`, encrypted home coordinates); share link `…-000000000200`
"Grandparents" (dev token `demo-grandparents-share-token` = `DEMO_IDS.shareToken`, only its sha256
stored; `ttl_hours = 24`, re-upserted so it always expires 24 h after the last seed run, no
passcode; a revoked demo link is deleted and recreated because a revoked link cannot be revived
with the same token; rule `milestones`); 12 photos `…-0000000003NN` (all `image/jpeg`, originals `babies/<baby>/originals/<photo>.jpg`): 8 approved, 1 approved and
sensitive (bath, with a `photo_ai` row), 1 approved and trashed, 2 pending from the nanny;
4 shared photos, all hand-picked by mom: 2, 9, 10 and the bath photo 4, which is **not released**
(viewers get a hidden tile and cannot read its derivatives); 3 measurements; `photo_search` rows for the 9 live approved photos (with `place`;
`embedding`, `embed_model`, `doc_version`, `content_hash` and `embedded_at` NULL, also reset on every
re-seed, so the worker's `search.reconcile` rebuilds and embeds them); one audit row.
The seed writes no image bytes: in dev the worker's `ensureDemoMedia()` (step 9, task 9.12)
puts metadata-free JPEG illustrations of non-real babies at those keys and writes the derivatives.
Re-seeding never clobbers the real sizes it wrote: `photos.width/height/bytes` are placeholders on
first insert only, and an existing `photo_derivatives` row is left untouched unless its
`storage_key` differs (then it is restored whole and the worker corrects the sizes again).

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
docker run --rm -d --name ll-db-test -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=tinyglow pgvector/pgvector:0.8.7-pg17
export DATABASE_URL=postgres://postgres:dev@localhost:55432/tinyglow AUTH_DB_PASSWORD=dev \
  API_DB_PASSWORD=dev WORKER_DB_PASSWORD=dev DATA_ENCRYPTION_KEY=dev-only-data-encryption-key-32-chars-min SEED_DEMO_FAMILY=true
pnpm db:bootstrap
# auth.users: either run GoTrue's migrations ...
docker run --rm --network container:ll-db-test -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:dev@localhost:5432/tinyglow \
  -e GOTRUE_JWT_SECRET=dev-only-jwt-secret-dev-only-jwt-secret -e GOTRUE_SITE_URL=http://localhost:8080 \
  -e API_EXTERNAL_URL=http://localhost:8080/auth supabase/auth:v2.197.0 auth migrate
# ... or, for a stub, `ensureAuthSchemaStub(client)` from a script/test.
pnpm db:migrate && pnpm db:migrate     # second run: "nothing to do"
pnpm db:seed && pnpm db:seed           # identical counts
pnpm db:migrate:down all && pnpm db:migrate && pnpm db:seed
pnpm --filter @tinyglow/db db:types && git diff --exit-code -- packages/db/src/generated
docker stop ll-db-test
```

Spot checks (password `dev` for the app roles):

```sh
PSQL="psql -h localhost -p 55432 -d tinyglow -Atv ON_ERROR_STOP=0"
# another user's baby: 0 rows
PGPASSWORD=dev $PSQL -U tinyglow_api -c "begin; set local role authenticated; select set_config('request.jwt.claims','{\"sub\":\"00000000-0000-4000-8000-0000000000ff\",\"role\":\"authenticated\"}',true); select count(*) from photos; rollback;"
# contributor cannot delete: permission denied for table photos
PGPASSWORD=dev $PSQL -U tinyglow_api -c "begin; set local role authenticated; select set_config('request.jwt.claims','{\"sub\":\"00000000-0000-4000-8000-000000000003\",\"role\":\"authenticated\"}',true); delete from photos; rollback;"
# viewer sees only shared_photos: 4, 4, permission denied for table photo_exif
PGPASSWORD=dev $PSQL -U tinyglow_api -c "begin; set local role viewer; select set_config('request.jwt.claims','{\"role\":\"viewer\",\"share_link_id\":\"00000000-0000-4000-8000-000000000200\"}',true); select count(*) from shared_photos; select count(*) from photos; select count(*) from photo_exif; rollback;"
# viewer media: 3 photos with readable derivatives, 0 rows for the unreleased bath photo
PGPASSWORD=dev $PSQL -U tinyglow_api -c "begin; set local role viewer; select set_config('request.jwt.claims','{\"role\":\"viewer\",\"share_link_id\":\"00000000-0000-4000-8000-000000000200\"}',true); select count(distinct photo_id) from photo_derivatives; select count(*) from photo_derivatives where photo_id = '00000000-0000-4000-8000-000000000304'; rollback;"
# viewer gets nothing on upload tables: permission denied for table upload_sessions
PGPASSWORD=dev $PSQL -U tinyglow_api -c "begin; set local role viewer; select set_config('request.jwt.claims','{\"role\":\"viewer\",\"share_link_id\":\"00000000-0000-4000-8000-000000000200\"}',true); select count(*) from upload_sessions; rollback;"
# FR-1.5: mom cannot demote or delete dad (UPDATE 0, DELETE 0); co-member profiles only via member_profiles (0, then 3)
PGPASSWORD=dev $PSQL -U tinyglow_api -c "begin; set local role authenticated; select set_config('request.jwt.claims','{\"sub\":\"00000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}',true); update baby_members set role='contributor' where user_id='00000000-0000-4000-8000-000000000002'; delete from baby_members where user_id='00000000-0000-4000-8000-000000000002'; select count(*) from profiles where user_id <> auth_uid(); select count(*) from member_profiles; rollback;"
# Home label in SQL, pipeline only: Home, then <null> 200 m away; never a plaintext coordinate in the result
PGPASSWORD=dev $PSQL -U tinyglow_worker -c "begin; set local role pipeline; select set_config('app.data_key','dev-only-data-encryption-key-32-chars-min',true); select home_place_label('00000000-0000-4000-8000-000000000100', 47.6062, -122.3321), home_place_label('00000000-0000-4000-8000-000000000100', 47.6080, -122.3321); rollback;"
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
| `1791520000700_worker-heartbeats-app-role.sql` | `worker_heartbeats.updated_at`, FORCE RLS, grant + policy for `tinyglow_worker` | revert |
| `1791600000100_auth-sessions-and-plan.sql` | guard (`auth.sessions`); session functions `auth_session_info`, `list_user_sessions`, `delete_user_session`, `count_user_sessions` (SECURITY DEFINER, `authenticated` only, no grants on `auth.*`); `baby_members.removal_requested_by/_at` (service_role-written); `babies_plan_follows_owner` + `baby_members_release_plan` triggers | drop triggers, functions, columns |
| `1791700000100_uploads-and-ingest.sql` | `photos.status` gains `duplicate`, `photos.quarantined_at` (pipeline-only UPDATE), `quarantined_at IS NULL` on the user SELECT/UPDATE policies and in `photo_editable` / `babies_avatar_guard`, `photos_pipeline_delete` = trash > 30 d and not quarantined OR `status = 'duplicate'`; `free_tier_photo_count` helper + `photos_free_tier_cap` no longer counts failed/duplicate/quarantined rows; `baby_has_quarantined_photos` helper + `babies_pipeline_delete` refuses a baby holding a quarantined photo; `upload_sessions`, `upload_files` (+ `upload_session_visible`, `upload_files_session_owner` trigger, RLS, column grants); `home_place_label` (×2, pipeline/service_role) | drop functions, trigger, tables; restore `babies_pipeline_delete` and the step-2 cap trigger body, drop the two helpers; restore the four photos policies and two functions; drop column; `DELETE … WHERE status = 'duplicate'` then restore the old CHECK |
| `1791900000100_ai-pipeline.sql` | `photos.ai_retry_requested_at` (+ `UPDATE` grant to `authenticated`); `ai_batches` provider file ids, `files_deleted_at`, versions, `reasoning_tokens`/`image_tokens`, `request_counts`, `last_polled_at`, `expires_at`, `submitted_bytes`, `ai_batches_open_idx`; `ai_batch_items` (ENABLE+FORCE RLS, pipeline/service_role ALL, authenticated column-limited SELECT via `photo_visible`, `ai_batch_items_guard`, 3 indexes); `ai_eligible_photos(...)` (pipeline/service_role); `ai_baby_month_cost_usd(...)` (authenticated/pipeline/service_role); `record_ai_budget_exceeded(uuid, text)` (SECURITY DEFINER, pipeline/service_role; inserts the `ai.budget_exceeded` audit row for a baby + `YYYY-MM` once, advisory-locked per (baby, month), returns whether it inserted; `pipeline` still has no SELECT on `audit_log`); `photo_ai_overrides_shape` extended to field/value shape (trigger now also `UPDATE OF value`) | restore the step-5 shape function/trigger verbatim; drop the three helpers, the table + guard, the index and columns; revoke + drop `ai_retry_requested_at` |
| `1791800000100_timeline-and-details.sql` | `photos_baby_id_sort_idx` (replaces `photos_baby_id_taken_at_idx`) + `photos_baby_id_age_days_idx`; `age_group(integer)` (IMMUTABLE; authenticated/viewer/pipeline/service_role); `milestones.updated_at` + trigger, `UPDATE (updated_at)` grant, `milestones_cap` (200 custom per baby), `milestones_name_guard` (1..80 chars, no preset names ⇒ 23505); `photo_details_milestone_id_photo_id_idx` (replaces `photo_details_milestone_id_idx`); `measurements_photo_same_baby` trigger, `measurements_photo_id_idx`; 14 CHECK constraints on parent-entered text dropped and re-stated as shape triggers (`photo_details_shape`, `measurements_shape`, `babies_shape`, `upload_sessions_shape`, `share_links_shape`, `chat_threads_shape`, `invites_shape`, `photo_ai_overrides_shape`; see "Shape triggers") | drop the new indexes/triggers/functions/column, recreate the two step-2 indexes and every dropped CHECK verbatim |
| `1792000000100_search-and-chat.sql` | `photo_search.doc_version/content_hash/embedded_at/place` + unembedded, (baby_id, place) and `lower_text_array(people)` GIN indexes; `lower_text_array(text[])`; `search_baby_ids()` and the `photo_search_authenticated_select` rewrite to `baby_id = ANY (ARRAY(SELECT search_baby_ids()))`; `photo_search_guard`, `photos_search_cleanup`, `photo_search_mark_stale` (5 triggers); `search_stale_photos(...)`, `photo_search_orphans(...)` (pipeline/service_role); `photo_search_text_candidates(...)`, `photo_search_term_candidates(...)` (SECURITY DEFINER, authenticated/service_role); `ai_spend` (ENABLE+FORCE RLS, `ai_spend_guard`); `ai_baby_month_cost_usd` = items + spend; `chat_threads (baby_id, user_id)` unique; `chat_messages.cited_measurement_ids/cost_usd/tools_used/status` + `chat_messages_shape`; `chat_turns` + `chat_reserve_turn(integer)`, `chat_user_turns_24h()`, `chat_messages_claim_turn` | drop all of it; restore the step-2 `photo_search` SELECT policy and the step-6 `ai_baby_month_cost_usd` body verbatim |
| `1792100000100_sharing-v1.sql` | `share_links.ttl_hours`, `token_rotated_at` (DB-maintained), `has_passcode` (generated); `share_links_shape` (+ ttl 1..720, expiry ≤ 30 days, hash format), `share_links_cap` (20/baby), `share_links_lifecycle` (no renew/un-revoke of a revoked link with the old token), `share_links_end_sessions`; `viewer_sessions.revoked_at` + `viewer_sessions_guard` + `viewer_session_check(uuid)`; `shared_photo_exclusions` (ENABLE+FORCE RLS, guard); `shared_photos.sensitive_released_at/_by`, narrowed user UPDATE grant, viewer column grant, `shared_photos_pipeline_delete` (rule rows); `shared_photos_gate` hardened (`FOR SHARE`, quarantine, analysed-only / exclusions / no release for rule rows, release normalisation); `photos_sensitive_unshare_rules` also clears releases; `viewer_link_id()`, `viewer_photo_ids()`, `viewer_media_photo_ids()`, `viewer_can_see_media(uuid)` and the four viewer policies rewritten on them; `share_rules.evaluated_at` (pipeline UPDATE), narrowed user grants, updated_at on rule columns only, `share_rules_shape` (tags, include tag, paid plan); `share_passcode_failures` (service_role only) + `share_passcode_lock_state(uuid, bytea)` + `share_link_passcode_locked(uuid)` | drop the new tables, functions, triggers, columns, index and policies; restore the step-2 gate, unshare trigger, viewer policies (photos: step 4), shared_photos/share_rules grants and policies, share_rules updated_at trigger, and the step-5 `share_links_shape`, verbatim |
| `1792200000100_native-push.sql` | guard (`auth.sessions`); `profiles.notify_photos_analyzed/notify_share_viewed` (default true, own-row UPDATE grant); `push_devices` (ENABLE+FORCE RLS, owner SELECT of safe columns + DELETE, unique `digest(token,'sha256')`, `push_devices_shape`) and `push_deliveries` (ENABLE+FORCE RLS, service_role only); internal `push_session_live`, `push_claims_session_id`; `register_push_device`, `unregister_push_devices_for_session` (authenticated); `push_targets`, `push_photos_analyzed_count` (pipeline/service_role), `push_link_baby`, `push_record_delivery` (pipeline) | drop the functions, both tables and the shape function; revoke and drop the two `profiles` columns |
| `1792200000200_photo-ai-tripwire-detach.sql` | `photo_ai_paid_tier_tripwire` exempts exactly one UPDATE shape: `batch_id` becomes NULL and every other column except `updated_at` is unchanged (whole-row jsonb compare), so deleting an `ai_batches` row (FK `ON DELETE SET NULL`) works when the batch holds photos of a free/lapsed/trashed baby; every other INSERT/UPDATE for such a baby is still refused (23514, same fixed message) | restore the step-2 tripwire body verbatim |
| `1792300000100_review-hardening.sql` | FR-1.5 in `baby_members_authenticated_update` / `_delete` (an admin row only by its owner); `profiles_authenticated_select` self-only + `member_profiles` view (security_barrier, 3 columns, live profiles, `authenticated` only); `photos_user_write_guard` + `photos_user_update_guard` trigger (contributors cannot touch approval/sensitivity columns; admin approval pins `approved_by`/`approved_at`; approved INSERT without approver gets the actor); `photos_authenticated_insert` requires `approved_by = auth_uid()` for approved rows and NULL otherwise | restore the step-2/4 policies verbatim; drop trigger, function and view |
| `1792300000200_data-exports.sql` | guard (`auth.users`); `data_exports` (ENABLE+FORCE RLS, generated `storage_key` not granted to `authenticated`, 5 indexes incl. `data_exports_one_active_per_baby`); `data_exports_baby_live`, `data_exports_rate_limit`, `data_exports_user_update_guard` triggers; `export_requester_is_admin`, `export_requester_email` (pipeline only); pipeline read grants on `babies` profile columns and `baby_members (baby_id, user_id, role, joined_at)` + `baby_members_pipeline_select` | drop the policy and revoke the two grants; drop functions, table, trigger functions |
| `1792300000300_photo-import.sql` | guard (`auth.users`); `encrypt_secret` / `decrypt_secret` (service_role only); `import_sources` (+ `import_sources_shape`, `import_sources_insert_guard`, composite FK to `baby_members`), `baby_members_drop_apple_sync` trigger; `google_accounts` (+ `google_accounts_shape`); `import_batches` (+ `import_batches_one_active`, `import_batches_user_transitions`, `import_batches_one_active_per_baby`); `import_items` (+ `import_items_batch_guard`), `import_batch_visible`; `import_batch_requester_state`, `import_google_refresh_token`, `import_mark_reconnect`, `import_book_photo` (pipeline only); all four tables ENABLE+FORCE RLS | drop the four functions, the `baby_members` trigger + function, the four tables and their trigger functions, `import_batch_visible`, `decrypt_secret`, `encrypt_secret` |
