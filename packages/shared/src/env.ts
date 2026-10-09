import { z } from "zod";

// Environment schemas shared by api, worker and db tooling (docs/plans/step-1.md 2.10, 2.5).
// Apps compose these in their own config modules and fail fast on invalid env, printing field
// names only (never values: several of these are secrets or contain credentials).

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url(),
});
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

/**
 * S3-compatible object storage (MinIO in every environment).
 * - `S3_ENDPOINT`: internal endpoint for server-side calls (e.g. `http://storage:9000`).
 * - `S3_PUBLIC_ENDPOINT`: endpoint used only when signing URLs handed to clients.
 */
export const s3EnvSchema = z.object({
  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  /** Env strings "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off"; MinIO needs path-style. */
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
});
export type S3Env = z.infer<typeof s3EnvSchema>;

/**
 * GoTrue signs JWTs with `GOTRUE_JWT_SECRET`; api/worker verify with `JWT_SECRET`. When both are
 * present they must be identical, otherwise every token would fail verification at runtime, so
 * the mismatch is rejected at boot.
 */
export const jwtEnvSchema = z
  .object({
    JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
    GOTRUE_JWT_SECRET: z.string().min(1).optional(),
  })
  .refine(
    (env) => env.GOTRUE_JWT_SECRET === undefined || env.GOTRUE_JWT_SECRET === env.JWT_SECRET,
    {
      path: ["GOTRUE_JWT_SECRET"],
      message: "must equal JWT_SECRET",
    },
  );
export type JwtEnv = z.infer<typeof jwtEnvSchema>;

export const logEnvSchema = z.object({
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
});
export type LogEnv = z.infer<typeof logEnvSchema>;

/**
 * Key for pgcrypto encryption of GPS and home coordinates (docs/plans/step-2.md 2.7). The app
 * sets it per transaction with `SELECT set_config('app.data_key', $1, true)` (bind parameter,
 * never in statement text, never logged). Production: `openssl rand -hex 32`.
 */
export const encryptionEnvSchema = z.object({
  DATA_ENCRYPTION_KEY: z.string().min(32, "must be at least 32 characters"),
});
export type EncryptionEnv = z.infer<typeof encryptionEnvSchema>;

/** Compose passes unset optional vars as `""` (`${VAR:-}`); treat that as absent. */
const emptyAsUndefined = (v: unknown) => (v === "" ? undefined : v);

/**
 * API auth settings (docs/plans/step-3.md 2.6, 2.8). `PUBLIC_URL` is the browser origin
 * (`http://localhost:8080` in dev, `https://littlelight.tesarsoft.com` in production) with any
 * trailing slash removed; GoTrue's JWT issuer is `${PUBLIC_URL}/auth`. The provider flags are fed
 * by the same `.env` values as GoTrue's `GOTRUE_EXTERNAL_*_ENABLED`. Turnstile is inert unless
 * `TURNSTILE_SECRET_KEY` is set.
 */
export const authEnvSchema = z.object({
  AUTH_INTERNAL_URL: z.preprocess(emptyAsUndefined, z.url().default("http://auth:9999")),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, "")),
  AUTH_APPLE_ENABLED: z.preprocess(emptyAsUndefined, z.stringbool().default(false)),
  AUTH_GOOGLE_ENABLED: z.preprocess(emptyAsUndefined, z.stringbool().default(false)),
  TURNSTILE_SECRET_KEY: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  TURNSTILE_SITE_KEY: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
});
export type AuthEnv = z.infer<typeof authEnvSchema>;

/**
 * SMTP for API-sent mail (invites, new-device alerts). Mailpit in dev (`mail:1025`, no auth),
 * Postmark/Resend SMTP in production. `SMTP_SECURE=true` means implicit TLS (port 465); with
 * `false` the transport still upgrades via STARTTLS when offered.
 */
export const mailEnvSchema = z.object({
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(1).max(65535).default(587)),
  SMTP_USER: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  SMTP_PASS: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  SMTP_SECURE: z.preprocess(emptyAsUndefined, z.stringbool().default(false)),
  MAIL_FROM: z.email(),
});
export type MailEnv = z.infer<typeof mailEnvSchema>;

/**
 * Worker ingest settings (docs/plans/step-4.md 2.6, 2.9, 2.11). `STORAGE_DISK_PATH` is a
 * read-only mount of the storage volume for the disk-usage alert (unset ⇒ check skipped).
 * `CSAM_MATCHER=photodna` needs `PHOTODNA_API_KEY` and `PHOTODNA_ENDPOINT`; the worker's
 * `createCsamMatcher` fails at startup without them. Never log `PHOTODNA_API_KEY`.
 */
export const ingestEnvSchema = z.object({
  INGEST_CONCURRENCY: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(8).default(2),
  ),
  STORAGE_DISK_PATH: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  STORAGE_DISK_ALERT_PCT: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(50).max(99).default(80),
  ),
  CSAM_MATCHER: z.preprocess(emptyAsUndefined, z.enum(["none", "photodna"]).default("none")),
  PHOTODNA_API_KEY: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  PHOTODNA_ENDPOINT: z.preprocess(emptyAsUndefined, z.url().optional()),
});
export type IngestEnv = z.infer<typeof ingestEnvSchema>;

/**
 * Defaults of the AI batch pipeline (docs/plans/step-6.md 2.4, 2.6; PRD FR-5.2 "flushed every 30
 * minutes or at 1,000 photos", "Cost controls", "Reliability and operations": alert when queue
 * age > 2 h; plan D12: $3 per baby per month hard stop, alert at 80 %). The API mirrors
 * `AI_MAX_ATTEMPTS` and the budget for `aiStatus`/usage, so both read them from here.
 */
export const AI_PIPELINE_DEFAULTS = {
  AI_BATCH_MAX_PHOTOS: 1000,
  AI_BATCH_FLUSH_MINUTES: 30,
  /** Bytes of one provider batch input (OpenAI's file limit is 200 MB; Anthropic's 256 MB). */
  AI_BATCH_MAX_BYTES: 150_000_000,
  AI_POLL_INTERVAL_CRON: "*/5 * * * *",
  AI_FLUSH_INTERVAL_CRON: "*/5 * * * *",
  /** FR-5.3: one retry, then `aiStatus = failed` until an admin requests a retry. */
  AI_MAX_ATTEMPTS: 2,
  AI_BABY_MONTHLY_BUDGET_USD: 3,
  AI_BUDGET_ALERT_PCT: 80,
  AI_QUEUE_AGE_ALERT_MINUTES: 120,
  AI_MAX_OUTPUT_TOKENS: 1200,
  AI_IMAGE_DETAIL: "auto",
} as const;

export const AI_IMAGE_DETAILS = ["auto", "low", "high"] as const;

/** Five-field cron expression (pg-boss `schedule`); syntax only, pg-boss validates the rest. */
const cronSchema = z
  .string()
  .trim()
  .regex(/^\S+(\s+\S+){4}$/, "must be a five-field cron expression");

const D = AI_PIPELINE_DEFAULTS;

/**
 * AI batch pipeline settings, read by the worker (all) and the API (`AI_MAX_ATTEMPTS`,
 * `AI_BABY_MONTHLY_BUDGET_USD`). `AI_BATCH_FLUSH_MINUTES=0` submits on every flush tick (dev and
 * the gate). Model/provider/keys stay in `aiEnvSchema` (`@littlelight/ai`).
 */
export const aiPipelineEnvSchema = z.object({
  AI_BATCH_MAX_PHOTOS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(5000).default(D.AI_BATCH_MAX_PHOTOS),
  ),
  AI_BATCH_FLUSH_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(0).max(1440).default(D.AI_BATCH_FLUSH_MINUTES),
  ),
  AI_BATCH_MAX_BYTES: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1_000_000).max(200_000_000).default(D.AI_BATCH_MAX_BYTES),
  ),
  AI_POLL_INTERVAL_CRON: z.preprocess(
    emptyAsUndefined,
    cronSchema.default(D.AI_POLL_INTERVAL_CRON),
  ),
  AI_FLUSH_INTERVAL_CRON: z.preprocess(
    emptyAsUndefined,
    cronSchema.default(D.AI_FLUSH_INTERVAL_CRON),
  ),
  AI_MAX_ATTEMPTS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(5).default(D.AI_MAX_ATTEMPTS),
  ),
  AI_BABY_MONTHLY_BUDGET_USD: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().min(0).max(1000).default(D.AI_BABY_MONTHLY_BUDGET_USD),
  ),
  AI_BUDGET_ALERT_PCT: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(50).max(100).default(D.AI_BUDGET_ALERT_PCT),
  ),
  AI_QUEUE_AGE_ALERT_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(10_080).default(D.AI_QUEUE_AGE_ALERT_MINUTES),
  ),
  AI_MAX_OUTPUT_TOKENS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(256).max(16_384).default(D.AI_MAX_OUTPUT_TOKENS),
  ),
  AI_IMAGE_DETAIL: z.preprocess(
    emptyAsUndefined,
    z.enum(AI_IMAGE_DETAILS).default(D.AI_IMAGE_DETAIL),
  ),
});
export type AiPipelineEnv = z.infer<typeof aiPipelineEnvSchema>;

// ---------------------------------------------------------------------------------------------
// Search and chat (docs/plans/step-7.md 2.4, 2.7, 2.9; PRD "Chat and RAG pipeline", "Cost
// controls": 100 chat turns per user per day). Read by the api (both) and the worker (search).
// Model names, provider and keys stay in `aiEnvSchema` (`@littlelight/ai`).
// ---------------------------------------------------------------------------------------------

/** Defaults of `searchEnvSchema`. */
export const SEARCH_DEFAULTS = {
  /** `off` (default, D6) or `llm` (one extra chat-model call re-ranks the top 30 captions). */
  SEARCH_RERANK: "off",
  /** Filtered candidate sets up to this size use an exact cosine scan instead of HNSW (D9). */
  SEARCH_EXACT_MAX: 2000,
  /** `SET LOCAL hnsw.ef_search` for the HNSW path (pgvector default 40). */
  SEARCH_HNSW_EF_SEARCH: 100,
  /** Hourly `search.reconcile`. */
  SEARCH_RECONCILE_CRON: "17 * * * *",
  /** Search documents per embedding request. */
  SEARCH_EMBED_BATCH: 100,
} as const;

export const SEARCH_RERANK_MODES = ["off", "llm"] as const;

const S = SEARCH_DEFAULTS;

/** Hybrid search and indexer settings (api: rerank/exact/ef_search; worker: cron/batch). */
export const searchEnvSchema = z.object({
  SEARCH_RERANK: z.preprocess(
    emptyAsUndefined,
    z.enum(SEARCH_RERANK_MODES).default(S.SEARCH_RERANK),
  ),
  SEARCH_EXACT_MAX: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(100).max(20_000).default(S.SEARCH_EXACT_MAX),
  ),
  SEARCH_HNSW_EF_SEARCH: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(40).max(1000).default(S.SEARCH_HNSW_EF_SEARCH),
  ),
  SEARCH_RECONCILE_CRON: z.preprocess(
    emptyAsUndefined,
    cronSchema.default(S.SEARCH_RECONCILE_CRON),
  ),
  SEARCH_EMBED_BATCH: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(512).default(S.SEARCH_EMBED_BATCH),
  ),
  /**
   * Relevance floor (cosine similarity) for candidates found by the vector leg only; unset ⇒ the
   * embedding model's default (`defaultMinSimilarity` in apps/api: 0.30 real, 0.60 fake).
   */
  SEARCH_MIN_SIMILARITY: z.preprocess(emptyAsUndefined, z.coerce.number().min(0).max(1).optional()),
});
export type SearchEnv = z.infer<typeof searchEnvSchema>;

/** Defaults of `chatEnvSchema`. */
export const CHAT_DEFAULTS = {
  /** PRD "Cost controls": 100 turns per user per rolling 24 h (across babies). */
  CHAT_TURNS_PER_DAY: 100,
  /** Model calls per turn (each may request tools); then a fixed "be more specific" answer. */
  CHAT_MAX_TOOL_ROUNDS: 4,
  CHAT_MAX_OUTPUT_TOKENS: 800,
  /** Earlier user/assistant messages replayed as context (text only; tool traffic is never stored). */
  CHAT_HISTORY_MESSAGES: 20,
  /** Per model call; a turn is bounded by `CHAT_MODEL_TIMEOUT_MS × CHAT_MAX_TOOL_ROUNDS`. */
  CHAT_MODEL_TIMEOUT_MS: 30_000,
  /**
   * Find-photos fast path: when the first model call only asks for `search_photos`, the server
   * writes the short answer itself (one model call instead of two; facts and summaries keep the
   * model-written answer).
   */
  CHAT_FAST_PATH: true,
} as const;

const C = CHAT_DEFAULTS;

/** Chat endpoint settings (api). */
export const chatEnvSchema = z.object({
  CHAT_TURNS_PER_DAY: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(10_000).default(C.CHAT_TURNS_PER_DAY),
  ),
  CHAT_MAX_TOOL_ROUNDS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(8).default(C.CHAT_MAX_TOOL_ROUNDS),
  ),
  CHAT_MAX_OUTPUT_TOKENS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(128).max(4096).default(C.CHAT_MAX_OUTPUT_TOKENS),
  ),
  CHAT_HISTORY_MESSAGES: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(0).max(100).default(C.CHAT_HISTORY_MESSAGES),
  ),
  CHAT_MODEL_TIMEOUT_MS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1000).max(300_000).default(C.CHAT_MODEL_TIMEOUT_MS),
  ),
  CHAT_FAST_PATH: z.preprocess(emptyAsUndefined, z.stringbool().default(C.CHAT_FAST_PATH)),
  /**
   * Fast-path confidence: without a lexical match, the best result's cosine similarity must reach
   * this for the server-written answer; unset ⇒ the embedding model's default
   * (`defaultFastPathMinSimilarity` in apps/api: 0.38 real, 0.60 fake).
   */
  CHAT_FAST_PATH_MIN_SIMILARITY: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().min(0).max(1).optional(),
  ),
});
export type ChatEnv = z.infer<typeof chatEnvSchema>;
