import { randomUUID } from "node:crypto";
import {
  AiProviderError,
  AiRequestError,
  createFakeVisionDescriber,
  type FakeOutcome,
  type VisionBatchHandle,
  type VisionBatchStatus,
  type VisionDescriber,
} from "@littlelight/ai";
import { aiDescriptionV1Schema, type ReindexJob } from "@littlelight/shared";
import { describe, expect, it, type Mock, vi } from "vitest";
import { craftJpeg } from "../../../../e2e/fixtures/ai-images";
import { createFakeAiDb, type FakeAiDb } from "../testing/ai-db";
import { recordingLog } from "../testing/stubs";
import {
  type AiPipelineConfig,
  aiErrorCategory,
  createAiPipeline,
  MAX_SUBMIT_ATTEMPTS,
  SUBMIT_LEASE_MINUTES,
} from "./pipeline";
import * as SQL from "./sql";

const SENTINEL = "SENTINEL-NOTE-90210";

const baseConfig: AiPipelineConfig = {
  AI_BATCH_MAX_PHOTOS: 1000,
  AI_BATCH_FLUSH_MINUTES: 30,
  AI_BATCH_MAX_BYTES: 150_000_000,
  AI_MAX_ATTEMPTS: 2,
  AI_BABY_MONTHLY_BUDGET_USD: 3,
  AI_BUDGET_ALERT_PCT: 80,
  AI_QUEUE_AGE_ALERT_MINUTES: 120,
};

interface Setup {
  db: FakeAiDb;
  pipeline: ReturnType<typeof createAiPipeline>;
  describer: ReturnType<typeof createFakeVisionDescriber>;
  log: ReturnType<typeof recordingLog>;
  reindexed: ReindexJob[];
  sendReindex: Mock<(job: ReindexJob) => Promise<string | null>>;
  getObject: Mock<(key: string) => Promise<Buffer>>;
  advance(min: number): void;
  paidBaby(): string;
  photo(
    babyId: string,
    over?: Parameters<FakeAiDb["addPhoto"]>[0] extends infer T ? Partial<T> : never,
  ): string;
}

function setup(
  o: {
    config?: Partial<AiPipelineConfig>;
    script?: (photoId: string, attempt: number) => FakeOutcome;
    describer?: VisionDescriber | null;
    storageFails?: (key: string) => boolean;
  } = {},
): Setup {
  const db = createFakeAiDb();
  const log = recordingLog();
  const describer = createFakeVisionDescriber({
    env: {},
    pollsUntilComplete: 0,
    ...(o.script ? { script: o.script } : {}),
  });
  const reindexed: ReindexJob[] = [];
  const sendReindex = vi.fn(async (job: ReindexJob) => {
    reindexed.push(job);
    return "job";
  });
  const getObject = vi.fn(async (key: string) => {
    if (o.storageFails?.(key)) throw new Error(`stub failure ${key}`);
    return Buffer.from(craftJpeg(768, 576, 2048));
  });
  const pipeline = createAiPipeline({
    pool: db.pool,
    storage: { getObject } as never,
    describer: o.describer === undefined ? describer : o.describer,
    disabledReason: "OPENAI_API_KEY not set",
    config: { ...baseConfig, ...o.config },
    sendReindex,
    log,
    now: () => db.now,
  });
  return {
    db,
    pipeline,
    describer,
    log,
    reindexed,
    sendReindex,
    getObject,
    advance: (min) => {
      db.now = new Date(db.now.getTime() + min * 60_000);
    },
    paidBaby: () => db.addBaby(true),
    photo: (babyId, over = {}) => db.addPhoto({ babyId, ...over }).id,
  };
}

const warns = (s: Setup) => s.log.lines.filter((l) => l.level === "warn");

describe("flush: claim, seal, submit", () => {
  it("claims paid photos into one building batch and waits for the 30 minute window", async () => {
    const s = setup();
    const baby = s.paidBaby();
    const ids = [s.photo(baby), s.photo(baby), s.photo(baby)];
    const r = await s.pipeline.flush();
    expect(r).toMatchObject({ claimed: 3, submitted: [], budgetSkipped: 0 });
    expect(s.db.batches).toHaveLength(1);
    expect(s.db.batches[0]).toMatchObject({ status: "building", photoCount: 3, submittedAt: null });
    expect(s.db.items.map((i) => i.state)).toEqual(["pending", "pending", "pending"]);
    expect(s.db.items.map((i) => i.attempt)).toEqual([1, 1, 1]);
    for (const id of ids) expect(s.db.photo(id).status).toBe("queued");
    expect(s.describer.requests).toEqual([]);
  });

  it("a flush after the window seals and submits: items submitted, photos analyzing, batch recorded", async () => {
    const s = setup();
    const baby = s.paidBaby();
    const ids = [s.photo(baby), s.photo(baby)];
    await s.pipeline.flush();
    s.advance(31);
    const r = await s.pipeline.flush();
    expect(r.submitted).toHaveLength(1);
    expect(r.submitted[0]).toMatchObject({ count: 2 });
    const b = s.db.batches[0];
    expect(b).toMatchObject({ status: "submitted", photoCount: 2, provider: "fake" });
    expect(b?.providerBatchId).toMatch(/^fakebatch_/);
    expect(s.db.items.every((i) => i.state === "submitted")).toBe(true);
    for (const id of ids) expect(s.db.photo(id).status).toBe("analyzing");
    expect(s.describer.requests.map((q) => q.photoId).sort()).toEqual([...ids].sort());
    for (const q of s.describer.requests) expect(q.plan).toBe("paid");
  });

  it("a forced flush submits at once (run-job, backfill, gate)", async () => {
    const s = setup();
    const baby = s.paidBaby();
    s.photo(baby);
    const r = await s.pipeline.flush({ force: true });
    expect(r.submitted).toHaveLength(1);
    expect(s.db.batches[0]?.status).toBe("submitted");
  });

  it("the 1,000 photo cap seals the batch without waiting; the rest goes into the next batch when forced", async () => {
    const s = setup({ config: { AI_BATCH_MAX_PHOTOS: 3 } });
    const baby = s.paidBaby();
    for (let i = 0; i < 7; i++) s.photo(baby);
    const first = await s.pipeline.flush();
    expect(first.claimed).toBe(3);
    expect(first.submitted).toHaveLength(1);
    expect(s.db.items.filter((i) => i.state === "pending")).toHaveLength(0);
    const forced = await s.pipeline.flush({ force: true });
    expect(forced.claimed).toBe(4);
    expect(forced.submitted.map((b) => b.count)).toEqual([3, 1]);
    expect(s.db.batches.map((b) => b.photoCount)).toEqual([3, 3, 1]);
  });

  it("does nothing while another flush holds the open batch (busy)", async () => {
    const s = setup();
    const baby = s.paidBaby();
    s.photo(baby);
    s.db.openBatchBusy = true;
    const r = await s.pipeline.flush({ force: true });
    expect(r).toMatchObject({ busy: true, claimed: 0, submitted: [] });
    expect(s.db.items).toEqual([]);
    expect(s.describer.requests).toEqual([]);
  });

  it("free, expired, pending, trashed, quarantined and analysis-less photos are never claimed or sent", async () => {
    const s = setup();
    const paid = s.paidBaby();
    const free = s.db.addBaby(false);
    const good = s.photo(paid);
    const freeIds = [s.photo(free), s.photo(free), s.photo(free)];
    s.photo(paid, { approval: "pending" });
    s.photo(paid, { deleted: true });
    s.photo(paid, { quarantined: true });
    s.photo(paid, { analysis: false });
    s.photo(paid, { status: "uploaded" });
    await s.pipeline.flush({ force: true });
    expect(s.describer.requests.map((q) => q.photoId)).toEqual([good]);
    for (const id of freeIds) {
      expect(s.db.photo(id).status).toBe("ingested");
      expect(s.db.itemsOf(id)).toEqual([]);
    }
    expect(JSON.stringify(s.describer.requests)).not.toContain(freeIds[0] as string);
  });

  it("babyId narrows the claim to one baby", async () => {
    const s = setup();
    const a = s.paidBaby();
    const b = s.paidBaby();
    const pa = s.photo(a);
    s.photo(b);
    await s.pipeline.flush({ force: true, babyId: a });
    expect(s.describer.requests.map((q) => q.photoId)).toEqual([pa]);
  });

  it("an empty queue is a no-op", async () => {
    const s = setup();
    s.paidBaby();
    const r = await s.pipeline.flush({ force: true });
    expect(r).toMatchObject({ claimed: 0, submitted: [] });
    expect(s.db.batches).toEqual([]);
  });

  it("a sealed batch whose submitter died is submitted again after the lease", async () => {
    const s = setup();
    const baby = s.paidBaby();
    const id = s.photo(baby);
    await s.pipeline.flush();
    // another process sealed it and vanished
    const sealed = s.db.batches[0];
    if (sealed) sealed.submittedAt = s.db.now;
    s.advance(SUBMIT_LEASE_MINUTES - 1);
    expect((await s.pipeline.flush()).submitted).toHaveLength(0);
    s.advance(2);
    const r = await s.pipeline.flush();
    expect(r.submitted).toHaveLength(1);
    expect(s.describer.requests.map((q) => q.photoId)).toEqual([id]);
  });
});

describe("re-check before submission", () => {
  it("drops a photo whose baby went free after the claim; the describer never sees it", async () => {
    const s = setup();
    const keep = s.paidBaby();
    const gone = s.paidBaby();
    const kept = s.photo(keep);
    const dropped = s.photo(gone);
    await s.pipeline.flush(); // claimed, not due
    s.db.paidBabies.delete(gone); // downgrade
    const r = await s.pipeline.flush({ force: true });
    expect(r.dropped).toBe(1);
    expect(s.describer.requests.map((q) => q.photoId)).toEqual([kept]);
    expect(JSON.stringify(s.describer.requests)).not.toContain(dropped);
    expect(s.db.itemsOf(dropped).map((i) => i.state)).toEqual(["dropped"]);
    expect(s.db.photo(dropped).status).toBe("ingested");
    expect(s.db.itemsOf(kept).map((i) => i.state)).toEqual(["submitted"]);
  });

  it.each([
    ["trashed", { deleted: true }],
    ["quarantined", { quarantined: true }],
    ["un-approved", { approval: "pending" as const }],
  ])("drops a photo that became %s", async (_n, change) => {
    const s = setup();
    const baby = s.paidBaby();
    const id = s.photo(baby);
    await s.pipeline.flush();
    Object.assign(s.db.photo(id), change);
    const r = await s.pipeline.flush({ force: true });
    expect(r.dropped).toBe(1);
    expect(s.describer.requests).toEqual([]);
    expect(s.db.photo(id).status).toBe("ingested");
  });

  it("a batch where everything was dropped is closed without a provider call", async () => {
    const s = setup();
    const baby = s.paidBaby();
    s.photo(baby);
    await s.pipeline.flush();
    s.db.paidBabies.delete(baby);
    await s.pipeline.flush({ force: true });
    expect(s.db.batches[0]).toMatchObject({ status: "cancelled", error: "empty" });
    expect(s.describer.requests).toEqual([]);
  });

  it("a free-tier request cannot reach describeBatch even if the stub describer is called directly", async () => {
    const s = setup();
    await expect(
      s.describer.describeBatch([{ photoId: randomUUID(), plan: "free" } as never]),
    ).rejects.toBeInstanceOf(AiRequestError);
  });
});

describe("budget (per baby, per UTC month)", () => {
  it("keeps what the budget allows, skips the rest, writes one audit row, warns once", async () => {
    const s = setup({
      config: {
        AI_BABY_MONTHLY_BUDGET_USD: 0.0005,
        costEstimateUsd: 0.00017,
        AI_BATCH_FLUSH_MINUTES: 0,
      },
    });
    const baby = s.paidBaby();
    for (let i = 0; i < 5; i++) s.photo(baby);
    const r = await s.pipeline.flush();
    expect(r).toMatchObject({ claimed: 2, budgetSkipped: 3 });
    expect(s.db.budgetAudits).toEqual(new Set([`${baby}:2026-10`]));
    expect(warns(s).filter((l) => l.msg.includes("budget exceeded"))).toHaveLength(1);
    // the skipped photos stay ingested with no item
    const waiting = [...s.db.photos.values()].filter((p) => p.status === "ingested");
    expect(waiting).toHaveLength(3);
    expect(s.db.items).toHaveLength(2);
    // next tick: still over budget, no second warn, the DB function dedupes the audit row
    await s.pipeline.flush();
    expect(warns(s).filter((l) => l.msg.includes("budget exceeded"))).toHaveLength(1);
    expect(s.db.budgetAudits.size).toBe(1);
  });

  it("only warns when the database function inserted (a second worker already audited)", async () => {
    const s = setup({ config: { AI_BABY_MONTHLY_BUDGET_USD: 0, costEstimateUsd: 0.00017 } });
    const baby = s.paidBaby();
    s.db.budgetAudits.add(`${baby}:2026-10`);
    s.photo(baby);
    const r = await s.pipeline.flush({ force: true });
    expect(r).toMatchObject({ claimed: 0, budgetSkipped: 1 });
    expect(warns(s).filter((l) => l.msg.includes("budget exceeded"))).toEqual([]);
  });

  it("a zero budget claims nothing and never calls the provider", async () => {
    const s = setup({ config: { AI_BABY_MONTHLY_BUDGET_USD: 0 } });
    const baby = s.paidBaby();
    s.photo(baby);
    await s.pipeline.flush({ force: true });
    expect(s.describer.requests).toEqual([]);
    expect(s.db.items).toEqual([]);
  });

  it("alerts once at 80 % of the budget without skipping", async () => {
    const s = setup({
      config: {
        AI_BABY_MONTHLY_BUDGET_USD: 0.001,
        costEstimateUsd: 0.00017,
        AI_BUDGET_ALERT_PCT: 80,
      },
    });
    const baby = s.paidBaby();
    for (let i = 0; i < 5; i++) s.photo(baby); // 5 * 0.00017 = 0.00085 >= 0.0008
    const r = await s.pipeline.flush({ force: true });
    expect(r).toMatchObject({ claimed: 5, budgetSkipped: 0 });
    expect(warns(s).filter((l) => l.msg === "ai budget alert")).toHaveLength(1);
    expect(s.db.budgetAudits.size).toBe(0);
  });

  it("spend of earlier items this month counts; another baby is unaffected", async () => {
    const s = setup({ config: { AI_BABY_MONTHLY_BUDGET_USD: 0.001, costEstimateUsd: 0.0001 } });
    const a = s.paidBaby();
    const b = s.paidBaby();
    s.db.extraSpend.set(a, 0.00095);
    s.photo(a);
    s.photo(b);
    const r = await s.pipeline.flush({ force: true });
    expect(r.claimed).toBe(1);
    expect(s.db.items.map((i) => i.babyId)).toEqual([b]);
  });
});

describe("submission failures", () => {
  function failingDescriber(s: Setup, err: unknown): VisionDescriber {
    return { ...s.describer, describeBatch: vi.fn(async () => Promise.reject(err)) } as never;
  }

  it("a provider error unseals the batch and retries on the next flush; the third failure fails the batch", async () => {
    const base = setup();
    const err = new AiProviderError("openai", "batches.create", 503, "api_error", false);
    const s = setup({
      describer: failingDescriber(base, err),
      config: { AI_BATCH_FLUSH_MINUTES: 0 },
    });
    const baby = s.paidBaby();
    const id = s.photo(baby);
    const r1 = await s.pipeline.flush();
    expect(r1.submitErrors).toBe(1);
    expect(s.db.batches[0]).toMatchObject({
      status: "building",
      submittedAt: null,
      error: "provider_503",
    });
    expect(s.db.batches[0]?.requestCounts).toEqual({ submit_attempts: 1 });
    expect(s.db.photo(id).status).toBe("queued");
    expect(s.db.itemsOf(id)[0]?.state).toBe("pending");
    await s.pipeline.flush();
    expect(s.db.batches[0]?.requestCounts).toEqual({ submit_attempts: 2 });
    expect(MAX_SUBMIT_ATTEMPTS).toBe(3);
    await s.pipeline.flush();
    expect(s.db.batches[0]).toMatchObject({ status: "failed", error: "provider_503" });
    expect(s.db.itemsOf(id)[0]).toMatchObject({ state: "failed", failureKind: "provider_error" });
    expect(s.db.photo(id).status).toBe("ingested"); // never failed (plan D4)
    expect(s.log.lines.some((l) => l.level === "error" && l.msg.includes("failed for good"))).toBe(
      true,
    );
  });

  it("a rate limit is categorised; a malformed request fails at once", async () => {
    expect(
      aiErrorCategory(new AiProviderError("openai", "x", 429, "rate_limit_exceeded", true)),
    ).toBe("rate_limited");
    expect(aiErrorCategory(new AiProviderError("openai", "x", 0, "timeout", true))).toBe(
      "provider_timeout",
    );
    expect(aiErrorCategory(new AiRequestError("batch_too_large"))).toBe("request_batch_too_large");
    const base = setup();
    const s = setup({
      describer: failingDescriber(base, new AiRequestError("batch_too_large")),
      config: { AI_BATCH_FLUSH_MINUTES: 0 },
    });
    const baby = s.paidBaby();
    const id = s.photo(baby);
    await s.pipeline.flush();
    expect(s.db.batches[0]).toMatchObject({ status: "failed", error: "request_batch_too_large" });
    expect(s.db.photo(id).status).toBe("ingested");
  });

  it("error logs carry a category, never the provider message", async () => {
    const base = setup();
    const err = new AiProviderError(
      "openai",
      "batches.create",
      400,
      "invalid_request_error",
      false,
    );
    const s = setup({
      describer: failingDescriber(base, err),
      config: { AI_BATCH_FLUSH_MINUTES: 0 },
    });
    const baby = s.paidBaby();
    s.photo(baby, { ctx: { note: SENTINEL } });
    await s.pipeline.flush();
    const text = JSON.stringify(s.log.lines);
    expect(text).toContain("provider_400");
    expect(text).not.toContain(SENTINEL);
  });

  it("a recording failure after a successful submit cancels the batch at the provider and rethrows", async () => {
    const s = setup();
    const baby = s.paidBaby();
    s.photo(baby);
    const original = s.db.pool.connect.bind(s.db.pool);
    let failNext = false;
    s.db.pool.connect = async () => {
      const c = await original();
      const q = c.query.bind(c);
      c.query = (async (sql: string, params?: unknown[]) => {
        if (failNext && sql === SQL.MARK_SUBMITTED_SQL) throw new Error("db down");
        return q(sql, params);
      }) as never;
      return c;
    };
    failNext = true;
    await expect(s.pipeline.flush({ force: true })).rejects.toThrow("db down");
    expect(s.describer.cancelCalls).toHaveLength(1);
    expect(s.log.lines.some((l) => l.level === "error" && l.msg.includes("not recorded"))).toBe(
      true,
    );
  });
});

describe("unbuildable photos and the byte cap", () => {
  it("a photo whose analysis copy cannot be read becomes a counted failed attempt; others go on", async () => {
    const s = setup({
      storageFails: (k) => k.includes("0000000bad01"),
      config: { AI_BATCH_FLUSH_MINUTES: 0 },
    });
    const baby = s.paidBaby();
    const good = s.photo(baby);
    const bad = s.photo(baby, { id: "00000000-0000-4000-8000-0000000bad01" });
    const r = await s.pipeline.flush();
    expect(r.unbuildable).toBe(1);
    expect(s.db.itemsOf(bad)[0]).toMatchObject({ state: "failed", failureKind: "provider_error" });
    expect(s.db.photo(bad).status).toBe("ingested");
    expect(s.describer.requests.map((q) => q.photoId)).toEqual([good]);
  });

  it("a photo without an analysis derivative row at submit time is unbuildable, not sent", async () => {
    const s = setup();
    const baby = s.paidBaby();
    const id = s.photo(baby);
    await s.pipeline.flush();
    s.db.photo(id).analysis = false;
    await s.pipeline.flush({ force: true });
    expect(s.describer.requests).toEqual([]);
    expect(s.db.itemsOf(id)[0]?.state).toBe("failed");
  });

  it("the byte cap defers the overflow back to the queue (item removed, photo ingested), never lost", async () => {
    const s = setup({ config: { AI_BATCH_MAX_BYTES: 40_000, AI_BATCH_FLUSH_MINUTES: 0 } }); // ~18.7 KB per request estimate
    const baby = s.paidBaby();
    const ids = [s.photo(baby), s.photo(baby), s.photo(baby)];
    const r = await s.pipeline.flush();
    expect(r.submitted[0]?.count).toBe(2);
    expect(r.deferred).toBe(1);
    expect(s.db.itemsOf(ids[2] as string)).toEqual([]);
    expect(s.db.photo(ids[2] as string).status).toBe("ingested");
    // the next forced flush picks the deferred one up
    const again = await s.pipeline.flush();
    expect(again.submitted[0]?.count).toBe(1);
    expect(s.describer.requests.map((q) => q.photoId)).toEqual(ids);
  });

  it("a single request over the cap is still sent alone (never an empty batch)", async () => {
    const s = setup({ config: { AI_BATCH_MAX_BYTES: 1000 } });
    const baby = s.paidBaby();
    s.photo(baby);
    const r = await s.pipeline.flush({ force: true });
    expect(r.submitted[0]?.count).toBe(1);
  });

  it("a coordinate-looking note is blanked and reported by photo id only", async () => {
    const s = setup();
    const baby = s.paidBaby();
    const id = s.photo(baby, { ctx: { note: "taken at 47.6062, -122.3321" } });
    await s.pipeline.flush({ force: true });
    expect(s.describer.requests[0]?.contextKeys).not.toContain("parentNotes");
    const w = warns(s).find((l) => l.msg.includes("blanked"));
    expect(w?.obj).toMatchObject({ photoIds: [id] });
    expect(JSON.stringify(s.log.lines)).not.toContain("47.6062");
  });
});

describe("poll: results", () => {
  async function submitted(s: Setup, n = 3) {
    const baby = s.paidBaby();
    const ids = Array.from({ length: n }, () => s.photo(baby));
    await s.pipeline.flush({ force: true });
    return { baby, ids };
  }

  it("stores valid results: photo_ai, ready, item cost, batch totals, artifacts deleted, one reindex per photo", async () => {
    const s = setup();
    const { baby, ids } = await submitted(s);
    const r = await s.pipeline.poll();
    expect(r).toMatchObject({
      polled: 1,
      terminal: 1,
      stored: 3,
      failed: 0,
      reindexSent: 3,
      filesDeleted: 1,
    });
    for (const id of ids) {
      expect(s.db.photo(id).status).toBe("ready");
      expect(aiDescriptionV1Schema.safeParse(s.db.photoAi.get(id)?.description).success).toBe(true);
      expect(s.db.itemsOf(id)[0]).toMatchObject({ state: "succeeded", failureKind: null });
      expect(s.db.itemsOf(id)[0]?.costUsd).toBeCloseTo(0.0001385, 10);
    }
    const b = s.db.batches[0];
    expect(b).toMatchObject({ status: "completed" });
    expect(b?.costUsd).toBeCloseTo(3 * 0.0001385, 9);
    expect(b?.totals).toMatchObject({ input: 4200, cached: 2100, output: 1200, reasoning: 0 });
    expect(b?.filesDeletedAt).not.toBeNull();
    expect(s.describer.deleteCalls).toEqual([b?.providerBatchId]);
    expect(s.reindexed.map((j) => j.photoId).sort()).toEqual([...ids].sort());
    for (const j of s.reindexed) expect(j).toMatchObject({ babyId: baby, reason: "ai" });
  });

  it("a bath photo stores the sensitive flag for the database trigger", async () => {
    const s = setup();
    const baby = s.paidBaby();
    const id = s.photo(baby, { id: "0aaaaaaa-0000-4000-8000-000000000001" });
    await s.pipeline.flush({ force: true });
    await s.pipeline.poll();
    expect(s.db.photoAi.get(id)?.flags).toEqual(["bath"]);
  });

  it("is idempotent: polling again, or re-delivering the same results, stores and sends nothing twice", async () => {
    const s = setup();
    const { ids } = await submitted(s, 2);
    await s.pipeline.poll();
    const again = await s.pipeline.poll();
    expect(again).toMatchObject({ polled: 0, stored: 0, reindexSent: 0 });
    expect(s.reindexed).toHaveLength(2);
    // simulate a crash after storing but before the batch row was closed
    const open = s.db.batches[0];
    if (open) open.status = "submitted";
    const redo = await s.pipeline.poll();
    expect(redo).toMatchObject({ stored: 0, reindexSent: 0 });
    expect(s.reindexed).toHaveLength(2);
    expect(s.db.photoAi.size).toBe(2);
    for (const id of ids) expect(s.db.itemsOf(id)).toHaveLength(1);
  });

  it("invalid output fails the item, releases the photo, a second claim retries once, then no third", async () => {
    const s = setup({ script: () => "invalid_output" });
    const baby = s.paidBaby();
    const id = s.photo(baby);
    await s.pipeline.flush({ force: true });
    const p1 = await s.pipeline.poll();
    expect(p1).toMatchObject({ stored: 0, failed: 1 });
    expect(s.db.itemsOf(id)[0]).toMatchObject({
      state: "failed",
      failureKind: "invalid_output",
      attempt: 1,
    });
    expect(s.db.photo(id).status).toBe("ingested");
    expect(s.db.photoAi.has(id)).toBe(false);
    expect(s.sendReindex).not.toHaveBeenCalled();
    // second attempt
    const f2 = await s.pipeline.flush({ force: true });
    expect(f2.claimed).toBe(1);
    expect(s.db.itemsOf(id).map((i) => i.attempt)).toEqual([1, 2]);
    await s.pipeline.poll();
    expect(s.db.itemsOf(id).filter((i) => i.state === "failed")).toHaveLength(2);
    // no third claim
    const f3 = await s.pipeline.flush({ force: true });
    expect(f3.claimed).toBe(0);
    expect(s.db.itemsOf(id)).toHaveLength(2);
    // an admin retry request re-enables one more pair of attempts
    s.advance(1);
    s.db.photo(id).retryRequestedAt = s.db.now;
    s.advance(1);
    const f4 = await s.pipeline.flush({ force: true });
    expect(f4.claimed).toBe(1);
    expect(s.db.itemsOf(id).at(-1)).toMatchObject({ attempt: 1, state: "submitted" });
  });

  it("a second attempt can succeed after a first invalid one", async () => {
    const s = setup({ script: (_id, attempt) => (attempt === 1 ? "invalid_output" : "ok") });
    const baby = s.paidBaby();
    const id = s.photo(baby);
    await s.pipeline.flush({ force: true });
    await s.pipeline.poll();
    await s.pipeline.flush({ force: true });
    const p = await s.pipeline.poll();
    expect(p.stored).toBe(1);
    expect(s.db.photo(id).status).toBe("ready");
    expect(s.db.itemsOf(id).map((i) => i.state)).toEqual(["failed", "succeeded"]);
  });

  it("a refusal is a failed item with its billed cost kept; nothing stored", async () => {
    const s = setup({ script: () => "refusal" });
    const baby = s.paidBaby();
    const id = s.photo(baby);
    await s.pipeline.flush({ force: true });
    const r = await s.pipeline.poll();
    expect(r).toMatchObject({ stored: 0, failed: 1 });
    const item = s.db.itemsOf(id)[0];
    expect(item).toMatchObject({ state: "failed", failureKind: "refusal" });
    expect(item?.costUsd).toBeGreaterThan(0);
    expect(s.db.photoAi.size).toBe(0);
  });

  it("a provider error result fails the item as provider_error", async () => {
    const s = setup({ script: () => "provider_error" });
    const baby = s.paidBaby();
    const id = s.photo(baby);
    await s.pipeline.flush({ force: true });
    await s.pipeline.poll();
    expect(s.db.itemsOf(id)[0]).toMatchObject({ state: "failed", failureKind: "provider_error" });
  });

  it("an expired batch: missing results become expired items, photos go back to the queue, batch is expired", async () => {
    const s = setup({ script: (id) => (id.startsWith("1") ? "expired" : "ok") });
    const baby = s.paidBaby();
    const gone = s.photo(baby, { id: "10000000-0000-4000-8000-000000000001" });
    const fine = s.photo(baby, { id: "20000000-0000-4000-8000-000000000002" });
    await s.pipeline.flush({ force: true });
    const r = await s.pipeline.poll();
    expect(r).toMatchObject({ stored: 1, failed: 1 });
    expect(s.db.itemsOf(gone)[0]).toMatchObject({ state: "failed", failureKind: "expired" });
    expect(s.db.photo(gone).status).toBe("ingested");
    expect(s.db.photo(fine).status).toBe("ready");
    expect(s.db.batches[0]?.status).toBe("expired");
  });

  it("results missing from a completed batch fail as provider_error", async () => {
    const s = setup();
    const baby = s.paidBaby();
    const ids = [s.photo(baby), s.photo(baby)];
    await s.pipeline.flush({ force: true });
    const real = s.describer.pollBatch.bind(s.describer);
    const partial: VisionDescriber = {
      ...s.describer,
      pollBatch: async (h: VisionBatchHandle) => {
        const st = await real(h);
        return { ...st, results: st.results?.filter((r) => r.photoId === ids[0]) };
      },
    } as never;
    const p = createAiPipeline({
      pool: s.db.pool,
      storage: { getObject: s.getObject } as never,
      describer: partial,
      config: baseConfig,
      sendReindex: s.sendReindex,
      log: s.log,
      now: () => s.db.now,
    });
    const r = await p.poll();
    expect(r).toMatchObject({ stored: 1, failed: 1 });
    expect(s.db.itemsOf(ids[1] as string)[0]).toMatchObject({
      state: "failed",
      failureKind: "provider_error",
    });
    expect(s.db.photo(ids[1] as string).status).toBe("ingested");
  });

  it("a baby downgraded after submission: billed, never stored, photo released", async () => {
    const s = setup();
    const { baby, ids } = await submitted(s, 2);
    s.db.paidBabies.delete(baby);
    const r = await s.pipeline.poll();
    expect(r.stored).toBe(0);
    expect(s.db.photoAi.size).toBe(0);
    for (const id of ids) {
      expect(s.db.itemsOf(id)[0]?.state).toBe("dropped");
      expect(s.db.photo(id).status).toBe("ingested");
    }
    expect(s.sendReindex).not.toHaveBeenCalled();
  });

  it("the database tripwire refusing one result fails only that item (savepoint), the rest are stored", async () => {
    const s = setup();
    const { ids } = await submitted(s, 3);
    s.db.upsertError = "23514";
    const r = await s.pipeline.poll();
    expect(r.stored).toBe(2);
    expect(r.failed).toBe(1);
    expect(s.db.photoAi.size).toBe(2);
    const failed = ids.filter((id) => s.db.itemsOf(id)[0]?.state === "failed");
    expect(failed).toHaveLength(1);
    expect(s.db.itemsOf(failed[0] as string)[0]?.failureKind).toBe("provider_error");
    expect(s.db.photo(failed[0] as string).status).toBe("ingested");
    expect(warns(s).some((l) => l.msg.includes("could not be stored"))).toBe(true);
  });

  it("a reindex send failure is logged and does not stop the others or the batch", async () => {
    const s = setup();
    const { ids } = await submitted(s, 3);
    s.sendReindex.mockImplementationOnce(async () => {
      throw new Error("boss down");
    });
    const r = await s.pipeline.poll();
    expect(r.stored).toBe(3);
    expect(r.reindexSent).toBe(2);
    expect(s.sendReindex).toHaveBeenCalledTimes(3);
    expect(ids.every((id) => s.db.photo(id).status === "ready")).toBe(true);
    expect(JSON.stringify(s.log.lines)).not.toContain("boss down");
  });

  it("a batch still in progress is recorded and left alone", async () => {
    const s = setup();
    const baby = s.paidBaby();
    s.photo(baby);
    const slow = createFakeVisionDescriber({ env: {}, pollsUntilComplete: 2 });
    const p = createAiPipeline({
      pool: s.db.pool,
      storage: { getObject: s.getObject } as never,
      describer: slow,
      config: baseConfig,
      sendReindex: s.sendReindex,
      log: s.log,
      now: () => s.db.now,
    });
    await p.flush({ force: true });
    const r = await p.poll();
    expect(r).toMatchObject({ polled: 1, terminal: 0, stored: 0 });
    expect(s.db.batches[0]?.status).toBe("in_progress");
    expect((await p.poll()).terminal).toBe(0);
    expect((await p.poll()).terminal).toBe(1);
  });

  it("a poll error is logged by category and the batch is retried on the next tick", async () => {
    const s = setup();
    await submitted(s, 1);
    const flaky: VisionDescriber = {
      ...s.describer,
      pollBatch: async () => {
        throw new AiProviderError("fake", "batches.retrieve", 503, "api_error", false);
      },
    } as never;
    const p = createAiPipeline({
      pool: s.db.pool,
      storage: { getObject: s.getObject } as never,
      describer: flaky,
      config: baseConfig,
      sendReindex: s.sendReindex,
      log: s.log,
      now: () => s.db.now,
    });
    const r = await p.poll();
    expect(r.polled).toBe(0);
    expect(s.db.batches[0]?.status).toBe("submitted");
    expect(warns(s).some((l) => l.obj.err === "provider_503")).toBe(true);
  });

  it("warns about open batches of another provider, once, and does not poll them", async () => {
    const s = setup();
    await submitted(s, 1);
    const other = s.db.batches[0];
    if (other) other.provider = "openai";
    await s.pipeline.poll();
    await s.pipeline.poll();
    expect(warns(s).filter((l) => l.msg.includes("another provider"))).toHaveLength(1);
    expect(s.db.batches[0]?.status).toBe("submitted");
  });
});

describe("poll: totals, warnings and artifact cleanup", () => {
  function statusWith(
    base: VisionBatchStatus,
    over: Partial<VisionBatchStatus>,
  ): VisionBatchStatus {
    return { ...base, ...over };
  }
  async function withStub(
    s: Setup,
    patch: (st: VisionBatchStatus) => VisionBatchStatus,
    cfg: Partial<AiPipelineConfig> = {},
    extra: Partial<VisionDescriber> = {},
  ) {
    const real = s.describer.pollBatch.bind(s.describer);
    const stub: VisionDescriber = {
      ...s.describer,
      pollBatch: async (h: VisionBatchHandle) => patch(await real(h)),
      ...extra,
    } as never;
    return createAiPipeline({
      pool: s.db.pool,
      storage: { getObject: s.getObject } as never,
      describer: stub,
      config: { ...baseConfig, ...cfg },
      sendReindex: s.sendReindex,
      log: s.log,
      now: () => s.db.now,
    });
  }
  async function oneSubmitted(s: Setup) {
    const baby = s.paidBaby();
    s.photo(baby);
    await s.pipeline.flush({ force: true });
  }

  it("warns when the provider's cost differs from the items' sum", async () => {
    const s = setup();
    await oneSubmitted(s);
    const p = await withStub(s, (st) =>
      statusWith(st, { usage: { ...(st.usage as object), costUsd: 0.5 } as never }),
    );
    await p.poll();
    expect(warns(s).some((l) => l.msg.includes("cost mismatch"))).toBe(true);
  });

  it("no mismatch warning when the totals agree", async () => {
    const s = setup();
    await oneSubmitted(s);
    await s.pipeline.poll();
    expect(warns(s).some((l) => l.msg.includes("cost mismatch"))).toBe(false);
  });

  it("warns on reasoning tokens with effort none, not with effort low", async () => {
    for (const [effort, expected] of [
      ["none", true],
      ["low", false],
    ] as const) {
      const s = setup();
      await oneSubmitted(s);
      const p = await withStub(
        s,
        (st) =>
          statusWith(st, {
            results: st.results?.map((r) =>
              r.ok ? { ...r, usage: { ...r.usage, reasoningTokens: 120 } } : r,
            ),
          }),
        { VISION_REASONING_EFFORT: effort },
      );
      await p.poll();
      expect(
        warns(s).some((l) => l.msg.includes("reasoning tokens")),
        effort,
      ).toBe(expected);
    }
  });

  it("an artifact delete failure leaves files_deleted_at null and is retried by the next poll", async () => {
    const s = setup();
    await oneSubmitted(s);
    let fail = true;
    const del = vi.fn(async (h: VisionBatchHandle) => {
      if (fail) throw new AiProviderError("fake", "files.delete", 500, "server_error", false);
      return { deleted: [h.batchId] };
    });
    const p = await withStub(s, (st) => st, {}, { deleteBatchArtifacts: del as never });
    const r1 = await p.poll();
    expect(r1).toMatchObject({ terminal: 1, filesDeleted: 0 });
    expect(del).toHaveBeenCalledTimes(1); // one attempt per poll, not an immediate second
    expect(s.db.batches[0]?.filesDeletedAt).toBeNull();
    expect(warns(s).some((l) => l.msg.includes("not deleted yet"))).toBe(true);
    fail = false;
    const r2 = await p.poll();
    expect(r2.filesDeleted).toBe(1);
    expect(s.db.batches[0]?.filesDeletedAt).not.toBeNull();
    expect(del).toHaveBeenCalledTimes(2);
    // and then it stops retrying
    expect((await p.poll()).filesDeleted).toBe(0);
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("the overdue flag appears after an hour of failed deletions", async () => {
    const s = setup();
    await oneSubmitted(s);
    const del = vi.fn(async () => {
      throw new Error("x");
    });
    const p = await withStub(s, (st) => st, {}, { deleteBatchArtifacts: del as never });
    await p.poll();
    s.advance(61);
    await p.poll();
    expect(warns(s).at(-1)?.obj.overdue).toBe(true);
  });

  it("a failed provider batch fails every item and records the failure code", async () => {
    const s = setup();
    await oneSubmitted(s);
    const p = await withStub(s, (st) =>
      statusWith(st, {
        state: "failed",
        results: [],
        failureCode: "invalid_json_line",
        usage: undefined,
      }),
    );
    await p.poll();
    expect(s.db.batches[0]).toMatchObject({ status: "failed", error: "invalid_json_line" });
    expect(s.db.items[0]).toMatchObject({ state: "failed", failureKind: "provider_error" });
    expect([...s.db.photos.values()][0]?.status).toBe("ingested");
  });
});

describe("version backfill and upgrade", () => {
  it("'upgrade' is a forced flush for the baby; 'version' re-describes already described photos", async () => {
    const s = setup();
    const baby = s.paidBaby();
    const id = s.photo(baby);
    const r = await s.pipeline.backfill({ reason: "upgrade", babyId: baby });
    expect(r.submitted).toHaveLength(1);
    expect(s.db.pool.log.filter(([sql]) => sql === SQL.ELIGIBLE_SQL)[0]?.[1]).toEqual([
      1000,
      "v1",
      "v1",
      baby,
      false,
      2,
      [],
    ]);
    await s.pipeline.poll();
    expect(s.db.photo(id).status).toBe("ready");
    s.describer.requests.length = 0;
    const v = await s.pipeline.backfill({ reason: "version" });
    expect(v.claimed).toBe(1);
    expect(s.db.pool.log.filter(([sql]) => sql === SQL.ELIGIBLE_SQL).at(-1)?.[1]).toEqual([
      1000,
      "v1",
      "v1",
      null,
      true,
      2,
      [],
    ]);
    expect(s.describer.requests.map((q) => q.photoId)).toEqual([id]);
    expect(s.db.photo(id).status).toBe("analyzing");
    // a regular flush never re-describes
    await s.pipeline.poll();
    expect((await s.pipeline.flush({ force: true })).claimed).toBe(0);
  });

  it("a replaced description keeps working if the new batch fails (back to ready, not ingested)", async () => {
    const s = setup({ script: (_i, attempt) => (attempt >= 2 ? "refusal" : "ok") });
    const baby = s.paidBaby();
    const id = s.photo(baby);
    await s.pipeline.flush({ force: true });
    await s.pipeline.poll();
    await s.pipeline.backfill({ reason: "version", babyId: baby });
    await s.pipeline.poll();
    expect(s.db.photo(id).status).toBe("ready");
    expect(s.db.photoAi.has(id)).toBe(true);
  });

  it("the upgrade backfill never claims a free baby's photos", async () => {
    const s = setup();
    const free = s.db.addBaby(false);
    const id = s.photo(free);
    const r = await s.pipeline.backfill({ reason: "upgrade", babyId: free });
    expect(r.claimed).toBe(0);
    expect(s.describer.requests).toEqual([]);
    expect(s.db.photo(id).status).toBe("ingested");
  });
});

describe("no provider configured", () => {
  it("flush and poll skip with one log line and touch no table", async () => {
    const s = setup({ describer: null });
    const baby = s.paidBaby();
    s.photo(baby);
    const f1 = await s.pipeline.flush({ force: true });
    const f2 = await s.pipeline.flush();
    const p = await s.pipeline.poll();
    expect(f1).toMatchObject({ skipped: true, claimed: 0 });
    expect(f2.skipped).toBe(true);
    expect(p.skipped).toBe(true);
    expect(s.db.pool.log).toEqual([]);
    const infos = s.log.lines.filter((l) => l.msg.startsWith("AI skipped"));
    expect(infos).toHaveLength(1);
    expect(infos[0]?.msg).toContain("OPENAI_API_KEY not set");
    expect([...s.db.photos.values()][0]?.status).toBe("ingested");
  });
});

describe("queue age", () => {
  it("reads the oldest eligible photo and the oldest open batch (null when empty)", async () => {
    const s = setup();
    expect(await s.pipeline.queueAge()).toEqual({
      oldestEligibleMinutes: null,
      oldestOpenBatchMinutes: null,
    });
    const pool = (await import("../testing/stubs")).scriptedPool({
      [SQL.OLDEST_ELIGIBLE_SQL]: () => ({ rows: [{ minutes: 130.5 }] }),
      [SQL.OLDEST_OPEN_BATCH_SQL]: () => ({ rows: [{ minutes: "12.25" }] }),
    });
    const p = createAiPipeline({
      pool,
      storage: { getObject: s.getObject } as never,
      describer: s.describer,
      config: baseConfig,
      sendReindex: s.sendReindex,
      log: s.log,
    });
    expect(await p.queueAge()).toEqual({
      oldestEligibleMinutes: 130.5,
      oldestOpenBatchMinutes: 12.25,
    });
    const [, params] = pool.appQueries()[0] ?? [];
    expect(params).toEqual(["v1", "v1", 2]);
  });
});

describe("privacy of logs and statements", () => {
  it("a parent note, people, place and milestone never appear in any log object or statement parameter", async () => {
    const s = setup({ script: (_id, attempt) => (attempt === 1 ? "invalid_output" : "refusal") });
    const baby = s.paidBaby();
    const ctx = {
      note: SENTINEL,
      people: [`${SENTINEL}-person`],
      location_label: `${SENTINEL}-place`,
      milestone_name: `${SENTINEL}-milestone`,
      age_days: 40,
      exif_taken_at: new Date("2026-06-14T10:00:00Z"),
      tz_offset_minutes: 0,
    };
    s.photo(baby, { ctx });
    s.photo(baby, { ctx });
    await s.pipeline.flush({ force: true });
    await s.pipeline.poll();
    await s.pipeline.flush({ force: true });
    await s.pipeline.poll();
    s.db.paidBabies.delete(baby);
    await s.pipeline.flush({ force: true });
    expect(s.db.items.length).toBeGreaterThan(0);
    const logText = JSON.stringify(s.log.lines);
    expect(logText).not.toContain(SENTINEL);
    expect(JSON.stringify(s.db.pool.log)).not.toContain(SENTINEL);
    // nor does the fake provider's own record
    expect(JSON.stringify(s.describer.requests)).not.toContain(SENTINEL);
    // and no log line carries a description, a prompt or image bytes
    expect(logText).not.toMatch(/base64|detailed_description|search_tags|data:image/);
  });

  it("no statement selects GPS, raw EXIF JSON, home coordinates or the baby's name", () => {
    for (const [name, sql] of Object.entries(SQL)) {
      if (typeof sql !== "string") continue;
      expect(sql, name).not.toMatch(/gps_|raw_json|home_lat|home_lng|decrypt_coord|app\.data_key/i);
      expect(sql, name).not.toMatch(/\bb\.name\b|babies\.name/i);
    }
  });

  it("the pipeline never binds the data key (runAsPipeline with no key)", async () => {
    const s = setup();
    const baby = s.paidBaby();
    s.photo(baby);
    await s.pipeline.flush({ force: true });
    await s.pipeline.poll();
    expect(s.db.pool.log.some(([sql]) => sql.includes("app.data_key"))).toBe(false);
    expect(
      s.db.pool.log.filter(([sql]) => sql === "SET LOCAL ROLE pipeline").length,
    ).toBeGreaterThan(0);
  });

  it("only the analysis derivative key is ever read from storage", async () => {
    const s = setup();
    const baby = s.paidBaby();
    s.photo(baby);
    s.photo(baby);
    await s.pipeline.flush({ force: true });
    expect(s.getObject).toHaveBeenCalledTimes(2);
    for (const [key] of s.getObject.mock.calls) expect(String(key)).toMatch(/\/analysis\.jpg$/);
  });
});

describe("forced-flush behaviour (one attempt per photo per call)", () => {
  it("a transient storage failure is claimed once in a forced flush, not re-claimed in later rounds", async () => {
    const s = setup({ storageFails: (k) => k.includes("0000000bad01") });
    const baby = s.paidBaby();
    s.photo(baby);
    const bad = s.photo(baby, { id: "00000000-0000-4000-8000-0000000bad01" });
    const r = await s.pipeline.flush({ force: true });
    expect(r.unbuildable).toBe(1);
    expect(s.db.itemsOf(bad)).toHaveLength(1);
    expect(s.db.itemsOf(bad)[0]).toMatchObject({ attempt: 1, state: "failed" });
    // later rounds excluded it explicitly
    const calls = s.db.pool.log.filter(([sql]) => sql === SQL.ELIGIBLE_SQL);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]?.[1]?.[6]).toEqual([]);
    expect(calls.at(-1)?.[1]?.[6]).toEqual([bad]);
    // the next flush call may try again (second and last attempt)
    await s.pipeline.flush({ force: true });
    expect(s.db.itemsOf(bad).map((i) => i.attempt)).toEqual([1, 2]);
  });

  it("a submit failure gives submitErrors 1 and exactly one describeBatch call per flush", async () => {
    const base = setup();
    const describeBatch = vi.fn(async () => {
      throw new AiProviderError("openai", "batches.create", 503, "api_error", false);
    });
    const s = setup({ describer: { ...base.describer, describeBatch } as never });
    const baby = s.paidBaby();
    s.photo(baby);
    const r = await s.pipeline.flush({ force: true });
    expect(r.submitErrors).toBe(1);
    expect(describeBatch).toHaveBeenCalledTimes(1);
    const r2 = await s.pipeline.flush({ force: true });
    expect(r2.submitErrors).toBe(1);
    expect(describeBatch).toHaveBeenCalledTimes(2);
    expect(s.db.batches[0]?.requestCounts).toEqual({ submit_attempts: 2 });
  });

  it("budgetSkipped counts distinct photos across rounds", async () => {
    const s = setup({
      config: { AI_BABY_MONTHLY_BUDGET_USD: 0.0005, costEstimateUsd: 0.00017 },
    });
    const baby = s.paidBaby();
    for (let i = 0; i < 5; i++) s.photo(baby);
    const r = await s.pipeline.flush({ force: true });
    expect(r).toMatchObject({ claimed: 2, budgetSkipped: 3 });
    expect(s.db.budgetAudits.size).toBe(1);
  });

  it("byte-cap deferrals stay re-claimable in later rounds of a forced flush (no attempt spent)", async () => {
    const s = setup({ config: { AI_BATCH_MAX_BYTES: 40_000 } });
    const baby = s.paidBaby();
    const ids = [s.photo(baby), s.photo(baby), s.photo(baby)];
    const r = await s.pipeline.flush({ force: true });
    expect(r.submitted.map((b) => b.count)).toEqual([2, 1]);
    expect(r.deferred).toBe(1);
    for (const id of ids) expect(s.db.itemsOf(id).map((i) => i.attempt)).toEqual([1]);
  });
});

describe("unsupported prompt/schema version", () => {
  it("flush is skipped: no eligibility query, no claim, one error log however often it runs", async () => {
    const s = setup({ config: { promptVersion: "v9" } });
    const baby = s.paidBaby();
    const id = s.photo(baby);
    const a = await s.pipeline.flush({ force: true });
    const b = await s.pipeline.flush();
    expect(a).toMatchObject({ skipped: true, claimed: 0 });
    expect(b.skipped).toBe(true);
    expect(s.db.pool.log.some(([sql]) => sql === SQL.ELIGIBLE_SQL)).toBe(false);
    expect(s.db.items).toEqual([]);
    expect(s.db.photo(id).status).toBe("ingested");
    expect(s.describer.requests).toEqual([]);
    const errors = s.log.lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0]?.obj)).not.toContain("SENTINEL");
  });

  it("also for an unsupported schema version, and through backfill", async () => {
    const s = setup({ config: { schemaVersion: "v7" } });
    const baby = s.paidBaby();
    s.photo(baby);
    const r = await s.pipeline.backfill({ reason: "upgrade", babyId: baby });
    expect(r.skipped).toBe(true);
    expect(s.db.pool.log.some(([sql]) => sql === SQL.ELIGIBLE_SQL)).toBe(false);
  });
});
