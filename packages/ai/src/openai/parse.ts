/**
 * OpenAI Responses / Batch output parsing (docs/plans/step-6.md 2.2, 2.5). Tolerant of missing
 * sub-objects (plan R3: usage detail field names are from the docs, unexercised until the real
 * run). Never returns or throws the text of a refused or invalid output.
 */

import { safeCode } from "../errors";
import { providerErrorCode } from "../http";
import { costUsd, type PriceTierName } from "../pricing";
import type { ModelUsage, VisionResult } from "../types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** `usage` of a Responses object → `ModelUsage` (input includes cached; output includes reasoning). */
export function openAiUsage(usage: unknown, model: string, tier: PriceTierName): ModelUsage {
  const u = isObj(usage) ? usage : {};
  const inDetails = isObj(u.input_tokens_details) ? u.input_tokens_details : {};
  const outDetails = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
  const inputTokens = num(u.input_tokens);
  const cachedInputTokens = num(inDetails.cached_tokens);
  const cacheWriteTokens = num(inDetails.cache_write_tokens ?? inDetails.cache_creation_tokens);
  const outputTokens = num(u.output_tokens);
  const reasoningTokens = num(outDetails.reasoning_tokens);
  const imageTokens = num(inDetails.image_tokens);
  const out: ModelUsage = {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: costUsd(model, tier, {
      inputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      outputTokens,
    }),
  };
  if (cacheWriteTokens) out.cacheWriteTokens = cacheWriteTokens;
  out.reasoningTokens = reasoningTokens;
  if (imageTokens) out.imageTokens = imageTokens;
  return out;
}

/** Maps one Responses API object (a batch line's `response.body`, or a real-time response). */
export function parseResponsesBody(
  body: unknown,
  photoId: string,
  model: string,
  tier: PriceTierName,
): VisionResult {
  if (!isObj(body)) {
    return { photoId, ok: false, failure: "provider_error", detail: "empty_body" };
  }
  const usage = isObj(body.usage) ? openAiUsage(body.usage, model, tier) : undefined;
  const status = typeof body.status === "string" ? body.status : "completed";
  if (status === "incomplete") {
    const reason = isObj(body.incomplete_details) ? body.incomplete_details.reason : undefined;
    return {
      photoId,
      ok: false,
      failure: "invalid_output",
      detail: safeCode(reason, "incomplete"),
      ...(usage ? { usage } : {}),
    };
  }
  if (status === "failed" || status === "cancelled") {
    return {
      photoId,
      ok: false,
      failure: "provider_error",
      detail: providerErrorCode(body, 0).replace(/^http_0$/, status),
      ...(usage ? { usage } : {}),
    };
  }
  const texts: string[] = [];
  let refused = false;
  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!isObj(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isObj(part)) continue;
      if (part.type === "refusal") refused = true;
      else if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  if (!texts.length && typeof body.output_text === "string") texts.push(body.output_text);
  if (refused) {
    return {
      photoId,
      ok: false,
      failure: "refusal",
      detail: "refusal",
      ...(usage ? { usage } : {}),
    };
  }
  const zero: ModelUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
  if (!texts.length) {
    return {
      photoId,
      ok: false,
      failure: "invalid_output",
      detail: "no_output_text",
      ...(usage ? { usage } : {}),
    };
  }
  try {
    return { photoId, ok: true, raw: JSON.parse(texts.join("")), usage: usage ?? zero };
  } catch {
    return {
      photoId,
      ok: false,
      failure: "invalid_output",
      detail: "json_parse",
      ...(usage ? { usage } : {}),
    };
  }
}

/**
 * One line of a batch output or error file:
 * `{id, custom_id, response: {status_code, request_id, body} | null, error: {code, message} | null}`.
 * Returns null for a line without a usable `custom_id` (or unparseable JSON).
 */
export function parseBatchLine(line: string, model: string): VisionResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(obj) || typeof obj.custom_id !== "string" || !obj.custom_id) return null;
  const photoId = obj.custom_id;
  if (isObj(obj.error)) {
    const code = safeCode(obj.error.code, "error");
    if (code === "batch_expired") return { photoId, ok: false, failure: "expired", detail: code };
    if (code === "batch_cancelled") return { photoId, ok: false, failure: "expired", detail: code };
    return {
      photoId,
      ok: false,
      failure: code.includes("rate_limit") ? "rate_limited" : "provider_error",
      detail: code,
    };
  }
  const response = isObj(obj.response) ? obj.response : null;
  if (!response) return { photoId, ok: false, failure: "provider_error", detail: "no_response" };
  const statusCode = typeof response.status_code === "number" ? response.status_code : 0;
  if (statusCode !== 200) {
    const code = providerErrorCode(response.body, statusCode);
    return {
      photoId,
      ok: false,
      failure: statusCode === 429 ? "rate_limited" : "provider_error",
      detail: code,
    };
  }
  return parseResponsesBody(response.body, photoId, model, "batch");
}
