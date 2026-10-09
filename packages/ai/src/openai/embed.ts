/**
 * OpenAI embeddings (docs/plans/step-7.md 2.2, 2.5). `POST /v1/embeddings {model, input,
 * dimensions, encoding_format: "float"}` → `{data: [{index, embedding}], usage: {prompt_tokens}}`.
 * Inputs are search documents and queries; never logged. Usage is summed over chunks and priced
 * from the pinned table (standard tier); a response without usage is estimated at
 * `ceil(chars / 4)` so spend is never recorded as $0.
 */

import { DEFAULT_OPENAI_BASE_URL } from "../defaults";
import { AiConfigError, AiProviderError } from "../errors";
import { HttpClient, type HttpClientOptions } from "../http";
import { costUsd, hasPrice } from "../pricing";
import type { AiLogger, Embedder, EmbedResult } from "../types";

export interface OpenAiEmbedderOptions {
  apiKey: string;
  model: string;
  dims: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: AiLogger;
  http?: Pick<HttpClientOptions, "retryBaseMs" | "sleep" | "timeoutMs" | "maxRetries">;
}

/** OpenAI accepts up to 2,048 inputs per request. */
const MAX_INPUTS = 2048;

export function createOpenAiEmbedder(opts: OpenAiEmbedderOptions): Embedder {
  const http = new HttpClient({
    provider: "openai",
    baseUrl: opts.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    headers: { authorization: `Bearer ${opts.apiKey}` },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...opts.http,
  });

  async function embed(texts: string[]): Promise<EmbedResult> {
    const out: number[][] = [];
    let inputTokens = 0;
    for (let i = 0; i < texts.length; i += MAX_INPUTS) {
      const chunk = texts.slice(i, i + MAX_INPUTS);
      const res = await http.request({
        op: "embeddings.create",
        method: "POST",
        path: "/v1/embeddings",
        json: { model: opts.model, input: chunk, dimensions: opts.dims, encoding_format: "float" },
        retry: "idempotent",
      });
      const body = res.body as { data?: unknown; usage?: { prompt_tokens?: unknown } } | undefined;
      const data = body?.data;
      const promptTokens = body?.usage?.prompt_tokens;
      inputTokens +=
        typeof promptTokens === "number" && Number.isFinite(promptTokens) && promptTokens >= 0
          ? promptTokens
          : chunk.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
      if (!Array.isArray(data) || data.length !== chunk.length) {
        throw new AiProviderError(
          "openai",
          "embeddings.create",
          res.status,
          "malformed_embeddings",
          false,
        );
      }
      const vectors: number[][] = new Array(chunk.length);
      for (const item of data as { index?: unknown; embedding?: unknown }[]) {
        const idx = typeof item.index === "number" ? item.index : -1;
        if (
          idx < 0 ||
          idx >= chunk.length ||
          !Array.isArray(item.embedding) ||
          item.embedding.length !== opts.dims
        ) {
          throw new AiProviderError(
            "openai",
            "embeddings.create",
            res.status,
            "malformed_embeddings",
            false,
          );
        }
        vectors[idx] = item.embedding as number[];
      }
      for (let j = 0; j < chunk.length; j++) {
        if (!vectors[j]) {
          throw new AiProviderError(
            "openai",
            "embeddings.create",
            res.status,
            "malformed_embeddings",
            false,
          );
        }
      }
      out.push(...vectors);
    }
    // The factory asserts the price up front; a direct construction with an unpriced model
    // fails here, after the provider answered, rather than recording $0.
    if (!hasPrice(opts.model)) throw new AiConfigError(["EMBED_MODEL"]);
    return {
      vectors: out,
      usage: {
        inputTokens,
        costUsd: costUsd(opts.model, "standard", {
          inputTokens,
          cachedInputTokens: 0,
          outputTokens: 0,
        }),
      },
    };
  }

  return { model: opts.model, dims: opts.dims, embed };
}
