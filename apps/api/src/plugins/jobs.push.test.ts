import {
  JOBS,
  PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
  PUSH_SHARE_DEBOUNCE_SEC_DEFAULT,
} from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type BossLike,
  createJobQueue,
  PUSH_DEBOUNCE_DEFAULTS,
  PUSH_SEND_OPTIONS,
  pushSendOptions,
  withAllSenders,
} from "./jobs";

const LINK = "55555555-5555-4555-8555-555555555555";
const BABY = "44444444-4444-4444-8444-444444444444";
const share = { kind: "share_viewed" as const, shareLinkId: LINK };
const photos = { kind: "photos_analyzed" as const, babyId: BABY };

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

describe("enqueuePush", () => {
  it("sends push.notify with a kind:id singleton key, retries 2, 5 min expiry and the share debounce", async () => {
    const boss = fakeBoss();
    const q = createJobQueue({ log: log(), createBoss: () => boss, retryDelayMs: 0 });
    expect(await q.enqueuePush(share)).toBe(true);
    expect(boss.send).toHaveBeenCalledWith(JOBS.pushNotify, share, {
      retryLimit: 2,
      expireInSeconds: 300,
      startAfter: PUSH_SHARE_DEBOUNCE_SEC_DEFAULT,
      singletonKey: `share_viewed:${LINK}`,
    });
  });

  it("uses the photos debounce for photos_analyzed", async () => {
    const boss = fakeBoss();
    const q = createJobQueue({ log: log(), createBoss: () => boss, retryDelayMs: 0 });
    await q.enqueuePush(photos);
    expect(boss.send).toHaveBeenCalledWith(
      JOBS.pushNotify,
      photos,
      expect.objectContaining({
        startAfter: PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
        singletonKey: `photos_analyzed:${BABY}`,
      }),
    );
  });

  it("a configured debounce of 0 omits startAfter (the gate and tests send immediately)", async () => {
    const boss = fakeBoss();
    const q = createJobQueue({
      log: log(),
      createBoss: () => boss,
      retryDelayMs: 0,
      pushDebounce: { photosAnalyzedSec: 0, shareViewedSec: 0 },
    });
    await q.enqueuePush(share);
    const opts = (boss.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
    expect(opts).not.toHaveProperty("startAfter");
    expect(opts).toMatchObject({ singletonKey: `share_viewed:${LINK}` });
  });

  it("honours custom debounce values per kind", async () => {
    const boss = fakeBoss();
    const q = createJobQueue({
      log: log(),
      createBoss: () => boss,
      retryDelayMs: 0,
      pushDebounce: { photosAnalyzedSec: 11, shareViewedSec: 22 },
    });
    await q.enqueuePush(share);
    await q.enqueuePush(photos);
    const calls = (boss.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[2]).toMatchObject({ startAfter: 22 });
    expect(calls[1]?.[2]).toMatchObject({ startAfter: 11 });
  });

  it("is strict: extra keys, wrong ids and unknown kinds throw without sending", async () => {
    const boss = fakeBoss();
    const q = createJobQueue({ log: log(), createBoss: () => boss });
    await expect(q.enqueuePush({ ...share, token: "abc" } as never)).rejects.toThrow();
    await expect(q.enqueuePush({ ...photos, count: 3 } as never)).rejects.toThrow();
    await expect(q.enqueuePush({ kind: "share_viewed", babyId: BABY } as never)).rejects.toThrow();
    await expect(
      q.enqueuePush({ kind: "photos_analyzed", babyId: "nope" } as never),
    ).rejects.toThrow();
    await expect(q.enqueuePush({ kind: "chat", babyId: BABY } as never)).rejects.toThrow();
    expect(boss.send).not.toHaveBeenCalled();
    expect(boss.start).not.toHaveBeenCalled();
  });

  it("retries once, then resolves false with a category-only warning; never throws for transport errors", async () => {
    const l = log();
    const send = vi.fn().mockRejectedValue(new Error("tok-secret device token in message"));
    const q = createJobQueue({ log: l, createBoss: () => fakeBoss({ send }), retryDelayMs: 0 });
    expect(await q.enqueuePush(share)).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain("tok-secret");
  });

  it("succeeds when the second attempt works", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("ok");
    const q = createJobQueue({ log: log(), createBoss: () => fakeBoss({ send }), retryDelayMs: 0 });
    expect(await q.enqueuePush(share)).toBe(true);
  });
});

describe("push send options", () => {
  it("constants", () => {
    expect(PUSH_SEND_OPTIONS).toEqual({ retryLimit: 2, expireInSeconds: 300 });
    expect(PUSH_DEBOUNCE_DEFAULTS).toEqual({ photosAnalyzedSec: 600, shareViewedSec: 60 });
  });

  it("pushSendOptions picks the debounce by kind", () => {
    const d = { photosAnalyzedSec: 5, shareViewedSec: 9 };
    expect(pushSendOptions(share, d)).toEqual({ ...PUSH_SEND_OPTIONS, startAfter: 9 });
    expect(pushSendOptions(photos, d)).toEqual({ ...PUSH_SEND_OPTIONS, startAfter: 5 });
    expect(pushSendOptions(photos, { photosAnalyzedSec: 0, shareViewedSec: 0 })).toEqual(
      PUSH_SEND_OPTIONS,
    );
  });
});

describe("withAllSenders (job-queue stubs without a push sender)", () => {
  it("adds a validating no-op enqueuePush that resolves false and logs the job name only", async () => {
    const warn = vi.fn();
    const stub = {
      enqueueIngest: vi.fn(async () => true),
      enqueueReindex: vi.fn(async () => true),
      enqueueShareApply: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    const jobs = withAllSenders(stub, { warn } as never);
    expect(await jobs.enqueuePush(share)).toBe(false);
    expect(warn).toHaveBeenCalledWith({ job: JOBS.pushNotify }, expect.any(String));
    await expect(jobs.enqueuePush({ ...share, extra: 1 } as never)).rejects.toThrow();
  });

  it("returns the queue untouched when every sender is present", () => {
    const full = {
      enqueueIngest: vi.fn(),
      enqueueReindex: vi.fn(),
      enqueueShareApply: vi.fn(),
      enqueuePush: vi.fn(),
      close: vi.fn(),
    };
    expect(withAllSenders(full as never, { warn: vi.fn() } as never)).toBe(full);
  });
});
