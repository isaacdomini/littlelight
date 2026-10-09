import {
  type ChatCompletion,
  type ChatMessage,
  type ChatModel,
  type ChatStreamEvent,
  createFakeChatModel,
  type FakeChatScript,
} from "@littlelight/ai";
import { CHAT_MESSAGES, type ChatToolName } from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentEvent,
  type AgentInput,
  interleave,
  isFindPhotosRequest,
  runChatTurn,
} from "./agent";
import { type ToolOutcome, toolError } from "./tools";

const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const M1 = "33333333-3333-4333-8333-333333333333";

const SYSTEM =
  "Baby's name: Maya\nBirth date: 2025-07-01\nAge today: 15 months\nToday: 2026-10-09\nUser's units: metric";

const input = (text: string, over: Partial<AgentInput> = {}): AgentInput => ({
  systemPrompt: SYSTEM,
  history: [],
  userText: text,
  maxRounds: 4,
  maxOutputTokens: 800,
  timeoutMs: 5000,
  ...over,
});

/** A search outcome the way `runTool` builds it. */
function searchOutcome(
  ids: string[],
  confidence: Partial<NonNullable<ToolOutcome["searchConfidence"]>> = {},
): ToolOutcome {
  return {
    searchConfidence: {
      results: ids.length,
      filtersOnly: false,
      lexical: true,
      topSimilarity: 0.9,
      ...confidence,
    },
    content: JSON.stringify({
      results: ids.map((id) => ({ photo_id: id, caption: "c" })),
      candidates: ids.length,
      truncated: false,
      unknown_milestones: [],
    }),
    photoIds: ids,
    measurementIds: [],
    searchPhotoIds: ids,
    hasData: ids.length > 0,
  };
}

function measurementOutcome(): ToolOutcome {
  return {
    content: JSON.stringify({
      measurements: [
        {
          measurement_id: M1,
          kind: "weight",
          value: "7.20 kg",
          value_metric: 7200,
          measured_at: "2026-01-01",
          age: "6 months",
          photo_id: P(1),
        },
      ],
      truncated: false,
    }),
    photoIds: [P(1)],
    measurementIds: [M1],
    searchPhotoIds: null,
    hasData: true,
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  const final = events.at(-1);
  if (final?.type !== "final") throw new Error("no final event");
  return { events, result: final.result };
}

const fake = (script?: FakeChatScript) =>
  createFakeChatModel({ delayMs: 0, env: {}, ...(script ? { script } : {}) });

describe("runChatTurn with the fake chat model", () => {
  it("event order: status thinking, status searching, photos, deltas, final; the text has no markers", async () => {
    const execute = vi.fn(async () => searchOutcome([P(1), P(2)]));
    const { events, result } = await collect(
      runChatTurn({ chat: fake(), executeTool: execute }, input("Photos with Grandma")),
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("status");
    expect(events[0]).toEqual({ type: "status", stage: "thinking" });
    expect(events[1]).toEqual({ type: "status", stage: "searching", tool: "search_photos" });
    expect(events[2]).toEqual({ type: "photos", photoIds: [P(1), P(2)] });
    expect(types.slice(3, -1).every((t) => t === "delta")).toBe(true);
    expect(types.at(-1)).toBe("final");
    const streamed = events
      .filter((e): e is Extract<AgentEvent, { type: "delta" }> => e.type === "delta")
      .map((e) => e.text)
      .join("");
    expect(streamed).toBe(result.text);
    expect(result.text).toBe("Here are 2 photos that match.");
    expect(result.text).not.toMatch(/\[photo:/);
    expect(result.citations.photoIds).toEqual([P(1), P(2)]);
    expect(result.photoIds).toEqual([P(1), P(2)]);
    expect(result.grounded).toBe(true);
    expect(result.status).toBe("complete");
    expect(result.toolsUsed).toEqual(["search_photos"]);
    expect(result.usage.calls).toBe(2);
    expect(result.citationsDropped).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("validates arguments before executing: the plan reaches the tool as parsed args", async () => {
    const execute = vi.fn(async (_n: ChatToolName, _a: unknown) => searchOutcome([P(1)]));
    await collect(
      runChatTurn(
        { chat: fake(), executeTool: execute },
        input("photos with Aunt Lily at the beach in July"),
      ),
    );
    expect(execute).toHaveBeenCalledWith(
      "search_photos",
      expect.objectContaining({
        query: "beach",
        people: ["Aunt Lily"],
        date_from: expect.stringMatching(/^\d{4}-07-01$/),
      }),
    );
  });

  it("parallel calls: a comparison runs one search per age; photos event sent once", async () => {
    const execute = vi.fn(async () => searchOutcome([P(1)]));
    const { events, result } = await collect(
      runChatTurn({ chat: fake(), executeTool: execute }, input("show her at 1, 6 and 12 months")),
    );
    expect(execute).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === "photos")).toHaveLength(1);
    expect(result.toolsUsed).toEqual(["search_photos"]);
    // the same id from three searches is cited once
    expect(result.citations.photoIds).toEqual([P(1)]);
  });

  it("cite_unknown: the invented id is dropped and counted, valid ids stay", async () => {
    const { result } = await collect(
      runChatTurn(
        { chat: fake("cite_unknown"), executeTool: async () => searchOutcome([P(1)]) },
        input("Photos with Grandma"),
      ),
    );
    expect(result.citations.photoIds).toEqual([P(1)]);
    expect(result.citationsDropped).toBe(1);
    expect(result.text).not.toMatch(/\[photo:/);
    expect(result.photoIds).toEqual([P(1)]);
  });

  it("bad_args: an invalid call is answered with invalid_arguments and never executed; the turn completes", async () => {
    const execute = vi.fn(async () => searchOutcome([P(1)]));
    const seen: ChatMessage[][] = [];
    const base = fake("bad_args");
    const spy: ChatModel = {
      provider: base.provider,
      model: base.model,
      complete: base.complete,
      stream(messages, tools, options) {
        seen.push(structuredClone(messages));
        return base.stream(messages, tools, options);
      },
    };
    const log = { info: vi.fn(), warn: vi.fn() };
    const { result } = await collect(
      runChatTurn({ chat: spy, executeTool: execute, log }, input("Photos with Grandma")),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("complete");
    expect(result.text).toBe(CHAT_MESSAGES.nothingFound);
    const second = seen[1] ?? [];
    const tool = second.find((m) => m.role === "tool");
    expect(JSON.parse((tool as { content: string }).content)).toEqual({
      error: "invalid_arguments",
      issues: ["limit"],
    });
    // the log line carries the tool name and the error code, not the arguments
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("999");
  });

  it("no_cite with data: grounded false, the grid falls back to the last search (max 12)", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => P(i + 1));
    const { result } = await collect(
      runChatTurn(
        { chat: fake("no_cite"), executeTool: async () => searchOutcome(ids) },
        input("Photos with Grandma"),
      ),
    );
    expect(result.grounded).toBe(false);
    expect(result.citations.photoIds).toEqual([]);
    expect(result.photoIds).toEqual(ids.slice(0, 12));
    expect(result.status).toBe("complete");
  });

  it("nothing found: the fixed answer, grounded (nothing to cite), empty grid", async () => {
    const { events, result } = await collect(
      runChatTurn(
        { chat: fake(), executeTool: async () => searchOutcome([]) },
        input("Photos with Grandma"),
      ),
    );
    expect(result.text).toBe(CHAT_MESSAGES.nothingFound);
    expect(result.grounded).toBe(true);
    expect(result.photoIds).toEqual([]);
    expect(events.some((e) => e.type === "photos")).toBe(false);
  });

  it("measurements: both the measurement and its linked photo are cited and kept", async () => {
    const { result } = await collect(
      runChatTurn(
        { chat: fake(), executeTool: async () => measurementOutcome() },
        input("What was her weight at 6 months?"),
      ),
    );
    expect(result.toolsUsed).toEqual(["get_measurements"]);
    expect(result.citations).toEqual({ photoIds: [P(1)], measurementIds: [M1] });
    expect(result.photoIds).toEqual([P(1)]);
    expect(result.text).toBe("Weight 7.20 kg on 2026-01-01 (6 months).");
  });

  it("a tool that throws becomes status error with the fixed answer; nothing is cited", async () => {
    const warn = vi.fn();
    const { result } = await collect(
      runChatTurn(
        {
          chat: fake(),
          executeTool: async () => {
            throw Object.assign(new Error("SECRET-SQL-TEXT parent note"), { code: "XX000" });
          },
          log: { info: vi.fn(), warn },
        },
        input("Photos with Grandma"),
      ),
    );
    expect(result.status).toBe("error");
    expect(result.text).toBe(CHAT_MESSAGES.failed);
    expect(result.grounded).toBe(false);
    expect(result.citations).toEqual({ photoIds: [], measurementIds: [] });
    expect(result.photoIds).toEqual([]);
    expect(result.finishReason).toBe("error");
    // the log carries an error name/code only, never the message
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
  });

  it("a model failure becomes status error", async () => {
    const broken: ChatModel = {
      provider: "fake",
      model: "gpt-6-luna",
      complete: async () => {
        throw new Error("x");
      },
      // biome-ignore lint/correctness/useYield: throws before yielding
      async *stream() {
        throw Object.assign(new Error("boom"), { status: 500, code: "server_error" });
      },
    };
    const { result } = await collect(
      runChatTurn({ chat: broken, executeTool: async () => searchOutcome([]) }, input("hello")),
    );
    expect(result.status).toBe("error");
    expect(result.text).toBe(CHAT_MESSAGES.failed);
  });

  it("a stream that ends without a completion is an error turn", async () => {
    const odd: ChatModel = {
      provider: "fake",
      model: "m",
      complete: async () => ({}) as ChatCompletion,
      async *stream(): AsyncGenerator<ChatStreamEvent> {
        yield { type: "text_delta", delta: "hi" };
      },
    };
    const { result } = await collect(
      runChatTurn({ chat: odd, executeTool: async () => searchOutcome([]) }, input("hello")),
    );
    expect(result.status).toBe("error");
  });

  it("history is passed as text-only messages between the system prompt and the new question", async () => {
    const seen: ChatMessage[][] = [];
    const base = fake();
    const spy: ChatModel = {
      ...base,
      stream(messages, tools, options) {
        seen.push(structuredClone(messages));
        return base.stream(messages, tools, options);
      },
    };
    await collect(
      runChatTurn(
        { chat: spy, executeTool: async () => searchOutcome([]) },
        input("Photos with Grandma", {
          history: [
            { role: "user", content: "earlier question" },
            { role: "assistant", content: "earlier answer" },
          ],
        }),
      ),
    );
    expect((seen[0] ?? []).map((m) => [m.role, "content" in m ? m.content : ""])).toEqual([
      ["system", SYSTEM],
      ["user", "earlier question"],
      ["assistant", "earlier answer"],
      ["user", "Photos with Grandma"],
    ]);
  });

  it("the second round echoes the provider items and tool call ids back", async () => {
    const seen: ChatMessage[][] = [];
    const base = fake();
    const spy: ChatModel = {
      ...base,
      stream(messages, tools, options) {
        seen.push(structuredClone(messages));
        return base.stream(messages, tools, options);
      },
    };
    await collect(
      runChatTurn(
        { chat: spy, executeTool: async () => searchOutcome([P(1)]) },
        input("Photos with Grandma"),
      ),
    );
    const assistant = (seen[1] ?? []).find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({ toolCalls: [{ name: "search_photos" }] });
    expect((assistant as { providerItems?: unknown[] }).providerItems).toBeDefined();
    const tool = (seen[1] ?? []).find((m) => m.role === "tool") as { toolCallId: string };
    expect(tool.toolCallId).toBe((assistant as { toolCalls: { id: string }[] }).toolCalls[0]?.id);
  });
});

describe("runChatTurn: round cap and odd model behaviour", () => {
  const usage = {
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    costUsd: 0.001,
  };
  function greedy(name = "search_photos"): ChatModel {
    let n = 0;
    const completion = (): ChatCompletion => ({
      model: "gpt-6-luna",
      text: "",
      toolCalls: [{ id: `call_${n}`, name, arguments: {} }],
      finishReason: "tool_calls",
      usage,
      latencyMs: 1,
    });
    return {
      provider: "fake",
      model: "gpt-6-luna",
      complete: async () => completion(),
      async *stream() {
        n++;
        const c = completion();
        for (const toolCall of c.toolCalls) yield { type: "tool_call", toolCall };
        yield { type: "done", completion: c };
      },
    };
  }

  it("stops after maxRounds and says the question is too broad; usage covers every call", async () => {
    const execute = vi.fn(async () => searchOutcome([P(1)]));
    const { result } = await collect(
      runChatTurn(
        { chat: greedy("get_milestones"), executeTool: execute },
        input("x", { maxRounds: 3 }),
      ),
    );
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.usage.calls).toBe(3);
    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.reasoningTokens).toBe(15);
    expect(result.usage.costUsd).toBeCloseTo(0.003, 10);
    expect(result.text).toContain(CHAT_MESSAGES.tooBroad);
    expect(result.status).toBe("complete");
  });

  it("an unknown tool name is answered with unknown_tool and never executed", async () => {
    const execute = vi.fn(async () => searchOutcome([]));
    const { result } = await collect(
      runChatTurn(
        { chat: greedy("drop_tables"), executeTool: execute },
        input("x", { maxRounds: 2 }),
      ),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolsUsed).toEqual([]);
  });

  it("a tool's own error outcome (not_found) is data for the model, not a failed turn", async () => {
    const { result } = await collect(
      runChatTurn(
        { chat: fake(), executeTool: async () => toolError("not_found") },
        input(`tell me about photo ${P(7)}`),
      ),
    );
    expect(result.status).toBe("complete");
    expect(result.text).toBe(CHAT_MESSAGES.nothingFound);
  });

  it("the answer is capped at 8000 characters and never empty", async () => {
    const long: ChatModel = {
      provider: "fake",
      model: "m",
      complete: async () => ({}) as ChatCompletion,
      async *stream() {
        yield { type: "text_delta", delta: "a".repeat(9000) };
        yield {
          type: "done",
          completion: {
            model: "m",
            text: "a".repeat(9000),
            toolCalls: [],
            finishReason: "stop",
            usage,
            latencyMs: 1,
          },
        };
      },
    };
    const { result } = await collect(
      runChatTurn({ chat: long, executeTool: async () => searchOutcome([]) }, input("x")),
    );
    expect(result.text).toHaveLength(8000);
  });

  it("logs counts only: no question, no answer, no ids", async () => {
    const info = vi.fn();
    await collect(
      runChatTurn(
        {
          chat: fake(),
          executeTool: async () => searchOutcome([P(1)]),
          log: { info, warn: vi.fn() },
        },
        input("SECRET-QUESTION about the bath"),
      ),
    );
    const dump = JSON.stringify(info.mock.calls);
    expect(dump).not.toContain("SECRET-QUESTION");
    expect(dump).not.toContain(P(1));
    expect(dump).toContain("chat turn");
  });
});

describe("isFindPhotosRequest", () => {
  it.each([
    "Show first steps",
    "Photos with Grandma",
    "beach in July",
    "show me the kite",
    "  show her at 1, 6 and 12 months  ",
    "bath time",
    "Aunt Lily at the beach",
    "pictures from last summer",
  ])("%s asks for photos", (text) => {
    expect(isFindPhotosRequest(text)).toBe(true);
  });

  it.each([
    "What happened in month 3?",
    "when did she first smile",
    "How tall was she at 12 months?",
    "Did she walk before the party?",
    "Which photos have Dad?",
    "Who is in the bath photo",
    "Is there a photo of the beach",
    "Tell me about her first birthday",
    "Describe the park photo",
    "Summarize June",
    "Compare month 1 and month 6",
    "Explain this photo",
    "List the milestones",
    "Can you show the kite?",
    "WHAT is this",
  ])("%s needs a written answer", (text) => {
    expect(isFindPhotosRequest(text)).toBe(false);
  });

  it("a leading word that merely starts like a question word does not count", () => {
    expect(isFindPhotosRequest("Whatever the weather photos")).toBe(true);
    expect(isFindPhotosRequest("Whoopee cushion")).toBe(true);
    expect(isFindPhotosRequest("Dolls and toys")).toBe(true);
  });
});

describe("runChatTurn: find-photos fast path", () => {
  /** The fake model with a counter of model calls. */
  function counted(script?: FakeChatScript) {
    const inner = fake(script);
    const calls = { n: 0 };
    const model: ChatModel = {
      provider: inner.provider,
      model: inner.model,
      complete: inner.complete,
      stream(messages, tools, options) {
        calls.n++;
        return inner.stream(messages, tools, options);
      },
    };
    return { model, calls };
  }
  const withFast = (text: string, over: Partial<AgentInput> = {}) =>
    input(text, { fastPath: true, ...over });

  it("one model call; the server writes the answer and cites exactly the search results", async () => {
    const { model, calls } = counted();
    const info = vi.fn();
    const { events, result } = await collect(
      runChatTurn(
        {
          chat: model,
          executeTool: async () => searchOutcome([P(1), P(2), P(3)]),
          log: { info, warn: vi.fn() },
        },
        withFast("Photos with Grandma"),
      ),
    );
    expect(calls.n).toBe(1);
    expect(result.usage.calls).toBe(1);
    expect(result.text).toBe("Here are 3 photos that match.");
    expect(result.citations.photoIds).toEqual([P(1), P(2), P(3)]);
    expect(result.photoIds).toEqual([P(1), P(2), P(3)]);
    expect(result.grounded).toBe(true);
    expect(result.finishReason).toBe("fast_path");
    expect(result.text).not.toMatch(/\[photo:/);
    // the stream: status, status, photos, delta(s), final
    expect(events.map((e) => e.type)).toEqual(["status", "status", "photos", "delta", "final"]);
    const turn = info.mock.calls.find((c) => c[1] === "chat turn")?.[0];
    expect(turn).toMatchObject({ fastPath: true, calls: 1, finishReason: "fast_path" });
  });

  it("exactly one photo gets the singular sentence", async () => {
    const { result } = await collect(
      runChatTurn(
        { chat: counted().model, executeTool: async () => searchOutcome([P(1)]) },
        withFast("Show first steps"),
      ),
    );
    expect(result.text).toBe("Here is 1 photo that matches.");
  });

  it("several searches in one turn get the group sentence and one citation per distinct photo", async () => {
    const outcomes = [
      searchOutcome([P(1), P(2)]),
      searchOutcome([P(2), P(3)]),
      searchOutcome([P(4)]),
    ];
    let i = 0;
    const { calls, model } = counted();
    const { result } = await collect(
      runChatTurn(
        { chat: model, executeTool: async () => outcomes[i++] as ToolOutcome },
        withFast("show her at 1, 6 and 12 months"),
      ),
    );
    expect(calls.n).toBe(1);
    expect(result.text).toBe("Here are 4 photos for the times you asked about.");
    // round-robin: the best photo of every period comes first
    expect(result.citations.photoIds).toEqual([P(1), P(2), P(4), P(3)]);
  });

  it("empty results give nothingFound, ungrounded-free and with no photos, still one call", async () => {
    const { calls, model } = counted();
    const { events, result } = await collect(
      runChatTurn(
        { chat: model, executeTool: async () => searchOutcome([]) },
        withFast("Photos with Grandma"),
      ),
    );
    expect(calls.n).toBe(1);
    expect(result.text).toBe(CHAT_MESSAGES.nothingFound);
    expect(result.citations.photoIds).toEqual([]);
    expect(result.photoIds).toEqual([]);
    expect(result.grounded).toBe(true);
    expect(events.some((e) => e.type === "photos")).toBe(false);
  });

  it("cites at most 50 photos", async () => {
    const ids = Array.from({ length: 80 }, (_, i) => P(i + 1));
    const { result } = await collect(
      runChatTurn(
        { chat: counted().model, executeTool: async () => searchOutcome(ids) },
        withFast("Photos with Grandma"),
      ),
    );
    expect(result.citations.photoIds).toHaveLength(50);
    expect(result.text).toBe("Here are 50 photos that match.");
  });

  it.each(["What happened in month 3?", "Which photos have Grandma?", "Tell me about the beach"])(
    "%s keeps two model calls and the model-written answer",
    async (text) => {
      const { calls, model } = counted();
      const { result } = await collect(
        runChatTurn(
          { chat: model, executeTool: async () => searchOutcome([P(1)]) },
          withFast(text),
        ),
      );
      expect(calls.n).toBe(2);
      expect(result.usage.calls).toBe(2);
      expect(result.finishReason).toBe("stop");
    },
  );

  it("is off unless asked for: the default keeps two calls", async () => {
    const { calls, model } = counted();
    await collect(
      runChatTurn(
        { chat: model, executeTool: async () => searchOutcome([P(1)]) },
        input("Photos with Grandma"),
      ),
    );
    expect(calls.n).toBe(2);
    const off = counted();
    await collect(
      runChatTurn(
        { chat: off.model, executeTool: async () => searchOutcome([P(1)]) },
        input("Photos with Grandma", { fastPath: false }),
      ),
    );
    expect(off.calls.n).toBe(2);
  });

  it("only for search_photos: measurement and milestone tools keep the written answer", async () => {
    const { calls, model } = counted();
    await collect(
      runChatTurn(
        { chat: model, executeTool: async () => measurementOutcome() },
        withFast("what did she weigh at 6 months?"),
      ),
    );
    expect(calls.n).toBe(2);
    const second = counted();
    const { result } = await collect(
      runChatTurn(
        { chat: second.model, executeTool: async () => measurementOutcome() },
        withFast("her weight in June"),
      ),
    );
    expect(second.calls.n).toBe(2);
    expect(result.finishReason).toBe("stop");
  });

  it("a model that wrote text next to its tool call is not short-circuited", async () => {
    let n = 0;
    const talkative: ChatModel = {
      provider: "fake",
      model: "m",
      complete: async () => ({}) as ChatCompletion,
      async *stream() {
        n++;
        const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 0 };
        if (n === 1) {
          const toolCall = {
            id: "c1",
            name: "search_photos",
            arguments: {
              query: null,
              date_from: null,
              date_to: null,
              age_from_days: null,
              age_to_days: null,
              milestones: [],
              people: [],
              tags: [],
              limit: null,
            },
          };
          yield { type: "text_delta", delta: "Let me look. " };
          yield { type: "tool_call", toolCall };
          yield {
            type: "done",
            completion: {
              model: "m",
              text: "Let me look. ",
              toolCalls: [toolCall],
              finishReason: "tool_calls",
              usage,
              latencyMs: 1,
            },
          };
        } else {
          yield { type: "text_delta", delta: `Found it. [photo:${P(1)}]` };
          yield {
            type: "done",
            completion: {
              model: "m",
              text: `Found it. [photo:${P(1)}]`,
              toolCalls: [],
              finishReason: "stop",
              usage,
              latencyMs: 1,
            },
          };
        }
      },
    };
    const { result } = await collect(
      runChatTurn(
        { chat: talkative, executeTool: async () => searchOutcome([P(1)]) },
        withFast("Photos with Grandma"),
      ),
    );
    expect(n).toBe(2);
    expect(result.text).toBe("Let me look. Found it.");
    expect(result.finishReason).toBe("stop");
  });

  it("an invalid search call (bad_args) still goes through the model, not the fast path", async () => {
    const { calls, model } = counted("bad_args");
    const execute = vi.fn(async () => searchOutcome([P(1)]));
    const { result } = await collect(
      runChatTurn({ chat: model, executeTool: execute }, withFast("Photos with Grandma")),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(calls.n).toBe(2);
    expect(result.finishReason).toBe("stop");
  });

  it("a tool failure is still an error turn", async () => {
    const { result } = await collect(
      runChatTurn(
        {
          chat: counted().model,
          executeTool: async () => {
            throw new Error("db down");
          },
        },
        withFast("Photos with Grandma"),
      ),
    );
    expect(result.status).toBe("error");
    expect(result.text).toBe(CHAT_MESSAGES.failed);
  });
});

describe("runChatTurn: a cited measurement brings its linked photo", () => {
  /** Answers a get_measurements call by citing only the measurement. */
  function citesMeasurementOnly(): ChatModel {
    let n = 0;
    return {
      provider: "fake",
      model: "m",
      complete: async () => ({}) as ChatCompletion,
      async *stream() {
        n++;
        const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 0.001 };
        if (n === 1) {
          const toolCall = {
            id: "c1",
            name: "get_measurements",
            arguments: { kind: null, date_from: null, date_to: null },
          };
          yield { type: "tool_call", toolCall };
          yield {
            type: "done",
            completion: {
              model: "m",
              text: "",
              toolCalls: [toolCall],
              finishReason: "tool_calls",
              usage,
              latencyMs: 1,
            },
          };
        } else {
          const text = `She weighed 7.2 kg. [measurement:${M1}]`;
          yield { type: "text_delta", delta: text };
          yield {
            type: "done",
            completion: {
              model: "m",
              text,
              toolCalls: [],
              finishReason: "stop",
              usage,
              latencyMs: 1,
            },
          };
        }
      },
    };
  }

  it("the photo joins the grid and the citations even though the model did not cite it", async () => {
    const { result } = await collect(
      runChatTurn(
        {
          chat: citesMeasurementOnly(),
          executeTool: async () => ({ ...measurementOutcome(), measurementPhotos: { [M1]: P(1) } }),
        },
        input("What did she weigh?"),
      ),
    );
    expect(result.citations).toEqual({ photoIds: [P(1)], measurementIds: [M1] });
    expect(result.photoIds).toEqual([P(1)]);
    expect(result.grounded).toBe(true);
  });

  it("a measurement without a linked photo adds none; an unknown measurement adds nothing", async () => {
    const none = await collect(
      runChatTurn(
        {
          chat: citesMeasurementOnly(),
          executeTool: async () => ({
            ...measurementOutcome(),
            photoIds: [],
            measurementPhotos: {},
          }),
        },
        input("What did she weigh?"),
      ),
    );
    expect(none.result.citations).toEqual({ photoIds: [], measurementIds: [M1] });
    expect(none.result.photoIds).toEqual([]);
    // the model cites a measurement no tool returned: dropped, and its "linked photo" never appears
    const other = await collect(
      runChatTurn(
        {
          chat: citesMeasurementOnly(),
          executeTool: async () => ({
            ...measurementOutcome(),
            measurementIds: [],
            measurementPhotos: { [M1]: P(9) },
          }),
        },
        input("What did she weigh?"),
      ),
    );
    expect(other.result.citations.measurementIds).toEqual([]);
    expect(other.result.citations.photoIds).toEqual([]);
    expect(other.result.citationsDropped).toBe(1);
  });

  it("an already cited photo is not duplicated; the photo is appended after cited ones", async () => {
    const both: ChatModel = {
      provider: "fake",
      model: "m",
      complete: async () => ({}) as ChatCompletion,
      async *stream(messages) {
        const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 0 };
        if (!messages.some((m) => m.role === "tool")) {
          const toolCall = {
            id: "c1",
            name: "get_measurements",
            arguments: { kind: null, date_from: null, date_to: null },
          };
          yield { type: "tool_call", toolCall };
          yield {
            type: "done",
            completion: {
              model: "m",
              text: "",
              toolCalls: [toolCall],
              finishReason: "tool_calls",
              usage,
              latencyMs: 1,
            },
          };
          return;
        }
        const text = `[measurement:${M1}] [photo:${P(1)}] [photo:${P(5)}]`;
        yield { type: "text_delta", delta: text };
        yield {
          type: "done",
          completion: {
            model: "m",
            text,
            toolCalls: [],
            finishReason: "stop",
            usage,
            latencyMs: 1,
          },
        };
      },
    };
    const { result } = await collect(
      runChatTurn(
        {
          chat: both,
          executeTool: async () => ({
            ...measurementOutcome(),
            photoIds: [P(1), P(5)],
            measurementPhotos: { [M1]: P(1) },
          }),
        },
        input("What did she weigh?"),
      ),
    );
    expect(result.citations.photoIds).toEqual([P(1), P(5)]);
  });
});

describe("interleave", () => {
  it("round-robins the groups, best of each first, duplicates once", () => {
    expect(interleave([["a", "b", "c"], ["d"], ["e", "f"]])).toEqual([
      "a",
      "d",
      "e",
      "b",
      "f",
      "c",
    ]);
    expect(
      interleave([
        ["a", "b"],
        ["b", "c"],
      ]),
    ).toEqual(["a", "b", "c"]);
  });
  it("handles empty input", () => {
    expect(interleave([])).toEqual([]);
    expect(interleave([[], []])).toEqual([]);
  });
});

describe("runChatTurn: fast-path confidence", () => {
  const fastModel = () => {
    const inner = createFakeChatModel({ delayMs: 0, env: {} });
    const calls = { n: 0 };
    const model: ChatModel = {
      provider: inner.provider,
      model: inner.model,
      complete: inner.complete,
      stream(m, t, o) {
        calls.n++;
        return inner.stream(m, t, o);
      },
    };
    return { model, calls };
  };
  const go = (
    conf: Partial<NonNullable<ToolOutcome["searchConfidence"]>>,
    over: Partial<AgentInput> = {},
  ) => {
    const { model, calls } = fastModel();
    const info = vi.fn();
    return collect(
      runChatTurn(
        {
          chat: model,
          executeTool: async () => searchOutcome([P(1)], conf),
          log: { info, warn: vi.fn() },
        },
        input("Photos with Grandma", { fastPath: true, ...over }),
      ),
    ).then((r) => ({ ...r, calls, info }));
  };

  it("a lexical match, a filter-only search and a strong vector similarity are confident", async () => {
    for (const conf of [
      { lexical: true, topSimilarity: 0.1 },
      { lexical: false, filtersOnly: true, topSimilarity: null },
      { lexical: false, topSimilarity: 0.38 },
    ]) {
      const r = await go(conf);
      expect(r.calls.n, JSON.stringify(conf)).toBe(1);
      expect(r.result.finishReason).toBe("fast_path");
    }
  });

  it("weak vector-only results go to the model (two calls) and the decline is logged", async () => {
    const r = await go({ lexical: false, topSimilarity: 0.37 });
    expect(r.calls.n).toBe(2);
    expect(r.result.finishReason).toBe("stop");
    const turn = r.info.mock.calls.find((c) => c[1] === "chat turn")?.[0];
    expect(turn).toMatchObject({ fastPath: false, fastPathDeclined: "weak_results" });
    // no similarity at all counts as weak
    expect((await go({ lexical: false, topSimilarity: null })).calls.n).toBe(2);
  });

  it("the threshold is configurable per turn", async () => {
    expect(
      (await go({ lexical: false, topSimilarity: 0.5 }, { fastPathMinSimilarity: 0.6 })).calls.n,
    ).toBe(2);
    expect(
      (await go({ lexical: false, topSimilarity: 0.5 }, { fastPathMinSimilarity: 0.4 })).calls.n,
    ).toBe(1);
  });

  it("empty results are confident (nothing found is said without a second call)", async () => {
    const { model, calls } = fastModel();
    const r = await collect(
      runChatTurn(
        {
          chat: model,
          executeTool: async () =>
            searchOutcome([], { results: 0, lexical: false, topSimilarity: null }),
        },
        input("Photos with Grandma", { fastPath: true }),
      ),
    );
    expect(calls.n).toBe(1);
    expect(r.result.text).toBe(CHAT_MESSAGES.nothingFound);
  });

  it("an outcome without confidence data (older tool) never short-circuits", async () => {
    const { model, calls } = fastModel();
    const bare = { ...searchOutcome([P(1)]) } as ToolOutcome;
    delete bare.searchConfidence;
    await collect(
      runChatTurn(
        { chat: model, executeTool: async () => bare },
        input("Photos with Grandma", { fastPath: true }),
      ),
    );
    expect(calls.n).toBe(2);
  });
});

describe("runChatTurn: weak results are never shown on their own", () => {
  const WEAK = { lexical: false, topSimilarity: 0.2 };

  it("no early photos event and no fallback grid for weak vector-only results", async () => {
    const { events, result } = await collect(
      runChatTurn(
        { chat: fake("no_cite"), executeTool: async () => searchOutcome([P(1), P(2)], WEAK) },
        input("Photos with Grandma", { fastPath: true }),
      ),
    );
    expect(events.some((e) => e.type === "photos")).toBe(false);
    expect(result.photoIds).toEqual([]);
    expect(result.citations.photoIds).toEqual([]);
    expect(result.usage.calls).toBe(2);
  });

  it("the same weak results with a lexical match are shown at once", async () => {
    const { events, result } = await collect(
      runChatTurn(
        {
          chat: fake("no_cite"),
          executeTool: async () => searchOutcome([P(1)], { lexical: true, topSimilarity: 0.2 }),
        },
        input("What is on the photos?", { fastPath: true }),
      ),
    );
    expect(events.some((e) => e.type === "photos")).toBe(true);
    expect(result.photoIds).toEqual([P(1)]);
  });

  it("a weak result still reaches the user when the model cites it", async () => {
    const { events, result } = await collect(
      runChatTurn(
        { chat: fake(), executeTool: async () => searchOutcome([P(1)], WEAK) },
        input("Photos with Grandma", { fastPath: true }),
      ),
    );
    expect(events.some((e) => e.type === "photos")).toBe(false);
    expect(result.citations.photoIds).toEqual([P(1)]);
    expect(result.photoIds).toEqual([P(1)]);
  });

  it("a round is confident only if every search in it is: one weak search declines the fast path", async () => {
    const outcomes = [searchOutcome([P(1)]), searchOutcome([P(2)], WEAK)];
    let i = 0;
    const info = vi.fn();
    const { result } = await collect(
      runChatTurn(
        {
          chat: fake(),
          executeTool: async () => outcomes[i++] as ToolOutcome,
          log: { info, warn: vi.fn() },
        },
        input("show her at 1 and 6 months", { fastPath: true }),
      ),
    );
    expect(result.finishReason).toBe("stop");
    expect(info.mock.calls.find((c) => c[1] === "chat turn")?.[0]).toMatchObject({
      fastPath: false,
      fastPathDeclined: "weak_results",
    });
  });

  it("the threshold boundary: 0.38 is confident, 0.379 is not (default threshold)", async () => {
    const run = async (sim: number) => {
      const info = vi.fn();
      const r = await collect(
        runChatTurn(
          {
            chat: fake(),
            executeTool: async () => searchOutcome([P(1)], { lexical: false, topSimilarity: sim }),
            log: { info, warn: vi.fn() },
          },
          input("Photos with Grandma", { fastPath: true }),
        ),
      );
      return { r, info };
    };
    expect((await run(0.38)).r.result.finishReason).toBe("fast_path");
    const weak = await run(0.379);
    expect(weak.r.result.finishReason).toBe("stop");
    expect(weak.info.mock.calls.find((c) => c[1] === "chat turn")?.[0]).toMatchObject({
      fastPathDeclined: "weak_results",
    });
  });

  it("a fast-path turn does not log a decline", async () => {
    const info = vi.fn();
    await collect(
      runChatTurn(
        {
          chat: fake(),
          executeTool: async () => searchOutcome([P(1)]),
          log: { info, warn: vi.fn() },
        },
        input("Photos with Grandma", { fastPath: true }),
      ),
    );
    const turn = info.mock.calls.find((c) => c[1] === "chat turn")?.[0] as Record<string, unknown>;
    expect(turn.fastPath).toBe(true);
    expect(turn.fastPathDeclined ?? null).toBeNull();
  });
});

describe("runChatTurn: multi-search grids interleave", () => {
  it("a model-written answer over several searches shows the best photo of each first", async () => {
    const outcomes = [searchOutcome([P(1), P(2)]), searchOutcome([P(3), P(4)])];
    let i = 0;
    const { events, result } = await collect(
      runChatTurn(
        { chat: fake("no_cite"), executeTool: async () => outcomes[i++] as ToolOutcome },
        input("What do the photos at 1 and 6 months show?"),
      ),
    );
    const early = events.find((e) => e.type === "photos") as { photoIds: string[] } | undefined;
    expect(early?.photoIds).toEqual([P(1), P(3), P(2), P(4)]);
    expect(result.photoIds).toEqual([P(1), P(3), P(2), P(4)]);
  });
});

describe("runChatTurn: per-search log lines", () => {
  const searchLog = (n: number) => ({
    tool: "search_photos",
    set: ["query", "date_from"],
    ageWindow: null,
    windowWidened: true,
    windowRetry: false,
    relaxed: false,
    unknownMilestones: 0,
    lexical: n,
    candidates: 10,
    results: n,
  });

  it("emits one 'chat tool search_photos' line per search and a searches array on the turn", async () => {
    const outcomes = [
      { ...searchOutcome([P(1)]), searchLog: searchLog(1) },
      { ...searchOutcome([P(2), P(3)]), searchLog: searchLog(2) },
    ];
    let i = 0;
    const info = vi.fn();
    await collect(
      runChatTurn(
        {
          chat: fake(),
          executeTool: async () => outcomes[i++] as ToolOutcome,
          log: { info, warn: vi.fn() },
        },
        input("show her at 1 and 6 months", { fastPath: true }),
      ),
    );
    const lines = info.mock.calls
      .filter((c) => c[1] === "chat tool search_photos")
      .map((c) => c[0]);
    expect(lines).toEqual([searchLog(1), searchLog(2)]);
    const turn = info.mock.calls.find((c) => c[1] === "chat turn")?.[0] as { searches: unknown[] };
    expect(turn.searches).toEqual([searchLog(1), searchLog(2)]);
  });

  it("other tools and rejected calls log no search line; the searches array is then empty", async () => {
    const info = vi.fn();
    await collect(
      runChatTurn(
        {
          chat: fake(),
          executeTool: async () => measurementOutcome(),
          log: { info, warn: vi.fn() },
        },
        input("What did she weigh at 6 months?"),
      ),
    );
    expect(info.mock.calls.some((c) => c[1] === "chat tool search_photos")).toBe(false);
    const turn = info.mock.calls.find((c) => c[1] === "chat turn")?.[0] as { searches: unknown[] };
    expect(turn.searches).toEqual([]);
  });
});
