/**
 * GoTrue / role bootstrap. Mirrors `supabase/auth` `hack/init_postgres.sql` (docs/plans/step-1.md
 * 2.6) and PRD "Compose requirements → Migrations": the migrate job creates the
 * `supabase_auth_admin` role and the `auth` schema before GoTrue runs its own migrations.
 *
 * This is a script, not a migration: it needs `AUTH_DB_PASSWORD` from the environment, it must
 * converge (re-apply the password and role attributes on every run) and it is by nature not
 * reversible. It is idempotent: a second run changes nothing observable.
 *
 * Security notes
 * - The password is never interpolated into SQL text. It is passed as a bind parameter to
 *   `set_config()` and read back inside a `DO` block, so it never appears in a top-level
 *   statement (and therefore never in Postgres statement logs) and Postgres stores only the
 *   SCRAM-SHA-256 hash.
 * - This module never prints the password or the connection string; errors go through
 *   `describeError` which masks both.
 */

import { fileURLToPath } from "node:url";
import pg from "pg";
import { requireAuthDbPassword, requireDatabaseUrl } from "./env.js";
import { describeError } from "./redact.js";

const { Client } = pg;

export const AUTH_ADMIN_ROLE = "supabase_auth_admin";
export const AUTH_SCHEMA = "auth";
/** NOLOGIN roles matching GoTrue's JWT `role` claims; step 2 builds RLS grants on them. */
export const JWT_ROLES = ["anon", "authenticated", "service_role"] as const;

export interface BootstrapOptions {
  databaseUrl: string;
  authDbPassword: string;
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
  auth_password text := current_setting('littlelight.auth_db_password', true);
  jwt_role text;
BEGIN
  IF auth_password IS NULL OR auth_password = '' THEN
    RAISE EXCEPTION 'littlelight.auth_db_password is not set for this transaction';
  END IF;

  -- supabase_auth_admin: GoTrue's database user. NOINHERIT so membership never leaks privileges;
  -- CREATEROLE is what supabase/auth's own init script grants; NOREPLICATION, no BYPASSRLS,
  -- no SUPERUSER.
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

  -- JWT claim roles. NOLOGIN: nothing ever connects as these; the API (step 3) sets
  -- request.jwt.claims and SET ROLE per transaction so RLS policies can key on them.
  FOREACH jwt_role IN ARRAY ARRAY[${JWT_ROLES.map((r) => `'${r}'`).join(", ")}] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = jwt_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER', jwt_role);
    ELSE
      EXECUTE format('ALTER ROLE %I NOLOGIN NOBYPASSRLS NOSUPERUSER', jwt_role);
    END IF;
  END LOOP;
END
$bootstrap$;
`;

export async function bootstrap(options: BootstrapOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const secrets = [options.authDbPassword];
  const client = new Client({
    connectionString: options.databaseUrl,
    application_name: "littlelight-bootstrap",
  });

  try {
    await client.connect();
    await client.query("BEGIN");
    // Bind parameter, transaction-local (is_local = true): visible only inside this transaction.
    await client.query("SELECT set_config('littlelight.auth_db_password', $1, true)", [
      options.authDbPassword,
    ]);
    await client.query(BOOTSTRAP_SQL);
    await client.query("COMMIT");
    log(
      `bootstrap: role ${AUTH_ADMIN_ROLE}, schema ${AUTH_SCHEMA}, roles ${JWT_ROLES.join("/")} are in place`,
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
export async function bootstrapFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await bootstrap({
    databaseUrl: requireDatabaseUrl(env),
    authDbPassword: requireAuthDbPassword(env),
  });
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  bootstrapFromEnv().catch((err: unknown) => {
    console.error(describeError(err, [process.env.AUTH_DB_PASSWORD ?? ""]));
    process.exit(1);
  });
}
