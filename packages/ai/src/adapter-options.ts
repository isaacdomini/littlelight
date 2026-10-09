import type { ReasoningEffort } from "./defaults";
import type { HttpClientOptions } from "./http";
import type { ImageDetail } from "./request";
import type { AiLogger } from "./types";

/** Construction options shared by the OpenAI and Anthropic vision adapters. */
export interface VisionAdapterOptions {
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  /** `AI_MAX_OUTPUT_TOKENS` (default 1200). */
  maxOutputTokens: number;
  /** `AI_IMAGE_DETAIL` (OpenAI only; default `auto`). */
  imageDetail?: ImageDetail;
  /** `AI_BATCH_MAX_BYTES`: `describeBatch` refuses a larger upload (the worker splits). */
  maxBatchBytes: number;
  /** `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` (mock servers); default the real API. */
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: AiLogger;
  /** Test knobs (retry backoff, sleep, timeout). */
  http?: Pick<HttpClientOptions, "retryBaseMs" | "sleep" | "timeoutMs" | "maxRetries">;
}
