import {
  type PushNotifyJob,
  type ReindexJob,
  type ReindexReason,
  reindexJobSchema,
} from "@tinyglow/shared";
import type { JobWithMetadata } from "pg-boss";
import type { ReconcileResult, ReindexResult, SearchIndexer } from "./ai";
import { errorCategory } from "./clients";
import { type PipelinePool, runAsPipeline } from "./db";
import type { WorkerLog } from "./log-types";
import type { AutoShareResult, AutoSharer } from "./sharing/autoshare";

// `photo.reindex` handler (docs/plans/step-5.md 2.5, docs/plans/step-7.md 2.7). The API enqueues
// one job per photo after every committed edit that changes its search document (details,
// milestone rename/delete, linked measurement, AI override) and the AI poller after a new
// `photo_ai` row; the payload carries ids and a reason only. pg-boss hands this handler a batch
// of up to `REINDEX_BATCH_SIZE` jobs; the valid ones go to the search indexer in ONE call (one
// embedding request per batch). The indexer re-reads everything at run time and checks
// `baby_ai_enabled` in SQL before any embedding call: a free-tier id is skipped (no model call,
// no row), never an error. Indexer errors (database, provider) propagate so pg-boss retries the
// batch (`retryLimit 3`); the hourly `search.reconcile` is the backstop for anything dropped.
//
// Step 8 (docs/plans/step-8.md 2.8, D16; PRD "AI pipeline" stage 6 "Post-process: auto-share rules
// run"): before indexing, the batch's photos go through the auto-sharer (`evaluatePhotos`). This
// handler runs after every new `photo_ai` row (`reason: "ai"`) and every details / milestone /
// override edit, which is exactly "after AI analysis and on details change". An auto-share failure
// is logged (error category only) and never blocks indexing or fails the batch; the hourly
// `share.reconcile` repairs it.
//
// Step 9 (docs/plans/step-9.md 2.8; PRD "Capacitor plugins": "23 photos analyzed"): after the
// batch was indexed (so the photos are searchable when the notification arrives), the babies of
// its `reason: "ai"` photos that still have AI enabled get one `push.notify {kind:
// "photos_analyzed", babyId}` each, delayed by `PUSH_PHOTOS_DEBOUNCE_SEC`; the `short` queue
// coalesces the rest of the poller's burst into that one job. The hook has its own try/catch: a
// push failure is logged (error category only) and never fails or retries the batch. An
// indexing failure throws before the hook, and the retried batch sends it.

/** The search indexer (`apps/worker/src/ai/search-index.ts`, docs/plans/step-7.md 2.6). */
export type { ReconcileResult, ReindexResult, SearchIndexer };

export interface ReindexDeps {
  indexer: Pick<SearchIndexer, "reindex">;
  /**
   * Stage 6 auto-share (docs/plans/step-8.md 2.8). Omitted only by unit tests that do not exercise
   * it; `startWorkers` and run-job always set it.
   */
  autoSharer?: Pick<AutoSharer, "evaluatePhotos">;
  /**
   * Step 9 push enqueue for `reason: "ai"` jobs (docs/plans/step-9.md 2.8). Omitted only by unit
   * tests that do not exercise it; `startWorkers` and run-job always set it.
   */
  pushHook?: {
    pool: PipelinePool;
    /** Enqueues one `push.notify` (with the photos debounce); null when one is already queued. */
    send: (job: PushNotifyJob) => Promise<string | null>;
  };
  log: WorkerLog;
}

export interface ReindexBatchOutcome {
  /** Distinct photo ids handed to the indexer (empty when every payload was invalid). */
  photoIds: string[];
  /** Payloads dropped as malformed. */
  invalid: number;
  /** The indexer's result; null when nothing valid was in the batch. */
  result: ReindexResult | null;
  /** The auto-sharer's result; null when nothing valid was in the batch or it failed. */
  autoShare: AutoShareResult | null;
  /**
   * Babies a `photos_analyzed` push was enqueued (or coalesced) for; present only when the
   * handler has a `pushHook` and the batch had valid jobs.
   */
  pushEnqueued?: number;
}

/**
 * Babies of these photos that have AI enabled (`baby_ai_enabled`: Plus, not trashed), as
 * `pipeline`. Photos deleted since are simply absent.
 */
const PUSH_BABIES_SQL = `
  SELECT x.baby_id
    FROM (SELECT DISTINCT p.baby_id FROM public.photos p WHERE p.id = ANY($1::uuid[])) x
   WHERE public.baby_ai_enabled(x.baby_id)`;

/**
 * The reindex push hook: one `photos_analyzed` enqueue per AI-enabled baby of `photoIds`. Never
 * throws; returns the number of babies a send was attempted and accepted or coalesced for.
 */
export async function enqueuePhotosAnalyzed(
  hook: NonNullable<ReindexDeps["pushHook"]>,
  log: WorkerLog,
  photoIds: readonly string[],
): Promise<number> {
  if (photoIds.length === 0) return 0;
  let babies: string[];
  try {
    babies = await runAsPipeline(hook.pool, {}, async (client) => {
      const { rows } = await client.query<{ baby_id: string }>(PUSH_BABIES_SQL, [[...photoIds]]);
      return rows.map((r) => r.baby_id);
    });
  } catch (err) {
    log.warn(
      { photos: photoIds.length, err: errorCategory(err) },
      "reindex: could not resolve babies for the photos-analyzed push (skipped)",
    );
    return 0;
  }
  let enqueued = 0;
  for (const babyId of babies) {
    try {
      await hook.send({ kind: "photos_analyzed", babyId });
      enqueued += 1;
    } catch (err) {
      log.warn(
        { babyId, err: errorCategory(err) },
        "reindex: could not enqueue the photos-analyzed push (skipped)",
      );
    }
  }
  return enqueued;
}

/**
 * The reason passed to the indexer for a batch (a log/metric label: the indexer decides what to
 * do from the database, not from the reason): the most frequent reason in the batch, ties broken
 * by `REINDEX_REASONS` order of first appearance.
 */
export function batchReason(jobs: readonly Pick<ReindexJob, "reason">[]): ReindexReason {
  const counts = new Map<ReindexReason, number>();
  for (const job of jobs) counts.set(job.reason, (counts.get(job.reason) ?? 0) + 1);
  let best: ReindexReason = jobs[0]?.reason ?? "backfill";
  for (const [reason, n] of counts) if (n > (counts.get(best) ?? 0)) best = reason;
  return best;
}

/**
 * The `photo.reindex` handler for one pg-boss batch (exported for run-job and tests). Malformed
 * payloads are dropped with a warning that carries the job id only; the rest are de-duplicated
 * by photo id, evaluated by the auto-sharer, then indexed in one `indexer.reindex` call.
 */
export async function handleReindexJobs(
  deps: ReindexDeps,
  jobs: ReadonlyArray<Pick<JobWithMetadata<unknown>, "id" | "data">>,
): Promise<ReindexBatchOutcome> {
  const valid: ReindexJob[] = [];
  let invalid = 0;
  for (const job of jobs) {
    const parsed = reindexJobSchema.safeParse(job.data);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      // A malformed payload can never succeed: complete it without touching anything.
      invalid += 1;
      deps.log.warn({ jobId: job.id }, "reindex: invalid job payload, dropped");
    }
  }
  const photoIds = [...new Set(valid.map((j) => j.photoId))];
  if (photoIds.length === 0) return { photoIds, invalid, result: null, autoShare: null };

  const reason = batchReason(valid);
  const reasons: Partial<Record<ReindexReason, number>> = {};
  for (const j of valid) reasons[j.reason] = (reasons[j.reason] ?? 0) + 1;
  const started = performance.now();
  // Stage 6 first (plan 2.8): its own try/catch so indexing always runs.
  let autoShare: AutoShareResult | null = null;
  try {
    autoShare = deps.autoSharer ? await deps.autoSharer.evaluatePhotos(photoIds) : null;
  } catch (err) {
    deps.log.warn(
      { photos: photoIds.length, err: errorCategory(err) },
      "reindex: auto-share failed (share.reconcile will repair it)",
    );
  }
  const result = await deps.indexer.reindex(photoIds, reason);
  // Step 9 push hook, after indexing; `enqueuePhotosAnalyzed` never throws.
  let pushEnqueued: number | undefined;
  if (deps.pushHook) {
    const aiPhotoIds = [...new Set(valid.filter((j) => j.reason === "ai").map((j) => j.photoId))];
    pushEnqueued = await enqueuePhotosAnalyzed(deps.pushHook, deps.log, aiPhotoIds);
  }
  deps.log.debug(
    {
      photos: photoIds.length,
      invalid,
      reasons,
      ...(pushEnqueued !== undefined ? { pushEnqueued } : {}),
      ms: Math.round(performance.now() - started),
    },
    "reindex: batch done",
  );
  return {
    photoIds,
    invalid,
    result,
    autoShare,
    ...(pushEnqueued !== undefined ? { pushEnqueued } : {}),
  };
}
