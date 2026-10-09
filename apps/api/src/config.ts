import {
  aiPipelineEnvSchema,
  authEnvSchema,
  CHAT_DEFAULTS,
  type ChatEnv,
  chatEnvSchema,
  databaseEnvSchema,
  EMBED_DIMS,
  encryptionEnvSchema,
  jwtEnvSchema,
  logEnvSchema,
  mailEnvSchema,
  SEARCH_DEFAULTS,
  type SearchEnv,
  s3EnvSchema,
  searchEnvSchema,
} from "@littlelight/shared";
import { z } from "zod";

// API configuration (docs/plans/step-1.md 2.5, 2.8; docs/plans/step-2.md 2.12). Fails fast on
// missing or invalid env and reports field names only: values are secrets or contain credentials
// (DATABASE_URL, S3 keys, DATA_ENCRYPTION_KEY). From step 2, DATABASE_URL is the
// `littlelight_api` role (never the superuser); every request-scoped query will run inside
// `withClaims` (step 3: BEGIN; SET LOCAL ROLE ...; set_config('request.jwt.claims', $1, true)).
// Step 3 adds auth (`PUBLIC_URL` = JWT issuer base, `AUTH_INTERNAL_URL`, provider flags,
// Turnstile) and SMTP (`SMTP_*`, `MAIL_FROM`) settings (docs/plans/step-3.md 2.6, 2.8).
// Step 7 (docs/plans/step-7.md 2.9) adds the search and chat settings (`searchEnvSchema`,
// `chatEnvSchema`). Provider, models and keys (`VISION_PROVIDER`, `OPENAI_API_KEY`, `CHAT_MODEL`,
// `EMBED_MODEL`, …) are NOT part of this config: `plugins/ai.ts` hands the env to
// `@littlelight/ai`'s factories (one schema rules), so the key never sits in `app.config`. The
// one AI setting checked here is `EMBED_DIMS`, which must equal the `photo_search.embedding`
// column width (1024): anything else fails boot.

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

/**
 * `EMBED_DIMS` (read by `@littlelight/ai`, default 1024) must equal the `vector(1024)` column.
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

export type ApiConfig = z.output<typeof serverEnvSchema> &
  z.output<typeof databaseEnvSchema> &
  z.output<typeof s3EnvSchema> &
  z.output<typeof jwtEnvSchema> &
  z.output<typeof encryptionEnvSchema> &
  z.output<typeof logEnvSchema> &
  z.output<typeof authEnvSchema> &
  z.output<typeof mailEnvSchema> &
  // Optional in the type (always set by `loadConfig`); readers fall back to the shared default.
  Partial<z.output<typeof aiApiEnvSchema>> &
  // Optional in the type (always set by `loadConfig`); read through `searchSettings` /
  // `chatSettings`, which fill the shared defaults.
  Partial<SearchEnv> &
  Partial<ChatEnv>;

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
    searchEnvSchema,
    chatEnvSchema,
    embedDimsGuardSchema,
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
  // The guard's value is not configuration (the factories read EMBED_DIMS from the env).
  delete merged.EMBED_DIMS;
  return merged as ApiConfig;
}

/**
 * Search settings with the shared defaults filled in (`searchEnvSchema`). `SEARCH_MIN_SIMILARITY`
 * is passed through only when set; unset ⇒ the routes use null = the embedding model's default
 * floor (search/hybrid.ts: 0.20 real, 0.60 fake).
 */
export function searchSettings(config: Partial<SearchEnv>): SearchEnv {
  return {
    SEARCH_RERANK: config.SEARCH_RERANK ?? SEARCH_DEFAULTS.SEARCH_RERANK,
    SEARCH_EXACT_MAX: config.SEARCH_EXACT_MAX ?? SEARCH_DEFAULTS.SEARCH_EXACT_MAX,
    SEARCH_HNSW_EF_SEARCH: config.SEARCH_HNSW_EF_SEARCH ?? SEARCH_DEFAULTS.SEARCH_HNSW_EF_SEARCH,
    SEARCH_RECONCILE_CRON: config.SEARCH_RECONCILE_CRON ?? SEARCH_DEFAULTS.SEARCH_RECONCILE_CRON,
    SEARCH_EMBED_BATCH: config.SEARCH_EMBED_BATCH ?? SEARCH_DEFAULTS.SEARCH_EMBED_BATCH,
    ...(config.SEARCH_MIN_SIMILARITY !== undefined
      ? { SEARCH_MIN_SIMILARITY: config.SEARCH_MIN_SIMILARITY }
      : {}),
  };
}

/** Chat settings with the shared defaults filled in (`chatEnvSchema`). */
export function chatSettings(config: Partial<ChatEnv>): ChatEnv {
  return {
    CHAT_TURNS_PER_DAY: config.CHAT_TURNS_PER_DAY ?? CHAT_DEFAULTS.CHAT_TURNS_PER_DAY,
    CHAT_MAX_TOOL_ROUNDS: config.CHAT_MAX_TOOL_ROUNDS ?? CHAT_DEFAULTS.CHAT_MAX_TOOL_ROUNDS,
    CHAT_MAX_OUTPUT_TOKENS: config.CHAT_MAX_OUTPUT_TOKENS ?? CHAT_DEFAULTS.CHAT_MAX_OUTPUT_TOKENS,
    CHAT_HISTORY_MESSAGES: config.CHAT_HISTORY_MESSAGES ?? CHAT_DEFAULTS.CHAT_HISTORY_MESSAGES,
    CHAT_MODEL_TIMEOUT_MS: config.CHAT_MODEL_TIMEOUT_MS ?? CHAT_DEFAULTS.CHAT_MODEL_TIMEOUT_MS,
    CHAT_FAST_PATH: config.CHAT_FAST_PATH ?? CHAT_DEFAULTS.CHAT_FAST_PATH,
    // Only when set: unset ⇒ the per-model default applies.
    ...(config.CHAT_FAST_PATH_MIN_SIMILARITY !== undefined
      ? { CHAT_FAST_PATH_MIN_SIMILARITY: config.CHAT_FAST_PATH_MIN_SIMILARITY }
      : {}),
  };
}
