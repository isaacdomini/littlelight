import {
  aiPipelineEnvSchema,
  databaseEnvSchema,
  EMBED_DIMS,
  encryptionEnvSchema,
  exportEnvSchema,
  googleImportEnvSchema,
  ingestEnvSchema,
  jwtEnvSchema,
  logEnvSchema,
  type MailEnv,
  mailEnvSchema,
  pushEnvSchema,
  s3EnvSchema,
  searchEnvSchema,
  sentryEnvSchema,
  shareEnvSchema,
  videoEnvSchema,
} from "@tinyglow/shared";
import { z } from "zod";

// Worker configuration (docs/plans/step-1.md 2.5, 2.9; docs/plans/step-2.md 2.12). Fails fast on
// missing or invalid env and reports field names only: values are secrets or contain credentials
// (DATABASE_URL, S3 keys, DATA_ENCRYPTION_KEY). From step 2, DATABASE_URL is the
// `tinyglow_worker` role: pg-boss and the heartbeat use it directly; job queries will run
// inside `runAsPipeline` (`db.ts`: BEGIN; SET LOCAL ROLE pipeline; ...). Step 4 adds the ingest
// settings (`INGEST_CONCURRENCY`, disk alert, CSAM matcher; docs/plans/step-4.md 2.6). Step 6
// adds the AI batch pipeline settings (`aiPipelineEnvSchema`: batch size/age, crons, attempts,
// budget, queue-age alert; docs/plans/step-6.md 2.7). Provider/model/keys (`aiEnvSchema` from
// `@tinyglow/ai`) are NOT part of this config: `main.ts` reads them through `getAiStatus` /
// `createVisionDescriber` so a missing key never fails worker boot. Step 7 adds the search
// indexer settings (`searchEnvSchema`: reconcile cron, embedding batch; docs/plans/step-7.md 2.7)
// and one AI-env guard that DOES fail boot: `EMBED_DIMS` must equal the `photo_search.embedding`
// column width (1024), or every upsert would fail. Step 8 adds the worker's part of
// `shareEnvSchema`: `SHARE_RECONCILE_CRON` (docs/plans/step-8.md 2.8; `SHARE_MEDIA_URL_TTL_SEC` is
// the api's and never fails worker boot). Step 9 adds `pushEnvSchema` as-is (docs/plans/step-9.md
// 2.8, 2.10): `PUSH_PROVIDER` (none|fake|live; `fake` fails boot in production), APNS_*/FCM_*
// (secrets: never logged), the `PUSH_*_URL` overrides and the debounce/gap settings. Review fixes
// (docs/plans/review-fixes.md 2.2, 2.4, 2.6) add `EXPORT_MAX_BYTES` (`exportEnvSchema`), Sentry
// (`sentryEnvSchema`: `SENTRY_DSN` unset ⇒ off) and the api's SMTP settings (`mailEnvSchema`) for
// the export notices. SMTP is required in production (boot fails without it, like the api) and
// optional elsewhere: without `SMTP_HOST` the export still completes and logs `emailed: false`.
// Step 10 (docs/plans/step-10.md 2.3, 2.7, D6, D7) adds `googleImportEnvSchema` as-is:
// `GOOGLE_IMPORT_PROVIDER` (none|fake|live; `fake` fails boot in production, `live` needs the
// client id + secret), the fake's internal URL, the download host allow-list
// (`GOOGLE_IMPORT_MEDIA_HOSTS`) and `IMPORT_CONCURRENCY` (downloads in flight per batch). The
// client secret is a secret: never logged. The brand pass adds an optional `PUBLIC_URL` (the
// browser origin, same rules as the api's) for the logo in the export notices
// (`${PUBLIC_URL}/email/logo.png`); unset ⇒ the notices go out without the logo. Step 12
// (docs/plans/step-12.md 2.3, 2.6) adds `videoEnvSchema` as-is: `VIDEO_CONCURRENCY`,
// `WORKER_SCRATCH_PATH` (the disk-backed staging folder, Q8), `FFMPEG_PATH` / `FFPROBE_PATH`,
// `VIDEO_FFMPEG_THREADS` and `VIDEO_TRANSCODE_TIMEOUT_SEC`. Nothing in it is a secret.

export const heartbeatEnvSchema = z.object({
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  HEARTBEAT_STALE_MS: z.coerce.number().int().min(1_000).default(30_000),
});

export const workerPublicUrlEnvSchema = z.object({
  PUBLIC_URL: z
    .url({ protocol: /^https?$/ })
    .transform((u) => u.replace(/\/+$/, ""))
    .optional(),
});

export const workerShareEnvSchema = shareEnvSchema.pick({ SHARE_RECONCILE_CRON: true });

export type WorkerConfig = z.output<typeof heartbeatEnvSchema> &
  z.output<typeof databaseEnvSchema> &
  z.output<typeof s3EnvSchema> &
  z.output<typeof jwtEnvSchema> &
  z.output<typeof encryptionEnvSchema> &
  z.output<typeof ingestEnvSchema> &
  z.output<typeof aiPipelineEnvSchema> &
  z.output<typeof searchEnvSchema> &
  z.output<typeof workerShareEnvSchema> &
  z.output<typeof pushEnvSchema> &
  z.output<typeof exportEnvSchema> &
  z.output<typeof googleImportEnvSchema> &
  z.output<typeof videoEnvSchema> &
  z.output<typeof sentryEnvSchema> &
  z.output<typeof workerPublicUrlEnvSchema> &
  Partial<MailEnv> &
  z.output<typeof logEnvSchema>;

/** Env needed by `healthcheck.ts` only (no S3/JWT/encryption key: it reads the heartbeat row). */
export type HealthcheckConfig = z.output<typeof heartbeatEnvSchema> &
  z.output<typeof databaseEnvSchema>;

type RawEnv = Readonly<Record<string, string | undefined>>;
type AnySchema = z.ZodType<Record<string, unknown>>;

export class ConfigError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`Invalid environment: ${fields.join(", ")}`);
    this.name = "ConfigError";
    this.fields = fields;
  }
}

/** Compose passes `FOO=` from env files as `""`; treat that as unset so defaults apply. */
function withoutEmpty(env: RawEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") out[key] = value;
  }
  return out;
}

/** Parse each schema, merge results, and throw one `ConfigError` naming every bad field. */
function parseAll(env: RawEnv, schemas: AnySchema[]): Record<string, unknown> {
  const input = withoutEmpty(env);
  const fields: string[] = [];
  const merged: Record<string, unknown> = {};
  for (const schema of schemas) {
    const result = schema.safeParse(input);
    if (result.success) {
      Object.assign(merged, result.data);
    } else {
      for (const issue of result.error.issues) {
        fields.push(`${issue.path.join(".") || "(root)"} (${issue.message})`);
      }
    }
  }
  if (fields.length > 0) throw new ConfigError([...new Set(fields)]);
  return merged;
}

/**
 * `EMBED_DIMS` (read by `@tinyglow/ai`, default 1024) must equal the `vector(1024)` column.
 * Unset/empty is fine (the default); anything else is a `ConfigError` naming the field only.
 */
export const embedDimsGuardSchema = z.object({
  EMBED_DIMS: z
    .string()
    .optional()
    .refine((v) => v === undefined || Number(v) === EMBED_DIMS, {
      message: `must be ${EMBED_DIMS}, the photo_search.embedding column width`,
    }),
});

/** SMTP settings are parsed when any is set, and always in production (then they are required). */
function mailRequired(env: RawEnv): boolean {
  const set = (k: string) => (env[k] ?? "").trim() !== "";
  return env.NODE_ENV === "production" || set("SMTP_HOST") || set("MAIL_FROM");
}

/** The SMTP settings, or null when this worker has none (non-production only). */
export function mailConfigOf(config: Partial<MailEnv>): MailEnv | null {
  if (!config.SMTP_HOST || !config.MAIL_FROM) return null;
  return {
    SMTP_HOST: config.SMTP_HOST,
    SMTP_PORT: config.SMTP_PORT ?? 587,
    SMTP_USER: config.SMTP_USER,
    SMTP_PASS: config.SMTP_PASS,
    SMTP_SECURE: config.SMTP_SECURE ?? false,
    MAIL_FROM: config.MAIL_FROM,
  };
}

export function loadConfig(env: RawEnv = process.env): WorkerConfig {
  const merged = parseAll(env, [
    heartbeatEnvSchema,
    databaseEnvSchema,
    s3EnvSchema,
    jwtEnvSchema,
    encryptionEnvSchema,
    ingestEnvSchema,
    aiPipelineEnvSchema,
    searchEnvSchema,
    workerShareEnvSchema,
    pushEnvSchema,
    exportEnvSchema,
    googleImportEnvSchema,
    videoEnvSchema,
    sentryEnvSchema,
    workerPublicUrlEnvSchema,
    ...(mailRequired(env) ? [mailEnvSchema] : []),
    embedDimsGuardSchema,
    logEnvSchema,
  ]);
  // The guard's value is not configuration (the AI factories read EMBED_DIMS from the env).
  delete merged.EMBED_DIMS;
  return merged as WorkerConfig;
}

export function loadHealthcheckConfig(env: RawEnv = process.env): HealthcheckConfig {
  return parseAll(env, [heartbeatEnvSchema, databaseEnvSchema]) as HealthcheckConfig;
}
