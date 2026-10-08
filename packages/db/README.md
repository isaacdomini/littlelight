# @littlelight/db

Database bootstrap, migrations and seed for Littlelight. Owned by `security-engineer`
(`CLAUDE.md` file ownership). Runs as the one-shot `migrate` Compose service before `auth`, `api`
and `worker` start.

## What runs, in order

1. **Bootstrap** (`src/bootstrap.ts`, idempotent script, not a migration): creates/converges the
   GoTrue database user `supabase_auth_admin` (NOINHERIT CREATEROLE LOGIN NOREPLICATION, password
   from `AUTH_DB_PASSWORD`), the `auth` schema owned by it, `GRANT CREATE ON DATABASE`, its
   `search_path = auth`, and the NOLOGIN JWT-claim roles `anon`, `authenticated`, `service_role`.
   Mirrors `supabase/auth` `hack/init_postgres.sql`. GoTrue then runs its own migrations inside
   `auth.*` on container start.
2. **Migrations** (`migrations/*.sql`, node-pg-migrate, tracked in `public.pgmigrations`):
   plain SQL with `-- Up Migration` / `-- Down Migration` markers. Every migration must have a
   working down (PRD: "Each migration is reversible"), and every RLS policy change needs a test.
3. **Seed** (`src/seed.ts`): idempotent. Step 1 is a no-op; step 2 adds the demo family.

pg-boss creates and owns the `pgboss` schema itself on the worker's first `boss.start()`. It is
deliberately outside these migrations; do not add it here.

## Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | all scripts | Superuser in step 1 (`postgres://postgres:dev@db:5432/littlelight` in dev). Step 2 introduces an app role. |
| `AUTH_DB_PASSWORD` | bootstrap (`migrate up`) | Password for `supabase_auth_admin`; must equal the password in `GOTRUE_DB_DATABASE_URL`. With `NODE_ENV=production` it must be at least 16 characters (`openssl rand -base64 48`). |

Scripts never print `DATABASE_URL` or `AUTH_DB_PASSWORD`; error output goes through
`src/redact.ts`, which masks URL passwords and the literal secret. The password reaches Postgres
only as a bind parameter (`set_config` → `DO` block), so it never appears in a top-level statement
or statement log, and Postgres stores only the SCRAM-SHA-256 hash.

## Commands

From the repo root (`pnpm db:*` forwards to this package) or from `packages/db`:

| Command | Effect |
| --- | --- |
| `pnpm db:bootstrap` | Bootstrap only |
| `pnpm db:migrate` | Bootstrap, then apply all pending migrations (`up`) |
| `pnpm db:migrate:down [n\|all]` | Revert the last `n` migrations (default 1); `all` reverts everything |
| `pnpm db:seed` | Seed (idempotent) |
| `pnpm --filter @littlelight/db db:migrate:create <name>` | New empty `migrations/<ms-timestamp>_<name>.sql` (the tool turns `_` in `<name>` into `-`) |

All of these are safe to run repeatedly: a second `db:migrate` is a no-op.

Programmatic use (integration tests): `import { runMigrations, bootstrap, seed } from "@littlelight/db"`.
`runMigrations({ direction: "down", count: Number.POSITIVE_INFINITY, bootstrap: false })` reverts
everything; `runMigrations({ direction: "up" })` bootstraps then applies (set `bootstrap: false`
to skip the role step when `AUTH_DB_PASSWORD` is not available).

## Writing a migration

- Keep the two markers; put DDL for the forward change under `-- Up Migration` and the exact
  inverse under `-- Down Migration`. Use `IF NOT EXISTS` / `IF EXISTS` so partial re-runs converge.
- Every table that holds baby-scoped data (step 2 onward) must `ENABLE ROW LEVEL SECURITY` in
  the same migration that creates it, with policies built on the `is_baby_member` /
  `is_baby_admin` helpers, and a negative-case test (non-member cannot read) in
  `packages/db/**/*.integration.test.ts`.
- Migrations run in one transaction (`singleTransaction`), so a failing statement rolls the whole
  batch back. Avoid statements that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`,
  `ALTER TYPE ... ADD VALUE` on PG < 12 semantics); split those into their own migration if ever needed.

## Local verification against a throwaway Postgres

```sh
docker run --rm -d --name ll-db-test -p 55432:5432 -e POSTGRES_PASSWORD=dev pgvector/pgvector:0.8.7-pg17
export DATABASE_URL=postgres://postgres:dev@localhost:55432/postgres AUTH_DB_PASSWORD=dev
pnpm db:migrate && pnpm db:migrate   # second run: "nothing to do"
pnpm db:seed
pnpm db:migrate:down all && pnpm db:migrate
docker stop ll-db-test
```

## Step-1 schema

| Migration | Up | Down |
| --- | --- | --- |
| `1791435700055_extensions.sql` | `vector`, `pgcrypto` extensions | drop both |
| `1791435701234_worker-heartbeats.sql` | `public.worker_heartbeats` with RLS enabled (no policies: only the owner/superuser can touch it until step 2 adds the app-role policy) | drop table |
