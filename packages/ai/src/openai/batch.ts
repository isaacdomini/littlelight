/**
 * OpenAI Batch API (docs/plans/step-6.md 2.2): create (`endpoint: "/v1/responses"`,
 * `completion_window: "24h"`), retrieve, cancel.
 */

import { AiProviderError, safeCode } from "../errors";
import type { HttpClient } from "../http";
import type { VisionBatchState } from "../types";

export interface OpenAiBatch {
  id: string;
  status: string;
  outputFileId?: string;
  errorFileId?: string;
  requestCounts?: { total: number; completed: number; failed: number };
  expiresAt?: string;
  createdAt?: string;
  /** First validation error code of a `failed` batch. */
  failureCode?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const epochIso = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : undefined;

export function parseBatchObject(body: unknown, provider: string, op: string): OpenAiBatch {
  if (!isObj(body) || typeof body.id !== "string" || typeof body.status !== "string") {
    throw new AiProviderError(provider, op, 200, "malformed_batch", false);
  }
  const out: OpenAiBatch = { id: body.id, status: body.status };
  const outputFileId = str(body.output_file_id);
  const errorFileId = str(body.error_file_id);
  if (outputFileId) out.outputFileId = outputFileId;
  if (errorFileId) out.errorFileId = errorFileId;
  if (isObj(body.request_counts)) {
    const rc = body.request_counts;
    out.requestCounts = {
      total: Number(rc.total) || 0,
      completed: Number(rc.completed) || 0,
      failed: Number(rc.failed) || 0,
    };
  }
  const expiresAt = epochIso(body.expires_at);
  if (expiresAt) out.expiresAt = expiresAt;
  const createdAt = epochIso(body.created_at);
  if (createdAt) out.createdAt = createdAt;
  if (isObj(body.errors) && Array.isArray(body.errors.data)) {
    const first = body.errors.data[0];
    if (isObj(first)) out.failureCode = safeCode(first.code, "validation_failed");
  }
  return out;
}

/** OpenAI batch status → `VisionBatchState` (unknown statuses are treated as in progress). */
export function mapOpenAiStatus(status: string): VisionBatchState {
  switch (status) {
    case "validating":
    case "in_progress":
    case "finalizing":
    case "completed":
    case "failed":
    case "expired":
    case "cancelling":
    case "cancelled":
      return status;
    default:
      return "in_progress";
  }
}

export async function createBatch(
  http: HttpClient,
  inputFileId: string,
  metadata: Record<string, string>,
): Promise<OpenAiBatch> {
  const res = await http.request({
    op: "batches.create",
    method: "POST",
    path: "/v1/batches",
    json: {
      input_file_id: inputFileId,
      endpoint: "/v1/responses",
      completion_window: "24h",
      metadata,
    },
    retry: "rate_limit_only",
  });
  return parseBatchObject(res.body, http.provider, "batches.create");
}

export async function retrieveBatch(http: HttpClient, batchId: string): Promise<OpenAiBatch> {
  const res = await http.request({
    op: "batches.retrieve",
    method: "GET",
    path: `/v1/batches/${encodeURIComponent(batchId)}`,
    retry: "idempotent",
  });
  return parseBatchObject(res.body, http.provider, "batches.retrieve");
}

export async function cancelBatch(http: HttpClient, batchId: string): Promise<OpenAiBatch> {
  const res = await http.request({
    op: "batches.cancel",
    method: "POST",
    path: `/v1/batches/${encodeURIComponent(batchId)}/cancel`,
    retry: "idempotent",
  });
  return parseBatchObject(res.body, http.provider, "batches.cancel");
}
