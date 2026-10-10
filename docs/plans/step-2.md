# Step 2 plan: Database

Status: proposed (architect, 2026-10-08). PRD step: "Build handoff for Claude Code → Build order →
2. Database: all tables from Data model and Auth data model, RLS policies, helper functions, seed
with one demo family." Applies `CLAUDE.md` "Spec clarifications" (self-hosted GoTrue, MinIO
everywhere, contributors in v1, viewers get no chat, AI paid-tier only, free-tier photos never
sent to a model).

PRD sections this plan implements: "Data model" (+ "Search document (what gets embedded)"),
"Accounts and authentication → Roles and permissions / Invites / Share-link viewers (no account) /
Auth data model additions", "Non-functional requirements → Privacy and child safety (highest
priority) / Security", "Build handoff → Conventions" (reversible migrations; RLS changes need a test).

## 1. Goal

Create every table from the PRD's Data model and Auth data model additions as reversible
node-pg-migrate SQL migrations, with row-level security on every table keyed by `baby_id`
membership, `SECURITY DEFINER` helper functions (`is_baby_member`, `is_baby_admin`, …) that read
`baby_members` and never trust client claims, a narrowly scoped `viewer` role that can only reach
the `shared_photos` of one active share link, a bounded `pipeline` role for the worker, the
max-two-admins constraint + trigger, soft delete, pgcrypto encryption for GPS and home
coordinates, SQL-enforceable gates for the paid tier and sensitive content, an idempotent demo
family seed (dev only), generated TypeScript row types, and the switch of `api`/`worker` off the
Postgres superuser. End state: `docker compose -f docker-compose.dev.yml up` still starts every
service healthy from a clean clone, the step-1 smoke passes, and `pnpm test:integration` proves
the acceptance check: a user cannot read another baby's rows; a contributor cannot delete; a
viewer sees only `shared_photos`.

## 2. Interfaces first

Everything in this section is a contract. Agents build to it without asking each other;
deviations go through the orchestrator.

### 2.1 The `auth.users` ordering problem (decided: reorder Compose)

GoTrue creates `auth.users` in its own migrations, which run when the `auth` container starts.
Today `auth` starts after `migrate`, so a migration with `REFERENCES auth.users(id)` would fail on
a fresh database. Decision: **split the one-shot into two and let GoTrue migrate first.**

```
db ─► db-init (pnpm db:bootstrap: roles + auth schema) ─► auth (GoTrue migrates, then /health)
                                                              │
                                                              ▼
                                            migrate (pnpm db:migrate [&& pnpm db:seed]) ─► api, worker
```

- `db-init` runs the existing idempotent bootstrap (`packages/db/src/bootstrap.ts`), which is
  exactly what GoTrue needs before it starts (PRD "Compose requirements → Migrations").
- GoTrue's default command runs `migrate` then `serve`, so `auth` healthy ⇒ `auth.users` exists.
- `migrate` depends on `auth: service_healthy` (`db-init` is re-run inside `db:migrate`; it is
  idempotent). `api`/`worker` keep depending on `migrate: service_completed_successfully`.
- Why not the alternatives: a "deferred FK" migration that no-ops when `auth.users` is missing
  would be recorded as applied and never add the FK; pre-creating `auth.users` ourselves couples
  us to GoTrue's internal DDL. The FK (`profiles.user_id → auth.users(id) ON DELETE CASCADE`) is
  the standard Supabase pattern and gives real integrity.
- Guard: the first step-2 migration raises `auth.users is missing: start the auth (GoTrue)
  service before running migrations` when `to_regclass('auth.users') IS NULL`, so a wrong order
  fails loudly instead of silently.
- CI's `check` job runs integration tests against a bare pgvector service with no GoTrue. The
  test harness calls `ensureAuthSchemaStub(client)` (exported from `@tinyglow/db`, see 2.10)
  which creates a minimal `auth.users` / `auth.identities` only when they do not exist. The
  stub's column list is exactly the column list the seed inserts (2.9).

### 2.2 Postgres roles

Created/converged by the bootstrap (cluster-level, idempotent, not reversible, like step 1).
Migrations assume they exist and fail with a clear message otherwise.

| Role | Attributes | Purpose | Who assumes it |
| --- | --- | --- | --- |
| `postgres` | superuser | `db-init`, `migrate`, seed, `backup` only | never api/worker |
| `supabase_auth_admin` | existing (step 1) | GoTrue | GoTrue |
| `tinyglow_api` | LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE, password `API_DB_PASSWORD` | API connection role. **No privileges of its own on app tables**: NOINHERIT means a query outside `SET LOCAL ROLE` gets `permission denied`, never data | `api` (`DATABASE_URL`) |
| `tinyglow_worker` | LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER, password `WORKER_DB_PASSWORD`; `GRANT CREATE ON DATABASE` (pg-boss schema); direct `ALL` on `worker_heartbeats` | Worker connection role; heartbeat + pg-boss run as this role directly | `worker` (`DATABASE_URL`), `healthcheck.ts` |
| `authenticated` | NOLOGIN (exists) | Signed-in user; policies read `request.jwt.claims` | `tinyglow_api` via `SET LOCAL ROLE` |
| `viewer` | NOLOGIN, new | Share-link viewer; may read only the allow-list in 2.6 for one `share_link_id` claim | `tinyglow_api` via `SET LOCAL ROLE` |
| `service_role` | NOLOGIN (exists), **now `BYPASSRLS`**, `ALL` on every public table | API-internal operations with no user context: share-token exchange (reads `token_hash`/`passcode_hash`), viewer-session writes, invite/billing/account-deletion flows, audit writes | `tinyglow_api` via `SET LOCAL ROLE` only; **never the worker** |
| `pipeline` | NOLOGIN NOBYPASSRLS, new | Worker job role: cross-baby, but only the photo-pipeline tables/columns in 2.6; never invites, tokens, chat, members, viewer sessions | `tinyglow_worker` via `SET LOCAL ROLE` |
| `anon` | NOLOGIN (exists) | No grants on anything (kept only because GoTrue mints the claim) | nobody |

Memberships: `GRANT authenticated, viewer, service_role TO tinyglow_api WITH INHERIT FALSE, SET TRUE;`
`GRANT pipeline TO tinyglow_worker WITH INHERIT FALSE, SET TRUE;`

Why the asymmetry (service bypasses RLS, pipeline does not): the API is already the auth trust
boundary and uses `service_role` only in a few named code paths; the worker handles untrusted
image bytes and third-party model output (`text_in_image` prompt injection), so it gets the
tighter role (PRD "least-privilege keys for workers").

pg-boss: bootstrap creates schema `pgboss AUTHORIZATION tinyglow_worker` if missing (pg-boss's
own `CREATE SCHEMA IF NOT EXISTS` then no-ops; it still needs `CREATE ON DATABASE`, which Postgres
checks even with `IF NOT EXISTS`), and if a `pgboss` schema from step 1 already exists owned by
`postgres` (existing dev volumes) it transfers ownership of the schema and every table/sequence/
function/type in it to `tinyglow_worker`. `ALTER DEFAULT PRIVILEGES FOR ROLE tinyglow_worker
IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tinyglow_api` (+ sequences,
functions) so the API can enqueue jobs in step 4 without further grants.

### 2.3 Per-transaction identity (`request.jwt.claims`)

The API verifies the GoTrue JWT with `JWT_SECRET` (step 3) and, for every request-scoped unit of
work, runs on one pooled client:

```sql
BEGIN;
SET LOCAL ROLE authenticated;                                  -- or viewer / service_role
SELECT set_config('request.jwt.claims', $1, true);             -- $1 = JSON string, bind param
-- ... queries ...
COMMIT;                                                        -- SET LOCAL + set_config(local) vanish
```

Rules: the claims JSON is always a bind parameter (never interpolated, never logged; pino must not
log query params); nothing runs outside a transaction that chose a role (NOINHERIT enforces it);
the worker does the same with `SET LOCAL ROLE pipeline` and no claims. Claim shapes (zod in
`packages/shared`, 2.11):

- authenticated: `{"sub":"<uuid>","role":"authenticated","email":"<email>","aud":"authenticated","exp":<unix>}`
  (GoTrue's own claim set; only `sub`, `role`, `email` are read by SQL).
- viewer (minted by the API in step 8, signed with `JWT_SECRET`): `{"role":"viewer","share_link_id":"<uuid>","exp":<unix>}`.

SQL helpers (schema `public`, names as in the PRD):

| Function | Kind | Returns |
| --- | --- | --- |
| `auth_claims()` | STABLE, SECURITY INVOKER | `nullif(current_setting('request.jwt.claims', true), '')::jsonb` or NULL |
| `auth_role()` | STABLE | `auth_claims()->>'role'` |
| `auth_uid()` | STABLE | `(auth_claims()->>'sub')::uuid` **only when** `auth_role() = 'authenticated'`, else NULL |
| `auth_email()` | STABLE | `lower(auth_claims()->>'email')` when authenticated, else NULL |
| `auth_share_link_id()` | STABLE | `(auth_claims()->>'share_link_id')::uuid` **only when** `auth_role() = 'viewer'`, else NULL |
| `is_baby_member(baby_id uuid)` | STABLE, **SECURITY DEFINER**, `SET search_path = pg_catalog, public` | `EXISTS (baby_members WHERE baby_id = $1 AND user_id = auth_uid())` |
| `is_baby_admin(baby_id uuid)` | same | … `AND role = 'admin'` |
| `shares_baby_with(other_user_id uuid)` | same | the two users share at least one baby |
| `baby_ai_enabled(baby_id uuid)` | same | `plan = 'plus' AND (entitlement_expires_at IS NULL OR entitlement_expires_at > now()) AND deleted_at IS NULL` |
| `is_share_link_active(share_link_id uuid)` | same | `revoked_at IS NULL AND expires_at > now()` and the baby is not soft-deleted |
| `share_link_baby(share_link_id uuid)` | same | `baby_id` of the link |
| `viewer_baby_id()` | same | `share_link_baby(auth_share_link_id())` if that link is active, else NULL |
| `viewer_can_see_photo(photo_id uuid)` | same | `EXISTS (shared_photos WHERE share_link_id = auth_share_link_id() AND photo_id = $1) AND is_share_link_active(auth_share_link_id())` |
| `photo_visible(photo_id uuid)` | STABLE, **SECURITY INVOKER** | `EXISTS (SELECT 1 FROM photos WHERE id = $1)` — inherits the caller's `photos` policy, so child tables follow parent visibility |
| `photo_editable(photo_id uuid)` | STABLE, SECURITY DEFINER | admin of the photo's baby, or (`uploaded_by = auth_uid()` AND `approval = 'pending'`); `deleted_at IS NULL` |
| `jsonb_has_gps_keys(jsonb)` | IMMUTABLE | true if any top-level key `ILIKE 'gps%'` or is `latitude`/`longitude`/`lat`/`lng`/`lon` |
| `encrypt_coord(double precision)` / `decrypt_coord(bytea)` | VOLATILE / STABLE | see 2.7 |
| `set_updated_at()` | trigger fn | `NEW.updated_at = now()` |

All helpers: `REVOKE EXECUTE … FROM PUBLIC`, then `GRANT EXECUTE` to exactly the roles that need
them (`decrypt_coord` only to `pipeline`, `service_role`). SECURITY DEFINER functions are owned by
`postgres`, which is why they bypass RLS on `baby_members`/`shared_photos` and cannot recurse.

### 2.4 Tables

Conventions: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`; `created_at`/`updated_at
timestamptz NOT NULL DEFAULT now()` (+ `set_updated_at` trigger where `updated_at` exists);
enums are `text` + `CHECK (col IN (…))` (reversible, no `ALTER TYPE`); every user FK targets
`public.profiles(user_id)` (not `auth.users`); `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW
LEVEL SECURITY` on every table in the migration that creates it (FORCE covers any future
non-superuser owner; the superuser still bypasses, which is why api/worker never get its URL);
every policy names its role with `TO <role>` (never PUBLIC); policy names `<table>_<role>_<verb>`.
`public.users` does **not** exist: GoTrue owns `auth.users`; `profiles` is the 1:1 app row.

| Table | Columns (type, constraints) | Indexes / notes |
| --- | --- | --- |
| `profiles` | `user_id uuid PK REFERENCES auth.users(id) ON DELETE CASCADE`, `display_name text NOT NULL DEFAULT ''`, `relationship_label text`, `timezone text NOT NULL DEFAULT 'UTC'`, `units text NOT NULL DEFAULT 'metric' CHECK IN ('metric','imperial')`, `terms_version text`, `privacy_version text`, `accepted_at timestamptz`, `accepted_ip_country text`, `created_at`, `updated_at`, `deleted_at timestamptz` | – |
| `babies` | `id`, `name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80)`, `nickname text`, `birth_date date NOT NULL`, `birth_date_is_due_date boolean NOT NULL DEFAULT false`, `birth_weight_g integer CHECK (> 0)`, `birth_length_mm integer CHECK (> 0)`, `avatar_photo_id uuid` (FK added in the photos migration, `ON DELETE SET NULL`), `home_lat_enc bytea`, `home_lng_enc bytea`, `home_label text`, `plan text NOT NULL DEFAULT 'free' CHECK IN ('free','plus')`, `plan_owner_user_id uuid REFERENCES profiles ON DELETE SET NULL`, `entitlement_expires_at timestamptz`, `created_by uuid REFERENCES profiles ON DELETE SET NULL`, `created_at`, `updated_at`, `deleted_at timestamptz` (30-day purge, FR-10.3) | trigger `babies_add_creator_admin` AFTER INSERT (SECURITY DEFINER): inserts `baby_members (NEW.id, NEW.created_by, 'admin')` when `created_by IS NOT NULL` |
| `baby_members` | `baby_id uuid REFERENCES babies ON DELETE CASCADE`, `user_id uuid REFERENCES profiles ON DELETE CASCADE`, `role text NOT NULL CHECK IN ('admin','contributor')`, `invited_by uuid REFERENCES profiles ON DELETE SET NULL`, `joined_at timestamptz NOT NULL DEFAULT now()`, `PRIMARY KEY (baby_id, user_id)` | `(user_id)`. Trigger `baby_members_max_two_admins` BEFORE INSERT OR UPDATE OF role (SECURITY DEFINER): `SELECT 1 FROM babies WHERE id = NEW.baby_id FOR UPDATE` then raise `check_violation` "baby already has two admins" if admins (excluding the row being updated) ≥ 2. Trigger `baby_members_keep_last_admin` BEFORE DELETE OR UPDATE OF role (SECURITY DEFINER): raise if it would leave zero admins while the baby row still exists and `deleted_at IS NULL` (skip when the baby is being deleted; cascade from `babies` sees no baby row) |
| `invites` | `id`, `baby_id … CASCADE`, `email text NOT NULL CHECK (email = lower(email))`, `role text NOT NULL CHECK IN ('admin','contributor')`, `token_hash bytea NOT NULL UNIQUE CHECK (octet_length = 32)` (sha256 of the 256-bit token), `invited_by uuid REFERENCES profiles ON DELETE SET NULL`, `expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'`, `accepted_at timestamptz`, `accepted_by uuid REFERENCES profiles ON DELETE SET NULL`, `revoked_at timestamptz`, `created_at` | `(baby_id, created_at)`; unique partial `(baby_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL`. Trigger `invites_rate_limit` BEFORE INSERT (SECURITY DEFINER): raise if ≥ 20 invites for the baby in the last 24 h (PRD "Invites") |
| `milestones` | `id`, `baby_id uuid REFERENCES babies ON DELETE CASCADE` (NULL = global preset), `name text NOT NULL CHECK (length BETWEEN 1 AND 80)`, `category text NOT NULL CHECK IN ('social','motor','feeding','growth','speech','event','custom')`, `sort_order integer NOT NULL DEFAULT 1000`, `created_by uuid REFERENCES profiles ON DELETE SET NULL`, `created_at` | `UNIQUE NULLS NOT DISTINCT (baby_id, lower(name))` via unique index. Presets inserted by the migration with fixed ids (2.8) |
| `photos` | `id`, `baby_id … CASCADE`, `uploaded_by uuid REFERENCES profiles ON DELETE SET NULL`, `storage_key_original text NOT NULL UNIQUE`, `sha256 bytea CHECK (octet_length = 32)`, `phash bit(64)`, `duplicate_of_photo_id uuid REFERENCES photos ON DELETE SET NULL`, `width integer`, `height integer`, `bytes bigint`, `mime text CHECK IN ('image/jpeg','image/png','image/heic','image/heif','image/webp')`, `status text NOT NULL DEFAULT 'uploaded' CHECK IN ('uploaded','ingested','queued','analyzing','ready','failed')`, `approval text NOT NULL DEFAULT 'approved' CHECK IN ('pending','approved','rejected')`, `approved_by uuid REFERENCES profiles ON DELETE SET NULL`, `approved_at timestamptz`, `taken_at timestamptz`, `taken_at_estimated boolean NOT NULL DEFAULT false`, `age_days integer`, `is_sensitive boolean NOT NULL DEFAULT false`, `created_at`, `updated_at`, `deleted_at timestamptz` | `(baby_id, taken_at DESC) WHERE deleted_at IS NULL`; `(baby_id, status)`; `(baby_id) WHERE approval = 'pending'`; `(uploaded_by)`; unique partial `(baby_id, sha256) WHERE sha256 IS NOT NULL AND deleted_at IS NULL`. Trigger `photos_free_tier_cap` BEFORE INSERT (SECURITY DEFINER): raise when the baby's `plan = 'free'` and non-deleted photos ≥ `FREE_TIER_PHOTO_LIMIT` (1000). Trigger `photos_status_guard` BEFORE UPDATE OF status (SECURITY DEFINER): `queued`/`analyzing` require `approval = 'approved' AND deleted_at IS NULL AND baby_ai_enabled(baby_id)` (free-tier photos cannot even enter the AI queue) |
| `photo_derivatives` | `photo_id … CASCADE`, `kind text CHECK IN ('thumb','display','analysis')`, `storage_key text NOT NULL UNIQUE`, `width integer NOT NULL`, `height integer NOT NULL`, `bytes bigint NOT NULL`, `created_at`, `PRIMARY KEY (photo_id, kind)` | Comment: derivatives are written by the worker with all EXIF/GPS stripped (FR-4.4); `analysis` is the only copy that may ever reach a model |
| `photo_exif` | `photo_id PK … CASCADE`, `taken_at timestamptz`, `tz_offset_minutes smallint`, `gps_lat_enc bytea`, `gps_lng_enc bytea`, `place_label text`, `camera_make text`, `camera_model text`, `orientation smallint`, `raw_json jsonb NOT NULL DEFAULT '{}' CHECK (NOT jsonb_has_gps_keys(raw_json))`, `created_at`, `updated_at` | GPS exists only encrypted (2.7); `raw_json` can never carry GPS keys |
| `photo_details` | `photo_id PK … CASCADE`, `milestone_id uuid REFERENCES milestones ON DELETE SET NULL`, `note text CHECK (length ≤ 2000)`, `people text[] NOT NULL DEFAULT '{}'`, `location_label text`, `edited_by uuid REFERENCES profiles ON DELETE SET NULL`, `created_at`, `updated_at` | `(milestone_id)` |
| `measurements` | `id`, `baby_id … CASCADE`, `photo_id uuid REFERENCES photos ON DELETE SET NULL`, `kind text CHECK IN ('weight','height','head')`, `value_metric numeric(10,3) NOT NULL CHECK (> 0)` (grams for weight, millimetres for height/head), `value_entered numeric(10,3) NOT NULL`, `unit_entered text NOT NULL CHECK IN ('g','kg','oz','lb','mm','cm','in')`, `measured_at timestamptz NOT NULL`, `note text`, `created_by uuid REFERENCES profiles ON DELETE SET NULL`, `created_at`, `updated_at` | `(baby_id, kind, measured_at)` |
| `ai_batches` | `id`, `provider text NOT NULL`, `model text NOT NULL`, `provider_batch_id text`, `status text NOT NULL DEFAULT 'building' CHECK IN ('building','submitted','in_progress','completed','failed','expired','cancelled')`, `photo_count integer NOT NULL DEFAULT 0`, `submitted_at`, `completed_at`, `input_tokens bigint`, `cached_input_tokens bigint`, `output_tokens bigint`, `cost_usd numeric(12,6)`, `error text`, `created_at`, `updated_at` | Not baby-scoped (operational); only `pipeline`/`service_role` |
| `photo_ai` | `photo_id PK … CASCADE`, `model text NOT NULL`, `prompt_version text NOT NULL`, `schema_version text NOT NULL`, `description jsonb NOT NULL`, `sensitive_flags text[] NOT NULL DEFAULT '{}'`, `confidence real`, `batch_id uuid REFERENCES ai_batches ON DELETE SET NULL`, `input_tokens integer`, `output_tokens integer`, `created_at`, `updated_at` | `(batch_id)`. Trigger `photo_ai_paid_tier_tripwire` BEFORE INSERT OR UPDATE (SECURITY DEFINER): raise unless `baby_ai_enabled(photo's baby)` (defence in depth for FR-5.8). Trigger `photo_ai_sync_sensitive` AFTER INSERT OR UPDATE OF sensitive_flags (SECURITY DEFINER): `UPDATE photos SET is_sensitive = true WHERE id = NEW.photo_id` when `cardinality(NEW.sensitive_flags) > 0` (only ever raises to true; admins may clear manually) |
| `photo_ai_overrides` | `photo_id … CASCADE`, `field_path text NOT NULL`, `value jsonb NOT NULL`, `edited_by uuid REFERENCES profiles ON DELETE SET NULL`, `updated_at`, `PRIMARY KEY (photo_id, field_path)` | – |
| `photo_search` | `photo_id PK … CASCADE`, `baby_id … CASCADE`, `search_text text NOT NULL`, `tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED`, `embedding vector(1024)`, `embed_model text`, `taken_at timestamptz`, `age_days integer`, `milestone_ids uuid[] NOT NULL DEFAULT '{}'`, `people text[] NOT NULL DEFAULT '{}'`, `tags text[] NOT NULL DEFAULT '{}'`, `is_sensitive boolean NOT NULL DEFAULT false`, `updated_at` | `USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`; `USING gin (tsv)`; `USING gin (tags)`; `(baby_id, taken_at)`; `(baby_id, age_days)`. `milestone_ids` is `uuid[]` (PRD says `int[]`; our milestone ids are uuid) |
| `share_links` | `id`, `baby_id … CASCADE`, `name text NOT NULL`, `token_hash bytea NOT NULL UNIQUE CHECK (octet_length = 32)` (sha256 of the ≥128-bit token), `passcode_hash text` (argon2id string computed by the API), `expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'`, `allow_download boolean NOT NULL DEFAULT false`, `revoked_at timestamptz`, `created_by uuid REFERENCES profiles ON DELETE SET NULL`, `last_viewed_at timestamptz`, `view_count integer NOT NULL DEFAULT 0`, `created_at`, `updated_at` | `(baby_id)` |
| `share_rules` | `share_link_id PK REFERENCES share_links ON DELETE CASCADE`, `mode text NOT NULL CHECK IN ('all','milestones','tags')`, `include_tags text[] NOT NULL DEFAULT '{}'`, `exclude_tags text[] NOT NULL DEFAULT '{}'`, `updated_at` | No row = manual sharing only |
| `shared_photos` | `share_link_id … CASCADE`, `photo_id … CASCADE`, `added_by text NOT NULL CHECK IN ('user','rule')`, `added_by_user_id uuid REFERENCES profiles ON DELETE SET NULL`, `added_at timestamptz NOT NULL DEFAULT now()`, `PRIMARY KEY (share_link_id, photo_id)` | `(photo_id)`. Trigger `shared_photos_gate` BEFORE INSERT OR UPDATE (SECURITY DEFINER): photo must belong to the link's baby, be `approval = 'approved'`, `deleted_at IS NULL`; if `added_by = 'rule'` and `photos.is_sensitive` → raise "sensitive photos are never auto-shared" (FR-9.5) |
| `viewer_sessions` | `id`, `share_link_id … CASCADE`, `created_at`, `expires_at timestamptz NOT NULL`, `ip_hash bytea`, `user_agent_hash bytea`, `last_seen_at timestamptz` | `(share_link_id, created_at DESC)` |
| `chat_threads` | `id`, `baby_id … CASCADE`, `user_id uuid REFERENCES profiles ON DELETE CASCADE`, `title text`, `created_at`, `updated_at` | `(baby_id, user_id, updated_at DESC)` |
| `chat_messages` | `id`, `thread_id REFERENCES chat_threads ON DELETE CASCADE`, `baby_id … CASCADE` (denormalised for RLS), `user_id uuid REFERENCES profiles ON DELETE CASCADE`, `role text CHECK IN ('user','assistant','tool','system')`, `content text NOT NULL`, `cited_photo_ids uuid[] NOT NULL DEFAULT '{}'`, `tokens_in integer`, `tokens_out integer`, `model text`, `created_at` | `(thread_id, created_at)` |
| `audit_log` | `id bigint GENERATED ALWAYS AS IDENTITY PK`, `baby_id uuid REFERENCES babies ON DELETE SET NULL`, `actor_user_id uuid REFERENCES profiles ON DELETE SET NULL`, `share_link_id uuid REFERENCES share_links ON DELETE SET NULL`, `event text NOT NULL`, `metadata jsonb NOT NULL DEFAULT '{}'`, `created_at` | `(baby_id, created_at DESC)`, `(actor_user_id, created_at DESC)`. Append-only: no UPDATE/DELETE grant to any role. Comment: metadata never holds tokens, GPS, notes or prompts |
| `worker_heartbeats` (step 1) | add `updated_at timestamptz NOT NULL DEFAULT now()` (always advances, fixes step-1 S5) | policy + grants for `tinyglow_worker` |

### 2.5 Soft delete and purge semantics

- `photos.deleted_at`: admins (and contributors for own pending) set it via UPDATE; nobody except
  `pipeline` may hard-delete, and `pipeline` only rows with `deleted_at < now() - interval '30
  days'` (FR-10.2). Trashed photos are visible to admins only.
- `babies.deleted_at`: admins set it; `pipeline` may hard-delete after 30 days (FR-10.3); members
  other than admins no longer see the baby.
- `profiles.deleted_at`: set by `service_role` during account deletion (step 3); the GoTrue user
  deletion cascades the profile row, which cascades `baby_members`, `chat_*`, and sets
  `uploaded_by`/`edited_by`/`created_by` to NULL so photos survive for the remaining admin.

### 2.6 RLS policy matrix

`A` = `authenticated` (conditions use helpers), `V` = `viewer`, `P` = `pipeline`, `S` =
`service_role` (BYPASSRLS + `GRANT ALL`, not listed per row). "–" = no grant at all (statement
fails with `permission denied`, which is the desired behaviour for the acceptance tests). Column
grants are `GRANT <verb> (cols)`; a `SELECT *` by a role with a column list fails.

| Table | A: SELECT | A: INSERT (WITH CHECK) | A: UPDATE (USING / WITH CHECK, column list) | A: DELETE | V | P |
| --- | --- | --- | --- | --- | --- | --- |
| `profiles` | `user_id = auth_uid() OR shares_baby_with(user_id)` | `user_id = auth_uid()` | own row; cols: display_name, relationship_label, timezone, units, terms_version, privacy_version, accepted_at, accepted_ip_country, updated_at | – | – | SELECT (user_id, display_name, relationship_label) USING true |
| `babies` | `is_baby_member(id) AND (deleted_at IS NULL OR is_baby_admin(id))` | `created_by = auth_uid()` (trigger adds creator as admin) | `is_baby_admin(id)` / same; cols: name, nickname, birth_date, birth_date_is_due_date, birth_weight_g, birth_length_mm, avatar_photo_id, home_lat_enc, home_lng_enc, home_label, deleted_at, updated_at (**not** plan, plan_owner_user_id, entitlement_expires_at: billing via S only) | – | SELECT (id, name, nickname, birth_date) USING `id = viewer_baby_id()` | SELECT (id, birth_date, plan, entitlement_expires_at, home_lat_enc, home_lng_enc, deleted_at) USING true; DELETE USING `deleted_at < now() - 30 days` |
| `baby_members` | `is_baby_member(baby_id)` | `is_baby_admin(baby_id)` OR (`user_id = auth_uid()` AND a matching live invite for `auth_email()` with the same `role`: the invitee may join only with the invited email) | `is_baby_admin(baby_id)` / same; cols: role | `is_baby_admin(baby_id) OR user_id = auth_uid()` (triggers protect the last admin) | – | – |
| `invites` | `is_baby_admin(baby_id) OR email = auth_email()`; SELECT cols exclude `token_hash` | `is_baby_admin(baby_id) AND invited_by = auth_uid()` (cols include token_hash) | `is_baby_admin(baby_id) OR email = auth_email()` / same; cols: token_hash, expires_at, accepted_at, accepted_by, revoked_at | `is_baby_admin(baby_id)` | – | – |
| `milestones` | `baby_id IS NULL OR is_baby_member(baby_id)` | `baby_id IS NOT NULL AND is_baby_admin(baby_id) AND created_by = auth_uid()` | `baby_id IS NOT NULL AND is_baby_admin(baby_id)` | same | SELECT (id, baby_id, name, category) USING `baby_id IS NULL OR baby_id = viewer_baby_id()` | SELECT USING true |
| `photos` | `is_baby_admin(baby_id) OR (is_baby_member(baby_id) AND deleted_at IS NULL AND (approval = 'approved' OR uploaded_by = auth_uid()))` | `is_baby_member(baby_id) AND uploaded_by = auth_uid() AND (is_baby_admin(baby_id) OR approval = 'pending')` (contributors land in the queue, FR-2.7); cols exclude pipeline columns | USING `is_baby_admin(baby_id) OR (uploaded_by = auth_uid() AND approval = 'pending')`; WITH CHECK same (a contributor cannot set approval to approved: NEW row would fail); cols: approval, approved_by, approved_at, is_sensitive, deleted_at, updated_at | **–** (soft delete only; "a contributor cannot delete") | SELECT (id, baby_id, taken_at, taken_at_estimated, age_days, width, height, mime, created_at) USING `viewer_can_see_photo(id) AND deleted_at IS NULL AND approval = 'approved'` — never `storage_key_original`, `sha256`, `phash`, `bytes` | SELECT USING true; UPDATE cols: status, sha256, phash, duplicate_of_photo_id, width, height, bytes, mime, taken_at, taken_at_estimated, age_days, is_sensitive, updated_at USING true; DELETE USING `deleted_at IS NOT NULL AND deleted_at < now() - 30 days` |
| `photo_derivatives` | `photo_visible(photo_id)` | – | – | – | SELECT (all) USING `kind IN ('thumb','display') AND photo_visible(photo_id)` | ALL USING true |
| `photo_exif` | `photo_visible(photo_id)`; SELECT cols exclude `gps_lat_enc`, `gps_lng_enc` (admins see only `place_label`) | – | – | – | – | ALL USING true |
| `photo_details` | `photo_visible(photo_id)` | `photo_editable(photo_id) AND edited_by = auth_uid()` | `photo_editable(photo_id)` / same | `photo_editable(photo_id)` | SELECT (photo_id, milestone_id) USING `photo_visible(photo_id)` | SELECT USING true |
| `measurements` | `is_baby_member(baby_id)` | `is_baby_admin(baby_id) AND created_by = auth_uid()` | `is_baby_admin(baby_id)` | same | – | SELECT USING true |
| `ai_batches` | – | – | – | – | – | ALL USING true |
| `photo_ai` | `photo_visible(photo_id)` | – | – | – | – (step 8 may add caption-only SELECT for alt text, with a test) | ALL USING true |
| `photo_ai_overrides` | `photo_visible(photo_id)` | `photo_editable(photo_id) AND edited_by = auth_uid()` | `photo_editable(photo_id)` | same | – | SELECT USING true |
| `photo_search` | `is_baby_admin(baby_id) AND baby_ai_enabled(baby_id) AND photo_visible(photo_id)` (search is admin + paid only, FR-7.7/5.8) | – | – | – | – | ALL USING true |
| `share_links` | `is_baby_admin(baby_id)`; SELECT cols exclude `token_hash`, `passcode_hash` | `is_baby_admin(baby_id) AND created_by = auth_uid()` (cols include the hashes) | `is_baby_admin(baby_id)` / same; cols: name, token_hash, passcode_hash, expires_at, allow_download, revoked_at, updated_at | `is_baby_admin(baby_id)` | SELECT (id, baby_id, name, expires_at, revoked_at, allow_download) USING `id = auth_share_link_id() AND is_share_link_active(id)` | SELECT (id, baby_id, expires_at, revoked_at) USING true |
| `share_rules` | `is_baby_admin(share_link_baby(share_link_id))` | same | same | same | – | SELECT USING true |
| `shared_photos` | `is_baby_admin(share_link_baby(share_link_id))` | same `AND added_by = 'user' AND added_by_user_id = auth_uid()` | same | same | SELECT (all) USING `share_link_id = auth_share_link_id() AND is_share_link_active(share_link_id) AND photo_visible(photo_id)` | SELECT USING true; INSERT WITH CHECK `added_by = 'rule' AND added_by_user_id IS NULL` (trigger gate applies) |
| `viewer_sessions` | `is_baby_admin(share_link_baby(share_link_id))`, cols: id, share_link_id, created_at, expires_at, last_seen_at | – | – | – | – | – |
| `chat_threads` / `chat_messages` | `is_baby_admin(baby_id) AND user_id = auth_uid()` | same `AND baby_ai_enabled(baby_id)` | same | same | – | – |
| `audit_log` | `is_baby_admin(baby_id) OR actor_user_id = auth_uid()` | `actor_user_id = auth_uid() AND (baby_id IS NULL OR is_baby_member(baby_id))` | – | – | – | INSERT WITH CHECK `actor_user_id IS NULL` |
| `worker_heartbeats` | – | – | – | – | – | – (direct grant + policy `TO tinyglow_worker` USING true / WITH CHECK true) |

Schema-level: `REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO
tinyglow_api, tinyglow_worker, authenticated, viewer, pipeline, service_role;` `ALTER DEFAULT
PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role` (+ sequences).
`anon` gets nothing. No role but `postgres` can read `pgmigrations` or `auth.*`.

### 2.7 Encryption at rest (GPS, home coordinates)

- pgcrypto `pgp_sym_encrypt(value::text, key)` → `bytea` columns `photo_exif.gps_lat_enc`,
  `gps_lng_enc`, `babies.home_lat_enc`, `home_lng_enc`. Plaintext GPS never exists in any table,
  log, derivative or viewer-facing row; admins see only `photo_exif.place_label` (FR-4.3).
- Key source: env `DATA_ENCRYPTION_KEY` (≥ 32 chars; dev literal in Compose `x-dev-shared`, prod
  `openssl rand -hex 32` in `.env`). Held by `api`, `worker`, and `migrate` (seed only).
- How it reaches SQL without logging: the caller sets it as a transaction-local GUC with a bind
  parameter, exactly like the step-1 bootstrap password: `SELECT set_config('app.data_key', $1,
  true)`. `encrypt_coord(double precision)` / `decrypt_coord(bytea)` read
  `current_setting('app.data_key', true)` and raise `data key not set for this transaction` when
  it is missing. Bind parameters are not part of statement text; Postgres defaults
  (`log_statement = none`, `log_parameter_max_length_on_error = 0`) never log them. devops
  documents in `docker-compose.yml`/`.env.example`: never enable `log_statement = all` or
  parameter logging on the production `db`.
- Grants: `encrypt_coord` → `authenticated` (home location, step 5), `pipeline`, `service_role`;
  `decrypt_coord` → `pipeline`, `service_role` only. Plaintext coordinates never leave the DB to a
  user role.
- Key rotation is out of scope (note in README: re-encrypt by `UPDATE … SET col =
  encrypt_coord(decrypt_coord(col))` under the old then new key).

### 2.8 Milestone presets (production data, in a migration, fixed ids)

`10000000-0000-4000-8000-0000000000NN`: 01 First smile (social) · 02 First laugh (social) ·
03 Rolled over (motor) · 04 Sat up (motor) · 05 First food (feeding) · 06 First tooth (growth) ·
07 Crawled (motor) · 08 First steps (motor) · 09 First word (speech) · 10 First haircut (event) ·
11 First birthday (event) · 12 First time with [person] (social). `sort_order` = NN × 10.
The same list lives in `packages/shared` as `MILESTONE_PRESETS` (2.11); a test asserts they match.

### 2.9 Seed (dev only, idempotent, demo family)

`packages/db/src/seed.ts`, run as the superuser by the dev `migrate` service on every start.
Refuses (exit 1, clear message) unless `NODE_ENV !== 'production'` **and** `SEED_DEMO_FAMILY=true`;
exits 0 with `seed: skipped (SEED_DEMO_FAMILY not set)` when the flag is absent so production
images that accidentally run it do nothing. One transaction; every row has a fixed id and is
upserted (`ON CONFLICT (pk) DO UPDATE`), so a second run yields identical counts. Needs
`DATA_ENCRYPTION_KEY` (sets `app.data_key` via bind param). Logs counts and the plaintext dev
share token (dev only). Never inserts real images: storage keys are placeholders; step 5's 10,000-
photo seed extends this file.

Fixed ids: users `00000000-0000-4000-8000-00000000000{1,2,3}` = `demo-mom@tinyglow.local`
(admin, display "Maria", relationship "Mom"), `demo-dad@tinyglow.local` (admin, "Dad"),
`demo-nanny@tinyglow.local` (contributor, "Nanny"); baby `…-000000000100` "Maya", nickname
"Mimi", `birth_date 2025-06-30`, `plan = 'plus'`, `plan_owner_user_id` = mom, home coordinates
encrypted (`47.6062, -122.3321`, `home_label 'Home'`); share link `…-000000000200` "Grandparents",
dev token `demo-grandparents-share-token` (stored as `sha256(token)`), `expires_at now() + 24h`
(re-upserted on every start so it is always fresh), `share_rules mode = 'milestones'`; photos
`…-0000000003NN` (12 rows): 8 approved by mom/dad with `status 'ingested'`, `taken_at` spread
over 2025-07 … 2026-06, `age_days` computed, `photo_exif` rows (one with encrypted GPS, all with
`raw_json` free of GPS keys), `photo_derivatives` thumb/display placeholder keys, `photo_details`
for 3 milestone photos (first smile, first steps on 2026-06-14 with people `{Dad}`, first
birthday), 2 `approval = 'pending'` uploaded by the nanny, 1 approved and soft-deleted, 1 flagged
`is_sensitive = true` (bath) with a `photo_ai` row carrying `sensitive_flags {bath}`; 3
`shared_photos` (`added_by 'user'`, the non-sensitive milestone photos); `measurements` (birth
weight 3400 g, 4-month weight 6500 g, 6-month height 660 mm); `photo_search` rows for the approved
photos with `search_text` built like the PRD example (embedding NULL until step 7);
one `audit_log` row `seed.demo_family`.

`auth.users` rows (GoTrue-compatible, explicit column list; this is also the stub's column list):
`instance_id '00000000-0000-0000-0000-000000000000'`, `id`, `aud 'authenticated'`, `role
'authenticated'`, `email`, `encrypted_password NULL`, `email_confirmed_at now()`,
`confirmation_token ''`, `recovery_token ''`, `email_change ''`, `email_change_token_new ''`,
`email_change_token_current ''`, `phone_change ''`, `phone_change_token ''`,
`reauthentication_token ''`, `raw_app_meta_data '{"provider":"email","providers":["email"]}'`,
`raw_user_meta_data '{}'`, `is_sso_user false`, `is_anonymous false`, `created_at`, `updated_at`
(empty strings, not NULLs, in the token columns: GoTrue scans them as Go strings). Plus
`auth.identities` (`id`, `user_id`, `provider 'email'`, `provider_id = user id::text`,
`identity_data {"sub","email","email_verified":true}`, `last_sign_in_at`, `created_at`,
`updated_at`). Step 3's e2e proves these users can sign in with OTP; if GoTrue rejects SQL-seeded
users, the fallback is seeding through GoTrue's admin API (`POST /admin/users` with a
`service_role` JWT) from the same script (Risk R4).

### 2.10 `@tinyglow/db` package surface

- `src/bootstrap.ts` (extended): all roles in 2.2, passwords from `API_DB_PASSWORD`,
  `WORKER_DB_PASSWORD` (same bind-param `set_config` → `DO` pattern, ≥ 16 chars in production),
  `service_role` → `BYPASSRLS`, `pgboss` schema + ownership convergence + default privileges.
  Exports `APP_ROLES = { api: 'tinyglow_api', worker: 'tinyglow_worker', viewer: 'viewer',
  pipeline: 'pipeline', authenticated: 'authenticated', service: 'service_role' }`.
- `src/env.ts`: `requireApiDbPassword`, `requireWorkerDbPassword`, `requireDataEncryptionKey`,
  `seedEnabled(env)`.
- `src/test-support.ts`: `ensureAuthSchemaStub(client)` (2.1) and `appRoleUrl(databaseUrl,
  role, password)` (rewrites user/password of a `postgres://` URL for tests). Exported from
  `src/index.ts`; documented as test/CI only.
- `src/gen-types.ts` + `src/generated/{index.ts,tables.ts}`: in-house generator (no new
  dependency; ~120 lines) reading `information_schema.columns` + `pg_attribute` for schema
  `public`: one `interface <PascalTable>Row` per table and `<PascalTable>Insert` (NOT NULL
  without default ⇒ required; others optional), plus `TABLE_NAMES`. Type map: `uuid|text|citext
  → string`, `int2|int4 → number`, `int8|numeric → string`, `bool → boolean`, `timestamptz|date
  → Date`, `jsonb → unknown`, `bytea → Buffer`, `text[] → string[]`, `uuid[] → string[]`,
  `vector|tsvector|bit → string`. Output is committed and deterministic (sorted); script
  `db:types` = `tsx src/gen-types.ts` (needs `DATABASE_URL`, superuser or any role with catalog
  access). Package export `"./types": "./src/generated/index.ts"` for step 3+ consumers (adding
  `@tinyglow/db` as an api/worker dependency is deferred to step 3 with a serial lockfile regen).
  Alternative if the orchestrator prefers a maintained tool: Kanel (`kanel`), see R6.
- `README.md`: role model, per-transaction pattern (2.3), encryption key handling, seed flags,
  "RLS policy changes need a test", type generation, migration list.

### 2.11 Shared contracts (`@tinyglow/shared`, architect-defined, backend-engineer writes)

- `src/db-enums.ts` (zod + inferred types): `babyRoleSchema` (`admin|contributor`), `planSchema`
  (`free|plus`), `unitsSchema` (`metric|imperial`), `photoStatusSchema`, `photoApprovalSchema`,
  `photoMimeSchema`, `derivativeKindSchema`, `measurementKindSchema`, `measurementUnitSchema`,
  `milestoneCategorySchema`, `aiBatchStatusSchema`, `shareRuleModeSchema`,
  `sharedPhotoAddedBySchema`, `chatRoleSchema` — values exactly as the CHECK constraints in 2.4.
- `src/jwt-claims.ts`: `authenticatedClaimsSchema` (`sub: uuid`, `role: literal('authenticated')`,
  `email: email().optional()`, `aud`, `exp: number`, `iat?`, `iss?`, passthrough), `viewerClaimsSchema`
  (`role: literal('viewer')`, `share_link_id: uuid`, `exp: number`, `iat?`, `jti?`),
  `jwtClaimsSchema = union`. Helper `claimsToSql(claims): string` = `JSON.stringify` of the parsed
  object (what goes into `set_config`).
- `src/constants.ts` (add): `MAX_ADMINS_PER_BABY = 2`, `INVITE_TTL_DAYS = 7`,
  `INVITES_PER_BABY_PER_DAY = 20`, `PHOTO_TRASH_DAYS = 30`, `HOME_RADIUS_M = 150`,
  `MILESTONE_PRESETS: readonly { id, name, category, sortOrder }[]` (2.8), `DEMO_IDS` (seed ids
  in 2.9, so tests and later steps reference one source).
- `src/env.ts` (add): `encryptionEnvSchema = { DATA_ENCRYPTION_KEY: z.string().min(32) }`.
- Measurement convention documented next to `measurementKindSchema`: `value_metric` is grams for
  `weight`, millimetres for `height`/`head`.

### 2.12 App changes (api, worker) in this step

- `apps/api/src/config.ts`, `apps/worker/src/config.ts`: add `encryptionEnvSchema`
  (`DATA_ENCRYPTION_KEY`; field name only in errors). No DB-role code yet; the per-transaction
  wrapper (`withClaims(claims, fn)` in `apps/api/src/plugins/db.ts`, `withPipeline(fn)` in
  `apps/worker/src/db.ts`) is specified in 2.3 and implemented in steps 3/4 when the first caller
  exists.
- `apps/worker/src/heartbeat.ts` (S5 fix): both upserts set `updated_at = now()` (insert and
  `DO UPDATE`); `PRUNE_SQL` deletes `WHERE updated_at < now() - interval '1 day' AND worker_id <>
  $1`. `last_seen_at` semantics unchanged (advances only when storage is reachable).
- Everything else keeps reading `DATABASE_URL`; the value changes per service (2.13).

### 2.13 Compose, env, CI (devops-engineer)

| Item | Dev (`docker-compose.dev.yml`, `.env.dev`) | Prod (`docker-compose.yml`, `.env.example`) |
| --- | --- | --- |
| New one-shot `db-init` | same image as `migrate`, `command: ["pnpm","db:bootstrap"]`, env: superuser `DATABASE_URL`, `AUTH_DB_PASSWORD`, `API_DB_PASSWORD`, `WORKER_DB_PASSWORD` (literals via `x-dev-shared`), `depends_on db: service_healthy`, `restart: "no"` | same with `${…:?}` from `.env` |
| `auth` | `depends_on: db-init: service_completed_successfully` (+ `mail`) | same |
| `migrate` | `depends_on: auth: service_healthy`; env adds the three passwords, `DATA_ENCRYPTION_KEY`, `SEED_DEMO_FAMILY: "true"`; command unchanged (`db:migrate && db:seed`) | `depends_on: auth: service_healthy`; no seed, no `SEED_DEMO_FAMILY` |
| `api` | `environment: DATABASE_URL: postgres://tinyglow_api:dev@db:5432/tinyglow`, `DATA_ENCRYPTION_KEY` (from `x-dev-app-env`) | `DATABASE_URL: postgres://tinyglow_api:${API_DB_PASSWORD:?}@db:5432/tinyglow` via `environment:` (overrides env_file) |
| `worker` | `DATABASE_URL: postgres://tinyglow_worker:dev@db:5432/tinyglow`, `DATA_ENCRYPTION_KEY` | `postgres://tinyglow_worker:${WORKER_DB_PASSWORD:?}@…` |
| `.env.dev` | `DATABASE_URL` line becomes a comment explaining it is set per service in Compose; add `DATA_ENCRYPTION_KEY` note (literal lives in `x-dev-shared`); `SEED_DEMO_FAMILY=true` | `.env.example`: `POSTGRES_PASSWORD`, `AUTH_DB_PASSWORD`, `API_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `DATA_ENCRYPTION_KEY` (all `openssl rand -hex 32`), `DATABASE_URL` documented as the superuser URL used by `db-init`/`migrate` only; comment: never set `log_statement=all` on `db` |
| CI `check` job | integration env adds `API_DB_PASSWORD=dev`, `WORKER_DB_PASSWORD=dev`, `DATA_ENCRYPTION_KEY=dev-only-data-encryption-key-32-chars-min`, `SEED_DEMO_FAMILY=true`; new step after integration tests: `pnpm db:types && git diff --exit-code -- packages/db/src/generated` | – |
| Smoke (`e2e/smoke/dev-stack.sh`, test-engineer) | expects `db-init`, `migrate`, `storage-init` exited 0; adds a check that `pg_stat_activity` shows `tinyglow-api` as `tinyglow_api` and `tinyglow-worker:*` as `tinyglow_worker`, and no app connection as `postgres` | – |

`docker/backup/*`: roles-only dump already covers the new roles; devops verifies the restore
script re-runs bootstrap after restore (passwords are not in the dump).

### 2.14 Migration files (`packages/db/migrations/`, timestamps after `1791435701234`)

| File | Up | Down |
| --- | --- | --- |
| `<ts>_app-roles-and-helpers.sql` | guard: roles from 2.2 exist, `auth.users` exists (2.1); schema grants + default privileges; claims helpers, `jsonb_has_gps_keys`, `encrypt_coord`/`decrypt_coord`, `set_updated_at`; EXECUTE grants | drop functions, revert default privileges/grants |
| `<ts>_identity.sql` | `profiles`, `babies` (no avatar FK yet), `baby_members` (+ three triggers), `invites` (+ rate-limit trigger); `is_baby_member`, `is_baby_admin`, `shares_baby_with`, `baby_ai_enabled`; RLS + grants + policies (A, P) | drop in reverse |
| `<ts>_photos.sql` | `milestones` (+ presets), `photos` (+ cap and status-guard triggers; `babies.avatar_photo_id` FK), `photo_derivatives`, `photo_exif`, `photo_details`, `measurements`, `photo_ai_overrides`; `photo_visible`, `photo_editable`; RLS/policies (A, P) | drop FK, tables, functions |
| `<ts>_ai.sql` | `ai_batches`, `photo_ai` (+ tripwire and sensitive-sync triggers), `photo_search` (+ HNSW/GIN/btree); RLS/policies (A, P) | drop |
| `<ts>_sharing.sql` | `share_links`, `share_rules`, `shared_photos` (+ gate trigger), `viewer_sessions`; `is_share_link_active`, `share_link_baby`, `viewer_baby_id`, `viewer_can_see_photo`; RLS/policies incl. all **V** policies on `babies`, `milestones`, `photos`, `photo_derivatives`, `photo_details` | drop viewer policies on earlier tables, then tables/functions |
| `<ts>_chat-audit.sql` | `chat_threads`, `chat_messages`, `audit_log`; RLS/policies | drop |
| `<ts>_worker-heartbeats-app-role.sql` | `ALTER TABLE worker_heartbeats ADD COLUMN updated_at …`; `GRANT ALL ON worker_heartbeats TO tinyglow_worker`; policy `worker_heartbeats_worker_all TO tinyglow_worker USING (true) WITH CHECK (true)` | drop policy, revoke, drop column |

Every file: `IF NOT EXISTS`/`IF EXISTS` guards, `ENABLE` + `FORCE ROW LEVEL SECURITY` in the
same file as `CREATE TABLE`, down is the exact inverse. The whole run is one transaction
(`singleTransaction`), so HNSW/GIN creation (empty tables) stays inside it.

## 3. Tasks

Owners per `CLAUDE.md` file ownership. Same-owner tasks run in sequence.

### 2.1 Roles, bootstrap, env, test support (security-engineer) — lane S, first

- Owned: `packages/db/src/bootstrap.ts`, `src/env.ts`, `src/test-support.ts`, `src/index.ts`,
  `README.md`, `package.json` scripts (no new deps).
- Build 2.2 and 2.10: new roles, memberships (`WITH INHERIT FALSE, SET TRUE`), `service_role
  BYPASSRLS`, `pgboss` schema/ownership/default privileges, password handling identical to
  `AUTH_DB_PASSWORD` (bind param → `DO`; never logged; redact list extended with the new
  secrets), `ensureAuthSchemaStub`, `appRoleUrl`. Bootstrap stays idempotent and converging.
- Security: no `BYPASSRLS` on any LOGIN role; `tinyglow_api`/`tinyglow_worker` NOINHERIT;
  nothing grants `anon`.
- Inputs: this plan. Done-when: against a throwaway pgvector (README recipe) `pnpm db:bootstrap`
  twice is a no-op the second time; `psql -c "\du"` shows the roles/attributes of 2.2;
  `psql -U tinyglow_api -c 'select 1'` works and `-c 'select * from worker_heartbeats'` is
  `permission denied`; `SET ROLE authenticated` works for `tinyglow_api` but `SET ROLE
  pipeline` fails; `SET ROLE service_role` fails for `tinyglow_worker`.

### 2.2 Migrations (security-engineer) — lane S, after 2.1

- Owned: `packages/db/migrations/*.sql`, `README.md` (migration table).
- Build 2.14 exactly as specified in 2.3–2.8 (tables, triggers, helpers, column grants, policies,
  indexes, presets). PRD-wide requirements to write explicitly into the SQL comments and enforce:
  RLS + FORCE on every table; GPS only as `*_enc` columns and `raw_json` CHECK; `viewer` allow-list
  only; sensitive gate trigger; `baby_ai_enabled` in the status guard, `photo_ai` tripwire,
  `photo_search` and chat policies; no DELETE grant on `photos` for `authenticated`; append-only
  `audit_log`.
- Inputs: 2.1. Done-when: `pnpm db:migrate` on a DB where GoTrue has migrated (dev stack) applies
  9 migrations total; a second run is a no-op; `pnpm db:migrate:down all && pnpm db:migrate`
  round-trips; `pnpm db:migrate` against a bare DB (no `auth.users`) fails with the guard message;
  `psql -c "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where
  nspname='public' and relkind='r' and not (relrowsecurity and relforcerowsecurity)"` returns
  only `pgmigrations`; the spot checks in section 4 pass by hand.

### 2.3 Seed (security-engineer) — lane S, after 2.2

- Owned: `packages/db/src/seed.ts`.
- Build 2.9. Guard flags, fixed ids, single transaction, upserts, encrypted home/GPS via
  `encrypt_coord` with `app.data_key` set by bind param, GoTrue-compatible `auth.users` +
  `auth.identities`, placeholder storage keys, no real images, log counts + dev share token only.
- Inputs: 2.2. Done-when: on the dev stack `pnpm db:seed` twice → identical `count(*)` per table;
  `NODE_ENV=production pnpm db:seed` exits 1 without touching the DB; with `SEED_DEMO_FAMILY`
  unset exits 0 and logs skipped; `select decrypt_coord(home_lat_enc)` under `app.data_key` returns
  `47.6062`; `select home_lat_enc::text` is not the plaintext.

### 2.4 Generated types (security-engineer) — lane S, after 2.2 (may precede 2.3)

- Owned: `packages/db/src/gen-types.ts`, `src/generated/**`, `package.json` (`db:types` script,
  `./types` export), `README.md`.
- Build 2.10 generator; commit the output generated from the migrated dev DB.
- Done-when: `pnpm db:types` twice produces no diff; `pnpm --filter @tinyglow/db typecheck`
  passes; `PhotosRow.status` is the union of the CHECK values (the generator reads
  `pg_constraint` `CHECK (col IN (...))` to narrow `text` columns; falls back to `string`).

### 2.5 Shared contracts (backend-engineer) — parallel group B (with lane S and 2.7)

- Owned: `packages/shared/src/**` (db-enums.ts, jwt-claims.ts, constants.ts, env.ts, index.ts;
  orchestrator approval implied by this plan).
- Build 2.11. Only `zod` as dependency; values must match 2.4/2.8/2.9 literally.
- Done-when: typecheck passes; unit tests (2.8) cover enum values, claims schemas (viewer claims
  without `share_link_id` rejected; authenticated claims with `role: viewer` rejected),
  `MILESTONE_PRESETS` has 12 entries with unique ids.

### 2.6 API/worker config + heartbeat S5 (backend-engineer) — after 2.5

- Owned: `apps/api/src/config.ts`, `apps/worker/src/config.ts`, `apps/worker/src/heartbeat.ts`,
  `apps/worker/src/main.ts` (only if needed). Not owned: `apps/api/src/auth/**`, `sharing/**`
  (do not create).
- Build 2.12. `pg-boss` keeps `connectionString: DATABASE_URL` (now `tinyglow_worker`); no
  `schema` option change.
- Done-when: with the dev stack on the new roles, `/healthz` is 200, worker healthy,
  `worker_heartbeats.updated_at` advances every beat even while `storage` is stopped
  (`last_seen_at` does not), and a row with `last_seen_at = epoch` but fresh `updated_at` survives
  `PRUNE_SQL` (unit test in 2.8).

### 2.7 Compose, env, CI (devops-engineer) — parallel group B, verified after lane S lands

- Owned: `docker-compose.dev.yml`, `docker-compose.yml`, `.env.dev`, `.env.example`,
  `.github/workflows/ci.yml`, `docker/backup/*`, `packages/db/Dockerfile` (no change expected).
- Build 2.13. Keep zero-setup dev: no new files for the user; dev literals in `x-dev-shared`
  (`api-db-password: dev`, `worker-db-password: dev`, `data-encryption-key:
  dev-only-data-encryption-key-32-chars-min`). Security: `.env.example` placeholders only;
  the `auth`, `storage`, `web` services still receive no app DB credentials or the encryption key.
- Done-when: `docker compose -f docker-compose.dev.yml config -q` and the prod `config -q` (as in
  CI) pass; from a clean clone `up -d --build --wait` exits 0 with `db-init`, `migrate`,
  `storage-init` exited 0 and all long-running services healthy; `pnpm dev:reset` repeats it;
  starting from a step-1 dev volume (pgboss owned by postgres) also comes up healthy.

### 2.8 Tests (test-engineer) — after 2.1–2.7

- Owned: `**/*.test.ts`, `e2e/**`.
- Files:
  - `packages/db/rls.integration.test.ts` — the matrix below.
  - `packages/db/triggers.integration.test.ts` — max-2-admins, last-admin, invite rate limit,
    free-tier cap (insert 1000 then the 1001st fails for a `free` baby; passes for `plus`),
    status guard (free baby photo → `queued` fails; pending photo → `queued` fails), `photo_ai`
    tripwire, sensitive sync, `shared_photos` gate (rule + sensitive fails; user + sensitive ok;
    pending or deleted photo fails; cross-baby fails), `raw_json` GPS CHECK, `encrypt_coord`
    round-trip + "key not set" error + ciphertext differs from plaintext, `set_updated_at`.
  - `packages/db/seed.integration.test.ts` — runs `seed()` twice, equal counts; refuses in
    production; stub-compatible (CI).
  - `packages/db/migrations.integration.test.ts` — update counts (9), call `ensureAuthSchemaStub`
    before `up`, assert every public table has RLS + FORCE, assert `MILESTONE_PRESETS` equals
    the preset rows.
  - `packages/shared/src/{db-enums,jwt-claims}.test.ts`, `apps/worker/src/heartbeat.test.ts`
    (S5), `apps/api/src/config.test.ts` (`DATA_ENCRYPTION_KEY` required, value never in message).
  - `e2e/smoke/dev-stack.sh` — 2.13 additions.
- Harness: connect as `postgres` for fixtures; as `tinyglow_api` (via `appRoleUrl`) for
  `authenticated`/`viewer`; as `tinyglow_worker` for `pipeline`. Minting claims =
  `BEGIN; SET LOCAL ROLE <r>; SELECT set_config('request.jwt.claims', $1, true)` with
  `JSON.stringify({ sub, role: 'authenticated', email })` or `{ role: 'viewer', share_link_id }`,
  assertions, `ROLLBACK`. Fixtures (fixed ids, created once per file as superuser): babies A and B;
  users `adminA1`, `adminA2`, `contribA`, `adminB`, `stranger` (no memberships); photos in A:
  approved by adminA1, pending by contribA, approved-and-sensitive, trashed; share links LA
  (active), LA-expired, LA-revoked, LB (baby B); `shared_photos` for LA = 2 approved photos.
- RLS matrix (every cell is a test; expected results are "rows returned", "0 rows", "RLS
  violation" (`42501` with `new row violates row-level security policy`), or "permission denied"
  (`42501` on the statement)):

| Actor | SELECT across all baby-scoped tables | Key verb cases |
| --- | --- | --- |
| `adminB` | 0 rows of baby A in every table (`babies`, `baby_members`, `invites`, `photos`, `photo_derivatives`, `photo_exif`, `photo_details`, `measurements`, `photo_ai`, `photo_ai_overrides`, `photo_search`, `share_links`, `share_rules`, `shared_photos`, `viewer_sessions`, `chat_*`, `audit_log`) | UPDATE/soft-delete of an A photo → 0 rows; INSERT `baby_members` into A → RLS violation; INSERT `shared_photos` for LA → RLS violation |
| `stranger` | 0 rows everywhere; own `profiles` row only | INSERT `babies` with `created_by = self` → row + auto admin membership |
| `adminA1` | all A rows incl. trashed and pending photos; `photo_exif` without gps columns (`SELECT gps_lat_enc` → permission denied); `share_links` without hashes | soft-delete any A photo → 1 row; `DELETE FROM photos` → permission denied; UPDATE `babies.plan` → permission denied (column); add 3rd admin → trigger error; remove self as last admin (after removing adminA2) → trigger error |
| `contribA` | `photos` = own uploads + approved, no trashed/others' pending; `babies` yes; `invites` 0 rows; `share_links`/`shared_photos`/`chat_*`/`photo_search` 0 rows | INSERT photo with `approval='approved'` → RLS violation; INSERT pending → ok; UPDATE own pending `deleted_at` → 1 row; UPDATE own pending `approval='approved'` → RLS violation; UPDATE approved photo (anyone's) → 0 rows; `DELETE FROM photos` → permission denied; INSERT `measurements` → RLS violation; INSERT `share_links` → RLS violation; INSERT `chat_threads` → RLS violation |
| `viewer` LA | `shared_photos` = exactly LA's 2 rows; `photos` (allowed columns) = those 2 ids; `SELECT *` from `photos` → permission denied; `photo_derivatives` only thumb/display of those; `babies` (id,name,nickname,birth_date) = A; every other table (`photo_exif`, `photo_ai`, `photo_search`, `invites`, `baby_members`, `measurements`, `chat_*`, `audit_log`, `viewer_sessions`, `profiles`, `ai_batches`) → permission denied; any INSERT/UPDATE/DELETE → permission denied | viewer LA-expired / LA-revoked / LB claims → 0 rows from `shared_photos`, `photos`, `babies`; viewer with no claims → 0 rows |
| `pipeline` | `photos`/`photo_exif` (incl. gps enc columns)/`photo_ai`/`photo_search`/`ai_batches` across both babies; `share_links` without hashes (`SELECT token_hash` → permission denied); `invites`, `chat_*`, `baby_members`, `viewer_sessions` → permission denied | UPDATE `photos.status` ok; UPDATE `photos.approval` → permission denied; DELETE photo trashed 31 days ago → 1 row, trashed yesterday → 0 rows; INSERT `shared_photos` rule → ok (non-sensitive) / trigger error (sensitive) |
| `tinyglow_api` without `SET ROLE` | `SELECT 1` ok; `SELECT * FROM photos` → permission denied; `SET ROLE pipeline` → error | – |
| `anon` | permission denied on every app table | – |

- Done-when: `pnpm test` green; `DATABASE_URL=postgres://postgres:dev@localhost:5432/tinyglow
  AUTH_DB_PASSWORD=dev API_DB_PASSWORD=dev WORKER_DB_PASSWORD=dev DATA_ENCRYPTION_KEY=dev-only-data-encryption-key-32-chars-min SEED_DEMO_FAMILY=true pnpm test:integration`
  green both against the dev stack and against a bare pgvector (stub path); `pnpm smoke` green.

### Parallelism summary

| Group | Tasks | Notes |
| --- | --- | --- |
| B (parallel) | lane S: 2.1 → 2.2 → 2.4 → 2.3 · 2.5 → 2.6 · 2.7 | Disjoint paths. 2.7's done-when needs lane S; 2.6's done-when needs 2.7 |
| C (serial) | 2.8 | Needs everything |
| Gate | orchestrator | Section 4 |

ai-engineer, frontend-engineer, mobile-engineer have no step-2 work.

## 4. Acceptance checks

Verbatim, PRD step 2: "Check: RLS tests prove a user cannot read another baby's rows; a
contributor cannot delete; a viewer role sees only `shared_photos`." Plus from the orchestrator:
seed one demo family idempotently on every dev start; `docker compose -f docker-compose.dev.yml
up` stays zero-setup and the step-1 smoke keeps passing.

Run from the repo root with Docker Desktop running.

1. Stack and ordering:
   ```sh
   docker compose -f docker-compose.dev.yml down -v
   docker compose -f docker-compose.dev.yml up -d --build --wait
   docker compose -f docker-compose.dev.yml ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.ExitCode}}'
   ```
   Expected: `db-init`, `migrate`, `storage-init` exited 0; `db auth storage mail api worker web` healthy.
2. App connections are not superuser:
   ```sh
   docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d tinyglow -Atc \
     "select distinct usename||' '||application_name from pg_stat_activity where application_name like 'tinyglow-%'"
   ```
   Expected: `tinyglow_api tinyglow-api`, `tinyglow_worker tinyglow-worker:<id>`; no `postgres tinyglow-*` lines.
3. RLS test suite (the PRD check):
   ```sh
   DATABASE_URL=postgres://postgres:dev@localhost:5432/tinyglow AUTH_DB_PASSWORD=dev \
   API_DB_PASSWORD=dev WORKER_DB_PASSWORD=dev SEED_DEMO_FAMILY=true \
   DATA_ENCRYPTION_KEY=dev-only-data-encryption-key-32-chars-min pnpm test:integration
   ```
   Expected: green, including `rls.integration.test.ts` cases named "another baby's rows are
   invisible", "contributor cannot delete", "viewer sees only shared_photos".
4. Manual spot checks (seed ids from 2.9; `PSQL="docker compose -f docker-compose.dev.yml exec -T db psql -d tinyglow -Atv ON_ERROR_STOP=0"`):
   ```sh
   # another user's baby: 0 rows (stranger uuid is not a member)
   $PSQL -U tinyglow_api -c "begin; set local role authenticated; select set_config('request.jwt.claims','{\"sub\":\"00000000-0000-4000-8000-0000000000ff\",\"role\":\"authenticated\"}',true); select count(*) from photos; rollback;"
   # contributor cannot delete
   $PSQL -U tinyglow_api -c "begin; set local role authenticated; select set_config('request.jwt.claims','{\"sub\":\"00000000-0000-4000-8000-000000000003\",\"role\":\"authenticated\"}',true); delete from photos; rollback;"   # ERROR: permission denied for table photos
   # viewer sees only shared_photos
   $PSQL -U tinyglow_api -c "begin; set local role viewer; select set_config('request.jwt.claims','{\"role\":\"viewer\",\"share_link_id\":\"00000000-0000-4000-8000-000000000200\"}',true); select count(*) from shared_photos; select count(*) from photos; select count(*) from photo_exif; rollback;"
   ```
   Expected: `0`; `permission denied`; `3`, `3`, then `permission denied for table photo_exif`.
   (`PGPASSWORD=dev` for the app roles.)
5. Seed idempotence: `docker compose -f docker-compose.dev.yml run --rm migrate pnpm db:seed`
   twice, then `$PSQL -U postgres -c "select (select count(*) from photos)||' '||(select count(*) from baby_members)||' '||(select count(*) from shared_photos)"` → `12 3 3` both times.
6. Every table locked down: `$PSQL -U postgres -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)"` → `0`.
7. Reversibility: `docker compose -f docker-compose.dev.yml run --rm migrate sh -c "pnpm db:migrate:down all && pnpm db:migrate && pnpm db:seed"` exits 0.
8. Types current: `DATABASE_URL=postgres://postgres:dev@localhost:5432/tinyglow pnpm --filter @tinyglow/db db:types && git diff --exit-code -- packages/db/src/generated`.
9. Step-1 smoke still green: `pnpm smoke` (includes the OTP email and storage-down checks).
10. Unit + lint + typecheck: `pnpm lint && pnpm typecheck && pnpm test`.
11. Hygiene: `grep -rn 'hex-32\|change-me' .env.dev` prints nothing; `git status --porcelain | grep -E '^\?\? \.env(\.local)?$'` prints nothing.

## 5. Risks and decisions (orchestrator to confirm or override)

- **D1 — Compose reorder for `auth.users` FKs (2.1).** `db-init` → `auth` → `migrate`. Deviates
  from the PRD YAML's `auth depends_on migrate` but satisfies its intent (role + schema before
  GoTrue). Alternative: no FK to `auth.users` at all (profiles anchored only by verified JWT
  `sub`); cheaper but loses integrity and cascade.
- **D2 — Role model (2.2).** Two LOGIN roles (`tinyglow_api`, `tinyglow_worker`, both
  NOINHERIT), `SET LOCAL ROLE` per transaction; `service_role` gets `BYPASSRLS` (Supabase
  semantics) and is reachable from the API only; the worker's `pipeline` role is NOBYPASSRLS with
  explicit policies. Changes step 1's `NOBYPASSRLS` assertion on `service_role`.
- **D3 — `public.users` does not exist**; `profiles` is the app row, every user FK targets
  `profiles(user_id)`, `profiles.user_id → auth.users ON DELETE CASCADE`.
- **D4 — Extra columns/tables beyond the PRD list**: `photos.approval/approved_by/approved_at`
  (FR-2.7 queue), `photos.taken_at/taken_at_estimated/age_days` (FR-4.2 effective capture time;
  keeps `photo_exif` viewer-free), `photos.is_sensitive` (gate usable without AI rows),
  `photos.duplicate_of_photo_id` (FR-2.5), status value `ingested`, `babies.birth_date_is_due_date`,
  `babies.home_label`, `babies.created_by`, `share_links.last_viewed_at/view_count` (FR-9.8),
  `photo_search.milestone_ids uuid[]` instead of `int[]`, `measurements.value_entered`,
  `profiles.accepted_ip_country`. No new tables beyond the PRD. Step 6 may add `ai_batch_items`;
  step 8 may add passcode-attempt tracking.
- **D5 — SQL-enforced product rules** (triggers): max 2 admins (PRD), last admin cannot leave
  (FR-1.5), invite rate limit 20/day, free-tier 1,000-photo cap, AI queue/`photo_ai` require
  `baby_ai_enabled`, sensitive photos never auto-shared, `raw_json` never carries GPS keys,
  contributor uploads pending. Each is cheap and testable; the API still validates first for
  friendly errors.
- **D6 — Soft delete only for users**: no role but `pipeline` (after 30 days) can hard-delete
  photos/babies; admins "delete" by setting `deleted_at`. Viewers never receive originals
  (`allow_download` means the display derivative; FR-4.4).
- **D7 — Encryption via pgcrypto + transaction-local GUC (2.7).** Alternative: AES-256-GCM in Node
  with the key never entering SQL; stronger isolation but two encryption paths (seed/tests) and a
  home-radius check that must run in the worker. Keep pgcrypto as the PRD names it; revisit if a
  managed KMS is adopted.
- **D8 — Search/chat gated at the policy level** (`photo_search` and `chat_*` require
  `is_baby_admin AND baby_ai_enabled`). Downgrading to free hides existing descriptions from
  search until re-upgrade; `photo_ai` rows stay readable in the viewer details panel.
- **R1 — GoTrue compatibility of SQL-seeded users (2.9).** Verified only in step 3's OTP e2e.
  Fallback: seed via GoTrue admin API (`auth` is already healthy when the seed runs).
- **R2 — Existing dev volumes** from step 1 have `pgboss` owned by `postgres`; bootstrap
  transfers ownership. If anything else differs, `pnpm dev:reset` is the documented escape hatch.
- **R3 — pg-boss as a non-owner-of-database role.** Needs `CREATE ON DATABASE` (Postgres checks it
  even for `CREATE SCHEMA IF NOT EXISTS`). If pg-boss 10+ needs more (e.g. `pg_catalog` functions),
  backend-engineer reports and security-engineer grants minimally.
- **R4 — Column-level grants + RLS** make `SELECT *` fail for `viewer`/`pipeline` on restricted
  tables; API code (steps 4–8) must always name columns. Documented in README.
- **R5 — Postgres logging of bind parameters.** Defaults are safe; production must not enable
  `log_statement = all`, `log_parameter_max_length_on_error > 0`, or `pg_stat_statements` with
  parameter capture. devops adds the comment; reviewer checks.
- **R6 — In-house type generator** instead of Kanel/kysely-codegen (no new dependency, no ESM
  config risk, deterministic). Swap to Kanel later is a one-task change if the orchestrator prefers
  a maintained tool.
- **R7 — `SECURITY DEFINER` trigger functions** owned by the superuser bypass RLS by design;
  every one pins `search_path = pg_catalog, public` and reads only what it must. Reviewer should
  check each for injection via `format(%I/%L)` (none should need dynamic SQL).
- **R8 — Policy performance**: `photo_visible()` is SECURITY INVOKER and re-evaluates `photos`
  policies per child row; fine at 50k photos/baby with the `(baby_id, …)` indexes, but step 5/7
  should measure and may denormalise `baby_id` onto child tables if needed.
- **Needs the user**: nothing in this step. Secrets for production (`API_DB_PASSWORD`,
  `WORKER_DB_PASSWORD`, `DATA_ENCRYPTION_KEY`) are generated on the server from `.env.example`.
