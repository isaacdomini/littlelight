import type pg from "pg";

// Pipeline transactions (docs/plans/step-4.md 2.7; packages/db/README.md "Per-transaction
// identity"). DATABASE_URL is `littlelight_worker`, which owns the pg-boss schema and the
// heartbeat table but has no privilege on any app table: every query against app tables runs
// inside `runAsPipeline`, which switches to the NOLOGIN `pipeline` role for exactly one
// transaction and hands the connection back to the pool as `littlelight_worker` again.
// pg-boss and the heartbeat keep using `littlelight_worker` directly.

/**
 * The only role a worker unit of work may switch to. The statement reaches SQL text only from
 * this frozen one-entry map (an identifier cannot be a bind parameter), never from input.
 */
const SET_LOCAL_ROLE: Readonly<Record<"pipeline", string>> = Object.freeze({
  pipeline: "SET LOCAL ROLE pipeline",
});

/** Exposed for tests: the map must stay frozen and hold exactly one entry. */
export const PIPELINE_ROLE_STATEMENTS = SET_LOCAL_ROLE;

export interface PipelineTxOptions {
  /**
   * `DATA_ENCRYPTION_KEY`, bound to `set_config('app.data_key', $1, true)` for pgcrypto
   * (`encrypt_coord`, `decrypt_coord`, `home_place_label`). Pass it ONLY to the transaction that
   * writes `photo_exif` GPS; every other transaction runs without it. Never logged.
   */
  dataKey?: string | null;
}

/** The slice of `pg.Pool` the wrapper needs; tests pass a stub. */
export type PipelinePool = Pick<pg.Pool, "connect">;

/** A client inside a pipeline transaction. */
export type PipelineClient = Pick<pg.PoolClient, "query">;

/** Thrown when `COMMIT` reports `ROLLBACK`: `fn` swallowed a statement error inside the transaction. */
export class TransactionAbortedError extends Error {
  constructor() {
    super("transaction was aborted by an earlier error and has been rolled back");
    this.name = "TransactionAbortedError";
  }
}

/**
 * Run `fn` on one pooled client inside one transaction as `pipeline`:
 *
 *   BEGIN; SET LOCAL ROLE pipeline;
 *   SELECT set_config('app.data_key', $1, true);   -- only when dataKey is given
 *   <fn>; COMMIT            (ROLLBACK and rethrow if fn throws)
 *
 * then, outside any transaction, `RESET ROLE; DISCARD ALL` before the client goes back to the
 * pool. If that cleanup fails the client is destroyed, never reused. `fn` must not issue
 * `BEGIN`/`COMMIT`/`ROLLBACK` itself. Mirrors the API's `runAs` (apps/api/src/plugins/db.ts).
 */
export async function runAsPipeline<T>(
  pool: PipelinePool,
  opts: PipelineTxOptions,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // A checked-out client whose backend dies emits 'error'; without a listener that would crash
  // the process (pg-pool only listens on idle clients).
  let broken: Error | undefined;
  const onError = (err: Error) => {
    broken = err;
  };
  client.on("error", onError);
  let result: T;
  try {
    await client.query("BEGIN");
    try {
      await client.query(SET_LOCAL_ROLE.pipeline);
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
    client.release(err instanceof Error ? err : new Error("connection cleanup failed"));
    return;
  }
  client.release();
}

/** SQLSTATE of a pg error, if any. */
export function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** True for a unique violation (23505), optionally on one named constraint/index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (sqlState(err) !== "23505") return false;
  if (constraint === undefined) return true;
  return (err as { constraint?: unknown }).constraint === constraint;
}
