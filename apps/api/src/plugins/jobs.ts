import { type IngestJob, ingestJobSchema, JOBS } from "@littlelight/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { PgBoss, type SendOptions } from "pg-boss";
import type { ApiConfig } from "../config";
import { errorCategory } from "../routes/healthz";

// Send-only pg-boss in the API (docs/plans/step-4.md 2.5). The worker owns the pgboss schema,
// queue creation, scheduling and maintenance; the API only enqueues `photo.ingest` after an
// upload completes.
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
// which re-sends for photos stuck in `uploaded`. Payloads are ids and a time zone name only
// (strict `ingestJobSchema`): never keys with signatures, bytes, GPS, notes or emails.

/** Per-photo ingest options (plan 2.5): one queued copy per photo, 3 retries with backoff. */
export const INGEST_SEND_OPTIONS = Object.freeze({
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 600,
}) satisfies SendOptions;

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
  close(): Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    jobs: JobQueue;
  }
}

export interface JobQueueOptions {
  log: Pick<FastifyBaseLogger, "warn" | "error" | "debug">;
  /** Factory for the pg-boss instance (tests inject a stub). */
  createBoss: () => BossLike;
  /** Delay before the single retry. Default 1000 ms. */
  retryDelayMs?: number;
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

export function createJobQueue(opts: JobQueueOptions): JobQueue {
  const retryDelayMs = opts.retryDelayMs ?? 1000;
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

  async function sendOnce(job: IngestJob): Promise<void> {
    const b = await ensureStarted();
    await b.send(JOBS.ingest, job, { ...INGEST_SEND_OPTIONS, singletonKey: job.photoId });
  }

  return {
    async enqueueIngest(input) {
      const job = ingestJobSchema.parse(input);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await sendOnce(job);
          return true;
        } catch (err) {
          if (attempt === 2 || closed) {
            opts.log.warn(
              { err: errorCategory(err), job: JOBS.ingest },
              "ingest enqueue failed; ingest.reconcile will retry",
            );
            return false;
          }
          await sleep(retryDelayMs);
        }
      }
      return false;
    },
    async close() {
      closed = true;
      const b = boss ?? (starting ? await starting.catch(() => null) : null);
      boss = null;
      if (b) await b.stop({ graceful: true, timeout: 5000 });
    },
  };
}

/** Decorate `app.jobs`; stops pg-boss on `app.close()`. */
export function registerJobs(app: FastifyInstance, jobs: JobQueue): void {
  app.decorate("jobs", jobs);
  app.addHook("onClose", async () => {
    await jobs.close();
  });
}
