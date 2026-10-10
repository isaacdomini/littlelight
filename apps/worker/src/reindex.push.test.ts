import type { PushNotifyJob } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import { enqueuePhotosAnalyzed, handleReindexJobs } from "./reindex";
import { type Handler, recordingLog, scriptedPool } from "./testing/stubs";

// The photos_analyzed push hook of the reindex handler (docs/plans/step-9.md 2.8, 2.15).

const PHOTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHOTO2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BABY = "11111111-1111-4111-8111-111111111111";
const BABY2 = "22222222-2222-4222-8222-222222222222";
const job = (reason: string, photoId = PHOTO, babyId = BABY) => ({ photoId, babyId, reason });

/** A pool answering the hook's baby lookup (matched by SQL fragment, as the text is private). */
function hookPool(answer: (photoIds: string[]) => string[] | Error) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const handlers = new Map<string, Handler>();
  const lookup: Handler = (params) => {
    const out = answer((params[0] ?? []) as string[]);
    if (out instanceof Error) throw out;
    return { rows: out.map((baby_id) => ({ baby_id })) };
  };
  const original = handlers.get.bind(handlers);
  handlers.get = (sql: string) => {
    if (sql.includes("baby_ai_enabled")) {
      return (params: unknown[]) => {
        queries.push({ sql, params });
        return lookup(params);
      };
    }
    return original(sql);
  };
  return { pool: scriptedPool(handlers) as never, queries };
}

function setup(
  opts: { babies?: string[] | Error; send?: (j: PushNotifyJob) => Promise<string | null> } = {},
) {
  const log = recordingLog();
  const reindex = vi.fn(async (ids: string[]) => ({ indexed: ids.length }) as never);
  const sent: PushNotifyJob[] = [];
  const send = vi.fn(async (j: PushNotifyJob) => {
    sent.push(j);
    return opts.send ? opts.send(j) : "job-id";
  });
  const { pool, queries } = hookPool(() => opts.babies ?? [BABY]);
  return {
    log,
    reindex,
    send,
    sent,
    queries,
    deps: { indexer: { reindex }, log, pushHook: { pool, send } },
  };
}

describe("reindex push hook", () => {
  it("a reason:ai batch enqueues one photos_analyzed per AI-enabled baby, after indexing", async () => {
    const order: string[] = [];
    const s = setup({ babies: [BABY, BABY2] });
    s.reindex.mockImplementation((async (ids: string[]) => {
      order.push("index");
      return { indexed: ids.length };
    }) as never);
    s.send.mockImplementation((async (j: PushNotifyJob) => {
      order.push(`push:${j.kind}`);
      s.sent.push(j);
      return "id";
    }) as never);
    const out = await handleReindexJobs(s.deps, [
      { id: "1", data: job("ai") },
      { id: "2", data: job("ai", PHOTO2, BABY2) },
    ]);
    expect(s.sent).toEqual([
      { kind: "photos_analyzed", babyId: BABY },
      { kind: "photos_analyzed", babyId: BABY2 },
    ]);
    expect(order).toEqual(["index", "push:photos_analyzed", "push:photos_analyzed"]);
    expect(out.pushEnqueued).toBe(2);
    expect(s.queries[0]?.params).toEqual([[PHOTO, PHOTO2]]);
  });

  it("only the ai-reason photos count: details, milestone and backfill batches enqueue nothing", async () => {
    for (const reason of ["details", "milestone", "override", "backfill", "manual"]) {
      const s = setup();
      const out = await handleReindexJobs(s.deps, [{ id: "1", data: job(reason) }]);
      expect(s.send, reason).not.toHaveBeenCalled();
      expect(out.pushEnqueued ?? 0, reason).toBe(0);
    }
  });

  it("in a mixed batch only the ai photos are looked up", async () => {
    const s = setup();
    await handleReindexJobs(s.deps, [
      { id: "1", data: job("details", PHOTO) },
      { id: "2", data: job("ai", PHOTO2) },
    ]);
    expect(s.queries[0]?.params).toEqual([[PHOTO2]]);
    expect(s.sent).toHaveLength(1);
  });

  it("a free-tier baby (the lookup returns no baby) is never enqueued", async () => {
    const s = setup({ babies: [] });
    const out = await handleReindexJobs(s.deps, [{ id: "1", data: job("ai") }]);
    expect(s.send).not.toHaveBeenCalled();
    expect(out.pushEnqueued).toBe(0);
  });

  it("the lookup is the AI-enabled gate (baby_ai_enabled), not a plan string compare", async () => {
    const s = setup();
    await handleReindexJobs(s.deps, [{ id: "1", data: job("ai") }]);
    expect(s.queries[0]?.sql).toContain("public.baby_ai_enabled");
  });

  it("an invalid job in the batch is dropped and does not reach the hook", async () => {
    const s = setup();
    await handleReindexJobs(s.deps, [
      { id: "1", data: { bad: true } },
      { id: "2", data: job("ai") },
    ]);
    expect(s.queries[0]?.params).toEqual([[PHOTO]]);
  });

  it("a push enqueue failure is logged by category and never blocks or fails the batch", async () => {
    const s = setup({
      send: async () => {
        throw new Error("pg-boss down with tok-secret");
      },
    });
    const out = await handleReindexJobs(s.deps, [{ id: "1", data: job("ai") }]);
    expect(out.result).toEqual({ indexed: 1 });
    expect(out.pushEnqueued).toBe(0);
    const warns = s.log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).not.toContain("tok-secret");
  });

  it("a failed baby lookup is logged and skipped, the batch still succeeds", async () => {
    const s = setup({ babies: new Error("db down") });
    const out = await handleReindexJobs(s.deps, [{ id: "1", data: job("ai") }]);
    expect(out.result).toEqual({ indexed: 1 });
    expect(out.pushEnqueued).toBe(0);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.log.lines.some((l) => l.level === "warn")).toBe(true);
  });

  it("an indexing failure throws before the hook (the retried batch sends the push)", async () => {
    const s = setup();
    s.reindex.mockRejectedValueOnce(new Error("index down"));
    await expect(handleReindexJobs(s.deps, [{ id: "1", data: job("ai") }])).rejects.toThrow(
      "index down",
    );
    expect(s.queries).toHaveLength(0);
    expect(s.send).not.toHaveBeenCalled();
  });

  it("without a pushHook (unit setups) nothing is attempted and the outcome has no pushEnqueued", async () => {
    const log = recordingLog();
    const reindex = vi.fn(async () => ({ indexed: 1 }) as never);
    const out = await handleReindexJobs({ indexer: { reindex }, log }, [
      { id: "1", data: job("ai") },
    ]);
    expect(out).not.toHaveProperty("pushEnqueued");
  });

  it("enqueuePhotosAnalyzed with no photos does not query", async () => {
    const s = setup();
    expect(await enqueuePhotosAnalyzed(s.deps.pushHook, s.log, [])).toBe(0);
    expect(s.queries).toHaveLength(0);
  });

  it("the job payload carries only the kind and the baby id", async () => {
    const s = setup();
    await handleReindexJobs(s.deps, [{ id: "1", data: job("ai") }]);
    expect(Object.keys(s.sent[0] ?? {}).sort()).toEqual(["babyId", "kind"]);
  });
});
