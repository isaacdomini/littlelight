import { describe, expect, it } from "vitest";
import { type AiDescriptionV1, applyAiOverrides } from "./ai-description";
import {
  buildSearchDocument,
  SEARCH_DOC_LIMITS,
  SEARCH_DOC_VERSION,
  type SearchDocumentInput,
  searchDocumentInputSchema,
} from "./search-document";

const MILESTONE = "11111111-1111-4111-8111-111111111111";

function description(patch: Partial<AiDescriptionV1> = {}): AiDescriptionV1 {
  return {
    caption: "Maya walks barefoot on grass toward Dad, arms out, smiling broadly",
    detailed_description: "She wears a yellow sundress and a white sun hat.",
    subjects: [{ who: "baby", relation_hint: null, is_target_baby: true }],
    baby_present: true,
    baby_state: { pose: "standing", expression: "smiling", activity: "walking" },
    setting: {
      indoor_outdoor: "outdoor",
      place_type: "park",
      weather: "sunny",
      time_of_day: "afternoon",
    },
    objects: ["sun hat"],
    clothing: ["yellow sundress", "white sun hat"],
    activities: ["walking"],
    possible_milestones: [],
    occasion: null,
    mood: ["happy"],
    colors: ["yellow"],
    text_in_image: null,
    photo_quality: { blurry: false, is_screenshot: false, is_duplicate_like: false },
    sensitive_content: [],
    search_tags: ["park", "first steps"],
    ...patch,
  };
}

function input(patch: Partial<SearchDocumentInput> = {}): SearchDocumentInput {
  return {
    ageDays: 335,
    takenAtLocal: "2026-06-14T14:30:00",
    takenAtEstimated: false,
    place: "Riverside Park",
    milestone: { id: MILESTONE, name: "First steps" },
    people: ["Dad"],
    note: "three wobbly steps then a fall into Dad's arms.",
    measurements: [
      { kind: "height", valueMetric: 680, measuredAt: "2026-06-14T10:00:00Z" },
      { kind: "weight", valueMetric: 7200, measuredAt: "2026-06-14T10:00:00Z" },
    ],
    ai: description(),
    isSensitive: false,
    ...patch,
  };
}

describe("buildSearchDocument: the PRD example", () => {
  it("renders the PRD shape in the fixed field order, without the baby's name as a field", () => {
    const doc = buildSearchDocument(input());
    expect(doc.text).toBe(
      "11 months (2026-06-14), Sunday afternoon at Riverside Park. Milestone: First steps. " +
        "With Dad. Maya walks barefoot on grass toward Dad, arms out, smiling broadly. " +
        "She wears a yellow sundress and a white sun hat. Wearing yellow sundress and white sun hat. " +
        "Doing: walking. Seen: sun hat. Outdoor, park, sunny. Mood: happy. Tags: park, first steps. " +
        'Weight 7.2 kg; Height 68 cm. Note from parent: "three wobbly steps then a fall into Dad\'s arms."',
    );
    expect(doc.docVersion).toBe(SEARCH_DOC_VERSION);
    expect(doc.warnings).toEqual([]);
  });

  it("derives columns: lower-cased tags (union, deduped), people, place, milestone ids", () => {
    const doc = buildSearchDocument(input());
    expect(doc.tags).toEqual(["park", "first steps", "walking"]);
    expect(doc.people).toEqual(["Dad"]);
    expect(doc.place).toBe("riverside park");
    expect(doc.milestoneIds).toEqual([MILESTONE]);
    expect(doc.isSensitive).toBe(false);
  });

  it("sections appear in the documented order", () => {
    const t = buildSearchDocument(input()).text;
    const order = [
      "Milestone:",
      "With ",
      "Maya walks",
      "Wearing ",
      "Doing:",
      "Seen:",
      "Outdoor,",
      "Mood:",
      "Tags:",
      "Weight ",
      "Note from parent:",
    ].map((s) => t.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("buildSearchDocument: inputs", () => {
  it("has no baby name field: a babyName key is rejected by the strict schema", () => {
    expect(() => buildSearchDocument({ ...input(), babyName: "Maya" } as never)).toThrow();
    expect(searchDocumentInputSchema.safeParse({ ...input(), latitude: 1 }).success).toBe(false);
    expect(searchDocumentInputSchema.safeParse({ ...input(), longitude: 1 }).success).toBe(false);
  });

  it("overrides win: the merged description is what is rendered and tagged", () => {
    const merged = applyAiOverrides(description(), {
      caption: "Maya's first steps!",
      detailed_description: "Three steps toward Dad.",
      search_tags: ["Steps", "Dad"],
    });
    const doc = buildSearchDocument(input({ ai: merged }));
    expect(doc.text).toContain("Maya's first steps! Three steps toward Dad.");
    expect(doc.text).not.toContain("walks barefoot");
    expect(doc.text).toContain("Tags: steps, dad.");
    expect(doc.tags.slice(0, 2)).toEqual(["steps", "dad"]);
    expect(doc.tags).not.toContain("first steps".concat("x"));
  });

  it("blanks coordinates in place and note with a warning that names the field only", () => {
    const doc = buildSearchDocument(
      input({ place: "47.6062, -122.3321", note: "40.7128,-74.0060" }),
    );
    expect(doc.text).not.toMatch(/47\.6|122\.3|40\.7|74\.0/);
    expect(doc.text).not.toContain("Note from parent");
    expect(doc.place).toBeNull();
    expect(doc.warnings).toEqual([
      { code: "coordinates_blanked", field: "place" },
      { code: "coordinates_blanked", field: "note" },
    ]);
  });

  it("blanks coordinates in the model's text_in_image too", () => {
    const doc = buildSearchDocument(
      input({ ai: description({ text_in_image: "47.6062, -122.3321" }) }),
    );
    expect(doc.text).not.toContain("Text in photo");
    expect(doc.warnings).toContainEqual({ code: "coordinates_blanked", field: "text_in_image" });
  });

  it("quotes real text in the photo", () => {
    const doc = buildSearchDocument(
      input({ ai: description({ text_in_image: "Happy Birthday" }) }),
    );
    expect(doc.text).toContain('Text in photo: "Happy Birthday".');
  });

  it("an estimated date renders 'around <date>' with no weekday and no clock-derived time of day", () => {
    const doc = buildSearchDocument(
      input({
        takenAtEstimated: true,
        takenAtLocal: "2026-06-14",
        ai: description({
          setting: { indoor_outdoor: "unknown", place_type: "", weather: "", time_of_day: "" },
        }),
      }),
    );
    expect(doc.text.startsWith("11 months (around 2026-06-14) at Riverside Park.")).toBe(true);
    expect(doc.text).not.toMatch(/Sunday|morning|afternoon|evening|night/);
  });

  it("derives the time of day from the local hour when the model gave none", () => {
    const hours: [string, string][] = [
      ["2026-06-14T05:00:00", "morning"],
      ["2026-06-14T11:59:00", "morning"],
      ["2026-06-14T12:00:00", "afternoon"],
      ["2026-06-14T17:00:00", "evening"],
      ["2026-06-14T21:00:00", "night"],
      ["2026-06-14T04:59:00", "night"],
    ];
    for (const [takenAtLocal, expected] of hours) {
      const doc = buildSearchDocument(input({ takenAtLocal, ai: null, place: null }));
      expect(doc.text.startsWith(`11 months (2026-06-14), Sunday ${expected}.`), takenAtLocal).toBe(
        true,
      );
    }
  });

  it("measurements are metric, sorted by date then weight/height/head, and omit nothing else", () => {
    const doc = buildSearchDocument(
      input({
        ai: null,
        note: null,
        measurements: [
          { kind: "head", valueMetric: 452, measuredAt: "2026-06-14T10:00:00Z" },
          { kind: "height", valueMetric: 680, measuredAt: "2026-06-14T10:00:00Z" },
          { kind: "weight", valueMetric: 7200, measuredAt: "2026-06-14T10:00:00Z" },
          { kind: "weight", valueMetric: 6900, measuredAt: "2026-05-14T10:00:00Z" },
        ],
      }),
    );
    expect(doc.text).toContain(
      "Weight 6.9 kg; Weight 7.2 kg; Height 68 cm; Head circumference 45.2 cm.",
    );
    // shuffling the input does not change the output
    const again = buildSearchDocument(
      input({
        ai: null,
        note: null,
        measurements: [
          { kind: "weight", valueMetric: 6900, measuredAt: "2026-05-14T10:00:00Z" },
          { kind: "weight", valueMetric: 7200, measuredAt: "2026-06-14T10:00:00Z" },
          { kind: "head", valueMetric: 452, measuredAt: "2026-06-14T10:00:00Z" },
          { kind: "height", valueMetric: 680, measuredAt: "2026-06-14T10:00:00Z" },
        ],
      }),
    );
    expect(again.text).toBe(doc.text);
  });

  it("omits absent fields instead of rendering 'unknown'", () => {
    const doc = buildSearchDocument({
      ageDays: null,
      takenAtLocal: null,
      takenAtEstimated: false,
      place: null,
      milestone: null,
      people: [],
      note: null,
      measurements: [],
      ai: null,
      isSensitive: true,
    });
    expect(doc.text).toBe("");
    expect(doc.tags).toEqual([]);
    expect(doc.people).toEqual([]);
    expect(doc.place).toBeNull();
    expect(doc.milestoneIds).toEqual([]);
    expect(doc.isSensitive).toBe(true);
  });

  it("treats model placeholders like 'unknown' as absent", () => {
    const doc = buildSearchDocument(
      input({ ai: description({ occasion: "unknown", mood: ["none"], objects: ["N/A"] }) }),
    );
    expect(doc.text).not.toMatch(/unknown|Mood:|Seen:|Occasion:/i);
  });

  it("people are trimmed, de-duplicated and capped at 20", () => {
    const people = Array.from({ length: 30 }, (_, i) => ` Person ${i % 25} `);
    const doc = buildSearchDocument(input({ people }));
    expect(doc.people).toHaveLength(SEARCH_DOC_LIMITS.people);
    expect(doc.people[0]).toBe("Person 0");
    expect(new Set(doc.people).size).toBe(doc.people.length);
  });

  it("joins people with commas and 'and'", () => {
    expect(buildSearchDocument(input({ people: ["Mom", "Dad", "Aunt Lily"] })).text).toContain(
      "With Mom, Dad and Aunt Lily.",
    );
    expect(buildSearchDocument(input({ people: ["Mom", "Dad"] })).text).toContain(
      "With Mom and Dad.",
    );
  });

  it("tags are capped at 30 (search tags first, then activities)", () => {
    const search_tags = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    const activities = Array.from({ length: 20 }, (_, i) => `act-${i}`);
    const doc = buildSearchDocument(input({ ai: description({ search_tags, activities }) }));
    expect(doc.tags).toHaveLength(SEARCH_DOC_LIMITS.tags);
    expect(doc.tags.slice(0, 20)).toEqual(search_tags);
    expect(doc.tags[20]).toBe("act-0");
  });

  it("includes sensitive flags and the milestone name in tags", () => {
    const doc = buildSearchDocument(input({ ai: description({ sensitive_content: ["bath"] }) }));
    expect(doc.tags).toContain("bath");
    expect(doc.tags).toContain("first steps");
  });
});

describe("buildSearchDocument: limits and determinism", () => {
  it("truncates a long note to 600 characters with a warning", () => {
    const doc = buildSearchDocument(input({ note: "word ".repeat(400) }));
    expect(doc.warnings).toContainEqual({ code: "truncated", field: "note" });
    const m = /Note from parent: "(.*)"/.exec(doc.text);
    expect(m?.[1]?.length).toBeLessThanOrEqual(SEARCH_DOC_LIMITS.note + 2);
  });

  it("a maximal input stays within the 4000 character cap", () => {
    const doc = buildSearchDocument(
      input({
        note: "n".repeat(900),
        people: Array.from({ length: 30 }, (_, i) => `${i}`.repeat(30)),
        ai: description({
          detailed_description: "d".repeat(1200),
          caption: "c".repeat(200),
          objects: Array.from({ length: 30 }, (_, i) => `object ${i} `.repeat(4)),
        }),
      }),
    );
    expect(doc.text.length).toBeLessThanOrEqual(SEARCH_DOC_LIMITS.text);
  });

  it("never splits a surrogate pair when truncating", () => {
    const doc = buildSearchDocument(input({ note: "👶".repeat(2000), ai: null }));
    // a lone surrogate would make this round trip fail
    expect(() => encodeURIComponent(doc.text)).not.toThrow();
  });

  it("is deterministic: same input, byte-identical text and columns; whitespace is normalised", () => {
    const a = buildSearchDocument(input());
    const b = buildSearchDocument(structuredClone(input()));
    expect(b).toEqual(a);
    const messy = buildSearchDocument(
      input({ note: "  three \n\n wobbly\t steps  ", people: ["  Dad "] }),
    );
    expect(messy.text).toContain('Note from parent: "three wobbly steps".');
    expect(messy.people).toEqual(["Dad"]);
  });

  it("strips control characters from parent text", () => {
    const doc = buildSearchDocument(input({ note: "hi\u0000there\u0007!" }));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are gone
    expect(doc.text).not.toMatch(/[\u0000-\u0008]/);
  });
});

describe("buildSearchDocument: videos (step 12) leave photo documents byte-identical", () => {
  it("a photo input renders the same text whether mediaKind is omitted or 'photo'", () => {
    const before = buildSearchDocument(input());
    const explicit = buildSearchDocument(input({ mediaKind: "photo", durationMs: null }));
    expect(explicit).toEqual(before);
    expect(before.text).not.toContain("Video clip");
    expect(before.docVersion).toBe(SEARCH_DOC_VERSION);
  });

  it("a video appends exactly one fixed sentence with its duration, after the note", () => {
    const photo = buildSearchDocument(input());
    const video = buildSearchDocument(input({ mediaKind: "video", durationMs: 42_000 }));
    expect(video.text).toBe(`${photo.text} Video clip, 42 seconds.`);
    expect(video.tags).toEqual(photo.tags);
    expect(video.warnings).toEqual([]);
    expect(buildSearchDocument(input({ mediaKind: "video", durationMs: 125_000 })).text).toMatch(
      / Video clip, 2 minutes 5 seconds\.$/,
    );
    expect(buildSearchDocument(input({ mediaKind: "video", durationMs: 60_000 })).text).toMatch(
      / Video clip, 1 minute\.$/,
    );
    expect(buildSearchDocument(input({ mediaKind: "video", durationMs: 1_000 })).text).toMatch(
      / Video clip, 1 second\.$/,
    );
    expect(buildSearchDocument(input({ mediaKind: "video" })).text).toMatch(/ Video clip\.$/);
  });

  it("rejects an unknown media kind and a non-positive duration", () => {
    expect(searchDocumentInputSchema.safeParse({ ...input(), mediaKind: "gif" }).success).toBe(
      false,
    );
    expect(
      searchDocumentInputSchema.safeParse({ ...input(), mediaKind: "video", durationMs: 0 })
        .success,
    ).toBe(false);
  });
});
