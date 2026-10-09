/**
 * `@littlelight/ai`: the only place in the codebase that talks to model providers
 * (PRD "Build handoff for Claude Code" -> "Conventions"). Call sites use the factories below
 * and the interfaces in `./types`; the provider is selected by env, never by code.
 *
 * Step 6: real vision adapters (OpenAI Batch primary, Anthropic Message Batches fallback, a
 * deterministic `fake`), the embedder (no caller until step 7), pricing, the v1 prompt and
 * output validation. Chat lands in step 7. No SDKs: plain `fetch` (docs/plans/step-6.md D2).
 *
 * The in-process mock servers (`src/testing/*`) and the bake-off (`src/bakeoff/*`) are NOT
 * exported here (they import `node:http` / the filesystem); tests import them by path.
 */

import { aiPipelineEnvSchema } from "@littlelight/shared";
import { createAnthropicVisionDescriber } from "./anthropic/vision";
import {
  type AiEnv,
  type AiEnvInput,
  fakeRefusedInProduction,
  getAiStatus,
  parseAiEnv,
} from "./env";
import { AiConfigError, AiNotConfiguredError, AiNotImplementedError } from "./errors";
import { createFakeEmbedder } from "./fake/embed";
import { createFakeVisionDescriber } from "./fake/vision";
import { createOpenAiEmbedder } from "./openai/embed";
import { createOpenAiVisionDescriber } from "./openai/vision";
import type { AiLogger, ChatModel, Embedder, VisionDescriber } from "./types";

export type { VisionAdapterOptions } from "./adapter-options";
export { createAnthropicVisionDescriber } from "./anthropic/vision";
export * from "./batch-state";
export * from "./defaults";
export * from "./env";
export * from "./errors";
export { fakeDescription } from "./fake/describe";
export { createFakeEmbedder, fakeEmbedding } from "./fake/embed";
export {
  createFakeVisionDescriber,
  FAKE_USAGE,
  type FakeOutcome,
  type FakeRecordedRequest,
  type FakeVisionDescriber,
  type FakeVisionOptions,
} from "./fake/vision";
export { assertAnalysisImage, readImageInfo } from "./image";
export { createOpenAiEmbedder, type OpenAiEmbedderOptions } from "./openai/embed";
export { createOpenAiVisionDescriber } from "./openai/vision";
export * from "./pricing";
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

/** Real-time chat model for the agentic RAG endpoint (step 7). */
export function createChatModel(env: AiEnvInput): ChatModel {
  requireConfigured(env);
  throw new AiNotImplementedError("ChatModel is not implemented yet (step 7)");
}

/**
 * Embedder (`EMBED_MODEL`, `EMBED_DIMS`). Always OpenAI (Anthropic has no embeddings API), so
 * it needs `OPENAI_API_KEY` whatever `VISION_PROVIDER` is; `VISION_PROVIDER=fake` gives the
 * deterministic fake embedder. No caller until step 7 (plan D11).
 */
export function createEmbedder(env: AiEnvInput, deps: AiFactoryDeps = {}): Embedder {
  const parsed = requireConfigured(env);
  if (parsed.VISION_PROVIDER === "fake") {
    return createFakeEmbedder({ model: parsed.EMBED_MODEL, dims: parsed.EMBED_DIMS });
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
