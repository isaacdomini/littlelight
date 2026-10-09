/**
 * Model defaults for the AI pipeline. The values live in `@littlelight/shared`
 * (`src/constants.ts`, plan section 2.10) so there is one source of truth; this module adds the
 * provider/effort enums and pins each default to them at compile time.
 */

import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_VISION_MODEL,
  EMBED_DIMS,
  DEFAULT_CHAT_REASONING_EFFORT as SHARED_CHAT_REASONING_EFFORT,
  DEFAULT_VISION_PROVIDER as SHARED_VISION_PROVIDER,
  DEFAULT_VISION_REASONING_EFFORT as SHARED_VISION_REASONING_EFFORT,
} from "@littlelight/shared";

/**
 * `fake` is the deterministic in-process provider (no key, no network) used by CI, the dev stack
 * gate and tests (docs/plans/step-6.md D1). It refuses to start when `NODE_ENV=production`
 * unless `AI_ALLOW_FAKE_IN_PRODUCTION=true`.
 */
export const VISION_PROVIDERS = ["openai", "anthropic", "fake"] as const;
export type VisionProvider = (typeof VISION_PROVIDERS)[number];

export const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Vision: GPT-6 Luna on the Batch API, no reasoning (CLAUDE.md spec clarifications). */
export const DEFAULT_VISION_PROVIDER: VisionProvider = SHARED_VISION_PROVIDER;
export const DEFAULT_VISION_REASONING_EFFORT: ReasoningEffort = SHARED_VISION_REASONING_EFFORT;

/** Chat: GPT-6 Luna, low reasoning, real-time. */
export const DEFAULT_CHAT_REASONING_EFFORT: ReasoningEffort = SHARED_CHAT_REASONING_EFFORT;

/** Embeddings are always OpenAI; `photo_search.embedding` is `vector(EMBED_DIMS)`. */
export { DEFAULT_CHAT_MODEL, DEFAULT_EMBED_MODEL, DEFAULT_VISION_MODEL, EMBED_DIMS };

/**
 * Fallback vision/chat model (Claude Haiku 5.5) when `VISION_PROVIDER=anthropic`. Model id
 * verified 2026-10-08 (docs/plans/step-6.md 2.2).
 */
export const FALLBACK_ANTHROPIC_MODEL = "claude-haiku-5-5";

/** PRD FR-5.1 / "Image compression for the model": the only image a model ever sees. */
export const ANALYSIS_LONG_EDGE_PX = 768;

/** Plan 2.5: a q75 768 px JPEG is 60-120 KB; this bound catches a display copy sent by mistake. */
export const ANALYSIS_MAX_BYTES = 400_000;

/** Real provider endpoints (overridable with `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` for mocks). */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Anthropic API version header (Message Batches, structured outputs; no beta header). */
export const ANTHROPIC_VERSION = "2023-06-01";
