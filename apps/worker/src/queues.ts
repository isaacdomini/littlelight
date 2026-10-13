import {
  type AiBackfillJob,
  type AiFlushJob,
  aiBackfillJobSchema,
  aiFlushJobSchema,
  aiPollJobSchema,
  type DataExportJob,
  dataExportJobSchema,
  dataExportSingletonKey,
  type ImportGoogleJob,
  type IngestJob,
  importGoogleJobSchema,
  importGoogleSingletonKey,
  importSweepJobSchema,
  ingestJobSchema,
  JOBS,
  type JobName,
  PUSH_MIN_GAP_MIN_DEFAULT,
  PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
  type PushNotifyJob,
  pushNotifyJobSchema,
  pushNotifySingletonKey,
  type ReindexJob,
  reindexJobSchema,
  SEARCH_DEFAULTS,
  type SearchBackfillJob,
  SHARE_DEFAULTS,
  type ShareApplyJob,
  searchBackfillJobSchema,
  searchReconcileJobSchema,
  shareApplyJobSchema,
  shareReconcileJobSchema,
  type VideoTranscodeJob,
  videoTranscodeJobSchema,
  videoTranscodeSingletonKey,
} from "@tinyglow/shared";
import type { Job, JobWithMetadata, PgBoss, Queue, SendOptions } from "pg-boss";
import type { AiPipeline, FlushResult, PollResult } from "./ai";
import { errorCategory } from "./clients";
import type { WorkerConfig } from "./config";
import { type DataExportDeps, handleDataExportJob } from "./export";
import {
  handleImportGoogleJob,
  type ImportGoogleDeps,
  type ImportSweepResult,
  sweepImports,
} from "./import";
import { type IngestDeps, ingestPhoto, markIngestFailed, type VideoIngestDeps } from "./ingest";
import type { WorkerLog } from "./log-types";
import { type PurgeDeps, purgeTrash } from "./purge";
import {
  createPushSender,
  handlePushNotifyJob,
  type PushNotifyJobLike,
  type PushNotifyResult,
  type PushSender,
} from "./push";
import { reconcileIngest } from "./reconcile";
import { handleReindexJobs, type ReconcileResult, type SearchIndexer } from "./reindex";
import { type AutoShareResult, type AutoSharer, createAutoSharer } from "./sharing/autoshare";
import { wrapHandler } from "./telemetry";
import { type SweepDeps, sweepUploads } from "./uploads-sweep";
import {
  isDeferrableTranscodeError,
  markTranscodeFailed,
  type TranscodeDeps,
  type TranscodeResult,
  transcodeVideo,
} from "./video/transcode";

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
//
// Step 7 (docs/plans/step-7.md 2.7): `photo.reindex` runs in pg-boss batches of 25 (one embedding
// call per batch) through the search indexer. `search.reconcile` is a cron singleton
// (`SEARCH_RECONCILE_CRON`, no retry: the next tick is the retry). `search.backfill` is sent on
// demand with `singletonKey = babyId ?? "all"`; an `ai.backfill` with `reason: "upgrade"` sends
// `search.backfill {babyId, reason: "upgrade"}` once it has completed (FR-5.8: search follows
// the upgrade).
//
// Step 8 (docs/plans/step-8.md 2.8): `share.apply` is sent by the api after a rule was set or
// changed, `singletonKey = shareLinkId` (one queued/active full sync per link; a send while one is
// active is dropped, and `share.reconcile` then re-syncs the rule because its `evaluated_at` is
// older than its `updated_at`). `share.reconcile` is a cron singleton (`SHARE_RECONCILE_CRON`, no
// retry: the next tick is the retry).
//
// Step 9 (docs/plans/step-9.md 2.8): `push.notify` is the one `short` queue: at most one QUEUED
// job per `singletonKey` (`${kind}:${id}`, `pushNotifySingletonKey`), unlimited active, so a burst
// of reindex batches or viewer exchanges coalesces into one notification while the debounce
// (`startAfter`) runs, and a running job can re-send itself for the min-gap rule. Sent by the
// reindex hook (`photos_analyzed`) and the api (`share_viewed`), `retryLimit 2`, 5-minute expiry.
//
// Review fixes (docs/plans/review-fixes.md 2.2, 2.3): `data.export` is sent by the api after an
// admin's export request committed, `singletonKey = exportId` (one queued/active job per export),
// `retryLimit 1`, `retryDelay 60` (a storage/internal error re-queues the row once), 4-hour
// expiry. One export at a time per worker process (`batchSize 1`, `localConcurrency 1`).
//
// Step 10 (docs/plans/step-10.md 2.3, 2.7): `import.google` is sent by the api once a Picker batch
// turned `queued` (and re-sent by `import.sweep`), `singletonKey = batchId`, `retryLimit 2`,
// `retryDelay 60` (storage/network trouble only), 2-hour expiry; one batch at a time per process
// (`batchSize 1`, `localConcurrency 1`; the handler itself downloads `IMPORT_CONCURRENCY` items
// at a time). `import.sweep` is an hourly cron singleton (`37 * * * *`, no retry: the next tick
// is the retry). Every handler is wrapped by `wrapHandler` (Sentry capture with tags
// `{service: "worker", queue}`, then rethrow: pg-boss semantics unchanged).
//
// Step 12 (docs/plans/step-12.md 2.3, 2.6): `video.transcode` is sent by the video ingest (and
// re-sent by `ingest.reconcile` for `rendition_status = 'pending'` rows older than 15 minutes),
// `singletonKey = photoId`, `retryLimit 2`, `retryDelay 120` (a scratch-space deferral or a
// storage hiccup), 2-hour expiry (ffmpeg on a 5-minute 4K clip on a small box); `VIDEO_CONCURRENCY`
// handlers per process, each one whole ffmpeg process. Seventeen queues in total.

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
  [JOBS.searchReconcile]: { policy: "exclusive", retryLimit: 0, expireInSeconds: 3000 },
  [JOBS.searchBackfill]: {
    policy: "exclusive",
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 7200,
  },
  [JOBS.shareApply]: {
    policy: "exclusive",
    retryLimit: 2,
    retryDelay: 30,
    expireInSeconds: 900,
  },
  [JOBS.shareReconcile]: { policy: "exclusive", retryLimit: 0, expireInSeconds: 3000 },
  [JOBS.pushNotify]: {
    policy: "short",
    retryLimit: 2,
    retryDelay: 30,
    expireInSeconds: 300,
  },
  [JOBS.dataExport]: {
    policy: "exclusive",
    retryLimit: 1,
    retryDelay: 60,
    expireInSeconds: 14_400,
  },
  [JOBS.importGoogle]: {
    policy: "exclusive",
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 7200,
  },
  [JOBS.importSweep]: { policy: "exclusive", retryLimit: 0, expireInSeconds: 3000 },
  [JOBS.videoTranscode]: {
    policy: "exclusive",
    retryLimit: 2,
    retryDelay: 120,
    expireInSeconds: 7200,
  },
});

/** Handlers per worker process for `photo.reindex` (docs/plans/step-7.md 2.7). */
export const REINDEX_CONCURRENCY = 2;
/** `photo.reindex` jobs per handler call: one indexer run (one embedding request) per batch. */
export const REINDEX_BATCH_SIZE = 25;

/** Fixed crons. The AI crons come from config: see `schedules(config)`. */
export const SCHEDULES: ReadonlyArray<readonly [JobName, string]> = Object.freeze([
  [JOBS.ingestReconcile, "*/5 * * * *"],
  [JOBS.purgeTrash, "7 * * * *"],
  [JOBS.uploadsSweep, "23,53 * * * *"],
  [JOBS.importSweep, "37 * * * *"],
] as const);

export type ScheduleConfig = Pick<
  WorkerConfig,
  "AI_FLUSH_INTERVAL_CRON" | "AI_POLL_INTERVAL_CRON"
> &
  // Optional in the type (always set by `loadConfig`); fall back to the shared defaults.
  Partial<Pick<WorkerConfig, "SEARCH_RECONCILE_CRON" | "SHARE_RECONCILE_CRON">>;

/**
 * Every cron this worker schedules: `SCHEDULES` plus `ai.flush` / `ai.poll`, `search.reconcile`
 * and `share.reconcile` from config.
 */
export function schedules(config: ScheduleConfig): ReadonlyArray<readonly [JobName, string]> {
  return [
    ...SCHEDULES,
    [JOBS.aiFlush, config.AI_FLUSH_INTERVAL_CRON],
    [JOBS.aiPoll, config.AI_POLL_INTERVAL_CRON],
    [JOBS.searchReconcile, config.SEARCH_RECONCILE_CRON ?? SEARCH_DEFAULTS.SEARCH_RECONCILE_CRON],
    [JOBS.shareReconcile, config.SHARE_RECONCILE_CRON ?? SHARE_DEFAULTS.SHARE_RECONCILE_CRON],
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

/** Same options as the `search.reconcile` queue (run-job `--enqueue`; cron ticks send no data). */
export const SEARCH_RECONCILE_SEND_OPTIONS: SendOptions = Object.freeze({
  retryLimit: 0,
  expireInSeconds: 3000,
});

/** `search.backfill` send options: one queued/active backfill per baby, or one global (`"all"`). */
export function searchBackfillSendOptions(job: Pick<SearchBackfillJob, "babyId">): SendOptions {
  return {
    singletonKey: job.babyId ?? "all",
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 7200,
  };
}

/** Validate and enqueue one `search.backfill`. Resolves null when one is already queued for the key. */
export async function sendSearchBackfill(
  boss: Pick<PgBoss, "send">,
  job: SearchBackfillJob,
): Promise<string | null> {
  const data = searchBackfillJobSchema.parse(job);
  return boss.send(JOBS.searchBackfill, data, searchBackfillSendOptions(data));
}

/**
 * `share.apply` send options: the queue's (`retryLimit 2`, `retryDelay 30`, `expireInSeconds 900`)
 * with `singletonKey = shareLinkId`. Same as the api's `enqueueShareApply`.
 */
export function shareApplySendOptions(shareLinkId: string): SendOptions {
  return {
    singletonKey: shareLinkId,
    retryLimit: 2,
    retryDelay: 30,
    expireInSeconds: 900,
  };
}

/** Validate and enqueue one `share.apply`. Resolves null when one is already queued for the link. */
export async function sendShareApply(
  boss: Pick<PgBoss, "send">,
  job: ShareApplyJob,
): Promise<string | null> {
  const data = shareApplyJobSchema.parse(job);
  return boss.send(JOBS.shareApply, data, shareApplySendOptions(data.shareLinkId));
}

/** Same options as the `share.reconcile` queue (run-job `--enqueue`; cron ticks send no data). */
export const SHARE_RECONCILE_SEND_OPTIONS: SendOptions = Object.freeze({
  retryLimit: 0,
  expireInSeconds: 3000,
});

/**
 * `push.notify` send options (docs/plans/step-9.md 2.8), the same as the api's
 * `PUSH_SEND_OPTIONS`: 2 retries, 5-minute expiry (the queue adds `retryDelay 30`); the
 * singleton key and the debounce (`startAfter`) are added per job by `pushNotifySendOptions`.
 */
export const PUSH_NOTIFY_SEND_OPTIONS: SendOptions = Object.freeze({
  retryLimit: 2,
  expireInSeconds: 300,
});

/** Full send options of one `push.notify` job: key `${kind}:${id}`, `startAfter` when > 0. */
export function pushNotifySendOptions(job: PushNotifyJob, startAfterSec: number): SendOptions {
  return {
    ...PUSH_NOTIFY_SEND_OPTIONS,
    singletonKey: pushNotifySingletonKey(job),
    ...(startAfterSec > 0 ? { startAfter: startAfterSec } : {}),
  };
}

/**
 * Validate and enqueue one `push.notify`, delayed by `startAfterSec` (the debounce, or the
 * remaining min gap of a re-send). Resolves null when one is already queued for the key.
 */
export async function sendPushNotify(
  boss: Pick<PgBoss, "send">,
  job: PushNotifyJob,
  startAfterSec: number,
): Promise<string | null> {
  const data = pushNotifyJobSchema.parse(job);
  return boss.send(JOBS.pushNotify, data, pushNotifySendOptions(data, startAfterSec));
}

/** Same options as the api's `DATA_EXPORT_SEND_OPTIONS`, keyed by the export id. */
export function dataExportSendOptions(job: DataExportJob): SendOptions {
  return {
    singletonKey: dataExportSingletonKey(job),
    retryLimit: 1,
    retryDelay: 60,
    expireInSeconds: 14_400,
  };
}

/** Validate and enqueue one `data.export` (run-job `--enqueue`). Null when already queued. */
export async function sendDataExport(
  boss: Pick<PgBoss, "send">,
  job: DataExportJob,
): Promise<string | null> {
  const data = dataExportJobSchema.parse(job);
  return boss.send(JOBS.dataExport, data, dataExportSendOptions(data));
}

/**
 * `import.google` send options: the same as the api's `IMPORT_GOOGLE_SEND_OPTIONS`, keyed by the
 * batch id (one queued/active job per batch).
 */
export function importGoogleSendOptions(job: ImportGoogleJob): SendOptions {
  return {
    singletonKey: importGoogleSingletonKey(job),
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 7200,
  };
}

/** Validate and enqueue one `import.google` (sweep re-send, run-job `--enqueue`). Null when queued. */
export async function sendImportGoogle(
  boss: Pick<PgBoss, "send">,
  job: ImportGoogleJob,
): Promise<string | null> {
  const data = importGoogleJobSchema.parse(job);
  return boss.send(JOBS.importGoogle, data, importGoogleSendOptions(data));
}

/** Same options as the `import.sweep` queue (run-job `--enqueue`; cron ticks send no data). */
export const IMPORT_SWEEP_SEND_OPTIONS: SendOptions = Object.freeze({
  retryLimit: 0,
  expireInSeconds: 3000,
});

/** `video.transcode` send options: the queue's, keyed by the photo id (one queued/active job per video). */
export function videoTranscodeSendOptions(job: VideoTranscodeJob): SendOptions {
  return {
    singletonKey: videoTranscodeSingletonKey(job),
    retryLimit: 2,
    retryDelay: 120,
    expireInSeconds: 7200,
  };
}

/** Validate and enqueue one `video.transcode`. Resolves null when one is already queued for the video. */
export async function sendVideoTranscode(
  boss: Pick<PgBoss, "send">,
  job: VideoTranscodeJob,
): Promise<string | null> {
  const data = videoTranscodeJobSchema.parse(job);
  return boss.send(JOBS.videoTranscode, data, videoTranscodeSendOptions(data));
}

/**
 * Video settings of the worker (`videoEnvSchema`, docs/plans/step-12.md 2.6): ffmpeg/ffprobe,
 * the scratch folder, threads and the transcode timeout. Shared by the ingest's video path and
 * the `video.transcode` handler; `sendVideoTranscode` is wired to this boss in `startWorkers`.
 */
export interface VideoQueueDeps {
  ffmpegPath: string;
  ffprobePath: string;
  scratchPath: string;
  threads: number;
  timeoutSec: number;
  /** `VIDEO_CONCURRENCY`. */
  concurrency: number;
}

/** Push settings of the worker (`pushEnvSchema`): the sender, the gap and the photos debounce. */
export interface PushQueueDeps {
  sender: PushSender;
  /** `PUSH_MIN_GAP_MIN`. */
  minGapMin: number;
  /** `PUSH_PHOTOS_DEBOUNCE_SEC`: `startAfter` of the reindex hook's `photos_analyzed`. */
  photosDebounceSec: number;
}

export interface QueueDeps {
  ingest: IngestDeps;
  purge: PurgeDeps;
  sweep: SweepDeps;
  /** Always present: without a provider the pipeline's flush/poll skip with one log line. */
  ai: AiPipeline;
  /**
   * The search indexer (docs/plans/step-7.md 2.6). Always present: without an embedder it writes
   * rows with a NULL vector (keyword search and filters still work) and logs that once.
   */
  indexer: SearchIndexer;
  /**
   * Auto-share rules (docs/plans/step-8.md 2.7): the reindex hook, `share.apply`,
   * `share.reconcile`. `main.ts` always passes it; when omitted (unit tests that do not exercise
   * sharing) one is created on first use over `ingest.pool`, so no handler ever runs without it.
   */
  autoSharer?: AutoSharer;
  /**
   * Push notifications (docs/plans/step-9.md 2.8). `main.ts` always passes it; when omitted (unit
   * tests written before step 9) the `push.notify` handler still runs with a `none` sender
   * (every delivery `unconfigured`) and the default gap/debounce.
   */
  push?: PushQueueDeps;
  /**
   * Data export (docs/plans/review-fixes.md 2.3). `main.ts` always passes it; when omitted (unit
   * tests written before the review fixes) the `data.export` queue gets no handler and jobs wait.
   */
  dataExport?: DataExportDeps;
  /**
   * Google Picker import (docs/plans/step-10.md 2.7) without `sendIngest` (wired here to this
   * boss). `main.ts` always passes it; when omitted (unit tests written before step 10) the
   * `import.google` queue gets no handler and jobs wait; `import.sweep` still runs (it needs only
   * the pool and storage of `sweep`).
   */
  importGoogle?: Omit<ImportGoogleDeps, "sendIngest">;
  /**
   * Video (docs/plans/step-12.md 2.6). `main.ts` always passes it; when omitted (unit tests
   * written before step 12) the `video.transcode` queue gets no handler, and a video upload fails
   * `unsupported_media_type` in ingest.
   */
  video?: VideoQueueDeps;
  log: WorkerLog;
  ingestConcurrency: number;
}

/** The ingest deps with the video settings and a `video.transcode` sender bound to `boss`. */
export function ingestDepsWithVideo(
  ingest: IngestDeps,
  video: VideoQueueDeps | undefined,
  boss: Pick<PgBoss, "send">,
): IngestDeps {
  if (!video) return ingest;
  const videoDeps: VideoIngestDeps = {
    ffmpegPath: video.ffmpegPath,
    ffprobePath: video.ffprobePath,
    scratchPath: video.scratchPath,
    threads: video.threads,
    sendVideoTranscode: (job) => sendVideoTranscode(boss, job),
  };
  return { ...ingest, video: videoDeps };
}

/**
 * The `video.transcode` handler for one job (exported for run-job and tests). Last-attempt rule
 * (`isDeferrableTranscodeError`): only a genuine failure (bad source / failed verification, or an
 * ffmpeg timeout) marks `rendition_status = 'failed'`; a deferral (scratch low, storage, database,
 * ffmpeg missing, shutdown, anything unknown) leaves the row `pending` so `ingest.reconcile`
 * re-sends the job after `VIDEO_TRANSCODE_STUCK_MINUTES` (a send from inside the handler would be
 * dropped by the exclusive policy while this job is still active). Either way the error is
 * rethrown so pg-boss records the attempt.
 */
export async function handleVideoTranscodeJob(
  deps: TranscodeDeps,
  job: Pick<JobWithMetadata<unknown>, "id" | "data" | "retryCount" | "retryLimit">,
): Promise<TranscodeResult | null> {
  const parsed = videoTranscodeJobSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "video.transcode: invalid job payload, dropped");
    return null;
  }
  const payload = parsed.data;
  try {
    return await transcodeVideo(deps, payload);
  } catch (err) {
    const lastAttempt = job.retryCount >= job.retryLimit;
    const deferrable = isDeferrableTranscodeError(err);
    deps.log.warn(
      {
        photoId: payload.photoId,
        attempt: job.retryCount + 1,
        err: errorCategory(err),
        deferrable,
        giveUp: lastAttempt && !deferrable,
        reconcile: lastAttempt && deferrable,
      },
      "video.transcode: attempt failed",
    );
    if (lastAttempt && !deferrable) {
      // The row stays live: poster, original download and export still work.
      await markTranscodeFailed(deps.pool, payload.photoId).catch((e: unknown) =>
        deps.log.error(
          { photoId: payload.photoId, err: errorCategory(e) },
          "video.transcode: could not mark failed",
        ),
      );
    }
    throw err;
  }
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
type AiHandlerDeps = Pick<QueueDeps, "ai" | "log"> & {
  /**
   * Enqueues `search.backfill` (the `ai.backfill` upgrade chain). Omitted in tests that do not
   * exercise the chain; `startWorkers` always sets it.
   */
  sendSearchBackfill?: (job: SearchBackfillJob) => Promise<string | null>;
};
type SearchHandlerDeps = { indexer: Pick<SearchIndexer, "reconcile" | "backfill">; log: WorkerLog };

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

/**
 * `ai.backfill` handler (upgrade, version or manual backfill; `aiBackfillJobSchema`). After an
 * `upgrade` backfill completes it sends `search.backfill {babyId, reason: "upgrade"}` (plan 2.7):
 * the baby's photos get search rows now, and each `photo.reindex {reason: "ai"}` from the poller
 * refreshes a row once its description lands. A failed send is logged and does not fail the AI
 * backfill (re-running it would re-claim photos for nothing); the hourly `search.reconcile`
 * indexes the baby anyway.
 */
export async function handleAiBackfillJob(
  deps: AiHandlerDeps,
  job: AiJob,
): Promise<FlushResult | null> {
  const parsed = aiBackfillJobSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "ai.backfill: invalid job payload, dropped");
    return null;
  }
  const result = await deps.ai.backfill(parsed.data);
  await chainSearchBackfill(deps, parsed.data);
  return result;
}

/**
 * The `ai.backfill` → `search.backfill` chain (upgrade only). Exported for run-job, which runs the
 * AI backfill in-process. Never throws.
 */
export async function chainSearchBackfill(
  deps: Pick<AiHandlerDeps, "log" | "sendSearchBackfill">,
  job: { reason: string; babyId?: string | undefined },
): Promise<string | null> {
  if (job.reason !== "upgrade" || job.babyId === undefined || !deps.sendSearchBackfill) {
    return null;
  }
  try {
    const jobId = await deps.sendSearchBackfill({ babyId: job.babyId, reason: "upgrade" });
    deps.log.info(
      { babyId: job.babyId, searchBackfillJobId: jobId },
      "ai.backfill: search.backfill sent after upgrade",
    );
    return jobId;
  } catch (err) {
    deps.log.warn(
      { babyId: job.babyId, err: errorCategory(err) },
      "ai.backfill: could not send search.backfill (search.reconcile will index the baby)",
    );
    return null;
  }
}

/**
 * `search.reconcile` handler (cron tick, no payload): stale/missing rows of paid babies are
 * re-indexed and orphans deleted (plan 2.6). Errors propagate; the next tick is the retry.
 */
export async function handleSearchReconcileJob(
  deps: SearchHandlerDeps,
  job: AiJob,
): Promise<ReconcileResult | null> {
  const parsed = searchReconcileJobSchema.safeParse(job.data ?? {});
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "search.reconcile: invalid job payload, dropped");
    return null;
  }
  return deps.indexer.reconcile();
}

/** `search.backfill` handler (upgrade, model or manual; `searchBackfillJobSchema`). */
export async function handleSearchBackfillJob(
  deps: SearchHandlerDeps,
  job: AiJob,
): Promise<ReconcileResult | null> {
  const parsed = searchBackfillJobSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "search.backfill: invalid job payload, dropped");
    return null;
  }
  return deps.indexer.backfill(parsed.data);
}

type ShareHandlerDeps = { autoSharer: Pick<AutoSharer, "applyLink" | "reconcile">; log: WorkerLog };

/** `deps.push`, or a `none` sender with the default gap/debounce (see `QueueDeps.push`). */
function pushDepsOf(deps: QueueDeps): PushQueueDeps {
  return (
    deps.push ?? {
      sender: createPushSender(
        {
          PUSH_PROVIDER: "none",
          APNS_BUNDLE_ID: "",
          APNS_ENVIRONMENT: "sandbox",
          NODE_ENV: "test",
        },
        deps.log,
      ),
      minGapMin: PUSH_MIN_GAP_MIN_DEFAULT,
      photosDebounceSec: PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
    }
  );
}

/**
 * `push.notify` handler (docs/plans/step-9.md 2.8; `apps/worker/src/push/notify.ts`): the
 * min-gap re-send goes back through `sendPushNotify`. Malformed payloads are dropped (job id
 * logged); a failed send makes it throw after recording so pg-boss retries.
 */
export async function handlePushJob(
  deps: { pool: QueueDeps["ingest"]["pool"]; push: PushQueueDeps; log: WorkerLog },
  boss: Pick<PgBoss, "send">,
  job: PushNotifyJobLike,
): Promise<PushNotifyResult | null> {
  return handlePushNotifyJob(
    {
      pool: deps.pool,
      sender: deps.push.sender,
      log: deps.log,
      minGapMin: deps.push.minGapMin,
      resend: (payload, startAfterSec) => sendPushNotify(boss, payload, startAfterSec),
    },
    job,
  );
}

/**
 * `share.apply` handler (`shareApplyJobSchema`): full auto-share sync of one link. A malformed
 * payload is logged (job id only) and dropped; sync errors propagate so pg-boss retries.
 */
export async function handleShareApplyJob(
  deps: ShareHandlerDeps,
  job: AiJob,
): Promise<AutoShareResult | null> {
  const parsed = shareApplyJobSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "share.apply: invalid job payload, dropped");
    return null;
  }
  return deps.autoSharer.applyLink(parsed.data.shareLinkId);
}

/** `share.reconcile` handler (cron tick, no payload). Errors propagate; the next tick retries. */
export async function handleShareReconcileJob(
  deps: ShareHandlerDeps,
  job: AiJob,
): Promise<AutoShareResult | null> {
  const parsed = shareReconcileJobSchema.safeParse(job.data ?? {});
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "share.reconcile: invalid job payload, dropped");
    return null;
  }
  return deps.autoSharer.reconcile();
}

/**
 * `import.sweep` handler (cron tick, no payload). A malformed payload is logged and dropped;
 * errors propagate (the next tick is the retry).
 */
export async function handleImportSweepJob(
  deps: Pick<QueueDeps, "sweep" | "log">,
  boss: Pick<PgBoss, "send">,
  job: AiJob,
): Promise<ImportSweepResult | null> {
  const parsed = importSweepJobSchema.safeParse(job.data ?? {});
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "import.sweep: invalid job payload, dropped");
    return null;
  }
  return sweepImports({
    pool: deps.sweep.pool,
    storage: deps.sweep.storage,
    sendImportGoogle: (j) => sendImportGoogle(boss, j),
    log: deps.log,
  });
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

/** `deps.autoSharer`, or one created lazily over the ingest pool on first use. */
function autoSharerOf(deps: QueueDeps): AutoSharer {
  if (deps.autoSharer) return deps.autoSharer;
  let made: AutoSharer | undefined;
  const get = () => {
    made ??= createAutoSharer({ pool: deps.ingest.pool, log: deps.log });
    return made;
  };
  return {
    evaluatePhotos: (ids) => get().evaluatePhotos(ids),
    applyLink: (id) => get().applyLink(id),
    reconcile: () => get().reconcile(),
  };
}

/** Register handlers on this worker. */
export async function startWorkers(
  boss: Pick<PgBoss, "work" | "send">,
  deps: QueueDeps,
): Promise<void> {
  const autoSharer = autoSharerOf(deps);
  const shareDeps: ShareHandlerDeps = { autoSharer, log: deps.log };
  const push = pushDepsOf(deps);
  const ingestDeps = ingestDepsWithVideo(deps.ingest, deps.video, boss);
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
    wrapHandler(JOBS.ingest, async (jobs: JobWithMetadata<unknown>[]) => {
      for (const job of jobs) await handleIngestJob(ingestDeps, job);
    }),
  );
  await boss.work(
    JOBS.ingestReconcile,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.ingestReconcile, async () => {
      await reconcileIngest({
        pool: deps.ingest.pool,
        log: deps.log,
        send: (job) => sendIngest(boss, job),
        sendTranscode: (job) => sendVideoTranscode(boss, job),
      });
    }),
  );
  // Step 12 (docs/plans/step-12.md 2.6): one whole ffmpeg per handler, `VIDEO_CONCURRENCY` of
  // them per process; the exclusive policy keeps one queued/active job per video.
  const video = deps.video;
  if (video) {
    const transcodeDeps: TranscodeDeps = {
      pool: deps.ingest.pool,
      storage: deps.ingest.storage as TranscodeDeps["storage"],
      log: deps.log,
      ffmpegPath: video.ffmpegPath,
      ffprobePath: video.ffprobePath,
      scratchPath: video.scratchPath,
      threads: video.threads,
      timeoutSec: video.timeoutSec,
    };
    await boss.work(
      JOBS.videoTranscode,
      {
        localConcurrency: video.concurrency,
        batchSize: 1,
        includeMetadata: true,
        pollingIntervalSeconds: 2,
      },
      wrapHandler(JOBS.videoTranscode, async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) await handleVideoTranscodeJob(transcodeDeps, job);
      }),
    );
  }
  await boss.work(
    JOBS.purgeTrash,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.purgeTrash, async () => {
      await purgeTrash(deps.purge);
    }),
  );
  await boss.work(
    JOBS.uploadsSweep,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.uploadsSweep, async () => {
      await sweepUploads(
        deps.video
          ? {
              ...deps.sweep,
              scratchPath: deps.sweep.scratchPath ?? deps.video.scratchPath,
              scratchActiveSec: deps.sweep.scratchActiveSec ?? deps.video.timeoutSec,
            }
          : deps.sweep,
      );
    }),
  );
  // Step 7 (plan 2.7): one indexer run per pg-boss batch of up to 25 jobs, so a burst of edits
  // costs one embedding request. The exclusive policy keeps one queued job per photo.
  await boss.work(
    JOBS.reindex,
    {
      localConcurrency: REINDEX_CONCURRENCY,
      batchSize: REINDEX_BATCH_SIZE,
      pollingIntervalSeconds: 2,
    },
    wrapHandler(JOBS.reindex, async (jobs: Job<unknown>[]) => {
      await handleReindexJobs(
        {
          indexer: deps.indexer,
          autoSharer,
          log: deps.log,
          pushHook: {
            pool: deps.ingest.pool,
            send: (job) => sendPushNotify(boss, job, push.photosDebounceSec),
          },
        },
        jobs,
      );
    }),
  );
  // Step 6 AI batch pipeline (docs/plans/step-6.md 2.6, 2.7). One job at a time per process;
  // the exclusive policy makes flush/poll cluster-wide singletons, and the pipeline itself
  // claims batches with SKIP LOCKED, so `--scale worker=3` stays safe.
  await boss.work(
    JOBS.aiFlush,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.aiFlush, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) await handleAiFlushJob(deps, job);
    }),
  );
  await boss.work(
    JOBS.aiPoll,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.aiPoll, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) await handleAiPollJob(deps, job);
    }),
  );
  const aiBackfillDeps: AiHandlerDeps = {
    ai: deps.ai,
    log: deps.log,
    sendSearchBackfill: (job) => sendSearchBackfill(boss, job),
  };
  await boss.work(
    JOBS.aiBackfill,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.aiBackfill, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) await handleAiBackfillJob(aiBackfillDeps, job);
    }),
  );
  // Step 7 search jobs (plan 2.6, 2.7): the reconcile is a cron singleton, the backfill one per
  // baby (or global). Both upsert idempotently, so `--scale worker=3` only risks a duplicate
  // embedding call, never a wrong row.
  await boss.work(
    JOBS.searchReconcile,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.searchReconcile, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) await handleSearchReconcileJob(deps, job);
    }),
  );
  await boss.work(
    JOBS.searchBackfill,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.searchBackfill, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) await handleSearchBackfillJob(deps, job);
    }),
  );
  // Step 8 auto-share (docs/plans/step-8.md 2.7, 2.8): one full link sync per job (singleton per
  // link), the reconcile a cron singleton. Inserts are ON CONFLICT DO NOTHING and the gate
  // re-checks every row, so `--scale worker=3` can only duplicate work, never a wrong row.
  await boss.work(
    JOBS.shareApply,
    { pollingIntervalSeconds: 5 },
    wrapHandler(JOBS.shareApply, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) await handleShareApplyJob(shareDeps, job);
    }),
  );
  await boss.work(
    JOBS.shareReconcile,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.shareReconcile, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) await handleShareReconcileJob(shareDeps, job);
    }),
  );
  // Step 9 push (docs/plans/step-9.md 2.8): one job at a time per process; `createdOn` (metadata)
  // is the event time the share_viewed "already covered" rule compares with.
  const pushJobDeps = { pool: deps.ingest.pool, push, log: deps.log };
  await boss.work(
    JOBS.pushNotify,
    { pollingIntervalSeconds: 5, batchSize: 1, includeMetadata: true },
    wrapHandler(JOBS.pushNotify, async (jobs: JobWithMetadata<unknown>[]) => {
      for (const job of jobs) await handlePushJob(pushJobDeps, boss, job);
    }),
  );
  // Review fixes (docs/plans/review-fixes.md 2.3): one export at a time per process; metadata for
  // the retry count (a retry may find the row a dead attempt left `running`).
  const exportDeps = deps.dataExport;
  if (exportDeps) {
    await boss.work(
      JOBS.dataExport,
      { pollingIntervalSeconds: 5, batchSize: 1, localConcurrency: 1, includeMetadata: true },
      wrapHandler(JOBS.dataExport, async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) await handleDataExportJob(exportDeps, job);
      }),
    );
  }
  // Step 10 (docs/plans/step-10.md 2.7): one Picker batch at a time per process (the handler runs
  // `IMPORT_CONCURRENCY` downloads); metadata for the retry count (the last attempt fails the
  // batch instead of rethrowing). Booked photos go through the normal `photo.ingest`.
  const importDeps = deps.importGoogle;
  if (importDeps) {
    const withIngest: ImportGoogleDeps = {
      ...importDeps,
      sendIngest: (job) => sendIngest(boss, job),
    };
    await boss.work(
      JOBS.importGoogle,
      { pollingIntervalSeconds: 2, batchSize: 1, localConcurrency: 1, includeMetadata: true },
      wrapHandler(JOBS.importGoogle, async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) await handleImportGoogleJob(withIngest, job);
      }),
    );
  }
  await boss.work(
    JOBS.importSweep,
    { pollingIntervalSeconds: 10 },
    wrapHandler(JOBS.importSweep, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) await handleImportSweepJob(deps, boss, job);
    }),
  );
}
