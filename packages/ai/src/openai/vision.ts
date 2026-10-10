/**
 * OpenAI vision adapter: GPT-6 Luna on the Batch API with `/v1/responses` requests
 * (docs/plans/step-6.md 2.2, 2.5). Plain `fetch` (D2).
 *
 * Lifecycle: `describeBatch` builds the JSONL in memory (`custom_id = photoId`, base64 data URL
 * of the 768 px analysis copy, static instructions + strict JSON Schema, `store: false`),
 * uploads it (`purpose=batch`) and creates the batch; `pollBatch` retrieves it and, when
 * terminal, streams the output and error files; `deleteBatchArtifacts` deletes the input,
 * output and error files. Logs carry ids, counts, bytes, durations and codes only.
 */

import { randomUUID } from "node:crypto";
import type { VisionAdapterOptions } from "../adapter-options";
import { isTerminalBatchState, sumUsage } from "../batch-state";
import { DEFAULT_OPENAI_BASE_URL } from "../defaults";
import { AiProviderError, AiRequestError } from "../errors";
import { HttpClient } from "../http";
import { assertPriced } from "../pricing";
import { checkVisionBatch, checkVisionRequest, openAiResponsesBody } from "../request";
import type {
  VisionBatchHandle,
  VisionBatchStatus,
  VisionDescriber,
  VisionRequest,
  VisionResult,
} from "../types";
import { cancelBatch, createBatch, mapOpenAiStatus, retrieveBatch } from "./batch";
import { deleteFile, streamFileLines, uploadBatchFile } from "./files";
import { parseBatchLine, parseResponsesBody } from "./parse";

const encoder = new TextEncoder();

export function createOpenAiHttp(
  opts: Omit<
    VisionAdapterOptions,
    "model" | "reasoningEffort" | "maxOutputTokens" | "maxBatchBytes"
  >,
) {
  return new HttpClient({
    provider: "openai",
    baseUrl: opts.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    headers: { authorization: `Bearer ${opts.apiKey}` },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...opts.http,
  });
}

/** One JSONL line per request (exported for tests and the byte estimate). */
export function openAiBatchLine(request: VisionRequest, opts: VisionAdapterOptions): string {
  return JSON.stringify({
    custom_id: request.photoId,
    method: "POST",
    url: "/v1/responses",
    body: openAiResponsesBody(request, {
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      maxOutputTokens: opts.maxOutputTokens,
      imageDetail: opts.imageDetail ?? "auto",
    }),
  });
}

export function createOpenAiVisionDescriber(opts: VisionAdapterOptions): VisionDescriber {
  assertPriced(opts.model, "VISION_MODEL");
  const http = createOpenAiHttp(opts);
  const log = opts.log;

  async function describeBatch(input: VisionRequest[]): Promise<VisionBatchHandle> {
    const started = Date.now();
    const { requests, warnings } = checkVisionBatch(input);
    if (warnings.length) {
      log?.warn(
        {
          provider: "openai",
          photoIds: warnings.map((w) => w.photoId),
          warning: "context_coordinates_blanked",
        },
        "ai context field blanked",
      );
    }
    const parts: Uint8Array[] = [];
    let bytes = 0;
    for (const r of requests) {
      const line = encoder.encode(`${openAiBatchLine(r, opts)}\n`);
      bytes += line.byteLength;
      if (bytes > opts.maxBatchBytes) throw new AiRequestError("batch_too_large");
      parts.push(line);
    }
    const first = requests[0] as VisionRequest;
    const file = await uploadBatchFile(http, parts, `tinyglow-batch-${randomUUID()}.jsonl`);
    let batch: Awaited<ReturnType<typeof createBatch>>;
    try {
      batch = await createBatch(http, file.id, {
        app: "tinyglow",
        prompt_version: first.promptVersion,
        schema_version: first.schemaVersion,
      });
    } catch (err) {
      // Never leave an orphaned input file (photos) at the provider.
      await deleteFile(http, file.id).catch(() => {
        log?.warn({ provider: "openai", fileId: file.id }, "ai orphaned input file not deleted");
      });
      throw err;
    }
    log?.info(
      {
        provider: "openai",
        batchId: batch.id,
        inputFileId: file.id,
        count: requests.length,
        bytes,
        ms: Date.now() - started,
      },
      "ai batch submitted",
    );
    return {
      provider: "openai",
      batchId: batch.id,
      model: opts.model,
      submittedAt: batch.createdAt ?? new Date().toISOString(),
      requestCount: requests.length,
      inputFileId: file.id,
      promptVersion: first.promptVersion,
      schemaVersion: first.schemaVersion,
    };
  }

  async function pollBatch(handle: VisionBatchHandle): Promise<VisionBatchStatus> {
    const batch = await retrieveBatch(http, handle.batchId);
    const state = mapOpenAiStatus(batch.status);
    const status: VisionBatchStatus = { handle, state, providerStatus: batch.status };
    if (batch.outputFileId) status.outputFileId = batch.outputFileId;
    if (batch.errorFileId) status.errorFileId = batch.errorFileId;
    if (batch.requestCounts) status.requestCounts = batch.requestCounts;
    if (batch.expiresAt) status.expiresAt = batch.expiresAt;
    if (batch.failureCode) status.failureCode = batch.failureCode;
    if (!isTerminalBatchState(state)) return status;

    const results = new Map<string, VisionResult>();
    let unparsed = 0;
    for (const fileId of [batch.outputFileId, batch.errorFileId]) {
      if (!fileId) continue;
      for await (const line of streamFileLines(http, fileId)) {
        const result = parseBatchLine(line, handle.model);
        if (!result) {
          unparsed++;
          continue;
        }
        if (!results.has(result.photoId)) results.set(result.photoId, result);
      }
    }
    status.results = [...results.values()];
    const usage = sumUsage(status.results);
    if (usage) status.usage = usage;
    log?.info(
      {
        provider: "openai",
        batchId: handle.batchId,
        state,
        results: status.results.length,
        ok: status.results.filter((r) => r.ok).length,
        unparsed,
        failureCode: batch.failureCode,
      },
      "ai batch results",
    );
    return status;
  }

  async function deleteBatchArtifacts(
    handle: VisionBatchHandle,
    status?: Pick<VisionBatchStatus, "outputFileId" | "errorFileId">,
  ): Promise<{ deleted: string[] }> {
    let output = status?.outputFileId;
    let error = status?.errorFileId;
    if (!status) {
      const batch = await retrieveBatch(http, handle.batchId);
      output = batch.outputFileId;
      error = batch.errorFileId;
    }
    const ids = [handle.inputFileId, output, error].filter((id): id is string => !!id);
    const deleted: string[] = [];
    let firstError: unknown;
    for (const id of ids) {
      try {
        await deleteFile(http, id);
        deleted.push(id);
      } catch (err) {
        firstError ??= err;
      }
    }
    log?.info(
      { provider: "openai", batchId: handle.batchId, deleted: deleted.length, of: ids.length },
      "ai batch files deleted",
    );
    if (firstError) throw firstError;
    return { deleted };
  }

  async function cancel(handle: VisionBatchHandle): Promise<void> {
    await cancelBatch(http, handle.batchId);
  }

  async function describeOne(input: VisionRequest): Promise<VisionResult> {
    const { request } = checkVisionRequest(input);
    const started = Date.now();
    try {
      const res = await http.request({
        op: "responses.create",
        method: "POST",
        path: "/v1/responses",
        json: openAiResponsesBody(request, {
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          maxOutputTokens: opts.maxOutputTokens,
          imageDetail: opts.imageDetail ?? "auto",
        }),
        retry: "idempotent",
      });
      const result = parseResponsesBody(res.body, request.photoId, opts.model, "standard");
      const latencyMs = Date.now() - started;
      return result.ok ? { ...result, latencyMs } : result;
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
    provider: "openai",
    model: opts.model,
    describeBatch,
    pollBatch,
    deleteBatchArtifacts,
    cancelBatch: cancel,
    describeOne,
  };
}
