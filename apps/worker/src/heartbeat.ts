import os from "node:os";
import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { errorCategory } from "./clients";

// Worker heartbeat (docs/plans/step-1.md 2.9). Every interval: HeadBucket on S3_BUCKET, then
// upsert this worker's `worker_heartbeats` row. `last_seen_at` advances ONLY when storage is
// reachable, so `healthcheck.ts` (row fresh within HEARTBEAT_STALE_MS) also proves storage.

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
}

export interface HeartbeatResult {
  storageOk: boolean;
  /** Sanitized category when storage failed (e.g. `ECONNREFUSED`, `NotFound`, `timeout`). */
  storageError?: string;
  storageLatencyMs: number;
}

/** Storage reachable: refresh `last_seen_at`. */
export const UPSERT_OK_SQL = `
INSERT INTO worker_heartbeats
  (worker_id, hostname, pid, version, started_at, last_seen_at, storage_ok, details)
VALUES ($1, $2, $3, $4, $5, now(), true, $6::jsonb)
ON CONFLICT (worker_id) DO UPDATE SET
  hostname = EXCLUDED.hostname,
  pid = EXCLUDED.pid,
  version = EXCLUDED.version,
  started_at = EXCLUDED.started_at,
  last_seen_at = now(),
  storage_ok = true,
  details = EXCLUDED.details`;

/**
 * Storage unreachable: record it but do NOT advance `last_seen_at`. A brand-new row starts at
 * the epoch so it is stale from the first beat (healthcheck fails until storage recovers).
 */
export const UPSERT_STORAGE_DOWN_SQL = `
INSERT INTO worker_heartbeats
  (worker_id, hostname, pid, version, started_at, last_seen_at, storage_ok, details)
VALUES ($1, $2, $3, $4, $5, to_timestamp(0), false, $6::jsonb)
ON CONFLICT (worker_id) DO UPDATE SET
  hostname = EXCLUDED.hostname,
  pid = EXCLUDED.pid,
  version = EXCLUDED.version,
  started_at = EXCLUDED.started_at,
  storage_ok = false,
  details = EXCLUDED.details`;

/** Remove rows of workers gone for a day (never this worker's own row). */
export const PRUNE_SQL = `
DELETE FROM worker_heartbeats
WHERE last_seen_at < now() - interval '1 day' AND worker_id <> $1`;

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
  const details = result.storageOk
    ? { storageLatencyMs: result.storageLatencyMs }
    : { storageLatencyMs: result.storageLatencyMs, storageError: result.storageError };
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
