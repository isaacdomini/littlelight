import type { FastifyInstance } from "fastify";
import pg from "pg";
import type { ApiConfig } from "../config";

/** The slice of `pg.Pool` the API uses; tests pass a stub with the same shape. */
export interface DbClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    db: DbClient;
  }
}

/**
 * Create the shared pg pool. Short connection timeout so `/healthz` reports a down database
 * quickly instead of hanging. The connection string is never logged.
 */
export function createPool(config: Pick<ApiConfig, "DATABASE_URL">, log: FastifyInstance["log"]) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    application_name: "littlelight-api",
  });
  // An idle client error (e.g. the db restarting) must not crash the process.
  pool.on("error", (err) => {
    log.warn({ code: (err as { code?: unknown }).code }, "pg pool idle client error");
  });
  return pool;
}

/**
 * Decorate the root instance with `app.db`. Called directly (not via `app.register`) so the
 * decorator is visible app-wide without `fastify-plugin`. Closes the client on `app.close()`.
 */
export function registerDb(app: FastifyInstance, db: DbClient): void {
  app.decorate("db", db);
  app.addHook("onClose", async () => {
    await db.end();
  });
}
