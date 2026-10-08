import os from "node:os";
import { aiEnvSchema, isAiConfigured } from "@littlelight/ai";
import { PgBoss } from "pg-boss";
import { createPool, createS3Client, errorCategory } from "./clients";
import { ConfigError, loadConfig } from "./config";
import { startHeartbeat, workerId } from "./heartbeat";
import { createLogger } from "./logger";
import { WORKER_VERSION } from "./version";

// Worker entry (docs/plans/step-1.md 2.9). No job handlers yet; job payloads carry IDs and
// object keys only, never photo bytes.

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

const pool = createPool(config, `littlelight-worker:${id}`);
pool.on("error", (err) => log.warn({ db: errorCategory(err) }, "pg pool idle client error"));
const s3 = createS3Client(config);

const boss = new PgBoss({ connectionString: config.DATABASE_URL });
boss.on("error", (err) => log.error({ err: errorCategory(err) }, "pg-boss error"));

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
    await boss.stop({ graceful: true, timeout: 10_000 });
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
  log.info({ workerId: id, version: WORKER_VERSION }, "worker started");
} catch (err) {
  log.error({ err: errorCategory(err) }, "pg-boss failed to start");
  await shutdown("startup-failure", 1);
}
