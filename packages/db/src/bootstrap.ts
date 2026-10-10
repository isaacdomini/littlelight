/**
 * Cluster-level bootstrap: Postgres roles, the GoTrue `auth` schema and the pg-boss schema
 * (docs/plans/step-2.md 2.2 and 2.10; step-1 2.6 for the GoTrue part). Runs as the superuser from
 * the `db-init` one-shot before GoTrue starts, and again (idempotently) at the start of
 * `pnpm db:migrate`.
 *
 * This is a script, not a migration: it needs role passwords from the environment, it must
 * converge (re-apply passwords and attributes on every run) and it is by nature not reversible.
 * It is idempotent: a second run changes nothing observable.
 *
 * Role model (least privilege; see README "Roles"):
 * - `supabase_auth_admin`  LOGIN, GoTrue only. Owns `auth.*`.
 * - `tinyglow_api`      LOGIN NOINHERIT. No privileges of its own on app tables; every unit of
 *                          work does `SET LOCAL ROLE authenticated|viewer|service_role`.
 * - `tinyglow_worker`   LOGIN NOINHERIT. Owns `pgboss`; `SET LOCAL ROLE pipeline` for app tables.
 * - `authenticated`, `viewer`, `pipeline`, `service_role`, `anon`: NOLOGIN. Policies are written
 *                          `TO <role>`. Only `service_role` has BYPASSRLS and it is reachable only
 *                          from `tinyglow_api` (never the worker, which handles untrusted
 *                          image bytes and model output).
 *
 * Security notes
 * - Passwords are never interpolated into SQL text. They are passed as bind parameters to
 *   `set_config()` and read back inside a `DO` block, so they never appear in a top-level
 *   statement (and therefore never in Postgres statement logs); Postgres stores only the
 *   SCRAM-SHA-256 hash.
 * - This module never prints a password or the connection string; errors go through
 *   `describeError`, which masks both.
 * - No LOGIN role ever gets BYPASSRLS or SUPERUSER.
 */

import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  knownSecrets,
  requireApiDbPassword,
  requireAuthDbPassword,
  requireDatabaseUrl,
  requireWorkerDbPassword,
} from "./env.js";
import { describeError } from "./redact.js";

const { Client } = pg;

export const AUTH_ADMIN_ROLE = "supabase_auth_admin";
export const AUTH_SCHEMA = "auth";
/** Schema pg-boss creates its tables in; owned by the worker login role. */
export const PGBOSS_SCHEMA = "pgboss";
/** NOLOGIN roles matching GoTrue's JWT `role` claims. */
export const JWT_ROLES = ["anon", "authenticated", "service_role"] as const;

/** Every role the application layer knows by name (docs/plans/step-2.md 2.2). */
export const APP_ROLES = {
  /** API connection role (LOGIN NOINHERIT). */
  api: "tinyglow_api",
  /** Worker connection role (LOGIN NOINHERIT); owns the pg-boss schema. */
  worker: "tinyglow_worker",
  /** Signed-in user; policies read `request.jwt.claims`. */
  authenticated: "authenticated",
  /** Share-link viewer; may read only the viewer allow-list for one `share_link_id` claim. */
  viewer: "viewer",
  /** Worker job role: cross-baby but only the photo-pipeline tables/columns. */
  pipeline: "pipeline",
  /** API-internal role with no user context; BYPASSRLS. Never the worker. */
  service: "service_role",
} as const;

export type AppRole = (typeof APP_ROLES)[keyof typeof APP_ROLES];

export interface BootstrapOptions {
  databaseUrl: string;
  authDbPassword: string;
  apiDbPassword: string;
  workerDbPassword: string;
  /** Defaults to console.log; receives already-redacted lines only. */
  log?: (line: string) => void;
}

/**
 * Everything runs in one transaction so a half-applied bootstrap cannot be observed. All DDL is
 * guarded by existence checks or `IF NOT EXISTS`, and the `ALTER ROLE` statements re-assert the
 * desired state so attribute or password drift is corrected on the next run.
 */
const BOOTSTRAP_SQL = `
DO $bootstrap$
DECLARE
  auth_password   text := current_setting('tinyglow.auth_db_password', true);
  api_password    text := current_setting('tinyglow.api_db_password', true);
  worker_password text := current_setting('tinyglow.worker_db_password', true);
  policy_role text;
  r record;
BEGIN
  IF coalesce(auth_password, '') = '' THEN
    RAISE EXCEPTION 'tinyglow.auth_db_password is not set for this transaction';
  END IF;
  IF coalesce(api_password, '') = '' THEN
    RAISE EXCEPTION 'tinyglow.api_db_password is not set for this transaction';
  END IF;
  IF coalesce(worker_password, '') = '' THEN
    RAISE EXCEPTION 'tinyglow.worker_db_password is not set for this transaction';
  END IF;

  ---------------------------------------------------------------------------------------------
  -- GoTrue: supabase_auth_admin + auth schema (mirrors supabase/auth hack/init_postgres.sql).
  -- NOINHERIT so membership never leaks privileges; CREATEROLE is what supabase/auth's own init
  -- script grants; NOREPLICATION, no BYPASSRLS, no SUPERUSER.
  ---------------------------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${AUTH_ADMIN_ROLE}') THEN
    EXECUTE format(
      'CREATE ROLE %I NOINHERIT CREATEROLE LOGIN NOREPLICATION NOBYPASSRLS NOSUPERUSER PASSWORD %L',
      '${AUTH_ADMIN_ROLE}', auth_password
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE %I NOINHERIT CREATEROLE LOGIN NOREPLICATION NOBYPASSRLS NOSUPERUSER PASSWORD %L',
      '${AUTH_ADMIN_ROLE}', auth_password
    );
  END IF;

  -- The auth schema is owned by the GoTrue role so its migrations can create objects in it.
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', '${AUTH_SCHEMA}', '${AUTH_ADMIN_ROLE}');
  EXECUTE format('ALTER SCHEMA %I OWNER TO %I', '${AUTH_SCHEMA}', '${AUTH_ADMIN_ROLE}');

  -- GoTrue issues CREATE SCHEMA IF NOT EXISTS on start, which needs CREATE on the database.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), '${AUTH_ADMIN_ROLE}');

  -- GoTrue's migrations assume unqualified names resolve inside the auth schema.
  EXECUTE format('ALTER ROLE %I SET search_path = %L', '${AUTH_ADMIN_ROLE}', '${AUTH_SCHEMA}');

  ---------------------------------------------------------------------------------------------
  -- NOLOGIN policy roles. Nothing ever connects as these; the API/worker SET LOCAL ROLE per
  -- transaction so RLS policies written TO <role> apply. anon/authenticated/service_role are
  -- also GoTrue's JWT role claims.
  ---------------------------------------------------------------------------------------------
  FOREACH policy_role IN ARRAY ARRAY['anon', 'authenticated', 'viewer', 'pipeline'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = policy_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION', policy_role);
    ELSE
      EXECUTE format('ALTER ROLE %I NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION', policy_role);
    END IF;
  END LOOP;

  -- service_role: Supabase semantics (bypasses RLS). NOLOGIN; only tinyglow_api may SET ROLE
  -- to it, and only in the few named API code paths that have no user context.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION';
  ELSE
    EXECUTE 'ALTER ROLE service_role NOLOGIN NOINHERIT BYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION';
  END IF;

  ---------------------------------------------------------------------------------------------
  -- LOGIN connection roles. NOINHERIT: a query that did not SET LOCAL ROLE has no privileges on
  -- app tables and fails with "permission denied" rather than returning data.
  ---------------------------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${APP_ROLES.api}') THEN
    EXECUTE format(
      'CREATE ROLE %I LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD %L',
      '${APP_ROLES.api}', api_password
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE %I LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD %L',
      '${APP_ROLES.api}', api_password
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${APP_ROLES.worker}') THEN
    EXECUTE format(
      'CREATE ROLE %I LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD %L',
      '${APP_ROLES.worker}', worker_password
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE %I LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD %L',
      '${APP_ROLES.worker}', worker_password
    );
  END IF;

  -- Memberships: SET TRUE / INHERIT FALSE = may SET ROLE to it, gains nothing without SET ROLE.
  -- The api may become authenticated, viewer or service_role; the worker only pipeline.
  EXECUTE format('GRANT authenticated, viewer, service_role TO %I WITH INHERIT FALSE, SET TRUE', '${APP_ROLES.api}');
  EXECUTE format('GRANT pipeline TO %I WITH INHERIT FALSE, SET TRUE', '${APP_ROLES.worker}');
  -- Converge: the worker must never be able to reach service_role/authenticated/viewer, and the
  -- api must never reach pipeline (revoke if some earlier state granted them).
  FOR r IN
    SELECT m.roleid::regrole AS granted, m.member::regrole AS grantee
    FROM pg_catalog.pg_auth_members m
    WHERE (m.member = '${APP_ROLES.worker}'::regrole AND m.roleid <> 'pipeline'::regrole)
       OR (m.member = '${APP_ROLES.api}'::regrole AND m.roleid NOT IN ('authenticated'::regrole, 'viewer'::regrole, 'service_role'::regrole))
  LOOP
    EXECUTE format('REVOKE %s FROM %s', r.granted, r.grantee);
  END LOOP;

  ---------------------------------------------------------------------------------------------
  -- pg-boss schema, owned by the worker. Postgres checks CREATE ON DATABASE even for
  -- CREATE SCHEMA IF NOT EXISTS (which pg-boss runs on start), so grant it. Existing dev volumes
  -- from step 1 have the schema and its objects owned by postgres: transfer ownership.
  ---------------------------------------------------------------------------------------------
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), '${APP_ROLES.worker}');
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', '${PGBOSS_SCHEMA}', '${APP_ROLES.worker}');
  EXECUTE format('ALTER SCHEMA %I OWNER TO %I', '${PGBOSS_SCHEMA}', '${APP_ROLES.worker}');
  FOR r IN
    SELECT c.oid::regclass AS name,
           CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS kind
    FROM pg_catalog.pg_class c
    WHERE c.relnamespace = '${PGBOSS_SCHEMA}'::regnamespace
      AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      AND c.relowner <> '${APP_ROLES.worker}'::regrole
      -- Sequences owned by a column (serial/identity) follow their table and cannot be altered
      -- alone. Only sequences get this filter: partition children carry the same 'a' dependency
      -- on their parent and must be transferred explicitly (pg-boss partitions job/queue_stats).
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
          AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype = 'a'
      ))
    ORDER BY (c.relkind = 'S')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', r.kind, r.name, '${APP_ROLES.worker}');
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS name, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = '${PGBOSS_SCHEMA}'::regnamespace
      AND p.proowner <> '${APP_ROLES.worker}'::regrole
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', r.kind, r.name, '${APP_ROLES.worker}');
  END LOOP;
  FOR r IN
    SELECT t.oid::regtype AS name
    FROM pg_catalog.pg_type t
    WHERE t.typnamespace = '${PGBOSS_SCHEMA}'::regnamespace
      AND t.typtype IN ('e', 'd', 'r')
      AND t.typowner <> '${APP_ROLES.worker}'::regrole
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO %I', r.name, '${APP_ROLES.worker}');
  END LOOP;

  -- The API enqueues jobs (step 4) through pg-boss tables it does not own: DML + sequences +
  -- functions, now and for objects pg-boss creates later.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', '${PGBOSS_SCHEMA}', '${APP_ROLES.api}');
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', '${PGBOSS_SCHEMA}', '${APP_ROLES.api}');
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', '${PGBOSS_SCHEMA}', '${APP_ROLES.api}');
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', '${PGBOSS_SCHEMA}', '${APP_ROLES.api}');
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', '${APP_ROLES.worker}', '${PGBOSS_SCHEMA}', '${APP_ROLES.api}');
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', '${APP_ROLES.worker}', '${PGBOSS_SCHEMA}', '${APP_ROLES.api}');
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I', '${APP_ROLES.worker}', '${PGBOSS_SCHEMA}', '${APP_ROLES.api}');
EXCEPTION WHEN OTHERS THEN
  -- A failing EXECUTE would otherwise carry its statement text (CREATE/ALTER ROLE ... PASSWORD
  -- '...') in the error CONTEXT, which Postgres writes to the server log. Re-raise message and
  -- SQLSTATE only, with the passwords masked, from this handler: the original context is dropped.
  RAISE EXCEPTION USING
    MESSAGE = replace(replace(replace(SQLERRM,
                coalesce(auth_password, ''), '[redacted]'),
                coalesce(api_password, ''), '[redacted]'),
                coalesce(worker_password, ''), '[redacted]'),
    ERRCODE = SQLSTATE;
END
$bootstrap$;
`;

export async function bootstrap(options: BootstrapOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const secrets = [options.authDbPassword, options.apiDbPassword, options.workerDbPassword];
  const client = new Client({
    connectionString: options.databaseUrl,
    application_name: "tinyglow-bootstrap",
  });

  try {
    await client.connect();
    await client.query("BEGIN");
    // Bind parameters, transaction-local (is_local = true): visible only inside this transaction.
    await client.query("SELECT set_config('tinyglow.auth_db_password', $1, true)", [
      options.authDbPassword,
    ]);
    await client.query("SELECT set_config('tinyglow.api_db_password', $1, true)", [
      options.apiDbPassword,
    ]);
    await client.query("SELECT set_config('tinyglow.worker_db_password', $1, true)", [
      options.workerDbPassword,
    ]);
    await client.query(BOOTSTRAP_SQL);
    await client.query("COMMIT");
    log(
      `bootstrap: roles ${AUTH_ADMIN_ROLE}, ${Object.values(APP_ROLES).join(", ")}, anon; schemas ${AUTH_SCHEMA}, ${PGBOSS_SCHEMA} are in place`,
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be gone; the original error is what matters
    }
    throw new Error(`bootstrap failed: ${describeError(err, secrets)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** CLI entry: `tsx src/bootstrap.ts` (also invoked by `migrate.ts up`). */
export async function bootstrapFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log?: (line: string) => void,
): Promise<void> {
  await bootstrap({
    databaseUrl: requireDatabaseUrl(env),
    authDbPassword: requireAuthDbPassword(env),
    apiDbPassword: requireApiDbPassword(env),
    workerDbPassword: requireWorkerDbPassword(env),
    log,
  });
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  bootstrapFromEnv().catch((err: unknown) => {
    console.error(describeError(err, knownSecrets()));
    process.exit(1);
  });
}
