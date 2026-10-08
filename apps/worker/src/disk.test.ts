import { describe, expect, it } from "vitest";
import { createDiskMonitor, type StatfsLike, usedPercent } from "./disk";
import { recordingLog } from "./testing/stubs";

const fs = (used: number, avail: number): StatfsLike => ({
  blocks: used + avail,
  bfree: avail,
  bavail: avail,
  bsize: 4096,
});

describe("usedPercent", () => {
  it("computes used / (used + available) like df", () => {
    expect(usedPercent(fs(50, 50))).toBe(50);
    expect(usedPercent(fs(81, 19))).toBe(81);
    expect(usedPercent(fs(0, 100))).toBe(0);
    expect(usedPercent(fs(100, 0))).toBe(100);
  });
  it("uses bavail (reserved blocks count as used)", () => {
    expect(usedPercent({ blocks: 100, bfree: 20, bavail: 10, bsize: 1 })).toBe(88.9);
  });
  it("accepts bigint fields and rounds to one decimal", () => {
    expect(usedPercent({ blocks: 3n, bfree: 2n, bavail: 2n, bsize: 4096n })).toBe(33.3);
  });
  it("undefined for an empty filesystem", () => {
    expect(usedPercent({ blocks: 0, bfree: 0, bavail: 0, bsize: 1 })).toBeUndefined();
  });
});

describe("createDiskMonitor", () => {
  it("unset path: one info line, never calls statfs, sample() is undefined", async () => {
    const log = recordingLog();
    let called = 0;
    const m = createDiskMonitor({
      path: undefined,
      alertPct: 80,
      log,
      statfs: async () => {
        called++;
        return fs(1, 1);
      },
    });
    expect(await m.sample()).toBeUndefined();
    expect(await m.sample()).toBeUndefined();
    expect(called).toBe(0);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]?.level).toBe("info");
  });

  it("warns once when usage crosses the threshold, not on every sample", async () => {
    const log = recordingLog();
    let pct = 50;
    const m = createDiskMonitor({
      path: "/data",
      alertPct: 80,
      log,
      statfs: async () => fs(pct, 100 - pct),
    });
    expect(await m.sample()).toBe(50);
    pct = 85;
    expect(await m.sample()).toBe(85);
    expect(await m.sample()).toBe(85);
    pct = 90;
    await m.sample();
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(log.lines.find((l) => l.level === "warn")?.obj).toMatchObject({
      diskUsedPct: 85,
      alertPct: 80,
    });
  });

  it("the threshold is inclusive (>=)", async () => {
    const log = recordingLog();
    const m = createDiskMonitor({ path: "/d", alertPct: 80, log, statfs: async () => fs(80, 20) });
    await m.sample();
    expect(log.lines.some((l) => l.level === "warn")).toBe(true);
  });

  it("logs info when back under, and warns again on the next crossing", async () => {
    const log = recordingLog();
    let pct = 90;
    const m = createDiskMonitor({
      path: "/d",
      alertPct: 80,
      log,
      statfs: async () => fs(pct, 100 - pct),
    });
    await m.sample();
    pct = 60;
    await m.sample();
    pct = 95;
    await m.sample();
    const levels = log.lines.map((l) => `${l.level}:${l.msg.replace("disk alert: ", "")}`);
    expect(levels).toEqual([
      "info:monitoring storage usage",
      "warn:storage usage above threshold",
      "info:storage usage back under threshold",
      "warn:storage usage above threshold",
    ]);
  });

  it("a failing statfs is logged once (error code only) and skipped, then recovers", async () => {
    const log = recordingLog();
    let fail = true;
    const m = createDiskMonitor({
      path: "/missing",
      alertPct: 80,
      log,
      statfs: async () => {
        if (fail)
          throw Object.assign(new Error("ENOENT: no such file /missing"), { code: "ENOENT" });
        return fs(10, 90);
      },
    });
    expect(await m.sample()).toBeUndefined();
    expect(await m.sample()).toBeUndefined();
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(log.lines[0]?.obj).toEqual({ disk: "ENOENT" });
    expect(JSON.stringify(log.lines)).not.toContain("/missing");
    fail = false;
    expect(await m.sample()).toBe(10);
  });
});
