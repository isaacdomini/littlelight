import { fileURLToPath } from "node:url";
import { databaseEnvSchema, s3EnvSchema } from "@tinyglow/shared";
import { PgBoss } from "pg-boss";
import { createPool, createS3Client, errorCategory } from "../clients";
import { createLogger } from "../logger";
import { sendIngest } from "../queues";
import { createStorage } from "../storage";
import {
  checkDemoMedia,
  checkPassed,
  type DemoMediaDeps,
  ensureDemoMedia,
  isUuid,
  writeReviewMedia,
} from "./media";

// `pnpm demo:media` (docs/plans/step-9.md 2.11, task 9.12).
//
//   pnpm demo:media                     render the dev demo family's originals + derivatives (idempotent)
//   pnpm demo:media --check             verify: 12/12 originals, 36/36 derivatives, rows, no metadata
//   pnpm demo:media --review-baby <id> [--confirm-production]
//                                       put the 24 review JPEGs at the rows'
//                                       `babies/<babyId>/originals/<id>.jpg` keys and enqueue ingest
//
// Production image: `node apps/worker/dist/demo-media.js --review-baby <id> --confirm-production`
// inside the worker container (its env: the `tinyglow_worker` role, the worker's MinIO key).
// The demo family (default mode and --check) is dev only and refused with NODE_ENV=production;
// --review-baby needs --confirm-production there (and the user's approval, plan 5.2).
//
// On the host against the dev stack nothing needs setting: unset variables default to the dev
// stack's worker role and worker MinIO key on localhost (DB_PORT / STORAGE_PORT respected), never
// in production. Output is ids and counts only. Exit 0 ok, 1 failed/check failed, 2 bad usage.

export const DEMO_MEDIA_USAGE =
  "usage: demo:media [--check] | demo:media --review-baby <babyId> [--confirm-production]";

export type DemoMediaArgs =
  | { mode: "ensure" }
  | { mode: "check" }
  | { mode: "review"; babyId: string; confirmProduction: boolean };

export class DemoMediaUsageError extends Error {
  override readonly name = "DemoMediaUsageError";
}

export function parseDemoMediaArgs(argv: readonly string[]): DemoMediaArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let check = false;
  let confirmProduction = false;
  let babyId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") check = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--review-baby") {
      babyId = args[++i];
      if (!babyId || !isUuid(babyId.toLowerCase())) {
        throw new DemoMediaUsageError("--review-baby needs a baby id (uuid)");
      }
      babyId = babyId.toLowerCase();
    } else throw new DemoMediaUsageError(`unknown argument`);
  }
  if (babyId !== undefined) {
    if (check) throw new DemoMediaUsageError("--check and --review-baby cannot be combined");
    return { mode: "review", babyId, confirmProduction };
  }
  if (confirmProduction)
    throw new DemoMediaUsageError("--confirm-production applies to --review-baby only");
  return check ? { mode: "check" } : { mode: "ensure" };
}

type Env = Readonly<Record<string, string | undefined>>;

function isProduction(env: Env): boolean {
  return env.NODE_ENV?.trim() === "production";
}

/** Null when the run may proceed, else the reason (names the rule, never a value). */
export function demoMediaRefusal(args: DemoMediaArgs, env: Env): string | null {
  if (!isProduction(env)) return null;
  if (args.mode !== "review")
    return "the demo family is dev only: refusing with NODE_ENV=production";
  if (!args.confirmProduction) return "refusing NODE_ENV=production without --confirm-production";
  return null;
}

/** The dev stack's worker credentials (docker-compose.dev.yml x-dev-shared), host-side. */
export function devDefaults(env: Env): Record<string, string> {
  const dbPort = env.DB_PORT?.trim() || "5432";
  const storagePort = env.STORAGE_PORT?.trim() || "9000";
  return {
    DATABASE_URL: `postgres://tinyglow_worker:dev@localhost:${dbPort}/tinyglow`,
    S3_ENDPOINT: `http://localhost:${storagePort}`,
    S3_PUBLIC_ENDPOINT: `http://localhost:${storagePort}`,
    S3_ACCESS_KEY: "tinyglow-worker",
    S3_SECRET_KEY: "dev-worker-s3-secret-16",
    S3_BUCKET: "tinyglow-dev",
  };
}

const cliEnvSchema = databaseEnvSchema.extend(s3EnvSchema.shape);

/** Env for the run: the process env, plus dev-stack defaults for unset keys outside production. */
export function resolveDemoMediaEnv(env: Env) {
  const merged: Record<string, string | undefined> = {};
  if (!isProduction(env)) Object.assign(merged, devDefaults(env));
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== "") merged[k] = v;
  // The worker image has no S3_PUBLIC_ENDPOINT requirement for this tool; reuse the endpoint.
  merged.S3_PUBLIC_ENDPOINT ??= merged.S3_ENDPOINT;
  const parsed = cliEnvSchema.safeParse(merged);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new DemoMediaUsageError(`invalid environment: ${fields.join(", ")}`);
  }
  return parsed.data;
}

async function main(argv: string[]): Promise<number> {
  let args: DemoMediaArgs;
  let env: ReturnType<typeof resolveDemoMediaEnv>;
  try {
    args = parseDemoMediaArgs(argv);
    const refusal = demoMediaRefusal(args, process.env);
    if (refusal) {
      console.error(`[demo-media] ${refusal}`);
      return 1;
    }
    env = resolveDemoMediaEnv(process.env);
  } catch (err) {
    if (err instanceof DemoMediaUsageError) {
      console.error(`[demo-media] ${err.message}\n${DEMO_MEDIA_USAGE}`);
      return 2;
    }
    throw err;
  }

  const log = createLogger({
    LOG_LEVEL: process.env.LOG_LEVEL === "debug" ? "debug" : "warn",
    NODE_ENV: isProduction(process.env) ? "production" : "test",
  });
  const pool = createPool(env, "tinyglow-worker-demo-media", 3);
  const s3 = createS3Client(env);
  const deps: DemoMediaDeps = {
    pool,
    s3,
    bucket: env.S3_BUCKET,
    storage: createStorage(s3, env.S3_BUCKET),
    log,
  };
  let boss: PgBoss | undefined;
  try {
    if (args.mode === "check") {
      const r = await checkDemoMedia(deps);
      const ok = checkPassed(r);
      console.log(
        `originals ${r.originals}/${r.expectedPhotos}, derivatives ${r.derivatives}/${r.expectedDerivatives}, ` +
          `rows ${r.rowsMatching}/${r.expectedPhotos}, metadata-free ${r.metadataFree}/${r.objectsChecked}` +
          (ok ? "" : "  (FAILED)"),
      );
      return ok ? 0 : 1;
    }
    if (args.mode === "ensure") {
      const r = await ensureDemoMedia(deps);
      console.log(JSON.stringify(r));
      if (r.photos === 0) {
        console.error(
          "[demo-media] no demo photos: run the seed first (SEED_DEMO_FAMILY=true pnpm db:seed)",
        );
        return 1;
      }
      return r.failed === 0 ? 0 : 1;
    }
    // Send-only pg-boss on the worker role: the running worker owns migrations and cron.
    boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      application_name: "tinyglow-worker-demo-media",
      max: 2,
      migrate: false,
      supervise: false,
      schedule: false,
      registerInstance: false,
    });
    boss.on("error", (err) => log.warn({ err: errorCategory(err) }, "pg-boss error"));
    await boss.start();
    const b = boss;
    const r = await writeReviewMedia(
      { ...deps, sendIngest: (job) => sendIngest(b, job) },
      args.babyId,
    );
    console.log(JSON.stringify({ babyId: args.babyId, ...r }));
    if (r.photos === 0) {
      console.error("[demo-media] that baby has no photos: run db:review-family first");
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(JSON.stringify({ error: errorCategory(err) }));
    return 1;
  } finally {
    await boss?.stop({ graceful: false, timeout: 2_000 }).catch(() => undefined);
    await pool.end().catch(() => undefined);
    s3.destroy();
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
