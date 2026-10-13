import {
  type IngestJob,
  VIDEO_TRANSCODE_STUCK_MINUTES,
  type VideoTranscodeJob,
} from "@tinyglow/shared";
import { errorCategory } from "./clients";
import { type PipelinePool, runAsPipeline } from "./db";
import type { WorkerLog } from "./log-types";

// `ingest.reconcile` (docs/plans/step-4.md 2.5, R5): every 5 minutes, re-send `photo.ingest` for
// photos still `uploaded` two minutes after completion. Covers a lost API send, an API restart
// between commit and send, and worker crashes. The `exclusive` queue policy keyed by photoId
// makes a re-send of a queued/active photo a no-op. `tzHint` cannot be recovered here
// (`pipeline` has no access to `profiles.timezone`), so EXIF wall times without an offset tag are
// read as UTC for these photos. Step 12 (docs/plans/step-12.md 2.6): also re-send
// `video.transcode` for ingested videos whose rendition is still `pending` after
// `VIDEO_TRANSCODE_STUCK_MINUTES` (a lost send, a worker crash mid-transcode, an expired job).

export const RECONCILE_SQL = `
SELECT id, baby_id
FROM photos
WHERE status = 'uploaded' AND created_at < now() - interval '2 minutes'
  AND deleted_at IS NULL AND quarantined_at IS NULL
ORDER BY created_at, id
LIMIT 500`;

/** Ingested videos whose rendition is still pending after `$1` minutes (and not quarantined/trashed). */
export const RECONCILE_VIDEO_SQL = `
SELECT id, baby_id
FROM photos
WHERE media_kind = 'video' AND rendition_status = 'pending' AND status = 'ingested'
  AND updated_at < now() - make_interval(mins => $1)
  AND deleted_at IS NULL AND quarantined_at IS NULL
ORDER BY updated_at, id
LIMIT 200`;

/** Number of videos the predicate above matches (heartbeat `details.videosPendingStuck`). */
export const COUNT_STUCK_VIDEOS_SQL = `
SELECT count(*)::int AS n
FROM photos
WHERE media_kind = 'video' AND rendition_status = 'pending' AND status = 'ingested'
  AND updated_at < now() - make_interval(mins => $1)
  AND deleted_at IS NULL AND quarantined_at IS NULL`;

/** Ingested videos whose rendition has been `pending` for more than `VIDEO_TRANSCODE_STUCK_MINUTES`. */
export async function countStuckVideos(pool: PipelinePool): Promise<number> {
  return runAsPipeline(pool, {}, async (c) => {
    const res = await c.query<{ n: number }>(COUNT_STUCK_VIDEOS_SQL, [
      VIDEO_TRANSCODE_STUCK_MINUTES,
    ]);
    return res.rows[0]?.n ?? 0;
  });
}

/** A video re-sent this many times by this process is logged as a `warn` (review fix S2). */
export const RECONCILE_REPEAT_WARN = 3;
/** Most photo ids remembered for the repeat warning. */
const REPEAT_MEMORY = 10_000;

export interface ReconcileDeps {
  pool: PipelinePool;
  /** `boss.send(JOBS.ingest, job, ingestSendOptions(job.photoId))`; null = already queued. */
  send(job: IngestJob): Promise<string | null>;
  /** `sendVideoTranscode(boss, job)`; null = already queued. Omitted in pre-step-12 tests. */
  sendTranscode?(job: VideoTranscodeJob): Promise<string | null>;
  /** Re-send counts per video (default: one module-level map per process). */
  resendCounts?: Map<string, number>;
  log: WorkerLog;
}

const defaultResendCounts = new Map<string, number>();

export interface ReconcileResult {
  stuck: number;
  sent: number;
  alreadyQueued: number;
  failed: number;
  /** Step 12: pending renditions re-sent to `video.transcode`. */
  videosStuck?: number;
  videosSent?: number;
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
  if (deps.sendTranscode) {
    const videos = await runAsPipeline(deps.pool, {}, async (c) => {
      const res = await c.query<{ id: string; baby_id: string }>(RECONCILE_VIDEO_SQL, [
        VIDEO_TRANSCODE_STUCK_MINUTES,
      ]);
      return res.rows;
    });
    result.videosStuck = videos.length;
    result.videosSent = 0;
    const counts = deps.resendCounts ?? defaultResendCounts;
    for (const row of videos) {
      try {
        const id = await deps.sendTranscode({ photoId: row.id, babyId: row.baby_id });
        if (id) {
          result.videosSent++;
          const n = (counts.get(row.id) ?? 0) + 1;
          if (counts.size >= REPEAT_MEMORY && !counts.has(row.id)) counts.clear();
          counts.set(row.id, n);
          if (n >= RECONCILE_REPEAT_WARN) {
            deps.log.warn(
              { photoId: row.id, babyId: row.baby_id, resends: n },
              "reconcile: video transcode re-sent repeatedly (deferring every time?)",
            );
          }
        } else result.alreadyQueued++;
      } catch (err) {
        result.failed++;
        deps.log.warn(
          { photoId: row.id, err: errorCategory(err) },
          "reconcile: transcode send failed",
        );
      }
    }
  }
  if (result.stuck > 0 || (result.videosStuck ?? 0) > 0) {
    deps.log.info({ ...result }, "reconcile: re-sent stuck photos");
  } else deps.log.debug({ ...result }, "reconcile: nothing stuck");
  return result;
}
