import { aiBackfillJobSchema, JOBS } from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import type { AiPipeline } from "./ai";
import {
  AI_FLUSH_SEND_OPTIONS,
  aiBackfillSendOptions,
  handleAiBackfillJob,
  handleAiFlushJob,
  handleAiPollJob,
  QUEUES,
  SCHEDULES,
  schedules,
  sendAiBackfill,
  sendAiFlush,
  startWorkers,
} from "./queues";
import { recordingLog } from "./testing/stubs";

const BABY = "11111111-1111-4111-8111-111111111111";

function indexerStub() {
  return {
    reindex: vi.fn(),
    reconcile: vi.fn(),
    backfill: vi.fn(),
    stats: vi.fn(),
  } as never;
}

function pipeline() {
  const result = {
    claimed: 0,
    budgetSkipped: 0,
    submitted: [],
    dropped: 0,
    unbuildable: 0,
    deferred: 0,
    submitErrors: 0,
  };
  return {
    flush: vi.fn(async () => result),
    backfill: vi.fn(async () => result),
    poll: vi.fn(async () => ({
      polled: 0,
      terminal: 0,
      stored: 0,
      failed: 0,
      reindexSent: 0,
      filesDeleted: 0,
    })),
    queueAge: vi.fn(async () => ({ oldestEligibleMinutes: null, oldestOpenBatchMinutes: null })),
  } satisfies AiPipeline;
}

describe("AI queue definitions (step 6)", () => {
  it("ai.flush and ai.poll are exclusive cron singletons with no retry; expiry just under the flush window", () => {
    for (const name of [JOBS.aiFlush, JOBS.aiPoll]) {
      expect(QUEUES[name]).toEqual({ policy: "exclusive", retryLimit: 0, expireInSeconds: 1700 });
    }
    expect(QUEUES[JOBS.aiFlush].expireInSeconds).toBeLessThan(30 * 60);
  });

  it("ai.backfill retries twice after 60 s, one hour expiry", () => {
    expect(QUEUES[JOBS.aiBackfill]).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      expireInSeconds: 3600,
    });
  });

  it("there are exactly fourteen queues, one per job name", () => {
    expect(Object.keys(QUEUES).sort()).toEqual(Object.values(JOBS).sort());
    expect(Object.keys(QUEUES)).toHaveLength(14);
  });

  it("schedules(config) adds the two AI crons and the search reconcile and the share reconcile to the three fixed ones (7 total)", () => {
    const all = schedules({
      AI_FLUSH_INTERVAL_CRON: "*/10 * * * *",
      AI_POLL_INTERVAL_CRON: "*/2 * * * *",
      SEARCH_RECONCILE_CRON: "5 * * * *",
    });
    expect(all).toHaveLength(7);
    expect(Object.fromEntries(all)[JOBS.searchReconcile]).toBe("5 * * * *");
    expect(Object.fromEntries(all)).toMatchObject({
      [JOBS.aiFlush]: "*/10 * * * *",
      [JOBS.aiPoll]: "*/2 * * * *",
    });
    expect(all.slice(0, 3)).toEqual([...SCHEDULES]);
    expect(SCHEDULES).toHaveLength(3);
    expect(all.map(([n]) => n)).not.toContain(JOBS.aiBackfill); // on demand only
  });
});

describe("send helpers", () => {
  it("aiBackfillSendOptions keys by baby, or 'all'", () => {
    expect(aiBackfillSendOptions({ babyId: BABY })).toEqual({
      singletonKey: BABY,
      retryLimit: 2,
      retryDelay: 60,
      expireInSeconds: 3600,
    });
    expect(aiBackfillSendOptions({}).singletonKey).toBe("all");
  });

  it("sendAiFlush validates, defaults to an empty payload, and uses the queue options", async () => {
    const send = vi.fn(async () => "id");
    await sendAiFlush({ send } as never);
    expect(send).toHaveBeenCalledWith(JOBS.aiFlush, {}, AI_FLUSH_SEND_OPTIONS);
    await sendAiFlush({ send } as never, { force: true, babyId: BABY });
    expect(send).toHaveBeenLastCalledWith(
      JOBS.aiFlush,
      { force: true, babyId: BABY },
      AI_FLUSH_SEND_OPTIONS,
    );
    send.mockClear();
    await expect(sendAiFlush({ send } as never, { force: "yes" } as never)).rejects.toThrow();
    await expect(sendAiFlush({ send } as never, { note: "x" } as never)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("sendAiBackfill validates: an upgrade needs a baby; extra keys are refused", async () => {
    const send = vi.fn(async () => "id");
    await expect(sendAiBackfill({ send } as never, { reason: "upgrade" })).rejects.toThrow();
    await expect(
      sendAiBackfill({ send } as never, { reason: "manual", note: "x" } as never),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await sendAiBackfill({ send } as never, { reason: "upgrade", babyId: BABY });
    expect(send).toHaveBeenCalledWith(
      JOBS.aiBackfill,
      aiBackfillJobSchema.parse({ reason: "upgrade", babyId: BABY }),
      aiBackfillSendOptions({ babyId: BABY }),
    );
  });
});

describe("AI handlers", () => {
  const job = (data: unknown) => ({ id: "job-1", data });

  it("flush passes force and babyId, only when present", async () => {
    const ai = pipeline();
    const log = recordingLog();
    await handleAiFlushJob({ ai, log }, job({ force: true, babyId: BABY }));
    expect(ai.flush).toHaveBeenLastCalledWith({ force: true, babyId: BABY });
    await handleAiFlushJob({ ai, log }, job({}));
    expect(ai.flush).toHaveBeenLastCalledWith({});
    await handleAiFlushJob({ ai, log }, job(undefined));
    expect(ai.flush).toHaveBeenLastCalledWith({});
    await handleAiFlushJob({ ai, log }, job(null as never)).catch(() => undefined);
  });

  it("flush drops a bad payload with one warn (job id only) and never calls the pipeline", async () => {
    const ai = pipeline();
    const log = recordingLog();
    for (const data of [{ force: "yes" }, { note: "x" }, "str", { babyId: "nope" }]) {
      expect(await handleAiFlushJob({ ai, log }, job(data))).toBeNull();
    }
    expect(ai.flush).not.toHaveBeenCalled();
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(4);
    expect(JSON.stringify(log.lines)).not.toContain("nope");
    expect(log.lines[0]?.obj).toEqual({ jobId: "job-1" });
  });

  it("poll accepts no payload and drops one with keys", async () => {
    const ai = pipeline();
    const log = recordingLog();
    await handleAiPollJob({ ai, log }, job(undefined));
    await handleAiPollJob({ ai, log }, job({}));
    expect(ai.poll).toHaveBeenCalledTimes(2);
    expect(await handleAiPollJob({ ai, log }, job({ force: true }))).toBeNull();
    expect(ai.poll).toHaveBeenCalledTimes(2);
  });

  it("backfill passes the parsed job; drops an upgrade without a baby", async () => {
    const ai = pipeline();
    const log = recordingLog();
    await handleAiBackfillJob({ ai, log }, job({ reason: "upgrade", babyId: BABY }));
    expect(ai.backfill).toHaveBeenCalledWith({ reason: "upgrade", babyId: BABY });
    await handleAiBackfillJob({ ai, log }, job({ reason: "version", promptVersion: "v1" }));
    expect(ai.backfill).toHaveBeenLastCalledWith({ reason: "version", promptVersion: "v1" });
    expect(await handleAiBackfillJob({ ai, log }, job({ reason: "upgrade" }))).toBeNull();
    expect(await handleAiBackfillJob({ ai, log }, job(undefined))).toBeNull();
    expect(ai.backfill).toHaveBeenCalledTimes(2);
  });

  it("pipeline errors propagate so pg-boss records the failure", async () => {
    const ai = pipeline();
    ai.flush.mockRejectedValueOnce(new Error("db down"));
    await expect(handleAiFlushJob({ ai, log: recordingLog() }, job({}))).rejects.toThrow("db down");
  });
});

describe("startWorkers registers the AI handlers", () => {
  it("ai.flush, ai.poll and ai.backfill run their handlers per job", async () => {
    const registered = new Map<
      string,
      { options: Record<string, unknown>; handler: (jobs: unknown[]) => Promise<void> }
    >();
    const boss = {
      send: vi.fn(),
      work: vi.fn(async (name: string, options: Record<string, unknown>, handler: never) => {
        registered.set(name, { options, handler });
        return "w";
      }),
    };
    const ai = pipeline();
    const log = recordingLog();
    await startWorkers(boss as never, {
      ingest: {} as never,
      purge: {} as never,
      sweep: {} as never,
      dataExport: {} as never,
      ai,
      indexer: indexerStub(),
      log,
      ingestConcurrency: 1,
    });
    expect([...registered.keys()].sort()).toEqual(Object.values(JOBS).sort());
    await registered.get(JOBS.aiFlush)?.handler([
      { id: "1", data: { force: true } },
      { id: "2", data: {} },
    ]);
    expect(ai.flush).toHaveBeenCalledTimes(2);
    await registered.get(JOBS.aiPoll)?.handler([{ id: "3", data: {} }]);
    expect(ai.poll).toHaveBeenCalledTimes(1);
    await registered.get(JOBS.aiBackfill)?.handler([
      { id: "4", data: { reason: "manual" } },
      { id: "5", data: { reason: "bogus" } },
    ]);
    expect(ai.backfill).toHaveBeenCalledTimes(1);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });
});
