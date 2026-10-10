import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage, recordingLog, scriptedPool } from "../testing/stubs";
import {
  AUDIT_SQL,
  EXPIRE_PICKING_SQL,
  FAIL_ORPHAN_SQL,
  FAIL_STALE_RUNNING_SQL,
  FINISH_BATCH_SQL,
  ORPHAN_DOWNLOADED_SQL,
  QUEUED_BATCHES_SQL,
  REQUESTER_STATE_SQL,
  RETENTION_SQL,
} from "./sql";
import {
  SWEEP_QUEUED_ALERT_MIN,
  SWEEP_QUEUED_STUCK_MIN,
  SWEEP_RUNNING_STALE_MIN,
  sweepImports,
} from "./sweep";

// import.sweep (docs/plans/step-10.md 2.7): abandoned pickers, stuck queued batches, stale running
// batches, orphaned downloads, retention, leftover staging files. Statements are scripted by SQL.

const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const BABY = "33333333-3333-4333-8333-333333333333";

describe("sweepImports", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ll-sweep-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function setup(
    over: Record<string, (p: unknown[]) => { rows?: unknown[]; rowCount?: number }> = {},
  ) {
    const send = vi.fn(async () => "job" as string | null);
    const log = recordingLog();
    const storage = memoryStorage();
    const pool = scriptedPool({
      [EXPIRE_PICKING_SQL]: () => ({ rows: [], rowCount: 0 }),
      [QUEUED_BATCHES_SQL]: () => ({ rows: [] }),
      [FAIL_STALE_RUNNING_SQL]: () => ({ rows: [] }),
      [ORPHAN_DOWNLOADED_SQL]: () => ({ rows: [] }),
      [RETENTION_SQL]: () => ({ rowCount: 0 }),
      [REQUESTER_STATE_SQL]: () => ({ rows: [{ state: "ok" }] }),
      ...over,
    });
    return { send, log, storage, pool };
  }
  const run = (
    s: ReturnType<typeof setup>,
    extra: Partial<Parameters<typeof sweepImports>[0]> = {},
  ) =>
    sweepImports({
      pool: s.pool,
      storage: s.storage,
      sendImportGoogle: s.send,
      log: s.log,
      tmpDir: tmp,
      ...extra,
    });

  it("does nothing on an empty system", async () => {
    const s = setup();
    const r = await run(s);
    expect(r).toEqual({
      expired: 0,
      resent: 0,
      failedQueued: 0,
      failedRunning: 0,
      orphans: 0,
      retained: 0,
      tmpRemoved: 0,
      errors: 0,
    });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.log.lines.filter((l) => l.level === "warn")).toEqual([]);
  });

  it("expires abandoned picking batches using the 30 minute TTL", async () => {
    const s = setup({ [EXPIRE_PICKING_SQL]: () => ({ rows: [{ id: B1 }], rowCount: 1 }) });
    const r = await run(s);
    expect(r.expired).toBe(1);
    expect(s.pool.log.find(([sql]) => sql === EXPIRE_PICKING_SQL)?.[1]).toEqual([30]);
  });

  it("re-sends only queued batches stuck for more than 10 minutes", async () => {
    const s = setup({
      [QUEUED_BATCHES_SQL]: () => ({
        rows: [
          { id: B1, baby_id: BABY, stuck: true, age_min: 15 },
          { id: B2, baby_id: BABY, stuck: false, age_min: 2 },
        ],
      }),
    });
    const r = await run(s);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledWith({ batchId: B1, babyId: BABY });
    expect(r.resent).toBe(1);
    expect(SWEEP_QUEUED_STUCK_MIN).toBe(10);
  });

  it("a send that reports an already-queued job (null) does not count as a resend", async () => {
    const s = setup({
      [QUEUED_BATCHES_SQL]: () => ({ rows: [{ id: B1, baby_id: BABY, stuck: true, age_min: 30 }] }),
    });
    s.send.mockResolvedValue(null);
    expect((await run(s)).resent).toBe(0);
  });

  it.each([
    ["not_connected", "google_reconnect"],
    ["reconnect", "google_reconnect"],
    ["not_member", "requester_not_member"],
    ["baby_trashed", "baby_trashed"],
  ])(
    "fails a queued batch whose requester state is %s with %s (and audits it, no resend)",
    async (state, error) => {
      const s = setup({
        [QUEUED_BATCHES_SQL]: () => ({
          rows: [{ id: B1, baby_id: BABY, stuck: true, age_min: 30 }],
        }),
        [REQUESTER_STATE_SQL]: () => ({ rows: [{ state }] }),
        [FINISH_BATCH_SQL]: () => ({ rows: [], rowCount: 1 }),
      });
      const r = await run(s);
      expect(r.failedQueued).toBe(1);
      expect(s.send).not.toHaveBeenCalled();
      expect(s.pool.log.find(([sql]) => sql === FINISH_BATCH_SQL)?.[1]).toEqual([
        B1,
        "failed",
        error,
      ]);
      const audit = s.pool.log.find(([sql]) => sql === AUDIT_SQL);
      expect(audit?.[1]?.[1]).toBe("import.batch_failed");
      expect(JSON.parse(String(audit?.[1]?.[2]))).toEqual({ batch_id: B1 });
    },
  );

  it("not_active leaves the batch alone", async () => {
    const s = setup({
      [QUEUED_BATCHES_SQL]: () => ({ rows: [{ id: B1, baby_id: BABY, stuck: false, age_min: 1 }] }),
      [REQUESTER_STATE_SQL]: () => ({ rows: [{ state: "not_active" }] }),
    });
    const r = await run(s);
    expect(r.failedQueued).toBe(0);
    expect(s.pool.log.some(([sql]) => sql === FINISH_BATCH_SQL)).toBe(false);
  });

  it("one warn when the oldest queued batch is older than 2 hours", async () => {
    const s = setup({
      [QUEUED_BATCHES_SQL]: () => ({
        rows: [{ id: B1, baby_id: BABY, stuck: true, age_min: SWEEP_QUEUED_ALERT_MIN + 5 }],
      }),
    });
    await run(s);
    const warns = s.log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.obj).toMatchObject({ alert: "import_queue_age" });
  });

  it("a failing resend defers that batch and is counted, not thrown", async () => {
    const s = setup({
      [QUEUED_BATCHES_SQL]: () => ({ rows: [{ id: B1, baby_id: BABY, stuck: true, age_min: 30 }] }),
    });
    s.send.mockRejectedValue(new Error("boss down http://x?token=secret"));
    const r = await run(s);
    expect(r.errors).toBe(1);
    expect(JSON.stringify(s.log.lines)).not.toContain("secret");
  });

  it("fails running batches without progress for 2 hours and audits each", async () => {
    const s = setup({ [FAIL_STALE_RUNNING_SQL]: () => ({ rows: [{ id: B1, baby_id: BABY }] }) });
    const r = await run(s);
    expect(r.failedRunning).toBe(1);
    expect(s.pool.log.find(([sql]) => sql === FAIL_STALE_RUNNING_SQL)?.[1]).toEqual([
      SWEEP_RUNNING_STALE_MIN,
    ]);
    expect(s.pool.log.filter(([sql]) => sql === AUDIT_SQL)).toHaveLength(1);
  });

  it("deletes the object of an orphaned download, then fails the item; a delete failure is deferred", async () => {
    const orphans = [
      { id: "i1", storage_key: "babies/b/originals/i1" },
      { id: "i2", storage_key: "babies/b/originals/i2" },
    ];
    let served = false;
    const s = setup({
      [ORPHAN_DOWNLOADED_SQL]: () => {
        if (served) return { rows: [] };
        served = true;
        return { rows: orphans };
      },
      [FAIL_ORPHAN_SQL]: () => ({ rowCount: 1 }),
    });
    s.storage.failOn.add("delete:babies/b/originals/i2");
    const r = await run(s);
    expect(r.orphans).toBe(1);
    expect(r.errors).toBe(1);
    expect(s.storage.calls).toContain("delete:babies/b/originals/i1");
    expect(s.pool.log.filter(([sql]) => sql === FAIL_ORPHAN_SQL).map(([, p]) => p)).toEqual([
      ["i1"],
    ]);
  });

  it("counts retention deletes", async () => {
    const s = setup({ [RETENTION_SQL]: () => ({ rowCount: 12 }) });
    expect((await run(s)).retained).toBe(12);
  });

  it("removes staged files older than an hour and keeps fresh ones", async () => {
    const old = path.join(tmp, "old-item");
    const fresh = path.join(tmp, "fresh-item");
    await writeFile(old, "x");
    await writeFile(fresh, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    const s = setup();
    const r = await run(s);
    expect(r.tmpRemoved).toBe(1);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(tmp)).toEqual(["fresh-item"]);
  });

  it("a missing staging directory is fine", async () => {
    const s = setup();
    await expect(run(s, { tmpDir: path.join(tmp, "nope", "ll-import") })).resolves.toMatchObject({
      tmpRemoved: 0,
    });
    await mkdir(path.join(tmp, "x"));
  });

  it("logs counts only", async () => {
    const s = setup({ [EXPIRE_PICKING_SQL]: () => ({ rows: [{ id: B1 }], rowCount: 1 }) });
    await run(s);
    const out = JSON.stringify(s.log.lines);
    expect(out).not.toContain(B1);
    expect(out).toContain("import.sweep: done");
  });
});
