import os from "node:os";
import { googleImportMediaAllowList, IMPORT_MAX_FILE_BYTES } from "@tinyglow/shared";
import { PgBoss } from "pg-boss";
import { createAiPipeline, createSearchIndexer } from "./ai";
import { aiPipelineConfig, createAiRuntime, searchIndexerConfig } from "./ai-runtime";
import { createPool, createS3Client, errorCategory } from "./clients";
import { ConfigError, loadConfig, mailConfigOf } from "./config";
import { demoMediaEnabled, ensureDemoMedia } from "./demo/media";
import { createDiskMonitor } from "./disk";
import { createExportMailer, type ExportMailer } from "./email/mailer";
import {
  createAiQueueAgeSampler,
  createSearchStatsSampler,
  startHeartbeat,
  workerId,
} from "./heartbeat";
import { createWorkerGoogleClient } from "./import";
import { createCsamMatcher } from "./ingest/safety";
import { createLogger } from "./logger";
import { createPushSender } from "./push";
import {
  ensureQueues,
  ensureSchedules,
  QUEUES,
  schedules,
  sendReindex,
  startWorkers,
} from "./queues";
import { createAutoSharer } from "./sharing/autoshare";
import { createStorage } from "./storage";
import { captureJobError, closeTelemetry, initTelemetry } from "./telemetry";
import { WORKER_VERSION } from "./version";

// Worker entry (docs/plans/step-1.md 2.9, docs/plans/step-4.md 2.5–2.9). pg-boss runs as
// `tinyglow_worker` (owns the pgboss schema: migrations, maintenance, cron); every app-table
// query runs as `pipeline` through `runAsPipeline`. Job payloads carry ids and a time zone name
// only, never photo bytes, GPS, notes or keys with signatures. Step 6 (docs/plans/step-6.md 2.7):
// the vision describer is created once here (null without a key: AI flush/poll then skip with one
// log line and the worker stays healthy), the AI queues are always created and registered.
// Step 7 (docs/plans/step-7.md 2.7): the embedder is created with it (null without
// OPENAI_API_KEY: search rows get no vector, keyword search still works) and the search indexer
// serves `photo.reindex`, `search.reconcile` and `search.backfill`. Step 8 (docs/plans/step-8.md
// 2.8): the auto-sharer runs inside `photo.reindex` (before indexing) and serves `share.apply`
// and `share.reconcile`; no model call. Step 9 (docs/plans/step-9.md 2.8): the push sender is
// created once here from `PUSH_PROVIDER` (none | fake | live; one boot line names the mode and
// which providers are configured, never a value) and serves `push.notify`; the reindex hook
// enqueues `photos_analyzed`. Dev only (docs/plans/step-9.md 2.11): with SEED_DEMO_FAMILY=true and
// NODE_ENV !== production, `ensureDemoMedia()` renders the seeded demo photos' originals and
// derivatives into MinIO after the workers start, in the background (never delays readiness;
// a failure is one warning and the next start retries). Review fixes
// (docs/plans/review-fixes.md 2.3, 2.4, 2.6): Sentry is initialised first (only with
// SENTRY_DSN; errors only, scrubbed), the export mailer is created from the SMTP settings (none
// outside production ⇒ exports complete and log `emailed: false`), and `data.export` is served
// with the data key, `EXPORT_MAX_BYTES` and the streaming storage. Step 10
// (docs/plans/step-10.md 2.7): the Google Picker client is created from `GOOGLE_IMPORT_PROVIDER`
// (none ⇒ null: a stray batch fails `internal`; one boot line names the mode, never a value) and
// serves `import.google` with the download allow-list (`googleImportMediaAllowList`) and
// `IMPORT_CONCURRENCY`; `import.sweep` runs hourly.

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
initTelemetry(config);
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
// search reindex/reconcile/backfill handlers (+1, docs/plans/step-7.md 2.7), and the share
// apply/reconcile handlers (+1, docs/plans/step-8.md 2.8), and the push.notify handler and the
// reindex push hook (+1, docs/plans/step-9.md 2.8), and the data.export handler (+1,
// docs/plans/review-fixes.md 2.3: short transactions only, never one held across the stream), and
// the import.google lanes plus import.sweep (IMPORT_CONCURRENCY + 1, docs/plans/step-10.md 2.7:
// short transactions only, none held across a download).
const pool = createPool(
  config,
  `tinyglow-worker:${id}`,
  config.INGEST_CONCURRENCY + 10 + config.IMPORT_CONCURRENCY + 1,
);
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
  application_name: `tinyglow-worker-boss:${id}`,
  useListenNotify: true,
});
boss.on("error", (err) => {
  log.error({ err: errorCategory(err) }, "pg-boss error");
  captureJobError("pg-boss", err);
});
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

const autoSharer = createAutoSharer({ pool, log });

const pushSender = createPushSender(config, log);

const googleClient = createWorkerGoogleClient(config);
const mediaAllowList = googleImportMediaAllowList(config);

const mailConfig = mailConfigOf(config);
const exportMailer: ExportMailer | null = mailConfig
  ? createExportMailer(mailConfig, log, { publicUrl: config.PUBLIC_URL })
  : null;

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
    await pushSender.close();
    exportMailer?.close();
    await pool.end();
    s3.destroy();
  } catch (err) {
    log.error({ err: errorCategory(err) }, "error during shutdown");
    code = 1;
  }
  await closeTelemetry();
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
    autoSharer,
    push: {
      sender: pushSender,
      minGapMin: config.PUSH_MIN_GAP_MIN,
      photosDebounceSec: config.PUSH_PHOTOS_DEBOUNCE_SEC,
    },
    dataExport: {
      pool,
      storage,
      dataKey: config.DATA_ENCRYPTION_KEY,
      maxBytes: config.EXPORT_MAX_BYTES,
      mailer: exportMailer,
      log,
    },
    importGoogle: {
      pool,
      storage,
      dataKey: config.DATA_ENCRYPTION_KEY,
      google: googleClient,
      download: { allowList: mediaAllowList, maxBytes: IMPORT_MAX_FILE_BYTES },
      concurrency: config.IMPORT_CONCURRENCY,
      log,
    },
    log,
    ingestConcurrency: config.INGEST_CONCURRENCY,
  });
  log.info(
    {
      workerId: id,
      version: WORKER_VERSION,
      ingestConcurrency: config.INGEST_CONCURRENCY,
      exportMail: exportMailer ? "smtp" : "off",
      googleImport: config.GOOGLE_IMPORT_PROVIDER,
      importConcurrency: config.IMPORT_CONCURRENCY,
    },
    "worker started",
  );
  if (demoMediaEnabled(process.env, config.NODE_ENV)) {
    void ensureDemoMedia({ pool, s3, bucket: config.S3_BUCKET, storage, log }).catch((err) =>
      log.warn({ err: errorCategory(err) }, "demo media: skipped"),
    );
  }
} catch (err) {
  log.error({ err: errorCategory(err) }, "worker failed to start");
  captureJobError("startup", err);
  await shutdown("startup-failure", 1);
}
