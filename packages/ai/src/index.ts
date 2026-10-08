/**
 * `@littlelight/ai`: the only place in the codebase that talks to model providers
 * (PRD "Build handoff for Claude Code" -> "Conventions"). Call sites use the factories below
 * and the interfaces in `./types`; the provider is selected by env, never by code.
 *
 * Step 1: interfaces, env parsing and stub factories only. No SDKs, no network.
 */

import { type AiEnvInput, getAiStatus, parseAiEnv } from "./env";
import { AiNotConfiguredError, AiNotImplementedError } from "./errors";
import type { ChatModel, Embedder, VisionDescriber } from "./types";

export * from "./defaults";
export * from "./env";
export * from "./errors";
export type * from "./types";

/**
 * Validates config, then throws: in step 1 there is no adapter yet. Missing key ->
 * `AiNotConfiguredError`; valid config -> `AiNotImplementedError` (a subclass, so callers can
 * catch `AiNotConfiguredError` for both).
 */
function notYet(env: AiEnvInput, what: string, step: number): never {
  const parsed = parseAiEnv(env);
  const status = getAiStatus(env);
  if (!status.configured) {
    throw new AiNotConfiguredError(`AI disabled: ${status.reason}`);
  }
  // Embeddings are OpenAI-only (Anthropic has no embeddings API), whatever VISION_PROVIDER is.
  if (what === "Embedder" && !parsed.OPENAI_API_KEY) {
    throw new AiNotConfiguredError("AI disabled: OPENAI_API_KEY not set (required for embeddings)");
  }
  throw new AiNotImplementedError(`${what} is not implemented yet (step ${step})`);
}

/** Vision describer for the configured `VISION_PROVIDER` (OpenAI primary, Anthropic fallback). */
export function createVisionDescriber(env: AiEnvInput): VisionDescriber {
  return notYet(env, "VisionDescriber", 6);
}

/** Real-time chat model for the agentic RAG endpoint. */
export function createChatModel(env: AiEnvInput): ChatModel {
  return notYet(env, "ChatModel", 7);
}

/** Embedder (`EMBED_MODEL`, `EMBED_DIMS`). */
export function createEmbedder(env: AiEnvInput): Embedder {
  return notYet(env, "Embedder", 6);
}
