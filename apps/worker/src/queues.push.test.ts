import { JOBS, PUSH_MIN_GAP_MIN_DEFAULT, PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import type { PushSender } from "./push";
import {
  handlePushJob,
  PUSH_NOTIFY_SEND_OPTIONS,
  pushNotifySendOptions,
  QUEUES,
  sendPushNotify,
  startWorkers,
} from "./queues";
import { memoryStorage, recordingLog, scriptedPool } from "./testing/stubs";

// Step 9 push queue config (docs/plans/step-9.md 2.8, 2.15): the `short` push.notify queue, the
// send helpers with singleton keys and debounce, and the worker registration.

const BABY = "11111111-1111-4111-8111-111111111111";
const LINK = "22222222-2222-4222-8222-222222222222";
const photos = { kind: "photos_analyzed" as const, babyId: BABY };
const share = { kind: "share_viewed" as const, shareLinkId: LINK };

describe("push.notify queue definition", () => {
  it("is the one short queue: 2 retries after 30 s, 5 minute expiry", () => {
    expect(QUEUES[JOBS.pushNotify]).toEqual({
      policy: "short",
      retryLimit: 2,
      retryDelay: 30,
      expireInSeconds: 300,
    });
    const others = Object.entries(QUEUES).filter(([name]) => name !== JOBS.pushNotify);
    expect(others).toHaveLength(15);
    expect(others.every(([, q]) => q.policy === "exclusive")).toBe(true);
  });

  it("send options match the api's (retries 2, expiry 300) with the key and debounce added per job", () => {
    expect(PUSH_NOTIFY_SEND_OPTIONS).toEqual({ retryLimit: 2, expireInSeconds: 300 });
    expect(pushNotifySendOptions(photos, 600)).toEqual({
      retryLimit: 2,
      expireInSeconds: 300,
      singletonKey: `photos_analyzed:${BABY}`,
      startAfter: 600,
    });
    expect(pushNotifySendOptions(share, 0)).toEqual({
      retryLimit: 2,
      expireInSeconds: 300,
      singletonKey: `share_viewed:${LINK}`,
    });
  });
});

describe("sendPushNotify", () => {
  it("validates strictly before sending, then sends with the singleton key and startAfter", async () => {
    const send = vi.fn(async () => "id-1");
    await expect(sendPushNotify({ send } as never, { kind: "chat" } as never, 5)).rejects.toThrow();
    await expect(
      sendPushNotify({ send } as never, { ...photos, count: 3 } as never, 5),
    ).rejects.toThrow();
    await expect(
      sendPushNotify({ send } as never, { kind: "share_viewed", babyId: BABY } as never, 5),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(await sendPushNotify({ send } as never, photos, 90)).toBe("id-1");
    expect(send).toHaveBeenCalledWith(JOBS.pushNotify, photos, pushNotifySendOptions(photos, 90));
  });

  it("passes null through when pg-boss coalesced it (a job with that key is already queued)", async () => {
    const send = vi.fn(async () => null);
    expect(await sendPushNotify({ send } as never, share, 60)).toBeNull();
  });
});

describe("handlePushJob", () => {
  const pool = () => scriptedPool({}) as never;
  const sender: PushSender = {
    mode: "none",
    send: vi.fn(async () => "unconfigured" as const),
    close: async () => undefined,
  };

  it("drops a malformed payload by job id, touching nothing", async () => {
    const log = recordingLog();
    const boss = { send: vi.fn() };
    const out = await handlePushJob(
      { pool: pool(), push: { sender, minGapMin: 60, photosDebounceSec: 600 }, log },
      boss as never,
      { id: "job-9", data: { kind: "photos_analyzed" } } as never,
    );
    expect(out).toBeNull();
    expect(boss.send).not.toHaveBeenCalled();
    expect(log.lines.filter((l) => l.level === "warn")[0]?.obj).toEqual({ jobId: "job-9" });
  });
});

describe("startWorkers: push.notify", () => {
  const registered = new Map<
    string,
    { options: Record<string, unknown>; handler: (jobs: unknown[]) => Promise<void> }
  >();

  async function start(extra: Record<string, unknown> = {}) {
    registered.clear();
    const boss = {
      send: vi.fn(async () => "queued"),
      work: vi.fn(async (name: string, options: Record<string, unknown>, handler: never) => {
        registered.set(name, { options, handler });
        return "w";
      }),
    };
    await startWorkers(boss as never, {
      ingest: {
        pool: scriptedPool(),
        storage: memoryStorage(),
        matcher: { name: "none", check: async () => ({ matched: false }) },
        dataKey: "k",
        log: recordingLog(),
      } as never,
      purge: {} as never,
      sweep: {} as never,
      dataExport: {} as never,
      ai: { flush: vi.fn(), poll: vi.fn(), backfill: vi.fn() } as never,
      indexer: {
        reindex: vi.fn(async () => ({ indexed: 0 })),
        reconcile: vi.fn(),
        backfill: vi.fn(),
      } as never,
      autoSharer: { evaluatePhotos: vi.fn(), applyLink: vi.fn(), reconcile: vi.fn() } as never,
      log: recordingLog(),
      ingestConcurrency: 1,
      ...extra,
    });
    return boss;
  }

  it("registers push.notify one job at a time with metadata (createdOn) and a 5 s poll", async () => {
    await start();
    expect(registered.get(JOBS.pushNotify)?.options).toEqual({
      pollingIntervalSeconds: 5,
      batchSize: 1,
      includeMetadata: true,
    });
  });

  it("without deps.push the handler runs with a none sender: nothing is sent and invalid jobs are dropped", async () => {
    await start();
    await registered.get(JOBS.pushNotify)?.handler([{ id: "j", data: { nope: true } }]);
  });

  it("the reindex hook enqueues photos_analyzed with the configured photos debounce", async () => {
    const handlers = new Map<string, import("./testing/stubs").Handler>();
    const orig = handlers.get.bind(handlers);
    handlers.get = (sql: string) =>
      sql.includes("baby_ai_enabled") ? () => ({ rows: [{ baby_id: BABY }] }) : orig(sql);
    const sender: PushSender = {
      mode: "fake",
      send: vi.fn(async () => "fake" as const),
      close: async () => undefined,
    };
    const boss = await start({
      push: { sender, minGapMin: 5, photosDebounceSec: 7 },
      ingest: {
        pool: scriptedPool(handlers),
        storage: memoryStorage(),
        matcher: { name: "none", check: async () => ({ matched: false }) },
        dataKey: "k",
        log: recordingLog(),
      },
    });
    const photo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await registered
      .get(JOBS.reindex)
      ?.handler([{ id: "r1", data: { photoId: photo, babyId: BABY, reason: "ai" } }]);
    expect(boss.send).toHaveBeenCalledWith(
      JOBS.pushNotify,
      photos,
      pushNotifySendOptions(photos, 7),
    );
  });

  it("the default gap and debounce are 60 min and 600 s", () => {
    expect(PUSH_MIN_GAP_MIN_DEFAULT).toBe(60);
    expect(PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT).toBe(600);
  });
});
