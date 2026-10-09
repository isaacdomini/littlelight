import {
  type AiBackfillJob,
  type AiFlushJob,
  aiBackfillJobSchema,
  aiFlushJobSchema,
  aiPollJobSchema,
  type IngestJob,
  ingestJobSchema,
  JOBS,
  type JobName,
  type ReindexJob,
  reindexJobSchema,
} from "@littlelight/shared";
import type { JobWithMetadata, PgBoss, Queue, SendOptions } from "pg-boss";
import type { AiPipeline, FlushResult, PollResult } from "./ai";
import { errorCategory } from "./clients";
import type { WorkerConfig } from "./config";
import { type IngestDeps, ingestPhoto, markIngestFailed } from "./ingest";
import type { WorkerLog } from "./log-types";
import { type PurgeDeps, purgeTrash } from "./purge";
import { reconcileIngest } from "./reconcile";
import { handleReindexJob } from "./reindex";
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
// a cluster-wide singleton. `photo.reindex` (step 5 2.5) is keyed by photoId too: one queued
// re-index per photo however many edits land before it runs (step 7 re-reads at run time).
//
// Step 6 (docs/plans/step-6.md 2.7): `ai.flush` and `ai.poll` are cron singletons (no key, no
// retry: the next tick is the retry; expiry just under the 30-minute flush window), scheduled
// from config (`AI_FLUSH_INTERVAL_CRON`, `AI_POLL_INTERVAL_CRON`). `ai.backfill` is sent on
// demand with `singletonKey = babyId ?? "all"`, so one backfill per baby (or one global) at a time.

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
  [JOBS.reindex]: {
    policy: "exclusive",
    retryLimit: 3,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  [JOBS.aiFlush]: { policy: "exclusive", retryLimit: 0, expireInSeconds: 1700 },
  [JOBS.aiPoll]: { policy: "exclusive", retryLimit: 0, expireInSeconds: 1700 },
  [JOBS.aiBackfill]: {
    policy: "exclusive",
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 3600,
  },
});

/** Handlers per worker process for `photo.reindex` (docs/plans/step-5.md 2.5). */
export const REINDEX_CONCURRENCY = 4;

/** Fixed crons. The AI crons come from config: see `schedules(config)`. */
export const SCHEDULES: ReadonlyArray<readonly [JobName, string]> = Object.freeze([
  [JOBS.ingestReconcile, "*/5 * * * *"],
  [JOBS.purgeTrash, "7 * * * *"],
  [JOBS.uploadsSweep, "23,53 * * * *"],
] as const);

export type ScheduleConfig = Pick<WorkerConfig, "AI_FLUSH_INTERVAL_CRON" | "AI_POLL_INTERVAL_CRON">;

/** Every cron this worker schedules: `SCHEDULES` plus `ai.flush` / `ai.poll` from config. */
export function schedules(config: ScheduleConfig): ReadonlyArray<readonly [JobName, string]> {
  return [
    ...SCHEDULES,
    [JOBS.aiFlush, config.AI_FLUSH_INTERVAL_CRON],
    [JOBS.aiPoll, config.AI_POLL_INTERVAL_CRON],
  ];
}

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

/** Same options the API sends with (apps/api/src/plugins/jobs.ts `enqueueReindex`). */
export function reindexSendOptions(photoId: string): SendOptions {
  return {
    singletonKey: photoId,
    retryLimit: 3,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 300,
  };
}

/** Validate and enqueue one `photo.reindex` job. Resolves null when one is already queued. */
export async function sendReindex(
  boss: Pick<PgBoss, "send">,
  job: ReindexJob,
): Promise<string | null> {
  const data = reindexJobSchema.parse(job);
  return boss.send(JOBS.reindex, data, reindexSendOptions(data.photoId));
}

/** Same options as the `ai.flush` queue (run-job `--enqueue`; cron ticks send no data). */
export const AI_FLUSH_SEND_OPTIONS: SendOptions = Object.freeze({
  retryLimit: 0,
  expireInSeconds: 1700,
});

/** Validate and enqueue one `ai.flush`. Resolves null when one is already queued or active. */
export async function sendAiFlush(
  boss: Pick<PgBoss, "send">,
  job: AiFlushJob = {},
): Promise<string | null> {
  const data = aiFlushJobSchema.parse(job);
  return boss.send(JOBS.aiFlush, data, { ...AI_FLUSH_SEND_OPTIONS });
}

/** `ai.backfill` send options: one queued/active backfill per baby, or one global (`"all"`). */
export function aiBackfillSendOptions(job: Pick<AiBackfillJob, "babyId">): SendOptions {
  return {
    singletonKey: job.babyId ?? "all",
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 3600,
  };
}

/** Validate and enqueue one `ai.backfill`. Resolves null when one is already queued for the key. */
export async function sendAiBackfill(
  boss: Pick<PgBoss, "send">,
  job: AiBackfillJob,
): Promise<string | null> {
  const data = aiBackfillJobSchema.parse(job);
  return boss.send(JOBS.aiBackfill, data, aiBackfillSendOptions(data));
}

export interface QueueDeps {
  ingest: IngestDeps;
  purge: PurgeDeps;
  sweep: SweepDeps;
  /** Always present: without a provider the pipeline's flush/poll skip with one log line. */
  ai: AiPipeline;
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

export async function ensureSchedules(
  boss: Pick<PgBoss, "schedule">,
  config: ScheduleConfig,
): Promise<void> {
  for (const [name, cron] of schedules(config)) {
    await boss.schedule(name, cron, {}, { tz: "UTC" });
  }
}

type AiJob = Pick<JobWithMetadata<unknown>, "id" | "data">;
type AiHandlerDeps = Pick<QueueDeps, "ai" | "log">;

/**
 * `ai.flush` handler (cron tick, or run-job `--enqueue` with `{force, babyId}`). A malformed
 * payload can never succeed: logged (job id only) and dropped. Pipeline errors propagate so
 * pg-boss records the failure; the next cron tick is the retry (`retryLimit 0`).
 */
export async function handleAiFlushJob(
  deps: AiHandlerDeps,
  job: AiJob,
): Promise<FlushResult | null> {
  const parsed = aiFlushJobSchema.safeParse(job.data ?? {});
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "ai.flush: invalid job payload, dropped");
    return null;
  }
  const { force, babyId } = parsed.data;
  return deps.ai.flush({
    ...(force !== undefined ? { force } : {}),
    ...(babyId !== undefined ? { babyId } : {}),
  });
}

/** `ai.poll` handler (cron tick; no payload). */
export async function handleAiPollJob(deps: AiHandlerDeps, job: AiJob): Promise<PollResult | null> {
  const parsed = aiPollJobSchema.safeParse(job.data ?? {});
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "ai.poll: invalid job payload, dropped");
    return null;
  }
  return deps.ai.poll();
}

/** `ai.backfill` handler (upgrade, version or manual backfill; `aiBackfillJobSchema`). */
export async function handleAiBackfillJob(
  deps: AiHandlerDeps,
  job: AiJob,
): Promise<FlushResult | null> {
  const parsed = aiBackfillJobSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "ai.backfill: invalid job payload, dropped");
    return null;
  }
  return deps.ai.backfill(parsed.data);
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
  // Step 5: validates and completes (no DB/network call). Step 7 fills in the body.
  await boss.work(
    JOBS.reindex,
    { localConcurrency: REINDEX_CONCURRENCY, batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs) => {
      for (const job of jobs) await handleReindexJob({ log: deps.log }, job);
    },
  );
  // Step 6 AI batch pipeline (docs/plans/step-6.md 2.6, 2.7). One job at a time per process;
  // the exclusive policy makes flush/poll cluster-wide singletons, and the pipeline itself
  // claims batches with SKIP LOCKED, so `--scale worker=3` stays safe.
  await boss.work(JOBS.aiFlush, { pollingIntervalSeconds: 10 }, async (jobs) => {
    for (const job of jobs) await handleAiFlushJob(deps, job);
  });
  await boss.work(JOBS.aiPoll, { pollingIntervalSeconds: 10 }, async (jobs) => {
    for (const job of jobs) await handleAiPollJob(deps, job);
  });
  await boss.work(JOBS.aiBackfill, { pollingIntervalSeconds: 10 }, async (jobs) => {
    for (const job of jobs) await handleAiBackfillJob(deps, job);
  });
}
