import { describe, expect, it } from "vitest";
import { RECONCILE_SQL, reconcileIngest } from "./reconcile";
import { recordingLog, scriptedPool } from "./testing/stubs";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BABY = "11111111-1111-4111-8111-111111111111";

describe("reconcileIngest", () => {
  it("only targets uploaded photos older than two minutes, never trashed or quarantined ones", () => {
    expect(RECONCILE_SQL).toContain("status = 'uploaded'");
    expect(RECONCILE_SQL).toContain("interval '2 minutes'");
    expect(RECONCILE_SQL).toContain("deleted_at IS NULL");
    expect(RECONCILE_SQL).toContain("quarantined_at IS NULL");
    expect(RECONCILE_SQL).toContain("LIMIT 500");
  });

  it("re-sends a job per stuck photo and counts sent / already queued / failed", async () => {
    const pool = scriptedPool({
      [RECONCILE_SQL]: () => ({
        rows: [
          { id: A, baby_id: BABY },
          { id: B, baby_id: BABY },
          { id: C, baby_id: BABY },
        ],
      }),
    });
    const sent: unknown[] = [];
    const log = recordingLog();
    const res = await reconcileIngest({
      pool,
      log,
      send: async (job) => {
        sent.push(job);
        if (job.photoId === B) return null; // already queued
        if (job.photoId === C) throw new Error("boom https://secret");
        return "job-id";
      },
    });
    expect(res).toEqual({ stuck: 3, sent: 1, alreadyQueued: 1, failed: 1 });
    expect(sent).toEqual([
      { photoId: A, babyId: BABY },
      { photoId: B, babyId: BABY },
      { photoId: C, babyId: BABY },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain("secret");
  });

  it("nothing stuck: nothing sent, debug only", async () => {
    const pool = scriptedPool({ [RECONCILE_SQL]: () => ({ rows: [] }) });
    const log = recordingLog();
    const res = await reconcileIngest({ pool, log, send: async () => "x" });
    expect(res).toEqual({ stuck: 0, sent: 0, alreadyQueued: 0, failed: 0 });
    expect(log.lines.map((l) => l.level)).toEqual(["debug"]);
  });

  it("the payload carries ids only (no tzHint can be recovered)", async () => {
    const pool = scriptedPool({ [RECONCILE_SQL]: () => ({ rows: [{ id: A, baby_id: BABY }] }) });
    let job: unknown;
    await reconcileIngest({
      pool,
      log: recordingLog(),
      send: async (j) => {
        job = j;
        return "id";
      },
    });
    expect(Object.keys(job as object).sort()).toEqual(["babyId", "photoId"]);
  });
});
