/**
 * Anthropic Message Batches API (docs/plans/step-6.md 2.2): create, retrieve, results stream,
 * cancel, delete. Headers `x-api-key` + `anthropic-version: 2023-06-01` (set on the client).
 */

import { AiProviderError } from "../errors";
import type { HttpClient } from "../http";
import type { VisionBatchState } from "../types";

export interface AnthropicBatch {
  id: string;
  processingStatus: string;
  counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  resultsUrl?: string;
  createdAt?: string;
  expiresAt?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function parseAnthropicBatch(body: unknown, op: string): AnthropicBatch {
  if (!isObj(body) || typeof body.id !== "string" || typeof body.processing_status !== "string") {
    throw new AiProviderError("anthropic", op, 200, "malformed_batch", false);
  }
  const rc = isObj(body.request_counts) ? body.request_counts : {};
  const out: AnthropicBatch = {
    id: body.id,
    processingStatus: body.processing_status,
    counts: {
      processing: n(rc.processing),
      succeeded: n(rc.succeeded),
      errored: n(rc.errored),
      canceled: n(rc.canceled),
      expired: n(rc.expired),
    },
  };
  const resultsUrl = str(body.results_url);
  if (resultsUrl) out.resultsUrl = resultsUrl;
  const createdAt = str(body.created_at);
  if (createdAt) out.createdAt = createdAt;
  const expiresAt = str(body.expires_at);
  if (expiresAt) out.expiresAt = expiresAt;
  return out;
}

/**
 * `processing_status` → `VisionBatchState`. `ended` is `completed` unless every request expired
 * (`expired`) or was canceled (`cancelled`); per-request outcomes come from the results.
 */
export function mapAnthropicStatus(batch: AnthropicBatch): VisionBatchState {
  const c = batch.counts;
  const total = c.processing + c.succeeded + c.errored + c.canceled + c.expired;
  switch (batch.processingStatus) {
    case "in_progress":
      return "in_progress";
    case "canceling":
      return "cancelling";
    case "ended":
      if (total > 0 && c.expired === total) return "expired";
      if (total > 0 && c.canceled === total) return "cancelled";
      return "completed";
    default:
      return "in_progress";
  }
}

export function requestCounts(batch: AnthropicBatch) {
  const c = batch.counts;
  return {
    total: c.processing + c.succeeded + c.errored + c.canceled + c.expired,
    completed: c.succeeded,
    failed: c.errored + c.canceled + c.expired,
  };
}

const batchPath = (id: string) => `/v1/messages/batches/${encodeURIComponent(id)}`;

/** `POST /v1/messages/batches` with a body pre-serialised as `{"requests":[...]}`. */
export async function createMessageBatch(
  http: HttpClient,
  jsonText: string,
): Promise<AnthropicBatch> {
  const res = await http.request({
    op: "batches.create",
    method: "POST",
    path: "/v1/messages/batches",
    jsonText,
    retry: "rate_limit_only",
    timeoutMs: 10 * 60_000,
  });
  return parseAnthropicBatch(res.body, "batches.create");
}

export async function retrieveMessageBatch(http: HttpClient, id: string): Promise<AnthropicBatch> {
  const res = await http.request({
    op: "batches.retrieve",
    method: "GET",
    path: batchPath(id),
    retry: "idempotent",
  });
  return parseAnthropicBatch(res.body, "batches.retrieve");
}

export async function cancelMessageBatch(http: HttpClient, id: string): Promise<void> {
  await http.request({
    op: "batches.cancel",
    method: "POST",
    path: `${batchPath(id)}/cancel`,
    retry: "idempotent",
  });
}

/** `DELETE /v1/messages/batches/{id}` (only after `ended`); true when deleted or already gone. */
export async function deleteMessageBatch(http: HttpClient, id: string): Promise<boolean> {
  await http.request({
    op: "batches.delete",
    method: "DELETE",
    path: batchPath(id),
    retry: "idempotent",
    allowStatuses: [404],
  });
  return true;
}

/**
 * Streams the results JSONL. `results_url` is followed only when it is on the configured base
 * URL's origin (the API key is sent with it); otherwise the canonical path is used.
 */
export function streamResults(http: HttpClient, batch: AnthropicBatch): AsyncGenerator<string> {
  const path =
    (batch.resultsUrl && http.sameOriginPath(batch.resultsUrl)) || `${batchPath(batch.id)}/results`;
  return http.lines({
    op: "batches.results",
    method: "GET",
    path,
    retry: "idempotent",
    timeoutMs: 10 * 60_000,
  });
}
