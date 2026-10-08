/**
 * Provider-neutral contracts for every model call in Littlelight (plan step 1, section 2.11).
 *
 * Call sites depend only on these interfaces; the OpenAI (primary) and Anthropic (fallback)
 * adapters implement them and are selected by env (`VISION_PROVIDER`), never by code changes.
 *
 * Privacy rules encoded here (PRD "AI pipeline", "Privacy and child safety"):
 * - Requests carry the compressed 768 px **analysis copy** only. Never the original, never a
 *   display/thumbnail derivative, never EXIF (the analysis copy is EXIF-stripped).
 * - Requests never carry GPS or coordinates. Place is a human-readable, coarse label at most.
 * - Requests are only built for paid-tier babies; the enqueue step checks `babies.plan`
 *   server-side, and `plan: "paid"` below makes a free-tier request a type error.
 * - Nothing in these types may be logged: they contain image bytes and parent notes.
 */

import type { ReasoningEffort, VisionProvider } from "./defaults";

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------

/** Token usage and cost as billed by the provider. Recorded per photo and per `ai_batches` row. */
export interface ModelUsage {
  inputTokens: number;
  /** Prompt-cache hits (system prompt + schema are marked cacheable). */
  cachedInputTokens: number;
  outputTokens: number;
  /** Billed image tokens when the provider reports them separately (bake-off metric). */
  imageTokens?: number;
  /** Computed from the provider's price table, batch discount applied where relevant. */
  costUsd: number;
}

// ---------------------------------------------------------------------------------------------
// Vision (describe stage)
// ---------------------------------------------------------------------------------------------

/**
 * The compressed analysis copy (PRD FR-5.1): long edge <= 768 px, EXIF stripped,
 * JPEG q75 or WebP q70, typically 60-120 KB. Adapters reject anything larger.
 * NEVER put an original or any other derivative in here.
 */
export interface AnalysisImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

/**
 * Per-photo prompt context (PRD FR-5.4). Parent-supplied details and EXIF facts are given so
 * the model does not contradict them. No GPS, no coordinates, no account identifiers.
 */
export interface VisionContext {
  /** Baby's age in days when the photo was taken, if known. */
  babyAgeDays: number | null;
  /** Capture date (ISO 8601 date or date-time), if known. */
  takenAt: string | null;
  /** Coarse, human-readable place label (for example "Lisbon, Portugal"). Never coordinates. */
  placeLabel: string | null;
  /** Parent-supplied names of people in the photo; the only source of identities. */
  people: string[];
  /** Parent-tagged milestone name, if any. */
  milestone: string | null;
  /** Free-text parent notes. Sensitive: never log. */
  parentNotes: string | null;
}

export interface VisionRequest {
  /** `photos.id`; used as the Batch API `custom_id`. */
  photoId: string;
  /**
   * Entitlement of the baby that owns the photo, as read server-side from `babies.plan` at
   * enqueue time. Typed as the literal `"paid"` so a free-tier request cannot be constructed.
   */
  plan: "paid";
  image: AnalysisImage;
  context: VisionContext;
  /** Prompt version recorded on `photo_ai` so FR-5.7 backfills can target old versions. */
  promptVersion: string;
  /** Description schema version (v1 in the PRD). */
  schemaVersion: string;
}

/** Opaque reference to a submitted provider batch; persisted on `ai_batches`. */
export interface VisionBatchHandle {
  provider: VisionProvider;
  /** Provider-side batch id. */
  batchId: string;
  model: string;
  /** ISO 8601. */
  submittedAt: string;
  requestCount: number;
}

export type VisionFailureKind =
  | "refusal"
  | "invalid_output"
  | "expired"
  | "rate_limited"
  | "provider_error";

/**
 * One photo's result. `raw` is the unvalidated model output: it MUST be validated against the
 * description schema v1 (zod, in `@littlelight/shared` from step 6) before anything is written
 * to `photo_ai`. Invalid output is retried once, then dead-lettered (PRD FR-5.3).
 */
export type VisionResult =
  | {
      photoId: string;
      ok: true;
      raw: unknown;
      usage: ModelUsage;
      /** Real-time path only; batch results have no meaningful per-request latency. */
      latencyMs?: number;
    }
  | {
      photoId: string;
      ok: false;
      failure: VisionFailureKind;
      /** Provider error code/message. Must not contain prompt text or parent notes. */
      detail: string;
      usage?: ModelUsage;
    };

export type VisionBatchState =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

export interface VisionBatchStatus {
  handle: VisionBatchHandle;
  state: VisionBatchState;
  /** Present once results are available (completed, or partial results on expired/cancelled). */
  results?: VisionResult[];
  /** Aggregate usage for the whole batch, written to `ai_batches`. */
  usage?: ModelUsage;
}

export interface VisionDescriber {
  readonly provider: VisionProvider;
  readonly model: string;
  /** Describe stage: submit one Batch API job (PRD FR-5.2). The default path. */
  describeBatch(requests: VisionRequest[]): Promise<VisionBatchHandle>;
  /** Poller (every 5 min): current batch state, plus results once finished. */
  pollBatch(handle: VisionBatchHandle): Promise<VisionBatchStatus>;
  /** Priority path only (PRD FR-5.5): real-time call for milestone/actively-waiting uploads. */
  describeOne(request: VisionRequest): Promise<VisionResult>;
}

// ---------------------------------------------------------------------------------------------
// Chat (agentic RAG, real-time)
// ---------------------------------------------------------------------------------------------

export interface ChatToolCall {
  id: string;
  name: string;
  /** Unvalidated arguments as produced by the model; validate with zod before executing. */
  arguments: unknown;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ChatToolCall[] }
  /** Tool output is data, never instructions (prompt-injection guardrail). */
  | { role: "tool"; toolCallId: string; content: string };

export interface ChatToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments (generated from the tool's zod schema). */
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  /** Defaults to `CHAT_REASONING_EFFORT`. */
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** Force or forbid tool use for this turn. Default `"auto"`. */
  toolChoice?: "auto" | "none" | "required";
  signal?: AbortSignal;
}

export type ChatFinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export interface ChatCompletion {
  model: string;
  text: string;
  toolCalls: ChatToolCall[];
  finishReason: ChatFinishReason;
  usage: ModelUsage;
  latencyMs: number;
}

export type ChatStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; toolCall: ChatToolCall }
  | { type: "done"; completion: ChatCompletion };

export interface ChatModel {
  readonly provider: VisionProvider;
  readonly model: string;
  complete(
    messages: ChatMessage[],
    tools: ChatToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatCompletion>;
  /** Streaming variant; the last event is always `done` with the full completion. */
  stream(
    messages: ChatMessage[],
    tools: ChatToolDefinition[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamEvent>;
}

// ---------------------------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------------------------

export interface Embedder {
  readonly model: string;
  /** Vector length; must equal the `photo_search.embedding` column (1024). */
  readonly dims: number;
  /** One vector per input, same order. Inputs are search documents (~250 tokens each). */
  embed(texts: string[]): Promise<number[][]>;
}
