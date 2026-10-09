import { JOBS, searchBackfillJobSchema } from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import type { ReconcileResult } from "./ai";
import {
  chainSearchBackfill,
  handleAiBackfillJob,
  handleSearchBackfillJob,
  handleSearchReconcileJob,
  QUEUES,
  REINDEX_BATCH_SIZE,
  REINDEX_CONCURRENCY,
  SCHEDULES,
  SEARCH_RECONCILE_SEND_OPTIONS,
  schedules,
  searchBackfillSendOptions,
  sendSearchBackfill,
  startWorkers,
} from "./queues";
import { recordingLog } from "./testing/stubs";

const BABY = "11111111-1111-4111-8111-111111111111";
const job = (data: unknown) => ({ id: "job-1", data });
const result: ReconcileResult = {
  rounds: 1,
  reindexed: 0,
  orphansDeleted: 0,
  written: 0,
  embedded: 0,
  costUsd: 0,
};

function indexer() {
  return {
    reindex: vi.fn(),
    reconcile: vi.fn(async () => result),
    backfill: vi.fn(async () => result),
    stats: vi.fn(),
  };
}
const pipeline = () => ({
  flush: vi.fn(),
  poll: vi.fn(),
  backfill: vi.fn(async () => ({ claimed: 0 }) as never),
  queueAge: vi.fn(),
});

describe("search queue definitions (step 7)", () => {
  it("there are twelve queues, all exclusive", () => {
    expect(Object.keys(QUEUES)).toHaveLength(12);
    for (const q of Object.values(QUEUES)) expect(q.policy).toBe("exclusive");
  });

  it("search.reconcile: a cron singleton with no retry (the next tick is the retry)", () => {
    expect(QUEUES[JOBS.searchReconcile]).toEqual({
      policy: "exclusive",
      retryLimit: 0,
      expireInSeconds: 3000,
    });
    expect(SEARCH_RECONCILE_SEND_OPTIONS).toEqual({ retryLimit: 0, expireInSeconds: 3000 });
  });

  it("search.backfill: two retries after 60 s, two hours to run", () => {
    expect(QUEUES[JOBS.searchBackfill]).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      expireInSeconds: 7200,
    });
  });

  it("the reconcile cron comes from config and is scheduled in addition to the six others", () => {
    const all = schedules({
      AI_FLUSH_INTERVAL_CRON: "*/5 * * * *",
      AI_POLL_INTERVAL_CRON: "*/5 * * * *",
      SEARCH_RECONCILE_CRON: "31 * * * *",
    });
    expect(all).toHaveLength(7);
    expect(Object.fromEntries(all)[JOBS.searchReconcile]).toBe("31 * * * *");
    expect(Object.fromEntries(all)[JOBS.searchBackfill]).toBeUndefined(); // on demand only
    expect(SCHEDULES).toHaveLength(3);
  });

  it("without a configured cron the shared default is used", () => {
    const all = schedules({ AI_FLUSH_INTERVAL_CRON: "a", AI_POLL_INTERVAL_CRON: "b" });
    expect(Object.fromEntries(all)[JOBS.searchReconcile]).toBe("17 * * * *");
  });

  it("photo.reindex runs batches of 25 with two handlers", () => {
    expect(REINDEX_BATCH_SIZE).toBe(25);
    expect(REINDEX_CONCURRENCY).toBe(2);
  });
});

describe("sendSearchBackfill", () => {
  it("keys the job by baby (or 'all') with the queue's retry settings", () => {
    expect(searchBackfillSendOptions({ babyId: BABY })).toEqual({
      singletonKey: BABY,
      retryLimit: 2,
      retryDelay: 60,
      expireInSeconds: 7200,
    });
    expect(searchBackfillSendOptions({}).singletonKey).toBe("all");
  });

  it("validates strictly before sending: an upgrade needs a baby, unknown keys are refused", async () => {
    const send = vi.fn(async () => "id");
    await expect(sendSearchBackfill({ send } as never, { reason: "upgrade" })).rejects.toThrow();
    await expect(
      sendSearchBackfill({ send } as never, { reason: "manual", note: "x" } as never),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await sendSearchBackfill({ send } as never, { reason: "upgrade", babyId: BABY });
    expect(send).toHaveBeenCalledWith(
      JOBS.searchBackfill,
      searchBackfillJobSchema.parse({ reason: "upgrade", babyId: BABY }),
      searchBackfillSendOptions({ babyId: BABY }),
    );
  });
});

describe("search handlers", () => {
  it("search.reconcile accepts no payload or {} and drops anything else with one warn (job id only)", async () => {
    const ix = indexer();
    const log = recordingLog();
    await handleSearchReconcileJob({ indexer: ix, log }, job(undefined));
    await handleSearchReconcileJob({ indexer: ix, log }, job({}));
    expect(ix.reconcile).toHaveBeenCalledTimes(2);
    expect(await handleSearchReconcileJob({ indexer: ix, log }, job({ babyId: BABY }))).toBeNull();
    expect(ix.reconcile).toHaveBeenCalledTimes(2);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(log.lines[0]?.obj).toEqual({ jobId: "job-1" });
  });

  it("search.backfill passes the parsed job; bad payloads are dropped without touching the indexer", async () => {
    const ix = indexer();
    const log = recordingLog();
    await handleSearchBackfillJob({ indexer: ix, log }, job({ reason: "upgrade", babyId: BABY }));
    expect(ix.backfill).toHaveBeenCalledWith({ reason: "upgrade", babyId: BABY });
    await handleSearchBackfillJob({ indexer: ix, log }, job({ reason: "model" }));
    expect(ix.backfill).toHaveBeenLastCalledWith({ reason: "model" });
    for (const data of [
      { reason: "upgrade" },
      undefined,
      null,
      { reason: "x" },
      { reason: "manual", note: "n" },
    ]) {
      expect(await handleSearchBackfillJob({ indexer: ix, log }, job(data))).toBeNull();
    }
    expect(ix.backfill).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.lines)).not.toContain('"note"');
  });

  it("indexer errors propagate so pg-boss records the failure", async () => {
    const ix = indexer();
    ix.reconcile.mockRejectedValueOnce(new Error("db down"));
    await expect(
      handleSearchReconcileJob({ indexer: ix, log: recordingLog() }, job({})),
    ).rejects.toThrow("db down");
  });
});

describe("the ai.backfill upgrade chain", () => {
  it("an upgrade backfill sends search.backfill {babyId, reason: upgrade} after it completed", async () => {
    const order: string[] = [];
    const ai = pipeline();
    ai.backfill.mockImplementation(async () => {
      order.push("ai.backfill");
      return {} as never;
    });
    const sendSb = vi.fn(async () => {
      order.push("search.backfill");
      return "sb-1";
    });
    const log = recordingLog();
    await handleAiBackfillJob(
      { ai, log, sendSearchBackfill: sendSb },
      job({ reason: "upgrade", babyId: BABY }),
    );
    expect(sendSb).toHaveBeenCalledWith({ babyId: BABY, reason: "upgrade" });
    expect(order).toEqual(["ai.backfill", "search.backfill"]);
    expect(log.lines.some((l) => l.msg.includes("search.backfill sent"))).toBe(true);
  });

  it("manual and version backfills do not chain; neither does a dropped payload or a failed AI backfill", async () => {
    const sendSb = vi.fn(async () => "x");
    const ai = pipeline();
    const log = recordingLog();
    await handleAiBackfillJob({ ai, log, sendSearchBackfill: sendSb }, job({ reason: "manual" }));
    await handleAiBackfillJob({ ai, log, sendSearchBackfill: sendSb }, job({ reason: "version" }));
    await handleAiBackfillJob({ ai, log, sendSearchBackfill: sendSb }, job({ reason: "upgrade" })); // invalid
    expect(sendSb).not.toHaveBeenCalled();
    ai.backfill.mockRejectedValueOnce(new Error("boom"));
    await expect(
      handleAiBackfillJob(
        { ai, log, sendSearchBackfill: sendSb },
        job({ reason: "upgrade", babyId: BABY }),
      ),
    ).rejects.toThrow("boom");
    expect(sendSb).not.toHaveBeenCalled();
  });

  it("a failed send is tolerated: the AI backfill still succeeds, one warn names a category only", async () => {
    const ai = pipeline();
    const log = recordingLog();
    const sendSb = vi.fn(async () => {
      throw Object.assign(new Error("pg-boss down SECRET-CONN-STRING"), { code: "ECONNREFUSED" });
    });
    await expect(
      handleAiBackfillJob(
        { ai, log, sendSearchBackfill: sendSb },
        job({ reason: "upgrade", babyId: BABY }),
      ),
    ).resolves.toBeDefined();
    const warns = log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.obj).toMatchObject({ babyId: BABY, err: "ECONNREFUSED" });
    expect(JSON.stringify(log.lines)).not.toContain("SECRET");
  });

  it("chainSearchBackfill never throws and returns the job id, or null", async () => {
    const log = recordingLog();
    expect(
      await chainSearchBackfill(
        { log, sendSearchBackfill: async () => "id-7" },
        { reason: "upgrade", babyId: BABY },
      ),
    ).toBe("id-7");
    expect(
      await chainSearchBackfill(
        { log, sendSearchBackfill: async () => null },
        { reason: "upgrade", babyId: BABY },
      ),
    ).toBeNull();
    expect(await chainSearchBackfill({ log }, { reason: "upgrade", babyId: BABY })).toBeNull();
    expect(
      await chainSearchBackfill(
        { log, sendSearchBackfill: async () => "x" },
        { reason: "upgrade" },
      ),
    ).toBeNull();
    expect(
      await chainSearchBackfill(
        {
          log,
          sendSearchBackfill: async () => {
            throw "weird";
          },
        },
        { reason: "upgrade", babyId: BABY },
      ),
    ).toBeNull();
  });
});

describe("startWorkers: the search handlers", () => {
  it("registers search.reconcile and search.backfill; startWorkers wires the chain with its own send", async () => {
    const registered = new Map<
      string,
      { options: Record<string, unknown>; handler: (jobs: unknown[]) => Promise<void> }
    >();
    const send = vi.fn(async () => "queued");
    const boss = {
      send,
      work: vi.fn(async (name: string, options: Record<string, unknown>, handler: never) => {
        registered.set(name, { options, handler });
        return "w";
      }),
    };
    const ix = indexer();
    const ai = pipeline();
    const log = recordingLog();
    await startWorkers(boss as never, {
      ingest: {} as never,
      purge: {} as never,
      sweep: {} as never,
      ai,
      indexer: ix as never,
      log,
      ingestConcurrency: 1,
    });
    expect(registered.size).toBe(12);
    await registered.get(JOBS.searchReconcile)?.handler([job({}), job({ bad: 1 })]);
    expect(ix.reconcile).toHaveBeenCalledTimes(1);
    await registered.get(JOBS.searchBackfill)?.handler([job({ reason: "manual", babyId: BABY })]);
    expect(ix.backfill).toHaveBeenCalledWith({ reason: "manual", babyId: BABY });

    // the upgrade chain sends through the same boss with the keyed options
    await registered.get(JOBS.aiBackfill)?.handler([job({ reason: "upgrade", babyId: BABY })]);
    expect(send).toHaveBeenCalledWith(
      JOBS.searchBackfill,
      { reason: "upgrade", babyId: BABY },
      searchBackfillSendOptions({ babyId: BABY }),
    );
  });
});
