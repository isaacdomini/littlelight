import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  isUniqueViolation,
  PIPELINE_ROLE_STATEMENTS,
  runAsPipeline,
  sqlState,
  TransactionAbortedError,
} from "./db";

/** A pg client whose statements are scripted and recorded; `emit` triggers client events. */
function fakeClient(script: (sql: string, params?: unknown[]) => unknown = () => ({ rows: [] })) {
  const log: string[] = [];
  const listeners = new Map<string, (...a: unknown[]) => void>();
  let released: { err?: Error } | null = null;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      log.push(sql);
      return script(sql, params);
    },
    on: (ev: string, fn: (...a: unknown[]) => void) => {
      listeners.set(ev, fn);
      return client;
    },
    off: (ev: string) => {
      listeners.delete(ev);
      return client;
    },
    release: (err?: Error) => {
      released = { err };
    },
  };
  const pool = { connect: async () => client as unknown as pg.PoolClient };
  return { pool, log, listeners, released: () => released, client };
}

describe("runAsPipeline", () => {
  it("the role statement map is frozen, has one entry, and is the only SET ROLE text", () => {
    expect(Object.isFrozen(PIPELINE_ROLE_STATEMENTS)).toBe(true);
    expect(Object.keys(PIPELINE_ROLE_STATEMENTS)).toEqual(["pipeline"]);
    expect(PIPELINE_ROLE_STATEMENTS.pipeline).toBe("SET LOCAL ROLE pipeline");
    expect(() => {
      (PIPELINE_ROLE_STATEMENTS as Record<string, string>).pipeline = "SET LOCAL ROLE postgres";
    }).toThrow();
  });

  it("BEGIN, SET LOCAL ROLE, fn, COMMIT, then RESET ROLE and DISCARD ALL; no data key by default", async () => {
    const f = fakeClient(() => ({ rows: [], command: "COMMIT" }));
    const out = await runAsPipeline(f.pool, {}, async () => 42);
    expect(out).toBe(42);
    expect(f.log).toEqual([
      "BEGIN",
      "SET LOCAL ROLE pipeline",
      "COMMIT",
      "RESET ROLE",
      "DISCARD ALL",
    ]);
    expect(f.released()?.err).toBeUndefined();
    expect(f.listeners.size).toBe(0); // error listener removed
  });

  it("binds the data key (as a parameter) only when it is given and non-empty", async () => {
    const seen: [string, unknown[] | undefined][] = [];
    const f = fakeClient((sql, params) => {
      seen.push([sql, params]);
      return { rows: [], command: "COMMIT" };
    });
    await runAsPipeline(f.pool, { dataKey: "k-1" }, async () => 1);
    expect(seen.find(([s]) => s.includes("app.data_key"))).toEqual([
      "SELECT set_config('app.data_key', $1, true)",
      ["k-1"],
    ]);
    for (const dataKey of [undefined, null, ""]) {
      const g = fakeClient(() => ({ rows: [], command: "COMMIT" }));
      await runAsPipeline(g.pool, { dataKey }, async () => 1);
      expect(g.log.some((s) => s.includes("app.data_key"))).toBe(false);
    }
    // The key never appears in SQL text.
    expect(f.log.join("\n")).not.toContain("k-1");
  });

  it("rolls back and rethrows when fn throws, still resetting the connection", async () => {
    const f = fakeClient();
    await expect(
      runAsPipeline(f.pool, {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(f.log).toEqual([
      "BEGIN",
      "SET LOCAL ROLE pipeline",
      "ROLLBACK",
      "RESET ROLE",
      "DISCARD ALL",
    ]);
    expect(f.log).not.toContain("COMMIT");
    expect(f.released()?.err).toBeUndefined();
  });

  it("a COMMIT answered with ROLLBACK (aborted tx) is a TransactionAbortedError", async () => {
    const f = fakeClient((sql) =>
      sql === "COMMIT" ? { rows: [], command: "ROLLBACK" } : { rows: [] },
    );
    await expect(runAsPipeline(f.pool, {}, async () => 1)).rejects.toBeInstanceOf(
      TransactionAbortedError,
    );
    expect(f.log).toContain("ROLLBACK");
  });

  it("a failing RESET/DISCARD destroys the client instead of returning it to the pool", async () => {
    const f = fakeClient((sql) => {
      if (sql === "DISCARD ALL") throw new Error("connection lost");
      return { rows: [], command: "COMMIT" };
    });
    await runAsPipeline(f.pool, {}, async () => 1);
    expect(f.released()?.err).toBeInstanceOf(Error);
  });

  it("a client that errored while checked out is destroyed and never reset", async () => {
    const f = fakeClient(() => ({ rows: [], command: "COMMIT" }));
    await runAsPipeline(f.pool, {}, async () => {
      f.listeners.get("error")?.(new Error("backend died"));
      return 1;
    });
    expect(f.released()?.err?.message).toBe("backend died");
    expect(f.log).not.toContain("RESET ROLE");
    expect(f.log).not.toContain("DISCARD ALL");
  });

  it("a failing ROLLBACK does not mask the original error", async () => {
    const f = fakeClient((sql) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [] };
    });
    await expect(
      runAsPipeline(f.pool, {}, async () => {
        throw new Error("original");
      }),
    ).rejects.toThrow("original");
  });

  it("does not leak SET ROLE if SET LOCAL ROLE itself fails", async () => {
    const f = fakeClient((sql) => {
      if (sql.startsWith("SET LOCAL ROLE")) throw new Error("role missing");
      return { rows: [] };
    });
    await expect(runAsPipeline(f.pool, {}, async () => 1)).rejects.toThrow("role missing");
    expect(f.log).toContain("ROLLBACK");
  });
});

describe("sqlState / isUniqueViolation", () => {
  const pgErr = (code: string, constraint?: string) =>
    Object.assign(new Error("x"), { code, constraint });
  it("reads the SQLSTATE", () => {
    expect(sqlState(pgErr("23505"))).toBe("23505");
    expect(sqlState(new Error("x"))).toBeUndefined();
    expect(sqlState(null)).toBeUndefined();
  });
  it("matches unique violations, optionally by constraint", () => {
    expect(isUniqueViolation(pgErr("23505", "photos_baby_id_sha256_key"))).toBe(true);
    expect(
      isUniqueViolation(pgErr("23505", "photos_baby_id_sha256_key"), "photos_baby_id_sha256_key"),
    ).toBe(true);
    expect(isUniqueViolation(pgErr("23505", "other"), "photos_baby_id_sha256_key")).toBe(false);
    expect(isUniqueViolation(pgErr("23514"))).toBe(false);
  });
});
