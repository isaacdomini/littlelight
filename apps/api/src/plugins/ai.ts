import {
  AiConfigError,
  type AiEnvInput,
  AiNotConfiguredError,
  type AiStatus,
  aiEnvSchema,
  type ChatModel,
  createChatModel,
  createEmbedder,
  DEFAULT_CHAT_REASONING_EFFORT,
  type Embedder,
  embedModelTag,
  getAiStatus,
  type ReasoningEffort,
} from "@littlelight/ai";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { errorCategory } from "../routes/healthz";

// Chat model and embedder, created once per process (docs/plans/step-7.md 2.9). The API reads
// `OPENAI_API_KEY` (and every other provider setting) only through `@littlelight/ai`'s factories:
// the env goes in, a `ChatModel` / `Embedder` comes out, and nothing here stores or logs a key.
// `VISION_PROVIDER=fake` selects the deterministic fake chat model and bag-of-words embedder
// (plan D1/D12), refused in production unless `AI_ALLOW_FAKE_IN_PRODUCTION=true`.
//
// A missing key or an invalid AI config never fails API boot:
// - no chat model ⇒ `POST /babies/:id/chat/messages` answers 409 `conflict` "Chat is not
//   configured on this server" after the access gate (chat/routes.ts) — a deployment fault,
//   never a user fault;
// - no embedder ⇒ search runs on filters + full text only and reports `degraded: "no_embeddings"`
//   (plan D15).
// Per-baby entitlement is NOT decided here: the routes' gate (`requireChatAccess`, admin +
// `baby_ai_enabled`) runs before any model or embedding call, and RLS is the backstop.

export interface AiServices {
  /** Null when chat is unavailable (no key, Anthropic-only, fake refused, invalid config). */
  chat: ChatModel | null;
  /** Null when query embeddings are unavailable (no `OPENAI_API_KEY` and not the fake provider). */
  embedder: Embedder | null;
  /** Loggable status (`provider`, model names, or a reason naming env vars only). */
  status: AiStatus;
  /** `CHAT_REASONING_EFFORT` (default `low`), for `ChatOptions.reasoningEffort`. */
  chatReasoningEffort: ReasoningEffort;
  /** Set when `chat` is null: env var / field names only. */
  chatDisabledReason?: string;
  /** Set when `embedder` is null: env var / field names only. */
  embedDisabledReason?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Chat model + embedder (null when unavailable). Tests inject fakes via `buildApp({ ai })`. */
    ai: AiServices;
  }
}

type AiLog = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
type Built<T> = { value: T; reason?: undefined } | { value: null; reason: string };

function build<T>(factory: () => T, what: "chat" | "embeddings", log: AiLog): Built<T> {
  try {
    return { value: factory() };
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      // Built from env var names only ("AI disabled: …", or the not-implemented sentence).
      return { value: null, reason: err.message.replace(/^AI disabled: /, "") };
    }
    if (err instanceof AiConfigError) {
      log.error({ fields: err.fields }, `AI ${what} disabled: invalid AI configuration`);
      return { value: null, reason: `invalid ${err.fields.join(", ")}` };
    }
    log.error({ err: errorCategory(err) }, `AI ${what} disabled: could not create the client`);
    return { value: null, reason: `${what} client could not be created` };
  }
}

/**
 * Build the chat model and the embedder from `env` (normally `process.env`) and log one boot line:
 * `AI enabled: provider=… chat=… embed=…` (`off` for a missing half, with a second line naming the
 * reason), or `AI disabled: <reason>; chat unavailable, search runs in keyword mode`. Never throws.
 */
export function createAiServices(env: AiEnvInput, log: AiLog): AiServices {
  const status = getAiStatus(env);
  const parsed = aiEnvSchema.safeParse(env);
  const chatReasoningEffort = parsed.success
    ? parsed.data.CHAT_REASONING_EFFORT
    : DEFAULT_CHAT_REASONING_EFFORT;
  if (!status.configured) {
    log.info({}, `AI disabled: ${status.reason}; chat unavailable, search runs in keyword mode`);
    return {
      chat: null,
      embedder: null,
      status,
      chatReasoningEffort,
      chatDisabledReason: status.reason,
      embedDisabledReason: status.reason,
    };
  }
  const deps = { log };
  const chat = build(() => createChatModel(env, deps), "chat", log);
  const embed = build(() => createEmbedder(env, deps), "embeddings", log);
  const chatLabel = chat.value ? chat.value.model : "off";
  const embedLabel = embed.value ? embedModelTag(embed.value) : "off";
  log.info({}, `AI enabled: provider=${status.provider} chat=${chatLabel} embed=${embedLabel}`);
  if (status.warning) log.warn({ provider: status.provider }, status.warning);
  if (!chat.value) log.info({}, `AI chat disabled: ${chat.reason}; chat routes answer 409`);
  if (!embed.value) {
    log.info({}, `AI embeddings disabled: ${embed.reason}; search runs in keyword mode`);
  }
  return {
    chat: chat.value,
    embedder: embed.value,
    status,
    chatReasoningEffort,
    ...(chat.value ? {} : { chatDisabledReason: chat.reason }),
    ...(embed.value ? {} : { embedDisabledReason: embed.reason }),
  };
}

/** Decorate the root instance with `app.ai`. */
export function registerAi(app: FastifyInstance, services: AiServices): void {
  app.decorate("ai", services);
}
