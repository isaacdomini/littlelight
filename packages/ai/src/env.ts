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
});

export type AiEnv = z.output<typeof aiEnvSchema>;

/** Raw env as read from `process.env` (or a plain object in tests). */
export type AiEnvInput = Readonly<Record<string, unknown>>;

/** Env var holding the API key for each provider. */
export const PROVIDER_KEY_VAR = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const satisfies Record<VisionProvider, keyof AiEnv>;

/**
 * Parse and default the AI env. Throws `AiConfigError` naming the invalid fields only;
 * values (including keys) are never included in the error.
 */
export function parseAiEnv(env: AiEnvInput): AiEnv {
  const result = aiEnvSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new AiConfigError(fields);
  }
  return result.data;
}

export type AiStatus =
  | {
      configured: true;
      provider: VisionProvider;
      visionModel: string;
      chatModel: string;
      embedModel: string;
    }
  | {
      configured: false;
      /** Safe to log: names env vars only, never values. */
      reason: string;
    };

/**
 * Loggable AI status for boot logs, e.g. `AI disabled: OPENAI_API_KEY not set` or
 * `AI enabled: provider=openai model=gpt-6-luna`. Never throws.
 */
export function getAiStatus(env: AiEnvInput): AiStatus {
  const result = aiEnvSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    return { configured: false, reason: `invalid ${fields.join(", ")}` };
  }
  const parsed = result.data;
  const keyVar = PROVIDER_KEY_VAR[parsed.VISION_PROVIDER];
  if (!parsed[keyVar]) {
    return { configured: false, reason: `${keyVar} not set` };
  }
  return {
    configured: true,
    provider: parsed.VISION_PROVIDER,
    visionModel: parsed.VISION_MODEL,
    chatModel: parsed.CHAT_MODEL,
    embedModel: parsed.EMBED_MODEL,
  };
}

/**
 * True iff the API key for the selected `VISION_PROVIDER` is set (and the AI env is valid).
 * `isAiConfigured({})` is false; `isAiConfigured({ OPENAI_API_KEY: "x" })` is true.
 *
 * Note: this is a deployment-level switch only. Per-baby entitlement (free tier never sent to a
 * model) is enforced separately, server-side from `babies.plan`, at job-enqueue time.
 */
export function isAiConfigured(env: AiEnvInput): boolean {
  return getAiStatus(env).configured;
}
