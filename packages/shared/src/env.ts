import { z } from "zod";
import { APP_UPDATE_BASE_URL_MESSAGE, isAppUpdateBaseUrl } from "./app-update";
import { emailSchema, FAMILIES_PER_IP_PER_DAY_DEFAULT, NEVER_BLOCKED_EMAIL_DOMAINS } from "./auth";
import { EXPORT_MAX_BYTES_DEFAULT } from "./constants";
import type { MediaUrlGuardOptions } from "./google-photos";
import { GOOGLE_ENDPOINTS, GOOGLE_MEDIA_HOST_SUFFIX_DEFAULT } from "./imports";
import { APP_ID, NATIVE_ORIGINS_DEFAULT } from "./native";
import {
  PUSH_MIN_GAP_MIN_DEFAULT,
  PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
  PUSH_SHARE_DEBOUNCE_SEC_DEFAULT,
} from "./push";

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
 * (`http://localhost:8080` in dev, `https://tinyglow.app` in production) with any
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
 * the gate). Model/provider/keys stay in `aiEnvSchema` (`@tinyglow/ai`).
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
// Model names, provider and keys stay in `aiEnvSchema` (`@tinyglow/ai`).
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

// ---------------------------------------------------------------------------------------------
// Sharing (docs/plans/step-8.md 2.4, 2.11; PRD "Privacy and child safety": signed URLs ≤ 1 h,
// scoped to one object). Read by the api (media URL TTL) and the worker (reconcile cron). No
// secret here: viewer-JWT and IP-hash keys are HKDF-derived from `JWT_SECRET`.
// ---------------------------------------------------------------------------------------------

/** Defaults of `shareEnvSchema`. */
export const SHARE_DEFAULTS = {
  /**
   * Lifetime of viewer `thumb`/`display` URLs (also capped at the link's expiry), so a revoked
   * link's already-issued media URLs die within minutes (FR-9.7, D6). Parents keep 1 h.
   */
  SHARE_MEDIA_URL_TTL_SEC: 300,
  /** Hourly `share.reconcile`. */
  SHARE_RECONCILE_CRON: "41 * * * *",
} as const;

const SH = SHARE_DEFAULTS;

/** Share-link settings (api: `SHARE_MEDIA_URL_TTL_SEC`; worker: `SHARE_RECONCILE_CRON`). */
export const shareEnvSchema = z.object({
  SHARE_MEDIA_URL_TTL_SEC: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(30).max(900).default(SH.SHARE_MEDIA_URL_TTL_SEC),
  ),
  SHARE_RECONCILE_CRON: z.preprocess(emptyAsUndefined, cronSchema.default(SH.SHARE_RECONCILE_CRON)),
});
export type ShareEnv = z.infer<typeof shareEnvSchema>;

// ---------------------------------------------------------------------------------------------
// Native apps (docs/plans/step-9.md 2.3, 2.5, 2.8, 2.10). Push provider secrets live in the
// worker env only; the CORS allow-list and the store-review account in the api env only. Every
// field below may hold a secret or an identifier: errors name the field, never the value.
// ---------------------------------------------------------------------------------------------

/** Provider endpoints used when the `PUSH_*_URL` overrides (mock servers in tests) are unset. */
export const PUSH_ENDPOINTS = {
  APNS_SANDBOX: "https://api.sandbox.push.apple.com",
  APNS_PRODUCTION: "https://api.push.apple.com",
  FCM: "https://fcm.googleapis.com",
} as const;

/** `PUSH_PROVIDER`: `none` (production default until keys exist), `fake` (dev; refused in production), `live`. */
export const PUSH_PROVIDERS = ["none", "fake", "live"] as const;
export const pushProviderModeSchema = z.enum(PUSH_PROVIDERS);
export type PushProviderMode = z.infer<typeof pushProviderModeSchema>;

const base64Schema = z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "must be base64 on one line");
const overrideUrlSchema = z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, ""));

/**
 * Worker push settings (2.8). `PUSH_PROVIDER=live` sends through APNs when `APNS_TEAM_ID`,
 * `APNS_KEY_ID` and `APNS_PRIVATE_KEY_BASE64` (the `.p8` file, base64) are set, and through FCM
 * HTTP v1 when `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_BASE64` (the service-account JSON,
 * base64) are set; otherwise that provider's sends are `unconfigured`. `PUSH_APNS_BASE_URL`
 * defaults from `APNS_ENVIRONMENT` (`PUSH_ENDPOINTS`), `PUSH_FCM_BASE_URL` to `PUSH_ENDPOINTS.FCM`,
 * `PUSH_OAUTH_TOKEN_URL` to the service account's `token_uri`; the overrides exist for mock
 * servers and must be https in production. `fake` is refused when `NODE_ENV=production`.
 */
export const pushEnvSchema = z
  .object({
    PUSH_PROVIDER: z.preprocess(emptyAsUndefined, pushProviderModeSchema.default("none")),
    APNS_TEAM_ID: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[A-Z0-9]{10}$/)
        .optional(),
    ),
    APNS_KEY_ID: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[A-Z0-9]{10}$/)
        .optional(),
    ),
    APNS_PRIVATE_KEY_BASE64: z.preprocess(emptyAsUndefined, base64Schema.optional()),
    APNS_BUNDLE_ID: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/)
        .default(APP_ID),
    ),
    APNS_ENVIRONMENT: z.preprocess(
      emptyAsUndefined,
      z.enum(["sandbox", "production"]).default("sandbox"),
    ),
    FCM_PROJECT_ID: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[a-z][a-z0-9-]{4,29}$/)
        .optional(),
    ),
    FCM_SERVICE_ACCOUNT_BASE64: z.preprocess(emptyAsUndefined, base64Schema.optional()),
    PUSH_APNS_BASE_URL: z.preprocess(emptyAsUndefined, overrideUrlSchema.optional()),
    PUSH_FCM_BASE_URL: z.preprocess(emptyAsUndefined, overrideUrlSchema.optional()),
    PUSH_OAUTH_TOKEN_URL: z.preprocess(emptyAsUndefined, overrideUrlSchema.optional()),
    PUSH_PHOTOS_DEBOUNCE_SEC: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(0).max(3600).default(PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT),
    ),
    PUSH_SHARE_DEBOUNCE_SEC: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(0).max(3600).default(PUSH_SHARE_DEBOUNCE_SEC_DEFAULT),
    ),
    PUSH_MIN_GAP_MIN: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(0).max(1440).default(PUSH_MIN_GAP_MIN_DEFAULT),
    ),
    /** Same field as `logEnvSchema` (default `production`), read here for the refinements. */
    NODE_ENV: logEnvSchema.shape.NODE_ENV,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (env.PUSH_PROVIDER === "fake") {
      ctx.addIssue({
        code: "custom",
        path: ["PUSH_PROVIDER"],
        message: "fake is refused in production",
      });
    }
    for (const key of [
      "PUSH_APNS_BASE_URL",
      "PUSH_FCM_BASE_URL",
      "PUSH_OAUTH_TOKEN_URL",
    ] as const) {
      const url = env[key];
      if (url !== undefined && !url.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: [key], message: "must be https in production" });
      }
    }
  });
export type PushEnv = z.infer<typeof pushEnvSchema>;

/** One allowed native WebView origin: scheme `capacitor`/`http`/`https`, host, optional port. */
const NATIVE_ORIGIN_RE = /^(capacitor|https?):\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/**
 * API CORS allow-list for the native apps (2.3): `NATIVE_APP_ORIGINS`, a comma-separated list
 * (default `capacitor://localhost,https://localhost`), parsed to a lowercase, de-duplicated
 * array. No wildcard, path or trailing slash is accepted. Unset or empty ⇒ the default.
 */
export const nativeCorsEnvSchema = z.object({
  NATIVE_APP_ORIGINS: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .default(NATIVE_ORIGINS_DEFAULT.join(","))
      .transform((v) => [
        ...new Set(
          v
            .split(",")
            .map((o) => o.trim().toLowerCase())
            .filter((o) => o !== ""),
        ),
      ])
      .pipe(
        z
          .array(z.string().regex(NATIVE_ORIGIN_RE, "each origin must be scheme://host[:port]"))
          .min(1)
          .max(10),
      ),
  ),
});
export type NativeCorsEnv = z.infer<typeof nativeCorsEnvSchema>;

/** `scrypt$1$N$r$p$<salt b64url>$<dk b64url>`, the share-link passcode hash format. */
const SCRYPT_HASH_RE = /^scrypt\$1\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

/**
 * Store-review sign-in (2.5, D4), api only. Off unless both are set: `REVIEW_ACCOUNT_EMAIL`
 * (normalized like every email) and `REVIEW_ACCOUNT_CODE_HASH` (the static code's
 * `scrypt$1$…` hash, same format as share-link passcodes). Exactly one set is an error.
 */
export const reviewAccountEnvSchema = z
  .object({
    REVIEW_ACCOUNT_EMAIL: z.preprocess(emptyAsUndefined, emailSchema.optional()),
    REVIEW_ACCOUNT_CODE_HASH: z.preprocess(
      emptyAsUndefined,
      z.string().max(512).regex(SCRYPT_HASH_RE, "must be a scrypt$1$ hash").optional(),
    ),
  })
  .superRefine((env, ctx) => {
    const hasEmail = env.REVIEW_ACCOUNT_EMAIL !== undefined;
    const hasHash = env.REVIEW_ACCOUNT_CODE_HASH !== undefined;
    if (hasEmail === hasHash) return;
    ctx.addIssue({
      code: "custom",
      path: [hasEmail ? "REVIEW_ACCOUNT_CODE_HASH" : "REVIEW_ACCOUNT_EMAIL"],
      message: "set both REVIEW_ACCOUNT_EMAIL and REVIEW_ACCOUNT_CODE_HASH, or neither",
    });
  });
export type ReviewAccountEnv = z.infer<typeof reviewAccountEnvSchema>;

/**
 * Passkeys (docs/plans/step-13.md 2.3, 2.7), api only. `AUTH_PASSKEYS_ENABLED` must equal
 * GoTrue's `GOTRUE_PASSKEY_ENABLED` (both compose files feed them from the one `.env` flag, like
 * the social providers); when false every `/auth/passkey/*` and `/me/passkeys*` route answers
 * 404 `passkey_disabled` and `GET /auth/config` reports `passkeys: false`.
 */
export const passkeyEnvSchema = z.object({
  AUTH_PASSKEYS_ENABLED: z.preprocess(emptyAsUndefined, z.stringbool().default(false)),
});
export type PasskeyEnv = z.infer<typeof passkeyEnvSchema>;

/** True when the store-review sign-in is configured (both review vars set). */
export function reviewAccountEnabled(
  env: ReviewAccountEnv,
): env is ReviewAccountEnv & { REVIEW_ACCOUNT_EMAIL: string; REVIEW_ACCOUNT_CODE_HASH: string } {
  return env.REVIEW_ACCOUNT_EMAIL !== undefined && env.REVIEW_ACCOUNT_CODE_HASH !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Data export (docs/plans/review-fixes.md 2.2, 2.3, D5). Worker only.
// ---------------------------------------------------------------------------------------------

const GIB = 1024 * 1024 * 1024;

/**
 * Worker export settings: `EXPORT_MAX_BYTES` caps the summed size of the originals one export
 * may stream (default 100 GiB, at least 1 GiB); a larger album fails with `too_large`. An export
 * temporarily doubles the album's storage footprint until it expires.
 */
export const exportEnvSchema = z.object({
  EXPORT_MAX_BYTES: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(GIB).default(EXPORT_MAX_BYTES_DEFAULT),
  ),
});
export type ExportEnv = z.infer<typeof exportEnvSchema>;

// ---------------------------------------------------------------------------------------------
// Video (docs/plans/step-12.md 2.3, 2.6, 2.10, Q8). Worker only; the api needs nothing new.
// ---------------------------------------------------------------------------------------------

/** Defaults of `videoEnvSchema`. */
export const VIDEO_DEFAULTS = {
  /** `video.transcode` jobs in flight (each one is a whole ffmpeg process). */
  VIDEO_CONCURRENCY: 1,
  /**
   * Disk-backed folder where originals are staged and renditions written (Q8): the 1 GiB `/tmp`
   * tmpfs cannot hold a 2 GB clip plus its rendition. Production mounts `WORKER_SCRATCH_PATH`
   * (e.g. `/mnt/data/tinyglow/scratch`) at `/scratch`; dev uses a named volume at the same path;
   * tests may point it at `/tmp/ll-scratch`.
   */
  WORKER_SCRATCH_PATH: "/scratch",
  FFMPEG_PATH: "ffmpeg",
  FFPROBE_PATH: "ffprobe",
  /** `-threads` of libx264 (a 2-vCPU box keeps one for ingest). */
  VIDEO_FFMPEG_THREADS: 2,
  /** One ffmpeg run is killed after this long (then retried; the last attempt marks `transcode_failed`). */
  VIDEO_TRANSCODE_TIMEOUT_SEC: 3600,
} as const;

const V = VIDEO_DEFAULTS;

/** An absolute path with no whitespace or quotes (it is passed to ffmpeg as an argument). */
const scratchPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\/[^\s"'`$]*$/, "must be an absolute path")
  .transform((p) => (p.length > 1 ? p.replace(/\/+$/, "") : p));

/** An executable name or absolute path (no whitespace, quotes or shell characters). */
const binaryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._/-]+$/, "must be a program name or path");

/**
 * Worker video settings. Every value is passed to `child_process.spawn` as a discrete argument
 * (never a shell string), and ffmpeg never receives a URL: sources and outputs are files under
 * `WORKER_SCRATCH_PATH`. Nothing here is a secret; errors still name the field only.
 */
export const videoEnvSchema = z.object({
  VIDEO_CONCURRENCY: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(2).default(V.VIDEO_CONCURRENCY),
  ),
  WORKER_SCRATCH_PATH: z.preprocess(
    emptyAsUndefined,
    scratchPathSchema.default(V.WORKER_SCRATCH_PATH),
  ),
  FFMPEG_PATH: z.preprocess(emptyAsUndefined, binaryPathSchema.default(V.FFMPEG_PATH)),
  FFPROBE_PATH: z.preprocess(emptyAsUndefined, binaryPathSchema.default(V.FFPROBE_PATH)),
  VIDEO_FFMPEG_THREADS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(8).default(V.VIDEO_FFMPEG_THREADS),
  ),
  VIDEO_TRANSCODE_TIMEOUT_SEC: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(60).max(86_400).default(V.VIDEO_TRANSCODE_TIMEOUT_SEC),
  ),
});
export type VideoEnv = z.output<typeof videoEnvSchema>;

// ---------------------------------------------------------------------------------------------
// Sentry (docs/plans/review-fixes.md 2.6, D8; PRD "Observability", "Environment variables":
// `SENTRY_DSN`). Errors only, scrubbed by `scrubTelemetryEvent`; off unless a DSN is set (dev
// sets none). api and worker read `SENTRY_DSN`; the web build reads `VITE_SENTRY_DSN` (from
// `SENTRY_WEB_DSN`) and may validate it with `sentryDsnSchema`. The DSN is not a secret in the
// usual sense, but config errors still name the field only.
// ---------------------------------------------------------------------------------------------

/**
 * A Sentry DSN: `http(s)://<public key>@<host>[/<path>]/<numeric project id>`. Empty or unset means "off" (the
 * callers' `emptyAsUndefined`); anything else that is not such a URL fails boot.
 */
export const sentryDsnSchema = z.url({ protocol: /^https?$/ }).refine((u) => {
  try {
    const url = new URL(u);
    return url.username !== "" && /^(\/[0-9A-Za-z._-]+)*\/[0-9]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}, "must be a Sentry DSN (scheme://key@host/project)");

/** `SENTRY_ENVIRONMENT` value: a short tag (`production`, `staging`, …). */
const sentryEnvironmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/, "letters, digits, '.', '_' or '-' only");

/**
 * api and worker Sentry settings. `SENTRY_DSN` unset/empty ⇒ Sentry is never initialised (no
 * network). `SENTRY_ENVIRONMENT` defaults to `NODE_ENV` (read here, same default as
 * `logEnvSchema`); the parsed output carries `SENTRY_DSN` (or undefined) and the resolved
 * `SENTRY_ENVIRONMENT` only.
 */
export const sentryEnvSchema = z
  .object({
    SENTRY_DSN: z.preprocess(emptyAsUndefined, sentryDsnSchema.optional()),
    SENTRY_ENVIRONMENT: z.preprocess(emptyAsUndefined, sentryEnvironmentSchema.optional()),
    NODE_ENV: logEnvSchema.shape.NODE_ENV,
  })
  .transform((env) => ({
    SENTRY_DSN: env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
  }));
export type SentryEnv = z.output<typeof sentryEnvSchema>;

// ---------------------------------------------------------------------------------------------
// Photo import (docs/plans/step-10.md 2.3, 2.6, 2.7, 2.10, D6, D7). Read by the api (OAuth,
// Picker sessions) and the worker (downloads; `IMPORT_CONCURRENCY`). The client secret reaches
// these two services only. Errors name the field, never the value.
// ---------------------------------------------------------------------------------------------

/** `GOOGLE_IMPORT_PROVIDER`: `none` (production default), `fake` (dev/CI; refused in production), `live`. */
export const GOOGLE_IMPORT_PROVIDERS = ["none", "fake", "live"] as const;
export const googleImportProviderSchema = z.enum(GOOGLE_IMPORT_PROVIDERS);
export type GoogleImportProvider = z.infer<typeof googleImportProviderSchema>;

/** Defaults of `googleImportEnvSchema`. */
export const GOOGLE_IMPORT_DEFAULTS = {
  GOOGLE_IMPORT_PROVIDER: "none",
  /** The fake Picker server as the api/worker reach it (Compose service `google-fake`). */
  GOOGLE_IMPORT_FAKE_URL: "http://google-fake:8099",
  /** The fake as the browser reaches it (consent and picker pages); api only. */
  GOOGLE_IMPORT_FAKE_PUBLIC_URL: "http://localhost:8099",
  GOOGLE_IMPORT_MEDIA_HOSTS: GOOGLE_MEDIA_HOST_SUFFIX_DEFAULT,
  /** Downloads in flight per `import.google` job (worker /tmp holds ≤ this × 100 MiB). */
  IMPORT_CONCURRENCY: 2,
} as const;

const GI = GOOGLE_IMPORT_DEFAULTS;

/** One media host suffix: lowercase DNS name of ≥ 2 labels, the last one alphabetic (no IP literal). */
const MEDIA_HOST_SUFFIX_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Photo import settings (api and worker).
 * - `GOOGLE_IMPORT_CLIENT_ID` / `GOOGLE_IMPORT_CLIENT_SECRET`: the Google "Web application"
 *   OAuth client (D18); both required when `live`, ignored otherwise.
 * - `GOOGLE_IMPORT_FAKE_URL` / `GOOGLE_IMPORT_FAKE_PUBLIC_URL`: used only when `fake`.
 * - `GOOGLE_IMPORT_MEDIA_HOSTS`: comma-separated host suffixes a Picker `baseUrl` may point at
 *   (parsed to a lowercase, de-duplicated array); the SSRF guard (`parseAllowedMediaUrl`) allows
 *   https hosts equal to or under one of them. In `fake` mode the fake's own origin is added by
 *   `googleImportMediaAllowList`, not here.
 * - `IMPORT_CONCURRENCY` (worker): 1..4.
 * `fake` is refused when `NODE_ENV=production` (like `PUSH_PROVIDER`).
 */
export const googleImportEnvSchema = z
  .object({
    GOOGLE_IMPORT_PROVIDER: z.preprocess(
      emptyAsUndefined,
      googleImportProviderSchema.default(GI.GOOGLE_IMPORT_PROVIDER),
    ),
    GOOGLE_IMPORT_CLIENT_ID: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .max(256)
        .regex(/^[A-Za-z0-9._-]+$/, "must be an OAuth client id")
        .optional(),
    ),
    GOOGLE_IMPORT_CLIENT_SECRET: z.preprocess(
      emptyAsUndefined,
      z.string().max(512).regex(/^\S+$/, "must not contain whitespace").optional(),
    ),
    GOOGLE_IMPORT_FAKE_URL: z.preprocess(
      emptyAsUndefined,
      overrideUrlSchema.default(GI.GOOGLE_IMPORT_FAKE_URL),
    ),
    GOOGLE_IMPORT_FAKE_PUBLIC_URL: z.preprocess(
      emptyAsUndefined,
      overrideUrlSchema.default(GI.GOOGLE_IMPORT_FAKE_PUBLIC_URL),
    ),
    GOOGLE_IMPORT_MEDIA_HOSTS: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .default(GI.GOOGLE_IMPORT_MEDIA_HOSTS)
        .transform((v) => [
          ...new Set(
            v
              .split(",")
              .map((h) => h.trim().toLowerCase().replace(/^\.+/, ""))
              .filter((h) => h !== ""),
          ),
        ])
        .pipe(
          z
            .array(
              z.string().max(253).regex(MEDIA_HOST_SUFFIX_RE, "each entry must be a host suffix"),
            )
            .min(1)
            .max(10),
        ),
    ),
    IMPORT_CONCURRENCY: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(1).max(4).default(GI.IMPORT_CONCURRENCY),
    ),
    /** Same field as `logEnvSchema` (default `production`), read here for the refinements. */
    NODE_ENV: logEnvSchema.shape.NODE_ENV,
  })
  .superRefine((env, ctx) => {
    if (env.GOOGLE_IMPORT_PROVIDER === "fake" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_IMPORT_PROVIDER"],
        message: "fake is refused in production",
      });
    }
    if (env.GOOGLE_IMPORT_PROVIDER === "live") {
      for (const key of ["GOOGLE_IMPORT_CLIENT_ID", "GOOGLE_IMPORT_CLIENT_SECRET"] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "required when GOOGLE_IMPORT_PROVIDER=live",
          });
        }
      }
    }
  });
export type GoogleImportEnv = z.infer<typeof googleImportEnvSchema>;

/** Where the api/worker talk to Google (or the fake). */
export interface GoogleImportEndpoints {
  /** Consent page, opened by the **browser** (`fake`: `GOOGLE_IMPORT_FAKE_PUBLIC_URL`). */
  readonly authUrl: string;
  /** Token exchange / refresh (server to server). */
  readonly tokenUrl: string;
  /** Token revocation (server to server). */
  readonly revokeUrl: string;
  /** Picker API base; paths `/v1/sessions`, `/v1/mediaItems` are appended. */
  readonly pickerBaseUrl: string;
}

/**
 * Endpoints for the configured provider: `GOOGLE_ENDPOINTS` when `live`; the fake's paths
 * (`/o/oauth2/v2/auth` on the public base, `/token`, `/revoke`, Picker at the root of the internal
 * base) when `fake`; `null` when `none` (the feature is unavailable).
 */
export function googleImportEndpoints(
  env: Pick<
    GoogleImportEnv,
    "GOOGLE_IMPORT_PROVIDER" | "GOOGLE_IMPORT_FAKE_URL" | "GOOGLE_IMPORT_FAKE_PUBLIC_URL"
  >,
): GoogleImportEndpoints | null {
  switch (env.GOOGLE_IMPORT_PROVIDER) {
    case "live":
      return {
        authUrl: GOOGLE_ENDPOINTS.AUTH,
        tokenUrl: GOOGLE_ENDPOINTS.TOKEN,
        revokeUrl: GOOGLE_ENDPOINTS.REVOKE,
        pickerBaseUrl: GOOGLE_ENDPOINTS.PICKER,
      };
    case "fake": {
      const internal = env.GOOGLE_IMPORT_FAKE_URL.replace(/\/+$/, "");
      const external = env.GOOGLE_IMPORT_FAKE_PUBLIC_URL.replace(/\/+$/, "");
      return {
        authUrl: `${external}/o/oauth2/v2/auth`,
        tokenUrl: `${internal}/token`,
        revokeUrl: `${internal}/revoke`,
        pickerBaseUrl: internal,
      };
    }
    default:
      return null;
  }
}

/** Arguments of the download guard: `parseAllowedMediaUrl(url, a.hostSuffixes, a)`. */
export interface GoogleMediaAllowList extends MediaUrlGuardOptions {
  readonly hostSuffixes: readonly string[];
  readonly exactOrigins: readonly string[];
}

/**
 * The worker's download allow-list: `GOOGLE_IMPORT_MEDIA_HOSTS`, plus, in `fake` mode only, the
 * exact origin of `GOOGLE_IMPORT_FAKE_URL` (http and a port are accepted for that origin alone;
 * the schema refuses `fake` in production).
 */
export function googleImportMediaAllowList(
  env: Pick<
    GoogleImportEnv,
    "GOOGLE_IMPORT_PROVIDER" | "GOOGLE_IMPORT_FAKE_URL" | "GOOGLE_IMPORT_MEDIA_HOSTS"
  >,
): GoogleMediaAllowList {
  const exactOrigins: string[] = [];
  if (env.GOOGLE_IMPORT_PROVIDER === "fake") {
    try {
      exactOrigins.push(new URL(env.GOOGLE_IMPORT_FAKE_URL).origin);
    } catch {
      // the schema already validated the URL; nothing to add otherwise
    }
  }
  return Object.freeze({
    hostSuffixes: Object.freeze([...env.GOOGLE_IMPORT_MEDIA_HOSTS]),
    exactOrigins: Object.freeze(exactOrigins),
  });
}

// ---------------------------------------------------------------------------------------------
// Family-start safeguards (docs/plans/step-11.md 2.3, 2.4, 2.10, D-H, D-J). api only. The
// disposable-domain list itself is vendored and compiled into the api
// (`apps/api/src/auth/disposable/`); these vars only tune it. Errors name the field, never the value.
// ---------------------------------------------------------------------------------------------

/** Most entries accepted in `EMAIL_DOMAIN_DENYLIST` / `EMAIL_DOMAIN_ALLOWLIST` each. */
export const EMAIL_DOMAIN_LIST_MAX = 1000;

const NEVER_BLOCKED: ReadonlySet<string> = new Set(NEVER_BLOCKED_EMAIL_DOMAINS);

/**
 * A comma-separated domain list → lowercase, trimmed, leading/trailing dots removed,
 * de-duplicated array (empty or unset ⇒ `[]`). Each entry must be a DNS name of ≥ 2 labels with
 * an alphabetic last label (the media host-suffix rule). With `dropNeverBlocked`, entries of
 * `NEVER_BLOCKED_EMAIL_DOMAINS` are removed (they always win over the deny list).
 */
function domainListSchema(dropNeverBlocked: boolean) {
  return z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .default("")
      .transform((v) => [
        ...new Set(
          v
            .split(",")
            .map((d) =>
              d
                .trim()
                .toLowerCase()
                .replace(/^\.+|\.+$/g, ""),
            )
            .filter((d) => d !== "" && !(dropNeverBlocked && NEVER_BLOCKED.has(d))),
        ),
      ])
      .pipe(
        z
          .array(z.string().max(253).regex(MEDIA_HOST_SUFFIX_RE, "each entry must be a domain"))
          .max(EMAIL_DOMAIN_LIST_MAX),
      ),
  );
}

/**
 * Family-start safeguards (api), checked when an account creates its first album:
 * - `FAMILIES_PER_IP_PER_DAY` (1..100000, default `FAMILIES_PER_IP_PER_DAY_DEFAULT` = 5): new
 *   families per client IP per rolling 24 h, counted in `family_starts`; guests start nothing and
 *   never count. Dev Compose sets 1000 (seed and e2e start many families from one IP).
 * - `BLOCK_DISPOSABLE_EMAIL` (stringbool, default true): refuse starting a family from an address
 *   on the vendored disposable-domain list (`EMAIL_DOMAIN_DENYLIST` additions apply even when
 *   false). Signing in and joining as a guest are never blocked.
 * - `EMAIL_DOMAIN_DENYLIST`: extra domains treated as disposable (subdomains match too);
 *   `NEVER_BLOCKED_EMAIL_DOMAINS` entries are dropped from it.
 * - `EMAIL_DOMAIN_ALLOWLIST`: domains removed from the block (operator override, exact match).
 */
export const abuseEnvSchema = z.object({
  FAMILIES_PER_IP_PER_DAY: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(100_000).default(FAMILIES_PER_IP_PER_DAY_DEFAULT),
  ),
  BLOCK_DISPOSABLE_EMAIL: z.preprocess(emptyAsUndefined, z.stringbool().default(true)),
  EMAIL_DOMAIN_DENYLIST: domainListSchema(true),
  EMAIL_DOMAIN_ALLOWLIST: domainListSchema(false),
});
export type AbuseEnv = z.infer<typeof abuseEnvSchema>;

// ---------------------------------------------------------------------------------------------
// Live updates (docs/plans/step-14.md 2.3, 2.6, D2, D7). api only: the signing key must reach no
// other service (`check-compose-keys.mjs`). Errors name the field, never the value.
// ---------------------------------------------------------------------------------------------

/** Where the api fetches the web image's manifest over the Compose network. */
export const APP_UPDATE_SOURCE_URL_DEFAULT = "http://web/app-update/manifest.json";

/** Like `emptyAsUndefined`, also for whitespace-only strings (a pasted key line). */
const blankAsUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/**
 * api live-update settings:
 * - `APP_UPDATE_ENABLED` (stringbool, default true): `false` ⇒ every check answers `disabled`.
 * - `APP_UPDATE_SIGNING_KEY_BASE64`: base64 PKCS#8 DER of the EC P-256 private key (trimmed).
 *   Unset or empty ⇒ feature off (`disabled`). Its shape and public half are checked by the
 *   api's signer, not here: a wrong key turns the feature off with one log line, it does not stop
 *   the api.
 * - `APP_UPDATE_SOURCE_URL`: the manifest upstream (default `APP_UPDATE_SOURCE_URL_DEFAULT`).
 * - `APP_UPDATE_FILES_BASE_URL`: the signed `baseUrl` (default `PUBLIC_URL`, resolved by the api);
 *   trailing slashes removed, then the `isAppUpdateBaseUrl` rules apply.
 */
export const appUpdateEnvSchema = z.object({
  APP_UPDATE_ENABLED: z.preprocess(emptyAsUndefined, z.stringbool().default(true)),
  APP_UPDATE_SIGNING_KEY_BASE64: z.preprocess(
    blankAsUndefined,
    z.string().trim().min(1).max(4096).optional(),
  ),
  APP_UPDATE_SOURCE_URL: z.preprocess(
    emptyAsUndefined,
    z.url({ protocol: /^https?$/ }).default(APP_UPDATE_SOURCE_URL_DEFAULT),
  ),
  APP_UPDATE_FILES_BASE_URL: z.preprocess(
    emptyAsUndefined,
    z
      .url({ protocol: /^https?$/ })
      .transform((u) => u.replace(/\/+$/, ""))
      .refine(isAppUpdateBaseUrl, APP_UPDATE_BASE_URL_MESSAGE)
      .optional(),
  ),
});
export type AppUpdateEnv = z.output<typeof appUpdateEnvSchema>;
