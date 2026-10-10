import { CHAT_MESSAGES, CHAT_TOOL_DEFINITIONS, parseChatToolArguments } from "@tinyglow/shared";
import { describe, expect, it } from "vitest";
import { AiNotConfiguredError } from "../errors";
import { CHAT_SYSTEM_PROMPT_V1 } from "../prompts/chat-v1";
import type { ChatMessage, ChatToolCall } from "../types";
import {
  composeFakeAnswer,
  createFakeChatModel,
  FAKE_CHAT_USAGE,
  type FakeChatScript,
  planFakeToolCalls,
} from "./chat";

const CTX = { today: "2026-10-09", birthDate: "2025-07-01" };
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const M1 = "33333333-3333-4333-8333-333333333333";
const SYSTEM = CHAT_SYSTEM_PROMPT_V1({
  babyName: "Maya",
  nickname: null,
  birthDate: CTX.birthDate,
  today: CTX.today,
  units: "metric",
});
const tools = CHAT_TOOL_DEFINITIONS.map((d) => ({ ...d }));

const NULLS = {
  query: null,
  date_from: null,
  date_to: null,
  age_from_days: null,
  age_to_days: null,
  milestones: [],
  people: [],
  tags: [],
  limit: null,
};
const search = (patch: object) => ({ name: "search_photos", arguments: { ...NULLS, ...patch } });

describe("planFakeToolCalls (question => tool arguments)", () => {
  const table: [string, object[]][] = [
    ["Show first steps", [search({ milestones: ["First steps"] })]],
    ["Photos with Grandma", [search({ people: ["Grandma"] })]],
    [
      "What was her weight at 6 months?",
      [
        {
          name: "get_measurements",
          arguments: { kind: "weight", date_from: "2025-12-11", date_to: "2026-01-20" },
        },
      ],
    ],
    ["What happened in month 3?", [search({ age_from_days: 61, age_to_days: 91 })]],
    [
      "show me her first steps at Riverside Park with Dad",
      [search({ query: "Riverside Park", milestones: ["First steps"], people: ["Dad"] })],
    ],
    [
      "photos with Aunt Lily at the beach in July",
      [
        search({
          query: "beach",
          date_from: "2026-07-01",
          date_to: "2026-07-31",
          people: ["Aunt Lily"],
        }),
      ],
    ],
    [
      "show her at 1, 6 and 12 months",
      [
        search({ age_from_days: 10, age_to_days: 50 }),
        search({ age_from_days: 163, age_to_days: 203 }),
        search({ age_from_days: 345, age_to_days: 385 }),
      ],
    ],
    ["pictures from last summer", [search({ date_from: "2026-06-01", date_to: "2026-08-31" })]],
  ];

  it.each(table)("%s", (question, expected) => {
    const planned = planFakeToolCalls(question, CTX);
    expect(planned).toEqual(expected);
    // every plan is valid for the strict argument parser
    for (const p of planned) expect(parseChatToolArguments(p.name, p.arguments).ok).toBe(true);
  });

  it("measurement words choose the kind; a date phrase becomes a range", () => {
    expect(planFakeToolCalls("how tall was she in March 2026", CTX)[0]).toEqual({
      name: "get_measurements",
      arguments: { kind: "height", date_from: "2026-03-01", date_to: "2026-03-31" },
    });
    expect(planFakeToolCalls("head circumference?", CTX)[0]?.arguments).toMatchObject({
      kind: "head",
      date_from: null,
    });
  });

  it("'when did' / milestone questions use get_milestones", () => {
    expect(planFakeToolCalls("when did she first smile", CTX)).toEqual([
      { name: "get_milestones", arguments: {} },
    ]);
  });

  it("a photo id selects get_photo (lower-cased)", () => {
    expect(planFakeToolCalls(`tell me about photo ${P1.toUpperCase()}`, CTX)).toEqual([
      { name: "get_photo", arguments: { photo_id: P1 } },
    ]);
  });

  it("#tags become tags, family words become people, 'with A, B and C' lists", () => {
    expect(planFakeToolCalls("bath #Splash", CTX)[0]?.arguments).toMatchObject({
      query: "bath",
      tags: ["splash"],
    });
    expect(planFakeToolCalls("pictures with Mom, Dad and Sam", CTX)[0]?.arguments).toMatchObject({
      people: ["Mom", "Dad", "Sam"],
    });
    expect(planFakeToolCalls("Grandma's garden", CTX)[0]?.arguments).toMatchObject({
      people: ["Grandma"],
      query: "garden",
    });
  });

  it("is deterministic and a no-signal text is a plain search with the words as query", () => {
    expect(planFakeToolCalls("yellow duck", CTX)).toEqual(planFakeToolCalls("yellow duck", CTX));
    expect(planFakeToolCalls("yellow duck", CTX)[0]?.arguments).toMatchObject({
      query: "yellow duck",
    });
  });

  it("the bad_args script makes the first search ask for limit 999 (invalid for the parser)", () => {
    const planned = planFakeToolCalls("show her at 1, 6 and 12 months", CTX, "bad_args");
    expect(planned[0]?.arguments).toMatchObject({ limit: 999 });
    expect(planned[1]?.arguments).toMatchObject({ limit: null });
    expect(parseChatToolArguments("search_photos", planned[0]?.arguments).ok).toBe(false);
  });
});

describe("composeFakeAnswer", () => {
  const searchResult = JSON.stringify({
    results: [
      { photo_id: P1, caption: "a" },
      { photo_id: P2, caption: "b" },
    ],
    candidates: 2,
    truncated: false,
    unknown_milestones: [],
  });

  it("cites every returned photo id in rank order", () => {
    const text = composeFakeAnswer([{ name: "search_photos", content: searchResult }]);
    expect(text).toBe(`Here are 2 photos that match. [photo:${P1}] [photo:${P2}]`);
  });

  it("measurements cite the measurement and its linked photo", () => {
    const text = composeFakeAnswer([
      {
        name: "get_measurements",
        content: JSON.stringify({
          measurements: [
            {
              measurement_id: M1,
              kind: "weight",
              value: "7.20 kg",
              value_metric: 7200,
              measured_at: "2026-01-01",
              age: "6 months",
              photo_id: P1,
            },
          ],
          truncated: false,
        }),
      },
    ]);
    expect(text).toBe(`Weight 7.20 kg on 2026-01-01 (6 months). [measurement:${M1}] [photo:${P1}]`);
  });

  it("milestones cite the first photo of each", () => {
    const text = composeFakeAnswer([
      {
        name: "get_milestones",
        content: JSON.stringify({
          milestones: [
            {
              milestone_id: M1,
              name: "First steps",
              date: "2026-06-14",
              age: "11 months",
              photo_ids: [P1, P2],
            },
          ],
        }),
      },
    ]);
    expect(text).toBe(`First steps on 2026-06-14 (11 months). [photo:${P1}]`);
  });

  it("no data, tool errors and invalid JSON give the fixed 'nothing found' answer", () => {
    expect(composeFakeAnswer([])).toBe(CHAT_MESSAGES.nothingFound);
    expect(
      composeFakeAnswer([
        { name: "search_photos", content: JSON.stringify({ error: "not_found" }) },
      ]),
    ).toBe(CHAT_MESSAGES.nothingFound);
    expect(composeFakeAnswer([{ name: "search_photos", content: "{nope" }])).toBe(
      CHAT_MESSAGES.nothingFound,
    );
    expect(
      composeFakeAnswer([
        {
          name: "search_photos",
          content: JSON.stringify({
            results: [],
            candidates: 0,
            truncated: false,
            unknown_milestones: [],
          }),
        },
      ]),
    ).toBe(CHAT_MESSAGES.nothingFound);
  });

  it("cite=false omits markers", () => {
    expect(composeFakeAnswer([{ name: "search_photos", content: searchResult }], false)).toBe(
      "Here are 2 photos that match.",
    );
  });
});

describe("createFakeChatModel: a two-call turn", () => {
  const model = (script?: FakeChatScript) =>
    createFakeChatModel({ delayMs: 0, ...(script ? { script } : {}), env: {} });

  async function turn(text: string, m = model()) {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: text },
    ];
    const first = await m.complete(messages, tools);
    return { messages, first, m };
  }

  function withResults(
    messages: ChatMessage[],
    calls: ChatToolCall[],
    contents: string[],
  ): ChatMessage[] {
    return [
      ...messages,
      { role: "assistant", content: "", toolCalls: calls },
      ...calls.map((c, i) => ({
        role: "tool" as const,
        toolCallId: c.id,
        content: contents[i] ?? "{}",
      })),
    ];
  }

  it("round 1 plans parallel tool calls with unique ids; usage is fixed and priced", async () => {
    const { first } = await turn("show her at 1, 6 and 12 months");
    expect(first.finishReason).toBe("tool_calls");
    expect(first.toolCalls.map((c) => c.name)).toEqual(Array(3).fill("search_photos"));
    expect(new Set(first.toolCalls.map((c) => c.id)).size).toBe(3);
    expect(first.usage.inputTokens).toBe(FAKE_CHAT_USAGE.inputTokens);
    expect(first.usage.outputTokens).toBe(FAKE_CHAT_USAGE.outputTokens);
    expect(first.usage.costUsd).toBeGreaterThan(0);
    expect(first.text).toBe("");
  });

  it("round 2 answers from the tool results, citing exactly the returned ids; deltas concatenate to the text", async () => {
    const { messages, first, m } = await turn("Photos with Grandma");
    const result = JSON.stringify({
      results: [{ photo_id: P1 }],
      candidates: 1,
      truncated: false,
      unknown_milestones: [],
    });
    const events: string[] = [];
    let text = "";
    let completion: { text: string; finishReason: string } | undefined;
    for await (const ev of m.stream(withResults(messages, first.toolCalls, [result]), tools)) {
      events.push(ev.type);
      if (ev.type === "text_delta") text += ev.delta;
      if (ev.type === "done") completion = ev.completion;
    }
    expect(events).toEqual(["text_delta", "text_delta", "text_delta", "done"]);
    expect(text).toBe(`Here is 1 photo that matches. [photo:${P1}]`);
    expect(completion?.text).toBe(text);
    expect(completion?.finishReason).toBe("stop");
  });

  it("with no tools offered (or toolChoice none) it answers directly", async () => {
    const m = model();
    const r = await m.complete(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: "hi" },
      ],
      [],
    );
    expect(r.finishReason).toBe("stop");
    expect(r.text).toBe(CHAT_MESSAGES.nothingFound);
    const r2 = await m.complete(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: "hi" },
      ],
      tools,
      { toolChoice: "none" },
    );
    expect(r2.toolCalls).toEqual([]);
  });

  it("cite_unknown adds a citation no tool returned", async () => {
    const m = model("cite_unknown");
    const { messages, first } = await turn("Photos with Grandma", m);
    const result = JSON.stringify({
      results: [{ photo_id: P1 }],
      candidates: 1,
      truncated: false,
      unknown_milestones: [],
    });
    const done = await m.complete(withResults(messages, first.toolCalls, [result]), tools);
    const ids = [...done.text.matchAll(/\[photo:([0-9a-f-]{36})\]/g)].map((x) => x[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(P1);
    expect(ids[1]).not.toBe(P1);
  });

  it("no_cite answers without markers", async () => {
    const m = model("no_cite");
    const { messages, first } = await turn("Photos with Grandma", m);
    const result = JSON.stringify({
      results: [{ photo_id: P1 }],
      candidates: 1,
      truncated: false,
      unknown_milestones: [],
    });
    const done = await m.complete(withResults(messages, first.toolCalls, [result]), tools);
    expect(done.text).not.toContain("[photo:");
    expect(done.text).toContain("photo");
  });

  it("length stops early with finishReason length", async () => {
    const m = model("length");
    const { messages, first } = await turn("Photos with Grandma", m);
    const result = JSON.stringify({
      results: [{ photo_id: P1 }],
      candidates: 1,
      truncated: false,
      unknown_milestones: [],
    });
    const done = await m.complete(withResults(messages, first.toolCalls, [result]), tools);
    expect(done.finishReason).toBe("length");
    expect(done.text.length).toBeGreaterThan(0);
    expect(done.text.length).toBeLessThan(`Here is 1 photo that matches. [photo:${P1}]`.length);
  });

  it("bad_args: the first call carries limit 999", async () => {
    const m = model("bad_args");
    const { first } = await turn("Photos with Grandma", m);
    expect(first.toolCalls[0]?.arguments).toMatchObject({ limit: 999 });
  });

  it("structured output (re-rank) is an identity ranking of the uuids in the prompt", async () => {
    const m = model();
    const r = await m.complete(
      [{ role: "user", content: `rank ${P2} then ${P1} and ${P2} again` }],
      [],
      { jsonSchema: { name: "rank", schema: { properties: { ids: { type: "array" } } } } },
    );
    expect(JSON.parse(r.text)).toEqual({ ids: [P2, P1] });
  });

  it("reads Today and Birth date from the system prompt", async () => {
    const { first } = await turn("What was her weight at 6 months?");
    expect(first.toolCalls[0]?.arguments).toMatchObject({
      date_from: "2025-12-11",
      date_to: "2026-01-20",
    });
  });

  it("is refused in production unless opted in; unpriced models are rejected", () => {
    expect(() => createFakeChatModel({ env: { NODE_ENV: "production" } })).toThrow(
      AiNotConfiguredError,
    );
    expect(() =>
      createFakeChatModel({ env: { NODE_ENV: "production", AI_ALLOW_FAKE_IN_PRODUCTION: "true" } }),
    ).not.toThrow();
    expect(() => createFakeChatModel({ model: "gpt-9", env: {} })).toThrow(/CHAT_MODEL/);
  });

  it("logs the call without text", async () => {
    const lines: Record<string, unknown>[] = [];
    const m = createFakeChatModel({
      delayMs: 0,
      env: {},
      log: { info: (o) => void lines.push(o), warn: (o) => void lines.push(o) },
    });
    await m.complete(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: "secret question about Maya" },
      ],
      tools,
    );
    expect(JSON.stringify(lines)).not.toMatch(/secret|Maya/);
    expect(lines[0]).toMatchObject({ provider: "fake", op: "chat" });
  });
});
