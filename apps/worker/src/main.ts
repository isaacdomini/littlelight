import os from "node:os";
import { aiEnvSchema, isAiConfigured } from "@littlelight/ai";
import { PgBoss } from "pg-boss";
import { createPool, createS3Client, errorCategory } from "./clients";
import { ConfigError, loadConfig } from "./config";
import { createDiskMonitor } from "./disk";
import { startHeartbeat, workerId } from "./heartbeat";
import { createCsamMatcher } from "./ingest/safety";
import { createLogger } from "./logger";
import { ensureQueues, ensureSchedules, startWorkers } from "./queues";
import { createStorage } from "./storage";
import { WORKER_VERSION } from "./version";

// Worker entry (docs/plans/step-1.md 2.9, docs/plans/step-4.md 2.5–2.9). pg-boss runs as
// `littlelight_worker` (owns the pgboss schema: migrations, maintenance, cron); every app-table
// query runs as `pipeline` through `runAsPipeline`. Job payloads carry ids and a time zone name
// only, never photo bytes, GPS, notes or keys with signatures.

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

const ai = aiEnvSchema.safeParse(process.env);
if (isAiConfigured(process.env) && ai.success) {
  log.info(`AI enabled: provider=${ai.data.VISION_PROVIDER} model=${ai.data.VISION_MODEL}`);
} else if (ai.success) {
  const keyVar = ai.data.VISION_PROVIDER === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  log.info(`AI disabled: ${keyVar} not set`);
} else {
  log.warn("AI disabled: invalid AI configuration");
}

let matcher: ReturnType<typeof createCsamMatcher>;
try {
  matcher = createCsamMatcher(config, log);
} catch {
  log.error({ csamMatcher: config.CSAM_MATCHER }, "invalid CSAM matcher configuration");
  process.exit(1);
}

// Room for INGEST_CONCURRENCY handlers (a few short transactions each) plus the heartbeat and
// the cron jobs.
const pool = createPool(config, `littlelight-worker:${id}`, config.INGEST_CONCURRENCY + 4);
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
  await ensureSchedules(boss);
  log.info({ queues: 4, schedules: 3 }, "queues ready");
  await startWorkers(boss, {
    ingest: { pool, storage, matcher, dataKey: config.DATA_ENCRYPTION_KEY, log },
    purge: { pool, storage, log },
    sweep: { pool, storage, log },
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
