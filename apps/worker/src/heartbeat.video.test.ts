import { describe, expect, it } from "vitest";
import { beatOnce, createStuckVideosSampler, type HeartbeatDeps, UPSERT_OK_SQL } from "./heartbeat";

// `details.videosPendingStuck` (docs/plans/step-12.md 2.6; review fix S2): the count of videos
// stuck `pending` past the reconcile threshold is sampled at most once per 5 minutes, warns once
// while non-zero and logs info once when back to 0; a failed sample is undefined and absent from
// the heartbeat details. Counts only: never a photo id in a log line.

function logger() {
  const lines: { level: string; obj: unknown; msg: string }[] = [];
  const mk = (level: string) => (obj: unknown, msg: string) => void lines.push({ level, obj, msg });
  return { lines, warn: mk("warn"), info: mk("info"), debug: mk("debug") };
}

describe("createStuckVideosSampler", () => {
  it("caches for 5 minutes by default, re-samples after", async () => {
    let t = 1_000_000;
    let n = 0;
    let calls = 0;
    const sample = createStuckVideosSampler({
      count: async () => {
        calls++;
        return n;
      },
      log: logger(),
      now: () => t,
    });
    expect(await sample()).toBe(0);
    n = 3;
    t += 299_999;
    expect(await sample()).toBe(0); // cached
    expect(calls).toBe(1);
    t += 1;
    expect(await sample()).toBe(3);
    expect(calls).toBe(2);
  });

  it("warns once on > 0 (not again while it stays stuck), info once when back to 0, nothing while 0", async () => {
    let t = 0;
    let n = 0;
    const log = logger();
    const sample = createStuckVideosSampler({
      count: async () => n,
      log,
      minIntervalMs: 1,
      now: () => (t += 10),
    });
    await sample();
    await sample();
    expect(log.lines).toEqual([]);
    n = 2;
    await sample();
    n = 5;
    await sample();
    const warns = log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toMatch(/stuck pending/);
    expect(warns[0]?.obj).toEqual({ videosPendingStuck: 2 });
    n = 0;
    await sample();
    await sample();
    const infos = log.lines.filter((l) => l.level === "info");
    expect(infos).toHaveLength(1);
    expect(infos[0]?.obj).toEqual({ videosPendingStuck: 0 });
    n = 1;
    await sample();
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  it("a failing count resolves undefined, logs a category only, and recovers", async () => {
    let t = 0;
    let fail = true;
    const log = logger();
    const sample = createStuckVideosSampler({
      count: async () => {
        if (fail) throw Object.assign(new Error("connect ECONNREFUSED db:5432"), { code: "57P01" });
        return 4;
      },
      log,
      minIntervalMs: 1,
      now: () => (t += 10),
    });
    expect(await sample()).toBeUndefined();
    expect(log.lines.map((l) => l.level)).toEqual(["debug"]);
    expect(JSON.stringify(log.lines)).not.toContain("db:5432");
    fail = false;
    expect(await sample()).toBe(4);
  });
});

describe("beatOnce: details.videosPendingStuck", () => {
  function makeDeps(over: Partial<HeartbeatDeps>) {
    const calls: { text: string; values?: unknown[] }[] = [];
    const deps: HeartbeatDeps = {
      db: {
        query: async (text, values) => {
          calls.push({ text, values });
          return { rows: [] };
        },
      },
      s3: { send: (async () => ({})) as never },
      bucket: "tinyglow-dev",
      workerId: "w1",
      hostname: "w1",
      pid: 42,
      version: "0.0.0",
      startedAt: new Date(0),
      ...over,
    };
    return { deps, calls };
  }

  it("is written into the heartbeat details and the result when the sampler answers", async () => {
    const { deps, calls } = makeDeps({ videosPendingStuck: async () => 3 });
    const r = await beatOnce(deps);
    expect(r.videosPendingStuck).toBe(3);
    expect(calls[0]?.text).toBe(UPSERT_OK_SQL);
    expect(JSON.parse(String(calls[0]?.values?.[5]))).toMatchObject({ videosPendingStuck: 3 });
  });

  it("is absent when the sampler is not configured, resolves undefined or throws", async () => {
    for (const over of [
      {},
      { videosPendingStuck: async () => undefined },
      {
        videosPendingStuck: async () => {
          throw new Error("db down");
        },
      },
    ] as Partial<HeartbeatDeps>[]) {
      const { deps, calls } = makeDeps(over);
      const r = await beatOnce(deps);
      expect("videosPendingStuck" in r).toBe(false);
      expect(JSON.parse(String(calls[0]?.values?.[5]))).not.toHaveProperty("videosPendingStuck");
    }
  });
});
