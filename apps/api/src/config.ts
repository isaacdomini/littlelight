import {
  type AbuseEnv,
  APP_UPDATE_SOURCE_URL_DEFAULT,
  type AppUpdateEnv,
  abuseEnvSchema,
  aiPipelineEnvSchema,
  appUpdateEnvSchema,
  authEnvSchema,
  CHAT_DEFAULTS,
  type ChatEnv,
  chatEnvSchema,
  databaseEnvSchema,
  EMBED_DIMS,
  encryptionEnvSchema,
  FAMILIES_PER_IP_PER_DAY_DEFAULT,
  GOOGLE_IMPORT_DEFAULTS,
  type GoogleImportEnv,
  googleImportEnvSchema,
  isAppUpdateBaseUrl,
  jwtEnvSchema,
  logEnvSchema,
  mailEnvSchema,
  NATIVE_ORIGINS_DEFAULT,
  type NativeCorsEnv,
  nativeCorsEnvSchema,
  type PasskeyEnv,
  PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
  PUSH_SHARE_DEBOUNCE_SEC_DEFAULT,
  passkeyEnvSchema,
  pushEnvSchema,
  type ReviewAccountEnv,
  reviewAccountEnvSchema,
  SEARCH_DEFAULTS,
  type SearchEnv,
  type SentryEnv,
  SHARE_DEFAULTS,
  type ShareEnv,
  s3EnvSchema,
  searchEnvSchema,
  sentryEnvSchema,
  shareEnvSchema,
} from "@tinyglow/shared";
import { z } from "zod";

// API configuration (docs/plans/step-1.md 2.5, 2.8; docs/plans/step-2.md 2.12). Fails fast on
// missing or invalid env and reports field names only: values are secrets or contain credentials
// (DATABASE_URL, S3 keys, DATA_ENCRYPTION_KEY). From step 2, DATABASE_URL is the
// `tinyglow_api` role (never the superuser); every request-scoped query will run inside
// `withClaims` (step 3: BEGIN; SET LOCAL ROLE ...; set_config('request.jwt.claims', $1, true)).
// Step 3 adds auth (`PUBLIC_URL` = JWT issuer base, `AUTH_INTERNAL_URL`, provider flags,
// Turnstile) and SMTP (`SMTP_*`, `MAIL_FROM`) settings (docs/plans/step-3.md 2.6, 2.8).
// Step 7 (docs/plans/step-7.md 2.9) adds the search and chat settings (`searchEnvSchema`,
// `chatEnvSchema`). Provider, models and keys (`VISION_PROVIDER`, `OPENAI_API_KEY`, `CHAT_MODEL`,
// `EMBED_MODEL`, …) are NOT part of this config: `plugins/ai.ts` hands the env to
// `@tinyglow/ai`'s factories (one schema rules), so the key never sits in `app.config`. The
// one AI setting checked here is `EMBED_DIMS`, which must equal the `photo_search.embedding`
// column width (1024): anything else fails boot.
// Step 8 (docs/plans/step-8.md 2.9) adds `SHARE_MEDIA_URL_TTL_SEC` (viewer media URL lifetime,
// 30..900 s, default 300); the worker reads `SHARE_RECONCILE_CRON` from the same shared schema.
// Step 9 (docs/plans/step-9.md 2.3, 2.8, 2.14) adds the native CORS allow-list
// (`NATIVE_APP_ORIGINS`, `nativeCorsEnvSchema`) and the `push.notify` debounce the API applies
// when it enqueues (`PUSH_SHARE_DEBOUNCE_SEC`; `PUSH_PHOTOS_DEBOUNCE_SEC` is read too, with the
// shared default, so `enqueuePush` can send either kind). `PUSH_PROVIDER` and the APNs/FCM
// secrets are worker-only and never read here.
// Step 9 (docs/plans/step-9.md 2.5, D4) adds the store-review sign-in (`reviewAccountEnvSchema`):
// off unless BOTH `REVIEW_ACCOUNT_EMAIL` and `REVIEW_ACCOUNT_CODE_HASH` are set (empty counts as
// unset); one without the other, a malformed email or a hash that is not `scrypt$1$…` fails boot
// naming the field only. `auth/review.ts` (`loadReviewAccount`) reads the parsed values from here.
// Review fixes (docs/plans/review-fixes.md 2.6, D8) add error telemetry (`sentryEnvSchema`):
// `SENTRY_DSN` unset/empty ⇒ off (dev); a value that is not a Sentry DSN fails boot naming the
// field only; `SENTRY_ENVIRONMENT` defaults to `NODE_ENV`. `plugins/telemetry.ts` reads them.
// Step 10 (docs/plans/step-10.md 2.3, 2.6, D7) adds photo import (`googleImportEnvSchema`):
// `GOOGLE_IMPORT_PROVIDER` none (default) | fake (refused in production) | live (needs
// `GOOGLE_IMPORT_CLIENT_ID` + `GOOGLE_IMPORT_CLIENT_SECRET`), the fake's internal and public base
// URLs. Read through `googleImportSettings`; the client secret is never logged or serialized.
// Step 11 (docs/plans/step-11.md 2.3, 2.5, D-H, D-J) adds the family-start safeguards
// (`abuseEnvSchema`): `FAMILIES_PER_IP_PER_DAY` (default 5; dev Compose 1000),
// `BLOCK_DISPOSABLE_EMAIL` (default true), `EMAIL_DOMAIN_DENYLIST` / `EMAIL_DOMAIN_ALLOWLIST`
// (comma lists of domains). They apply when an account starts its family (first album), never at
// sign-in. Every one has a default, so the api boots with none set. Read through `abuseSettings`.
// Step 13 (docs/plans/step-13.md 2.3, 2.4, 2.7) adds `AUTH_PASSKEYS_ENABLED` (`passkeyEnvSchema`,
// default false; must equal GoTrue's `GOTRUE_PASSKEY_ENABLED`, both fed by one `.env` flag). Read
// through `passkeysEnabled`: off ⇒ every passkey route answers 404 `passkey_disabled`.
// Step 14 (docs/plans/step-14.md 2.3, 2.6, D7) adds live updates (`appUpdateEnvSchema`):
// `APP_UPDATE_ENABLED` (default true), `APP_UPDATE_SIGNING_KEY_BASE64` (unset ⇒ feature off; a
// bad or untrusted key also turns it off with one log line in `app-update/`, never a boot
// failure), `APP_UPDATE_SOURCE_URL`, `APP_UPDATE_FILES_BASE_URL` (default `PUBLIC_URL`). Read
// through `appUpdateSettings`; the key is never logged or serialized.

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

/** Step 8: the API reads only the viewer media URL lifetime from `shareEnvSchema`. */
const shareApiEnvSchema = shareEnvSchema.pick({ SHARE_MEDIA_URL_TTL_SEC: true });
export type ShareApiEnv = Pick<ShareEnv, "SHARE_MEDIA_URL_TTL_SEC">;

/**
 * Step 9: the two debounce fields of the worker's `pushEnvSchema` (same validation and defaults).
 * Built from its `shape` because `pick` is not available on a refined object.
 */
const pushApiEnvSchema = z.object({
  PUSH_PHOTOS_DEBOUNCE_SEC: pushEnvSchema.shape.PUSH_PHOTOS_DEBOUNCE_SEC,
  PUSH_SHARE_DEBOUNCE_SEC: pushEnvSchema.shape.PUSH_SHARE_DEBOUNCE_SEC,
});
export type PushApiEnv = z.output<typeof pushApiEnvSchema>;

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
  Partial<ChatEnv> &
  // Optional in the type (always set by `loadConfig`); read through `shareSettings`.
  Partial<ShareApiEnv> &
  // Optional in the type (always set by `loadConfig`); read through `nativeSettings`.
  Partial<NativeCorsEnv> &
  Partial<PushApiEnv> &
  // Both optional: absent ⇒ the review sign-in is off (`reviewAccountEnabled`).
  ReviewAccountEnv &
  // Optional in the type: `SENTRY_DSN` absent ⇒ telemetry off; `SENTRY_ENVIRONMENT` is always
  // set by `loadConfig` (default `NODE_ENV`).
  Partial<SentryEnv> &
  // Optional in the type (always set by `loadConfig`); read through `googleImportSettings`.
  Partial<Omit<GoogleImportEnv, "NODE_ENV">> &
  // Optional in the type (always set by `loadConfig`); read through `abuseSettings`.
  Partial<AbuseEnv> &
  // Optional in the type (always set by `loadConfig`); read through `passkeysEnabled`.
  Partial<PasskeyEnv> &
  // Optional in the type (the key is absent unless configured); read through `appUpdateSettings`.
  Partial<AppUpdateEnv>;

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
    shareApiEnvSchema,
    nativeCorsEnvSchema,
    pushApiEnvSchema,
    reviewAccountEnvSchema,
    sentryEnvSchema,
    googleImportEnvSchema,
    abuseEnvSchema,
    passkeyEnvSchema,
    appUpdateEnvSchema,
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

/** Share settings with the shared defaults filled in (`shareEnvSchema`, step-8 plan 2.9). */
export function shareSettings(config: Partial<ShareApiEnv>): ShareApiEnv {
  return {
    SHARE_MEDIA_URL_TTL_SEC:
      config.SHARE_MEDIA_URL_TTL_SEC ?? SHARE_DEFAULTS.SHARE_MEDIA_URL_TTL_SEC,
  };
}

/** Step 9 settings with the shared defaults filled in (docs/plans/step-9.md 2.3, 2.8). */
export function nativeSettings(config: Partial<NativeCorsEnv> & Partial<PushApiEnv>): {
  NATIVE_APP_ORIGINS: string[];
  PUSH_PHOTOS_DEBOUNCE_SEC: number;
  PUSH_SHARE_DEBOUNCE_SEC: number;
} {
  return {
    NATIVE_APP_ORIGINS: config.NATIVE_APP_ORIGINS ?? [...NATIVE_ORIGINS_DEFAULT],
    PUSH_PHOTOS_DEBOUNCE_SEC: config.PUSH_PHOTOS_DEBOUNCE_SEC ?? PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
    PUSH_SHARE_DEBOUNCE_SEC: config.PUSH_SHARE_DEBOUNCE_SEC ?? PUSH_SHARE_DEBOUNCE_SEC_DEFAULT,
  };
}

/** Photo import settings the API reads, with the shared defaults filled in (step-10 plan 2.3). */
export type GoogleImportSettings = Pick<
  GoogleImportEnv,
  | "GOOGLE_IMPORT_PROVIDER"
  | "GOOGLE_IMPORT_CLIENT_ID"
  | "GOOGLE_IMPORT_CLIENT_SECRET"
  | "GOOGLE_IMPORT_FAKE_URL"
  | "GOOGLE_IMPORT_FAKE_PUBLIC_URL"
>;

export function googleImportSettings(
  config: Partial<Omit<GoogleImportEnv, "NODE_ENV">>,
): GoogleImportSettings {
  return {
    GOOGLE_IMPORT_PROVIDER:
      config.GOOGLE_IMPORT_PROVIDER ?? GOOGLE_IMPORT_DEFAULTS.GOOGLE_IMPORT_PROVIDER,
    GOOGLE_IMPORT_CLIENT_ID: config.GOOGLE_IMPORT_CLIENT_ID,
    GOOGLE_IMPORT_CLIENT_SECRET: config.GOOGLE_IMPORT_CLIENT_SECRET,
    GOOGLE_IMPORT_FAKE_URL:
      config.GOOGLE_IMPORT_FAKE_URL ?? GOOGLE_IMPORT_DEFAULTS.GOOGLE_IMPORT_FAKE_URL,
    GOOGLE_IMPORT_FAKE_PUBLIC_URL:
      config.GOOGLE_IMPORT_FAKE_PUBLIC_URL ?? GOOGLE_IMPORT_DEFAULTS.GOOGLE_IMPORT_FAKE_PUBLIC_URL,
  };
}

/**
 * Family-start safeguard settings with the shared defaults filled in (`abuseEnvSchema`, step-11
 * plan 2.3, 2.5). The domain lists are already normalised by the schema (lowercase, no trailing
 * dots, de-duplicated; `NEVER_BLOCKED_EMAIL_DOMAINS` dropped from the deny list).
 */
export function abuseSettings(config: Partial<AbuseEnv>): AbuseEnv {
  return {
    FAMILIES_PER_IP_PER_DAY: config.FAMILIES_PER_IP_PER_DAY ?? FAMILIES_PER_IP_PER_DAY_DEFAULT,
    BLOCK_DISPOSABLE_EMAIL: config.BLOCK_DISPOSABLE_EMAIL ?? true,
    EMAIL_DOMAIN_DENYLIST: config.EMAIL_DOMAIN_DENYLIST ?? [],
    EMAIL_DOMAIN_ALLOWLIST: config.EMAIL_DOMAIN_ALLOWLIST ?? [],
  };
}

/**
 * Passkeys on or off (step 13, `passkeyEnvSchema`): `AUTH_PASSKEYS_ENABLED`, default false. A
 * config built by hand without the field (tests) means off, the safe direction.
 */
export function passkeysEnabled(config: Partial<PasskeyEnv>): boolean {
  return config.AUTH_PASSKEYS_ENABLED ?? false;
}

/** Live-update settings the api reads (step 14, `appUpdateEnvSchema`), defaults filled in. */
export interface AppUpdateSettings {
  /** `APP_UPDATE_ENABLED` (default true; a config built by hand without it means on). */
  enabled: boolean;
  /** base64 PKCS#8 DER of the P-256 signing key; undefined ⇒ the feature is off. Secret. */
  signingKeyBase64: string | undefined;
  /** Where the web image's manifest is fetched (Compose network). */
  sourceUrl: string;
  /**
   * The signed `baseUrl`: `APP_UPDATE_FILES_BASE_URL`, else `PUBLIC_URL`. `null` when the
   * fallback `PUBLIC_URL` does not satisfy `isAppUpdateBaseUrl` (e.g. plain http on a LAN
   * address): the feature is then off with one log line, the api still boots.
   */
  filesBaseUrl: string | null;
  /** `NODE_ENV === "production"`: only the `prod` public key is trusted. */
  production: boolean;
}

export function appUpdateSettings(
  config: Partial<AppUpdateEnv> & Partial<Pick<ApiConfig, "PUBLIC_URL" | "NODE_ENV">>,
): AppUpdateSettings {
  const fallback = config.PUBLIC_URL?.replace(/\/+$/, "");
  const filesBaseUrl =
    config.APP_UPDATE_FILES_BASE_URL ??
    (fallback !== undefined && isAppUpdateBaseUrl(fallback) ? fallback : null);
  return {
    enabled: config.APP_UPDATE_ENABLED ?? true,
    signingKeyBase64: config.APP_UPDATE_SIGNING_KEY_BASE64,
    sourceUrl: config.APP_UPDATE_SOURCE_URL ?? APP_UPDATE_SOURCE_URL_DEFAULT,
    filesBaseUrl,
    production: config.NODE_ENV === "production",
  };
}
