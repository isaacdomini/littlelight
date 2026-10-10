import {
  aiBackfillJobSchema,
  aiFlushJobSchema,
  aiPollJobSchema,
  dataExportJobSchema,
  googleImportMediaAllowList,
  IMPORT_MAX_FILE_BYTES,
  importGoogleJobSchema,
  importSweepJobSchema,
  ingestJobSchema,
  JOBS,
  type JobName,
  pushNotifyJobSchema,
  reindexJobSchema,
  searchBackfillJobSchema,
  searchReconcileJobSchema,
  shareApplyJobSchema,
  shareReconcileJobSchema,
} from "@tinyglow/shared";
import { PgBoss } from "pg-boss";
import { createAiPipeline, createSearchIndexer } from "./ai";
import { aiPipelineConfig, createAiRuntime, searchIndexerConfig } from "./ai-runtime";
import { createPool, createS3Client, errorCategory } from "./clients";
import { ConfigError, loadConfig, mailConfigOf } from "./config";
import { createExportMailer, type ExportMailer } from "./email/mailer";
import { runDataExport } from "./export";
import { createWorkerGoogleClient, runImportGoogle, sweepImports } from "./import";
import { ingestPhoto } from "./ingest";
import { createCsamMatcher } from "./ingest/safety";
import { createLogger } from "./logger";
import { purgeTrash } from "./purge";
import { createPushSender, handlePushNotifyJob, type PushSender } from "./push";
import {
  chainSearchBackfill,
  IMPORT_SWEEP_SEND_OPTIONS,
  SEARCH_RECONCILE_SEND_OPTIONS,
  SHARE_RECONCILE_SEND_OPTIONS,
  sendAiBackfill,
  sendAiFlush,
  sendDataExport,
  sendImportGoogle,
  sendIngest,
  sendPushNotify,
  sendReindex,
  sendSearchBackfill,
  sendShareApply,
} from "./queues";
import { reconcileIngest } from "./reconcile";
import { handleReindexJobs } from "./reindex";
import { createAutoSharer } from "./sharing/autoshare";
import { createStorage } from "./storage";
import { sweepUploads } from "./uploads-sweep";

// Run one job handler in-process, now (docs/plans/step-4.md 2.13 gate: "triggers purge.trash").
//
//   pnpm --filter @tinyglow/worker run-job purge.trash
//   pnpm --filter @tinyglow/worker run-job uploads.sweep
//   pnpm --filter @tinyglow/worker run-job ingest.reconcile
//   pnpm --filter @tinyglow/worker run-job photo.ingest '{"photoId":"…","babyId":"…"}'
//   pnpm --filter @tinyglow/worker run-job photo.reindex '{"photoId":"…","babyId":"…","reason":"backfill"}'
//   pnpm --filter @tinyglow/worker run-job ai.flush ['{"force":true,"babyId":"…"}']
//   pnpm --filter @tinyglow/worker run-job ai.poll
//   pnpm --filter @tinyglow/worker run-job ai.backfill '{"babyId":"…","reason":"upgrade"}'
//   pnpm --filter @tinyglow/worker run-job search.reconcile
//   pnpm --filter @tinyglow/worker run-job search.backfill '{"babyId":"…","reason":"manual"}'
//   pnpm --filter @tinyglow/worker run-job share.apply '{"shareLinkId":"…","reason":"manual"}'
//   pnpm --filter @tinyglow/worker run-job share.reconcile
//   pnpm --filter @tinyglow/worker run-job push.notify '{"kind":"share_viewed","shareLinkId":"…"}'
//   pnpm --filter @tinyglow/worker run-job push.notify '{"kind":"photos_analyzed","babyId":"…"}'
//   pnpm --filter @tinyglow/worker run-job data.export '{"exportId":"…","babyId":"…"}'
//   pnpm --filter @tinyglow/worker run-job import.google '{"batchId":"…","babyId":"…"}'
//   pnpm --filter @tinyglow/worker run-job import.sweep
//   pnpm --filter @tinyglow/worker run-job --enqueue purge.trash      # via the queue instead
//   pnpm --filter @tinyglow/worker run-job --enqueue ai.backfill '{"reason":"manual"}'
//   pnpm --filter @tinyglow/worker run-job --enqueue search.backfill '{"babyId":"…","reason":"manual"}'
//   pnpm --filter @tinyglow/worker run-job --enqueue share.apply '{"shareLinkId":"…","reason":"manual"}'
//   pnpm --filter @tinyglow/worker run-job --enqueue push.notify '{"kind":"photos_analyzed","babyId":"…"}'
//   pnpm --filter @tinyglow/worker run-job --enqueue data.export '{"exportId":"…","babyId":"…"}'
//   pnpm --filter @tinyglow/worker run-job --enqueue import.google '{"batchId":"…","babyId":"…"}'
//
// `import.google` in-process runs one Picker batch with this process's `GOOGLE_IMPORT_*` env as a
// last attempt (storage/network trouble fails the batch, no retry); a batch a running worker
// already claimed is processed again only for its open items. Booked photos are sent to
// `photo.ingest` through the queue. `import.sweep` re-sends stuck batches through the queue too.
//
// `data.export` in-process claims the row only while it is `queued` (a running worker usually
// takes it first: then the result is `{outcome: "skipped"}`), runs as a last attempt (a storage
// error marks it failed, no retry) and sends the ready/failed notice when SMTP is configured.
//
// `photo.reindex` runs the auto-share hook first, like the worker; the share jobs make no model
// call and need no AI env.
//
// `push.notify` runs in-process with this process's `PUSH_PROVIDER` (and APNS_*/FCM_* for live),
// the min-gap rule from `PUSH_MIN_GAP_MIN` (a re-send goes to the queue), and no "already covered"
// check (there is no job creation time). `--enqueue push.notify` uses the per-kind debounce
// (`PUSH_PHOTOS_DEBOUNCE_SEC` / `PUSH_SHARE_DEBOUNCE_SEC`) like the real producers.
//
// The AI jobs run in-process with this process's AI env (`VISION_PROVIDER`, keys): without a
// provider, flush/poll print `{skipped: true}`, and the search jobs (`photo.reindex`,
// `search.reconcile`, `search.backfill`) write rows without vectors (keyword-only). An in-process
// `ai.backfill` with `reason: "upgrade"` enqueues the `search.backfill` follow-up like the worker. Run them inside the worker container
// (`docker compose exec -T worker pnpm --silent --filter @tinyglow/worker run-job ai.poll`) to
// share its env, e.g. the fake provider's `FAKE_VISION_DIR` state across processes.
//
// In the production image: `node apps/worker/dist/run-job.js <job> [json]`. Uses the worker's
// own env (same roles and keys as the running worker). Prints the handler's result (counts and
// ids only) as JSON on stdout; exit code 0 on success, 1 on failure, 2 on bad usage.

const USAGE = `usage: run-job [--enqueue] <${Object.values(JOBS).join("|")}> [json payload]`;

function isJobName(v: string | undefined): v is JobName {
  return (Object.values(JOBS) as string[]).includes(v ?? "");
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const enqueue = args[0] === "--enqueue";
  if (enqueue) args.shift();
  const [name, rawPayload] = args;
  if (!isJobName(name)) {
    console.error(USAGE);
    return 2;
  }
  let payload: unknown = {};
  if (rawPayload !== undefined) {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      console.error("payload must be JSON");
      return 2;
    }
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[run-job] ${err.message}`);
      return 2;
    }
    throw err;
  }
  const log = createLogger(config);
  const pool = createPool(config, "tinyglow-worker-run-job");
  const s3 = createS3Client(config);
  const storage = createStorage(s3, config.S3_BUCKET);
  // Send-only pg-boss on the worker role: the running worker owns migrations and cron.
  let boss: PgBoss | undefined;
  let pushSender: PushSender | undefined;
  let mailer: ExportMailer | undefined;
  const getBoss = async () => {
    if (!boss) {
      boss = new PgBoss({
        connectionString: config.DATABASE_URL,
        application_name: "tinyglow-worker-run-job",
        max: 2,
        migrate: false,
        supervise: false,
        schedule: false,
        registerInstance: false,
      });
      boss.on("error", (err) => log.warn({ err: errorCategory(err) }, "pg-boss error"));
      await boss.start();
    }
    return boss;
  };

  try {
    let result: unknown;
    if (enqueue) {
      const b = await getBoss();
      switch (name) {
        case JOBS.ingest:
          result = { jobId: await sendIngest(b, ingestJobSchema.parse(payload)) };
          break;
        case JOBS.reindex:
          result = { jobId: await sendReindex(b, reindexJobSchema.parse(payload)) };
          break;
        case JOBS.aiFlush:
          result = { jobId: await sendAiFlush(b, aiFlushJobSchema.parse(payload)) };
          break;
        case JOBS.aiBackfill:
          result = { jobId: await sendAiBackfill(b, aiBackfillJobSchema.parse(payload)) };
          break;
        case JOBS.aiPoll:
          result = { jobId: await b.send(name, aiPollJobSchema.parse(payload)) };
          break;
        case JOBS.searchReconcile:
          result = {
            jobId: await b.send(name, searchReconcileJobSchema.parse(payload), {
              ...SEARCH_RECONCILE_SEND_OPTIONS,
            }),
          };
          break;
        case JOBS.searchBackfill:
          result = { jobId: await sendSearchBackfill(b, searchBackfillJobSchema.parse(payload)) };
          break;
        case JOBS.shareApply:
          result = { jobId: await sendShareApply(b, shareApplyJobSchema.parse(payload)) };
          break;
        case JOBS.shareReconcile:
          result = {
            jobId: await b.send(name, shareReconcileJobSchema.parse(payload), {
              ...SHARE_RECONCILE_SEND_OPTIONS,
            }),
          };
          break;
        case JOBS.pushNotify: {
          const job = pushNotifyJobSchema.parse(payload);
          const debounce =
            job.kind === "photos_analyzed"
              ? config.PUSH_PHOTOS_DEBOUNCE_SEC
              : config.PUSH_SHARE_DEBOUNCE_SEC;
          result = { jobId: await sendPushNotify(b, job, debounce) };
          break;
        }
        case JOBS.dataExport:
          result = { jobId: await sendDataExport(b, dataExportJobSchema.parse(payload)) };
          break;
        case JOBS.importGoogle:
          result = { jobId: await sendImportGoogle(b, importGoogleJobSchema.parse(payload)) };
          break;
        case JOBS.importSweep:
          result = {
            jobId: await b.send(name, importSweepJobSchema.parse(payload), {
              ...IMPORT_SWEEP_SEND_OPTIONS,
            }),
          };
          break;
        default:
          result = { jobId: await b.send(name, {}) };
      }
    } else {
      switch (name) {
        case JOBS.purgeTrash:
          result = await purgeTrash({ pool, storage, log });
          break;
        case JOBS.uploadsSweep:
          result = await sweepUploads({ pool, storage, log });
          break;
        case JOBS.ingestReconcile: {
          const b = await getBoss();
          result = await reconcileIngest({ pool, log, send: (job) => sendIngest(b, job) });
          break;
        }
        case JOBS.ingest: {
          const job = ingestJobSchema.parse(payload);
          const matcher = createCsamMatcher(config, log);
          result = await ingestPhoto(
            { pool, storage, matcher, dataKey: config.DATA_ENCRYPTION_KEY, log },
            job,
          );
          break;
        }
        case JOBS.reindex:
        case JOBS.searchReconcile:
        case JOBS.searchBackfill: {
          // Strict parse first so a bad payload is a usage error (exit 1), not a silent drop.
          const reindexJob = name === JOBS.reindex ? reindexJobSchema.parse(payload) : undefined;
          const backfillJob =
            name === JOBS.searchBackfill ? searchBackfillJobSchema.parse(payload) : undefined;
          if (name === JOBS.searchReconcile) searchReconcileJobSchema.parse(payload);
          const ai = createAiRuntime(process.env, log);
          const indexer = createSearchIndexer({
            pool,
            embedder: ai.embedder,
            config: searchIndexerConfig(config, process.env, ai.embedder),
            log,
          });
          result = reindexJob
            ? await handleReindexJobs(
                {
                  indexer,
                  autoSharer: createAutoSharer({ pool, log }),
                  pushHook: {
                    pool,
                    send: async (job) =>
                      sendPushNotify(await getBoss(), job, config.PUSH_PHOTOS_DEBOUNCE_SEC),
                  },
                  log,
                },
                [{ id: "run-job", data: reindexJob }],
              )
            : backfillJob
              ? await indexer.backfill(backfillJob)
              : await indexer.reconcile();
          break;
        }
        case JOBS.shareApply: {
          const job = shareApplyJobSchema.parse(payload);
          result = await createAutoSharer({ pool, log }).applyLink(job.shareLinkId);
          break;
        }
        case JOBS.shareReconcile:
          shareReconcileJobSchema.parse(payload);
          result = await createAutoSharer({ pool, log }).reconcile();
          break;
        case JOBS.pushNotify: {
          // Strict parse first: a bad payload is an error (exit 1), not a silent drop.
          const job = pushNotifyJobSchema.parse(payload);
          pushSender = createPushSender(config, log);
          result = await handlePushNotifyJob(
            {
              pool,
              sender: pushSender,
              log,
              minGapMin: config.PUSH_MIN_GAP_MIN,
              resend: async (j, startAfterSec) => sendPushNotify(await getBoss(), j, startAfterSec),
            },
            { id: "run-job", data: job },
          );
          break;
        }
        case JOBS.dataExport: {
          const job = dataExportJobSchema.parse(payload);
          const mail = mailConfigOf(config);
          mailer = mail ? createExportMailer(mail, log) : undefined;
          result = await runDataExport(
            {
              pool,
              storage,
              dataKey: config.DATA_ENCRYPTION_KEY,
              maxBytes: config.EXPORT_MAX_BYTES,
              mailer: mailer ?? null,
              log,
            },
            job,
            { retry: false, lastAttempt: true },
          );
          break;
        }
        case JOBS.importGoogle: {
          const job = importGoogleJobSchema.parse(payload);
          result = await runImportGoogle(
            {
              pool,
              storage,
              dataKey: config.DATA_ENCRYPTION_KEY,
              google: createWorkerGoogleClient(config),
              download: {
                allowList: googleImportMediaAllowList(config),
                maxBytes: IMPORT_MAX_FILE_BYTES,
              },
              concurrency: config.IMPORT_CONCURRENCY,
              sendIngest: async (j) => sendIngest(await getBoss(), j),
              log,
            },
            job,
            { lastAttempt: true },
          );
          break;
        }
        case JOBS.importSweep:
          importSweepJobSchema.parse(payload);
          result = await sweepImports({
            pool,
            storage,
            sendImportGoogle: async (j) => sendImportGoogle(await getBoss(), j),
            log,
          });
          break;
        case JOBS.aiFlush:
        case JOBS.aiPoll:
        case JOBS.aiBackfill: {
          // Strict parse first: a bad payload is an error (exit 1), not a silent drop.
          const flushJob = name === JOBS.aiFlush ? aiFlushJobSchema.parse(payload) : undefined;
          const backfillJob =
            name === JOBS.aiBackfill ? aiBackfillJobSchema.parse(payload) : undefined;
          if (name === JOBS.aiPoll) aiPollJobSchema.parse(payload);
          const ai = createAiRuntime(process.env, log);
          const pipeline = createAiPipeline({
            pool,
            storage,
            describer: ai.describer,
            ...(ai.disabledReason ? { disabledReason: ai.disabledReason } : {}),
            config: aiPipelineConfig(config, process.env),
            sendReindex: async (job) => sendReindex(await getBoss(), job),
            log,
          });
          if (flushJob) {
            result = await pipeline.flush(flushJob);
          } else if (backfillJob) {
            const backfill = await pipeline.backfill(backfillJob);
            const searchBackfillJobId = await chainSearchBackfill(
              { log, sendSearchBackfill: async (job) => sendSearchBackfill(await getBoss(), job) },
              backfillJob,
            );
            result =
              backfillJob.reason === "upgrade" ? { ...backfill, searchBackfillJobId } : backfill;
          } else {
            result = await pipeline.poll();
          }
          break;
        }
      }
    }
    console.log(JSON.stringify({ job: name, enqueue, result }));
    return 0;
  } catch (err) {
    console.error(JSON.stringify({ job: name, error: errorCategory(err) }));
    return 1;
  } finally {
    await pushSender?.close().catch(() => undefined);
    mailer?.close();
    await boss?.stop({ graceful: false, timeout: 2_000 }).catch(() => undefined);
    await pool.end().catch(() => undefined);
    s3.destroy();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.exitCode = 1;
  });
