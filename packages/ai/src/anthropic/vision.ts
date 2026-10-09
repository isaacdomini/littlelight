/**
 * Anthropic vision adapter: Claude Haiku 5.5 (`claude-haiku-5-5`) on Message Batches, the
 * fallback behind the same `VisionDescriber` interface (docs/plans/step-6.md 2.2, 2.5). Plain
 * `fetch` (D2). Structured output via `output_config.format` (json_schema), thinking disabled
 * for effort `none`, 1-hour cached system prompt. Images are ephemeral at Anthropic; the only
 * artifact to delete is the batch itself.
 */

import type { VisionAdapterOptions } from "../adapter-options";
import { isTerminalBatchState, sumUsage } from "../batch-state";
import { ANTHROPIC_VERSION, DEFAULT_ANTHROPIC_BASE_URL } from "../defaults";
import { AiProviderError, AiRequestError } from "../errors";
import { HttpClient } from "../http";
import { assertPriced } from "../pricing";
import { anthropicMessageParams, checkVisionBatch, checkVisionRequest } from "../request";
import type {
  VisionBatchHandle,
  VisionBatchStatus,
  VisionDescriber,
  VisionRequest,
  VisionResult,
} from "../types";
import {
  cancelMessageBatch,
  createMessageBatch,
  deleteMessageBatch,
  mapAnthropicStatus,
  requestCounts,
  retrieveMessageBatch,
  streamResults,
} from "./batch";
import { parseMessage, parseResultLine } from "./parse";

/** Anthropic's own cap is 256 MB / 100,000 requests per batch. */
const ANTHROPIC_MAX_BATCH_BYTES = 256_000_000;

export function createAnthropicVisionDescriber(opts: VisionAdapterOptions): VisionDescriber {
  assertPriced(opts.model, "VISION_MODEL");
  const http = new HttpClient({
    provider: "anthropic",
    baseUrl: opts.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL,
    headers: { "x-api-key": opts.apiKey, "anthropic-version": ANTHROPIC_VERSION },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...opts.http,
  });
  const log = opts.log;
  const buildOpts = {
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    maxOutputTokens: opts.maxOutputTokens,
  };
  const maxBytes = Math.min(opts.maxBatchBytes, ANTHROPIC_MAX_BATCH_BYTES);

  async function describeBatch(input: VisionRequest[]): Promise<VisionBatchHandle> {
    const started = Date.now();
    const { requests, warnings } = checkVisionBatch(input);
    if (warnings.length) {
      log?.warn(
        {
          provider: "anthropic",
          photoIds: warnings.map((w) => w.photoId),
          warning: "context_coordinates_blanked",
        },
        "ai context field blanked",
      );
    }
    const items: string[] = [];
    let bytes = 16;
    for (const r of requests) {
      const item = JSON.stringify({
        custom_id: r.photoId,
        params: anthropicMessageParams(r, buildOpts),
      });
      bytes += Buffer.byteLength(item) + 1;
      if (bytes > maxBytes) throw new AiRequestError("batch_too_large");
      items.push(item);
    }
    const batch = await createMessageBatch(http, `{"requests":[${items.join(",")}]}`);
    const first = requests[0] as VisionRequest;
    log?.info(
      {
        provider: "anthropic",
        batchId: batch.id,
        count: requests.length,
        bytes,
        ms: Date.now() - started,
      },
      "ai batch submitted",
    );
    return {
      provider: "anthropic",
      batchId: batch.id,
      model: opts.model,
      submittedAt: batch.createdAt ?? new Date().toISOString(),
      requestCount: requests.length,
      promptVersion: first.promptVersion,
      schemaVersion: first.schemaVersion,
    };
  }

  async function pollBatch(handle: VisionBatchHandle): Promise<VisionBatchStatus> {
    const batch = await retrieveMessageBatch(http, handle.batchId);
    const state = mapAnthropicStatus(batch);
    const status: VisionBatchStatus = {
      handle,
      state,
      providerStatus: batch.processingStatus,
      requestCounts: requestCounts(batch),
    };
    if (batch.expiresAt) status.expiresAt = batch.expiresAt;
    if (!isTerminalBatchState(state)) return status;
    const results = new Map<string, VisionResult>();
    let unparsed = 0;
    for await (const line of streamResults(http, batch)) {
      const result = parseResultLine(line, handle.model);
      if (!result) {
        unparsed++;
        continue;
      }
      if (!results.has(result.photoId)) results.set(result.photoId, result);
    }
    status.results = [...results.values()];
    const usage = sumUsage(status.results);
    if (usage) status.usage = usage;
    log?.info(
      {
        provider: "anthropic",
        batchId: handle.batchId,
        state,
        results: status.results.length,
        ok: status.results.filter((r) => r.ok).length,
        unparsed,
      },
      "ai batch results",
    );
    return status;
  }

  async function deleteBatchArtifacts(handle: VisionBatchHandle): Promise<{ deleted: string[] }> {
    await deleteMessageBatch(http, handle.batchId);
    log?.info({ provider: "anthropic", batchId: handle.batchId, deleted: 1 }, "ai batch deleted");
    return { deleted: [handle.batchId] };
  }

  async function cancel(handle: VisionBatchHandle): Promise<void> {
    await cancelMessageBatch(http, handle.batchId);
  }

  async function describeOne(input: VisionRequest): Promise<VisionResult> {
    const { request } = checkVisionRequest(input);
    const started = Date.now();
    try {
      const res = await http.request({
        op: "messages.create",
        method: "POST",
        path: "/v1/messages",
        json: anthropicMessageParams(request, buildOpts),
        retry: "idempotent",
      });
      const result = parseMessage(res.body, request.photoId, opts.model, "standard");
      return result.ok ? { ...result, latencyMs: Date.now() - started } : result;
    } catch (err) {
      if (err instanceof AiProviderError) {
        return {
          photoId: request.photoId,
          ok: false,
          failure: err.status === 429 ? "rate_limited" : "provider_error",
          detail: err.code,
        };
      }
      throw err;
    }
  }

  return {
    provider: "anthropic",
    model: opts.model,
    describeBatch,
    pollBatch,
    deleteBatchArtifacts,
    cancelBatch: cancel,
    describeOne,
  };
}
