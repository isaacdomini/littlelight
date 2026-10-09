import { describe, expect, it, vi } from "vitest";
import { beatOnce, createAiQueueAgeSampler, type HeartbeatDeps } from "./heartbeat";

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}
const age = (e: number | null, o: number | null) => ({
  oldestEligibleMinutes: e,
  oldestOpenBatchMinutes: o,
});

describe("createAiQueueAgeSampler", () => {
  it("returns the older of the two ages, rounded; 0 when nothing is waiting", async () => {
    const log = logger();
    let t = 0;
    const queueAge = vi.fn(async () => age(10.4, 25.6));
    const sample = createAiQueueAgeSampler({ queueAge, alertMinutes: 120, log, now: () => t });
    expect(await sample()).toBe(26);
    queueAge.mockResolvedValue(age(null, null));
    t += 61_000;
    expect(await sample()).toBe(0);
    queueAge.mockResolvedValue(age(7, null));
    t += 61_000;
    expect(await sample()).toBe(7);
  });

  it("queries at most once a minute and returns the cached value in between", async () => {
    const log = logger();
    let t = 1_000_000;
    const queueAge = vi.fn(async () => age(5, null));
    const sample = createAiQueueAgeSampler({ queueAge, alertMinutes: 120, log, now: () => t });
    await sample();
    t += 10_000;
    await sample();
    t += 49_000;
    await sample();
    expect(queueAge).toHaveBeenCalledTimes(1);
    t += 2_000; // 61 s since the first
    await sample();
    expect(queueAge).toHaveBeenCalledTimes(2);
  });

  it("a custom interval is honoured", async () => {
    let t = 0;
    const queueAge = vi.fn(async () => age(1, null));
    const sample = createAiQueueAgeSampler({
      queueAge,
      alertMinutes: 120,
      log: logger(),
      minIntervalMs: 5_000,
      now: () => t,
    });
    await sample();
    t = 5_000;
    await sample();
    expect(queueAge).toHaveBeenCalledTimes(2);
  });

  it("warns once when over the threshold, info once when back under; ages and threshold only", async () => {
    const log = logger();
    let t = 0;
    const queueAge = vi.fn(async () => age(130, null));
    const sample = createAiQueueAgeSampler({ queueAge, alertMinutes: 120, log, now: () => t });
    const next = async (a: ReturnType<typeof age>) => {
      queueAge.mockResolvedValue(a);
      t += 61_000;
      return sample();
    };
    await next(age(130, null));
    await next(age(140, null));
    await next(age(null, 150));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ aiQueueAgeMin: 130, alertMinutes: 120 });
    expect(log.info).not.toHaveBeenCalled();
    await next(age(10, null));
    await next(age(20, null));
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[0]).toMatchObject({ aiQueueAgeMin: 10 });
    // over again later: a new warn
    await next(age(500, null));
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("exactly at the threshold is not over it (alert is 'older than')", async () => {
    const log = logger();
    const sample = createAiQueueAgeSampler({
      queueAge: async () => age(120, null),
      alertMinutes: 120,
      log,
      now: () => 0,
    });
    expect(await sample()).toBe(120);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("a failed sample resolves undefined, logs a category at debug (no message), and recovers a minute later", async () => {
    const log = logger();
    let t = 0;
    const queueAge = vi.fn(async () => {
      throw Object.assign(new Error("connection to db.internal:5432 refused SECRET"), {
        code: "ECONNREFUSED",
      });
    });
    const sample = createAiQueueAgeSampler({
      queueAge: queueAge as never,
      alertMinutes: 120,
      log,
      now: () => t,
    });
    expect(await sample()).toBeUndefined();
    expect(await sample()).toBeUndefined(); // cached failure within the minute
    expect(queueAge).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain("SECRET");
    expect(log.warn).not.toHaveBeenCalled();
    queueAge.mockResolvedValue(age(3, null) as never);
    t += 61_000;
    expect(await sample()).toBe(3);
  });
});

describe("heartbeat details.aiQueueAgeMin", () => {
  function deps(extra: Partial<HeartbeatDeps>) {
    const calls: { text: string; values?: unknown[] }[] = [];
    const d: HeartbeatDeps = {
      db: {
        query: async (text, values) => {
          calls.push({ text, values });
          return { rows: [] };
        },
      },
      s3: { send: (async () => ({})) as never },
      bucket: "b",
      workerId: "w",
      hostname: "h",
      pid: 1,
      version: "0",
      startedAt: new Date(0),
      ...extra,
    };
    return { d, calls };
  }
  const details = (calls: { values?: unknown[] }[]) => JSON.parse(String(calls[0]?.values?.[5]));

  it("reports aiQueueAgeMin when the sampler answers (including 0)", async () => {
    for (const v of [42, 0]) {
      const { d, calls } = deps({ aiQueueAge: async () => v });
      const r = await beatOnce(d);
      expect(r.aiQueueAgeMin).toBe(v);
      expect(details(calls).aiQueueAgeMin).toBe(v);
    }
  });

  it("omits it when AI is disabled, the sample is undefined, or the sampler throws", async () => {
    for (const aiQueueAge of [
      undefined,
      async () => undefined,
      async () => {
        throw new Error("x");
      },
    ]) {
      const { d, calls } = deps(aiQueueAge ? { aiQueueAge } : {});
      const r = await beatOnce(d);
      expect(r.aiQueueAgeMin).toBeUndefined();
      expect(details(calls)).not.toHaveProperty("aiQueueAgeMin");
    }
  });

  it("is reported next to the disk figure and when storage is down", async () => {
    const { d, calls } = deps({
      aiQueueAge: async () => 9,
      diskUsedPct: async () => 50,
      s3: {
        send: (async () => {
          throw new Error("down");
        }) as never,
      },
    });
    await beatOnce(d);
    expect(details(calls)).toMatchObject({
      aiQueueAgeMin: 9,
      diskUsedPct: 50,
      storageError: "error",
    });
  });
});
