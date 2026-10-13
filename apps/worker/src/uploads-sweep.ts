import { VIDEO_SCRATCH_MIN_FREE_BYTES } from "@tinyglow/shared";
import { errorCategory } from "./clients";
import { type PipelinePool, runAsPipeline } from "./db";
import type { WorkerLog } from "./log-types";
import type { ObjectStorage } from "./storage";
import { SCRATCH_ACTIVE_MS_DEFAULT, sweepScratch } from "./video/scratch";

// `uploads.sweep` (docs/plans/step-4.md 2.8): twice an hour, abort the multipart uploads of
// files still `registered` in expired sessions (state `aborted`, error `expired`), then abort any
// multipart upload under `babies/` initiated more than 48 h ago that no registered file
// references. `pipeline` reads only the liveness columns of `upload_sessions`. Step 12
// (docs/plans/step-12.md 2.6, review fix M2): then sweep the scratch folder
// (`WORKER_SCRATCH_PATH`): every file older than `VIDEO_SCRATCH_TTL_HOURS` goes, and while free
// space is under `VIDEO_SCRATCH_MIN_FREE_BYTES` the oldest files older than one transcode timeout
// go too — staged originals are re-downloadable, so a low scratch disk always heals itself.

export const SWEEP_BATCH = 200;
const MAX_BATCHES = 25;
const STRAY_AGE_MS = 48 * 3_600_000;

export const EXPIRED_FILES_SQL = `
SELECT f.id, f.storage_key, f.multipart_upload_id
FROM upload_files f
JOIN upload_sessions s ON s.id = f.session_id
WHERE f.state = 'registered' AND s.expires_at < now()
  AND f.id <> ALL($2::uuid[])
ORDER BY f.created_at, f.id
LIMIT $1`;

export const MARK_EXPIRED_SQL = `
UPDATE upload_files SET state = 'aborted', error = 'expired' WHERE id = $1 AND state = 'registered'`;

export const REGISTERED_UPLOAD_IDS_SQL = `
SELECT multipart_upload_id
FROM upload_files
WHERE state = 'registered' AND multipart_upload_id = ANY($1::text[])`;

export interface SweepDeps {
  pool: PipelinePool;
  storage: ObjectStorage;
  log: WorkerLog;
  now?: () => Date;
  batchSize?: number;
  /** `WORKER_SCRATCH_PATH` (step 12); omitted = no scratch sweep. */
  scratchPath?: string;
  /** Low-space threshold of the scratch pass (default `VIDEO_SCRATCH_MIN_FREE_BYTES`). */
  scratchMinFreeBytes?: number;
  /** Files younger than this are never taken by the low-space pass (default `VIDEO_TRANSCODE_TIMEOUT_SEC`). */
  scratchActiveSec?: number;
}

export interface SweepResult {
  expiredFiles: number;
  strayUploads: number;
  errors: number;
  /** Step 12: scratch files removed by the TTL pass / by the low-space pass / kept (young). */
  scratchRemoved?: number;
  scratchLowSpaceRemoved?: number;
  scratchKept?: number;
  scratchFreeBytes?: number;
}

export async function sweepUploads(deps: SweepDeps): Promise<SweepResult> {
  const { pool, storage, log } = deps;
  const now = deps.now ?? (() => new Date());
  const batch = deps.batchSize ?? SWEEP_BATCH;
  const result: SweepResult = { expiredFiles: 0, strayUploads: 0, errors: 0 };

  // 1. Registered files of expired sessions.
  const failed: string[] = [];
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await runAsPipeline(pool, {}, async (c) => {
      return (
        await c.query<{ id: string; storage_key: string; multipart_upload_id: string | null }>(
          EXPIRED_FILES_SQL,
          [batch, failed],
        )
      ).rows;
    });
    for (const row of rows) {
      try {
        if (row.multipart_upload_id) {
          await storage.abortMultipartUpload(row.storage_key, row.multipart_upload_id);
        }
        const changed = await runAsPipeline(pool, {}, async (c) => {
          return ((await c.query(MARK_EXPIRED_SQL, [row.id])).rowCount ?? 0) > 0;
        });
        if (changed) result.expiredFiles++;
      } catch (err) {
        failed.push(row.id);
        result.errors++;
        log.warn({ uploadFileId: row.id, err: errorCategory(err) }, "sweep: abort deferred");
      }
    }
    if (rows.length < batch) break;
  }

  // 2. Stray multipart uploads older than 48 h that no registered file references.
  const cutoff = now().getTime() - STRAY_AGE_MS;
  const stale = (await storage.listMultipartUploads("babies/")).filter(
    (u) => u.initiated !== null && u.initiated.getTime() < cutoff,
  );
  for (let i = 0; i < stale.length; i += 500) {
    const chunk = stale.slice(i, i + 500);
    const referenced = await runAsPipeline(pool, {}, async (c) => {
      const res = await c.query<{ multipart_upload_id: string }>(REGISTERED_UPLOAD_IDS_SQL, [
        chunk.map((u) => u.uploadId),
      ]);
      return new Set(res.rows.map((r) => r.multipart_upload_id));
    });
    for (const u of chunk) {
      if (referenced.has(u.uploadId)) continue;
      try {
        await storage.abortMultipartUpload(u.key, u.uploadId);
        result.strayUploads++;
      } catch (err) {
        result.errors++;
        log.warn({ err: errorCategory(err) }, "sweep: stray abort deferred");
      }
    }
  }

  // 3. Scratch files (step 12): TTL pass, then the low-space pass (see video/scratch.ts).
  if (deps.scratchPath) {
    const scratch = await sweepScratch(deps.scratchPath, {
      now,
      minFreeBytes: deps.scratchMinFreeBytes ?? VIDEO_SCRATCH_MIN_FREE_BYTES,
      activeMs:
        deps.scratchActiveSec !== undefined
          ? deps.scratchActiveSec * 1000
          : SCRATCH_ACTIVE_MS_DEFAULT,
    });
    result.scratchRemoved = scratch.removed;
    result.scratchLowSpaceRemoved = scratch.lowSpaceRemoved;
    result.scratchKept = scratch.kept;
    if (scratch.freeBytes !== undefined) result.scratchFreeBytes = scratch.freeBytes;
    result.errors += scratch.errors;
    if (scratch.lowSpaceRemoved > 0) {
      log.warn(
        { scratchLowSpaceRemoved: scratch.lowSpaceRemoved, scratchFreeBytes: scratch.freeBytes },
        "sweep: scratch low, staged files released",
      );
    }
  }

  if (
    result.expiredFiles +
      result.strayUploads +
      result.errors +
      (result.scratchRemoved ?? 0) +
      (result.scratchLowSpaceRemoved ?? 0) >
    0
  ) {
    log.info({ ...result }, "sweep: done");
  } else {
    log.debug({ ...result }, "sweep: nothing to do");
  }
  return result;
}
