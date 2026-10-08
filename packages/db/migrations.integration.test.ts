import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./src/index";

// Migration round trip against a real Postgres (pgvector image). Skipped when DATABASE_URL is
// unset. Also needs AUTH_DB_PASSWORD for the bootstrap step (defaults to a throwaway below).
// WARNING: reverts every migration, so only point it at a disposable database.
const databaseUrl = process.env.DATABASE_URL;
const quiet = () => undefined;

describe.skipIf(!databaseUrl)("db migrations round trip", () => {
  let client: pg.Client;
  const env = { ...process.env, AUTH_DB_PASSWORD: process.env.AUTH_DB_PASSWORD ?? "dev" };
  const run = (opts: Parameters<typeof runMigrations>[0]) =>
    runMigrations({ databaseUrl, env, log: quiet, ...opts });

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    // Start from a clean slate regardless of earlier state.
    await run({ direction: "down", count: Number.POSITIVE_INFINITY, bootstrap: false });
  });

  afterAll(async () => {
    // Leave the database migrated, as the dev stack expects.
    await run({ direction: "up" });
    await client.end();
  });

  const scalar = async (sql: string) =>
    (await client.query(sql)).rows[0] as Record<string, unknown>;

  it("applies all migrations up", async () => {
    const applied = await run({ direction: "up" });
    expect(applied.length).toBe(2);
    const { n } = await scalar("SELECT count(*)::int AS n FROM public.pgmigrations");
    expect(n).toBe(2);
    const ext = await client.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto') ORDER BY 1",
    );
    expect(ext.rows.map((r) => r.extname)).toEqual(["pgcrypto", "vector"]);
  });

  it("enables RLS on worker_heartbeats and creates the JWT roles", async () => {
    const rls = await scalar(
      "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.worker_heartbeats'::regclass",
    );
    expect(rls.relrowsecurity).toBe(true);
    const roles = await client.query(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','supabase_auth_admin') ORDER BY 1",
    );
    expect(roles.rows.map((r) => r.rolname)).toEqual([
      "anon",
      "authenticated",
      "service_role",
      "supabase_auth_admin",
    ]);
  });

  it("denies the authenticated role any access to worker_heartbeats", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE authenticated");
      await expect(client.query("SELECT * FROM public.worker_heartbeats")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("denies anon as well", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE anon");
      await expect(client.query("SELECT * FROM public.worker_heartbeats")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("is idempotent: a second up applies nothing", async () => {
    expect(await run({ direction: "up" })).toEqual([]);
  });

  it("reverts everything down", async () => {
    const reverted = await run({
      direction: "down",
      count: Number.POSITIVE_INFINITY,
      bootstrap: false,
    });
    expect(reverted.length).toBe(2);
    const { n } = await scalar("SELECT count(*)::int AS n FROM public.pgmigrations");
    expect(n).toBe(0);
    const table = await scalar("SELECT to_regclass('public.worker_heartbeats') AS t");
    expect(table.t).toBeNull();
    const ext = await client.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto')",
    );
    expect(ext.rows).toEqual([]);
  });

  it("applies cleanly up again after a full down, then is a no-op", async () => {
    expect((await run({ direction: "up" })).length).toBe(2);
    expect(await run({ direction: "up" })).toEqual([]);
    const table = await scalar("SELECT to_regclass('public.worker_heartbeats') AS t");
    expect(table.t).not.toBeNull();
  });
});
