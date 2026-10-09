import { type ReindexJob, type ReindexReason, reindexJobSchema } from "@littlelight/shared";
import type { JobWithMetadata } from "pg-boss";
import type { ReconcileResult, ReindexResult, SearchIndexer } from "./ai";
import type { WorkerLog } from "./log-types";

// `photo.reindex` handler (docs/plans/step-5.md 2.5, docs/plans/step-7.md 2.7). The API enqueues
// one job per photo after every committed edit that changes its search document (details,
// milestone rename/delete, linked measurement, AI override) and the AI poller after a new
// `photo_ai` row; the payload carries ids and a reason only. pg-boss hands this handler a batch
// of up to `REINDEX_BATCH_SIZE` jobs; the valid ones go to the search indexer in ONE call (one
// embedding request per batch). The indexer re-reads everything at run time and checks
// `baby_ai_enabled` in SQL before any embedding call: a free-tier id is skipped (no model call,
// no row), never an error. Indexer errors (database, provider) propagate so pg-boss retries the
// batch (`retryLimit 3`); the hourly `search.reconcile` is the backstop for anything dropped.

/** The search indexer (`apps/worker/src/ai/search-index.ts`, docs/plans/step-7.md 2.6). */
export type { ReconcileResult, ReindexResult, SearchIndexer };

export interface ReindexDeps {
  indexer: Pick<SearchIndexer, "reindex">;
  log: WorkerLog;
}

export interface ReindexBatchOutcome {
  /** Distinct photo ids handed to the indexer (empty when every payload was invalid). */
  photoIds: string[];
  /** Payloads dropped as malformed. */
  invalid: number;
  /** The indexer's result; null when nothing valid was in the batch. */
  result: ReindexResult | null;
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
 * by photo id and indexed in one `indexer.reindex` call.
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
  if (photoIds.length === 0) return { photoIds, invalid, result: null };

  const reason = batchReason(valid);
  const reasons: Partial<Record<ReindexReason, number>> = {};
  for (const j of valid) reasons[j.reason] = (reasons[j.reason] ?? 0) + 1;
  const started = performance.now();
  const result = await deps.indexer.reindex(photoIds, reason);
  deps.log.debug(
    { photos: photoIds.length, invalid, reasons, ms: Math.round(performance.now() - started) },
    "reindex: batch done",
  );
  return { photoIds, invalid, result };
}
