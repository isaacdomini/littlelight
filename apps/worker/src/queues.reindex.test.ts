import { JOBS, reindexJobSchema } from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import {
  QUEUES,
  REINDEX_BATCH_SIZE,
  REINDEX_CONCURRENCY,
  reindexSendOptions,
  SCHEDULES,
  sendReindex,
  startWorkers,
} from "./queues";
import { memoryStorage, recordingLog, scriptedPool } from "./testing/stubs";

const PHOTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BABY = "11111111-1111-4111-8111-111111111111";
const job = { photoId: PHOTO, babyId: BABY, reason: "milestone" as const };

describe("reindex queue (step 5) in the twelve-queue set", () => {
  it("QUEUES has exactly the twelve jobs, all exclusive", () => {
    expect(Object.keys(QUEUES).sort()).toEqual(
      [
        "photo.ingest",
        "ingest.reconcile",
        "purge.trash",
        "uploads.sweep",
        "photo.reindex",
        "ai.flush",
        "ai.poll",
        "ai.backfill",
        "search.reconcile",
        "search.backfill",
        "share.apply",
        "share.reconcile",
      ].sort(),
    );
    for (const q of Object.values(QUEUES)) expect(q.policy).toBe("exclusive");
  });

  it("photo.reindex: 3 retries, 15 s delay, backoff, 5 minute expiry, no notify", () => {
    expect(QUEUES[JOBS.reindex]).toEqual({
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 15,
      retryBackoff: true,
      expireInSeconds: 300,
    });
  });

  it("reindex is not scheduled (only the three fixed crons are; AI and search crons come from config)", () => {
    expect(SCHEDULES.map(([n]) => n)).not.toContain(JOBS.reindex);
    expect(SCHEDULES).toHaveLength(3);
  });

  it("reindexSendOptions keys the job by photo id with the queue's retry settings", () => {
    expect(reindexSendOptions(PHOTO)).toEqual({
      singletonKey: PHOTO,
      retryLimit: 3,
      retryDelay: 15,
      retryBackoff: true,
      expireInSeconds: 300,
    });
  });

  it("sendReindex validates (strict) before sending", async () => {
    const send = vi.fn(async () => "id");
    await expect(sendReindex({ send } as never, { photoId: "x" } as never)).rejects.toThrow();
    await expect(sendReindex({ send } as never, { ...job, note: "x" } as never)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await sendReindex({ send } as never, job);
    expect(send).toHaveBeenCalledWith(
      JOBS.reindex,
      reindexJobSchema.parse(job),
      reindexSendOptions(PHOTO),
    );
  });

  it("startWorkers registers twelve handlers; reindex runs batches of 25 through one indexer call", async () => {
    const registered: Array<{
      name: string;
      options: Record<string, unknown>;
      handler: (jobs: unknown[]) => Promise<void>;
    }> = [];
    const boss = {
      send: vi.fn(),
      work: vi.fn(async (name: string, options: Record<string, unknown>, handler: never) => {
        registered.push({ name, options, handler });
        return "w";
      }),
    };
    const pool = scriptedPool();
    const log = recordingLog();
    const reindex = vi.fn(async () => ({}));
    await startWorkers(boss as never, {
      ingest: {
        pool,
        storage: memoryStorage(),
        matcher: { name: "none", check: async () => ({ matched: false }) },
        dataKey: "k",
        log,
      } as never,
      purge: {} as never,
      sweep: {} as never,
      ai: { flush: vi.fn(), poll: vi.fn(), backfill: vi.fn() } as never,
      indexer: { reindex } as never,
      autoSharer: {
        evaluatePhotos: vi.fn(async () => ({})),
        applyLink: vi.fn(),
        reconcile: vi.fn(),
      } as never,
      log,
      ingestConcurrency: 2,
    });
    expect(registered.map((r) => r.name).sort()).toEqual(Object.values(JOBS).sort());
    const worker = registered.find((r) => r.name === JOBS.reindex);
    expect(worker?.options).toMatchObject({
      localConcurrency: REINDEX_CONCURRENCY,
      batchSize: REINDEX_BATCH_SIZE,
      pollingIntervalSeconds: 2,
    });
    expect(REINDEX_CONCURRENCY).toBe(2);
    expect(REINDEX_BATCH_SIZE).toBe(25);
    await worker?.handler([
      { id: "1", data: { photoId: PHOTO, babyId: BABY, reason: "details" } },
      { id: "2", data: { bad: true } },
    ]);
    expect(reindex).toHaveBeenCalledTimes(1);
    expect(reindex).toHaveBeenCalledWith([PHOTO], "details");
    expect(pool.log).toEqual([]);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });
});
