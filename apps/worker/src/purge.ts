import { babyPrefix, photoPrefixes } from "@tinyglow/shared";
import { errorCategory } from "./clients";
import { type PipelinePool, runAsPipeline } from "./db";
import type { WorkerLog } from "./log-types";
import type { ObjectStorage } from "./storage";

// `purge.trash` (docs/plans/step-4.md 2.8, D6; PRD FR-10.2 "hard delete after 30-day trash
// within 24 h", FR-10.3). Hourly, as `pipeline`, in batches. Every object version is deleted
// BEFORE the row, so a crash leaves a row the next run retries, never a row without objects
// being "forgotten". Quarantined photos (CSAM hash match) are never purged automatically: the
// original is evidence and an operator decides; a trashed baby holding one is deferred too (its
// prefix delete would destroy the evidence).
//
// Review fixes (docs/plans/review-fixes.md 2.3, D5): data exports.
//   5. Stale exports (a job that died: `running` for > 5 h, past the 4-hour job expiry, or
//      `queued` for > 1 day) are marked `failed/internal` + audit `export.failed`.
//   6. Every export ZIP that is no longer downloadable is deleted (all versions), then the row is
//      marked `purged_at` (a `ready` row becomes `expired`) + audit `export.purged`: past
//      `expires_at` (incl. early expiry by an admin), failed or cancelled, requester gone
//      (`requested_by` NULL after account deletion), demoted, left the album or deleted
//      (`export_requester_is_admin()` false), or the album is in the trash. A purged baby's ZIPs
//      go with its prefix (step 1) and its rows by cascade.
//   7. Rows purged more than 30 days ago are deleted.

export const PURGE_BATCH = 100;
const MAX_BATCHES = 50;

export const DUE_BABIES_SQL = `
SELECT b.id
FROM babies b
WHERE b.deleted_at < now() - interval '30 days'
  AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.baby_id = b.id AND p.quarantined_at IS NOT NULL)
  AND b.id <> ALL($2::uuid[])
ORDER BY b.deleted_at, b.id
LIMIT $1`;

export const HELD_BABIES_SQL = `
SELECT count(*)::int AS n
FROM babies b
WHERE b.deleted_at < now() - interval '30 days'
  AND EXISTS (SELECT 1 FROM photos p WHERE p.baby_id = b.id AND p.quarantined_at IS NOT NULL)`;

export const DELETE_BABY_SQL = `
DELETE FROM babies WHERE id = $1 AND deleted_at < now() - interval '30 days'`;

export const DUE_PHOTOS_SQL = `
SELECT id, baby_id
FROM photos
WHERE deleted_at < now() - interval '30 days' AND quarantined_at IS NULL
  AND id <> ALL($2::uuid[])
ORDER BY deleted_at, id
LIMIT $1`;

export const DELETE_PHOTO_SQL = `
DELETE FROM photos
WHERE id = $1 AND deleted_at < now() - interval '30 days' AND quarantined_at IS NULL`;

export const AUDIT_PURGED_SQL = `
INSERT INTO audit_log (baby_id, event, metadata) VALUES ($1, 'photo.purged', $2::jsonb)`;

/** Exact-duplicate markers left by a worker that died between marker and delete (10 min grace). */
export const LEFTOVER_DUPLICATES_SQL = `
SELECT id, baby_id
FROM photos
WHERE status = 'duplicate' AND updated_at < now() - interval '10 minutes'
  AND id <> ALL($2::uuid[])
ORDER BY updated_at, id
LIMIT $1`;

export const DELETE_DUPLICATE_SQL = `DELETE FROM photos WHERE id = $1 AND status = 'duplicate'`;

/**
 * Objects of failed/aborted uploads with no photo worth keeping (no photos row, or one rejected
 * as `unsupported_media_type`). Originals of decode failures, storage errors and quarantined
 * photos stay. Looked at for 24 h after the file settled (each hourly run re-checks, so a missed
 * run or a transient error is retried), keyset-paginated.
 */
export const ORPHAN_UPLOADS_SQL = `
SELECT f.id, f.storage_key, f.updated_at
FROM upload_files f
WHERE f.state IN ('failed', 'aborted')
  AND f.updated_at < now() - interval '1 hour'
  AND f.updated_at >= now() - interval '25 hours'
  AND NOT EXISTS (
    SELECT 1 FROM photos p
    WHERE p.id = f.id
      AND (p.quarantined_at IS NOT NULL OR f.error IS DISTINCT FROM 'unsupported_media_type')
  )
  AND (f.updated_at, f.id) > ($2::timestamptz, $3::uuid)
ORDER BY f.updated_at, f.id
LIMIT $1`;

export const STALE_EXPORTS_SQL = `
SELECT id, baby_id
FROM data_exports
WHERE purged_at IS NULL
  AND ((status = 'running' AND started_at < now() - interval '5 hours')
       OR (status = 'queued' AND created_at < now() - interval '1 day'))
  AND id <> ALL($2::uuid[])
ORDER BY created_at, id
LIMIT $1`;

export const FAIL_STALE_EXPORT_SQL = `
UPDATE data_exports SET status = 'failed', error = 'internal', finished_at = now()
WHERE id = $1 AND purged_at IS NULL
  AND ((status = 'running' AND started_at < now() - interval '5 hours')
       OR (status = 'queued' AND created_at < now() - interval '1 day'))`;

export const DUE_EXPORTS_SQL = `
SELECT e.id, e.baby_id, e.storage_key, e.status
FROM data_exports e
LEFT JOIN babies b ON b.id = e.baby_id
WHERE e.purged_at IS NULL
  AND e.status IN ('ready', 'failed', 'expired')
  AND (e.status <> 'ready'
       OR e.expires_at < now()
       OR e.requested_by IS NULL
       OR NOT public.export_requester_is_admin(e.id)
       OR b.deleted_at IS NOT NULL)
  AND e.id <> ALL($2::uuid[])
ORDER BY e.created_at, e.id
LIMIT $1`;

export const MARK_EXPORT_PURGED_SQL = `
UPDATE data_exports
   SET status = CASE WHEN status = 'ready' THEN 'expired' ELSE status END, purged_at = now()
 WHERE id = $1 AND purged_at IS NULL AND status IN ('ready', 'failed', 'expired')`;

export const DELETE_OLD_EXPORTS_SQL = `
DELETE FROM data_exports WHERE purged_at < now() - interval '30 days'`;

export const AUDIT_EXPORT_SQL = `
INSERT INTO audit_log (baby_id, event, metadata) VALUES ($1, $2, $3::jsonb)`;

export interface PurgeDeps {
  pool: PipelinePool;
  storage: ObjectStorage;
  log: WorkerLog;
  batchSize?: number;
}

export interface PurgeResult {
  babies: number;
  babiesHeldForQuarantine: number;
  photos: number;
  duplicates: number;
  orphanUploads: number;
  /** Exports whose job died, marked failed (step 5). */
  exportsStale: number;
  /** Export ZIPs deleted and rows marked purged (step 6). */
  exportsPurged: number;
  /** Export rows purged > 30 days ago, deleted (step 7). */
  exportRowsDeleted: number;
  versionsDeleted: number;
  errors: number;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Repeatedly select a batch, process each id, skip ids that failed in this run. */
async function drain<Row extends { id: string }>(
  deps: PurgeDeps,
  select: string,
  each: (row: Row) => Promise<boolean>,
  onError: (row: Row, err: unknown) => void,
): Promise<number> {
  const batch = deps.batchSize ?? PURGE_BATCH;
  const failed: string[] = [];
  let done = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await runAsPipeline(deps.pool, {}, async (c) => {
      return (await c.query<Row>(select, [batch, failed])).rows;
    });
    for (const row of rows) {
      try {
        if (await each(row)) done++;
      } catch (err) {
        failed.push(row.id);
        onError(row, err);
      }
    }
    if (rows.length < batch) break;
  }
  return done;
}

export async function purgeTrash(deps: PurgeDeps): Promise<PurgeResult> {
  const { pool, storage, log } = deps;
  const result: PurgeResult = {
    babies: 0,
    babiesHeldForQuarantine: 0,
    photos: 0,
    duplicates: 0,
    orphanUploads: 0,
    exportsStale: 0,
    exportsPurged: 0,
    exportRowsDeleted: 0,
    versionsDeleted: 0,
    errors: 0,
  };
  const fail = (what: string) => (row: { id: string }, err: unknown) => {
    result.errors++;
    log.warn({ [what]: row.id, err: errorCategory(err) }, `purge: ${what} deferred`);
  };

  // 1. Babies trashed > 30 days: every object under the baby prefix, then the row (cascades
  //    photos, members, share links, chat, uploads).
  result.babies = await drain<{ id: string }>(
    deps,
    DUE_BABIES_SQL,
    async (row) => {
      result.versionsDeleted += await storage.deleteAllVersions(babyPrefix(row.id));
      return runAsPipeline(pool, {}, async (c) => {
        return ((await c.query(DELETE_BABY_SQL, [row.id])).rowCount ?? 0) > 0;
      });
    },
    fail("babyId"),
  );
  result.babiesHeldForQuarantine = await runAsPipeline(pool, {}, async (c) => {
    return (await c.query<{ n: number }>(HELD_BABIES_SQL)).rows[0]?.n ?? 0;
  });
  if (result.babiesHeldForQuarantine > 0) {
    log.warn(
      { count: result.babiesHeldForQuarantine },
      "purge: trashed babies held back (quarantined photos need an operator decision)",
    );
  }

  // 2. Photos trashed > 30 days (never quarantined ones).
  result.photos = await drain<{ id: string; baby_id: string }>(
    deps,
    DUE_PHOTOS_SQL,
    async (row) => {
      for (const prefix of photoPrefixes(row.baby_id, row.id)) {
        result.versionsDeleted += await storage.deleteAllVersions(prefix);
      }
      return runAsPipeline(pool, {}, async (c) => {
        const deleted = ((await c.query(DELETE_PHOTO_SQL, [row.id])).rowCount ?? 0) > 0;
        if (deleted) {
          await c.query(AUDIT_PURGED_SQL, [row.baby_id, JSON.stringify({ photo_id: row.id })]);
        }
        return deleted;
      });
    },
    fail("photoId"),
  );

  // 3. Leftover exact-duplicate markers.
  result.duplicates = await drain<{ id: string; baby_id: string }>(
    deps,
    LEFTOVER_DUPLICATES_SQL,
    async (row) => {
      for (const prefix of photoPrefixes(row.baby_id, row.id)) {
        result.versionsDeleted += await storage.deleteAllVersions(prefix);
      }
      return runAsPipeline(pool, {}, async (c) => {
        return ((await c.query(DELETE_DUPLICATE_SQL, [row.id])).rowCount ?? 0) > 0;
      });
    },
    fail("photoId"),
  );

  // 4. Orphaned upload objects (keyset pagination: these rows are not deleted).
  let cursor: { at: Date | string; id: string } = { at: "-infinity", id: NIL_UUID };
  const batch = deps.batchSize ?? PURGE_BATCH;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await runAsPipeline(pool, {}, async (c) => {
      return (
        await c.query<{ id: string; storage_key: string; updated_at: Date }>(ORPHAN_UPLOADS_SQL, [
          batch,
          cursor.at,
          cursor.id,
        ])
      ).rows;
    });
    for (const row of rows) {
      try {
        const n = await storage.deleteAllVersions(row.storage_key);
        result.versionsDeleted += n;
        if (n > 0) result.orphanUploads++;
      } catch (err) {
        fail("uploadFileId")(row, err);
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < batch) break;
    cursor = { at: last.updated_at, id: last.id };
  }

  // 5. Exports whose job died.
  result.exportsStale = await drain<{ id: string; baby_id: string }>(
    deps,
    STALE_EXPORTS_SQL,
    async (row) =>
      runAsPipeline(pool, {}, async (c) => {
        const n = (await c.query(FAIL_STALE_EXPORT_SQL, [row.id])).rowCount ?? 0;
        if (n > 0) {
          await c.query(AUDIT_EXPORT_SQL, [
            row.baby_id,
            "export.failed",
            JSON.stringify({ export_id: row.id }),
          ]);
        }
        return n > 0;
      }),
    fail("exportId"),
  );

  // 6. Export ZIPs that can no longer be downloaded: every version, then the row.
  result.exportsPurged = await drain<{
    id: string;
    baby_id: string;
    storage_key: string;
    status: string;
  }>(
    deps,
    DUE_EXPORTS_SQL,
    async (row) => {
      const n = await storage.deleteAllVersions(row.storage_key);
      result.versionsDeleted += n;
      return runAsPipeline(pool, {}, async (c) => {
        const marked = ((await c.query(MARK_EXPORT_PURGED_SQL, [row.id])).rowCount ?? 0) > 0;
        if (marked && (row.status === "ready" || n > 0)) {
          await c.query(AUDIT_EXPORT_SQL, [
            row.baby_id,
            "export.purged",
            JSON.stringify({ export_id: row.id }),
          ]);
        }
        return marked;
      });
    },
    fail("exportId"),
  );

  // 7. Purged export rows after 30 days.
  result.exportRowsDeleted = await runAsPipeline(pool, {}, async (c) => {
    return (await c.query(DELETE_OLD_EXPORTS_SQL)).rowCount ?? 0;
  });

  log.info({ ...result }, "purge: done");
  return result;
}
