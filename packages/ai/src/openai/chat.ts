/**
 * OpenAI chat adapter: GPT-6 Luna on the Responses API with function calling, streamed
 * (docs/plans/step-7.md 2.2, 2.5; PRD "Chat and RAG pipeline"). Plain `fetch` (step-6 D2).
 *
 * Request body (`POST /v1/responses`):
 *   {model, instructions, input, tools: [{type: "function", name, description, parameters,
 *    strict: true}], tool_choice, parallel_tool_calls: true, reasoning: {effort},
 *    max_output_tokens, store: false, include: ["reasoning.encrypted_content"],
 *    prompt_cache_key: "littlelight-chat-<CHAT_PROMPT_VERSION>", stream: true}
 *
 * Message mapping: `system` → `instructions` (joined); `user` / `assistant` → `{role, content}`
 * input messages; an assistant message that carries `providerItems` (the previous call of the
 * same turn) is replayed as those raw output items, in order, so `reasoning` items with
 * `encrypted_content` and the `function_call` items travel back without `store` (R2); `tool` →
 * `{type: "function_call_output", call_id, output}`.
 *
 * Privacy: request and response bodies (questions, notes from `get_photo`, answers, tool
 * arguments) never reach a log or an error. Logs: response id, model, finish reason, tool names,
 * token counts, cost, latency.
 */

import { CHAT_PROMPT_VERSION } from "@littlelight/shared";
import { DEFAULT_OPENAI_BASE_URL, type ReasoningEffort } from "../defaults";
import { AiProviderError } from "../errors";
import { HttpClient, type HttpClientOptions } from "../http";
import { assertPriced } from "../pricing";
import type {
  AiLogger,
  ChatCompletion,
  ChatMessage,
  ChatModel,
  ChatOptions,
  ChatStreamEvent,
  ChatToolDefinition,
} from "../types";
import { ResponsesStreamParser, sseFrames } from "./sse";

export interface OpenAiChatModelOptions {
  apiKey: string;
  /** `CHAT_MODEL` (must be priced). */
  model: string;
  /** `CHAT_REASONING_EFFORT` (default `low`). */
  reasoningEffort: ReasoningEffort;
  /** `CHAT_MAX_OUTPUT_TOKENS`. */
  maxOutputTokens: number;
  /** `CHAT_MODEL_TIMEOUT_MS`: bounds one call including reading the whole stream. */
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: AiLogger;
  /** Test knobs. */
  http?: Pick<HttpClientOptions, "retryBaseMs" | "sleep" | "maxRetries">;
}

/** `prompt_cache_key` of chat requests (system prompt + tool schemas are the cached prefix). */
export const CHAT_PROMPT_CACHE_KEY = `littlelight-chat-${CHAT_PROMPT_VERSION}`;

/** Responses `input` items for a conversation (exported for tests). */
export function openAiChatInput(messages: readonly ChatMessage[]): {
  instructions: string | undefined;
  input: unknown[];
} {
  const system: string[] = [];
  const input: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        system.push(m.content);
        break;
      case "user":
        input.push({ role: "user", content: m.content });
        break;
      case "assistant":
        if (m.providerItems && m.providerItems.length > 0) input.push(...m.providerItems);
        else if (m.toolCalls && m.toolCalls.length > 0) {
          // No provider items (e.g. produced by another adapter): rebuild the calls.
          if (m.content) input.push({ role: "assistant", content: m.content });
          for (const c of m.toolCalls) {
            input.push({
              type: "function_call",
              call_id: c.id,
              name: c.name,
              arguments:
                typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
            });
          }
        } else input.push({ role: "assistant", content: m.content });
        break;
      case "tool":
        input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
        break;
    }
  }
  return { instructions: system.length ? system.join("\n\n") : undefined, input };
}

/** The full request body (exported for tests). */
export function openAiChatBody(
  messages: readonly ChatMessage[],
  tools: readonly ChatToolDefinition[],
  opts: {
    model: string;
    reasoningEffort: ReasoningEffort;
    maxOutputTokens: number;
    options?: ChatOptions;
  },
): Record<string, unknown> {
  const { instructions, input } = openAiChatInput(messages);
  const o = opts.options ?? {};
  const body: Record<string, unknown> = { model: opts.model };
  if (instructions !== undefined) body.instructions = instructions;
  body.input = input;
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: true,
    }));
    body.tool_choice = o.toolChoice ?? "auto";
    body.parallel_tool_calls = true;
  }
  if (o.jsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: o.jsonSchema.name,
        schema: o.jsonSchema.schema,
        strict: true,
      },
    };
  }
  body.reasoning = { effort: o.reasoningEffort ?? opts.reasoningEffort };
  body.max_output_tokens = o.maxOutputTokens ?? opts.maxOutputTokens;
  body.store = false;
  body.include = ["reasoning.encrypted_content"];
  body.prompt_cache_key = CHAT_PROMPT_CACHE_KEY;
  body.stream = true;
  return body;
}

export function createOpenAiChatModel(opts: OpenAiChatModelOptions): ChatModel {
  assertPriced(opts.model, "CHAT_MODEL");
  const http = new HttpClient({
    provider: "openai",
    baseUrl: opts.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    headers: { authorization: `Bearer ${opts.apiKey}` },
    timeoutMs: opts.timeoutMs,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...opts.http,
  });
  const log = opts.log;

  async function* stream(
    messages: ChatMessage[],
    tools: readonly ChatToolDefinition[],
    options: ChatOptions = {},
  ): AsyncGenerator<ChatStreamEvent> {
    const started = Date.now();
    const op = "responses.stream";
    const res = await http.openStream({
      op,
      method: "POST",
      path: "/v1/responses",
      json: openAiChatBody(messages, tools, {
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        maxOutputTokens: opts.maxOutputTokens,
        options,
      }),
      // Real-time and side-effect free (`store: false`): retry before the stream starts.
      retry: "idempotent",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parser = new ResponsesStreamParser(opts.model, { op });
    let completion: ChatCompletion;
    try {
      if (res.body) {
        for await (const frame of sseFrames(res.body)) {
          for (const ev of parser.push(frame)) yield ev;
        }
      }
      completion = parser.finish(Date.now() - started);
    } catch (err) {
      if (err instanceof AiProviderError) {
        log?.warn(
          { provider: "openai", op, model: opts.model, code: err.code, ms: Date.now() - started },
          "ai chat call failed",
        );
        throw err;
      }
      const code = options.signal?.aborted
        ? "aborted"
        : err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
          ? "timeout"
          : "network";
      log?.warn(
        { provider: "openai", op, model: opts.model, code, ms: Date.now() - started },
        "ai chat call failed",
      );
      throw new AiProviderError("openai", op, 0, code, code !== "aborted");
    }
    log?.info(
      {
        provider: "openai",
        op,
        model: opts.model,
        responseId: completion.responseId,
        finishReason: completion.finishReason,
        tools: completion.toolCalls.map((c) => c.name),
        inputTokens: completion.usage.inputTokens,
        cachedInputTokens: completion.usage.cachedInputTokens,
        outputTokens: completion.usage.outputTokens,
        reasoningTokens: completion.usage.reasoningTokens ?? 0,
        costUsd: completion.usage.costUsd,
        ms: completion.latencyMs,
      },
      "ai chat call",
    );
    yield { type: "done", completion };
  }

  async function complete(
    messages: ChatMessage[],
    tools: readonly ChatToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatCompletion> {
    return drainChatStream(stream(messages, tools, options));
  }

  return { provider: "openai", model: opts.model, complete, stream };
}

/** `complete()` from `stream()`: the `done` event's completion. */
export async function drainChatStream(
  events: AsyncIterable<ChatStreamEvent>,
  provider = "openai",
): Promise<ChatCompletion> {
  let done: ChatCompletion | undefined;
  for await (const ev of events) if (ev.type === "done") done = ev.completion;
  if (!done) throw new AiProviderError(provider, "chat.stream", 200, "stream_truncated", true);
  return done;
}
