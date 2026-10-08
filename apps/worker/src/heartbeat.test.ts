import { describe, expect, it } from "vitest";
import {
  beatOnce,
  type HeartbeatDeps,
  PRUNE_SQL,
  UPSERT_OK_SQL,
  UPSERT_STORAGE_DOWN_SQL,
} from "./heartbeat";

function makeDeps(send: () => Promise<unknown>) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const deps: HeartbeatDeps = {
    db: {
      query: async (text, values) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    },
    s3: { send: send as never },
    bucket: "littlelight-dev",
    workerId: "w1",
    hostname: "w1",
    pid: 42,
    version: "0.0.0",
    startedAt: new Date(0),
  };
  return { deps, calls };
}

describe("beatOnce", () => {
  it("refreshes last_seen_at when storage is reachable", async () => {
    const { deps, calls } = makeDeps(async () => ({}));
    const result = await beatOnce(deps);
    expect(result.storageOk).toBe(true);
    expect(calls[0]?.text).toBe(UPSERT_OK_SQL);
    expect(UPSERT_OK_SQL).toContain("last_seen_at = now()");
    expect(calls[1]?.text).toBe(PRUNE_SQL);
  });

  it("does NOT advance last_seen_at when storage fails", async () => {
    const { deps, calls } = makeDeps(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED http://storage:9000"), {
        code: "ECONNREFUSED",
      });
    });
    const result = await beatOnce(deps);
    expect(result).toMatchObject({ storageOk: false, storageError: "ECONNREFUSED" });
    expect(calls[0]?.text).toBe(UPSERT_STORAGE_DOWN_SQL);
    // The conflict-update branch must not touch last_seen_at.
    const updatePart = UPSERT_STORAGE_DOWN_SQL.split("DO UPDATE SET")[1] ?? "";
    expect(updatePart).not.toContain("last_seen_at");
    expect(updatePart).toContain("storage_ok = false");
    // New rows start stale (epoch) so the healthcheck fails.
    expect(UPSERT_STORAGE_DOWN_SQL).toContain("to_timestamp(0)");
  });

  it("advances updated_at on every upsert (insert and conflict update), storage up or down", () => {
    for (const sql of [UPSERT_OK_SQL, UPSERT_STORAGE_DOWN_SQL]) {
      expect(sql.split("VALUES")[0]).toContain("updated_at");
      expect(sql.split("VALUES")[1]?.split("ON CONFLICT")[0]).toContain("now()");
      expect(sql.split("DO UPDATE SET")[1]).toContain("updated_at = now()");
    }
  });

  it("prunes on updated_at (always advancing), never on last_seen_at, and spares own row", () => {
    expect(PRUNE_SQL).toContain("updated_at < now() - interval '1 day'");
    expect(PRUNE_SQL).not.toContain("last_seen_at");
    expect(PRUNE_SQL).toContain("worker_id <> $1");
  });

  it("records only a sanitized category in details, never the raw message", async () => {
    const { deps, calls } = makeDeps(async () => {
      throw new Error("failed http://storage:9000 secret=abc");
    });
    await beatOnce(deps);
    const details = String(calls[0]?.values?.[5]);
    expect(details).not.toContain("storage:9000");
    expect(details).not.toContain("secret");
    expect(JSON.parse(details).storageError).toBe("error");
  });

  it("maps timeouts to a 'timeout' category", async () => {
    const { deps } = makeDeps(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect((await beatOnce(deps)).storageError).toBe("timeout");
  });

  it("propagates database errors", async () => {
    const { deps } = makeDeps(async () => ({}));
    deps.db = {
      query: async () => {
        throw new Error("db down");
      },
    };
    await expect(beatOnce(deps)).rejects.toThrow("db down");
  });
});
