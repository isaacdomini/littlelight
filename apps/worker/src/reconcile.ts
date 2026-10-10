import type { IngestJob } from "@tinyglow/shared";
import { errorCategory } from "./clients";
import { type PipelinePool, runAsPipeline } from "./db";
import type { WorkerLog } from "./log-types";

// `ingest.reconcile` (docs/plans/step-4.md 2.5, R5): every 5 minutes, re-send `photo.ingest` for
// photos still `uploaded` two minutes after completion. Covers a lost API send, an API restart
// between commit and send, and worker crashes. The `exclusive` queue policy keyed by photoId
// makes a re-send of a queued/active photo a no-op. `tzHint` cannot be recovered here
// (`pipeline` has no access to `profiles.timezone`), so EXIF wall times without an offset tag are
// read as UTC for these photos.

export const RECONCILE_SQL = `
SELECT id, baby_id
FROM photos
WHERE status = 'uploaded' AND created_at < now() - interval '2 minutes'
  AND deleted_at IS NULL AND quarantined_at IS NULL
ORDER BY created_at, id
LIMIT 500`;

export interface ReconcileDeps {
  pool: PipelinePool;
  /** `boss.send(JOBS.ingest, job, ingestSendOptions(job.photoId))`; null = already queued. */
  send(job: IngestJob): Promise<string | null>;
  log: WorkerLog;
}

export interface ReconcileResult {
  stuck: number;
  sent: number;
  alreadyQueued: number;
  failed: number;
}

export async function reconcileIngest(deps: ReconcileDeps): Promise<ReconcileResult> {
  const rows = await runAsPipeline(deps.pool, {}, async (c) => {
    const res = await c.query<{ id: string; baby_id: string }>(RECONCILE_SQL);
    return res.rows;
  });
  const result: ReconcileResult = { stuck: rows.length, sent: 0, alreadyQueued: 0, failed: 0 };
  for (const row of rows) {
    try {
      const id = await deps.send({ photoId: row.id, babyId: row.baby_id });
      if (id) result.sent++;
      else result.alreadyQueued++;
    } catch (err) {
      result.failed++;
      deps.log.warn({ photoId: row.id, err: errorCategory(err) }, "reconcile: send failed");
    }
  }
  if (result.stuck > 0) deps.log.info({ ...result }, "reconcile: re-sent stuck photos");
  else deps.log.debug({ ...result }, "reconcile: nothing stuck");
  return result;
}
