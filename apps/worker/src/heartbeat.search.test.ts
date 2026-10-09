import { describe, expect, it, vi } from "vitest";
import { beatOnce, createSearchStatsSampler, type HeartbeatDeps } from "./heartbeat";

const log = () => ({ debug: vi.fn() });

describe("createSearchStatsSampler", () => {
  it("samples at most once per 5 minutes and returns the cached value in between", async () => {
    let t = 1_000_000;
    const stats = vi.fn(async () => ({ stale: 3, unembedded: 7 }));
    const sample = createSearchStatsSampler({ stats, log: log(), now: () => t });
    expect(await sample()).toEqual({ stale: 3, unembedded: 7 });
    t += 299_000;
    expect(await sample()).toEqual({ stale: 3, unembedded: 7 });
    expect(stats).toHaveBeenCalledTimes(1);
    t += 2_000; // 301 s after the first
    stats.mockResolvedValue({ stale: 0, unembedded: 1 });
    expect(await sample()).toEqual({ stale: 0, unembedded: 1 });
    expect(stats).toHaveBeenCalledTimes(2);
  });

  it("honours a custom interval", async () => {
    let t = 0;
    const stats = vi.fn(async () => ({ stale: 1, unembedded: 1 }));
    const sample = createSearchStatsSampler({
      stats,
      log: log(),
      minIntervalMs: 1000,
      now: () => t,
    });
    await sample();
    t = 1000;
    await sample();
    expect(stats).toHaveBeenCalledTimes(2);
  });

  it("a failed sample resolves undefined, logs the error category only, and retries after the interval", async () => {
    const l = log();
    let t = 0;
    const stats = vi
      .fn<() => Promise<{ stale: number; unembedded: number }>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("connection to db.internal refused SECRET"), {
          code: "ECONNREFUSED",
        }),
      )
      .mockResolvedValue({ stale: 2, unembedded: 0 });
    const sample = createSearchStatsSampler({ stats, log: l, now: () => t });
    expect(await sample()).toBeUndefined();
    expect(JSON.stringify(l.debug.mock.calls)).not.toContain("SECRET");
    expect(l.debug.mock.calls[0]?.[0]).toEqual({ db: "ECONNREFUSED" });
    // the failure is not retried within the interval...
    t += 10_000;
    expect(await sample()).toBeUndefined();
    expect(stats).toHaveBeenCalledTimes(1);
    // ...and recovers afterwards
    t += 300_000;
    expect(await sample()).toEqual({ stale: 2, unembedded: 0 });
  });

  it("copies only the two counts", async () => {
    const sample = createSearchStatsSampler({
      stats: async () => ({ stale: 1, unembedded: 2, extra: "x" }) as never,
      log: log(),
      now: () => 0,
    });
    expect(await sample()).toEqual({ stale: 1, unembedded: 2 });
  });
});

describe("beatOnce reports search counts in the heartbeat details", () => {
  function deps(over: Partial<HeartbeatDeps> = {}) {
    const query = vi.fn(async () => ({ rows: [] }));
    const d: HeartbeatDeps = {
      db: { query } as never,
      s3: { send: async () => ({}) } as never,
      bucket: "b",
      workerId: "w",
      hostname: "h",
      pid: 1,
      version: "v",
      startedAt: new Date(0),
      ...over,
    } as HeartbeatDeps;
    return { d, query };
  }

  it("adds searchStale and searchUnembedded to the result and the stored details", async () => {
    const { d, query } = deps({ searchStats: async () => ({ stale: 4, unembedded: 9 }) });
    const r = await beatOnce(d);
    expect(r).toMatchObject({ searchStale: 4, searchUnembedded: 9 });
    const details = JSON.parse(
      (query.mock.calls[0] as unknown as [string, unknown[]])[1][5] as string,
    );
    expect(details).toMatchObject({ searchStale: 4, searchUnembedded: 9 });
  });

  it("omits them when the sample failed or no sampler is wired", async () => {
    for (const searchStats of [
      async () => undefined,
      async () => Promise.reject(new Error("x")),
      undefined,
    ]) {
      const { d, query } = deps(searchStats ? { searchStats } : {});
      const r = await beatOnce(d);
      expect(r).not.toHaveProperty("searchStale");
      const details = JSON.parse(
        (query.mock.calls[0] as unknown as [string, unknown[]])[1][5] as string,
      );
      expect(details).not.toHaveProperty("searchStale");
    }
  });
});
