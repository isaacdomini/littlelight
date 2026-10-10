import type { FastifyInstance } from "fastify";
import pg from "pg";
import type { ApiConfig } from "../config";

// Pooled Postgres access (docs/plans/step-3.md 2.7; packages/db/README.md "Per-transaction
// identity"). DATABASE_URL is `tinyglow_api`, which has no table privileges of its own: every
// request-scoped unit of work goes through `runAs`, which switches role and claims for exactly
// one transaction and returns the connection to the pool as `tinyglow_api` again.

/** The slice of `pg.Pool` the API uses. Tests may pass a stub without `connect` (see `asDbPool`). */
export interface DbClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  connect?: () => Promise<pg.PoolClient>;
}

/** `app.db`: always able to hand out a client for `runAs`. */
export interface DbPool extends DbClient {
  connect(): Promise<pg.PoolClient>;
}

declare module "fastify" {
  interface FastifyInstance {
    db: DbPool;
  }
}

/**
 * Create the shared pg pool. Short connection timeout so `/healthz` reports a down database
 * quickly instead of hanging. The connection string is never logged.
 *
 * Do not use named prepared statements (`{ name: … }` queries) on this pool: `DISCARD ALL` on
 * every release (see `runAs`) deallocates them server-side while `pg` still thinks they exist.
 */
export function createPool(config: Pick<ApiConfig, "DATABASE_URL">, log: FastifyInstance["log"]) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    application_name: "tinyglow-api",
  });
  // An idle client error (e.g. the db restarting) must not crash the process.
  pool.on("error", (err) => {
    log.warn({ code: (err as { code?: unknown }).code }, "pg pool idle client error");
  });
  return pool;
}

/**
 * Database roles a unit of work may run as. Role names reach SQL text only through this frozen
 * map (an identifier cannot be a bind parameter), never from input.
 */
export type DbRole = "authenticated" | "viewer" | "service_role";

const SET_LOCAL_ROLE: Readonly<Record<DbRole, string>> = Object.freeze({
  authenticated: "SET LOCAL ROLE authenticated",
  viewer: "SET LOCAL ROLE viewer",
  service_role: "SET LOCAL ROLE service_role",
});

export interface TxOptions {
  /**
   * JSON string bound to `set_config('request.jwt.claims', $1, true)`; build it with
   * `claimsToSql()` from `@tinyglow/shared`. Never logged, never interpolated.
   */
  claimsJson?: string | null;
  /**
   * `DATA_ENCRYPTION_KEY`, bound to `set_config('app.data_key', $1, true)` for pgcrypto
   * (`service_role` only, step 5). Never logged, never interpolated.
   */
  dataKey?: string | null;
}

/** Thrown when `COMMIT` reports `ROLLBACK`: `fn` swallowed a statement error inside the transaction. */
export class TransactionAbortedError extends Error {
  constructor() {
    super("transaction was aborted by an earlier error and has been rolled back");
    this.name = "TransactionAbortedError";
  }
}

/**
 * Run `fn` on one pooled client inside one transaction as `role`:
 *
 *   BEGIN; SET LOCAL ROLE <role>;
 *   SELECT set_config('request.jwt.claims', $1, true);   -- if claimsJson
 *   SELECT set_config('app.data_key', $1, true);          -- if dataKey
 *   <fn>; COMMIT            (ROLLBACK and rethrow if fn throws)
 *
 * then, outside any transaction, `RESET ROLE; DISCARD ALL` before the client goes back to the
 * pool. If that cleanup fails the client is destroyed (`release(err)`), never reused, so a role or
 * claims can never leak to the next request on the same connection. Never uses session-level
 * `SET ROLE`. `fn` must not issue `BEGIN`/`COMMIT`/`ROLLBACK` itself.
 */
export async function runAs<T>(
  pool: Pick<pg.Pool, "connect">,
  role: DbRole,
  opts: TxOptions,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const setRole = Object.hasOwn(SET_LOCAL_ROLE, role) ? SET_LOCAL_ROLE[role] : undefined;
  if (!setRole) throw new Error("runAs: unknown database role");

  const client = await pool.connect();
  // pg-pool only listens for errors on idle clients. A checked-out client whose backend dies
  // (db restart, admin termination) emits 'error'; without a listener that crashes the process.
  let broken: Error | undefined;
  const onError = (err: Error) => {
    broken = err;
  };
  client.on("error", onError);
  let result: T;
  try {
    await client.query("BEGIN");
    try {
      await client.query(setRole);
      if (opts.claimsJson) {
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [opts.claimsJson]);
      }
      if (opts.dataKey) {
        await client.query("SELECT set_config('app.data_key', $1, true)", [opts.dataKey]);
      }
      result = await fn(client);
      const commit = await client.query("COMMIT");
      // Postgres answers COMMIT of an aborted transaction with ROLLBACK, not an error.
      if (commit.command === "ROLLBACK") throw new TransactionAbortedError();
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Connection is likely broken; the cleanup below fails too and destroys the client.
      }
      throw err;
    }
  } finally {
    await resetAndRelease(client, () => broken);
    client.off("error", onError);
  }
  return result;
}

async function resetAndRelease(
  client: pg.PoolClient,
  brokenBy: () => Error | undefined,
): Promise<void> {
  const early = brokenBy();
  if (early) {
    client.release(early);
    return;
  }
  try {
    await client.query("RESET ROLE");
    await client.query("DISCARD ALL");
  } catch (err) {
    // Destroy instead of returning a connection in an unknown state.
    client.release(err instanceof Error ? err : new Error("connection cleanup failed"));
    return;
  }
  client.release();
}

/** Give a `connect`-less test stub a `connect` that fails loudly instead of at type level. */
export function asDbPool(db: DbClient): DbPool {
  if (typeof db.connect === "function") return db as DbPool;
  return Object.assign(db, {
    connect: async (): Promise<pg.PoolClient> => {
      throw new Error("this db stub does not support transactions (no connect())");
    },
  });
}

/**
 * Decorate the root instance with `app.db`. Called directly (not via `app.register`) so the
 * decorator is visible app-wide without `fastify-plugin`. Closes the client on `app.close()`.
 */
export function registerDb(app: FastifyInstance, db: DbClient): void {
  app.decorate("db", asDbPool(db));
  app.addHook("onClose", async () => {
    await db.end();
  });
}
