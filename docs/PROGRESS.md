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
