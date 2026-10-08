import {
  databaseEnvSchema,
  encryptionEnvSchema,
  jwtEnvSchema,
  logEnvSchema,
  s3EnvSchema,
} from "@littlelight/shared";
import { z } from "zod";

// Worker configuration (docs/plans/step-1.md 2.5, 2.9; docs/plans/step-2.md 2.12). Fails fast on
// missing or invalid env and reports field names only: values are secrets or contain credentials
// (DATABASE_URL, S3 keys, DATA_ENCRYPTION_KEY). From step 2, DATABASE_URL is the
// `littlelight_worker` role: pg-boss and the heartbeat use it directly; job queries will run
// inside `withPipeline` (step 4: BEGIN; SET LOCAL ROLE pipeline; ...).

export const heartbeatEnvSchema = z.object({
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  HEARTBEAT_STALE_MS: z.coerce.number().int().min(1_000).default(30_000),
});

export type WorkerConfig = z.output<typeof heartbeatEnvSchema> &
  z.output<typeof databaseEnvSchema> &
  z.output<typeof s3EnvSchema> &
  z.output<typeof jwtEnvSchema> &
  z.output<typeof encryptionEnvSchema> &
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

export function loadConfig(env: RawEnv = process.env): WorkerConfig {
  return parseAll(env, [
    heartbeatEnvSchema,
    databaseEnvSchema,
    s3EnvSchema,
    jwtEnvSchema,
    encryptionEnvSchema,
    logEnvSchema,
  ]) as WorkerConfig;
}

export function loadHealthcheckConfig(env: RawEnv = process.env): HealthcheckConfig {
  return parseAll(env, [heartbeatEnvSchema, databaseEnvSchema]) as HealthcheckConfig;
}
