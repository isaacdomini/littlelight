/**
 * OpenAI embeddings (plan D11: no caller until step 7). `POST /v1/embeddings {model, input,
 * dimensions, encoding_format: "float"}`. Inputs are search documents; never logged.
 */

import { DEFAULT_OPENAI_BASE_URL } from "../defaults";
import { AiProviderError } from "../errors";
import { HttpClient, type HttpClientOptions } from "../http";
import type { AiLogger, Embedder } from "../types";

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

  async function embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_INPUTS) {
      const chunk = texts.slice(i, i + MAX_INPUTS);
      const res = await http.request({
        op: "embeddings.create",
        method: "POST",
        path: "/v1/embeddings",
        json: { model: opts.model, input: chunk, dimensions: opts.dims, encoding_format: "float" },
        retry: "idempotent",
      });
      const data = (res.body as { data?: unknown } | undefined)?.data;
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
    return out;
  }

  return { model: opts.model, dims: opts.dims, embed };
}
