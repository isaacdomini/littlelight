/**
 * Provider-neutral contracts for every model call in Tinyglow (plan step 1, section 2.11).
 *
 * Call sites depend only on these interfaces; the OpenAI (primary) and Anthropic (fallback)
 * adapters implement them and are selected by env (`VISION_PROVIDER`), never by code changes.
 *
 * Privacy rules encoded here (PRD "AI pipeline", "Privacy and child safety"):
 * - Requests carry the compressed 768 px **analysis copy** only. Never the original, never a
 *   display/thumbnail derivative, never EXIF (the analysis copy is EXIF-stripped). A video item
 *   (step 12) carries its poster (`analysis`) plus up to three 768 px keyframes, each held to
 *   the same rule; never the original clip, never the `web` rendition.
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
  /** All prompt tokens, including cached reads and cache writes (normalised across providers). */
  inputTokens: number;
  /** Prompt-cache hits (system prompt + schema are marked cacheable). Subset of `inputTokens`. */
  cachedInputTokens: number;
  /** Prompt tokens written to the cache (billed at the cache-write rate). Subset of `inputTokens`. */
  cacheWriteTokens?: number;
  /** All billed output tokens, including reasoning/thinking tokens. */
  outputTokens: number;
  /** Reasoning tokens (subset of `outputTokens`); should be 0 with effort `none` (cost tripwire). */
  reasoningTokens?: number;
  /** Billed image tokens when the provider reports them separately (bake-off metric). */
  imageTokens?: number;
  /** Computed from the pinned price table (`pricing.ts`), batch discount applied where relevant. */
  costUsd: number;
}

/** Minimal pino-compatible logger. Adapters log ids, counts, statuses, durations and codes only. */
export interface AiLogger {
  debug?(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
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
  /**
   * Video items only (step 12; `aiVisionMediaSchema` in `@tinyglow/shared`): the per-item text
   * tells the model that the attached images are `frameCount` frames sampled from one
   * `durationSeconds`-second clip. `frameCount` must equal `1 + frames.length` of the request.
   * Absent for photos.
   */
  media?: VisionMedia;
}

/** Mirrors `aiVisionMediaSchema` (`@tinyglow/shared`). */
export interface VisionMedia {
  kind: "video";
  /** Whole seconds, ≥ 1. */
  durationSeconds: number;
  /** Images in the request (poster + keyframes), 1..`AI_VIDEO_MAX_FRAMES`. */
  frameCount: number;
}

export interface VisionRequest {
  /** `photos.id`; used as the Batch API `custom_id`. */
  photoId: string;
  /**
   * Entitlement of the baby that owns the photo, as read server-side from `babies.plan` at
   * enqueue time. Typed as the literal `"paid"` so a free-tier request cannot be constructed.
   */
  plan: "paid";
  /** The analysis copy; for a video, its poster frame (the `analysis` derivative). */
  image: AnalysisImage;
  /**
   * Video items only (step 12): the `keyframe1..3` derivatives (768 px, ≤ 400 KB each), sent
   * after `image` as further images of the same request. Every frame passes
   * `assertAnalysisImage`; at most `AI_VIDEO_MAX_FRAMES - 1` entries. Requires `context.media`.
   */
  frames?: AnalysisImage[];
  context: VisionContext;
  /** Prompt version recorded on `photo_ai` so FR-5.7 backfills can target old versions. */
  promptVersion: string;
  /** Description schema version (v1 in the PRD). */
  schemaVersion: string;
}

/**
 * Reference to a submitted provider batch; every field is persisted on `ai_batches`
 * (`provider`, `provider_batch_id`, `model`, `submitted_at`, `photo_count`,
 * `provider_input_file_id`, `prompt_version`, `schema_version`) so the poller can rebuild it.
 */
export interface VisionBatchHandle {
  provider: VisionProvider;
  /** Provider-side batch id. */
  batchId: string;
  model: string;
  /** ISO 8601. */
  submittedAt: string;
  requestCount: number;
  /** OpenAI: the uploaded JSONL input file (deleted by `deleteBatchArtifacts`). */
  inputFileId?: string;
  promptVersion: string;
  schemaVersion: string;
}

export type VisionFailureKind =
  | "refusal"
  | "invalid_output"
  | "expired"
  | "rate_limited"
  | "provider_error";

/**
 * One photo's result. `raw` is the unvalidated model output: it MUST be validated against the
 * description schema v1 (zod, in `@tinyglow/shared` from step 6) before anything is written
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
      /**
       * Short code only (`refusal`, `max_output_tokens`, `content_filter`, `json_parse`,
       * `batch_expired`, `rate_limit_exceeded`, ...). Never message text, prompts or notes.
       */
      detail: string;
      /** Present when the provider billed the attempt (refusals, truncated output). */
      usage?: ModelUsage;
      /** Adapters never return the text of an invalid or refused output. */
      attemptedRaw?: never;
    };

export type VisionBatchState =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

export interface VisionBatchStatus {
  handle: VisionBatchHandle;
  /** Terminal states: `completed`, `failed`, `expired`, `cancelled` (`isTerminalBatchState`). */
  state: VisionBatchState;
  /** Raw provider status string (`in_progress`, `ended`, ...) for logs; never a message. */
  providerStatus: string;
  /**
   * Present once the batch is terminal. Photos of the batch that have no entry here got no
   * result: on `expired`/`cancelled` treat them as `expired`, on `failed` as `provider_error`.
   */
  results?: VisionResult[];
  /** Aggregate usage over `results`, written to `ai_batches`. */
  usage?: ModelUsage;
  /** OpenAI: output/error JSONL files (persist them; `deleteBatchArtifacts` removes them). */
  outputFileId?: string;
  errorFileId?: string;
  requestCounts?: { total: number; completed: number; failed: number };
  /** ISO 8601, when the provider expires the batch (24 h after creation). */
  expiresAt?: string;
  /** `failed` batches: the provider's validation error code (e.g. `invalid_json_line`). */
  failureCode?: string;
}

export interface VisionDescriber {
  readonly provider: VisionProvider;
  readonly model: string;
  /**
   * Describe stage: submit one Batch API job (PRD FR-5.2). The default path. Throws
   * `AiRequestError` before any network call when a request is not paid, an image is not a
   * valid analysis copy, a context is invalid, or the batch exceeds the byte cap.
   */
  describeBatch(requests: VisionRequest[]): Promise<VisionBatchHandle>;
  /** Poller (every 5 min): current batch state, plus results once terminal. Idempotent. */
  pollBatch(handle: VisionBatchHandle): Promise<VisionBatchStatus>;
  /**
   * Delete everything the provider keeps for a terminal batch (PRD "Privacy and child safety":
   * batch input files are deleted after results are retrieved). OpenAI: input, output and error
   * files; Anthropic: the batch; fake: records the call. Already-gone artifacts count as deleted.
   * `status` supplies the output/error file ids; without them the batch is retrieved first.
   */
  deleteBatchArtifacts(
    handle: VisionBatchHandle,
    status?: Pick<VisionBatchStatus, "outputFileId" | "errorFileId">,
  ): Promise<{ deleted: string[] }>;
  /** Cancel a non-terminal batch (operator use; never called automatically). */
  cancelBatch(handle: VisionBatchHandle): Promise<void>;
  /** Priority path only (PRD FR-5.5): real-time call; implemented, not wired in step 6 (D8). */
  describeOne(request: VisionRequest): Promise<VisionResult>;
}

// ---------------------------------------------------------------------------------------------
// Chat (agentic RAG, real-time; docs/plans/step-7.md 2.5)
// ---------------------------------------------------------------------------------------------

export interface ChatToolCall {
  /** Provider call id (OpenAI `call_id`); echoed back as `toolCallId` of the tool message. */
  id: string;
  name: string;
  /**
   * Unvalidated arguments as produced by the model: the parsed JSON object, or the raw string
   * when it was not valid JSON. Validate with `parseChatToolArguments` (`@tinyglow/shared`)
   * before executing. Never log (they contain the user's query).
   */
  arguments: unknown;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ChatToolCall[];
      /**
       * Opaque provider output items of the call that produced this message
       * (`ChatCompletion.providerItems`). Pass them back unchanged on the next call of the same
       * turn: OpenAI needs its `reasoning` items (with `encrypted_content`) and `function_call`
       * items echoed because requests use `store: false`. Never persisted, never logged.
       */
      providerItems?: unknown[];
    }
  /** Tool output is data, never instructions (prompt-injection guardrail). */
  | { role: "tool"; toolCallId: string; content: string };

export interface ChatToolDefinition {
  name: string;
  description: string;
  /** Strict JSON Schema for the arguments (`CHAT_TOOL_JSON_SCHEMAS` in `@tinyglow/shared`). */
  parameters: Readonly<Record<string, unknown>>;
}

export interface ChatOptions {
  /** Defaults to the adapter's configured effort (`CHAT_REASONING_EFFORT`, `low`). */
  reasoningEffort?: ReasoningEffort;
  /** Defaults to the adapter's configured `CHAT_MAX_OUTPUT_TOKENS`. */
  maxOutputTokens?: number;
  /** Force or forbid tool use for this turn. Default `"auto"`. */
  toolChoice?: "auto" | "none" | "required";
  /**
   * Strict structured output instead of free text (the optional LLM re-rank): OpenAI
   * `text.format = {type: "json_schema", name, schema, strict: true}`. `text` of the completion
   * is then the JSON string; validate it with zod.
   */
  jsonSchema?: { name: string; schema: Readonly<Record<string, unknown>> };
  /** Caller's cancellation (client went away); combined with the adapter's timeout. */
  signal?: AbortSignal;
}

export type ChatFinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export interface ChatCompletion {
  model: string;
  /** Final assistant text (with citation markers as the model wrote them). Never log. */
  text: string;
  toolCalls: ChatToolCall[];
  finishReason: ChatFinishReason;
  /** `costUsd` from the pinned price table, standard (real-time) tier. */
  usage: ModelUsage;
  latencyMs: number;
  /** Opaque output items to echo back in `ChatMessage.providerItems` (see there). */
  providerItems?: unknown[];
  /** Provider response id (safe to log). */
  responseId?: string;
}

/**
 * Streaming events. `text_delta`s concatenate to `completion.text`; each `tool_call` is emitted
 * once its arguments are complete; the last event is always `done`.
 */
export type ChatStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; toolCall: ChatToolCall }
  | { type: "done"; completion: ChatCompletion };

export interface ChatModel {
  readonly provider: VisionProvider;
  readonly model: string;
  /** Non-streaming variant (the stream drained). */
  complete(
    messages: ChatMessage[],
    tools: readonly ChatToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatCompletion>;
  /**
   * Streaming variant; the last event is always `done` with the full completion. Throws
   * `AiProviderError` (status + short code, never a body) on provider failure or timeout.
   */
  stream(
    messages: ChatMessage[],
    tools: readonly ChatToolDefinition[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamEvent>;
}

// ---------------------------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------------------------

/** Usage of one `embed` call (for the `ai_spend` ledger). */
export interface EmbedUsage {
  /** Billed input tokens (OpenAI `usage.prompt_tokens`; fake: `ceil(chars / 4)`). */
  inputTokens: number;
  /** From the pinned price table (standard tier); the fake prices like `text-embedding-3-small`. */
  costUsd: number;
}

export interface EmbedResult {
  /** One unit-length vector of `dims` per input, same order. */
  vectors: number[][];
  usage: EmbedUsage;
}

export interface Embedder {
  /** `text-embedding-3-small`, or `fake` for the deterministic fake. */
  readonly model: string;
  /** Vector length; must equal the `photo_search.embedding` column (1024). */
  readonly dims: number;
  /** Inputs are search documents (~250 tokens each) or queries. Never log them. */
  embed(texts: string[]): Promise<EmbedResult>;
}
