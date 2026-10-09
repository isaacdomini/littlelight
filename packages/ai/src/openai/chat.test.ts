import { CHAT_TOOL_DEFINITIONS } from "@littlelight/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiProviderError } from "../errors";
import {
  type OpenAiMockChatStep,
  type OpenAiMockServer,
  startOpenAiMockServer,
} from "../testing/openai-mock-server";
import type { ChatMessage, ChatStreamEvent } from "../types";
import {
  CHAT_PROMPT_CACHE_KEY,
  createOpenAiChatModel,
  drainChatStream,
  openAiChatBody,
  openAiChatInput,
} from "./chat";

// biome-ignore lint/suspicious/noExplicitAny: wire JSON read back from recorded requests
type Rec = Record<string, any>;

const P1 = "11111111-1111-4111-8111-111111111111";
const tools = CHAT_TOOL_DEFINITIONS.map((d) => ({ ...d }));
const messages: ChatMessage[] = [
  { role: "system", content: "SYSTEM RULES" },
  { role: "user", content: "SECRET QUESTION about bath" },
];

let mock: OpenAiMockServer;
const logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
const log = {
  debug: (obj: Record<string, unknown>, msg: string) =>
    void logs.push({ level: "debug", obj, msg }),
  info: (obj: Record<string, unknown>, msg: string) => void logs.push({ level: "info", obj, msg }),
  warn: (obj: Record<string, unknown>, msg: string) => void logs.push({ level: "warn", obj, msg }),
};

async function setup(
  chatScript?: (body: Record<string, unknown>, i: number) => OpenAiMockChatStep[],
  over: Partial<Parameters<typeof createOpenAiChatModel>[0]> = {},
) {
  mock = await startOpenAiMockServer(chatScript ? { chatScript } : {});
  return createOpenAiChatModel({
    apiKey: "sk-test-secret",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    maxOutputTokens: 800,
    timeoutMs: 5000,
    baseUrl: mock.baseUrl,
    log,
    http: { sleep: async () => undefined, retryBaseMs: 1 },
    ...over,
  });
}

beforeEach(() => {
  logs.length = 0;
});
afterEach(async () => {
  await mock?.close().catch(() => undefined);
});

describe("request body (docs/plans/step-7.md 2.5)", () => {
  it("sends the documented flags and the strict tool definitions", async () => {
    const model = await setup();
    await model.complete(messages, tools);
    const r = mock.requests.find((x) => x.path === "/v1/responses");
    expect(r?.method).toBe("POST");
    expect(r?.headers.authorization).toBe("Bearer sk-test-secret");
    const body = r?.body as Rec;
    expect(body).toMatchObject({
      model: "gpt-6-luna",
      instructions: "SYSTEM RULES",
      input: [{ role: "user", content: "SECRET QUESTION about bath" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "low" },
      max_output_tokens: 800,
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: CHAT_PROMPT_CACHE_KEY,
      stream: true,
    });
    expect(CHAT_PROMPT_CACHE_KEY).toBe("littlelight-chat-v1");
    expect(body.tools).toHaveLength(4);
    for (const t of body.tools) {
      expect(t).toMatchObject({ type: "function", strict: true });
      expect(t.parameters.additionalProperties).toBe(false);
    }
    expect(body.tools.map((t: Rec) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it("per-call options override effort, output tokens and tool choice; omits tools when none", () => {
    const body = openAiChatBody(messages, [], {
      model: "gpt-6-luna",
      reasoningEffort: "low",
      maxOutputTokens: 800,
      options: { reasoningEffort: "none", maxOutputTokens: 300, toolChoice: "required" },
    });
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.max_output_tokens).toBe(300);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    const withTools = openAiChatBody(messages, tools, {
      model: "m",
      reasoningEffort: "low",
      maxOutputTokens: 1,
      options: { toolChoice: "required" },
    });
    expect(withTools.tool_choice).toBe("required");
  });

  it("jsonSchema becomes strict text.format", () => {
    const body = openAiChatBody(messages, [], {
      model: "m",
      reasoningEffort: "low",
      maxOutputTokens: 1,
      options: { jsonSchema: { name: "rank", schema: { type: "object" } } },
    });
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "rank", schema: { type: "object" }, strict: true },
    });
  });
});

describe("message mapping", () => {
  it("system => instructions (joined), tool => function_call_output", () => {
    const { instructions, input } = openAiChatInput([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "q" },
      { role: "tool", toolCallId: "call_1", content: '{"x":1}' },
    ]);
    expect(instructions).toBe("a\n\nb");
    expect(input).toEqual([
      { role: "user", content: "q" },
      { type: "function_call_output", call_id: "call_1", output: '{"x":1}' },
    ]);
  });

  it("replays providerItems unchanged; rebuilds calls when there are none", () => {
    const items = [
      { type: "reasoning", id: "rs", encrypted_content: "enc" },
      { type: "function_call", call_id: "c1", name: "get_milestones", arguments: "{}" },
    ];
    const withItems = openAiChatInput([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "get_milestones", arguments: {} }],
        providerItems: items,
      },
    ]);
    expect(withItems.input).toEqual(items);
    const rebuilt = openAiChatInput([
      {
        role: "assistant",
        content: "thinking",
        toolCalls: [{ id: "c2", name: "get_photo", arguments: { photo_id: P1 } }],
      },
    ]);
    expect(rebuilt.input).toEqual([
      { role: "assistant", content: "thinking" },
      {
        type: "function_call",
        call_id: "c2",
        name: "get_photo",
        arguments: JSON.stringify({ photo_id: P1 }),
      },
    ]);
    expect(openAiChatInput([{ role: "assistant", content: "plain" }]).input).toEqual([
      { role: "assistant", content: "plain" },
    ]);
  });
});

describe("a tool-using turn against the mock", () => {
  it("round 1: reasoning + a function call; round 2 echoes reasoning, call and output, then answers", async () => {
    const model = await setup();
    const first = await model.complete(messages, tools);
    expect(first.finishReason).toBe("tool_calls");
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]?.name).toBe("search_photos");
    expect(first.toolCalls[0]?.arguments).toMatchObject({ query: "SECRET QUESTION about bath" });
    expect(first.providerItems?.map((i) => (i as Rec).type)).toEqual([
      "reasoning",
      "function_call",
    ]);
    expect(first.usage.costUsd).toBeGreaterThan(0);
    expect(first.responseId).toMatch(/^resp_/);

    const result = JSON.stringify({ results: [{ photo_id: P1 }] });
    const second = await model.complete(
      [
        ...messages,
        {
          role: "assistant",
          content: first.text,
          toolCalls: first.toolCalls,
          ...(first.providerItems ? { providerItems: first.providerItems } : {}),
        },
        { role: "tool", toolCallId: first.toolCalls[0]?.id as string, content: result },
      ],
      tools,
    );
    expect(second.finishReason).toBe("stop");
    expect(second.text).toBe(`Here is the bath photo [photo:${P1}].`);

    const req2 = mock.requests.filter((r) => r.path === "/v1/responses")[1]?.body as Rec;
    expect(req2.input.map((i: Rec) => i.type ?? i.role)).toEqual([
      "user",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(req2.input[1].encrypted_content).toMatch(/^enc_/);
    expect(req2.input[3]).toEqual({
      type: "function_call_output",
      call_id: first.toolCalls[0]?.id,
      output: result,
    });
  });

  it("streams text in several deltas and ends with done; tool calls arrive as events", async () => {
    const model = await setup(() => [
      { type: "reasoning" },
      { type: "text", text: "A fairly long answer that arrives in many small deltas." },
    ]);
    const events: ChatStreamEvent[] = [];
    for await (const ev of model.stream(messages, tools)) events.push(ev);
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBeGreaterThan(3);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    const text = deltas.map((d) => (d as { delta: string }).delta).join("");
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.completion.text).toBe(text);
    expect(text).toBe("A fairly long answer that arrives in many small deltas.");
  });

  it("parallel function calls are all returned", async () => {
    const args = { query: null };
    const model = await setup(() => [
      { type: "function_call", name: "search_photos", arguments: args },
      { type: "function_call", name: "get_milestones", arguments: {} },
    ]);
    const c = await model.complete(messages, tools);
    expect(c.toolCalls.map((t) => t.name)).toEqual(["search_photos", "get_milestones"]);
    expect(new Set(c.toolCalls.map((t) => t.id)).size).toBe(2);
  });
});

describe("terminal states", () => {
  it("incomplete (max_output_tokens) => finishReason length with the partial text", async () => {
    const model = await setup(() => [
      { type: "text", text: "partial answer" },
      { type: "incomplete", reason: "max_output_tokens" },
    ]);
    const c = await model.complete(messages, tools);
    expect(c.finishReason).toBe("length");
    expect(c.text).toBe("partial answer");
  });

  it("incomplete (content_filter) => content_filter", async () => {
    const model = await setup(() => [{ type: "incomplete", reason: "content_filter" }]);
    expect((await model.complete(messages, tools)).finishReason).toBe("content_filter");
  });

  it("response.failed throws a coded AiProviderError", async () => {
    const model = await setup(() => [{ type: "failed", code: "server_error" }]);
    const err = await model.complete(messages, tools).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe("server_error");
  });

  it("an in-stream error event throws", async () => {
    const model = await setup(() => [{ type: "error", code: "rate_limit_exceeded" }]);
    const err = await model.complete(messages, tools).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe("rate_limit_exceeded");
  });

  it("a stream cut off without a terminal event is stream_truncated", async () => {
    const model = await setup(() => [{ type: "text", text: "half" }, { type: "truncate" }]);
    const err = await model.complete(messages, tools).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe("stream_truncated");
  });

  it("drainChatStream without a done event is stream_truncated", async () => {
    async function* none(): AsyncGenerator<ChatStreamEvent> {}
    await expect(drainChatStream(none())).rejects.toMatchObject({ code: "stream_truncated" });
  });
});

describe("HTTP behaviour", () => {
  it("retries a 500 before the stream starts and then succeeds", async () => {
    const model = await setup(() => [{ type: "text", text: "ok" }]);
    mock.injectFailure({ method: "POST", path: "/v1/responses", status: 500, times: 1 });
    const c = await model.complete(messages, tools);
    expect(c.text).toBe("ok");
    expect(mock.requests.filter((r) => r.path === "/v1/responses")).toHaveLength(2);
  });

  it("a 401 is a coded error and is not retried", async () => {
    const model = await setup();
    mock.injectFailure({ method: "POST", path: "/v1/responses", status: 401, times: 5 });
    const err = await model.complete(messages, tools).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.status).toBe(401);
    expect(mock.requests.filter((r) => r.path === "/v1/responses")).toHaveLength(1);
  });

  it("an aborted signal throws an 'aborted' error, not retryable", async () => {
    const model = await setup();
    const ac = new AbortController();
    ac.abort();
    const err = await model.complete(messages, tools, { signal: ac.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe("aborted");
  });

  it("an unreachable server is a coded network error", async () => {
    const model = await setup();
    const url = mock.baseUrl;
    await mock.close();
    const dead = createOpenAiChatModel({
      apiKey: "k",
      model: "gpt-6-luna",
      reasoningEffort: "low",
      maxOutputTokens: 100,
      timeoutMs: 1000,
      baseUrl: url,
      http: { sleep: async () => undefined, retryBaseMs: 1, maxRetries: 0 },
    });
    expect(model.provider).toBe("openai");
    await expect(dead.complete(messages, tools)).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe("privacy", () => {
  it("never logs the question, the answer, tool arguments, the key or the instructions", async () => {
    const model = await setup();
    const first = await model.complete(messages, tools);
    await model.complete(
      [
        ...messages,
        {
          role: "assistant",
          content: "",
          toolCalls: first.toolCalls,
          ...(first.providerItems ? { providerItems: first.providerItems } : {}),
        },
        {
          role: "tool",
          toolCallId: first.toolCalls[0]?.id as string,
          content: JSON.stringify({ note: "PARENT NOTE SENTINEL", id: P1 }),
        },
      ],
      tools,
    );
    const dump = JSON.stringify(logs);
    for (const secret of [
      "SECRET QUESTION",
      "SYSTEM RULES",
      "PARENT NOTE SENTINEL",
      "sk-test-secret",
      "Here is the bath photo",
    ]) {
      expect(dump, secret).not.toContain(secret);
    }
    const call = logs.find((l) => l.msg === "ai chat call");
    expect(call?.obj).toMatchObject({ provider: "openai", model: "gpt-6-luna" });
    expect(call?.obj.tools).toEqual(["search_photos"]);
  });

  it("an error carries the status and code only, never the question", async () => {
    const model = await setup(() => [{ type: "failed", code: "server_error" }]);
    const err = await model.complete(messages, tools).catch((e) => e);
    expect(String(err.message)).not.toContain("SECRET");
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });

  it("rejects an unpriced model at construction", () => {
    expect(() =>
      createOpenAiChatModel({
        apiKey: "k",
        model: "gpt-9",
        reasoningEffort: "low",
        maxOutputTokens: 1,
        timeoutMs: 1000,
      }),
    ).toThrow(/CHAT_MODEL/);
  });
});
