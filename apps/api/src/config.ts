import { databaseEnvSchema, jwtEnvSchema, logEnvSchema, s3EnvSchema } from "@littlelight/shared";
import { z } from "zod";

// API configuration (docs/plans/step-1.md 2.5, 2.8). Fails fast on missing or invalid env and
// reports field names only: values are secrets or contain credentials (DATABASE_URL, S3 keys).

const serverEnvSchema = z.object({
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export type ApiConfig = z.output<typeof serverEnvSchema> &
  z.output<typeof databaseEnvSchema> &
  z.output<typeof s3EnvSchema> &
  z.output<typeof jwtEnvSchema> &
  z.output<typeof logEnvSchema>;

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
  const schemas = [serverEnvSchema, databaseEnvSchema, s3EnvSchema, jwtEnvSchema, logEnvSchema];
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
