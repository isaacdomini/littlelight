import {
  aiPipelineEnvSchema,
  authEnvSchema,
  databaseEnvSchema,
  encryptionEnvSchema,
  jwtEnvSchema,
  logEnvSchema,
  mailEnvSchema,
  s3EnvSchema,
} from "@littlelight/shared";
import { z } from "zod";

// API configuration (docs/plans/step-1.md 2.5, 2.8; docs/plans/step-2.md 2.12). Fails fast on
// missing or invalid env and reports field names only: values are secrets or contain credentials
// (DATABASE_URL, S3 keys, DATA_ENCRYPTION_KEY). From step 2, DATABASE_URL is the
// `littlelight_api` role (never the superuser); every request-scoped query will run inside
// `withClaims` (step 3: BEGIN; SET LOCAL ROLE ...; set_config('request.jwt.claims', $1, true)).
// Step 3 adds auth (`PUBLIC_URL` = JWT issuer base, `AUTH_INTERNAL_URL`, provider flags,
// Turnstile) and SMTP (`SMTP_*`, `MAIL_FROM`) settings (docs/plans/step-3.md 2.6, 2.8).

const serverEnvSchema = z.object({
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

/**
 * Step 6 (docs/plans/step-6.md 2.8): the per-baby monthly AI budget shown by
 * `GET /babies/:id/ai/usage`, read from the same env var as the worker (same default). The API
 * reads no provider key and no other AI setting.
 */
const aiApiEnvSchema = aiPipelineEnvSchema.pick({ AI_BABY_MONTHLY_BUDGET_USD: true });

export type ApiConfig = z.output<typeof serverEnvSchema> &
  z.output<typeof databaseEnvSchema> &
  z.output<typeof s3EnvSchema> &
  z.output<typeof jwtEnvSchema> &
  z.output<typeof encryptionEnvSchema> &
  z.output<typeof logEnvSchema> &
  z.output<typeof authEnvSchema> &
  z.output<typeof mailEnvSchema> &
  // Optional in the type (always set by `loadConfig`); readers fall back to the shared default.
  Partial<z.output<typeof aiApiEnvSchema>>;

export class ConfigError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`Invalid environment: ${fields.join(", ")}`);
    this.name = "ConfigError";
    this.fields = fields;
  }
}

/** Compose passes `FOO=` from env files as `""`; treat that as unset so defaults apply. */
function withoutEmpty(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") out[key] = value;
  }
  return out;
}

/**
 * Parse the API env. Throws `ConfigError` listing invalid fields as `NAME (message)`; zod issue
 * messages describe the expectation, never the received value.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApiConfig {
  const input = withoutEmpty(env);
  const schemas = [
    serverEnvSchema,
    databaseEnvSchema,
    s3EnvSchema,
    jwtEnvSchema,
    encryptionEnvSchema,
    logEnvSchema,
    authEnvSchema,
    mailEnvSchema,
    aiApiEnvSchema,
  ];
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
  return merged as ApiConfig;
}
