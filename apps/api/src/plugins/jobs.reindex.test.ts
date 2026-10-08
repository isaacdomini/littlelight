import { JOBS } from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import { type BossLike, createJobQueue, enqueueReindexAll, REINDEX_SEND_OPTIONS } from "./jobs";

const PHOTO = "33333333-3333-4333-8333-333333333333";
const BABY = "44444444-4444-4444-8444-444444444444";
const job = { photoId: PHOTO, babyId: BABY, reason: "details" as const };

function fakeBoss(overrides: Partial<BossLike> = {}) {
  const boss: BossLike = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    send: vi.fn(async () => "job-id"),
    on: vi.fn(() => boss),
    ...overrides,
  };
  return boss;
}
const log = () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe("enqueueReindex", () => {
  it("sends photo.reindex with the plan's options and singletonKey = photoId", async () => {
    const boss = fakeBoss();
    const q = createJobQueue({ log: log(), createBoss: () => boss, retryDelayMs: 0 });
    expect(await q.enqueueReindex(job)).toBe(true);
    expect(boss.send).toHaveBeenCalledWith(JOBS.reindex, job, {
      ...REINDEX_SEND_OPTIONS,
      singletonKey: PHOTO,
    });
    expect(REINDEX_SEND_OPTIONS).toEqual({
      retryLimit: 3,
      retryDelay: 15,
      retryBackoff: true,
      expireInSeconds: 300,
    });
  });

  it("retries once, then false with a category-only warning; never throws", async () => {
    const l = log();
    const send = vi.fn().mockRejectedValue(new Error("note: first steps (secret)"));
    const q = createJobQueue({ log: l, createBoss: () => fakeBoss({ send }), retryDelayMs: 0 });
    expect(await q.enqueueReindex(job)).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain("first steps");
  });

  it("succeeds when the second attempt works", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("ok");
    const q = createJobQueue({ log: log(), createBoss: () => fakeBoss({ send }), retryDelayMs: 0 });
    expect(await q.enqueueReindex(job)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("is strict: extra keys (a note), a bad reason or id reject without sending", async () => {
    const boss = fakeBoss();
    const q = createJobQueue({ log: log(), createBoss: () => boss });
    await expect(q.enqueueReindex({ ...job, note: "x" } as never)).rejects.toThrow();
    await expect(q.enqueueReindex({ ...job, reason: "nope" } as never)).rejects.toThrow();
    await expect(q.enqueueReindex({ ...job, photoId: "p" })).rejects.toThrow();
    expect(boss.send).not.toHaveBeenCalled();
  });
});

describe("enqueueReindexAll", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({
    ...job,
    photoId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  }));

  it("bounds the number of sends in flight and counts accepted ones", async () => {
    let inFlight = 0;
    let peak = 0;
    const enqueueReindex = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return true;
    });
    expect(await enqueueReindexAll({ enqueueReindex }, items, 4)).toBe(25);
    expect(enqueueReindex).toHaveBeenCalledTimes(25);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("counts only accepted sends and handles empty input", async () => {
    let n = 0;
    const enqueueReindex = vi.fn(async () => n++ % 2 === 0);
    expect(await enqueueReindexAll({ enqueueReindex }, items)).toBe(13);
    expect(await enqueueReindexAll({ enqueueReindex }, [])).toBe(0);
  });

  it("each item is sent exactly once", async () => {
    const seen: string[] = [];
    await enqueueReindexAll(
      {
        enqueueReindex: async (j) => {
          seen.push(j.photoId);
          return true;
        },
      },
      items,
      3,
    );
    expect(seen.sort()).toEqual(items.map((i) => i.photoId).sort());
  });
});
