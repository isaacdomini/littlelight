# Step 1 plan: Scaffold

Status: proposed (architect, 2026-10-08). PRD step: "Build handoff for Claude Code → Build order → 1. Scaffold".
Applies `CLAUDE.md` "Spec clarifications" (self-hosted GoTrue, MinIO everywhere, no hosted Supabase).

## 1. Goal

Stand up the pnpm monorepo, lint/format, test runner, CI, Dockerfiles, `docker-compose.yml`
(production) and `docker-compose.dev.yml` (local), `.env.dev` and `.env.example`, so that a fresh
clone with no folders or env files to create runs `docker compose -f docker-compose.dev.yml up`
and every service comes up healthy: Postgres+pgvector, self-hosted GoTrue, MinIO, Mailpit, a
Fastify API with a real `/healthz`, a pg-boss worker with a heartbeat-row healthcheck, and a
React+Vite+Ionic+Tailwind web shell at `http://localhost:8080` whose `/api` and `/auth` proxies
match production nginx. Requesting an email OTP through `/auth` on :8080 lands a 6-digit code in
Mailpit (:8025). CI builds every image and runs typecheck + tests. Only the minimum schema ships
here (auth bootstrap, extensions, worker heartbeat table); the full data model is step 2.

## 2. Interfaces first

Everything below is a contract. Agents build to it without asking each other; deviations go
through the orchestrator.

### 2.1 Workspace packages

| Package name | Path | Depends on (workspace) | Entry |
| --- | --- | --- | --- |
| `@tinyglow/shared` | `packages/shared` | – | `src/index.ts` |
| `@tinyglow/ai` | `packages/ai` | shared | `src/index.ts` |
| `@tinyglow/db` | `packages/db` | – | `src/migrate.ts`, `src/seed.ts`, `src/bootstrap.ts` |
| `@tinyglow/api` | `apps/api` | shared, ai | `src/server.ts` (prod: `dist/server.js`) |
| `@tinyglow/worker` | `apps/worker` | shared, ai | `src/main.ts` (prod: `dist/main.js`), `src/healthcheck.ts` (prod: `dist/healthcheck.js`) |
| `@tinyglow/mobile-web` | `apps/mobile-web` | shared | Vite app; prod output `dist/` |

- All packages are `"type": "module"`, TypeScript, `"private": true`.
- `packages/shared` and `packages/ai` export **TypeScript source** (`"main"`/`"types"`/`"exports"` →
  `./src/index.ts`). Consumers (tsx, tsup, Vite, Vitest) all consume TS directly, so the dev bind
  mounts of `packages/*/src` hot-reload without a build step. No `dist` for packages.
- Pins: Node `22.23.3` (containers: `node:22.23.3-alpine`; `.nvmrc` = `22.23.3`;
  `engines.node = ">=22.12 <23"` — host Node 25 only warns, `engine-strict=false`). pnpm `12.10.1`
  (`"packageManager": "pnpm@12.10.1"` for corepack on the host; **Dockerfiles install pnpm with
  `npm i -g pnpm@12.10.1`** since corepack is no longer bundled with Node 25 and is deprecated in 22).
- Every dependency pinned exact (no `^`), current stable at scaffold time.

### 2.2 Root scripts (root `package.json`)

| Script | Runs |
| --- | --- |
| `dev` | `docker compose -f docker-compose.dev.yml up --build` |
| `dev:down` | `docker compose -f docker-compose.dev.yml down` |
| `dev:reset` | `docker compose -f docker-compose.dev.yml down -v && docker compose -f docker-compose.dev.yml up --build` |
| `typecheck` | `pnpm -r --parallel typecheck` (each package: `tsc --noEmit -p tsconfig.json`) |
| `lint` | `biome check .` |
| `format` | `biome format --write .` |
| `test` | `vitest run` (root config with `test.projects: ["apps/*", "packages/*"]`; unit tests only, no DB/network) |
| `test:integration` | `vitest run --project db-integration` — skipped unless `DATABASE_URL` set (used with the dev stack) |
| `build` | `pnpm -r build` |
| `db:migrate` / `db:migrate:down` / `db:seed` / `db:bootstrap` | `pnpm --filter @tinyglow/db <same>` |
| `smoke` | `bash e2e/smoke/dev-stack.sh` |

Per-package scripts every Dockerfile/compose command relies on:

| Package | `dev` | `build` | `start` | other |
| --- | --- | --- | --- | --- |
| api | `tsx watch src/server.ts` | `tsup` → `dist/server.js` | `node dist/server.js` | `typecheck`, `test` |
| worker | `tsx watch src/main.ts` | `tsup` → `dist/main.js`, `dist/healthcheck.js` | `node dist/main.js` | `healthcheck` = `tsx src/healthcheck.ts` (dev) |
| mobile-web | `vite` | `vite build` | – | `preview`, `typecheck`, `test` |
| db | – | – | – | `db:bootstrap` = `tsx src/bootstrap.ts`; `db:migrate` = `tsx src/migrate.ts up` (runs bootstrap first); `db:migrate:down` = `tsx src/migrate.ts down`; `db:seed` = `tsx src/seed.ts`; `db:migrate:create <name>` |
| shared, ai | – | – | – | `typecheck`, `test` |

### 2.3 Ports and service names (dev)

| Compose service | Image (pinned) | Container port | Host port (dev) | Healthcheck |
| --- | --- | --- | --- | --- |
| `db` | `pgvector/pgvector:0.8.7-pg17` | 5432 | 5432 | `pg_isready -U postgres -d tinyglow` |
| `migrate` (one-shot) | build `packages/db/Dockerfile` | – | – | exits 0 |
| `auth` | `supabase/auth:v2.197.0` | 9999 | 9999 | `wget --no-verbose --tries=1 --spider http://localhost:9999/health` |
| `storage` | `${MINIO_IMAGE:-pgsty/minio:RELEASE.2026-08-04T00-00-00Z}` (see Risk R1) | 9000 (S3), 9001 (console) | 9000, 9001 | `curl -sf http://localhost:9000/minio/health/live \|\| mc ready local` (devops verifies which binary the image ships) |
| `storage-init` (one-shot) | `${MC_IMAGE:-pgsty/mc:RELEASE.2026-09-16T00-00-00Z}` (Risk R1) | – | – | exits 0 after `mc mb -p local/tinyglow-dev` |
| `mail` | `axllent/mailpit:v1.31.4` | 1025 (SMTP, internal only), 8025 (UI/API) | 8025 | `["CMD","/mailpit","readyz"]` |
| `api` | build `apps/api/Dockerfile` target `dev` | 3000 | 3000 | `node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` |
| `worker` | build `apps/worker/Dockerfile` target `dev` | – | – | `pnpm --filter @tinyglow/worker healthcheck` (dev) / `node dist/healthcheck.js` (prod) |
| `web` | build `apps/mobile-web/Dockerfile` target `dev` | 8080 | 8080 | `wget -qO- http://localhost:8080/ >/dev/null` (dev) / `wget -qO- http://localhost/healthz` (prod nginx) |

Production-only services: `cloudflared` (`cloudflare/cloudflared:2026.10.0`), `backup`
(`pgvector/pgvector:0.8.7-pg17`, nightly `pg_dump`, 35-day retention). Prod `web` is
`nginx:1.28-alpine` serving the Vite build on port 80 (PRD routes `http://web:80`).

Dependency order (both files): `db` → `migrate` → {`auth`, `api`, `worker`}; `storage` →
`storage-init` → {`api`, `worker`} (`condition: service_completed_successfully` so `/healthz`'s
bucket check cannot race bucket creation); `web` → {`api`, `auth`}. One-shots have `restart: "no"`.

### 2.4 Routing (identical in Vite dev proxy and production nginx)

| Browser path | Target | Prefix stripped | Notes |
| --- | --- | --- | --- |
| `/api/*` | `http://api:3000/*` | yes (`/api/healthz` → `/healthz`) | nginx: `proxy_buffering off` (SSE later), `client_max_body_size 50m` (Cloudflare 100 MB cap) |
| `/auth/*` | `http://auth:9999/*` | yes (`/auth/otp` → `/otp`, `/auth/health` → `/health`) | supabase-js is pointed at `http://<origin>/auth` in step 3 |
| `/.well-known/apple-app-site-association` | static file, `Content-Type: application/json` | – | placeholder JSON in step 1 (real values step 9) |
| `/.well-known/assetlinks.json` | static file | – | placeholder `[]` |
| `/email-templates/*` | static files from `docker/gotrue/templates/` | – | GoTrue fetches its email templates here (see 2.6) |
| `/healthz` (prod nginx only) | `return 200 "ok"` | – | nginx container healthcheck |
| `/*` | SPA `index.html` | – | `try_files $uri /index.html` |

Vite dev: `server.proxy` for `/api` and `/auth` with `rewrite` stripping the prefix; targets from
`VITE_PROXY_API_TARGET` (default `http://api:3000`) and `VITE_PROXY_AUTH_TARGET` (default
`http://auth:9999`) so the same config works on the host (`http://localhost:3000`, `:9999`).
`server.allowedHosts` must include `web` (GoTrue fetches templates at `http://web:8080/...`) plus
`VITE_ALLOWED_HOSTS` (comma list) for LAN phone hostnames; IPs are allowed by default.
`server.watch.usePolling` is enabled when `VITE_USE_POLLING=1` (macOS bind-mount fallback).

### 2.5 Environment variables

`.env.dev` (committed, dev-only values; loaded via `env_file` by `migrate`, `auth`, `api`,
`worker`, `web`, `storage-init`; `.env.local` optional override, git-ignored):

| Variable | Dev value | Used by |
| --- | --- | --- |
| `NODE_ENV` | `development` | api, worker, web |
| `LOG_LEVEL` | `debug` | api, worker |
| `DATABASE_URL` | `postgres://postgres:dev@db:5432/tinyglow` | migrate, api, worker (superuser in step 1; step 2 introduces an app role) |
| `AUTH_DB_PASSWORD` | `dev` | migrate (creates `supabase_auth_admin` with this password) |
| `JWT_SECRET` | `dev-only-jwt-secret-at-least-32-characters` | api, worker (verifies GoTrue JWTs from step 3) |
| `GOTRUE_JWT_SECRET` | same literal as `JWT_SECRET` | auth. **Must match `JWT_SECRET`**; api/worker config asserts equality at boot when both are present and refuses to start otherwise |
| `GOTRUE_API_HOST` / `GOTRUE_API_PORT` | `0.0.0.0` / `9999` | auth |
| `GOTRUE_DB_DRIVER` | `postgres` | auth |
| `GOTRUE_DB_DATABASE_URL` | `postgres://supabase_auth_admin:dev@db:5432/tinyglow` | auth |
| `GOTRUE_SITE_URL` | `http://localhost:8080` | auth |
| `API_EXTERNAL_URL` | `http://localhost:8080/auth` | auth (email links go through the nginx/Vite `/auth` prefix) |
| `GOTRUE_URI_ALLOW_LIST` | `http://localhost:8080/**` | auth |
| `GOTRUE_JWT_EXP` / `GOTRUE_JWT_AUD` / `GOTRUE_JWT_DEFAULT_GROUP_NAME` / `GOTRUE_JWT_ADMIN_ROLES` / `GOTRUE_JWT_ISSUER` | `3600` / `authenticated` / `authenticated` / `service_role` / `http://localhost:8080/auth` | auth |
| `GOTRUE_EXTERNAL_EMAIL_ENABLED` / `GOTRUE_DISABLE_SIGNUP` / `GOTRUE_MAILER_AUTOCONFIRM` | `true` / `false` / `false` | auth |
| `GOTRUE_MAILER_OTP_EXP` / `GOTRUE_MAILER_OTP_LENGTH` | `600` / `6` | auth (PRD: code valid 10 min, 6 digits) |
| `GOTRUE_SMTP_HOST` / `GOTRUE_SMTP_PORT` / `GOTRUE_SMTP_ADMIN_EMAIL` / `GOTRUE_SMTP_SENDER_NAME` | `mail` / `1025` / `noreply@tinyglow.local` / `Tinyglow` | auth (no `SMTP_USER`/`PASS` in dev) |
| `GOTRUE_SMTP_MAX_FREQUENCY` / `GOTRUE_RATE_LIMIT_EMAIL_SENT` | `1s` / `1000` | auth (dev only; PRD production limits are set in step 3) |
| `GOTRUE_MAILER_TEMPLATES_CONFIRMATION` / `GOTRUE_MAILER_TEMPLATES_MAGIC_LINK` | `http://web:8080/email-templates/confirmation.html` / `http://web:8080/email-templates/magic-link.html` | auth (see 2.6) |
| `GOTRUE_MAILER_SUBJECTS_CONFIRMATION` / `GOTRUE_MAILER_SUBJECTS_MAGIC_LINK` | `Your Tinyglow sign-in code` | auth |
| `GOTRUE_EXTERNAL_APPLE_ENABLED` / `GOTRUE_EXTERNAL_GOOGLE_ENABLED` | `false` / `false` | auth (step 3 flips with real client IDs) |
| `S3_ENDPOINT` | `http://storage:9000` | api, worker (server-side) |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | api (pre-signed URLs, step 4) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `dev` / `devdevdev` | api, worker, storage-init (`storage` reads the same literals as `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in the compose file, written as `${S3_ACCESS_KEY:-dev}` style defaults) |
| `S3_BUCKET` | `tinyglow-dev` | api, worker, storage-init |
| `S3_REGION` / `S3_FORCE_PATH_STYLE` | `us-east-1` / `true` | api, worker |
| `API_HOST` / `API_PORT` | `0.0.0.0` / `3000` | api |
| `HEARTBEAT_INTERVAL_MS` / `HEARTBEAT_STALE_MS` | `10000` / `30000` | worker |
| `VISION_PROVIDER` / `VISION_MODEL` / `VISION_REASONING_EFFORT` | `openai` / `gpt-6-luna` / `none` | worker (step 6) |
| `CHAT_MODEL` / `CHAT_REASONING_EFFORT` | `gpt-6-luna` / `low` | api (step 7) |
| `EMBED_MODEL` / `EMBED_DIMS` | `text-embedding-3-small` / `1024` | worker, api |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | **absent** (go in `.env.local`) | worker logs `AI disabled: OPENAI_API_KEY not set` at boot |
| `VITE_PROXY_API_TARGET` / `VITE_PROXY_AUTH_TARGET` / `VITE_ALLOWED_HOSTS` / `VITE_USE_POLLING` | `http://api:3000` / `http://auth:9999` / `web` / (unset) | web (dev server only) |

`.env.example` (committed, production documentation, placeholder values only — never real
secrets): all of the above that are production-relevant plus `POSTGRES_PASSWORD`,
`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` (Postmark or Resend), `STORAGE_PATH`,
`BACKUP_PATH`, `CLOUDFLARE_TUNNEL_TOKEN`, `APPLE_*`, `GOOGLE_*`, `POSTMARK_TOKEN`/`RESEND_API_KEY`,
`REVENUECAT_*`, `STRIPE_*`, `SENTRY_DSN`, `MINIO_IMAGE`, `MC_IMAGE`. The production compose maps
`GOTRUE_JWT_SECRET: ${JWT_SECRET}` and `GOTRUE_SMTP_*: ${SMTP_*}` (PRD style; `.env` is auto-loaded
for interpolation in production, which is why the dev file cannot use the same trick and carries
the duplicated-but-asserted literal). Per `CLAUDE.md`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` are **not** used anywhere; `.env.example` says so in a comment.

### 2.6 GoTrue bootstrap and email

- `migrate` connects as the Postgres superuser (`DATABASE_URL`) and, before any app migration,
  runs the idempotent bootstrap (mirrors `supabase/auth` `hack/init_postgres.sql`):
  `CREATE ROLE supabase_auth_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION PASSWORD
  '<AUTH_DB_PASSWORD>'` (then `ALTER ROLE ... PASSWORD` on every run so password changes apply);
  `CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin`;
  `GRANT CREATE ON DATABASE tinyglow TO supabase_auth_admin`;
  `ALTER ROLE supabase_auth_admin SET search_path = 'auth'`;
  plus `NOLOGIN` roles `anon`, `authenticated`, `service_role` (created if missing) so GoTrue's
  JWT `role` claims map to real Postgres roles in step 2. GoTrue runs its own migrations in
  `auth.*` on container start (it needs no more than this).
- OTP flow: `POST /auth/otp {"email","create_user":true}` → GoTrue sends the **confirmation**
  template for a new address and the **magic link** template for an existing one. GoTrue's
  built-in templates contain only a link, so both templates are customized in
  `docker/gotrue/templates/{confirmation,magic-link}.html` to show `{{ .Token }}` (the 6-digit
  code, primary per `CLAUDE.md`) and `{{ .ConfirmationURL }}` (web-only fallback link). Templates
  are served over HTTP by the `web` service in both environments (dev: Vite serves
  `./docker/gotrue/templates` bind-mounted read-only at `apps/mobile-web/public/email-templates`;
  prod: `COPY docker/gotrue/templates /usr/share/nginx/html/email-templates`).
- Mailpit accepts unauthenticated SMTP on `mail:1025` (`MP_SMTP_AUTH_ACCEPT_ANY=1`,
  `MP_SMTP_AUTH_ALLOW_INSECURE=1`). Its REST API (`GET /api/v1/search?query=to:<email>`,
  `GET /api/v1/message/<ID>`) is what the smoke test reads.

### 2.7 Database (step 1 only; full schema is step 2)

Migration tool: **node-pg-migrate** with **plain SQL migration files** (`-- Up Migration` /
`-- Down Migration` markers), tracked in `public.pgmigrations`. Why: pure Node (no extra binary in
the `migrate` image), reversible by construction (PRD "Each migration is reversible"), and
reviewers read raw SQL for RLS policies. Role/schema bootstrap is a separate idempotent TS
script, not a migration, because it needs `AUTH_DB_PASSWORD` from the environment and is by
nature not reversible.

| Migration | Up | Down |
| --- | --- | --- |
| `<ts>_extensions.sql` | `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;` | drop both |
| `<ts>_worker_heartbeats.sql` | table below + `ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;` (no policies yet: only the owner/superuser may read; step 2 adds a policy for the app role) | drop table |

`public.worker_heartbeats`: `worker_id text PRIMARY KEY`, `hostname text NOT NULL`,
`pid int NOT NULL`, `version text NOT NULL`, `started_at timestamptz NOT NULL DEFAULT now()`,
`last_seen_at timestamptz NOT NULL DEFAULT now()`, `storage_ok boolean NOT NULL DEFAULT false`,
`details jsonb NOT NULL DEFAULT '{}'`.

pg-boss creates and owns schema `pgboss` itself on first `boss.start()`; it is intentionally
outside our migrations (documented in `packages/db/README.md`).

Seed (`src/seed.ts`): idempotent no-op in step 1 (logs `seed: nothing to seed yet`), exit 0.
Step 2 fills in the demo family.

### 2.8 API (`@tinyglow/api`)

| Route | Request | Response | Notes |
| --- | --- | --- | --- |
| `GET /healthz` | – | `HealthzResponse` (200 if every check ok, else 503) | checks: `db` (`SELECT 1` via pg pool), `storage` (`HeadBucket` on `S3_BUCKET` via `S3_ENDPOINT`). Error strings must never include credentials or connection URLs. |

Files: `src/server.ts` (listen), `src/app.ts` (`buildApp()` for tests, zod type provider,
pino logger with `redact` for `authorization`/`cookie` headers), `src/config.ts` (zod env),
`src/plugins/db.ts` (pg `Pool` decorator), `src/plugins/storage.ts` (`S3Client` decorator with
`forcePathStyle`), `src/routes/healthz.ts`. No auth plugin yet (step 3); no `auth/`, `sharing/`,
`chat/`, `search/` directories created in step 1.

### 2.9 Worker (`@tinyglow/worker`)

- `src/main.ts`: load config, start pg-boss (`new PgBoss({ connectionString: DATABASE_URL })`,
  `boss.on('error', log)`), start heartbeat loop, log `AI disabled: OPENAI_API_KEY not set` (or
  `AI enabled: provider=<p> model=<m>`) using `isAiConfigured()` from `@tinyglow/ai`.
  Graceful shutdown on SIGTERM. No job handlers registered yet.
- `src/heartbeat.ts`: every `HEARTBEAT_INTERVAL_MS`, `HeadBucket` on `S3_BUCKET`, then upsert
  the row for `WORKER_ID` (= `os.hostname()`, unique per container so `--scale worker=3` works)
  with `last_seen_at = now()` **only when storage is reachable**, `storage_ok` accordingly; delete
  rows with `last_seen_at < now() - interval '1 day'`.
- `src/healthcheck.ts`: exits 0 iff the own row exists and `last_seen_at > now() - HEARTBEAT_STALE_MS`
  (and therefore storage was reachable within the window). Exit 1 otherwise; never throws.
- Payload rule (PRD-wide): job payloads carry IDs and keys only, never photo bytes. No jobs yet.
- The 80%-disk alert from "Compose requirements" is deferred to step 4 (needs MinIO admin API).

### 2.10 Shared contracts (`@tinyglow/shared`, architect-defined, backend-engineer writes)

- `src/constants.ts`: `APP_NAME = "Tinyglow"`, `API_PREFIX = "/api"`, `AUTH_PREFIX = "/auth"`,
  `EMBED_DIMS = 1024`, `DEFAULT_VISION_PROVIDER = "openai"`, `DEFAULT_VISION_MODEL = "gpt-6-luna"`,
  `DEFAULT_VISION_REASONING_EFFORT = "none"`, `DEFAULT_CHAT_MODEL = "gpt-6-luna"`,
  `DEFAULT_CHAT_REASONING_EFFORT = "low"`, `DEFAULT_EMBED_MODEL = "text-embedding-3-small"`,
  `SHARE_LINK_DEFAULT_TTL_HOURS = 24`, `FREE_TIER_PHOTO_LIMIT = 1000`.
- `src/env.ts` (zod): `databaseEnvSchema` (`DATABASE_URL`: url), `s3EnvSchema` (`S3_ENDPOINT`,
  `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION` default
  `us-east-1`, `S3_FORCE_PATH_STYLE` coerced boolean default `true`), `jwtEnvSchema`
  (`JWT_SECRET` min 32 chars, optional `GOTRUE_JWT_SECRET` that must equal it when present),
  `logEnvSchema` (`LOG_LEVEL` enum, `NODE_ENV` enum).
- `src/health.ts`: `healthzCheckSchema = { ok: boolean, latencyMs?: number, error?: string }`,
  `healthzResponseSchema = { status: "ok" | "degraded", service: string, version: string,
  uptimeSec: number, checks: { db: healthzCheck, storage: healthzCheck } }`, exported types
  `HealthzResponse`, `HealthzCheck`.
- `src/index.ts` re-exports. Only `zod` as a dependency. No runtime clients in shared.

### 2.11 AI interfaces (`@tinyglow/ai`, stubs only)

- `src/types.ts`: `VisionDescriber` (`describeBatch(requests: VisionRequest[]): Promise<VisionBatchHandle>`,
  `pollBatch(handle)`, `describeOne(request)` for the priority path), `ChatModel`
  (`complete(messages, tools, options)` returning text + tool calls + usage, streaming variant),
  `Embedder` (`embed(texts: string[]): Promise<number[][]>`, `dims`, `model`). Request types
  carry the compressed analysis image bytes + context, never GPS, never originals (comment it).
  Result types carry `raw: unknown` + usage/cost fields; schema validation of the description
  lives in `packages/shared` from step 6 (PRD: shared holds the AI description schema v1).
- `src/env.ts`: `aiEnvSchema` (`OPENAI_API_KEY?`, `ANTHROPIC_API_KEY?`, `VISION_PROVIDER` enum
  `openai|anthropic`, `VISION_MODEL`, `VISION_REASONING_EFFORT` enum `none|low|medium|high`,
  `CHAT_MODEL`, `CHAT_REASONING_EFFORT`, `EMBED_MODEL`, `EMBED_DIMS` coerced int) with the
  defaults from shared constants; `isAiConfigured(env): boolean` (true iff the key for
  `VISION_PROVIDER` is set).
- `src/index.ts`: factories `createVisionDescriber(env)`, `createChatModel(env)`,
  `createEmbedder(env)` that throw `AiNotConfiguredError` in step 1. No provider SDKs added yet.

### 2.12 Web shell (`@tinyglow/mobile-web`)

Ionic React app, `IonTabs` with the PRD's five tabs (Chat, Timeline, Upload, Milestones,
Family) as placeholder pages; Tailwind v4 via `@tailwindcss/vite`; TanStack Query provider;
a small `SystemStatus` component on the Chat page that fetches `/api/healthz` (parsed with
`healthzResponseSchema`) and `/auth/health` to prove both proxies. `index.html` has
`viewport-fit=cover` and title "Tinyglow". `public/.well-known/apple-app-site-association`
and `public/.well-known/assetlinks.json` placeholders. No Capacitor yet (`ios/`, `android/`,
`capacitor.config.ts` arrive in step 9); no auth UI yet (step 3).

### 2.13 Dockerfile contract (devops)

| Dockerfile | Stages | Prod runtime |
| --- | --- | --- |
| `apps/api/Dockerfile` | `base` (node:22.23.3-alpine, pnpm, workspace manifests, `pnpm install --frozen-lockfile --filter @tinyglow/api...`) → `dev` (full source copied; compose bind-mounts `src` dirs over it) → `build` (`pnpm --filter @tinyglow/api build`) → `prod` | non-root `node`, `dist/` + production `node_modules`, `CMD ["node","apps/api/dist/server.js"]`, `HEALTHCHECK` as in 2.3 |
| `apps/worker/Dockerfile` | same shape | `CMD ["node","apps/worker/dist/main.js"]`, healthcheck `node apps/worker/dist/healthcheck.js` |
| `apps/mobile-web/Dockerfile` | `base` → `dev` (vite) → `build` (`vite build`) → `prod` (`nginx:1.28-alpine`, `docker/nginx/default.conf`, `COPY --from=build dist`, `COPY docker/gotrue/templates .../email-templates`) | port 80 |
| `packages/db/Dockerfile` | single stage node:22.23.3-alpine with `@tinyglow/db` deps; `CMD ["pnpm","db:migrate"]`; dev compose overrides `command: sh -c "pnpm db:migrate && pnpm db:seed"` | runs as non-root `node` |

Rules: build context is the repo root; `.dockerignore` excludes `node_modules`, `dist`, `.git`,
`apps/mobile-web/{ios,android}`, `.env`, `.env.local`. Dev bind mounts cover only `src`
directories (exactly as the PRD YAML), so image `node_modules` (root and per-package) are never
shadowed; never bind-mount a whole package directory. `tsup` bundles workspace packages
(`noExternal: [/^@tinyglow\//]`) and leaves npm deps external.

## 3. Tasks

Owners per `CLAUDE.md` file-ownership. Root-level monorepo files are **not** in that table; this
plan assigns them explicitly (see 1.1 and 1.7). Same-owner tasks run in sequence.

### 1.1 Monorepo root scaffold (devops-engineer) — runs first, alone

- Owned paths (assigned by this plan): `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
  `.npmrc`, `.nvmrc`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `.editorconfig`,
  `.dockerignore`, `README.md`, `.gitignore` (extend only), and the **initial** `package.json` +
  `tsconfig.json` + placeholder `src/index.ts` (`export {};`) of all six workspace packages,
  including every dependency named in section 2 and in the dep list below. After 1.1, each
  package's `package.json` belongs to its path owner, but adding a dependency requires
  orchestrator approval and a serial `pnpm install` by devops (the lockfile is shared; two
  agents running `pnpm install` in parallel will conflict).
- Deps to include (current stable, pinned exact): root dev: `typescript`, `@biomejs/biome`,
  `vitest`, `tsx`, `tsup`, `@types/node`. shared: `zod`. ai: `zod`. db: `pg`, `@types/pg`,
  `node-pg-migrate`. api: `fastify`, `fastify-type-provider-zod`, `zod`, `pg`, `@types/pg`,
  `@aws-sdk/client-s3`, `pino-pretty` (dev). worker: `pg-boss`, `pg`, `@types/pg`,
  `@aws-sdk/client-s3`, `pino`, `pino-pretty` (dev), `zod`. mobile-web: `react`, `react-dom`,
  `@ionic/react`, `@ionic/react-router`, `react-router` + `react-router-dom` (the versions
  `@ionic/react-router` peer-depends on), `ionicons`, `@tanstack/react-query`, `zod`,
  `tailwindcss`, `@tailwindcss/vite`, `vite`, `@vitejs/plugin-react`, `@types/react`,
  `@types/react-dom`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`.
- Lint/format decision: **Biome** (one tool, one config, formatter + linter, `pnpm lint` /
  `pnpm format`). Test runner: **Vitest** with root `test.projects`.
- Inputs: this plan. Done-when: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck
  && pnpm test` pass on the host (Node 25 warns on engines only), `pnpm -r exec pwd` lists all
  six packages.

### 1.2 Database package: bootstrap, migrations, seed (security-engineer) — parallel group B

- Owned: `packages/db/**` (except `packages/db/Dockerfile`, devops).
- Build `src/bootstrap.ts`, `src/migrate.ts` (node-pg-migrate programmatic runner: dir
  `migrations/`, SQL files, `up`/`down <n>`; runs bootstrap before `up`), `src/seed.ts` (no-op,
  idempotent), `migrations/<ts>_extensions.sql`, `migrations/<ts>_worker_heartbeats.sql`,
  `README.md` (how to create/run/revert, pg-boss schema note), scripts from 2.2. Everything
  idempotent: a second `pnpm db:migrate` is a no-op. Security: bootstrap never logs the password;
  RLS enabled on `worker_heartbeats` (section 2.7).
- Inputs: 1.1. Done-when: against the dev `db` container (`DATABASE_URL=postgres://postgres:dev@localhost:5432/tinyglow`):
  `pnpm db:migrate` succeeds twice, `psql -c '\dx'` shows `vector` and `pgcrypto`, role
  `supabase_auth_admin` can `\dn auth`, `pnpm db:migrate:down 2` then `up` round-trips cleanly,
  `pnpm db:seed` exits 0.

### 1.3 Shared contracts (backend-engineer) — parallel group B (first of backend's sequence)

- Owned: `packages/shared/**` (architect-defined shapes in 2.10; orchestrator approval implied by
  this plan).
- Inputs: 1.1. Done-when: exports exactly the names in 2.10; `pnpm --filter @tinyglow/shared
  typecheck` passes; unit tests (1.9) validate a sample healthz payload and the
  `JWT_SECRET`/`GOTRUE_JWT_SECRET` mismatch refinement.

### 1.4 API skeleton (backend-engineer) — after 1.3

- Owned: `apps/api/**` except `apps/api/Dockerfile` (devops) and the not-yet-existing
  `auth/`, `sharing/`, `chat/`, `search/` dirs (do not create them).
- Build per 2.8. Config fails fast on missing/invalid env (zod `safeParse`, print the field names
  only). Pino redacts `req.headers.authorization` and `req.headers.cookie`. `/healthz` returns
  503 with `status: "degraded"` when either check fails; never echoes `DATABASE_URL` or S3 keys.
- Inputs: 1.3. Done-when: `pnpm --filter @tinyglow/api typecheck` passes; with the dev stack up,
  `curl -s http://localhost:3000/healthz` returns `{"status":"ok",...,"checks":{"db":{"ok":true..},"storage":{"ok":true..}}}`;
  stopping `storage` flips it to 503 within one request.

### 1.5 Worker skeleton (backend-engineer) — after 1.3 (may interleave with 1.4)

- Owned: `apps/worker/**` except `apps/worker/Dockerfile` (devops) and `apps/worker/src/ai/**`
  (ai-engineer; do not create). Build per 2.9. Uses `isAiConfigured` from `@tinyglow/ai` (1.6);
  if 1.6 is not merged yet, build against the signature in 2.11.
- Inputs: 1.3, 1.2 (table), 1.6 (type only). Done-when: with the dev stack up, `SELECT * FROM
  worker_heartbeats` shows one row per worker container refreshing every 10 s with
  `storage_ok = true`; `docker compose -f docker-compose.dev.yml stop storage` makes the worker
  container turn `unhealthy` within ~45 s; logs contain the `AI disabled` line.

### 1.6 AI package stubs (ai-engineer) — parallel group B

- Owned: `packages/ai/**`. Build per 2.11. No SDK dependencies, no network. Document in
  `packages/ai/README.md` the PRD-wide rules the real adapters must obey (768 px analysis copy
  only, never originals, never GPS, Batch API for describe, free-tier photos never submitted,
  provider selected by config).
- Inputs: 1.1 (and shared constants from 1.3; if not yet merged, mirror the literal defaults and
  switch the import once 1.3 lands). Done-when: typecheck passes; `createVisionDescriber(env)`
  throws `AiNotConfiguredError`; `isAiConfigured({})` is `false`, `isAiConfigured({OPENAI_API_KEY:"x"})` is `true`.

### 1.7 Web shell (frontend-engineer) — parallel group B

- Owned: `apps/mobile-web/src/**`, plus (assigned by this plan) `apps/mobile-web/vite.config.ts`,
  `index.html`, `public/**`, `tsconfig*.json`, `vitest.config.ts`, `postcss`/Tailwind config and
  `package.json` (no new deps without approval). Not owned: `apps/mobile-web/Dockerfile`,
  `ios/`, `android/`, `capacitor.config.ts`.
- Build per 2.12 and the Vite proxy/allowedHosts/polling rules in 2.4. Mobile-first at 375 px;
  44 px touch targets on the tab bar; no analytics or logging of user data.
- Inputs: 1.1; `healthzResponseSchema` from 1.3 (shape fixed in 2.10, so work can start before
  1.3 merges). Done-when: `pnpm --filter @tinyglow/mobile-web build` emits `dist/index.html`
  and `dist/.well-known/*`; on the dev stack `http://localhost:8080` renders the tab bar and the
  status component shows API `ok` and auth `ok`; `curl -s http://localhost:8080/api/healthz` and
  `curl -s http://localhost:8080/auth/health` succeed through the Vite proxy; `curl -s -H 'Host: web:8080'
  http://localhost:8080/email-templates/magic-link.html` returns the template (allowedHosts).

### 1.8 Dockerfiles, nginx, GoTrue templates, both Compose files, env files (devops-engineer) — parallel group B, verified after B lands

- Owned: `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/mobile-web/Dockerfile`,
  `packages/db/Dockerfile`, `docker/nginx/default.conf`, `docker/gotrue/templates/*.html`,
  `docker/backup/*` (restore-test script, even if untested here), `docker-compose.yml`,
  `docker-compose.dev.yml`, `.env.dev`, `.env.example`.
- Build per 2.3–2.6 and 2.13, starting from the PRD's YAML and applying: pinned tags; env from
  `.env.dev` via `x-dev` anchor on `migrate`, `auth`, `storage-init`, `api`, `worker`, `web`;
  healthchecks on every long-running service; `storage-init` completion as a dependency of
  `api`/`worker`; `MINIO_IMAGE`/`MC_IMAGE` interpolation with defaults (R1); dev `web` mounts
  `./docker/gotrue/templates:/repo/apps/mobile-web/public/email-templates:ro`; prod `web` serves
  the same from the image. Production file keeps `cloudflared`, `backup`, `${STORAGE_PATH:?}`,
  `${BACKUP_PATH:?}`, MinIO versioning on. nginx: `resolver 127.0.0.11 valid=10s` with
  variable upstreams so a restarted `api`/`auth` doesn't wedge nginx; `proxy_buffering off` and
  `client_max_body_size 50m` on `/api/`; `/healthz` → 200; `.well-known` AASA served as JSON.
- Security: no real secrets anywhere; `.env.example` placeholders only, with
  `openssl rand -base64 48` guidance for `JWT_SECRET`, `POSTGRES_PASSWORD`, `AUTH_DB_PASSWORD`,
  `S3_SECRET_KEY`.
- Inputs: 1.1 (scripts), 1.2–1.7 for verification. Done-when: `docker compose -f docker-compose.dev.yml
  config -q` and `docker compose -f docker-compose.yml --env-file .env.example config -q` pass;
  from a clean clone `docker compose -f docker-compose.dev.yml up -d --build --wait` exits 0 and
  every long-running service is `healthy`, `migrate` and `storage-init` exited 0; `pnpm dev:reset`
  repeats that from empty volumes.

### 1.9 Tests: unit, migration round-trip, dev-stack smoke (test-engineer) — after 1.2–1.7

- Owned: `**/*.test.ts`, and (assigned by this plan) `**/*.test.tsx`, `e2e/**`.
- `packages/shared/src/health.test.ts`, `packages/shared/src/env.test.ts` (secret mismatch
  refinement rejects), `packages/ai/src/index.test.ts` (factories throw, `isAiConfigured`),
  `apps/api/src/routes/healthz.test.ts` (`buildApp()` + `inject`, db/storage stubs: 200 when both
  ok, 503 and no secret leakage in `error` when storage throws an error whose message contains
  the endpoint URL), `apps/worker/src/heartbeat.test.ts` (does not advance `last_seen_at` when
  storage check fails), `apps/mobile-web/src/App.test.tsx` (renders five tabs; jsdom).
  `packages/db/migrations.integration.test.ts` under project `db-integration`: up → down(all) →
  up against `DATABASE_URL`, skipped when unset.
- `e2e/smoke/dev-stack.sh` (bash + curl + `node -e` for JSON): the acceptance commands in
  section 4, exit non-zero on first failure; used by CI (1.10) and `pnpm smoke`.
- Done-when: `pnpm test` green on the host; `DATABASE_URL=postgres://postgres:dev@localhost:5432/tinyglow
  pnpm test:integration` green against the dev stack; `pnpm smoke` green against the dev stack.

### 1.10 CI (devops-engineer) — after 1.8 and 1.9

- Owned: `.github/workflows/ci.yml`. Jobs: `check` (pnpm via `pnpm/action-setup` reading
  `packageManager`, `actions/setup-node` with `.nvmrc`, `pnpm install --frozen-lockfile`,
  `pnpm lint`, `pnpm typecheck`, `pnpm test`); `images` (matrix over the four Dockerfiles,
  `docker/build-push-action` with `push: false`, GHA cache, target `prod`); `dev-stack-smoke`
  (`docker compose -f docker-compose.dev.yml up -d --build --wait` then `bash e2e/smoke/dev-stack.sh`,
  always dumping `docker compose logs` on failure). Triggers: push to `main`, pull requests.
- Done-when: workflow validates (`actionlint` or a dry parse) and each job's commands pass locally
  in sequence. Note: pushing to a remote to observe a real run requires the user (`CLAUDE.md`
  "Stop and ask"); report the workflow as ready and ask.

### Parallelism summary

| Group | Tasks | Notes |
| --- | --- | --- |
| A (serial) | 1.1 | Everything depends on the lockfile and package skeletons |
| B (parallel) | 1.2 · 1.3→1.4→1.5 · 1.6 · 1.7 · 1.8 | Disjoint paths; 1.3/1.4/1.5 are one owner, so sequential inside that lane. 1.8 can be authored in parallel but its done-when needs the others |
| C (serial) | 1.9 | Needs B's code |
| D (serial) | 1.10 | Needs 1.8 and 1.9 |
| Gate | orchestrator | Section 4 |

mobile-engineer and ai-engineer's worker/API paths have no step-1 work beyond 1.6.

## 4. Acceptance checks

Verbatim, PRD step 1: "Check: `docker compose up` -f docker-compose.dev.yml up starts every
service healthy from a clean clone with no folders or env files to create; the web app loads at
http://localhost:8080; an OTP email arrives in Mailpit; CI builds every image."
Verbatim, `CLAUDE.md`: "Step 1's check means: `docker compose -f docker-compose.dev.yml up` starts
every service healthy." Orchestrator's expansion: one-shot jobs (migrate, storage-init) exit 0;
OTP requested via GoTrue through the `/auth` proxy on :8080 delivers to Mailpit (:8025); CI runs
typecheck + tests.

Run from the repo root (Docker Desktop running). `e2e/smoke/dev-stack.sh` automates 2–5.

1. Clean clone, zero setup:
   ```sh
   rm -rf /private/tmp/ll-clean && git clone -q . /private/tmp/ll-clean && cd /private/tmp/ll-clean
   test ! -e .env && test ! -e .env.local            # nothing to create
   docker compose -f docker-compose.dev.yml up -d --build --wait
   docker compose -f docker-compose.dev.yml ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.ExitCode}}'
   ```
   Expected: `db auth storage mail api worker web` all `running healthy`; `migrate` and
   `storage-init` `exited` with exit code `0`. (The smoke script asserts this with
   `docker compose ps -a --format json`.)
2. Web app loads: `curl -fsS http://localhost:8080/ | grep -q '<div id="root">'`.
3. Proxies match production routing:
   `curl -fsS http://localhost:8080/api/healthz | grep -q '"status":"ok"'` and
   `curl -fsS http://localhost:8080/auth/health`.
4. OTP email arrives in Mailpit with a 6-digit code:
   ```sh
   curl -fsS -X POST http://localhost:8080/auth/otp -H 'content-type: application/json' \
     -d '{"email":"smoke@example.com","create_user":true}'
   for i in $(seq 1 20); do
     ID=$(curl -fsS 'http://localhost:8025/api/v1/search?query=to:smoke@example.com' \
          | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.messages?.[0]?.ID??"")})')
     [ -n "$ID" ] && break; sleep 1
   done
   curl -fsS "http://localhost:8025/api/v1/message/$ID" | grep -Eq '[0-9]{6}'
   ```
5. Worker heartbeat and storage gating:
   `docker compose -f docker-compose.dev.yml exec db psql -U postgres -d tinyglow -c "select worker_id, storage_ok, now()-last_seen_at < interval '30 seconds' as fresh from worker_heartbeats"`
   shows `t | t`. Then `docker compose -f docker-compose.dev.yml stop storage`; within 60 s
   `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/healthz` is `503` and
   `docker compose -f docker-compose.dev.yml ps worker` shows `unhealthy`; `start storage` restores both.
6. Reset works: `pnpm dev:reset` (detached variant: `down -v` then `up -d --build --wait`) and
   check 1 passes again.
7. CI builds every image and runs typecheck + tests (local equivalents, since pushing needs the user):
   ```sh
   pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test
   for f in apps/api apps/worker apps/mobile-web; do docker build --target prod -f $f/Dockerfile . ; done
   docker build -f packages/db/Dockerfile .
   DATABASE_URL=postgres://postgres:dev@localhost:5432/tinyglow pnpm test:integration
   pnpm smoke
   ```
   Then ask the user to push so `.github/workflows/ci.yml` runs for real.
8. Hygiene: `git status --porcelain | grep -E '^\?\? \.env(\.local)?$'` prints nothing;
   `grep -rn 'sk-\|BEGIN PRIVATE' .env.dev .env.example` prints nothing.

## 5. Risks and decisions (orchestrator to confirm or override)

- **R1 — MinIO images are gone from Docker Hub (needs the user).** `minio/minio` and `minio/mc`
  return 404 on Docker Hub; MinIO Community Edition went source-only (2025-10-15) and the GitHub
  repo was archived in 2026. The PRD's `image: minio/minio` cannot be pulled. Proposed default:
  keep MinIO (PRD architecture, S3 pre-signed URLs, versioning) and pull the community-rebuilt
  images `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` and `pgsty/mc:RELEASE.2026-09-16T00-00-00Z`
  (Pigsty project; verified present on Docker Hub today), exposed as `${MINIO_IMAGE}` /
  `${MC_IMAGE}` with those defaults so switching is config. Alternatives: (a) the frozen official
  build `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` (MinIO Inc.-built but predates the last
  CVE fix, and reports of quay 401s are mixed; devops should `docker manifest inspect` before
  relying on it); (b) move to a maintained S3-compatible store (Garage, SeaweedFS, RustFS) — a
  bigger PRD deviation affecting versioning and `mc`-based init. This is a supply-chain trust
  choice for a store holding children's photos: **stop and ask the user** before step 1 is gated.
- **R2 — Migration tool.** node-pg-migrate with SQL files (section 2.7). Bootstrap of GoTrue roles
  is a separate idempotent script, not a migration.
- **R3 — Lint/format.** Biome instead of ESLint+Prettier (one config, fast, fewer parallel-edit
  conflicts). Switch later is cheap.
- **R4 — pnpm 12.10.1 + Node 22.23.3.** pnpm installed via `npm i -g` in images (no corepack
  dependency); host users need `corepack enable` or `npm i -g pnpm@12.10.1` (README). If pnpm 12
  changes `pnpm deploy` semantics, devops may use `pnpm install --prod --filter` in the prod stage
  instead; the contract is only the runtime layout in 2.13.
- **R5 — Custom GoTrue email templates served by `web`.** GoTrue's defaults contain no 6-digit
  code, and templates can only be fetched over HTTP, so both the confirmation and magic-link
  templates live in `docker/gotrue/templates` and are served by Vite (dev) / nginx (prod). Side
  effect: templates are public at `/email-templates/*` (harmless, no secrets). Requires Vite
  `allowedHosts` to include `web`.
- **R6 — JWT secret duplicated in `.env.dev`.** Compose cannot interpolate `${JWT_SECRET}` without
  a project `.env`, which zero-setup dev forbids, so `.env.dev` carries both `JWT_SECRET` and
  `GOTRUE_JWT_SECRET` with an api/worker boot assertion that they match. Production uses the PRD's
  `${JWT_SECRET}` interpolation from `.env`.
- **R7 — Pre-creating `anon`/`authenticated`/`service_role`.** Cheap, idempotent, and matches
  GoTrue's JWT `role` claims; step 2 builds RLS on `authenticated` plus a viewer role. In step 1
  api/worker still connect as `postgres`; step 2 must introduce the app role and a
  `worker_heartbeats` policy for it.
- **R8 — Workspace packages export TS source; tsup bundles api/worker for prod.** Avoids `dist`
  rebuild races with the dev bind mounts. Native deps (sharp, step 4) must stay external.
- **R9 — Ownership gaps closed by this plan.** Root monorepo files and the initial package
  skeletons → devops-engineer (1.1); `apps/mobile-web/{vite.config.ts,index.html,public,tsconfig,package.json}`
  → frontend-engineer; `*.test.tsx` → test-engineer; `packages/shared` written by backend-engineer
  to the architect-defined shapes. Dependency additions need orchestrator approval + a serial
  lockfile regen.
- **R10 — Extra CI job `dev-stack-smoke`.** Not in the PRD's "CI builds every image" wording, but it
  is the only automated proof of the step-1 check. Adds ~5–8 min per run; drop if too slow.
- **R11 — Production compose is unverifiable here.** Validated only with `config` against
  `.env.example`; `cloudflared` and `backup` need the server and a tunnel token (user).
- **R12 — Deferred from "Compose requirements".** Worker 80%-disk alert (step 4), GoTrue production
  rate limits and Turnstile (step 3), off-site restic copy (devops writes the script in a later
  step; restore test needs the server), Capacitor projects (step 9), `VITE_API_URL` for phones
  (steps 3/4; the app calls relative URLs so only `S3_PUBLIC_ENDPOINT` matters later).
- **R13 — macOS bind-mount file watching.** `tsx watch`/Vite usually get events through Docker
  Desktop; `VITE_USE_POLLING=1` / `CHOKIDAR_USEPOLLING=1` in `.env.local` is the documented fallback.
- **R14 — nginx runs the official image (root master process, `nginx` workers).** The PRD's
  non-root requirement is for the node production targets; switching to `nginx-unprivileged` on
  :8080 would change the PRD's `http://web:80` tunnel route. Keep :80 for now.
