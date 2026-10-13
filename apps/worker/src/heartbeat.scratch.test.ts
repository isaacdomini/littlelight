import { describe, expect, it } from "vitest";
import { createScratchSampler } from "./heartbeat";

// `details.scratchFreeBytes` (docs/plans/step-12.md 2.6, Q8): the scratch folder's free space is
// sampled at most once per interval, "scratch low" is logged once on the way down and once on the
// way back, byte counts only (never the path), and a failed sample is undefined.

function logger() {
  const lines: { level: string; obj: unknown; msg: string }[] = [];
  const mk = (level: string) => (obj: unknown, msg: string) => void lines.push({ level, obj, msg });
  return { lines, warn: mk("warn"), info: mk("info"), debug: mk("debug") };
}

describe("createScratchSampler", () => {
  it("samples, caches within the interval, re-samples after it", async () => {
    let t = 1_000_000;
    let free = 10e9;
    let calls = 0;
    const log = logger();
    const sample = createScratchSampler({
      freeBytes: async () => {
        calls++;
        return free;
      },
      minFreeBytes: 6e9,
      log,
      minIntervalMs: 60_000,
      now: () => t,
    });
    expect(await sample()).toBe(10e9);
    free = 1e9;
    t += 30_000;
    expect(await sample()).toBe(10e9); // cached
    expect(calls).toBe(1);
    t += 31_000;
    expect(await sample()).toBe(1e9);
    expect(calls).toBe(2);
  });

  it("warns once when the space drops under the floor, info once when it is back, nothing in between", async () => {
    let t = 0;
    let free = 8e9;
    const log = logger();
    const sample = createScratchSampler({
      freeBytes: async () => free,
      minFreeBytes: 6e9,
      log,
      minIntervalMs: 1,
      now: () => (t += 10),
    });
    await sample();
    expect(log.lines.filter((l) => l.level !== "debug")).toEqual([]);
    free = 2e9;
    await sample();
    await sample();
    const warns = log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toMatch(/scratch low/);
    expect(warns[0]?.obj).toEqual({ scratchFreeBytes: 2e9, minFreeBytes: 6e9 });
    free = 7e9;
    await sample();
    await sample();
    const infos = log.lines.filter((l) => l.level === "info");
    expect(infos).toHaveLength(1);
    expect(infos[0]?.msg).toMatch(/back over threshold/);
    expect(JSON.stringify(log.lines)).not.toMatch(/\/scratch|\/mnt/);
  });

  it("a failing statfs resolves undefined, logs a category only, and recovers on the next sample", async () => {
    let t = 0;
    let fail = true;
    const log = logger();
    const sample = createScratchSampler({
      freeBytes: async () => {
        if (fail)
          throw new Error("ENOENT: no such file or directory, statfs '/mnt/data/tinyglow/scratch'");
        return 9e9;
      },
      minFreeBytes: 6e9,
      log,
      minIntervalMs: 1,
      now: () => (t += 10),
    });
    expect(await sample()).toBeUndefined();
    expect(log.lines.map((l) => l.level)).toEqual(["debug"]);
    expect(JSON.stringify(log.lines)).not.toContain("/mnt/data");
    fail = false;
    expect(await sample()).toBe(9e9);
  });
});
