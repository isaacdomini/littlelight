import { describe, expect, it } from "vitest";
import {
  AI_DESCRIPTION_LIMITS,
  AI_DESCRIPTION_V1_JSON_SCHEMA,
  AI_DESCRIPTION_V1_SCHEMA_NAME,
  AI_EXPRESSION,
  AI_FIELD_OVERRIDABLE,
  AI_INDOOR_OUTDOOR,
  AI_JSON_SCHEMA_FORBIDDEN_KEYWORDS,
  AI_POSE,
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
  AI_SENSITIVE_FLAGS,
  AI_SUBJECT_WHO,
  type AiDescriptionV1,
  aiDescriptionV1Schema,
  aiOverrideValueSchema,
  aiVisionContextSchema,
  applyAiOverrides,
  isSensitive,
  looksLikeCoordinates,
  maxMilestoneConfidence,
} from "./ai-description";

// The PRD "Structured description schema (v1)" example, written with every key present.
function sample(): AiDescriptionV1 {
  return {
    caption: "Baby giggling in a yellow rain jacket at the park.",
    detailed_description:
      "A baby sits on a picnic blanket and laughs. A grandmother holds a toy. Trees are behind them.",
    subjects: [
      { who: "baby", relation_hint: null, is_target_baby: true },
      { who: "adult", relation_hint: "grandmother", is_target_baby: false },
    ],
    baby_present: true,
    baby_state: { pose: "sitting", expression: "smiling", activity: "playing" },
    setting: {
      indoor_outdoor: "outdoor",
      place_type: "park",
      weather: "overcast",
      time_of_day: "afternoon",
    },
    objects: ["blanket", "toy"],
    clothing: ["yellow rain jacket"],
    activities: ["playing"],
    possible_milestones: [{ name: "sitting up", confidence: 0.4 }],
    occasion: null,
    mood: ["happy"],
    colors: ["yellow", "green"],
    text_in_image: null,
    photo_quality: { blurry: false, is_screenshot: false, is_duplicate_like: false },
    sensitive_content: [],
    search_tags: ["park", "rain jacket", "giggle"],
  };
}

describe("versions", () => {
  it("pins v1 for prompt and schema, with a valid OpenAI schema name", () => {
    expect(AI_SCHEMA_VERSION).toBe("v1");
    expect(AI_PROMPT_VERSION).toBe("v1");
    expect(AI_DESCRIPTION_V1_SCHEMA_NAME).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("aiDescriptionV1Schema: accept", () => {
  it("accepts the PRD example shape", () => {
    expect(aiDescriptionV1Schema.safeParse(sample()).success).toBe(true);
  });

  it.each(AI_SUBJECT_WHO)("accepts subject who=%s", (who) => {
    const d = sample();
    d.subjects[0] = { who, relation_hint: null, is_target_baby: false };
    expect(aiDescriptionV1Schema.safeParse(d).success).toBe(true);
  });
  it.each(AI_POSE)("accepts pose=%s", (pose) => {
    const d = sample();
    d.baby_state.pose = pose;
    expect(aiDescriptionV1Schema.safeParse(d).success).toBe(true);
  });
  it.each(AI_EXPRESSION)("accepts expression=%s", (expression) => {
    const d = sample();
    d.baby_state.expression = expression;
    expect(aiDescriptionV1Schema.safeParse(d).success).toBe(true);
  });
  it.each(AI_INDOOR_OUTDOOR)("accepts indoor_outdoor=%s", (v) => {
    const d = sample();
    d.setting.indoor_outdoor = v;
    expect(aiDescriptionV1Schema.safeParse(d).success).toBe(true);
  });
  it.each(AI_SENSITIVE_FLAGS)("accepts sensitive flag %s", (flag) => {
    const d = sample();
    d.sensitive_content = [flag];
    const r = aiDescriptionV1Schema.parse(d);
    expect(isSensitive(r)).toBe(true);
  });

  it("accepts empty lists and an empty subjects array", () => {
    const d = sample();
    Object.assign(d, {
      subjects: [],
      objects: [],
      clothing: [],
      activities: [],
      possible_milestones: [],
      mood: [],
      colors: [],
    });
    expect(aiDescriptionV1Schema.safeParse(d).success).toBe(true);
  });
});

describe("aiDescriptionV1Schema: normalisation", () => {
  it("trims, lowercases and dedupes search_tags", () => {
    const d = sample();
    d.search_tags = ["  Park ", "PARK", "Rain Jacket", "park"];
    expect(aiDescriptionV1Schema.parse(d).search_tags).toEqual(["park", "rain jacket"]);
  });

  it("dedupes sensitive_content before bounds", () => {
    const d = sample();
    d.sensitive_content = ["bath", "bath", "diaper", "bath", "diaper"];
    expect(aiDescriptionV1Schema.parse(d).sensitive_content).toEqual(["bath", "diaper"]);
  });

  it("trims caption and rejects whitespace-only", () => {
    const d = sample();
    d.caption = "   hi   ";
    expect(aiDescriptionV1Schema.parse(d).caption).toBe("hi");
    d.caption = "    ";
    expect(aiDescriptionV1Schema.safeParse(d).success).toBe(false);
  });

  it("is idempotent on its own output (safe to store and re-parse)", () => {
    const d = sample();
    d.search_tags = ["A", "a", " B "];
    const once = aiDescriptionV1Schema.parse(d);
    expect(aiDescriptionV1Schema.parse(once)).toEqual(once);
  });
});

describe("aiDescriptionV1Schema: reject", () => {
  type Obj = Record<string, unknown> & {
    baby_state: Record<string, unknown>;
    subjects: Record<string, unknown>[];
  };
  const withChange = (change: (d: Obj) => void) => {
    const d = structuredClone(sample()) as unknown as Obj;
    change(d);
    return aiDescriptionV1Schema.safeParse(d);
  };
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
  const milestones = (n: number) =>
    Array.from({ length: n }, () => ({ name: "x", confidence: 0.1 }));

  const cases: [string, (d: Obj) => void][] = [
    ["an unknown top-level key", (d) => Object.assign(d, { name: "Mia" })],
    ["a latitude key", (d) => Object.assign(d, { latitude: 47.6 })],
    ["a missing key", (d) => Reflect.deleteProperty(d, "caption")],
    ["a missing search_tags", (d) => Reflect.deleteProperty(d, "search_tags")],
    ["empty search_tags", (d) => Object.assign(d, { search_tags: [] })],
    ["21 tags", (d) => Object.assign(d, { search_tags: tags(21) })],
    ["a 61 char tag", (d) => Object.assign(d, { search_tags: ["x".repeat(61)] })],
    ["a 201 char caption", (d) => Object.assign(d, { caption: "x".repeat(201) })],
    [
      "a 1201 char description",
      (d) => Object.assign(d, { detailed_description: "x".repeat(1201) }),
    ],
    ["an unknown pose", (d) => Object.assign(d.baby_state, { pose: "flying" })],
    ["an enum in the wrong case", (d) => Object.assign(d.baby_state, { pose: "Sitting" })],
    ["an unknown sensitive flag", (d) => Object.assign(d, { sensitive_content: ["nudity"] })],
    [
      "a confidence above 1",
      (d) => Object.assign(d, { possible_milestones: [{ name: "x", confidence: 1.2 }] }),
    ],
    [
      "a negative confidence",
      (d) => Object.assign(d, { possible_milestones: [{ name: "x", confidence: -0.1 }] }),
    ],
    ["baby_present as a string", (d) => Object.assign(d, { baby_present: "yes" })],
    ["null caption", (d) => Object.assign(d, { caption: null })],
    ["an extra key inside baby_state", (d) => Object.assign(d.baby_state, { mood: "x" })],
    ["an extra key in a subject", (d) => Object.assign(d.subjects[0] ?? {}, { name: "Mia" })],
    [
      "21 subjects",
      (d) =>
        Object.assign(d, {
          subjects: Array.from({ length: 21 }, () => ({
            who: "baby",
            relation_hint: null,
            is_target_baby: false,
          })),
        }),
    ],
    ["31 objects", (d) => Object.assign(d, { objects: tags(31) })],
    ["11 milestones", (d) => Object.assign(d, { possible_milestones: milestones(11) })],
    ["a nullable key that is absent instead of null", (d) => Reflect.deleteProperty(d, "occasion")],
  ];

  it.each(cases)("rejects %s", (_n, change) => {
    expect(withChange(change).success).toBe(false);
  });

  it("issues never echo the offending value", () => {
    const r = withChange((d) => Object.assign(d, { caption: "SECRET-NOTE-".repeat(30) }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain("SECRET-NOTE");
  });

  it.each([null, undefined, "x", 5, []])("rejects non-object %s", (v) => {
    expect(aiDescriptionV1Schema.safeParse(v).success).toBe(false);
  });
});

describe("helpers", () => {
  it("isSensitive is true only when flags exist", () => {
    expect(isSensitive({ sensitive_content: [] })).toBe(false);
    expect(isSensitive({ sensitive_content: ["medical"] })).toBe(true);
  });
  it("maxMilestoneConfidence", () => {
    expect(maxMilestoneConfidence({ possible_milestones: [] })).toBeNull();
    expect(
      maxMilestoneConfidence({
        possible_milestones: [
          { name: "a", confidence: 0.2 },
          { name: "b", confidence: 0.9 },
        ],
      }),
    ).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------------------------
// Provider JSON Schema strict-mode invariants
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** `schema.properties[name].properties[child]`-style lookup that fails loudly. */
function sub(node: unknown, ...keys: string[]): Json {
  let cur = node as Json;
  for (const k of keys) {
    const next = (cur.properties as Record<string, Json> | undefined)?.[k];
    if (!next) throw new Error(`no property ${k}`);
    cur = next;
  }
  return cur;
}

function walk(node: unknown, visit: (n: Json, path: string) => void, path = "$"): void {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) walk(v, visit, `${path}[${i}]`);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  visit(node as Json, path);
  for (const [k, v] of Object.entries(node)) walk(v, visit, `${path}.${k}`);
}

describe("AI_DESCRIPTION_V1_JSON_SCHEMA (strict structured output)", () => {
  const schema = AI_DESCRIPTION_V1_JSON_SCHEMA as Json;

  it("is an object schema with no $schema/$id", () => {
    expect(schema.type).toBe("object");
    expect(schema.$schema).toBeUndefined();
    expect(schema.$id).toBeUndefined();
  });

  it("every object has additionalProperties:false and required = all property keys", () => {
    let objects = 0;
    walk(schema, (n, path) => {
      if (n.type === "object" && n.properties) {
        objects++;
        expect(n.additionalProperties, path).toBe(false);
        expect([...(n.required as string[])].sort(), path).toEqual(
          Object.keys(n.properties as Json).sort(),
        );
      }
    });
    // top level, subject, baby_state, setting, milestone, photo_quality
    expect(objects).toBe(6);
  });

  it("has none of the forbidden keywords anywhere", () => {
    const found: string[] = [];
    walk(schema, (n, path) => {
      for (const kw of AI_JSON_SCHEMA_FORBIDDEN_KEYWORDS) if (kw in n) found.push(`${path}.${kw}`);
    });
    expect(found).toEqual([]);
  });

  it("has no anyOf/oneOf/allOf: nullable fields are type [T, 'null']", () => {
    walk(schema, (n, path) => {
      expect("anyOf" in n, path).toBe(false);
      expect("oneOf" in n, path).toBe(false);
      expect("allOf" in n, path).toBe(false);
    });
    const props = schema.properties as Record<string, Json>;
    expect(props.occasion?.type).toEqual(["string", "null"]);
    expect(props.text_in_image?.type).toEqual(["string", "null"]);
    expect(sub(schema, "setting", "weather").type).toEqual(["string", "null"]);
    expect(props.caption?.type).toBe("string");
  });

  it("lists exactly the 17 description keys, matching the zod schema", () => {
    const keys = Object.keys(schema.properties as Json).sort();
    expect(keys).toEqual(Object.keys(aiDescriptionV1Schema.shape).sort());
    expect(keys).toHaveLength(17);
  });

  it("carries the closed enums", () => {
    const props = schema.properties as Record<string, Json>;
    const sensitive = props.sensitive_content?.items as Json;
    expect(sensitive.enum).toEqual([...AI_SENSITIVE_FLAGS]);
    const state = props.baby_state?.properties as Record<string, Json>;
    expect(state.pose?.enum).toEqual([...AI_POSE]);
  });

  it("is deep-frozen and stable across reads", () => {
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.properties)).toBe(true);
    expect(JSON.stringify(schema)).toBe(JSON.stringify(AI_DESCRIPTION_V1_JSON_SCHEMA));
  });

  it("a valid sample is structurally accepted: every required key present, enum values allowed", () => {
    const d = sample() as unknown as Json;
    const props = schema.properties as Record<string, Json>;
    for (const key of schema.required as string[]) expect(key in d, key).toBe(true);
    expect(Object.keys(d).sort()).toEqual(Object.keys(props).sort());
    expect(sub(schema, "baby_state", "pose").enum).toContain((d.baby_state as Json).pose);
  });
});

// ---------------------------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------------------------

describe("override value schemas", () => {
  it("lists the three overridable fields", () => {
    expect([...AI_FIELD_OVERRIDABLE]).toEqual(["caption", "detailed_description", "search_tags"]);
  });

  it("caption: trimmed, 1..200", () => {
    const s = aiOverrideValueSchema("caption");
    expect(s.parse("  Our first walk  ")).toBe("Our first walk");
    expect(s.safeParse("").success).toBe(false);
    expect(s.safeParse("   ").success).toBe(false);
    expect(s.safeParse("x".repeat(200)).success).toBe(true);
    expect(s.safeParse("x".repeat(201)).success).toBe(false);
    expect(s.safeParse(5).success).toBe(false);
  });

  it("detailed_description: 1..1200", () => {
    const s = aiOverrideValueSchema("detailed_description");
    expect(s.safeParse("x".repeat(1200)).success).toBe(true);
    expect(s.safeParse("x".repeat(1201)).success).toBe(false);
    expect(s.safeParse("").success).toBe(false);
  });

  it("search_tags: lowercased, deduped, 1..20 of <= 60", () => {
    const s = aiOverrideValueSchema("search_tags");
    expect(s.parse(["Park", " park ", "Zoo"])).toEqual(["park", "zoo"]);
    expect(s.safeParse([]).success).toBe(false);
    expect(s.safeParse(Array.from({ length: 21 }, (_, i) => `t${i}`)).success).toBe(false);
    expect(s.safeParse(Array.from({ length: 20 }, (_, i) => `t${i}`)).success).toBe(true);
    expect(s.safeParse(["x".repeat(61)]).success).toBe(false);
    expect(s.safeParse(["ok", ""]).success).toBe(false);
    expect(s.safeParse("park").success).toBe(false);
  });
});

describe("applyAiOverrides", () => {
  it("returns the description unchanged for null/undefined/empty overrides", () => {
    const d = aiDescriptionV1Schema.parse(sample());
    expect(applyAiOverrides(d, null)).toBe(d);
    expect(applyAiOverrides(d, undefined)).toBe(d);
    expect(applyAiOverrides(d, {})).toEqual(d);
  });

  it("each valid override wins and the input is not mutated", () => {
    const d = aiDescriptionV1Schema.parse(sample());
    const before = structuredClone(d);
    const out = applyAiOverrides(d, {
      caption: "Mia's first picnic",
      detailed_description: "Parents wrote this.",
      search_tags: ["Picnic", "picnic", "Summer"],
    });
    expect(out.caption).toBe("Mia's first picnic");
    expect(out.detailed_description).toBe("Parents wrote this.");
    expect(out.search_tags).toEqual(["picnic", "summer"]);
    expect(d).toEqual(before);
    expect(aiDescriptionV1Schema.safeParse(out).success).toBe(true);
  });

  it("ignores malformed override values so the result stays valid", () => {
    const d = aiDescriptionV1Schema.parse(sample());
    const out = applyAiOverrides(d, {
      caption: 42,
      detailed_description: "",
      search_tags: [],
    });
    expect(out).toEqual(d);
    const out2 = applyAiOverrides(d, { caption: "x".repeat(500), search_tags: "park" });
    expect(out2.caption).toBe(d.caption);
    expect(out2.search_tags).toEqual(d.search_tags);
  });

  it("treats null as absent and leaves other fields alone", () => {
    const d = aiDescriptionV1Schema.parse(sample());
    const out = applyAiOverrides(d, { caption: null, search_tags: ["only"] });
    expect(out.caption).toBe(d.caption);
    expect(out.search_tags).toEqual(["only"]);
    expect(out.objects).toEqual(d.objects);
  });

  it("ignores keys outside the overridable set", () => {
    const d = aiDescriptionV1Schema.parse(sample());
    const out = applyAiOverrides(d, { objects: ["x"], baby_present: false } as never);
    expect(out).toEqual(d);
  });
});

// ---------------------------------------------------------------------------------------------
// Coordinates tripwire and context
// ---------------------------------------------------------------------------------------------

describe("looksLikeCoordinates", () => {
  it.each([
    "47.6062, -122.3321",
    "47.6062 -122.3321",
    "47.6062;-122.3321",
    "at 47.60621/-122.33211 yesterday",
    `47°36'22"N`,
    "47° 36′ N",
    "my latitude is secret",
    "Longitude",
    "gps tag here",
  ])("flags %j", (t) => {
    expect(looksLikeCoordinates(t)).toBe(true);
  });

  it.each([
    "Riverside Park, 2 pm",
    "Grandma's house",
    "She weighed 7.5 lb at 3.25 months",
    "Tuesday 12:30",
    "47 days old",
    "Lisbon, Portugal",
    "",
  ])("leaves %j alone", (t) => {
    expect(looksLikeCoordinates(t)).toBe(false);
  });
});

describe("aiVisionContextSchema", () => {
  const ok = {
    babyAgeDays: 120,
    takenAt: "2026-06-14T10:42:00",
    placeLabel: "Riverside Park",
    people: ["Grandma"],
    milestone: null,
    parentNotes: "First picnic",
  };

  it("accepts a normal context and date-only / offset times", () => {
    expect(aiVisionContextSchema.safeParse(ok).success).toBe(true);
    expect(aiVisionContextSchema.safeParse({ ...ok, takenAt: "2026-06-14" }).success).toBe(true);
    expect(
      aiVisionContextSchema.safeParse({ ...ok, takenAt: "2026-06-14T10:42:00+02:00" }).success,
    ).toBe(true);
    expect(
      aiVisionContextSchema.safeParse({ ...ok, takenAt: null, babyAgeDays: null }).success,
    ).toBe(true);
  });

  it("is strict: no latitude / baby name / extra field", () => {
    expect(aiVisionContextSchema.safeParse({ ...ok, latitude: 1 }).success).toBe(false);
    expect(aiVisionContextSchema.safeParse({ ...ok, babyName: "Mia" }).success).toBe(false);
  });

  it("rejects coordinate-looking placeLabel and parentNotes with a fixed message", () => {
    const r1 = aiVisionContextSchema.safeParse({ ...ok, placeLabel: "47.6062, -122.3321" });
    expect(r1.success).toBe(false);
    expect(JSON.stringify(r1.error?.issues)).not.toContain("47.6062");
    expect(
      aiVisionContextSchema.safeParse({ ...ok, parentNotes: "taken at 47.6062 -122.3321" }).success,
    ).toBe(false);
    expect(
      aiVisionContextSchema.safeParse({ ...ok, placeLabel: "Riverside Park, 2 pm" }).success,
    ).toBe(true);
  });

  it("bounds notes, people and labels", () => {
    expect(aiVisionContextSchema.safeParse({ ...ok, parentNotes: "x".repeat(2001) }).success).toBe(
      false,
    );
    expect(
      aiVisionContextSchema.safeParse({ ...ok, people: Array.from({ length: 21 }, () => "A") })
        .success,
    ).toBe(false);
    expect(aiVisionContextSchema.safeParse({ ...ok, placeLabel: "x".repeat(121) }).success).toBe(
      false,
    );
    expect(aiVisionContextSchema.safeParse({ ...ok, takenAt: "yesterday" }).success).toBe(false);
  });
});

describe("limits", () => {
  it("match the documented bounds", () => {
    expect(AI_DESCRIPTION_LIMITS.caption).toBe(200);
    expect(AI_DESCRIPTION_LIMITS.detailedDescription).toBe(1200);
    expect(AI_DESCRIPTION_LIMITS.searchTags).toBe(20);
    expect(AI_DESCRIPTION_LIMITS.searchTag).toBe(60);
  });
});
