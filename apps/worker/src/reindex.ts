import { type ReindexJob, reindexJobSchema } from "@littlelight/shared";
import type { JobWithMetadata } from "pg-boss";
import type { WorkerLog } from "./log-types";

// `photo.reindex` handler (docs/plans/step-5.md 2.5, D5). Step 5 reserves the queue so the API
// can enqueue after every edit that changes a photo's search document (details, milestone
// rename/delete, linked measurement); there is nothing to index before embeddings exist, so the
// handler validates the payload and returns. It makes NO database, storage or network call.
//
// Step 7 (ai-engineer, `apps/worker/src/ai/**`) replaces the body: re-read everything at run time
// (the payload carries ids and a reason only), return early when `baby_ai_enabled(babyId)` is
// false (free tier: no embedding call, ever), assemble the search document, embed, upsert
// `photo_search`. The `updated_at` columns of photo_details / measurements / milestones are the
// durable "stale" signal its reconcile re-checks (the exclusive policy can drop an edit that
// lands while a job for the same photo is active).

export interface ReindexDeps {
  log: WorkerLog;
}

export type ReindexOutcome = { outcome: "noop"; job: ReindexJob } | { outcome: "invalid" };

/** The `photo.reindex` handler for one job (exported for run-job and tests). Never throws. */
export async function handleReindexJob(
  deps: ReindexDeps,
  job: Pick<JobWithMetadata<unknown>, "id" | "data">,
): Promise<ReindexOutcome> {
  const parsed = reindexJobSchema.safeParse(job.data);
  if (!parsed.success) {
    // A malformed payload can never succeed: complete it without touching anything.
    deps.log.warn({ jobId: job.id }, "reindex: invalid job payload, dropped");
    return { outcome: "invalid" };
  }
  const { photoId, babyId, reason } = parsed.data;
  deps.log.debug({ jobId: job.id, photoId, babyId, reason }, "reindex: no-op until step 7");
  return { outcome: "noop", job: parsed.data };
}
