/**
 * OpenAI Responses API streaming parser (docs/plans/step-7.md 2.2, 2.5, R1).
 *
 * Two layers, both exported for tests:
 * - `sseFrames(stream)`: splits a byte stream into SSE frames (`event:` / `data:` lines up to a
 *   blank line), decoding UTF-8 across chunk boundaries and tolerating `\r\n`, frames split
 *   mid-line and comment lines.
 * - `ResponsesStreamParser`: turns Responses events into `ChatStreamEvent`s and a final
 *   `ChatCompletion`.
 *
 * Tolerance (R1: some field names come from SDK types, not the reference page): the event type is
 * the payload's `type`, else the frame's `event:` name. Function calls are keyed on the
 * `function_call` **item** of `response.output_item.added/done` (it carries `call_id`, `name` and
 * the final `arguments`); `response.function_call_arguments.delta/done` are only used as a
 * fallback for the arguments. `response.completed`'s `response.output` is the authoritative list
 * of output items (echoed back as `providerItems`, including `reasoning` items with
 * `encrypted_content`); any `function_call` in it that was never announced by an
 * `output_item.done` is emitted before `done`. Unknown event types are ignored.
 *
 * Errors carry the HTTP status (200 for an in-stream failure) and a short code, never a message
 * or any text. Nothing here logs.
 */

import { AiProviderError, safeCode } from "../errors";
import type {
  ChatCompletion,
  ChatFinishReason,
  ChatStreamEvent,
  ChatToolCall,
  ModelUsage,
} from "../types";
import { openAiUsage } from "./parse";

export interface SseFrame {
  /** `event:` field, or null when absent. */
  event: string | null;
  /** `data:` lines joined with `\n`. */
  data: string;
}

/** Splits an SSE byte stream into frames; comment-only and data-less frames are skipped. */
export async function* sseFrames(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | null = null;
  let data: string[] = [];
  let sawData = false;

  function* line(raw: string): Generator<SseFrame> {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (l === "") {
      if (sawData) yield { event, data: data.join("\n") };
      event = null;
      data = [];
      sawData = false;
      return;
    }
    if (l.startsWith(":")) return;
    const colon = l.indexOf(":");
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? "" : l.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") {
      data.push(value);
      sawData = true;
    }
  }

  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      yield* line(raw);
      idx = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  if (buf.length) yield* line(buf);
  yield* line("");
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

interface PendingCall {
  itemId: string | undefined;
  callId: string | undefined;
  name: string | undefined;
  args: string;
  emitted: boolean;
}

/** Parsed JSON when valid, else the raw string (validated later with zod by the agent). */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw === "" ? "{}" : raw);
  } catch {
    return raw;
  }
}

/**
 * Stateful accumulator for one streamed response. Feed every frame to `push`; call `finish`
 * after the stream ended.
 */
export class ResponsesStreamParser {
  private text = "";
  private readonly calls: PendingCall[] = [];
  private readonly items: unknown[] = [];
  private finalOutput: unknown[] | null = null;
  private usage: ModelUsage | null = null;
  private status: "completed" | "incomplete" | null = null;
  private incompleteReason: string | null = null;
  private responseId: string | undefined;
  private refused = false;

  constructor(
    private readonly model: string,
    private readonly opts: { op?: string } = {},
  ) {}

  /** Events to emit for one frame; throws `AiProviderError` on `error` / `response.failed`. */
  push(frame: SseFrame): ChatStreamEvent[] {
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      if (frame.data.trim() === "[DONE]") return [];
      return [];
    }
    if (!isObj(payload)) return [];
    const type = str(payload.type) ?? frame.event ?? "";
    switch (type) {
      case "response.created":
      case "response.in_progress":
        this.readResponseMeta(payload.response);
        return [];
      case "response.output_text.delta": {
        const delta = str(payload.delta) ?? "";
        if (!delta) return [];
        this.text += delta;
        return [{ type: "text_delta", delta }];
      }
      case "response.refusal.delta":
      case "response.refusal.done":
        this.refused = true;
        return [];
      case "response.output_item.added": {
        const item = payload.item;
        if (isObj(item) && item.type === "function_call") this.callFor(item);
        return [];
      }
      case "response.function_call_arguments.delta": {
        const call = this.callByItemId(str(payload.item_id));
        if (call) call.args += str(payload.delta) ?? "";
        return [];
      }
      case "response.function_call_arguments.done": {
        const call = this.callByItemId(str(payload.item_id));
        if (call) {
          const args = str(payload.arguments);
          if (args !== undefined) call.args = args;
          call.name ??= str(payload.name) || undefined;
        }
        return [];
      }
      case "response.output_item.done": {
        const item = payload.item;
        if (!isObj(item)) return [];
        this.items.push(item);
        if (item.type !== "function_call") return [];
        const call = this.callFor(item);
        const args = str(item.arguments);
        if (args !== undefined) call.args = args;
        return this.emit(call);
      }
      case "response.completed":
      case "response.incomplete": {
        const response = isObj(payload.response) ? payload.response : {};
        this.readResponseMeta(response);
        this.status = type === "response.completed" ? "completed" : "incomplete";
        if (str(response.status) === "incomplete") this.status = "incomplete";
        if (isObj(response.incomplete_details)) {
          this.incompleteReason = str(response.incomplete_details.reason) ?? null;
        }
        if (isObj(response.usage)) this.usage = openAiUsage(response.usage, this.model, "standard");
        if (Array.isArray(response.output)) {
          this.finalOutput = response.output;
          const out: ChatStreamEvent[] = [];
          for (const item of response.output) {
            if (isObj(item) && item.type === "function_call") {
              const call = this.callFor(item);
              const args = str(item.arguments);
              if (args !== undefined && !call.emitted) call.args = args;
              out.push(...this.emit(call));
            }
          }
          return out;
        }
        return [];
      }
      case "response.failed": {
        const response = isObj(payload.response) ? payload.response : {};
        const err = isObj(response.error) ? response.error : {};
        throw new AiProviderError(
          "openai",
          this.opts.op ?? "responses.stream",
          200,
          safeCode(err.code, "") || safeCode(err.type, "") || "response_failed",
          false,
        );
      }
      case "error": {
        const err = isObj(payload.error) ? payload.error : payload;
        const code = safeCode(err.code, "") || safeCode(err.type, "") || "stream_error";
        throw new AiProviderError(
          "openai",
          this.opts.op ?? "responses.stream",
          200,
          code,
          /rate_limit|server_error|overloaded/.test(code),
        );
      }
      default:
        return [];
    }
  }

  /** Final completion; throws when the stream ended without `response.completed/incomplete`. */
  finish(latencyMs: number): ChatCompletion {
    if (this.status === null) {
      throw new AiProviderError(
        "openai",
        this.opts.op ?? "responses.stream",
        200,
        "stream_truncated",
        true,
      );
    }
    const toolCalls: ChatToolCall[] = this.calls
      .filter((c) => c.emitted)
      .map((c) => this.toToolCall(c));
    let finishReason: ChatFinishReason = "stop";
    if (this.status === "incomplete") {
      finishReason =
        this.incompleteReason === "content_filter" ? "content_filter" : ("length" as const);
    } else if (this.refused && !this.text) {
      finishReason = "content_filter";
    } else if (toolCalls.length > 0) {
      finishReason = "tool_calls";
    }
    const completion: ChatCompletion = {
      model: this.model,
      text: this.text,
      toolCalls,
      finishReason,
      usage: this.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
      latencyMs,
      providerItems: this.finalOutput ?? this.items,
    };
    if (this.responseId) completion.responseId = this.responseId;
    return completion;
  }

  private readResponseMeta(response: unknown): void {
    if (isObj(response)) this.responseId ??= str(response.id);
  }

  private callByItemId(itemId: string | undefined): PendingCall | undefined {
    return itemId === undefined ? undefined : this.calls.find((c) => c.itemId === itemId);
  }

  /** Finds (by item id, then call id) or registers the pending call of a `function_call` item. */
  private callFor(item: Obj): PendingCall {
    const itemId = str(item.id);
    const callId = str(item.call_id);
    let call =
      (itemId !== undefined ? this.calls.find((c) => c.itemId === itemId) : undefined) ??
      (callId !== undefined ? this.calls.find((c) => c.callId === callId) : undefined);
    if (!call) {
      call = { itemId, callId, name: undefined, args: "", emitted: false };
      this.calls.push(call);
    }
    call.itemId ??= itemId;
    call.callId ??= callId;
    const name = str(item.name);
    if (name) call.name = name;
    return call;
  }

  private emit(call: PendingCall): ChatStreamEvent[] {
    if (call.emitted) return [];
    if (!call.callId || !call.name) {
      throw new AiProviderError(
        "openai",
        this.opts.op ?? "responses.stream",
        200,
        "malformed_function_call",
        false,
      );
    }
    call.emitted = true;
    return [{ type: "tool_call", toolCall: this.toToolCall(call) }];
  }

  private toToolCall(call: PendingCall): ChatToolCall {
    return {
      id: call.callId as string,
      name: call.name as string,
      arguments: parseArguments(call.args),
    };
  }
}
