import {
  aiBackfillJobSchema,
  aiFlushJobSchema,
  aiPollJobSchema,
  ingestJobSchema,
  JOBS,
  type JobName,
  reindexJobSchema,
} from "@littlelight/shared";
import { PgBoss } from "pg-boss";
import { createAiPipeline } from "./ai";
import { aiPipelineConfig, createAiRuntime } from "./ai-runtime";
import { createPool, createS3Client, errorCategory } from "./clients";
import { ConfigError, loadConfig } from "./config";
import { ingestPhoto } from "./ingest";
import { createCsamMatcher } from "./ingest/safety";
import { createLogger } from "./logger";
import { purgeTrash } from "./purge";
import { sendAiBackfill, sendAiFlush, sendIngest, sendReindex } from "./queues";
import { reconcileIngest } from "./reconcile";
import { handleReindexJob } from "./reindex";
import { createStorage } from "./storage";
import { sweepUploads } from "./uploads-sweep";

// Run one job handler in-process, now (docs/plans/step-4.md 2.13 gate: "triggers purge.trash").
//
//   pnpm --filter @littlelight/worker run-job purge.trash
//   pnpm --filter @littlelight/worker run-job uploads.sweep
//   pnpm --filter @littlelight/worker run-job ingest.reconcile
//   pnpm --filter @littlelight/worker run-job photo.ingest '{"photoId":"…","babyId":"…"}'
//   pnpm --filter @littlelight/worker run-job photo.reindex '{"photoId":"…","babyId":"…","reason":"details"}'
//   pnpm --filter @littlelight/worker run-job ai.flush ['{"force":true,"babyId":"…"}']
//   pnpm --filter @littlelight/worker run-job ai.poll
//   pnpm --filter @littlelight/worker run-job ai.backfill '{"babyId":"…","reason":"upgrade"}'
//   pnpm --filter @littlelight/worker run-job --enqueue purge.trash      # via the queue instead
//   pnpm --filter @littlelight/worker run-job --enqueue ai.backfill '{"reason":"manual"}'
//
// The AI jobs run in-process with this process's AI env (`VISION_PROVIDER`, keys): without a
// provider, flush/poll print `{skipped: true}`. Run them inside the worker container
// (`docker compose exec -T worker pnpm --silent --filter @littlelight/worker run-job ai.poll`) to
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
  const pool = createPool(config, "littlelight-worker-run-job");
  const s3 = createS3Client(config);
  const storage = createStorage(s3, config.S3_BUCKET);
  // Send-only pg-boss on the worker role: the running worker owns migrations and cron.
  let boss: PgBoss | undefined;
  const getBoss = async () => {
    if (!boss) {
      boss = new PgBoss({
        connectionString: config.DATABASE_URL,
        application_name: "littlelight-worker-run-job",
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
        case JOBS.reindex: {
          // Strict parse first so a bad payload is a usage error (exit 1), not a silent drop.
          const job = reindexJobSchema.parse(payload);
          result = await handleReindexJob({ log }, { id: "run-job", data: job });
          break;
        }
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
          result = flushJob
            ? await pipeline.flush(flushJob)
            : backfillJob
              ? await pipeline.backfill(backfillJob)
              : await pipeline.poll();
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
