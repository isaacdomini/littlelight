import {
  AiProviderError,
  AiRequestError,
  assembleVisionRequest,
  estimateVisionRequestBytes,
  isTerminalBatchState,
  type ReasoningEffort,
  readImageInfo,
  systemPromptFor,
  type VisionBatchHandle,
  type VisionBatchState,
  type VisionBatchStatus,
  type VisionContext,
  type VisionDescriber,
  type VisionProvider,
  type VisionRequest,
  type VisionResult,
  validateDescription,
} from "@tinyglow/ai";
import {
  AI_COST_PER_PHOTO_ESTIMATE_USD,
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
  type AiBackfillJob,
  type AiPipelineEnv,
  maxMilestoneConfidence,
  type ReindexJob,
} from "@tinyglow/shared";
import type pg from "pg";
import { errorCategory } from "../clients";
import { type PipelinePool, runAsPipeline } from "../db";
import type { WorkerLog } from "../log-types";
import type { ObjectStorage } from "../storage";
import { buildVisionContext, type PendingRow } from "./context";
import * as SQL from "./sql";

// AI batch pipeline (docs/plans/step-6.md 2.6; PRD FR-5.2/5.3/5.7/5.8, "AI pipeline" stages 2-4,
// "Cost controls", "Reliability and operations").
//
// Invariants:
// - Every app-table query runs through `runAsPipeline(pool, {}, …)`: as `pipeline`, never with
//   the data key (no GPS is needed or selected).
// - Only the `analysis` derivative is read from storage; `plan: "paid"` is set on a request only
//   after the per-photo re-check right before `describeBatch`. The DB triggers
//   (`photos_status_guard`, `ai_batch_items_guard`, `photo_ai_paid_tier_tripwire`) re-check the
//   paid gate on every write regardless.
// - `photos.status` is never set to `failed` by AI (D4); a photo without a result goes back to
//   `ingested` (or `ready` when it keeps an older-version description).
// - Logs carry ids, counts, bytes, token counts, cost, durations and error categories only:
//   never a context field, a description, a prompt, image bytes or a provider message.

/**
 * Pipeline settings: the parsed `aiPipelineEnvSchema` (shared; the fields below are required,
 * the rest such as the cron expressions are accepted and ignored) + provider/model (informational:
 * the describer's own provider/model are what batches are keyed by) + versions + effort.
 */
export type AiPipelineConfig = Pick<
  AiPipelineEnv,
  | "AI_BATCH_MAX_PHOTOS"
  | "AI_BATCH_FLUSH_MINUTES"
  | "AI_BATCH_MAX_BYTES"
  | "AI_MAX_ATTEMPTS"
  | "AI_BABY_MONTHLY_BUDGET_USD"
  | "AI_BUDGET_ALERT_PCT"
  | "AI_QUEUE_AGE_ALERT_MINUTES"
> &
  Partial<AiPipelineEnv> & {
    VISION_PROVIDER?: string;
    VISION_MODEL?: string;
    VISION_REASONING_EFFORT?: ReasoningEffort;
    /** Default `AI_PROMPT_VERSION` / `AI_SCHEMA_VERSION` from `@tinyglow/shared`. */
    promptVersion?: string;
    schemaVersion?: string;
    /** Overrides `VISION_REASONING_EFFORT`; with `none`, reasoning tokens > 0 log a cost warning. */
    reasoningEffort?: ReasoningEffort;
    /** Per-photo estimate for the budget check (default `AI_COST_PER_PHOTO_ESTIMATE_USD`). */
    costEstimateUsd?: number;
  };

export interface AiPipelineDeps {
  /** `runAsPipeline(pool, {}, …)` only; the data key is never bound here. */
  pool: PipelinePool;
  storage: Pick<ObjectStorage, "getObject">;
  /** `createVisionDescriber(env)`; null when AI is not configured (flush/poll then skip). */
  describer: VisionDescriber | null;
  /** Shown in the one-time skip log line, e.g. `OPENAI_API_KEY not set`. Env var names only. */
  disabledReason?: string;
  config: AiPipelineConfig;
  sendReindex: (job: ReindexJob) => Promise<string | null>;
  log: WorkerLog;
  /** Tests. */
  now?: () => Date;
}

export interface FlushOptions {
  /** Submit now regardless of size/age (backfill, run-job). */
  force?: boolean;
  /** Only claim this baby's photos. */
  babyId?: string;
  /** Version backfill: re-describe photos whose `photo_ai` has other versions (FR-5.7). */
  reprocess?: boolean;
}

export interface SubmittedBatch {
  batchId: string;
  providerBatchId: string;
  count: number;
  bytes: number;
}

export interface FlushResult {
  skipped?: true;
  /** Another flush holds the open batch. */
  busy?: boolean;
  claimed: number;
  budgetSkipped: number;
  submitted: SubmittedBatch[];
  /** Items removed by the re-check before submission. */
  dropped: number;
  /** Items whose analysis copy could not be loaded/validated (counted as a failed attempt). */
  unbuildable: number;
  /** Items released back to the queue because the batch hit `AI_BATCH_MAX_BYTES`. */
  deferred: number;
  /** Provider submissions that threw (the batch is retried, then failed after 3). */
  submitErrors: number;
}

export interface PollResult {
  skipped?: true;
  polled: number;
  terminal: number;
  stored: number;
  failed: number;
  reindexSent: number;
  filesDeleted: number;
}

export interface QueueAge {
  oldestEligibleMinutes: number | null;
  oldestOpenBatchMinutes: number | null;
}

export interface AiPipeline {
  flush(opts?: FlushOptions): Promise<FlushResult>;
  poll(): Promise<PollResult>;
  backfill(job: AiBackfillJob): Promise<FlushResult>;
  queueAge(): Promise<QueueAge>;
}

/** A sealed batch whose submitter vanished is retried after this lease. */
export const SUBMIT_LEASE_MINUTES = 15;
/** Provider submissions per batch before it is marked failed. */
export const MAX_SUBMIT_ATTEMPTS = 3;
/** Results written per transaction. */
export const RESULT_CHUNK = 50;
/** Batches polled per tick. */
export const POLL_LIMIT = 50;
/** Forced flushes stop after this many batches (1,000 photos each by default). */
export const MAX_FORCED_ROUNDS = 100;
const LOAD_CONCURRENCY = 8;

type ItemState = "succeeded" | "failed" | "dropped";
type FailureKind = "refusal" | "invalid_output" | "expired" | "rate_limited" | "provider_error";

interface BatchRow {
  id: string;
  provider: string;
  model: string;
  provider_batch_id: string;
  provider_input_file_id: string | null;
  provider_output_file_id: string | null;
  provider_error_file_id: string | null;
  submitted_at: Date | null;
  photo_count: number;
  prompt_version: string | null;
  schema_version: string | null;
  status: string;
  completed_at?: Date | null;
}

interface Prepared {
  photoId: string;
  babyId: string;
  image: VisionRequest["image"];
  context: VisionContext;
}

function emptyFlush(): FlushResult {
  return {
    claimed: 0,
    budgetSkipped: 0,
    submitted: [],
    dropped: 0,
    unbuildable: 0,
    deferred: 0,
    submitErrors: 0,
  };
}

function addFlush(into: FlushResult, r: FlushResult): void {
  into.claimed += r.claimed;
  into.budgetSkipped += r.budgetSkipped;
  into.submitted.push(...r.submitted);
  into.dropped += r.dropped;
  into.unbuildable += r.unbuildable;
  into.deferred += r.deferred;
  into.submitErrors += r.submitErrors;
  if (r.busy) into.busy = true;
}

/** Category of an error for logs and `ai_batches.error`: codes only, never messages. */
export function aiErrorCategory(err: unknown): string {
  if (err instanceof AiRequestError) return `request_${err.code}`;
  if (err instanceof AiProviderError) {
    return err.status === 429
      ? "rate_limited"
      : `provider_${err.status === 0 ? err.code : String(err.status)}`;
  }
  return errorCategory(err);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

const int = (n: number | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;

function toBatchState(state: VisionBatchState): "completed" | "failed" | "expired" | "cancelled" {
  return state === "failed" || state === "expired" || state === "cancelled" ? state : "completed";
}

export function createAiPipeline(deps: AiPipelineDeps): AiPipeline {
  const { pool, storage, describer, log } = deps;
  const cfg = deps.config;
  const promptVersion = cfg.promptVersion ?? AI_PROMPT_VERSION;
  const schemaVersion = cfg.schemaVersion ?? AI_SCHEMA_VERSION;
  const estimate = cfg.costEstimateUsd ?? AI_COST_PER_PHOTO_ESTIMATE_USD;
  const now = deps.now ?? (() => new Date());

  let skipLogged = false;
  let otherProviderWarned = false;
  // Prompt/schema versions this package has a prompt for; checked once (flush skips otherwise).
  let versionError: string | null = null;
  let versionErrorLogged = false;
  try {
    systemPromptFor(promptVersion, schemaVersion);
  } catch (err) {
    versionError = aiErrorCategory(err);
  }
  const budgetAudited = new Set<string>();
  const budgetAlerted = new Set<string>();

  const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => runAsPipeline(pool, {}, fn);

  function skip(): true {
    if (!skipLogged) {
      skipLogged = true;
      log.info(
        {},
        `AI skipped: ${deps.disabledReason ?? "AI not configured"} (photos stay ingested)`,
      );
    }
    return true;
  }

  function utcMonth(): { month: string; firstDay: string } {
    const d = now();
    const month = d.toISOString().slice(0, 7);
    return { month, firstDay: `${month}-01` };
  }

  // -------------------------------------------------------------------------------------------
  // Claim
  // -------------------------------------------------------------------------------------------

  interface ClaimOutcome {
    busy: boolean;
    claimed: number;
    budgetSkipped: number;
    /** Batches sealed in this transaction, to submit now. */
    toSubmit: string[];
  }

  /**
   * State of one `flush()` call. Photos released in the call (dropped by the re-check, failed
   * to build, budget-skipped) are never re-claimed by a later round of the same call, so a
   * transient failure cannot burn several attempts in one run; byte-cap deferrals are not
   * excluded (no attempt is spent; a forced backfill splits by claiming them again).
   */
  interface FlushCtx {
    excluded: Set<string>;
    budgetSkipped: Set<string>;
  }

  /** Per-baby monthly budget: keep as many photos per baby as the remaining budget allows. */
  async function applyBudget(
    c: pg.PoolClient,
    rows: { id: string; baby_id: string; failed_attempts: number }[],
  ): Promise<{ kept: typeof rows; skipped: number; skippedIds: string[] }> {
    const budget = cfg.AI_BABY_MONTHLY_BUDGET_USD;
    const { month, firstDay } = utcMonth();
    const byBaby = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byBaby.get(r.baby_id) ?? [];
      list.push(r);
      byBaby.set(r.baby_id, list);
    }
    const kept: typeof rows = [];
    const skippedIds: string[] = [];
    let skipped = 0;
    for (const [babyId, list] of byBaby) {
      const res = await c.query<{ spent: number }>(SQL.BABY_MONTH_SPEND_SQL, [
        babyId,
        firstDay,
        estimate,
      ]);
      const spent = Number(res.rows[0]?.spent ?? 0);
      const allowed =
        estimate > 0 ? Math.max(0, Math.floor((budget - spent) / estimate + 1e-9)) : list.length;
      kept.push(...list.slice(0, allowed));
      const over = list.length - Math.min(allowed, list.length);
      const key = `${babyId}:${month}`;
      if (over > 0) {
        skipped += over;
        skippedIds.push(...list.slice(Math.min(allowed, list.length)).map((r) => r.id));
        // The in-process set only short-circuits repeat calls; the DB function is the dedupe.
        if (!budgetAudited.has(key)) {
          budgetAudited.add(key);
          const rec = await c.query<{ inserted: boolean }>(SQL.AUDIT_BUDGET_EXCEEDED_SQL, [
            babyId,
            month,
          ]);
          if (rec.rows[0]?.inserted === true) {
            log.warn(
              { babyId, month, spentUsd: spent, budgetUsd: budget, skipped: over },
              "ai budget exceeded: photos wait for next month",
            );
          }
        }
        continue;
      }
      const projected = spent + Math.min(allowed, list.length) * estimate;
      if (projected >= (budget * cfg.AI_BUDGET_ALERT_PCT) / 100 && !budgetAlerted.has(key)) {
        budgetAlerted.add(key);
        log.warn(
          {
            babyId,
            month,
            spentUsd: projected,
            budgetUsd: budget,
            alertPct: cfg.AI_BUDGET_ALERT_PCT,
          },
          "ai budget alert",
        );
      }
    }
    return { kept, skipped, skippedIds };
  }

  async function claim(
    d: VisionDescriber,
    opts: FlushOptions,
    ctx: FlushCtx,
  ): Promise<ClaimOutcome> {
    const key = [d.provider, d.model, promptVersion, schemaVersion];
    return tx(async (c) => {
      const toSubmit: string[] = [];
      // Sealed batches whose submitter died: refresh the lease and submit them again.
      const stale = await c.query<{ id: string }>(SQL.LOCK_STALE_SEALED_SQL, [
        d.provider,
        SUBMIT_LEASE_MINUTES,
      ]);
      for (const row of stale.rows) {
        await c.query(SQL.SEAL_BATCH_SQL, [row.id]);
        toSubmit.push(row.id);
      }

      let batch = (
        await c.query<{ id: string; photo_count: number; created_at: Date }>(
          SQL.LOCK_OPEN_BATCH_SQL,
          key,
        )
      ).rows[0];
      if (!batch) {
        const busy = await c.query<{ busy: boolean }>(SQL.OPEN_BATCH_EXISTS_SQL, key);
        if (busy.rows[0]?.busy) return { busy: true, claimed: 0, budgetSkipped: 0, toSubmit };
      }
      const capacity = cfg.AI_BATCH_MAX_PHOTOS - (batch?.photo_count ?? 0);
      let claimed = 0;
      let budgetSkipped = 0;
      if (capacity > 0) {
        const eligible = await c.query<{ id: string }>(SQL.ELIGIBLE_SQL, [
          capacity,
          promptVersion,
          schemaVersion,
          opts.babyId ?? null,
          opts.reprocess ?? false,
          cfg.AI_MAX_ATTEMPTS,
          [...ctx.excluded],
        ]);
        const ids = eligible.rows.map((r) => r.id);
        if (ids.length) {
          const info = await c.query<{ id: string; baby_id: string; failed_attempts: number }>(
            SQL.CLAIM_INFO_SQL,
            [ids, promptVersion, schemaVersion],
          );
          const { kept, skipped, skippedIds } = await applyBudget(c, info.rows);
          budgetSkipped = skipped;
          for (const id of skippedIds) {
            ctx.excluded.add(id);
            ctx.budgetSkipped.add(id);
          }
          if (kept.length) {
            if (!batch) {
              batch = (
                await c.query<{ id: string; photo_count: number; created_at: Date }>(
                  SQL.INSERT_BATCH_SQL,
                  key,
                )
              ).rows[0];
            }
            if (!batch) throw new Error("ai batch insert returned no row");
            await c.query(SQL.INSERT_ITEMS_SQL, [
              batch.id,
              kept.map((r) => r.id),
              kept.map((r) => r.baby_id),
              kept.map((r) => Math.min(9, 1 + Number(r.failed_attempts ?? 0))),
              promptVersion,
              schemaVersion,
            ]);
            await c.query(SQL.MARK_QUEUED_SQL, [kept.map((r) => r.id)]);
            await c.query(SQL.ADD_PHOTO_COUNT_SQL, [batch.id, kept.length]);
            claimed = kept.length;
          }
        }
      }
      if (batch) {
        const count = batch.photo_count + claimed;
        const ageMin = (now().getTime() - new Date(batch.created_at).getTime()) / 60_000;
        const due =
          count > 0 &&
          (opts.force || count >= cfg.AI_BATCH_MAX_PHOTOS || ageMin >= cfg.AI_BATCH_FLUSH_MINUTES);
        if (due) {
          await c.query(SQL.SEAL_BATCH_SQL, [batch.id]);
          toSubmit.push(batch.id);
        }
        if (claimed) {
          log.info(
            { batchId: batch.id, claimed, photoCount: count, budgetSkipped, sealed: due },
            "ai photos claimed",
          );
        }
      }
      return { busy: false, claimed, budgetSkipped, toSubmit };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------------------------

  async function prepare(
    row: PendingRow,
  ): Promise<{ ok: true; p: Prepared } | { ok: false; photoId: string; reason: string }> {
    if (!row.storage_key) return { ok: false, photoId: row.photo_id, reason: "no_analysis" };
    let bytes: Buffer;
    try {
      bytes = await storage.getObject(row.storage_key);
    } catch (err) {
      return { ok: false, photoId: row.photo_id, reason: `storage_${errorCategory(err)}` };
    }
    const info = readImageInfo(bytes);
    if (!info) return { ok: false, photoId: row.photo_id, reason: "image_unreadable" };
    return {
      ok: true,
      p: {
        photoId: row.photo_id,
        babyId: row.baby_id,
        image: {
          bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          mimeType: info.type,
          width: info.width,
          height: info.height,
        },
        context: buildVisionContext(row),
      },
    };
  }

  async function failWholeBatch(batchId: string, category: string, photoIds: string[]) {
    await tx(async (c) => {
      await c.query(SQL.FAIL_PENDING_ITEMS_SQL, [batchId, photoIds, "provider_error"]);
      await c.query(SQL.RELEASE_PHOTOS_SQL, [photoIds]);
      await c.query(SQL.CLOSE_UNSUBMITTED_BATCH_SQL, [batchId, "failed", category, 0]);
    });
  }

  async function submit(d: VisionDescriber, batchId: string, ctx: FlushCtx): Promise<FlushResult> {
    const result = emptyFlush();
    const started = Date.now();
    const rows = (await tx((c) => c.query<PendingRow>(SQL.LOAD_PENDING_SQL, [batchId]))).rows;
    if (!rows.length) {
      await tx((c) => c.query(SQL.CLOSE_UNSUBMITTED_BATCH_SQL, [batchId, "cancelled", "empty", 0]));
      return result;
    }

    // 1. Build: analysis copy + context (no plan yet).
    const prepared = await mapLimit(rows, LOAD_CONCURRENCY, prepare);
    const unbuildable: string[] = [];
    const reasons = new Map<string, number>();
    const ready: Prepared[] = [];
    for (const p of prepared) {
      if (p.ok) ready.push(p.p);
      else {
        unbuildable.push(p.photoId);
        reasons.set(p.reason, (reasons.get(p.reason) ?? 0) + 1);
      }
    }

    // 2. Re-check right before submission: still approved, live and paid.
    const stillOk = new Set(
      (
        await tx((c) => c.query<{ id: string }>(SQL.RECHECK_SQL, [ready.map((p) => p.photoId)]))
      ).rows.map((r) => r.id),
    );
    const dropped = ready.filter((p) => !stillOk.has(p.photoId)).map((p) => p.photoId);

    // 3. Requests (plan "paid" only now), byte cap.
    const requests: VisionRequest[] = [];
    const deferred: string[] = [];
    let bytes = 0;
    let blanked: string[] = [];
    for (const p of ready) {
      if (!stillOk.has(p.photoId)) continue;
      let request: VisionRequest;
      try {
        const assembled = assembleVisionRequest({
          photoId: p.photoId,
          plan: "paid",
          image: p.image,
          context: p.context,
          promptVersion,
          schemaVersion,
        });
        request = assembled.request;
        if (assembled.warnings.includes("context_coordinates_blanked")) {
          blanked = [...blanked, p.photoId];
        }
      } catch (err) {
        unbuildable.push(p.photoId);
        const reason = aiErrorCategory(err);
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        continue;
      }
      const size = estimateVisionRequestBytes(request);
      if (bytes + size > cfg.AI_BATCH_MAX_BYTES && requests.length > 0) {
        deferred.push(p.photoId);
        continue;
      }
      bytes += size;
      requests.push(request);
    }
    if (blanked.length) {
      log.warn(
        { batchId, photoIds: blanked, warning: "context_coordinates_blanked" },
        "ai context field blanked",
      );
    }
    if (unbuildable.length) {
      log.warn(
        { batchId, count: unbuildable.length, reasons: Object.fromEntries(reasons) },
        "ai photos could not be prepared",
      );
    }
    if (dropped.length || unbuildable.length || deferred.length) {
      await tx(async (c) => {
        if (dropped.length) await c.query(SQL.DROP_ITEMS_SQL, [batchId, dropped]);
        if (unbuildable.length) {
          await c.query(SQL.FAIL_PENDING_ITEMS_SQL, [batchId, unbuildable, "provider_error"]);
        }
        if (deferred.length) await c.query(SQL.RELEASE_ITEMS_SQL, [batchId, deferred]);
        await c.query(SQL.RELEASE_PHOTOS_SQL, [[...dropped, ...unbuildable, ...deferred]]);
      });
    }
    for (const id of [...dropped, ...unbuildable]) ctx.excluded.add(id);
    result.dropped = dropped.length;
    result.unbuildable = unbuildable.length;
    result.deferred = deferred.length;
    if (dropped.length)
      log.info({ batchId, dropped: dropped.length }, "ai items dropped by re-check");
    if (deferred.length) {
      log.info({ batchId, deferred: deferred.length, bytes }, "ai batch byte cap: items deferred");
    }

    if (!requests.length) {
      await tx((c) => c.query(SQL.CLOSE_UNSUBMITTED_BATCH_SQL, [batchId, "cancelled", "empty", 0]));
      return result;
    }

    // 4. Provider call (outside any transaction).
    let handle: VisionBatchHandle;
    try {
      handle = await d.describeBatch(requests);
    } catch (err) {
      const category = aiErrorCategory(err);
      result.submitErrors = 1;
      const attempts =
        Number(
          (await tx((c) => c.query<{ attempts: number }>(SQL.BATCH_SUBMIT_ATTEMPTS_SQL, [batchId])))
            .rows[0]?.attempts ?? 0,
        ) + 1;
      const ids = requests.map((r) => r.photoId);
      if (attempts >= MAX_SUBMIT_ATTEMPTS || err instanceof AiRequestError) {
        await failWholeBatch(batchId, category, ids);
        log.error(
          { batchId, err: category, attempts, count: ids.length },
          "ai batch submission failed for good: items failed, photos released",
        );
      } else {
        await tx((c) => c.query(SQL.SUBMIT_FAILED_SQL, [batchId, category, attempts, ids.length]));
        log.warn(
          { batchId, err: category, attempts },
          "ai batch submission failed: retried next flush",
        );
      }
      return result;
    }

    // 5. Record the submission.
    const ids = requests.map((r) => r.photoId);
    try {
      await tx(async (c) => {
        await c.query(SQL.MARK_SUBMITTED_SQL, [
          batchId,
          handle.batchId,
          handle.inputFileId ?? null,
          handle.submittedAt,
          null,
          bytes,
          ids.length,
        ]);
        await c.query(SQL.MARK_ITEMS_SUBMITTED_SQL, [batchId, ids]);
        await c.query(SQL.MARK_ANALYZING_SQL, [ids]);
      });
    } catch (err) {
      // The provider has the batch but we could not record it: cancel it (best effort) so it is
      // not processed unseen; an operator can delete its artefacts by the logged id.
      log.error(
        { batchId, providerBatchId: handle.batchId, err: errorCategory(err) },
        "ai batch submitted but not recorded; cancelling at the provider",
      );
      await d.cancelBatch(handle).catch(() => undefined);
      throw err;
    }
    result.submitted.push({ batchId, providerBatchId: handle.batchId, count: ids.length, bytes });
    log.info(
      {
        batchId,
        provider: handle.provider,
        providerBatchId: handle.batchId,
        count: ids.length,
        bytes,
        ms: Date.now() - started,
      },
      "ai batch submitted",
    );
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // Flush / backfill
  // -------------------------------------------------------------------------------------------

  async function flush(opts: FlushOptions = {}): Promise<FlushResult> {
    if (!describer) {
      skip();
      return { ...emptyFlush(), skipped: true };
    }
    if (versionError) {
      if (!versionErrorLogged) {
        versionErrorLogged = true;
        log.error(
          { promptVersion, schemaVersion, err: versionError },
          "AI flush disabled: no prompt for the configured prompt/schema version (nothing is claimed)",
        );
      }
      return { ...emptyFlush(), skipped: true };
    }
    const total = emptyFlush();
    const ctx: FlushCtx = { excluded: new Set(), budgetSkipped: new Set() };
    const rounds = opts.force ? MAX_FORCED_ROUNDS : 1;
    for (let round = 0; round < rounds; round++) {
      const c = await claim(describer, opts, ctx);
      total.claimed += c.claimed;
      if (c.busy) total.busy = true;
      let submitFailed = false;
      for (const batchId of c.toSubmit) {
        const r = await submit(describer, batchId, ctx);
        if (r.submitErrors) submitFailed = true;
        addFlush(total, r);
      }
      // A failed provider submission is retried by the next flush tick, never in the same call.
      if (c.busy || c.claimed === 0 || submitFailed) break;
    }
    total.budgetSkipped = ctx.budgetSkipped.size;
    return total;
  }

  async function backfill(job: AiBackfillJob): Promise<FlushResult> {
    const base: FlushOptions = { force: true, ...(job.babyId ? { babyId: job.babyId } : {}) };
    const opts = job.reason === "version" ? { ...base, reprocess: true } : base;
    const res = await flush(opts);
    log.info(
      {
        reason: job.reason,
        babyId: job.babyId ?? null,
        claimed: res.claimed,
        batches: res.submitted.length,
        budgetSkipped: res.budgetSkipped,
      },
      "ai backfill",
    );
    return res;
  }

  // -------------------------------------------------------------------------------------------
  // Poll
  // -------------------------------------------------------------------------------------------

  function handleOf(row: BatchRow): VisionBatchHandle {
    return {
      provider: row.provider as VisionProvider,
      batchId: row.provider_batch_id,
      model: row.model,
      submittedAt: (row.submitted_at ?? new Date(0)).toISOString(),
      requestCount: row.photo_count,
      ...(row.provider_input_file_id ? { inputFileId: row.provider_input_file_id } : {}),
      promptVersion: row.prompt_version ?? promptVersion,
      schemaVersion: row.schema_version ?? schemaVersion,
    };
  }

  /** Item columns from a result; validation decides success. */
  function classify(r: VisionResult): {
    state: ItemState;
    kind: FailureKind | null;
    value?: ReturnType<typeof validateDescription>;
  } {
    if (r.ok) {
      const value = validateDescription(r.raw);
      return value.ok
        ? { state: "succeeded", kind: null, value }
        : { state: "failed", kind: "invalid_output", value };
    }
    return { state: "failed", kind: r.failure };
  }

  function usageParams(r: VisionResult) {
    const u = r.usage;
    return [
      int(u?.inputTokens),
      int(u?.cachedInputTokens),
      int(u?.outputTokens),
      int(u?.reasoningTokens),
      int(u?.imageTokens),
      u && Number.isFinite(u.costUsd) ? u.costUsd : null,
    ];
  }

  async function storeChunk(
    batch: BatchRow,
    model: string,
    chunk: VisionResult[],
  ): Promise<{ stored: ReindexJob[]; failed: number; invalidIssues: number }> {
    const stored: ReindexJob[] = [];
    let failed = 0;
    let invalidIssues = 0;
    await tx(async (c) => {
      for (const r of chunk) {
        const cls = classify(r);
        await c.query("SAVEPOINT ai_result");
        try {
          const claimed = await c.query<{ baby_id: string; ai_enabled: boolean }>(
            SQL.CLAIM_RESULT_SQL,
            [batch.id, r.photoId, cls.state, cls.kind, ...usageParams(r)],
          );
          const item = claimed.rows[0];
          if (!item) {
            // Unknown id or already processed by an earlier poll: idempotent no-op.
            await c.query("RELEASE SAVEPOINT ai_result");
            continue;
          }
          if (cls.state === "succeeded" && cls.value?.ok) {
            if (!item.ai_enabled) {
              // The baby went free after submission: billed, never stored (tripwire).
              await c.query(
                "UPDATE ai_batch_items SET state = 'dropped' WHERE batch_id = $1 AND photo_id = $2",
                [batch.id, r.photoId],
              );
              await c.query(SQL.RELEASE_PHOTOS_SQL, [[r.photoId]]);
              failed++;
            } else {
              const desc = cls.value.value;
              await c.query(SQL.UPSERT_PHOTO_AI_SQL, [
                r.photoId,
                model,
                batch.prompt_version ?? promptVersion,
                batch.schema_version ?? schemaVersion,
                JSON.stringify(desc),
                desc.sensitive_content,
                maxMilestoneConfidence(desc),
                batch.id,
                int(r.usage?.inputTokens),
                int(r.usage?.outputTokens),
              ]);
              await c.query(SQL.MARK_READY_SQL, [r.photoId]);
              stored.push({ photoId: r.photoId, babyId: item.baby_id, reason: "ai" });
            }
          } else {
            if (cls.value && !cls.value.ok) invalidIssues++;
            await c.query(SQL.RELEASE_PHOTOS_SQL, [[r.photoId]]);
            failed++;
          }
          await c.query("RELEASE SAVEPOINT ai_result");
        } catch (err) {
          await c.query("ROLLBACK TO SAVEPOINT ai_result");
          log.warn(
            { batchId: batch.id, photoId: r.photoId, err: errorCategory(err) },
            "ai result could not be stored: item failed",
          );
          await c.query(SQL.CLAIM_RESULT_SQL, [
            batch.id,
            r.photoId,
            "failed",
            "provider_error",
            ...usageParams(r),
          ]);
          await c.query(SQL.RELEASE_PHOTOS_SQL, [[r.photoId]]);
          await c.query("RELEASE SAVEPOINT ai_result");
          failed++;
        }
      }
    });
    return { stored, failed, invalidIssues };
  }

  async function deleteArtifacts(
    d: VisionDescriber,
    row: BatchRow,
    status?: Pick<VisionBatchStatus, "outputFileId" | "errorFileId">,
  ): Promise<boolean> {
    try {
      const ids = status ?? {
        ...(row.provider_output_file_id ? { outputFileId: row.provider_output_file_id } : {}),
        ...(row.provider_error_file_id ? { errorFileId: row.provider_error_file_id } : {}),
      };
      const { deleted } = await d.deleteBatchArtifacts(handleOf(row), ids);
      await tx((c) => c.query(SQL.MARK_FILES_DELETED_SQL, [row.id]));
      log.info({ batchId: row.id, deleted: deleted.length }, "ai provider artifacts deleted");
      return true;
    } catch (err) {
      const ageMin = row.completed_at
        ? (now().getTime() - new Date(row.completed_at).getTime()) / 60_000
        : 0;
      log.warn(
        { batchId: row.id, err: aiErrorCategory(err), overdue: ageMin > 60 },
        "ai provider artifacts not deleted yet: retried next poll",
      );
      return false;
    }
  }

  async function finishBatch(
    d: VisionDescriber,
    row: BatchRow,
    status: VisionBatchStatus,
  ): Promise<{ stored: number; failed: number; reindexSent: number; filesDeleted: number }> {
    const results = status.results ?? [];
    const stored: ReindexJob[] = [];
    let failed = 0;
    let invalid = 0;
    for (let i = 0; i < results.length; i += RESULT_CHUNK) {
      const out = await storeChunk(row, status.handle.model, results.slice(i, i + RESULT_CHUNK));
      stored.push(...out.stored);
      failed += out.failed;
      invalid += out.invalidIssues;
    }
    const terminal = toBatchState(status.state);
    const missingKind: FailureKind =
      terminal === "expired" || terminal === "cancelled" ? "expired" : "provider_error";
    const totals = await tx(async (c) => {
      const missing = await c.query<{ photo_id: string }>(SQL.FAIL_MISSING_ITEMS_SQL, [
        row.id,
        missingKind,
      ]);
      if (missing.rows.length) {
        await c.query(SQL.RELEASE_PHOTOS_SQL, [missing.rows.map((m) => m.photo_id)]);
      }
      const t = await c.query<{ cost_usd: number; reasoning_tokens: number }>(
        SQL.BATCH_TOTALS_SQL,
        [
          row.id,
          terminal,
          status.requestCounts ? JSON.stringify(status.requestCounts) : null,
          status.outputFileId ?? null,
          status.errorFileId ?? null,
          terminal === "failed" ? (status.failureCode ?? "provider_failed") : null,
        ],
      );
      return { missing: missing.rows.length, row: t.rows[0] };
    });
    failed += totals.missing;

    const costUsd = Number(totals.row?.cost_usd ?? 0);
    const reasoning = Number(totals.row?.reasoning_tokens ?? 0);
    const providerCost = status.usage?.costUsd;
    log.info(
      {
        batchId: row.id,
        providerBatchId: row.provider_batch_id,
        state: terminal,
        results: results.length,
        stored: stored.length,
        failed,
        invalid,
        missing: totals.missing,
        costUsd,
        inputTokens: status.usage?.inputTokens,
        cachedInputTokens: status.usage?.cachedInputTokens,
        outputTokens: status.usage?.outputTokens,
        reasoningTokens: reasoning,
      },
      "ai batch finished",
    );
    if (
      typeof providerCost === "number" &&
      Math.abs(providerCost - costUsd) > Math.max(1e-6, 0.01 * Math.max(providerCost, costUsd))
    ) {
      log.warn(
        { batchId: row.id, itemsCostUsd: costUsd, providerCostUsd: providerCost },
        "ai batch cost mismatch between items and provider usage",
      );
    }
    if (
      reasoning > 0 &&
      (cfg.reasoningEffort ?? cfg.VISION_REASONING_EFFORT ?? "none") === "none"
    ) {
      log.warn(
        { batchId: row.id, reasoningTokens: reasoning },
        "ai reasoning tokens billed with effort none (cost tripwire)",
      );
    }

    const deleted = await deleteArtifacts(d, { ...row, completed_at: now() }, status);

    let reindexSent = 0;
    for (const job of stored) {
      try {
        await deps.sendReindex(job);
        reindexSent++;
      } catch (err) {
        log.warn(
          { photoId: job.photoId, err: errorCategory(err) },
          "ai reindex send failed (step 7 reconcile covers it)",
        );
      }
    }
    return { stored: stored.length, failed, reindexSent, filesDeleted: deleted ? 1 : 0 };
  }

  async function poll(): Promise<PollResult> {
    const result: PollResult = {
      polled: 0,
      terminal: 0,
      stored: 0,
      failed: 0,
      reindexSent: 0,
      filesDeleted: 0,
    };
    if (!describer) {
      skip();
      return { ...result, skipped: true };
    }
    const d = describer;
    const { open, other } = await tx(async (c) => ({
      open: (await c.query<BatchRow>(SQL.OPEN_BATCHES_SQL, [d.provider, POLL_LIMIT])).rows,
      other: Number(
        (await c.query<{ n: number }>(SQL.OTHER_PROVIDER_OPEN_SQL, [d.provider])).rows[0]?.n ?? 0,
      ),
    }));
    if (other > 0 && !otherProviderWarned) {
      otherProviderWarned = true;
      log.warn(
        { provider: d.provider, otherProviderOpenBatches: other },
        "ai open batches of another provider are not polled (switch VISION_PROVIDER back to finish them)",
      );
    }
    const touched = new Set<string>();
    for (const row of open) {
      touched.add(row.id);
      let status: VisionBatchStatus;
      try {
        status = await d.pollBatch(handleOf(row));
      } catch (err) {
        log.warn({ batchId: row.id, err: aiErrorCategory(err) }, "ai batch poll failed");
        continue;
      }
      result.polled++;
      if (!isTerminalBatchState(status.state)) {
        await tx((c) =>
          c.query(SQL.UPDATE_PROGRESS_SQL, [
            row.id,
            "in_progress",
            status.requestCounts ? JSON.stringify(status.requestCounts) : null,
            status.outputFileId ?? null,
            status.errorFileId ?? null,
            status.expiresAt ?? null,
          ]),
        );
        log.debug(
          { batchId: row.id, providerStatus: status.providerStatus, counts: status.requestCounts },
          "ai batch in progress",
        );
        continue;
      }
      result.terminal++;
      const out = await finishBatch(d, row, status);
      result.stored += out.stored;
      result.failed += out.failed;
      result.reindexSent += out.reindexSent;
      result.filesDeleted += out.filesDeleted;
    }

    // Terminal batches whose provider artefacts are still there (earlier delete failed).
    const undeleted = (
      await tx((c) => c.query<BatchRow>(SQL.UNDELETED_BATCHES_SQL, [d.provider, 20]))
    ).rows;
    for (const row of undeleted) {
      // A batch finished (and its delete attempted) earlier in this poll waits for the next one.
      if (touched.has(row.id)) continue;
      if (await deleteArtifacts(d, row)) result.filesDeleted++;
    }

    return result;
  }

  // -------------------------------------------------------------------------------------------
  // Queue age
  // -------------------------------------------------------------------------------------------

  async function queueAge(): Promise<QueueAge> {
    const age = await tx(async (c) => {
      const eligible = await c.query<{ minutes: number }>(SQL.OLDEST_ELIGIBLE_SQL, [
        promptVersion,
        schemaVersion,
        cfg.AI_MAX_ATTEMPTS,
      ]);
      const open = await c.query<{ minutes: number | null }>(SQL.OLDEST_OPEN_BATCH_SQL);
      const e = eligible.rows[0]?.minutes;
      const o = open.rows[0]?.minutes;
      return {
        oldestEligibleMinutes: e === undefined || e === null ? null : Number(e),
        oldestOpenBatchMinutes: o === undefined || o === null ? null : Number(o),
      };
    });
    // Free-tier photos are never eligible, so they never count as "queued". Alerting on these
    // ages (> AI_QUEUE_AGE_ALERT_MINUTES) is the heartbeat's sampler (heartbeat.ts).
    return age;
  }

  return { flush, poll, backfill, queueAge };
}
