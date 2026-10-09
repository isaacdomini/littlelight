import os from "node:os";
import { PgBoss } from "pg-boss";
import { createAiPipeline, createSearchIndexer } from "./ai";
import { aiPipelineConfig, createAiRuntime, searchIndexerConfig } from "./ai-runtime";
import { createPool, createS3Client, errorCategory } from "./clients";
import { ConfigError, loadConfig } from "./config";
import { createDiskMonitor } from "./disk";
import {
  createAiQueueAgeSampler,
  createSearchStatsSampler,
  startHeartbeat,
  workerId,
} from "./heartbeat";
import { createCsamMatcher } from "./ingest/safety";
import { createLogger } from "./logger";
import {
  ensureQueues,
  ensureSchedules,
  QUEUES,
  schedules,
  sendReindex,
  startWorkers,
} from "./queues";
import { createStorage } from "./storage";
import { WORKER_VERSION } from "./version";

// Worker entry (docs/plans/step-1.md 2.9, docs/plans/step-4.md 2.5–2.9). pg-boss runs as
// `littlelight_worker` (owns the pgboss schema: migrations, maintenance, cron); every app-table
// query runs as `pipeline` through `runAsPipeline`. Job payloads carry ids and a time zone name
// only, never photo bytes, GPS, notes or keys with signatures. Step 6 (docs/plans/step-6.md 2.7):
// the vision describer is created once here (null without a key: AI flush/poll then skip with one
// log line and the worker stays healthy), the AI queues are always created and registered.
// Step 7 (docs/plans/step-7.md 2.7): the embedder is created with it (null without
// OPENAI_API_KEY: search rows get no vector, keyword search still works) and the search indexer
// serves `photo.reindex`, `search.reconcile` and `search.backfill`.

function readConfig() {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[worker] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const config = readConfig();
const log = createLogger(config);
const id = workerId();

const ai = createAiRuntime(process.env, log);

let matcher: ReturnType<typeof createCsamMatcher>;
try {
  matcher = createCsamMatcher(config, log);
} catch {
  log.error({ csamMatcher: config.CSAM_MATCHER }, "invalid CSAM matcher configuration");
  process.exit(1);
}

// Room for INGEST_CONCURRENCY handlers (a few short transactions each) plus the heartbeat, the
// cron jobs and the AI flush/poll/backfill handlers (+2, docs/plans/step-6.md 2.7), and the
// search reindex/reconcile/backfill handlers (+1, docs/plans/step-7.md 2.7).
const pool = createPool(config, `littlelight-worker:${id}`, config.INGEST_CONCURRENCY + 7);
pool.on("error", (err) => log.warn({ db: errorCategory(err) }, "pg pool idle client error"));
const s3 = createS3Client(config);
const storage = createStorage(s3, config.S3_BUCKET);
const disk = createDiskMonitor({
  path: config.STORAGE_DISK_PATH,
  alertPct: config.STORAGE_DISK_ALERT_PCT,
  log,
});

const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  application_name: `littlelight-worker-boss:${id}`,
  useListenNotify: true,
});
boss.on("error", (err) => log.error({ err: errorCategory(err) }, "pg-boss error"));
boss.on("warning", (w) => log.warn({ warning: errorCategory(w) }, "pg-boss warning"));

const aiPipeline = createAiPipeline({
  pool,
  storage,
  describer: ai.describer,
  ...(ai.disabledReason ? { disabledReason: ai.disabledReason } : {}),
  config: aiPipelineConfig(config, process.env),
  sendReindex: (job) => sendReindex(boss, job),
  log,
});

const indexer = createSearchIndexer({
  pool,
  embedder: ai.embedder,
  config: searchIndexerConfig(config, process.env, ai.embedder),
  log,
});

const heartbeat = startHeartbeat(
  {
    db: pool,
    s3,
    bucket: config.S3_BUCKET,
    workerId: id,
    hostname: os.hostname(),
    pid: process.pid,
    version: WORKER_VERSION,
    startedAt: new Date(),
    diskUsedPct: () => disk.sample(),
    // Only with a provider: without one, eligible photos wait by design (no alert).
    ...(ai.describer
      ? {
          aiQueueAge: createAiQueueAgeSampler({
            queueAge: () => aiPipeline.queueAge(),
            alertMinutes: config.AI_QUEUE_AGE_ALERT_MINUTES,
            log,
          }),
        }
      : {}),
    searchStats: createSearchStatsSampler({ stats: () => indexer.stats(), log }),
  },
  config.HEARTBEAT_INTERVAL_MS,
  log,
);

let shuttingDown = false;
async function shutdown(signal: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  try {
    await heartbeat.stop();
    await boss.stop({ graceful: true, timeout: 30_000 });
    await pool.end();
    s3.destroy();
  } catch (err) {
    log.error({ err: errorCategory(err) }, "error during shutdown");
    code = 1;
  }
  process.exit(code);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await boss.start();
  await ensureQueues(boss, log);
  await ensureSchedules(boss, config);
  log.info(
    { queues: Object.keys(QUEUES).length, schedules: schedules(config).length },
    "queues ready",
  );
  await startWorkers(boss, {
    ingest: { pool, storage, matcher, dataKey: config.DATA_ENCRYPTION_KEY, log },
    purge: { pool, storage, log },
    sweep: { pool, storage, log },
    ai: aiPipeline,
    indexer,
    log,
    ingestConcurrency: config.INGEST_CONCURRENCY,
  });
  log.info(
    { workerId: id, version: WORKER_VERSION, ingestConcurrency: config.INGEST_CONCURRENCY },
    "worker started",
  );
} catch (err) {
  log.error({ err: errorCategory(err) }, "worker failed to start");
  await shutdown("startup-failure", 1);
}
