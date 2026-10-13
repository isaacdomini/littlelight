import os from "node:os";
import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { errorCategory } from "./clients";

// Worker heartbeat (docs/plans/step-1.md 2.9, docs/plans/step-2.md 2.12). Every interval:
// HeadBucket on S3_BUCKET (+ statfs of the storage mount for the disk alert, step 4 2.11), then
// upsert this worker's `worker_heartbeats` row.
// - `last_seen_at` advances ONLY when storage is reachable, so `healthcheck.ts` (row fresh within
//   HEARTBEAT_STALE_MS) also proves storage.
// - `updated_at` advances on EVERY successful write, storage up or down. Pruning keys off it, so
//   a live worker whose storage is down (last_seen_at stale or epoch) is never pruned by a peer.
// Runs directly as `tinyglow_worker` (direct grant + policy on this table; no SET ROLE).
// Step 6 (docs/plans/step-6.md 2.6, 2.7): `details.aiQueueAgeMin` from an optional sampler
// (`createAiQueueAgeSampler`, at most one query per minute) that also raises the PRD's
// "queue age > 2 h" alert as a `warn` once, and an `info` when it clears. Step 7
// (docs/plans/step-7.md 2.7): `details.searchStale` / `details.searchUnembedded` from the search
// indexer's `stats()`, sampled at most once per 5 minutes (`createSearchStatsSampler`).

/** Unique per container (`--scale worker=3` gives each replica its own hostname). */
export function workerId(): string {
  return os.hostname();
}

/** The slice of `pg.Pool` the heartbeat uses; tests pass a stub. */
export interface HeartbeatDb {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export type HeartbeatStorage = Pick<S3Client, "send">;

export interface HeartbeatDeps {
  db: HeartbeatDb;
  s3: HeartbeatStorage;
  bucket: string;
  workerId: string;
  hostname: string;
  pid: number;
  version: string;
  startedAt: Date;
  /** Budget for the HeadBucket call. */
  storageTimeoutMs?: number;
  /**
   * Storage disk usage in percent (docs/plans/step-4.md 2.11, `disk.ts`); undefined = check
   * disabled or failed. Reported as `details.diskUsedPct`.
   */
  diskUsedPct?: () => Promise<number | undefined>;
  /**
   * Age in minutes of the AI queue (oldest eligible-but-unclaimed photo or oldest open batch,
   * whichever is older; 0 when empty); undefined = AI disabled or the sample failed. Reported as
   * `details.aiQueueAgeMin` (docs/plans/step-6.md 2.7).
   */
  aiQueueAge?: () => Promise<number | undefined>;
  /**
   * Photos whose search row is missing/stale and rows without a vector (counts only);
   * undefined = the sample failed. Reported as `details.searchStale` / `details.searchUnembedded`
   * (docs/plans/step-7.md 2.7).
   */
  searchStats?: () => Promise<SearchStats | undefined>;
  /**
   * Free bytes of the video scratch folder (`WORKER_SCRATCH_PATH`, docs/plans/step-12.md 2.6);
   * undefined = not configured or the sample failed. Reported as `details.scratchFreeBytes`;
   * `createScratchSampler` raises the "scratch low" alert.
   */
  scratchFree?: () => Promise<number | undefined>;
  /**
   * Ingested videos whose rendition has been `pending` longer than `VIDEO_TRANSCODE_STUCK_MINUTES`
   * (`countStuckVideos`); undefined = not configured or the sample failed. Reported as
   * `details.videosPendingStuck`; `createStuckVideosSampler` warns once while it is non-zero.
   */
  videosPendingStuck?: () => Promise<number | undefined>;
}

export interface SearchStats {
  stale: number;
  unembedded: number;
}

export interface HeartbeatResult {
  storageOk: boolean;
  /** Sanitized category when storage failed (e.g. `ECONNREFUSED`, `NotFound`, `timeout`). */
  storageError?: string;
  storageLatencyMs: number;
  diskUsedPct?: number;
  aiQueueAgeMin?: number;
  searchStale?: number;
  searchUnembedded?: number;
  scratchFreeBytes?: number;
  videosPendingStuck?: number;
}

/** Storage reachable: refresh `last_seen_at`. */
export const UPSERT_OK_SQL = `
INSERT INTO worker_heartbeats
  (worker_id, hostname, pid, version, started_at, last_seen_at, storage_ok, details, updated_at)
VALUES ($1, $2, $3, $4, $5, now(), true, $6::jsonb, now())
ON CONFLICT (worker_id) DO UPDATE SET
  hostname = EXCLUDED.hostname,
  pid = EXCLUDED.pid,
  version = EXCLUDED.version,
  started_at = EXCLUDED.started_at,
  last_seen_at = now(),
  storage_ok = true,
  details = EXCLUDED.details,
  updated_at = now()`;

/**
 * Storage unreachable: record it but do NOT advance `last_seen_at`. A brand-new row starts at
 * the epoch so it is stale from the first beat (healthcheck fails until storage recovers).
 * `updated_at` still advances: the worker is alive, so its row must survive peers' pruning.
 */
export const UPSERT_STORAGE_DOWN_SQL = `
INSERT INTO worker_heartbeats
  (worker_id, hostname, pid, version, started_at, last_seen_at, storage_ok, details, updated_at)
VALUES ($1, $2, $3, $4, $5, to_timestamp(0), false, $6::jsonb, now())
ON CONFLICT (worker_id) DO UPDATE SET
  hostname = EXCLUDED.hostname,
  pid = EXCLUDED.pid,
  version = EXCLUDED.version,
  started_at = EXCLUDED.started_at,
  storage_ok = false,
  details = EXCLUDED.details,
  updated_at = now()`;

/**
 * Remove rows of workers that have not written ANY heartbeat for a day (never this worker's own
 * row). Keyed on the always-advancing `updated_at`, not `last_seen_at`, so a live worker with
 * storage down is not deleted (step-1 review S5).
 */
export const PRUNE_SQL = `
DELETE FROM worker_heartbeats
WHERE updated_at < now() - interval '1 day' AND worker_id <> $1`;

async function checkStorage(
  s3: HeartbeatStorage,
  bucket: string,
  timeoutMs: number,
): Promise<HeartbeatResult> {
  const started = performance.now();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }), {
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return { storageOk: true, storageLatencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return {
      storageOk: false,
      storageError:
        name === "TimeoutError" || name === "AbortError" ? "timeout" : errorCategory(err),
      storageLatencyMs: Math.round(performance.now() - started),
    };
  }
}

/** One heartbeat: storage check, then upsert. DB errors propagate to the caller. */
export async function beatOnce(deps: HeartbeatDeps): Promise<HeartbeatResult> {
  const result = await checkStorage(deps.s3, deps.bucket, deps.storageTimeoutMs ?? 5_000);
  const diskUsedPct = deps.diskUsedPct
    ? await deps.diskUsedPct().catch(() => undefined)
    : undefined;
  if (diskUsedPct !== undefined) result.diskUsedPct = diskUsedPct;
  const aiQueueAgeMin = deps.aiQueueAge
    ? await deps.aiQueueAge().catch(() => undefined)
    : undefined;
  if (aiQueueAgeMin !== undefined) result.aiQueueAgeMin = aiQueueAgeMin;
  const search = deps.searchStats ? await deps.searchStats().catch(() => undefined) : undefined;
  if (search !== undefined) {
    result.searchStale = search.stale;
    result.searchUnembedded = search.unembedded;
  }
  const scratchFreeBytes = deps.scratchFree
    ? await deps.scratchFree().catch(() => undefined)
    : undefined;
  if (scratchFreeBytes !== undefined) result.scratchFreeBytes = scratchFreeBytes;
  const videosPendingStuck = deps.videosPendingStuck
    ? await deps.videosPendingStuck().catch(() => undefined)
    : undefined;
  if (videosPendingStuck !== undefined) result.videosPendingStuck = videosPendingStuck;
  const details = {
    storageLatencyMs: result.storageLatencyMs,
    ...(result.storageOk ? {} : { storageError: result.storageError }),
    ...(diskUsedPct !== undefined ? { diskUsedPct } : {}),
    ...(aiQueueAgeMin !== undefined ? { aiQueueAgeMin } : {}),
    ...(search !== undefined
      ? { searchStale: search.stale, searchUnembedded: search.unembedded }
      : {}),
    ...(scratchFreeBytes !== undefined ? { scratchFreeBytes } : {}),
    ...(videosPendingStuck !== undefined ? { videosPendingStuck } : {}),
  };
  await deps.db.query(result.storageOk ? UPSERT_OK_SQL : UPSERT_STORAGE_DOWN_SQL, [
    deps.workerId,
    deps.hostname,
    deps.pid,
    deps.version,
    deps.startedAt,
    JSON.stringify(details),
  ]);
  await deps.db.query(PRUNE_SQL, [deps.workerId]);
  return result;
}

export interface HeartbeatLogger {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

/**
 * Run `beatOnce` immediately and then every `intervalMs` (never overlapping). Errors are logged
 * by category and never stop the loop. Returns `stop()`, which waits for an in-flight beat.
 */
export function startHeartbeat(
  deps: HeartbeatDeps,
  intervalMs: number,
  log: HeartbeatLogger,
): { stop: () => Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let lastStorageOk: boolean | undefined;

  const tick = () => {
    inFlight = beatOnce(deps)
      .then((result) => {
        if (result.storageOk !== lastStorageOk) {
          if (result.storageOk) log.info({ storage: "ok" }, "heartbeat: storage reachable");
          else log.warn({ storage: result.storageError }, "heartbeat: storage unreachable");
          lastStorageOk = result.storageOk;
        } else {
          log.debug({ storageOk: result.storageOk }, "heartbeat");
        }
      })
      .catch((err: unknown) => {
        log.warn({ db: errorCategory(err) }, "heartbeat: failed to write heartbeat row");
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}

/** `createAiPipeline(...).queueAge()` (docs/plans/step-6.md 2.6). */
export type AiQueueAgeSource = () => Promise<{
  oldestEligibleMinutes: number | null;
  oldestOpenBatchMinutes: number | null;
}>;

export interface AiQueueAgeSamplerOptions {
  queueAge: AiQueueAgeSource;
  /** `AI_QUEUE_AGE_ALERT_MINUTES` (PRD: alert when queue age > 2 h). */
  alertMinutes: number;
  log: Pick<HeartbeatLogger, "warn" | "info" | "debug">;
  /** Minimum time between two queries; the cached value is returned in between. */
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * Heartbeat dep for `details.aiQueueAgeMin`: samples `queueAge()` at most once per
 * `minIntervalMs` (default 60 s; the heartbeat beats every 10 s), reports the older of the two
 * ages rounded to whole minutes (0 when nothing is waiting), and logs `warn` once when it passes
 * `alertMinutes` and `info` once when it is back under. Logs ages and the threshold only. A failed
 * sample resolves undefined (logged at debug) until the next sample a minute later.
 */
export function createAiQueueAgeSampler(
  opts: AiQueueAgeSamplerOptions,
): () => Promise<number | undefined> {
  const minIntervalMs = opts.minIntervalMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let sampledAt = Number.NEGATIVE_INFINITY;
  let cached: number | undefined;
  let alerting = false;

  return async () => {
    if (now() - sampledAt < minIntervalMs) return cached;
    sampledAt = now();
    try {
      const age = await opts.queueAge();
      const ages = [age.oldestEligibleMinutes, age.oldestOpenBatchMinutes].filter(
        (m): m is number => typeof m === "number" && Number.isFinite(m),
      );
      cached = Math.max(0, Math.round(Math.max(0, ...ages)));
      const over = cached > opts.alertMinutes;
      if (over && !alerting) {
        opts.log.warn(
          {
            aiQueueAgeMin: cached,
            oldestEligibleMinutes: age.oldestEligibleMinutes,
            oldestOpenBatchMinutes: age.oldestOpenBatchMinutes,
            alertMinutes: opts.alertMinutes,
          },
          "ai: queue age over threshold",
        );
      } else if (!over && alerting) {
        opts.log.info(
          { aiQueueAgeMin: cached, alertMinutes: opts.alertMinutes },
          "ai: queue age back under threshold",
        );
      }
      alerting = over;
      return cached;
    } catch (err) {
      opts.log.debug({ db: errorCategory(err) }, "ai: queue age sample failed");
      cached = undefined;
      return undefined;
    }
  };
}

export interface SearchStatsSamplerOptions {
  /** `createSearchIndexer(...).stats()` (docs/plans/step-7.md 2.6). */
  stats: () => Promise<SearchStats>;
  log: Pick<HeartbeatLogger, "debug">;
  /** Minimum time between two queries (default 5 minutes); the cached value is returned in between. */
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * Heartbeat dep for `details.searchStale` / `details.searchUnembedded`: calls `stats()` at most
 * once per `minIntervalMs` (default 5 min; the heartbeat beats every 10 s and the stale query
 * scans the baby's photos). A failed sample resolves undefined (logged at debug by category)
 * until the next sample.
 */
export function createSearchStatsSampler(
  opts: SearchStatsSamplerOptions,
): () => Promise<SearchStats | undefined> {
  const minIntervalMs = opts.minIntervalMs ?? 300_000;
  const now = opts.now ?? Date.now;
  let sampledAt = Number.NEGATIVE_INFINITY;
  let cached: SearchStats | undefined;

  return async () => {
    if (now() - sampledAt < minIntervalMs) return cached;
    sampledAt = now();
    try {
      const s = await opts.stats();
      cached = { stale: s.stale, unembedded: s.unembedded };
      return cached;
    } catch (err) {
      opts.log.debug({ db: errorCategory(err) }, "search: stats sample failed");
      cached = undefined;
      return undefined;
    }
  };
}

export interface ScratchSamplerOptions {
  /** `scratchFreeBytes(WORKER_SCRATCH_PATH)`. */
  freeBytes: () => Promise<number>;
  /** `VIDEO_SCRATCH_MIN_FREE_BYTES`: below it `video.transcode` defers. */
  minFreeBytes: number;
  log: Pick<HeartbeatLogger, "warn" | "info" | "debug">;
  /** Minimum time between two statfs calls (default 60 s); the cached value is returned in between. */
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * Heartbeat dep for `details.scratchFreeBytes` (docs/plans/step-12.md 2.6, Q8): samples the
 * scratch folder's free space at most once per `minIntervalMs`, logs `warn` once when it drops
 * under `minFreeBytes` ("scratch low": transcodes are deferred) and `info` once when it is back.
 * Logs byte counts and the threshold only, never the path. A failed sample resolves undefined.
 */
export function createScratchSampler(
  opts: ScratchSamplerOptions,
): () => Promise<number | undefined> {
  const minIntervalMs = opts.minIntervalMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let sampledAt = Number.NEGATIVE_INFINITY;
  let cached: number | undefined;
  let alerting = false;

  return async () => {
    if (now() - sampledAt < minIntervalMs) return cached;
    sampledAt = now();
    try {
      cached = await opts.freeBytes();
      const low = cached < opts.minFreeBytes;
      if (low && !alerting) {
        opts.log.warn(
          { scratchFreeBytes: cached, minFreeBytes: opts.minFreeBytes },
          "video: scratch low, transcodes deferred",
        );
      } else if (!low && alerting) {
        opts.log.info(
          { scratchFreeBytes: cached, minFreeBytes: opts.minFreeBytes },
          "video: scratch space back over threshold",
        );
      }
      alerting = low;
      return cached;
    } catch (err) {
      opts.log.debug({ err: errorCategory(err) }, "video: scratch sample failed");
      cached = undefined;
      return undefined;
    }
  };
}

export interface StuckVideosSamplerOptions {
  /** `countStuckVideos(pool)`. */
  count: () => Promise<number>;
  log: Pick<HeartbeatLogger, "warn" | "info" | "debug">;
  /** Minimum time between two queries (default 5 minutes); the cached value is returned in between. */
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * Heartbeat dep for `details.videosPendingStuck` (review fix S2): samples at most once per
 * `minIntervalMs`, warns once when videos are stuck `pending` past the reconcile threshold and
 * logs `info` once when none is left. Counts only; a failed sample resolves undefined.
 */
export function createStuckVideosSampler(
  opts: StuckVideosSamplerOptions,
): () => Promise<number | undefined> {
  const minIntervalMs = opts.minIntervalMs ?? 300_000;
  const now = opts.now ?? Date.now;
  let sampledAt = Number.NEGATIVE_INFINITY;
  let cached: number | undefined;
  let alerting = false;

  return async () => {
    if (now() - sampledAt < minIntervalMs) return cached;
    sampledAt = now();
    try {
      cached = await opts.count();
      const stuck = cached > 0;
      if (stuck && !alerting) {
        opts.log.warn({ videosPendingStuck: cached }, "video: renditions stuck pending");
      } else if (!stuck && alerting) {
        opts.log.info({ videosPendingStuck: 0 }, "video: no rendition stuck pending");
      }
      alerting = stuck;
      return cached;
    } catch (err) {
      opts.log.debug({ db: errorCategory(err) }, "video: stuck sample failed");
      cached = undefined;
      return undefined;
    }
  };
}
