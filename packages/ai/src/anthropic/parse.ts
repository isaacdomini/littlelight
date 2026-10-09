/**
 * Anthropic Messages / Message Batches result parsing (docs/plans/step-6.md 2.2, 2.5).
 * Tolerant: missing usage sub-objects count as 0; the nested error shape
 * (`{type: "error", error: {type}}`) and a flat `{type}` are both accepted. Never returns or
 * throws the text of a refused or invalid output.
 */

import { safeCode } from "../errors";
import { costUsd, type PriceTierName } from "../pricing";
import type { ModelUsage, VisionResult } from "../types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * `message.usage` → `ModelUsage`. Anthropic's `input_tokens` excludes cache reads and writes;
 * `ModelUsage.inputTokens` is normalised to include them. 1-hour cache writes are priced at the
 * 1-hour rate when `cache_creation.ephemeral_1h_input_tokens` is reported.
 */
export function anthropicUsage(usage: unknown, model: string, tier: PriceTierName): ModelUsage {
  const u = isObj(usage) ? usage : {};
  const uncached = num(u.input_tokens);
  const cachedInputTokens = num(u.cache_read_input_tokens);
  const cacheWriteTokens = num(u.cache_creation_input_tokens);
  const creation = isObj(u.cache_creation) ? u.cache_creation : {};
  const cacheWrite1hTokens = num(creation.ephemeral_1h_input_tokens);
  const outputTokens = num(u.output_tokens);
  const inputTokens = uncached + cachedInputTokens + cacheWriteTokens;
  const out: ModelUsage = {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: costUsd(model, tier, {
      inputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      cacheWrite1hTokens,
      outputTokens,
    }),
  };
  if (cacheWriteTokens) out.cacheWriteTokens = cacheWriteTokens;
  const details = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
  const thinking = num(details.thinking_tokens ?? details.reasoning_tokens);
  out.reasoningTokens = thinking;
  return out;
}

/** Maps one Messages API response (a batch `succeeded` result's `message`, or a real-time reply). */
export function parseMessage(
  message: unknown,
  photoId: string,
  model: string,
  tier: PriceTierName,
): VisionResult {
  if (!isObj(message))
    return { photoId, ok: false, failure: "provider_error", detail: "empty_body" };
  const usage = isObj(message.usage) ? anthropicUsage(message.usage, model, tier) : undefined;
  const withUsage = usage ? { usage } : {};
  const stop = message.stop_reason;
  if (stop === "refusal")
    return { photoId, ok: false, failure: "refusal", detail: "refusal", ...withUsage };
  if (stop === "max_tokens") {
    return { photoId, ok: false, failure: "invalid_output", detail: "max_tokens", ...withUsage };
  }
  const texts: string[] = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isObj(block) && block.type === "text" && typeof block.text === "string")
        texts.push(block.text);
    }
  }
  if (!texts.length) {
    return {
      photoId,
      ok: false,
      failure: "invalid_output",
      detail: "no_output_text",
      ...withUsage,
    };
  }
  try {
    const zero: ModelUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
    return { photoId, ok: true, raw: JSON.parse(texts.join("")), usage: usage ?? zero };
  } catch {
    return { photoId, ok: false, failure: "invalid_output", detail: "json_parse", ...withUsage };
  }
}

/** Error type from `{type: "error", error: {type}}` or `{type}`. */
export function anthropicErrorType(error: unknown): string {
  if (!isObj(error)) return "error";
  if (isObj(error.error)) return safeCode(error.error.type, "error");
  return safeCode(error.type, "error");
}

/**
 * One line of the results JSONL:
 * `{custom_id, result: {type: succeeded|errored|canceled|expired, message?, error?}}`.
 * Returns null for a line without a usable `custom_id` (or unparseable JSON).
 */
export function parseResultLine(line: string, model: string): VisionResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(obj) || typeof obj.custom_id !== "string" || !obj.custom_id) return null;
  const photoId = obj.custom_id;
  const result = isObj(obj.result) ? obj.result : {};
  switch (result.type) {
    case "succeeded":
      return parseMessage(result.message, photoId, model, "batch");
    case "expired":
      return { photoId, ok: false, failure: "expired", detail: "expired" };
    case "canceled":
      return { photoId, ok: false, failure: "expired", detail: "canceled" };
    case "errored": {
      const type = anthropicErrorType(result.error);
      return {
        photoId,
        ok: false,
        failure: type === "rate_limit_error" ? "rate_limited" : "provider_error",
        detail: type,
      };
    }
    default:
      return { photoId, ok: false, failure: "provider_error", detail: "unknown_result" };
  }
}
