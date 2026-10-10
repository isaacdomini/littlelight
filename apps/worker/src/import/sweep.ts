import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  auditMetadataSchema,
  IMPORT_PICKING_TTL_MIN,
  type ImportBatchError,
  type ImportGoogleJob,
} from "@tinyglow/shared";
import { errorCategory } from "../clients";
import { type PipelinePool, runAsPipeline } from "../db";
import type { WorkerLog } from "../log-types";
import type { ObjectStorage } from "../storage";
import { importTmpDir } from "./google/download";
import { stateError } from "./google/handler";
import {
  AUDIT_SQL,
  EXPIRE_PICKING_SQL,
  FAIL_ORPHAN_SQL,
  FAIL_STALE_RUNNING_SQL,
  FINISH_BATCH_SQL,
  ORPHAN_DOWNLOADED_SQL,
  QUEUED_BATCHES_SQL,
  REQUESTER_STATE_SQL,
  RETENTION_SQL,
} from "./sql";

// `import.sweep` (cron `37 * * * *`, cluster-wide singleton; docs/plans/step-10.md 2.7, D19), as
// `pipeline`:
// 1. `picking` batches past `picker_expires_at` (or 30 minutes old without one) ⇒ `expired`. The
//    Google session is not deleted here: the worker can obtain a token only for a queued/running
//    batch (`import_google_refresh_token`), and Google expires abandoned sessions itself.
// 2. `queued` batches: a requester who disconnected, left, or whose album is in the trash ⇒ the
//    batch fails (`google_reconnect` / `requester_not_member` / `baby_trashed`); a batch queued for
//    more than 10 minutes otherwise gets its `import.google` job re-sent (a no-op while one is
//    queued or active: `exclusive`, `singletonKey = batchId`). A batch queued for more than 2 h
//    raises one `warn` (the queue-age alert channel of the AI pipeline).
// 3. `running` batches without progress for 2 h ⇒ `failed / internal` (the job expired or died).
// 4. `downloaded` items older than 1 h without a photo row ⇒ object deleted, item `failed /
//    storage_error`.
// 5. Retention: items 30 days after their last change (terminal, or of a finished batch).
// 6. Staged files under `<tmp>/ll-import` older than 1 h ⇒ removed.
// Logs counts and categories only.

export const SWEEP_QUEUED_STUCK_MIN = 10;
export const SWEEP_QUEUED_ALERT_MIN = 120;
export const SWEEP_RUNNING_STALE_MIN = 120;
export const SWEEP_ORPHAN_MIN = 60;
export const SWEEP_TMP_MAX_AGE_MS = 3_600_000;
const BATCH = 200;
const MAX_ROUNDS = 25;
const RETENTION_CHUNK = 1000;

export interface ImportSweepDeps {
  pool: PipelinePool;
  storage: Pick<ObjectStorage, "deleteAllVersions">;
  /** Re-sends `import.google` (null = one is already queued/active). */
  sendImportGoogle: (job: ImportGoogleJob) => Promise<string | null>;
  log: WorkerLog;
  /** Staging dir (default `importTmpDir()`). */
  tmpDir?: string;
  now?: () => Date;
}

export interface ImportSweepResult {
  expired: number;
  resent: number;
  failedQueued: number;
  failedRunning: number;
  orphans: number;
  retained: number;
  tmpRemoved: number;
  errors: number;
}

async function auditFailed(
  c: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  babyId: string,
  batchId: string,
): Promise<void> {
  const metadata = auditMetadataSchema.parse({ batch_id: batchId });
  await c.query(AUDIT_SQL, [babyId, "import.batch_failed", JSON.stringify(metadata)]);
}

export async function sweepImports(deps: ImportSweepDeps): Promise<ImportSweepResult> {
  const { pool, log } = deps;
  const now = deps.now ?? (() => new Date());
  const result: ImportSweepResult = {
    expired: 0,
    resent: 0,
    failedQueued: 0,
    failedRunning: 0,
    orphans: 0,
    retained: 0,
    tmpRemoved: 0,
    errors: 0,
  };

  // 1. Abandoned picker sessions.
  result.expired = await runAsPipeline(pool, {}, async (c) => {
    return (await c.query(EXPIRE_PICKING_SQL, [IMPORT_PICKING_TTL_MIN])).rowCount ?? 0;
  });

  // 2. Queued batches: requester checks, re-sends, age alert.
  const queued = await runAsPipeline(pool, {}, async (c) => {
    return (
      await c.query<{ id: string; baby_id: string; stuck: boolean; age_min: number }>(
        QUEUED_BATCHES_SQL,
        [SWEEP_QUEUED_STUCK_MIN, BATCH],
      )
    ).rows;
  });
  let oldestMin = 0;
  for (const b of queued) {
    try {
      const failed = await runAsPipeline(pool, {}, async (c) => {
        const state =
          (await c.query<{ state: string }>(REQUESTER_STATE_SQL, [b.id])).rows[0]?.state ?? "";
        const err = stateError(state);
        if (err === null || err === "skip") return false;
        const res = await c.query(FINISH_BATCH_SQL, [
          b.id,
          "failed",
          err satisfies ImportBatchError,
        ]);
        if ((res.rowCount ?? 0) === 0) return false;
        await auditFailed(c, b.baby_id, b.id);
        return true;
      });
      if (failed) {
        result.failedQueued++;
        continue;
      }
      oldestMin = Math.max(oldestMin, b.age_min);
      if (b.stuck) {
        const jobId = await deps.sendImportGoogle({ batchId: b.id, babyId: b.baby_id });
        if (jobId) result.resent++;
      }
    } catch (err) {
      result.errors++;
      log.warn(
        { batchId: b.id, category: errorCategory(err) },
        "import.sweep: queued batch deferred",
      );
    }
  }
  if (oldestMin > SWEEP_QUEUED_ALERT_MIN) {
    log.warn(
      {
        alert: "import_queue_age",
        oldestQueuedMin: oldestMin,
        thresholdMin: SWEEP_QUEUED_ALERT_MIN,
      },
      "import queue age above threshold",
    );
  }

  // 3. Running batches without progress.
  result.failedRunning = await runAsPipeline(pool, {}, async (c) => {
    const rows = (
      await c.query<{ id: string; baby_id: string }>(FAIL_STALE_RUNNING_SQL, [
        SWEEP_RUNNING_STALE_MIN,
      ])
    ).rows;
    for (const r of rows) await auditFailed(c, r.baby_id, r.id);
    return rows.length;
  });

  // 4. Orphaned objects of `downloaded` items.
  const deferred = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const rows = await runAsPipeline(pool, {}, async (c) => {
      return (
        await c.query<{ id: string; storage_key: string }>(ORPHAN_DOWNLOADED_SQL, [
          SWEEP_ORPHAN_MIN,
          BATCH,
        ])
      ).rows;
    });
    const todo = rows.filter((r) => !deferred.has(r.id));
    for (const r of todo) {
      try {
        await deps.storage.deleteAllVersions(r.storage_key);
        const n = await runAsPipeline(pool, {}, async (c) => {
          return (await c.query(FAIL_ORPHAN_SQL, [r.id])).rowCount ?? 0;
        });
        result.orphans += n;
      } catch (err) {
        deferred.add(r.id);
        result.errors++;
        log.warn({ itemId: r.id, category: errorCategory(err) }, "import.sweep: orphan deferred");
      }
    }
    if (rows.length < BATCH || todo.length === 0) break;
  }

  // 5. Item retention.
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const n = await runAsPipeline(pool, {}, async (c) => {
      return (await c.query(RETENTION_SQL, [RETENTION_CHUNK])).rowCount ?? 0;
    });
    result.retained += n;
    if (n < RETENTION_CHUNK) break;
  }

  // 6. Staged files left behind by a crashed run.
  const dir = deps.tmpDir ?? importTmpDir();
  const cutoff = now().getTime() - SWEEP_TMP_MAX_AGE_MS;
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    names = []; // no staging dir yet
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await stat(file);
      if (st.mtimeMs < cutoff) {
        await rm(file, { force: true, recursive: true });
        result.tmpRemoved++;
      }
    } catch {
      // vanished meanwhile, or not ours to remove
    }
  }

  const total =
    result.expired +
    result.resent +
    result.failedQueued +
    result.failedRunning +
    result.orphans +
    result.retained +
    result.tmpRemoved +
    result.errors;
  if (total > 0) log.info({ ...result }, "import.sweep: done");
  else log.debug({ ...result }, "import.sweep: nothing to do");
  return result;
}
