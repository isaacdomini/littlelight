import {
  type DataExportJob,
  dataExportJobSchema,
  dataExportSingletonKey,
  type ImportGoogleJob,
  type IngestJob,
  importGoogleJobSchema,
  importGoogleSingletonKey,
  ingestJobSchema,
  JOBS,
  PUSH_NOTIFY_JOB,
  PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
  PUSH_SHARE_DEBOUNCE_SEC_DEFAULT,
  type PushNotifyJob,
  pushNotifyJobSchema,
  pushNotifySingletonKey,
  type ReindexJob,
  reindexJobSchema,
  type ShareApplyJob,
  shareApplyJobSchema,
} from "@littlelight/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { PgBoss, type SendOptions } from "pg-boss";
import type { ApiConfig } from "../config";
import { errorCategory } from "../routes/healthz";

// Send-only pg-boss in the API (docs/plans/step-4.md 2.5, docs/plans/step-5.md 2.5). The worker
// owns the pgboss schema, queue creation, scheduling and maintenance; the API only enqueues
// `photo.ingest` after an upload completes and `photo.reindex` after any committed edit that
// changes a photo's search document (details, milestone rename/delete, linked measurement).
//
// `boss.send` is the ONLY database call the API makes outside `runAs`: it runs on pg-boss's own
// small pool as `littlelight_api` (which has grants on the `pgboss` schema, see
// packages/db/README.md "pg-boss and the API") with no role switch and no claims. It must never
// run inside a `runAs` transaction: that one is `SET LOCAL ROLE authenticated`, which has no
// `pgboss` grants. Callers send only after their transaction committed.
//
// The instance starts lazily on the first send, so API boot does not depend on the worker having
// installed the pgboss schema yet. A failed send is retried once after 1 s (fresh stack: queue
// not created yet), then logged by category and left to the worker's `ingest.reconcile` cron,
// which re-sends for photos stuck in `uploaded`. A lost `photo.reindex` is covered by step 7's
// reconcile (the `updated_at` columns are the durable stale signal). Payloads are ids, a time
// zone name and a reason only (strict `ingestJobSchema` / `reindexJobSchema`): never keys with
// signatures, bytes, GPS, notes, people, values or emails.
//
// Step 8 (docs/plans/step-8.md 2.9) adds `share.apply {shareLinkId, reason}` after an admin
// created or changed a link's auto-share rule. Same contract: sent after commit, outside `runAs`;
// the strict `shareApplyJobSchema` lets nothing but the link id and the reason through (never a
// token, passcode, link name or tag). A lost send is repaired by the worker's hourly
// `share.reconcile` (the rule's `updated_at` is newer than its `evaluated_at`).
//
// Step 9 (docs/plans/step-9.md 2.8) adds `push.notify {kind, id}` (`enqueuePush`): sent after
// commit, outside `runAs`, by the viewer exchange when it created a new viewer session
// (`share_viewed`, task 9.10). The strict `pushNotifyJobSchema` lets only the kind and one id
// through (never a device token, name, count or text). `singletonKey` = `${kind}:${id}` on the
// worker's `short` queue, so a burst coalesces into one queued job; `startAfter` is the debounce
// (`PUSH_SHARE_DEBOUNCE_SEC` / `PUSH_PHOTOS_DEBOUNCE_SEC`). A lost send loses one notification
// (no reconcile: pushes are best effort).
//
// Review fixes (docs/plans/review-fixes.md 2.2, 2.5) add `data.export {exportId, babyId}`
// (`enqueueDataExport`): sent after the request's transaction committed, outside `runAs`. The
// strict `dataExportJobSchema` carries the two ids only (never a storage key, URL, email or the
// location flag: the worker re-reads the row). `singletonKey = exportId` on the worker's
// `exclusive` queue; 1 retry after 60 s; 4-hour expiry. A failed send is NOT repaired by a
// reconcile: the route marks the row `failed/internal` and answers 503, so the admin can retry.
//
// Step 10 (docs/plans/step-10.md 2.3, 2.6) adds `import.google {batchId, babyId}`
// (`enqueueImportGoogle`): sent by `GET /imports/:batchId` after the batch turned `queued`
// (commit first, outside `runAs`). The strict `importGoogleJobSchema` carries the two ids only
// (never a token, a Google session or item id, a URL or a time zone: the worker re-reads the
// batch as `pipeline`). `singletonKey = batchId` on the worker's `exclusive` queue, 2 retries
// 60 s apart, 2-hour expiry. A failed send leaves the batch `queued`; `import.sweep` re-sends
// batches queued for more than 10 minutes.

/** Per-photo ingest options (plan 2.5): one queued copy per photo, 3 retries with backoff. */
export const INGEST_SEND_OPTIONS = Object.freeze({
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 600,
}) satisfies SendOptions;

/**
 * Per-photo reindex options (step-5 plan 2.5): `singletonKey = photoId` on the worker's
 * `exclusive` queue, 3 retries with backoff, 5-minute expiry.
 */
export const REINDEX_SEND_OPTIONS = Object.freeze({
  retryLimit: 3,
  retryDelay: 15,
  retryBackoff: true,
  expireInSeconds: 300,
}) satisfies SendOptions;

/**
 * Auto-share sync options (step-8 plan 2.8): the worker's `share.apply` queue is `exclusive`
 * with `singletonKey = shareLinkId`, 2 retries 30 s apart, 15-minute expiry.
 */
export const SHARE_APPLY_SEND_OPTIONS = Object.freeze({
  retryLimit: 2,
  retryDelay: 30,
  expireInSeconds: 900,
}) satisfies SendOptions;

/**
 * `push.notify` options (2.8): 2 retries, 5-minute expiry; `startAfter` (the debounce, seconds)
 * is added per kind by `pushSendOptions`.
 */
export const PUSH_SEND_OPTIONS = Object.freeze({
  retryLimit: 2,
  expireInSeconds: 300,
}) satisfies SendOptions;

/**
 * `data.export` options (2.2): the worker's queue is `exclusive` with `singletonKey = exportId`,
 * one retry 60 s later (storage errors only; the handler never rethrows for `too_large` /
 * `requester_not_admin`), 4-hour expiry (a 50 GB album streams in ~17 min).
 */
export const DATA_EXPORT_SEND_OPTIONS = Object.freeze({
  retryLimit: 1,
  retryDelay: 60,
  expireInSeconds: 14_400,
}) satisfies SendOptions;

/**
 * `import.google` options (step-10 plan 2.3): `exclusive` queue with `singletonKey = batchId`,
 * 2 retries 60 s apart (storage/network failures only), 2-hour expiry (500 originals).
 */
export const IMPORT_GOOGLE_SEND_OPTIONS = Object.freeze({
  retryLimit: 2,
  retryDelay: 60,
  expireInSeconds: 7200,
}) satisfies SendOptions;

/** Debounce per push kind, in seconds (`PUSH_PHOTOS_DEBOUNCE_SEC` / `PUSH_SHARE_DEBOUNCE_SEC`). */
export interface PushDebounce {
  photosAnalyzedSec: number;
  shareViewedSec: number;
}

export const PUSH_DEBOUNCE_DEFAULTS: Readonly<PushDebounce> = Object.freeze({
  photosAnalyzedSec: PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
  shareViewedSec: PUSH_SHARE_DEBOUNCE_SEC_DEFAULT,
});

/** The full send options of one `push.notify` job (without the singleton key). */
export function pushSendOptions(job: PushNotifyJob, debounce: PushDebounce): SendOptions {
  const startAfter =
    job.kind === "photos_analyzed" ? debounce.photosAnalyzedSec : debounce.shareViewedSec;
  return { ...PUSH_SEND_OPTIONS, ...(startAfter > 0 ? { startAfter } : {}) };
}

/** The slice of `PgBoss` the API uses; tests pass a stub. */
export interface BossLike {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  send(name: string, data: object, options: SendOptions): Promise<string | null>;
  on(event: "error" | "warning", listener: (err: unknown) => void): unknown;
}

export interface JobQueue {
  /**
   * Validate and enqueue `photo.ingest` (singletonKey = photoId). Resolves `true` when pg-boss
   * accepted it (or an identical job is already queued), `false` after a failed retry; never
   * throws for transport errors, so a completed upload is never reported as failed because of
   * the queue. Throws only for an invalid payload (a programming error).
   */
  enqueueIngest(job: IngestJob): Promise<boolean>;
  /**
   * Validate and enqueue `photo.reindex` (singletonKey = photoId), same contract as
   * `enqueueIngest`: `true` when accepted, `false` after a failed retry (logged by category;
   * step 7's reconcile re-embeds stale rows), never throws for transport errors. Call only after
   * the writing transaction committed, outside `runAs`.
   */
  enqueueReindex(job: ReindexJob): Promise<boolean>;
  /**
   * Validate and enqueue `share.apply` (singletonKey = shareLinkId), same contract as
   * `enqueueReindex`: `true` when accepted, `false` after a failed retry (logged by category; the
   * hourly `share.reconcile` re-syncs the rule), never throws for transport errors. Call only
   * after the writing transaction committed, outside `runAs`.
   *
   * Optional in this interface only so job-queue stubs written before step 8 still type-check;
   * `createJobQueue` always implements it and `app.jobs` (see `registerJobs`) always has it.
   */
  enqueueShareApply?(job: ShareApplyJob): Promise<boolean>;
  /**
   * Validate and enqueue `push.notify` (singletonKey `${kind}:${id}`, `startAfter` = the kind's
   * debounce). Same contract: `true` when accepted (or coalesced into a queued job), `false`
   * after a failed retry (logged by category and job name only), never throws for transport
   * errors; throws only for an invalid payload. Call only after the writing transaction
   * committed, outside `runAs`. A failed send can take ~1 s (one retry): callers that must not
   * delay their response run it without awaiting (`void app.jobs.enqueuePush(...)`).
   *
   * Optional in this interface only so job-queue stubs written before step 9 still type-check;
   * `createJobQueue` always implements it and `app.jobs` always has it.
   */
  enqueuePush?(job: PushNotifyJob): Promise<boolean>;
  /**
   * Validate and enqueue `data.export` (singletonKey = exportId, `DATA_EXPORT_SEND_OPTIONS`).
   * Same contract: `true` when accepted (or an identical job is already queued), `false` after a
   * failed retry (logged by category and job name only), never throws for transport errors;
   * throws only for an invalid payload. Call only after the export row committed, outside
   * `runAs`. On `false` the caller marks the row `failed/internal` (nothing re-sends it).
   *
   * Optional in this interface only so job-queue stubs written before this batch still
   * type-check; `createJobQueue` always implements it and `app.jobs` always has it.
   */
  enqueueDataExport?(job: DataExportJob): Promise<boolean>;
  /**
   * Validate and enqueue `import.google` (singletonKey = batchId, `IMPORT_GOOGLE_SEND_OPTIONS`).
   * Same contract: `true` when accepted (or an identical job is already queued), `false` after a
   * failed retry (logged by category and job name only), never throws for transport errors;
   * throws only for an invalid payload. Call only after the batch turned `queued` and committed,
   * outside `runAs`. On `false` the batch stays `queued` and `import.sweep` re-sends it.
   *
   * Optional in this interface only so job-queue stubs written before step 10 still type-check;
   * `createJobQueue` always implements it and `app.jobs` always has it.
   */
  enqueueImportGoogle?(job: ImportGoogleJob): Promise<boolean>;
  close(): Promise<void>;
}

/** `app.jobs`: every sender present (`registerJobs` fills a logged no-op for old stubs). */
export type AppJobQueue = Required<JobQueue>;

declare module "fastify" {
  interface FastifyInstance {
    jobs: AppJobQueue;
  }
}

export interface JobQueueOptions {
  log: Pick<FastifyBaseLogger, "warn" | "error" | "debug">;
  /** Factory for the pg-boss instance (tests inject a stub). */
  createBoss: () => BossLike;
  /** Delay before the single retry. Default 1000 ms. */
  retryDelayMs?: number;
  /** `push.notify` debounce per kind. Default `PUSH_DEBOUNCE_DEFAULTS`. */
  pushDebounce?: PushDebounce;
}

/** pg-boss constructed send-only: no schema creation, migrations, maintenance or cron. */
export function sendOnlyBoss(config: Pick<ApiConfig, "DATABASE_URL">): BossLike {
  return new PgBoss({
    connectionString: config.DATABASE_URL,
    application_name: "littlelight-api-jobs",
    max: 2,
    createSchema: false,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createJobQueue(opts: JobQueueOptions): AppJobQueue {
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const pushDebounce = opts.pushDebounce ?? PUSH_DEBOUNCE_DEFAULTS;
  let boss: BossLike | null = null;
  let starting: Promise<BossLike> | null = null;
  let closed = false;

  async function ensureStarted(): Promise<BossLike> {
    if (boss) return boss;
    if (closed) throw new Error("job queue is closed");
    starting ??= (async () => {
      const b = opts.createBoss();
      // EventEmitter: an unhandled 'error' event would crash the process.
      b.on("error", (err) => opts.log.warn({ err: errorCategory(err) }, "pg-boss error"));
      b.on("warning", (w) => opts.log.debug({ warning: errorCategory(w) }, "pg-boss warning"));
      try {
        await b.start();
      } catch (err) {
        await b.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
        throw err;
      }
      boss = b;
      return b;
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  /** Send once, retry once after `retryDelayMs`; log by category and resolve false on failure. */
  async function sendWithRetry(
    name: string,
    data: object,
    singletonKey: string,
    options: SendOptions,
    failureMessage: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const b = await ensureStarted();
        await b.send(name, data, { ...options, singletonKey });
        return true;
      } catch (err) {
        if (attempt === 2 || closed) {
          opts.log.warn({ err: errorCategory(err), job: name }, failureMessage);
          return false;
        }
        await sleep(retryDelayMs);
      }
    }
    return false;
  }

  return {
    async enqueueIngest(input) {
      const job = ingestJobSchema.parse(input);
      return sendWithRetry(
        JOBS.ingest,
        job,
        job.photoId,
        INGEST_SEND_OPTIONS,
        "ingest enqueue failed; ingest.reconcile will retry",
      );
    },
    async enqueueReindex(input) {
      const job = reindexJobSchema.parse(input);
      return sendWithRetry(
        JOBS.reindex,
        job,
        job.photoId,
        REINDEX_SEND_OPTIONS,
        "reindex enqueue failed; the search reconcile will catch up",
      );
    },
    async enqueueShareApply(input) {
      const job = shareApplyJobSchema.parse(input);
      return sendWithRetry(
        JOBS.shareApply,
        job,
        job.shareLinkId,
        SHARE_APPLY_SEND_OPTIONS,
        "share apply enqueue failed; share.reconcile will catch up",
      );
    },
    async enqueuePush(input) {
      const job = pushNotifyJobSchema.parse(input);
      return sendWithRetry(
        PUSH_NOTIFY_JOB,
        job,
        pushNotifySingletonKey(job),
        pushSendOptions(job, pushDebounce),
        "push enqueue failed; this notification is skipped",
      );
    },
    async enqueueDataExport(input) {
      const job = dataExportJobSchema.parse(input);
      return sendWithRetry(
        JOBS.dataExport,
        job,
        dataExportSingletonKey(job),
        DATA_EXPORT_SEND_OPTIONS,
        "data export enqueue failed; the export is marked failed",
      );
    },
    async enqueueImportGoogle(input) {
      const job = importGoogleJobSchema.parse(input);
      return sendWithRetry(
        JOBS.importGoogle,
        job,
        importGoogleSingletonKey(job),
        IMPORT_GOOGLE_SEND_OPTIONS,
        "import enqueue failed; import.sweep will re-send",
      );
    },
    async close() {
      closed = true;
      const b = boss ?? (starting ? await starting.catch(() => null) : null);
      boss = null;
      if (b) await b.stop({ graceful: true, timeout: 5000 });
    },
  };
}

/**
 * Enqueue `photo.reindex` for many photos (batch details, milestone rename/delete) with at most
 * `concurrency` sends in flight, so a 500-photo batch does not queue 500 sends on pg-boss's
 * 2-connection pool at once. Resolves the number accepted; never throws for transport errors.
 */
export async function enqueueReindexAll(
  jobs: Pick<JobQueue, "enqueueReindex">,
  items: readonly ReindexJob[],
  concurrency = 4,
): Promise<number> {
  let next = 0;
  let accepted = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item && (await jobs.enqueueReindex(item))) accepted++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
  return accepted;
}

/**
 * `jobs` with every sender present. A stub without `enqueueShareApply` / `enqueuePush` /
 * `enqueueDataExport` / `enqueueImportGoogle` gets one
 * that validates the payload (a bad payload still throws, as in production), logs by job name
 * only and resolves `false` (the "not accepted" result). Exported for tests.
 */
export function withAllSenders(jobs: JobQueue, log: Pick<FastifyBaseLogger, "warn">): AppJobQueue {
  if (
    jobs.enqueueShareApply &&
    jobs.enqueuePush &&
    jobs.enqueueDataExport &&
    jobs.enqueueImportGoogle
  ) {
    return jobs as AppJobQueue;
  }
  const shareApply = jobs.enqueueShareApply?.bind(jobs);
  const push = jobs.enqueuePush?.bind(jobs);
  const dataExport = jobs.enqueueDataExport?.bind(jobs);
  const importGoogle = jobs.enqueueImportGoogle?.bind(jobs);
  return {
    enqueueIngest: (job) => jobs.enqueueIngest(job),
    enqueueReindex: (job) => jobs.enqueueReindex(job),
    enqueueShareApply:
      shareApply ??
      (async (input) => {
        shareApplyJobSchema.parse(input);
        log.warn({ job: JOBS.shareApply }, "job queue has no share.apply sender; not enqueued");
        return false;
      }),
    enqueuePush:
      push ??
      (async (input) => {
        pushNotifyJobSchema.parse(input);
        log.warn({ job: PUSH_NOTIFY_JOB }, "job queue has no push.notify sender; not enqueued");
        return false;
      }),
    enqueueDataExport:
      dataExport ??
      (async (input) => {
        dataExportJobSchema.parse(input);
        log.warn({ job: JOBS.dataExport }, "job queue has no data.export sender; not enqueued");
        return false;
      }),
    enqueueImportGoogle:
      importGoogle ??
      (async (input) => {
        importGoogleJobSchema.parse(input);
        log.warn({ job: JOBS.importGoogle }, "job queue has no import.google sender; not enqueued");
        return false;
      }),
    close: () => jobs.close(),
  };
}

/** Decorate `app.jobs`; stops pg-boss on `app.close()`. */
export function registerJobs(app: FastifyInstance, input: JobQueue): void {
  const jobs = withAllSenders(input, app.log);
  app.decorate("jobs", jobs);
  app.addHook("onClose", async () => {
    await jobs.close();
  });
}
