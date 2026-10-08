/**
 * Shared harness for the db integration tests (docs/plans/step-2.md 2.8). Test-only; not part of
 * the package surface.
 *
 * - `admin`: a `postgres` superuser client used for fixtures and for asserting persisted state.
 * - `api(role, claims)` / `pipeline(fn)`: run `fn` inside one transaction on a `littlelight_api` /
 *   `littlelight_worker` connection, with `SET LOCAL ROLE` + `set_config('request.jwt.claims', $1,
 *   true)` exactly as the README documents, and ALWAYS roll back.
 */

import pg from "pg";
import { appRoleUrl, ensureAuthSchemaStub, runMigrations } from "../src/index";

export const env = {
  ...process.env,
  AUTH_DB_PASSWORD: process.env.AUTH_DB_PASSWORD ?? "dev",
  API_DB_PASSWORD: process.env.API_DB_PASSWORD ?? "dev",
  WORKER_DB_PASSWORD: process.env.WORKER_DB_PASSWORD ?? "dev",
  DATA_ENCRYPTION_KEY:
    process.env.DATA_ENCRYPTION_KEY ?? "dev-only-data-encryption-key-32-chars-min",
};
export const databaseUrl = process.env.DATABASE_URL;
export const DATA_KEY = env.DATA_ENCRYPTION_KEY;

const quiet = () => undefined;

/** Idempotent: stub auth.users if GoTrue has not run, then bootstrap + apply pending migrations. */
export async function ensureMigrated(): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await ensureAuthSchemaStub(c);
  } finally {
    await c.end();
  }
  await runMigrations({ direction: "up", databaseUrl, env, log: quiet });
}

export type Claims = Record<string, unknown>;
export const authed = (sub: string, email?: string): Claims => ({
  sub,
  role: "authenticated",
  aud: "authenticated",
  ...(email ? { email } : {}),
});
export const viewerClaims = (shareLinkId: string): Claims => ({
  role: "viewer",
  share_link_id: shareLinkId,
});

export interface Db {
  /** Superuser client (fixtures, assertions). */
  admin: pg.Client;
  apiPool: pg.Pool;
  workerPool: pg.Pool;
  /** As `role` (authenticated/viewer/service_role) with `claims`; rolled back afterwards. */
  asRole<T>(role: string, claims: Claims | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  asUser<T>(sub: string, fn: (c: pg.PoolClient) => Promise<T>, email?: string): Promise<T>;
  asViewer<T>(shareLinkId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  asPipeline<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function connect(): Promise<Db> {
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  const apiPool = new pg.Pool({
    connectionString: appRoleUrl(databaseUrl, "littlelight_api", env.API_DB_PASSWORD),
    max: 2,
  });
  const workerPool = new pg.Pool({
    connectionString: appRoleUrl(databaseUrl, "littlelight_worker", env.WORKER_DB_PASSWORD),
    max: 2,
  });

  async function inTx<T>(
    pool: pg.Pool,
    role: string,
    claims: Claims | null,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${role}`);
      if (claims)
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(claims),
        ]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  return {
    admin,
    apiPool,
    workerPool,
    asRole: (role, claims, fn) => inTx(apiPool, role, claims, fn),
    asUser: (sub, fn, email) => inTx(apiPool, "authenticated", authed(sub, email), fn),
    asViewer: (id, fn) => inTx(apiPool, "viewer", id ? viewerClaims(id) : null, fn),
    asPipeline: (fn) => inTx(workerPool, "pipeline", null, fn),
    close: async () => {
      await admin.end();
      await apiPool.end();
      await workerPool.end();
    },
  };
}

/** Run `sql` and return the error (SQLSTATE + message) or null. Uses a savepoint so the tx lives on. */
export async function tryQuery(
  c: pg.ClientBase,
  sql: string,
  params: unknown[] = [],
): Promise<{ code?: string; message: string } | null> {
  try {
    await c.query("SAVEPOINT t");
  } catch (e) {
    if ((e as { code?: string }).code !== "25P01") throw e;
    // Not inside a transaction: run the statement in a throwaway one.
    await c.query("BEGIN");
    try {
      await c.query(sql, params);
      return null;
    } catch (inner) {
      const err = inner as { code?: string; message: string };
      return { code: err.code, message: err.message };
    } finally {
      await c.query("ROLLBACK");
    }
  }
  try {
    await c.query(sql, params);
    await c.query("RELEASE SAVEPOINT t");
    return null;
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT t");
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
}

export const RLS_VIOLATION = /new row violates row-level security policy/i;
export const PERMISSION_DENIED = /permission denied/i;

/** UUID helper for fixtures: fixed, readable ids in a private range. */
export const fid = (prefix: string, n: number) =>
  `f${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
