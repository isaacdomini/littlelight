import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { asDbPool, runAs, TransactionAbortedError } from "./db";

/** A pg client whose queries are scripted; records every statement. */
function fakeClient(script: (sql: string, params?: unknown[]) => unknown = () => ({ rows: [] })) {
  const log: string[] = [];
  const listeners = new Map<string, (...a: unknown[]) => void>();
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      log.push(sql);
      return script(sql, params);
    }),
    on: (ev: string, fn: (...a: unknown[]) => void) => listeners.set(ev, fn),
    off: (ev: string) => listeners.delete(ev),
    release,
  };
  const pool = { connect: async () => client as unknown as pg.PoolClient };
  return { client, pool, log, release, listeners };
}

describe("runAs (unit, scripted client)", () => {
  it("brackets fn with BEGIN / SET LOCAL ROLE / claims / COMMIT, then RESET ROLE + DISCARD ALL", async () => {
    const f = fakeClient();
    const out = await runAs(
      f.pool,
      "authenticated",
      { claimsJson: '{"a":1}', dataKey: "k" },
      async () => 7,
    );
    expect(out).toBe(7);
    expect(f.log).toEqual([
      "BEGIN",
      "SET LOCAL ROLE authenticated",
      "SELECT set_config('request.jwt.claims', $1, true)",
      "SELECT set_config('app.data_key', $1, true)",
      "COMMIT",
      "RESET ROLE",
      "DISCARD ALL",
    ]);
    expect(f.client.query).toHaveBeenCalledWith(
      "SELECT set_config('request.jwt.claims', $1, true)",
      ['{"a":1}'],
    );
    expect(f.release).toHaveBeenCalledWith();
  });

  it("rejects an unknown role before connecting", async () => {
    const connect = vi.fn();
    await expect(
      runAs({ connect } as never, "postgres" as never, {}, async () => 1),
    ).rejects.toThrow(/unknown database role/);
    await expect(
      runAs({ connect } as never, "toString" as never, {}, async () => 1),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rolls back, rethrows and still cleans up when fn throws", async () => {
    const f = fakeClient();
    await expect(
      runAs(f.pool, "viewer", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(f.log).toEqual([
      "BEGIN",
      "SET LOCAL ROLE viewer",
      "ROLLBACK",
      "RESET ROLE",
      "DISCARD ALL",
    ]);
    expect(f.release).toHaveBeenCalledWith();
  });

  it("raises TransactionAbortedError when COMMIT answers ROLLBACK", async () => {
    const f = fakeClient((sql) =>
      sql === "COMMIT" ? { command: "ROLLBACK", rows: [] } : { rows: [] },
    );
    await expect(runAs(f.pool, "service_role", {}, async () => 1)).rejects.toBeInstanceOf(
      TransactionAbortedError,
    );
    expect(f.log).toContain("ROLLBACK");
  });

  it("destroys the client when cleanup fails", async () => {
    const f = fakeClient((sql) => {
      if (sql === "DISCARD ALL") throw new Error("connection lost");
      return { rows: [] };
    });
    await runAs(f.pool, "authenticated", {}, async () => 1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("destroys the client when its backend emitted an error during the unit of work", async () => {
    const f = fakeClient();
    await expect(
      runAs(f.pool, "authenticated", {}, async () => {
        f.listeners.get("error")?.(new Error("terminating connection"));
        throw new Error("query failed");
      }),
    ).rejects.toThrow("query failed");
    expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    // No RESET/DISCARD on a dead connection.
    expect(f.log).not.toContain("DISCARD ALL");
  });
});

describe("asDbPool", () => {
  it("gives a connect-less stub a connect that fails loudly", async () => {
    const pool = asDbPool({ query: async () => ({ rows: [] }), end: async () => undefined });
    await expect(pool.connect()).rejects.toThrow(/does not support transactions/);
  });
});
