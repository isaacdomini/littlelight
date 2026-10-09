import { z } from "zod";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHAT_REASONING_EFFORT,
  DEFAULT_EMBED_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_PROVIDER,
  DEFAULT_VISION_REASONING_EFFORT,
  EMBED_DIMS,
  REASONING_EFFORTS,
  VISION_PROVIDERS,
  type VisionProvider,
} from "./defaults";
import { AiConfigError } from "./errors";

/** Compose passes unset vars as `""` (`OPENAI_API_KEY=` in an env file); treat that as unset. */
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalSecret = z.preprocess(emptyToUndefined, z.string().optional());
const stringWithDefault = (fallback: string) =>
  z.preprocess(emptyToUndefined, z.string().default(fallback));
/** `http(s)://host[:port][/prefix]` without a trailing slash; empty = the real API. */
const optionalBaseUrl = z.preprocess(
  emptyToUndefined,
  z
    .url({ protocol: /^https?$/ })
    .transform((u) => u.replace(/\/+$/, ""))
    .optional(),
);

export const aiEnvSchema = z.object({
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  VISION_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(VISION_PROVIDERS).default(DEFAULT_VISION_PROVIDER),
  ),
  VISION_MODEL: stringWithDefault(DEFAULT_VISION_MODEL),
  VISION_REASONING_EFFORT: z.preprocess(
    emptyToUndefined,
    z.enum(REASONING_EFFORTS).default(DEFAULT_VISION_REASONING_EFFORT),
  ),
  CHAT_MODEL: stringWithDefault(DEFAULT_CHAT_MODEL),
  CHAT_REASONING_EFFORT: z.preprocess(
    emptyToUndefined,
    z.enum(REASONING_EFFORTS).default(DEFAULT_CHAT_REASONING_EFFORT),
  ),
  EMBED_MODEL: stringWithDefault(DEFAULT_EMBED_MODEL),
  /** Must match the `vector(N)` column of `photo_search.embedding` (1024). */
  EMBED_DIMS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(EMBED_DIMS),
  ),
  /**
   * Test/mock only: point the adapters at a local mock server. Empty = api.openai.com /
   * api.anthropic.com. Whatever is set here receives photos, so production leaves it empty.
   */
  OPENAI_BASE_URL: optionalBaseUrl,
  ANTHROPIC_BASE_URL: optionalBaseUrl,
  /**
   * Fake provider only: directory for `<batchId>.jsonl` (request lines minus image bytes) and
   * `<batchId>.state.json` (photo ids, poll count), so a batch survives across processes
   * (`run-job ai.flush` then `run-job ai.poll`). Unset = in-memory only.
   */
  FAKE_VISION_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Fake provider only: polls answered `in_progress` before `completed`. */
  FAKE_VISION_POLLS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(100).default(1),
  ),
  /** The fake provider refuses `NODE_ENV=production` unless this is exactly `true`. */
  AI_ALLOW_FAKE_IN_PRODUCTION: z.preprocess(
    emptyToUndefined,
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().optional()),
});

export type AiEnv = z.output<typeof aiEnvSchema>;

/** Raw env as read from `process.env` (or a plain object in tests). */
export type AiEnvInput = Readonly<Record<string, unknown>>;

/** Env var holding the API key for each provider; the fake provider needs none. */
export const PROVIDER_KEY_VAR = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  fake: null,
} as const satisfies Record<VisionProvider, keyof AiEnv | null>;

function invalidFields(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.join(".")))];
}

/**
 * Parse and default the AI env. Throws `AiConfigError` naming the invalid fields only;
 * values (including keys) are never included in the error.
 */
export function parseAiEnv(env: AiEnvInput): AiEnv {
  const result = aiEnvSchema.safeParse(env);
  if (!result.success) throw new AiConfigError(invalidFields(result.error));
  return result.data;
}

export type AiStatus =
  | {
      configured: true;
      provider: VisionProvider;
      visionModel: string;
      chatModel: string;
      embedModel: string;
      /** Safe to log at `warn` when present (e.g. the fake provider in production). */
      warning?: string;
    }
  | {
      configured: false;
      /** Safe to log: names env vars only, never values. */
      reason: string;
    };

/** True when the fake provider would run in production without the explicit opt-in. */
export function fakeRefusedInProduction(parsed: AiEnv): boolean {
  return (
    parsed.VISION_PROVIDER === "fake" &&
    parsed.NODE_ENV === "production" &&
    !parsed.AI_ALLOW_FAKE_IN_PRODUCTION
  );
}

/**
 * Loggable AI status for boot logs, e.g. `AI disabled: OPENAI_API_KEY not set` or
 * `AI enabled: provider=openai model=gpt-6-luna`. Never throws.
 */
export function getAiStatus(env: AiEnvInput): AiStatus {
  const result = aiEnvSchema.safeParse(env);
  if (!result.success) {
    return { configured: false, reason: `invalid ${invalidFields(result.error).join(", ")}` };
  }
  const parsed = result.data;
  if (fakeRefusedInProduction(parsed)) {
    return {
      configured: false,
      reason: "VISION_PROVIDER=fake is refused in production (AI_ALLOW_FAKE_IN_PRODUCTION not set)",
    };
  }
  const keyVar = PROVIDER_KEY_VAR[parsed.VISION_PROVIDER];
  if (keyVar !== null && !parsed[keyVar]) {
    return { configured: false, reason: `${keyVar} not set` };
  }
  const status: AiStatus = {
    configured: true,
    provider: parsed.VISION_PROVIDER,
    visionModel: parsed.VISION_MODEL,
    chatModel: parsed.CHAT_MODEL,
    embedModel: parsed.EMBED_MODEL,
  };
  if (parsed.VISION_PROVIDER === "fake" && parsed.NODE_ENV === "production") {
    status.warning = "VISION_PROVIDER=fake in production: photos get synthetic descriptions";
  }
  return status;
}

/**
 * True iff the selected `VISION_PROVIDER` can run: its API key is set (the fake provider needs
 * none, but is refused in production without `AI_ALLOW_FAKE_IN_PRODUCTION=true`).
 * `isAiConfigured({})` is false; `isAiConfigured({ OPENAI_API_KEY: "x" })` is true.
 *
 * Note: this is a deployment-level switch only. Per-baby entitlement (free tier never sent to a
 * model) is enforced separately, server-side from `babies.plan`, at job-enqueue time.
 */
export function isAiConfigured(env: AiEnvInput): boolean {
  return getAiStatus(env).configured;
}
