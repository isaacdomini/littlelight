import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeVisionDescriber, type FakeOutcome } from "@littlelight/ai";
import { aiDescriptionV1Schema, type ReindexJob } from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestPhoto } from "../ingest";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import { sceneJpeg } from "../testing/images";
import { type AiPipelineConfig, createAiPipeline } from "./pipeline";

// The AI batch pipeline against real Postgres + MinIO (docs/plans/step-6.md 2.11): real ingest
// (analysis derivatives), the real SQL and triggers, the fake vision provider with a state dir.
// Free-tier photos are asserted absent from the requests AND from the provider dump files.

const config: AiPipelineConfig = {
  AI_BATCH_MAX_PHOTOS: 1000,
  AI_BATCH_FLUSH_MINUTES: 0,
  AI_BATCH_MAX_BYTES: 150_000_000,
  AI_MAX_ATTEMPTS: 2,
  AI_BABY_MONTHLY_BUDGET_USD: 3,
  AI_BUDGET_ALERT_PCT: 80,
  AI_QUEUE_AGE_ALERT_MINUTES: 120,
};

describe.skipIf(!integrationEnv)("AI batch pipeline (real database + object storage)", () => {
  let h: Harness;
  let dir: string;
  let seed = 1000;

  beforeAll(async () => {
    h = await createHarness();
    dir = await mkdtemp(join(tmpdir(), "ll-fake-vision-"));
  });
  afterAll(async () => {
    await h?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function make(
    o: {
      script?: (photoId: string, attempt: number) => FakeOutcome;
      cfg?: Partial<AiPipelineConfig>;
      describer?: null;
      pollsUntilComplete?: number;
    } = {},
  ) {
    const describer = createFakeVisionDescriber({
      env: {},
      dir,
      pollsUntilComplete: o.pollsUntilComplete ?? 0,
      ...(o.script ? { script: o.script } : {}),
    });
    const reindexed: ReindexJob[] = [];
    const pipeline = createAiPipeline({
      pool: h.workerPool,
      storage: h.storage,
      describer: o.describer === null ? null : describer,
      disabledReason: "OPENAI_API_KEY not set",
      config: { ...config, ...o.cfg },
      sendReindex: async (job) => {
        reindexed.push(job);
        return "job";
      },
      log: h.log,
    });
    return { describer, pipeline, reindexed };
  }

  /** `n` really ingested photos (status `ingested`, analysis derivative in storage). */
  async function ingested(baby: { id: string; ownerId: string }, n: number, ids: string[] = []) {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const bytes = await sceneJpeg(1600, 1200, seed++);
      const up = await h.seedUpload({ baby, bytes, ...(ids[i] ? { id: ids[i] } : {}) });
      const r = await ingestPhoto(h.deps(), { photoId: up.id, babyId: baby.id });
      expect(r.outcome).toBe("ingested");
      out.push(up.id);
    }
    return out;
  }

  const photoRow = (id: string) =>
    h.one<{ status: string; is_sensitive: boolean }>(
      "SELECT status, is_sensitive FROM public.photos WHERE id = $1",
      [id],
    );
  const items = async (babyId: string) =>
    (
      await h.admin.query(
        `SELECT photo_id, batch_id, state, failure_kind, attempt, cost_usd::float8 AS cost
           FROM public.ai_batch_items WHERE baby_id = $1 ORDER BY created_at, photo_id`,
        [babyId],
      )
    ).rows as {
      photo_id: string;
      batch_id: string;
      state: string;
      failure_kind: string | null;
      attempt: number;
      cost: number | null;
    }[];
  const aiRow = (id: string) =>
    h.one<{
      description: unknown;
      batch_id: string;
      prompt_version: string;
      sensitive_flags: string[];
    }>(
      "SELECT description, batch_id, prompt_version, sensitive_flags FROM public.photo_ai WHERE photo_id = $1",
      [id],
    );
  const batch = (id: string) =>
    h.one<{
      status: string;
      cost_usd: string | null;
      input_tokens: string | null;
      output_tokens: string | null;
      files_deleted_at: Date | null;
      photo_count: number;
      error: string | null;
    }>(
      "SELECT status, cost_usd, input_tokens, output_tokens, files_deleted_at, photo_count, error FROM public.ai_batches WHERE id = $1",
      [id],
    );
  const dumpFor = async () => {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("");
  };

  it("PRD check: a paid baby's photos are described, a free baby's never leave the building", async () => {
    const paid = await h.baby({ plan: "plus" });
    const free = await h.baby({ plan: "free" });
    // The first photo has an id starting with 0: the fake provider flags it as a bath photo.
    const bathId = "0aaaaaaa-1111-4111-8111-000000000001";
    const paidIds = await ingested(paid, 5, [bathId]);
    const freeIds = await ingested(free, 3);
    for (const id of [...paidIds, ...freeIds])
      expect((await photoRow(id))?.status).toBe("ingested");

    const { pipeline, describer, reindexed } = make();
    const flush = await pipeline.flush({ force: true });
    expect(flush.claimed).toBeGreaterThanOrEqual(5);

    // one batch with the five paid photos; the free ones are untouched
    const paidItems = await items(paid.id);
    expect(paidItems).toHaveLength(5);
    expect(new Set(paidItems.map((i) => i.batch_id)).size).toBe(1);
    expect(paidItems.every((i) => i.state === "submitted" && i.attempt === 1)).toBe(true);
    expect(await items(free.id)).toEqual([]);
    for (const id of freeIds) expect((await photoRow(id))?.status).toBe("ingested");
    for (const id of paidIds) expect((await photoRow(id))?.status).toBe("analyzing");

    // describer.requests and the dump files hold the paid ids, none of the free ids
    const sent = describer.requests.map((r) => r.photoId);
    for (const id of paidIds) expect(sent).toContain(id);
    for (const id of freeIds) expect(sent).not.toContain(id);
    expect(
      describer.requests.every((r) => r.plan === "paid" && r.width <= 768 && r.height <= 768),
    ).toBe(true);
    const dump = await dumpFor();
    for (const id of paidIds) expect(dump).toContain(id);
    for (const id of freeIds) expect(dump).not.toContain(id);
    expect(dump).not.toMatch(/latitude|longitude|gps/i);

    // poll twice (second is a no-op)
    const p1 = await pipeline.poll();
    expect(p1.stored).toBeGreaterThanOrEqual(5);
    const p2 = await pipeline.poll();
    expect(p2.stored).toBe(0);

    for (const id of paidIds) {
      const row = await aiRow(id);
      expect(row, id).toBeDefined();
      expect(aiDescriptionV1Schema.safeParse(row?.description).success).toBe(true);
      expect(row?.prompt_version).toBe("v1");
      expect((await photoRow(id))?.status).toBe("ready");
    }
    for (const id of freeIds) {
      expect(await aiRow(id)).toBeUndefined();
      expect((await photoRow(id))?.status).toBe("ingested");
    }
    const done = await items(paid.id);
    expect(done.every((i) => i.state === "succeeded" && (i.cost ?? 0) > 0)).toBe(true);
    const b = await batch(done[0]?.batch_id as string);
    expect(b?.status).toBe("completed");
    expect(Number(b?.cost_usd)).toBeGreaterThan(0);
    expect(Number(b?.cost_usd)).toBeCloseTo(0.0001385 * 5, 5);
    expect(Number(b?.input_tokens)).toBe(1400 * 5);
    expect(Number(b?.output_tokens)).toBe(400 * 5);
    expect(b?.files_deleted_at).not.toBeNull();
    expect(describer.deleteCalls.length).toBeGreaterThanOrEqual(1);

    // the sensitive photo is flagged through the database trigger
    expect((await aiRow(bathId))?.sensitive_flags).toEqual(["bath"]);
    expect((await photoRow(bathId))?.is_sensitive).toBe(true);

    // 5 reindex hand-offs with reason ai, one per stored photo
    const mine = reindexed.filter((j) => j.babyId === paid.id);
    expect(mine.map((j) => j.photoId).sort()).toEqual([...paidIds].sort());
    expect(mine.every((j) => j.reason === "ai")).toBe(true);
    expect(reindexed.filter((j) => j.babyId === free.id)).toEqual([]);

    // monthly cost visible through the database function
    const month = new Date().toISOString().slice(0, 7);
    const cost = await h.one<{ c: string }>(
      "SELECT public.ai_baby_month_cost_usd($1, $2::date)::text AS c",
      [paid.id, `${month}-01`],
    );
    expect(Number(cost?.c)).toBeCloseTo(0.0001385 * 5, 5);
  });

  it("a baby downgraded after the claim but before submission is dropped; the provider never sees the photo", async () => {
    const baby = await h.baby({ plan: "plus" });
    const [id] = await ingested(baby, 1);
    const { pipeline, describer } = make({ cfg: { AI_BATCH_FLUSH_MINUTES: 30 } });
    const first = await pipeline.flush({ babyId: baby.id });
    expect(first.claimed).toBe(1);
    expect((await photoRow(id as string))?.status).toBe("queued");
    await h.admin.query(
      "UPDATE public.babies SET plan = 'free', plan_owner_user_id = NULL, entitlement_expires_at = NULL WHERE id = $1",
      [baby.id],
    );
    const r = await pipeline.flush({ force: true, babyId: baby.id });
    expect(r.dropped).toBe(1);
    expect(describer.requests.map((q) => q.photoId)).not.toContain(id);
    expect(await dumpFor()).not.toContain(id as string);
    expect((await items(baby.id)).map((i) => i.state)).toEqual(["dropped"]);
    expect((await photoRow(id as string))?.status).toBe("ingested");
    expect(await aiRow(id as string)).toBeUndefined();
  });

  it("a baby downgraded after submission: the result is billed but never stored", async () => {
    const baby = await h.baby({ plan: "plus" });
    const [id] = await ingested(baby, 1);
    const { pipeline, reindexed } = make();
    await pipeline.flush({ force: true, babyId: baby.id });
    await h.admin.query(
      "UPDATE public.babies SET plan = 'free', plan_owner_user_id = NULL, entitlement_expires_at = NULL WHERE id = $1",
      [baby.id],
    );
    await pipeline.poll();
    expect(await aiRow(id as string)).toBeUndefined();
    expect((await photoRow(id as string))?.status).toBe("ingested");
    expect((await items(baby.id)).map((i) => i.state)).toEqual(["dropped"]);
    expect(reindexed.filter((j) => j.babyId === baby.id)).toEqual([]);
  });

  it("a trashed photo is dropped at the re-check", async () => {
    const baby = await h.baby({ plan: "plus" });
    const [id] = await ingested(baby, 1);
    const { pipeline, describer } = make({ cfg: { AI_BATCH_FLUSH_MINUTES: 30 } });
    await pipeline.flush({ babyId: baby.id });
    await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [id]);
    const r = await pipeline.flush({ force: true, babyId: baby.id });
    expect(r.dropped).toBe(1);
    expect(describer.requests.map((q) => q.photoId)).not.toContain(id);
  });

  it("scripted invalid output: failed, retried once, then stored; a persistent failure stops at two attempts", async () => {
    const baby = await h.baby({ plan: "plus" });
    const [recover, stuck] = await ingested(baby, 2);
    const { pipeline } = make({
      script: (photoId, attempt) =>
        photoId === stuck ? "invalid_output" : attempt === 1 ? "invalid_output" : "ok",
    });
    await pipeline.flush({ force: true, babyId: baby.id });
    const p1 = await pipeline.poll();
    expect(p1.failed).toBeGreaterThanOrEqual(2);
    for (const id of [recover, stuck]) {
      expect((await photoRow(id as string))?.status).toBe("ingested"); // never failed
      expect(await aiRow(id as string)).toBeUndefined();
    }
    expect(
      (await items(baby.id)).every(
        (i) => i.state === "failed" && i.failure_kind === "invalid_output",
      ),
    ).toBe(true);

    await pipeline.flush({ force: true, babyId: baby.id });
    await pipeline.poll();
    expect((await photoRow(recover as string))?.status).toBe("ready");
    expect(
      aiDescriptionV1Schema.safeParse((await aiRow(recover as string))?.description).success,
    ).toBe(true);
    const stuckItems = (await items(baby.id)).filter((i) => i.photo_id === stuck);
    expect(stuckItems.map((i) => [i.attempt, i.state])).toEqual([
      [1, "failed"],
      [2, "failed"],
    ]);

    // no third attempt, until an admin asks for a retry
    const third = await pipeline.flush({ force: true, babyId: baby.id });
    expect(third.claimed).toBe(0);
    await h.admin.query("UPDATE public.photos SET ai_retry_requested_at = now() WHERE id = $1", [
      stuck,
    ]);
    const fourth = await pipeline.flush({ force: true, babyId: baby.id });
    expect(fourth.claimed).toBe(1);
    expect((await items(baby.id)).filter((i) => i.photo_id === stuck).at(-1)).toMatchObject({
      attempt: 1,
      state: "submitted",
    });
  });

  it("scripted refusal: failed with its cost recorded, nothing stored", async () => {
    const baby = await h.baby({ plan: "plus" });
    const [id] = await ingested(baby, 1);
    const { pipeline } = make({ script: () => "refusal" });
    await pipeline.flush({ force: true, babyId: baby.id });
    await pipeline.poll();
    const [item] = await items(baby.id);
    expect(item).toMatchObject({ state: "failed", failure_kind: "refusal" });
    expect(item?.cost).toBeGreaterThan(0);
    expect(await aiRow(id as string)).toBeUndefined();
  });

  it("scripted expiry: the item is failed 'expired', the batch expired, the photo back in the queue", async () => {
    const baby = await h.baby({ plan: "plus" });
    const [id] = await ingested(baby, 1);
    const { pipeline } = make({ script: () => "expired" });
    await pipeline.flush({ force: true, babyId: baby.id });
    await pipeline.poll();
    const [item] = await items(baby.id);
    expect(item).toMatchObject({ state: "failed", failure_kind: "expired" });
    expect((await batch(item?.batch_id as string))?.status).toBe("expired");
    expect((await photoRow(id as string))?.status).toBe("ingested");
    // and it is eligible again (an expired attempt counts, but one attempt is below the limit of 2)
    expect((await pipeline.flush({ force: true, babyId: baby.id })).claimed).toBe(1);
  });

  it("a version backfill re-describes and replaces the row; the photo stays visible", async () => {
    const baby = await h.baby({ plan: "plus" });
    const [id] = await ingested(baby, 1);
    const { pipeline, reindexed } = make();
    await pipeline.flush({ force: true, babyId: baby.id });
    await pipeline.poll();
    const before = await aiRow(id as string);
    expect(before?.prompt_version).toBe("v1");
    // the stored row predates the current prompt
    await h.admin.query("UPDATE public.photo_ai SET prompt_version = 'v0' WHERE photo_id = $1", [
      id,
    ]);
    // a regular flush leaves described photos alone
    expect((await pipeline.flush({ force: true, babyId: baby.id })).claimed).toBe(0);
    const r = await pipeline.backfill({ reason: "version", babyId: baby.id });
    expect(r.claimed).toBe(1);
    await pipeline.poll();
    const after = await aiRow(id as string);
    expect(after?.prompt_version).toBe("v1");
    expect(after?.batch_id).not.toBe(before?.batch_id);
    expect((await photoRow(id as string))?.status).toBe("ready");
    expect(reindexed.filter((j) => j.photoId === id)).toHaveLength(2);
    expect((await items(baby.id)).map((i) => i.state)).toEqual(["succeeded", "succeeded"]);
  });

  it("the upgrade backfill describes a baby that just became paid, and nobody else", async () => {
    const baby = await h.baby({ plan: "free" });
    const other = await h.baby({ plan: "free" });
    const [id] = await ingested(baby, 1);
    const [otherId] = await ingested(other, 1);
    const { pipeline, describer } = make();
    // free: nothing, even when forced and named
    expect((await pipeline.backfill({ reason: "upgrade", babyId: baby.id })).claimed).toBe(0);
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [baby.id]);
    const r = await pipeline.backfill({ reason: "upgrade", babyId: baby.id });
    expect(r.claimed).toBe(1);
    await pipeline.poll();
    expect((await photoRow(id as string))?.status).toBe("ready");
    expect((await photoRow(otherId as string))?.status).toBe("ingested");
    expect(describer.requests.map((q) => q.photoId)).not.toContain(otherId);
  });

  it("the per-baby budget skips the photos and audits once per month, even across restarts", async () => {
    const baby = await h.baby({ plan: "plus" });
    const ids = await ingested(baby, 2);
    const cfg = { AI_BABY_MONTHLY_BUDGET_USD: 0.0001 };
    const a = make({ cfg });
    const r1 = await a.pipeline.flush({ force: true, babyId: baby.id });
    expect(r1).toMatchObject({ claimed: 0, budgetSkipped: 2 });
    // a "restart": a brand new pipeline instance has no in-process memory of the first one
    const b = make({ cfg });
    await b.pipeline.flush({ force: true, babyId: baby.id });
    await b.pipeline.flush({ force: true, babyId: baby.id });
    expect(await items(baby.id)).toEqual([]);
    expect(a.describer.requests.map((q) => q.photoId)).not.toContain(ids[0]);
    for (const id of ids) expect((await photoRow(id))?.status).toBe("ingested");
    const month = new Date().toISOString().slice(0, 7);
    const audit = await h.admin.query(
      "SELECT metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'ai.budget_exceeded'",
      [baby.id],
    );
    expect(audit.rows).toEqual([{ metadata: { month } }]);
  });

  it("with no provider configured nothing is claimed, queued or sent", async () => {
    const baby = await h.baby({ plan: "plus" });
    const [id] = await ingested(baby, 1);
    const { pipeline } = make({ describer: null });
    expect(await pipeline.flush({ force: true, babyId: baby.id })).toMatchObject({
      skipped: true,
      claimed: 0,
    });
    expect(await pipeline.poll()).toMatchObject({ skipped: true });
    expect(await items(baby.id)).toEqual([]);
    expect((await photoRow(id as string))?.status).toBe("ingested");
    expect(h.log.lines.some((l) => l.msg.startsWith("AI skipped"))).toBe(true);
  });

  it("an unchanged photo never enters two batches (an in-flight item blocks a second flush)", async () => {
    const baby = await h.baby({ plan: "plus" });
    const [id] = await ingested(baby, 1);
    const { pipeline } = make({ pollsUntilComplete: 5 });
    await pipeline.flush({ force: true, babyId: baby.id });
    const again = await pipeline.flush({ force: true, babyId: baby.id });
    expect(again.claimed).toBe(0);
    expect((await items(baby.id)).filter((i) => i.photo_id === id)).toHaveLength(1);
    const p = await pipeline.poll();
    expect(p).toMatchObject({ polled: 1, terminal: 0 });
  });

  it("queueAge reads the oldest eligible photo and open batch from the database", async () => {
    const baby = await h.baby({ plan: "plus" });
    await ingested(baby, 1);
    await h.admin.query(
      "UPDATE public.photos SET created_at = now() - interval '3 hours' WHERE baby_id = $1",
      [baby.id],
    );
    const { pipeline } = make();
    const age = await pipeline.queueAge();
    expect(age.oldestEligibleMinutes).toBeGreaterThan(170);
  });

  it("logs from a full run never contain a description, a prompt or image data", async () => {
    const text = JSON.stringify(h.log.lines);
    expect(text).not.toMatch(/data:image|base64|detailed_description|search_tags/);
  });
});
