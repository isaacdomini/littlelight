import { describe, expect, it } from "vitest";
import { AiProviderError } from "../errors";
import { ResponsesStreamParser, type SseFrame, sseFrames } from "./sse";

const enc = new TextEncoder();

async function collect(chunks: (string | Uint8Array)[]): Promise<SseFrame[]> {
  async function* gen() {
    for (const c of chunks) yield typeof c === "string" ? enc.encode(c) : c;
  }
  const out: SseFrame[] = [];
  for await (const f of sseFrames(gen())) out.push(f);
  return out;
}

describe("sseFrames", () => {
  it("splits frames and joins multi-line data with \\n", async () => {
    const frames = await collect(["event: a\ndata: 1\n\n", "data: x\ndata: y\n\n"]);
    expect(frames).toEqual([
      { event: "a", data: "1" },
      { event: null, data: "x\ny" },
    ]);
  });

  it("handles a frame split in the middle of a line, and of a field name", async () => {
    const text = 'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n';
    for (let cut = 1; cut < text.length; cut += 3) {
      const frames = await collect([text.slice(0, cut), text.slice(cut)]);
      expect(frames, `cut ${cut}`).toEqual([
        { event: "response.output_text.delta", data: '{"delta":"hi"}' },
      ]);
    }
  });

  it("decodes UTF-8 characters split across chunks", async () => {
    const bytes = enc.encode('data: {"t":"é👶"}\n\n');
    const frames: SseFrame[] = [];
    // one byte per chunk
    async function* gen() {
      for (const b of bytes) yield Uint8Array.of(b);
    }
    for await (const f of sseFrames(gen())) frames.push(f);
    expect(frames).toEqual([{ event: null, data: '{"t":"é👶"}' }]);
  });

  it("tolerates CRLF, comments and a single optional space after the colon", async () => {
    const frames = await collect([": keepalive\r\n\r\nevent:e\r\ndata:no-space\r\n\r\n"]);
    expect(frames).toEqual([{ event: "e", data: "no-space" }]);
  });

  it("skips frames without data and flushes a final frame without a trailing blank line", async () => {
    expect(await collect(["event: only-event\n\n"])).toEqual([]);
    expect(await collect(["data: last"])).toEqual([{ event: null, data: "last" }]);
  });

  it("an empty stream yields nothing", async () => {
    expect(await collect([])).toEqual([]);
  });
});

const frame = (data: unknown, event: string | null = null): SseFrame => ({
  event,
  data: typeof data === "string" ? data : JSON.stringify(data),
});

describe("ResponsesStreamParser", () => {
  const usage = {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 5 },
  };

  it("accumulates text deltas and completes with usage and provider items", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    const evs = [
      ...p.push(frame({ type: "response.created", response: { id: "resp_1" } })),
      ...p.push(frame({ type: "response.output_text.delta", delta: "Hel" })),
      ...p.push(frame({ type: "response.output_text.delta", delta: "lo" })),
      ...p.push(frame({ type: "response.output_text.delta", delta: "" })),
      ...p.push(
        frame({
          type: "response.completed",
          response: {
            status: "completed",
            usage,
            output: [
              { type: "reasoning", id: "rs", encrypted_content: "enc" },
              { type: "message" },
            ],
          },
        }),
      ),
    ];
    expect(evs).toEqual([
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
    ]);
    const c = p.finish(12);
    expect(c).toMatchObject({
      text: "Hello",
      finishReason: "stop",
      toolCalls: [],
      responseId: "resp_1",
      latencyMs: 12,
      model: "gpt-6-luna",
    });
    expect(c.usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 });
    expect(c.usage.costUsd).toBeGreaterThan(0);
    expect(c.providerItems).toEqual([
      { type: "reasoning", id: "rs", encrypted_content: "enc" },
      { type: "message" },
    ]);
  });

  it("builds a function call from output_item.done even when argument deltas were missing", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    p.push(
      frame({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc1",
          call_id: "call_1",
          name: "search_photos",
          arguments: "",
        },
      }),
    );
    const evs = p.push(
      frame({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc1",
          call_id: "call_1",
          name: "search_photos",
          arguments: '{"query":"bath"}',
        },
      }),
    );
    expect(evs).toEqual([
      {
        type: "tool_call",
        toolCall: { id: "call_1", name: "search_photos", arguments: { query: "bath" } },
      },
    ]);
    p.push(
      frame({ type: "response.completed", response: { status: "completed", usage, output: [] } }),
    );
    const c = p.finish(1);
    expect(c.finishReason).toBe("tool_calls");
    expect(c.toolCalls).toHaveLength(1);
  });

  it("uses argument deltas as a fallback and emits each call once", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    p.push(
      frame({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc", call_id: "c", name: "get_milestones" },
      }),
    );
    p.push(frame({ type: "response.function_call_arguments.delta", item_id: "fc", delta: "{" }));
    p.push(frame({ type: "response.function_call_arguments.delta", item_id: "fc", delta: "}" }));
    const done = p.push(
      frame({
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc", call_id: "c", name: "get_milestones" },
      }),
    );
    expect(done).toHaveLength(1);
    expect((done[0] as { toolCall: { arguments: unknown } }).toolCall.arguments).toEqual({});
    // the completed event lists the same call: not emitted twice
    const again = p.push(
      frame({
        type: "response.completed",
        response: {
          status: "completed",
          usage,
          output: [
            {
              type: "function_call",
              id: "fc",
              call_id: "c",
              name: "get_milestones",
              arguments: "{}",
            },
          ],
        },
      }),
    );
    expect(again).toEqual([]);
  });

  it("a function call only present in response.completed is emitted before done", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    const evs = p.push(
      frame({
        type: "response.completed",
        response: {
          status: "completed",
          usage,
          output: [
            {
              type: "function_call",
              id: "fc",
              call_id: "c9",
              name: "get_photo",
              arguments: '{"photo_id":"x"}',
            },
          ],
        },
      }),
    );
    expect(evs).toHaveLength(1);
    expect(p.finish(1).toolCalls[0]).toEqual({
      id: "c9",
      name: "get_photo",
      arguments: { photo_id: "x" },
    });
  });

  it("keeps unparsable arguments as the raw string for the agent to reject", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    const evs = p.push(
      frame({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "f",
          call_id: "c",
          name: "search_photos",
          arguments: "{oops",
        },
      }),
    );
    expect((evs[0] as { toolCall: { arguments: unknown } }).toolCall.arguments).toBe("{oops");
  });

  it("empty arguments become {}", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    const evs = p.push(
      frame({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "f",
          call_id: "c",
          name: "get_milestones",
          arguments: "",
        },
      }),
    );
    expect((evs[0] as { toolCall: { arguments: unknown } }).toolCall.arguments).toEqual({});
  });

  it("a function_call item without call_id or name is a malformed_function_call error", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    expect(() =>
      p.push(
        frame({
          type: "response.output_item.done",
          item: { type: "function_call", id: "f", arguments: "{}" },
        }),
      ),
    ).toThrow(AiProviderError);
  });

  it("incomplete: max_output_tokens => length, content_filter => content_filter", () => {
    for (const [reason, expected] of [
      ["max_output_tokens", "length"],
      ["content_filter", "content_filter"],
    ] as const) {
      const p = new ResponsesStreamParser("gpt-6-luna");
      p.push(frame({ type: "response.output_text.delta", delta: "part" }));
      p.push(
        frame({
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason }, usage, output: [] },
        }),
      );
      const c = p.finish(1);
      expect(c.finishReason).toBe(expected);
      expect(c.text).toBe("part");
    }
  });

  it("a refusal without text is content_filter", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    p.push(frame({ type: "response.refusal.delta", delta: "no" }));
    p.push(
      frame({ type: "response.completed", response: { status: "completed", usage, output: [] } }),
    );
    expect(p.finish(1).finishReason).toBe("content_filter");
  });

  it("response.failed and error events throw AiProviderError with a short code and no message", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    let err: unknown;
    try {
      p.push(
        frame({
          type: "response.failed",
          response: { error: { code: "server_error", message: "SECRET prompt text" } },
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).code).toBe("server_error");
    expect(String((err as Error).message)).not.toContain("SECRET");

    const p2 = new ResponsesStreamParser("gpt-6-luna");
    expect(() =>
      p2.push(frame({ type: "error", code: "rate_limit_exceeded", message: "SECRET" })),
    ).toThrow(/rate_limit_exceeded/);
    const p3 = new ResponsesStreamParser("gpt-6-luna");
    expect(() => p3.push(frame({ type: "error", error: { type: "overloaded" } }))).toThrow(
      AiProviderError,
    );
  });

  it("finish before any terminal event is stream_truncated", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    p.push(frame({ type: "response.output_text.delta", delta: "x" }));
    let err: unknown;
    try {
      p.finish(1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).code).toBe("stream_truncated");
  });

  it("ignores unknown event types, [DONE], invalid JSON and non-objects; uses the SSE event name when type is absent", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    expect(p.push(frame({ type: "response.something_new" }))).toEqual([]);
    expect(p.push(frame("[DONE]"))).toEqual([]);
    expect(p.push(frame("{not json"))).toEqual([]);
    expect(p.push(frame("[1,2]"))).toEqual([]);
    expect(p.push(frame({ delta: "named" }, "response.output_text.delta"))).toEqual([
      { type: "text_delta", delta: "named" },
    ]);
  });

  it("missing usage yields zero usage rather than a crash", () => {
    const p = new ResponsesStreamParser("gpt-6-luna");
    p.push(frame({ type: "response.completed", response: { status: "completed", output: [] } }));
    expect(p.finish(1).usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });
});
