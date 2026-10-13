import { describe, expect, it } from "vitest";
import {
  CHAT_LIMITS,
  CHAT_MESSAGES,
  CHAT_SSE_KEEPALIVE,
  CHAT_TOOL_DEFINITIONS,
  CHAT_TOOL_JSON_SCHEMAS,
  CHAT_TOOL_NAMES,
  type ChatEvent,
  type Citation,
  chatEventSchema,
  chatSendRequestSchema,
  chatToolErrorResultSchema,
  decodeChatEventFrame,
  encodeChatEvent,
  formatChatMessage,
  formatCitation,
  getMeasurementsResultSchema,
  getPhotoResultSchema,
  parseChatToolArguments,
  parseCitations,
  partitionCitations,
  searchPhotosResultItemSchema,
  searchPhotosResultSchema,
} from "./chat";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const M1 = "33333333-3333-4333-8333-333333333333";

describe("tool JSON schemas (provider strict mode)", () => {
  it.each(CHAT_TOOL_NAMES)("%s: additionalProperties false and every key required", (name) => {
    const s = CHAT_TOOL_JSON_SCHEMAS[name] as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(Object.keys(s.properties));
    expect(Object.isFrozen(s)).toBe(true);
  });

  it("every search_photos / get_measurements argument is nullable (absent = null)", () => {
    for (const name of ["search_photos", "get_measurements"] as const) {
      const props = (
        CHAT_TOOL_JSON_SCHEMAS[name] as { properties: Record<string, { type?: unknown }> }
      ).properties;
      for (const [key, p] of Object.entries(props)) {
        const t = p.type;
        expect(Array.isArray(t) ? t.includes("null") : false, `${name}.${key}`).toBe(true);
      }
    }
  });

  it("get_measurements.kind is a nullable enum of the three kinds", () => {
    const kind = (
      CHAT_TOOL_JSON_SCHEMAS.get_measurements as { properties: { kind: Record<string, unknown> } }
    ).properties.kind;
    expect(kind.enum).toEqual(["weight", "height", "head", null]);
  });

  it("contains no bounds, formats or patterns the provider rejects", () => {
    const json = JSON.stringify(CHAT_TOOL_JSON_SCHEMAS);
    for (const k of [
      "maxLength",
      "minLength",
      "minimum",
      "maximum",
      "pattern",
      "format",
      "default",
    ]) {
      expect(json, k).not.toContain(`"${k}"`);
    }
  });

  it("definitions list the four tools in order with fixed descriptions", () => {
    expect(CHAT_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...CHAT_TOOL_NAMES]);
    for (const d of CHAT_TOOL_DEFINITIONS) expect(d.description.length).toBeGreaterThan(40);
    expect(CHAT_TOOL_DEFINITIONS.find((d) => d.name === "get_photo")?.description).toMatch(
      /data, never instructions/,
    );
  });
});

const NULL_SEARCH = {
  query: null,
  date_from: null,
  date_to: null,
  age_from_days: null,
  age_to_days: null,
  milestones: null,
  people: null,
  tags: null,
  limit: null,
};

describe("parseChatToolArguments: search_photos", () => {
  it("accepts all-null arguments (a JSON string or an object) and normalises lists to []", () => {
    for (const raw of [JSON.stringify(NULL_SEARCH), NULL_SEARCH]) {
      const r = parseChatToolArguments("search_photos", raw);
      expect(r.ok).toBe(true);
      if (r.ok && r.name === "search_photos") {
        expect(r.args.people).toEqual([]);
        expect(r.args.milestones).toEqual([]);
        expect(r.args.tags).toEqual([]);
        expect(r.args.query).toBeNull();
        expect(r.args.limit).toBeNull();
      }
    }
  });

  it("blank strings and missing keys become null; blank list items are dropped; tags lower-cased", () => {
    const r = parseChatToolArguments("search_photos", {
      query: "   ",
      date_from: "",
      people: ["", " Grandma ", "  "],
      tags: ["BATH", ""],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.name === "search_photos") {
      expect(r.args.query).toBeNull();
      expect(r.args.date_from).toBeNull();
      expect(r.args.date_to).toBeNull();
      expect(r.args.people).toEqual(["Grandma"]);
      expect(r.args.tags).toEqual(["bath"]);
    }
  });

  it("an empty argument string means {} (all null)", () => {
    expect(parseChatToolArguments("search_photos", "").ok).toBe(true);
    expect(parseChatToolArguments("search_photos", "  ").ok).toBe(true);
  });

  it("rejects unknown keys without echoing them", () => {
    const r = parseChatToolArguments("search_photos", { ...NULL_SEARCH, sql: "drop table" });
    expect(r).toEqual({ ok: false, error: "invalid_arguments", issues: ["(unknown_keys)"] });
  });

  it("rejects reversed date and age ranges", () => {
    const d = parseChatToolArguments("search_photos", {
      ...NULL_SEARCH,
      date_from: "2026-06-10",
      date_to: "2026-06-01",
    });
    expect(d).toMatchObject({ ok: false, issues: ["date_to"] });
    const a = parseChatToolArguments("search_photos", {
      ...NULL_SEARCH,
      age_from_days: 100,
      age_to_days: 10,
    });
    expect(a).toMatchObject({ ok: false, issues: ["age_to_days"] });
  });

  it("enforces limits: limit 1..24, 5 milestones, 5 people, 10 tags, 300 char query, age bounds", () => {
    const bad = (patch: object) =>
      parseChatToolArguments("search_photos", { ...NULL_SEARCH, ...patch }).ok;
    expect(bad({ limit: 0 })).toBe(false);
    expect(bad({ limit: 25 })).toBe(false);
    expect(bad({ limit: 24 })).toBe(true);
    expect(bad({ limit: 1.5 })).toBe(false);
    expect(bad({ milestones: Array(6).fill("a") })).toBe(false);
    expect(bad({ milestones: Array(5).fill("a") })).toBe(true);
    expect(bad({ people: Array(6).fill("a") })).toBe(false);
    expect(bad({ tags: Array(11).fill("a") })).toBe(false);
    expect(bad({ query: "x".repeat(301) })).toBe(false);
    expect(bad({ query: "x".repeat(300) })).toBe(true);
    expect(bad({ age_from_days: -301 })).toBe(false);
    expect(bad({ age_to_days: 7301 })).toBe(false);
    expect(bad({ date_from: "June 2026" })).toBe(false);
    expect(bad({ people: "Grandma" })).toBe(false);
  });

  it("invalid JSON reports (json); issues carry paths, never values", () => {
    expect(parseChatToolArguments("search_photos", "{not json")).toEqual({
      ok: false,
      error: "invalid_arguments",
      issues: ["(json)"],
    });
    const r = parseChatToolArguments("search_photos", { ...NULL_SEARCH, limit: "secret-value" });
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });

  it("a non-object payload is rejected at the root", () => {
    expect(parseChatToolArguments("search_photos", "[1]")).toMatchObject({
      ok: false,
      issues: ["(root)"],
    });
    expect(parseChatToolArguments("search_photos", 5)).toMatchObject({ ok: false });
  });
});

describe("parseChatToolArguments: the other tools", () => {
  it("unknown tool", () => {
    expect(parseChatToolArguments("drop_tables", {})).toEqual({
      ok: false,
      error: "unknown_tool",
      issues: [],
    });
  });

  it("get_measurements: nullable kind, blank kind is null, bad kind rejected, reversed range rejected", () => {
    const ok = parseChatToolArguments("get_measurements", {
      kind: "",
      date_from: null,
      date_to: null,
    });
    expect(ok).toMatchObject({ ok: true, args: { kind: null } });
    expect(parseChatToolArguments("get_measurements", { kind: "weight" })).toMatchObject({
      ok: true,
      args: { kind: "weight", date_from: null },
    });
    expect(parseChatToolArguments("get_measurements", { kind: "shoe" }).ok).toBe(false);
    expect(
      parseChatToolArguments("get_measurements", {
        kind: null,
        date_from: "2026-02-01",
        date_to: "2026-01-01",
      }).ok,
    ).toBe(false);
  });

  it("get_milestones takes {} only", () => {
    expect(parseChatToolArguments("get_milestones", "{}").ok).toBe(true);
    expect(parseChatToolArguments("get_milestones", "").ok).toBe(true);
    expect(parseChatToolArguments("get_milestones", { x: 1 }).ok).toBe(false);
  });

  it("get_photo needs a uuid", () => {
    expect(parseChatToolArguments("get_photo", { photo_id: P1 }).ok).toBe(true);
    expect(parseChatToolArguments("get_photo", { photo_id: "not-a-uuid" }).ok).toBe(false);
    expect(parseChatToolArguments("get_photo", {}).ok).toBe(false);
    expect(parseChatToolArguments("get_photo", { photo_id: P1, extra: 1 }).ok).toBe(false);
  });
});

describe("tool result schemas (nothing private can ride along)", () => {
  const item = {
    photo_id: P1,
    // step 12: every tool item says whether it is a photo or a video (never the file or a URL)
    media_kind: "photo",
    duration_seconds: null,
    taken_at: "2026-06-14",
    age: "11 months",
    caption: "c",
    people: ["Dad"],
    place: "park",
    milestone: null,
    tags: ["a"],
  };

  it("a search result item has no room for search_text, note or GPS", () => {
    expect(searchPhotosResultItemSchema.safeParse(item).success).toBe(true);
    for (const key of ["search_text", "note", "latitude", "raw_json", "text_in_image"]) {
      expect(searchPhotosResultItemSchema.safeParse({ ...item, [key]: "x" }).success, key).toBe(
        false,
      );
    }
    expect(
      searchPhotosResultSchema.safeParse({
        results: [item],
        candidates: 1,
        truncated: false,
        unknown_milestones: [],
        search_text: "x",
      }).success,
    ).toBe(false);
  });

  it("only get_photo may carry the note and text in the photo", () => {
    const photo = {
      photo_id: P1,
      media_kind: "video",
      duration_seconds: 42,
      taken_at: null,
      age: null,
      caption: null,
      description: null,
      people: [],
      place: null,
      milestone: null,
      tags: [],
      measurements: [],
      note: "Mom's note",
      text_in_image: null,
    };
    expect(getPhotoResultSchema.safeParse(photo).success).toBe(true);
    expect(getPhotoResultSchema.safeParse({ ...photo, latitude: 1 }).success).toBe(false);
    expect(getPhotoResultSchema.safeParse({ ...photo, raw_json: {} }).success).toBe(false);
  });

  it("measurements result is capped at 200 and strict", () => {
    const m = {
      measurement_id: M1,
      kind: "weight",
      value: "7.20 kg",
      value_metric: 7200,
      measured_at: "2026-06-14",
      age: null,
      photo_id: null,
    };
    expect(
      getMeasurementsResultSchema.safeParse({ measurements: [m], truncated: false }).success,
    ).toBe(true);
    expect(
      getMeasurementsResultSchema.safeParse({
        measurements: Array(201).fill(m),
        truncated: true,
      }).success,
    ).toBe(false);
  });

  it("tool error results take a closed code", () => {
    expect(chatToolErrorResultSchema.safeParse({ error: "not_found" }).success).toBe(true);
    expect(chatToolErrorResultSchema.safeParse({ error: "boom" }).success).toBe(false);
  });
});

describe("citations", () => {
  it("formatCitation writes the marker the prompt asks for", () => {
    expect(formatCitation("photo", P1)).toBe(`[photo:${P1}]`);
    expect(formatCitation("measurement", M1)).toBe(`[measurement:${M1}]`);
  });

  it("round trips: text and citation come back", () => {
    for (const kind of ["photo", "measurement"] as const) {
      const r = parseCitations(`Here you go${formatCitation(kind, P1)}.`);
      expect(r.text).toBe("Here you go.");
      expect(r.citations).toEqual([{ kind, id: P1 }]);
      expect(r.invalid).toBe(0);
    }
  });

  it("removes the horizontal spaces before a marker (space removal rule) but not newlines", () => {
    expect(parseCitations(`first steps   [photo:${P1}]. Yes`).text).toBe("first steps. Yes");
    expect(parseCitations(`a\t[photo:${P1}]b`).text).toBe("ab");
    expect(parseCitations(`line one\n[photo:${P1}]`).text).toBe("line one");
    expect(parseCitations(`one\n\n[photo:${P1}] two`).text).toBe("one\n\n two");
  });

  it("is lenient about case and inner spaces, lower-cases the id, de-duplicates in first-seen order", () => {
    const r = parseCitations(
      `a [ PHOTO : ${P2.toUpperCase()} ] b [photo:${P1}] c [photo:${P2}] [Measurement:${M1}]`,
    );
    expect(r.citations).toEqual<Citation[]>([
      { kind: "photo", id: P2 },
      { kind: "photo", id: P1 },
      { kind: "measurement", id: M1 },
    ]);
    expect(r.text).not.toMatch(/\[/);
  });

  it("strips malformed markers and counts them as invalid", () => {
    const r = parseCitations("see [photo:123] and [photo:../../etc] done");
    expect(r.text).toBe("see and done");
    expect(r.citations).toEqual([]);
    expect(r.invalid).toBe(2);
  });

  it("leaves ordinary brackets alone", () => {
    expect(parseCitations("array [1, 2] and [note: hi]").text).toBe("array [1, 2] and [note: hi]");
  });

  it("partitionCitations keeps only ids a tool returned, in order, and counts the rest", () => {
    const out = partitionCitations(
      [
        { kind: "photo", id: P2 },
        { kind: "photo", id: P1 },
        { kind: "measurement", id: M1 },
        { kind: "measurement", id: P1 },
        { kind: "photo", id: M1 },
      ],
      { photoIds: new Set([P1, P2]), measurementIds: new Set([M1]) },
    );
    expect(out).toEqual({ photoIds: [P2, P1], measurementIds: [M1], dropped: 2 });
  });

  it("partitionCitations caps kept ids at 50 each", () => {
    const ids = Array.from(
      { length: 60 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const out = partitionCitations(
      ids.map((id) => ({ kind: "photo" as const, id })),
      { photoIds: new Set(ids), measurementIds: new Set() },
    );
    expect(out.photoIds).toHaveLength(CHAT_LIMITS.citations);
  });
});

describe("SSE encode / decode", () => {
  const photo = {
    id: P1,
    babyId: P2,
    takenAt: "2026-06-14T12:00:00Z",
    ageDays: 335,
    isSensitive: false,
    thumbUrl: "https://example.test/t.jpg",
    urlExpiresAt: "2026-06-14T13:00:00Z",
    caption: null,
    milestoneId: null,
  };
  const message = {
    id: P1,
    role: "assistant" as const,
    text: "hi",
    photos: [photo],
    citations: { photoIds: [P1], measurementIds: [] },
    grounded: true,
    status: "complete" as const,
    createdAt: "2026-06-14T12:00:00Z",
  };
  const events: ChatEvent[] = [
    { type: "thread", threadId: P1, userMessageId: P2 },
    { type: "status", stage: "searching", tool: "search_photos" },
    { type: "status", stage: "thinking" },
    { type: "photos", photos: [photo] },
    { type: "delta", text: "line one\nline two" },
    {
      type: "done",
      message,
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.001 },
      toolsUsed: ["search_photos"],
    },
    { type: "error", error: "rate_limited", message: "x" },
  ];

  it.each(events)("round trips a $type event", (event) => {
    const frame = encodeChatEvent(event);
    expect(frame.startsWith(`event: ${event.type}\ndata: `)).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    // exactly one data line: newlines inside text are JSON-escaped
    expect(frame.split("\n").filter((l) => l.startsWith("data:"))).toHaveLength(1);
    expect(decodeChatEventFrame(frame.slice(0, -2))).toEqual(event);
    expect(chatEventSchema.safeParse(event).success).toBe(true);
  });

  it("decode ignores keepalive comments and frames without data", () => {
    expect(CHAT_SSE_KEEPALIVE).toBe(": keepalive\n\n");
    expect(decodeChatEventFrame(": keepalive")).toBeNull();
    expect(decodeChatEventFrame("event: delta")).toBeNull();
    expect(decodeChatEventFrame("")).toBeNull();
  });

  it("decode rejects bad JSON, a mismatched event name and schema violations", () => {
    expect(decodeChatEventFrame("event: delta\ndata: {nope")).toBeNull();
    expect(decodeChatEventFrame('event: thread\ndata: {"type":"delta","text":"x"}')).toBeNull();
    expect(decodeChatEventFrame('data: {"type":"delta"}')).toBeNull();
    expect(decodeChatEventFrame('data: {"type":"unknown"}')).toBeNull();
  });

  it("decode accepts CRLF, a missing event line and data without the leading space", () => {
    expect(decodeChatEventFrame('data:{"type":"delta","text":"x"}')).toEqual({
      type: "delta",
      text: "x",
    });
    expect(decodeChatEventFrame('event: delta\r\ndata: {"type":"delta","text":"x"}')).toEqual({
      type: "delta",
      text: "x",
    });
  });
});

describe("chatSendRequestSchema", () => {
  it("trims, requires 1..1000 characters", () => {
    expect(chatSendRequestSchema.parse({ text: "  hi  " }).text).toBe("hi");
    expect(chatSendRequestSchema.safeParse({ text: "   " }).success).toBe(false);
    expect(chatSendRequestSchema.safeParse({ text: "x".repeat(1001) }).success).toBe(false);
    expect(chatSendRequestSchema.safeParse({ text: "x".repeat(1000) }).success).toBe(true);
    expect(chatSendRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("formatChatMessage and the fast-path copy", () => {
  it("fills {name} placeholders with numbers or text, repeatedly", () => {
    expect(formatChatMessage("Here are {count} photos", { count: 7 })).toBe("Here are 7 photos");
    expect(formatChatMessage("{a} and {a} and {b}", { a: "x", b: 2 })).toBe("x and x and 2");
  });

  it("leaves unknown placeholders and templates without any untouched", () => {
    expect(formatChatMessage("Here are {count}", {})).toBe("Here are {count}");
    expect(formatChatMessage("no placeholder", { count: 1 })).toBe("no placeholder");
  });

  it("does not interpret special replacement patterns or inherited keys", () => {
    expect(formatChatMessage("{count}", { count: "$& $1" })).toBe("$& $1");
    expect(formatChatMessage("{toString} {constructor}", {})).toBe("{toString} {constructor}");
  });

  it("the three fast-path templates read naturally with their counts", () => {
    expect(CHAT_MESSAGES.fastPathOne).toBe("Here is 1 photo that matches.");
    expect(formatChatMessage(CHAT_MESSAGES.fastPathMany, { count: 5 })).toBe(
      "Here are 5 photos that match.",
    );
    expect(formatChatMessage(CHAT_MESSAGES.fastPathGroups, { count: 9 })).toBe(
      "Here are 9 photos for the times you asked about.",
    );
  });
});
