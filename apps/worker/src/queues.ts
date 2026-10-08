import { type IngestJob, ingestJobSchema, JOBS, type JobName } from "@littlelight/shared";
import type { JobWithMetadata, PgBoss, Queue, SendOptions } from "pg-boss";
import { errorCategory } from "./clients";
import { type IngestDeps, ingestPhoto, markIngestFailed } from "./ingest";
import type { WorkerLog } from "./log-types";
import { type PurgeDeps, purgeTrash } from "./purge";
import { reconcileIngest } from "./reconcile";
import { type SweepDeps, sweepUploads } from "./uploads-sweep";

// pg-boss queues, schedules and handlers (docs/plans/step-4.md 2.5, R1). The worker owns queue
// creation (`createQueue` is INSERT … ON CONFLICT DO NOTHING, so every replica may call it) and
// scheduling (one schedule row per queue; pg-boss's cron monitor creates one job per tick across
// all replicas).
//
// Policies: every queue is `exclusive` (at most one job per singletonKey in created/retry/active).
// For `photo.ingest` the key is the photoId (the API and `ingest.reconcile` always set it), so a
// re-send for a photo that is queued or being processed is a no-op and `--scale worker=3` never
// processes a photo twice concurrently. The cron queues are sent without a key, so each runs as
// a cluster-wide singleton.

export const QUEUES: Readonly<Record<JobName, Omit<Queue, "name">>> = Object.freeze({
  [JOBS.ingest]: {
    policy: "exclusive",
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
    // Wake workers on send (LISTEN/NOTIFY) instead of waiting for the next poll: thumbnails
    // within 5 s (plan R4). Polling remains as the backstop.
    notify: true,
  },
  [JOBS.ingestReconcile]: { policy: "exclusive", retryLimit: 0, expireInSeconds: 300 },
  [JOBS.purgeTrash]: { policy: "exclusive", retryLimit: 1, expireInSeconds: 3300 },
  [JOBS.uploadsSweep]: { policy: "exclusive", retryLimit: 1, expireInSeconds: 900 },
});

export const SCHEDULES: ReadonlyArray<readonly [JobName, string]> = Object.freeze([
  [JOBS.ingestReconcile, "*/5 * * * *"],
  [JOBS.purgeTrash, "7 * * * *"],
  [JOBS.uploadsSweep, "23,53 * * * *"],
] as const);

/** Same options the API sends with (apps/api/src/plugins/jobs.ts `INGEST_SEND_OPTIONS`). */
export function ingestSendOptions(photoId: string): SendOptions {
  return {
    singletonKey: photoId,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
  };
}

/** Validate and enqueue one `photo.ingest` job. Resolves null when one is already queued. */
export async function sendIngest(
  boss: Pick<PgBoss, "send">,
  job: IngestJob,
): Promise<string | null> {
  const data = ingestJobSchema.parse(job);
  return boss.send(JOBS.ingest, data, ingestSendOptions(data.photoId));
}

export interface QueueDeps {
  ingest: IngestDeps;
  purge: PurgeDeps;
  sweep: SweepDeps;
  log: WorkerLog;
  ingestConcurrency: number;
}

/** Create every queue (idempotent) and warn when an existing queue has a different policy. */
export async function ensureQueues(
  boss: Pick<PgBoss, "createQueue" | "getQueue">,
  log: WorkerLog,
): Promise<void> {
  for (const [name, options] of Object.entries(QUEUES)) {
    await boss.createQueue(name, options);
    const q = await boss.getQueue(name);
    if (q && q.policy !== options.policy) {
      log.warn(
        { queue: name, policy: q.policy, expected: options.policy },
        "queue exists with a different policy (pg-boss cannot change it in place)",
      );
    }
  }
}

export async function ensureSchedules(boss: Pick<PgBoss, "schedule">): Promise<void> {
  for (const [name, cron] of SCHEDULES) {
    await boss.schedule(name, cron, {}, { tz: "UTC" });
  }
}

/** The `photo.ingest` handler for one job (exported for run-job and tests). */
export async function handleIngestJob(
  deps: IngestDeps,
  job: Pick<JobWithMetadata<unknown>, "id" | "data" | "retryCount" | "retryLimit" | "createdOn">,
): Promise<void> {
  const parsed = ingestJobSchema.safeParse(job.data);
  if (!parsed.success) {
    // A malformed payload can never succeed: complete it without touching anything.
    deps.log.warn({ jobId: job.id }, "ingest: invalid job payload, dropped");
    return;
  }
  const payload = parsed.data;
  const queuedMs = job.createdOn ? Date.now() - new Date(job.createdOn).getTime() : undefined;
  try {
    const result = await ingestPhoto(deps, payload);
    if (result.outcome === "ingested") {
      deps.log.debug({ photoId: payload.photoId, queuedMs }, "ingest: queue wait");
    }
  } catch (err) {
    const lastAttempt = job.retryCount >= job.retryLimit;
    deps.log.warn(
      {
        photoId: payload.photoId,
        attempt: job.retryCount + 1,
        err: errorCategory(err),
        giveUp: lastAttempt,
      },
      "ingest: attempt failed",
    );
    if (lastAttempt) {
      await markIngestFailed(deps.pool, payload.photoId, "storage_error").catch((e: unknown) =>
        deps.log.error(
          { photoId: payload.photoId, err: errorCategory(e) },
          "ingest: could not mark failed",
        ),
      );
    }
    throw err;
  }
}

/** Register handlers on this worker. */
export async function startWorkers(
  boss: Pick<PgBoss, "work" | "send">,
  deps: QueueDeps,
): Promise<void> {
  await boss.work(
    JOBS.ingest,
    {
      localConcurrency: deps.ingestConcurrency,
      batchSize: 1,
      includeMetadata: true,
      // pg-boss waits (interval - job duration) before the next fetch, also while NOTIFY is
      // active, so a long NOTIFY backstop would idle a busy handler between queued jobs. 0.5 s
      // (the minimum) for both keeps a backlog draining back-to-back; idle polling is one cheap
      // query per handler per 0.5 s.
      pollingIntervalSeconds: 0.5,
      notifyPollingIntervalSeconds: 0.5,
    },
    async (jobs) => {
      for (const job of jobs) await handleIngestJob(deps.ingest, job);
    },
  );
  await boss.work(JOBS.ingestReconcile, { pollingIntervalSeconds: 10 }, async () => {
    await reconcileIngest({
      pool: deps.ingest.pool,
      log: deps.log,
      send: (job) => sendIngest(boss, job),
    });
  });
  await boss.work(JOBS.purgeTrash, { pollingIntervalSeconds: 10 }, async () => {
    await purgeTrash(deps.purge);
  });
  await boss.work(JOBS.uploadsSweep, { pollingIntervalSeconds: 10 }, async () => {
    await sweepUploads(deps.sweep);
  });
}
