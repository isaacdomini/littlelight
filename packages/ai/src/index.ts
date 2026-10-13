/**
 * `@tinyglow/ai`: the only place in the codebase that talks to model providers
 * (PRD "Build handoff for Claude Code" -> "Conventions"). Call sites use the factories below
 * and the interfaces in `./types`; the provider is selected by env, never by code.
 *
 * Step 6: real vision adapters (OpenAI Batch primary, Anthropic Message Batches fallback, a
 * deterministic `fake`), the embedder, pricing, the v1 prompt and output validation. Step 7: the
 * OpenAI chat adapter (Responses API, streamed function calling), the deterministic fake chat
 * model, the bag-of-words fake embedder and chat prompt v1. No SDKs: plain `fetch`
 * (docs/plans/step-6.md D2).
 *
 * The in-process mock servers (`src/testing/*`) and the bake-off (`src/bakeoff/*`) are NOT
 * exported here (they import `node:http` / the filesystem); tests import them by path.
 */

import { aiPipelineEnvSchema, chatEnvSchema } from "@tinyglow/shared";
import { createAnthropicVisionDescriber } from "./anthropic/vision";
import {
  type AiEnv,
  type AiEnvInput,
  fakeRefusedInProduction,
  getAiStatus,
  parseAiEnv,
} from "./env";
import { AiConfigError, AiNotConfiguredError, AiNotImplementedError } from "./errors";
import { createFakeChatModel } from "./fake/chat";
import { createFakeEmbedder } from "./fake/embed";
import { createFakeVisionDescriber } from "./fake/vision";
import { createOpenAiChatModel } from "./openai/chat";
import { createOpenAiEmbedder } from "./openai/embed";
import { createOpenAiVisionDescriber } from "./openai/vision";
import { assertPriced } from "./pricing";
import type { AiLogger, ChatModel, Embedder, VisionDescriber } from "./types";

export type { VisionAdapterOptions } from "./adapter-options";
export { createAnthropicVisionDescriber } from "./anthropic/vision";
export * from "./batch-state";
export * from "./defaults";
export * from "./env";
export * from "./errors";
export {
  composeFakeAnswer,
  createFakeChatModel,
  FAKE_CHAT_USAGE,
  type FakeChatOptions,
  type FakeChatScript,
  type FakePlannedCall,
  planFakeToolCalls,
} from "./fake/chat";
export { fakeDescription } from "./fake/describe";
export {
  cosineSimilarity,
  createFakeEmbedder,
  FAKE_EMBED_STOP_WORDS,
  type FakeEmbedderOptions,
  fakeEmbedding,
  fakeEmbeddingOpaque,
  fakeStem,
  fakeTokenCount,
  fakeTokens,
} from "./fake/embed";
export {
  ageRangeToDates,
  resolveTemporal,
  type TemporalContext,
  type TemporalRange,
  type TemporalResult,
} from "./fake/temporal";
export {
  createFakeVisionDescriber,
  FAKE_TOKENS_PER_EXTRA_IMAGE,
  FAKE_USAGE,
  type FakeOutcome,
  type FakeRecordedRequest,
  type FakeVisionDescriber,
  type FakeVisionOptions,
} from "./fake/vision";
export { assertAnalysisImage, readImageInfo } from "./image";
export {
  CHAT_PROMPT_CACHE_KEY,
  createOpenAiChatModel,
  drainChatStream,
  type OpenAiChatModelOptions,
  openAiChatBody,
  openAiChatInput,
} from "./openai/chat";
export { createOpenAiEmbedder, type OpenAiEmbedderOptions } from "./openai/embed";
export { ResponsesStreamParser, type SseFrame, sseFrames } from "./openai/sse";
export { createOpenAiVisionDescriber } from "./openai/vision";
export * from "./pricing";
export * from "./prompts/chat-v1";
export * from "./prompts/describe-v1";
export * from "./request";
export type * from "./types";
export * from "./validate";

/** Optional runtime dependencies of the factories (logger; `fetch` for tests). */
export interface AiFactoryDeps {
  log?: AiLogger;
  fetch?: typeof fetch;
}

function requireConfigured(env: AiEnvInput): AiEnv {
  const parsed = parseAiEnv(env);
  const status = getAiStatus(env);
  if (!status.configured) throw new AiNotConfiguredError(`AI disabled: ${status.reason}`);
  return parsed;
}

/** `AI_MAX_OUTPUT_TOKENS`, `AI_IMAGE_DETAIL`, `AI_BATCH_MAX_BYTES` from the shared pipeline schema. */
function pipelineSettings(env: AiEnvInput) {
  const res = aiPipelineEnvSchema
    .pick({ AI_MAX_OUTPUT_TOKENS: true, AI_IMAGE_DETAIL: true, AI_BATCH_MAX_BYTES: true })
    .safeParse(env);
  if (!res.success) {
    throw new AiConfigError([...new Set(res.error.issues.map((i) => i.path.join(".")))]);
  }
  return res.data;
}

/**
 * Vision describer for the configured `VISION_PROVIDER`: `openai` (needs `OPENAI_API_KEY`),
 * `anthropic` (needs `ANTHROPIC_API_KEY`), `fake` (no key; refused in production unless
 * `AI_ALLOW_FAKE_IN_PRODUCTION=true`). Throws `AiNotConfiguredError` when AI is unavailable,
 * `AiConfigError` (field names only) when the config is invalid or `VISION_MODEL` is not in the
 * price table.
 */
export function createVisionDescriber(env: AiEnvInput, deps: AiFactoryDeps = {}): VisionDescriber {
  const parsed = requireConfigured(env);
  const settings = pipelineSettings(env);
  const common = {
    model: parsed.VISION_MODEL,
    reasoningEffort: parsed.VISION_REASONING_EFFORT,
    maxOutputTokens: settings.AI_MAX_OUTPUT_TOKENS,
    imageDetail: settings.AI_IMAGE_DETAIL,
    maxBatchBytes: settings.AI_BATCH_MAX_BYTES,
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  switch (parsed.VISION_PROVIDER) {
    case "openai":
      return createOpenAiVisionDescriber({
        ...common,
        apiKey: parsed.OPENAI_API_KEY as string,
        ...(parsed.OPENAI_BASE_URL ? { baseUrl: parsed.OPENAI_BASE_URL } : {}),
      });
    case "anthropic":
      return createAnthropicVisionDescriber({
        ...common,
        apiKey: parsed.ANTHROPIC_API_KEY as string,
        ...(parsed.ANTHROPIC_BASE_URL ? { baseUrl: parsed.ANTHROPIC_BASE_URL } : {}),
      });
    case "fake": {
      if (fakeRefusedInProduction(parsed)) {
        throw new AiNotConfiguredError(
          "AI disabled: VISION_PROVIDER=fake is refused in production",
        );
      }
      if (parsed.NODE_ENV === "production") {
        deps.log?.warn({ provider: "fake" }, "VISION_PROVIDER=fake in production");
      }
      return createFakeVisionDescriber({
        model: parsed.VISION_MODEL,
        pollsUntilComplete: parsed.FAKE_VISION_POLLS,
        ...(parsed.FAKE_VISION_DIR ? { dir: parsed.FAKE_VISION_DIR } : {}),
        ...(deps.log ? { log: deps.log } : {}),
        env: {
          NODE_ENV: parsed.NODE_ENV,
          AI_ALLOW_FAKE_IN_PRODUCTION: parsed.AI_ALLOW_FAKE_IN_PRODUCTION ? "true" : "false",
        },
      });
    }
  }
}

/** `CHAT_MAX_OUTPUT_TOKENS`, `CHAT_MODEL_TIMEOUT_MS` from the shared chat schema. */
function chatSettings(env: AiEnvInput) {
  const res = chatEnvSchema
    .pick({ CHAT_MAX_OUTPUT_TOKENS: true, CHAT_MODEL_TIMEOUT_MS: true })
    .safeParse(env);
  if (!res.success) {
    throw new AiConfigError([...new Set(res.error.issues.map((i) => i.path.join(".")))]);
  }
  return res.data;
}

/**
 * Real-time chat model for the agentic RAG endpoint (docs/plans/step-7.md 2.5, D12: the same
 * `VISION_PROVIDER` switch): `openai` ⇒ GPT-6 Luna on the Responses API (needs
 * `OPENAI_API_KEY`; `CHAT_MODEL`, `CHAT_REASONING_EFFORT`, `CHAT_MAX_OUTPUT_TOKENS`,
 * `CHAT_MODEL_TIMEOUT_MS`); `fake` ⇒ the deterministic rule-based model (refused in production
 * unless `AI_ALLOW_FAKE_IN_PRODUCTION=true`); `anthropic` ⇒ `AiNotImplementedError` (plan D10).
 * `AiConfigError` (field names only) for invalid settings or an unpriced `CHAT_MODEL`.
 */
export function createChatModel(env: AiEnvInput, deps: AiFactoryDeps = {}): ChatModel {
  const parsed = requireConfigured(env);
  const settings = chatSettings(env);
  switch (parsed.VISION_PROVIDER) {
    case "anthropic":
      throw new AiNotImplementedError(
        "Anthropic chat adapter is not implemented; set VISION_PROVIDER=openai or fake",
      );
    case "fake":
      assertPriced(parsed.CHAT_MODEL, "CHAT_MODEL");
      return createFakeChatModel({
        model: parsed.CHAT_MODEL,
        ...(deps.log ? { log: deps.log } : {}),
        env: {
          NODE_ENV: parsed.NODE_ENV,
          AI_ALLOW_FAKE_IN_PRODUCTION: parsed.AI_ALLOW_FAKE_IN_PRODUCTION ? "true" : "false",
        },
      });
    case "openai":
      return createOpenAiChatModel({
        apiKey: parsed.OPENAI_API_KEY as string,
        model: parsed.CHAT_MODEL,
        reasoningEffort: parsed.CHAT_REASONING_EFFORT,
        maxOutputTokens: settings.CHAT_MAX_OUTPUT_TOKENS,
        timeoutMs: settings.CHAT_MODEL_TIMEOUT_MS,
        ...(parsed.OPENAI_BASE_URL ? { baseUrl: parsed.OPENAI_BASE_URL } : {}),
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
  }
}

/** `photo_search.embed_model` tag of an embedder: `text-embedding-3-small/1024`, `fake/1024`. */
export function embedModelTag(embedder: Pick<Embedder, "model" | "dims">): string {
  return `${embedder.model}/${embedder.dims}`;
}

/**
 * Embedder (`EMBED_MODEL`, `EMBED_DIMS`). Always OpenAI (Anthropic has no embeddings API), so
 * it needs `OPENAI_API_KEY` whatever `VISION_PROVIDER` is; `VISION_PROVIDER=fake` gives the
 * deterministic bag-of-words fake (model `fake`, priced like `EMBED_MODEL`). `AiConfigError` for
 * an unpriced `EMBED_MODEL`. Callers check `EMBED_DIMS === 1024` (the column width).
 */
export function createEmbedder(env: AiEnvInput, deps: AiFactoryDeps = {}): Embedder {
  const parsed = requireConfigured(env);
  assertPriced(parsed.EMBED_MODEL, "EMBED_MODEL");
  if (parsed.VISION_PROVIDER === "fake") {
    return createFakeEmbedder({ dims: parsed.EMBED_DIMS, priceModel: parsed.EMBED_MODEL });
  }
  if (!parsed.OPENAI_API_KEY) {
    throw new AiNotConfiguredError("AI disabled: OPENAI_API_KEY not set (required for embeddings)");
  }
  return createOpenAiEmbedder({
    apiKey: parsed.OPENAI_API_KEY,
    model: parsed.EMBED_MODEL,
    dims: parsed.EMBED_DIMS,
    ...(parsed.OPENAI_BASE_URL ? { baseUrl: parsed.OPENAI_BASE_URL } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
