import { JOBS } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import { type BossLike, createJobQueue, INGEST_SEND_OPTIONS } from "./jobs";

const PHOTO = "33333333-3333-4333-8333-333333333333";
const BABY = "44444444-4444-4444-8444-444444444444";
const job = { photoId: PHOTO, babyId: BABY, uploadFileId: PHOTO };

function fakeBoss(overrides: Partial<BossLike> = {}) {
  const events: string[] = [];
  const boss: BossLike & { events: string[] } = {
    events,
    start: vi.fn(async () => {
      events.push("start");
    }),
    stop: vi.fn(async () => {
      events.push("stop");
    }),
    send: vi.fn(async () => "job-id"),
    on: vi.fn(() => boss),
    ...overrides,
  };
  return boss;
}
const log = () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe("job queue (send-only pg-boss)", () => {
  it("starts lazily on the first send, once, and sends photo.ingest with the plan's options", async () => {
    const boss = fakeBoss();
    const createBoss = vi.fn(() => boss);
    const q = createJobQueue({ log: log(), createBoss, retryDelayMs: 0 });
    expect(createBoss).not.toHaveBeenCalled(); // boot does not touch pg-boss
    expect(await q.enqueueIngest(job)).toBe(true);
    expect(await q.enqueueIngest({ ...job, photoId: BABY })).toBe(true);
    expect(createBoss).toHaveBeenCalledTimes(1);
    expect(boss.start).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenNthCalledWith(1, JOBS.ingest, job, {
      ...INGEST_SEND_OPTIONS,
      singletonKey: PHOTO,
    });
    expect(INGEST_SEND_OPTIONS).toMatchObject({ retryLimit: 3, retryBackoff: true });
  });

  it("registers error/warning listeners before start so a pg-boss error cannot crash the process", async () => {
    const boss = fakeBoss();
    const q = createJobQueue({ log: log(), createBoss: () => boss });
    await q.enqueueIngest(job);
    const events = (boss.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toEqual(["error", "warning"]);
    expect((boss.on as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (boss.start as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] as number,
    );
  });

  it("rejects an invalid payload (strict schema: extra keys, bad ids) without sending", async () => {
    const boss = fakeBoss();
    const q = createJobQueue({ log: log(), createBoss: () => boss });
    await expect(q.enqueueIngest({ ...job, photoId: "nope" })).rejects.toThrow();
    await expect(q.enqueueIngest({ ...job, note: "parent note" } as never)).rejects.toThrow();
    await expect(q.enqueueIngest({ ...job, tzHint: "Not/AZone" } as never)).rejects.toThrow();
    expect(boss.send).not.toHaveBeenCalled();
    expect(boss.start).not.toHaveBeenCalled();
  });

  it("retries exactly once, then returns false and logs the category only", async () => {
    const l = log();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("relation pgboss.job does not exist (secret)"))
      .mockResolvedValueOnce("ok");
    const q = createJobQueue({ log: l, createBoss: () => fakeBoss({ send }), retryDelayMs: 0 });
    expect(await q.enqueueIngest(job)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(l.warn).not.toHaveBeenCalled();

    const l2 = log();
    const failing = vi.fn().mockRejectedValue(new Error("boom with photo bytes"));
    const q2 = createJobQueue({
      log: l2,
      createBoss: () => fakeBoss({ send: failing }),
      retryDelayMs: 0,
    });
    expect(await q2.enqueueIngest(job)).toBe(false);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(l2.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(l2.warn.mock.calls)).not.toContain("photo bytes");
  });

  it("never throws for a start failure; stops the half-started instance and retries a fresh one", async () => {
    const boss1 = fakeBoss({ start: vi.fn().mockRejectedValue(new Error("no db")) });
    const boss2 = fakeBoss();
    const boxes = [boss1, boss2];
    const q = createJobQueue({
      log: log(),
      createBoss: () => boxes.shift() as BossLike,
      retryDelayMs: 0,
    });
    expect(await q.enqueueIngest(job)).toBe(true);
    expect(boss1.stop).toHaveBeenCalled();
    expect(boss2.send).toHaveBeenCalledTimes(1);
  });

  it("concurrent first sends share one start", async () => {
    const boss = fakeBoss();
    const createBoss = vi.fn(() => boss);
    const q = createJobQueue({ log: log(), createBoss });
    await Promise.all([1, 2, 3].map(() => q.enqueueIngest(job)));
    expect(createBoss).toHaveBeenCalledTimes(1);
    expect(boss.start).toHaveBeenCalledTimes(1);
  });

  it("close() stops a started instance gracefully, does nothing when never started, and blocks later sends", async () => {
    const idle = fakeBoss();
    const q0 = createJobQueue({ log: log(), createBoss: () => idle });
    await q0.close();
    expect(idle.stop).not.toHaveBeenCalled();

    const boss = fakeBoss();
    const q = createJobQueue({ log: log(), createBoss: () => boss });
    await q.enqueueIngest(job);
    await q.close();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 5000 });
    expect(await q.enqueueIngest(job)).toBe(false);
  });
});
