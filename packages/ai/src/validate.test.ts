import { describe, expect, it } from "vitest";
import { fakeDescription } from "./fake/describe";
import { mergeOverrides, validateDescription } from "./validate";

// Loosely typed JSON as read back from recorded requests.
// biome-ignore lint/suspicious/noExplicitAny: test-only access to wire JSON
type Rec = Record<string, any>;

const good = () => structuredClone(fakeDescription("11111111-1111-4111-8111-111111111111")) as Rec;

describe("validateDescription", () => {
  it("accepts a valid object and a JSON string of one", () => {
    expect(validateDescription(good()).ok).toBe(true);
    const r = validateDescription(JSON.stringify(good()));
    expect(r.ok).toBe(true);
  });

  it("lenient pre-pass: enum casing, spaces/dashes, and confidence clamping", () => {
    const d = good();
    d.baby_state.pose = " Sitting ";
    d.setting.indoor_outdoor = "OUTDOOR";
    d.subjects = [{ who: "Baby", relation_hint: null, is_target_baby: true }];
    d.sensitive_content = ["Partial-Nudity", "BATH"];
    d.possible_milestones = [
      { name: "x", confidence: 1.7 },
      { name: "y", confidence: -2 },
    ];
    const r = validateDescription(d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.baby_state.pose).toBe("sitting");
      expect(r.value.sensitive_content).toEqual(["partial_nudity", "bath"]);
      expect(r.value.possible_milestones.map((m) => m.confidence)).toEqual([1, 0]);
    }
  });

  it("does not mutate its input", () => {
    const d = good();
    d.baby_state.pose = "Sitting";
    const before = structuredClone(d);
    validateDescription(d);
    expect(d).toEqual(before);
  });

  it("invalid output yields path:code issues and never echoes values", () => {
    const d = good();
    d.caption = 42;
    d.secret_extra = "PRIVATE-NOTE";
    const r = validateDescription(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.startsWith("caption:"))).toBe(true);
      expect(JSON.stringify(r.issues)).not.toContain("PRIVATE-NOTE");
      expect(r.issues.length).toBeLessThanOrEqual(20);
    }
  });

  it("unparseable JSON string, non-objects and an unknown enum value fail", () => {
    expect(validateDescription("{not json")).toEqual({ ok: false, issues: ["$:json_parse"] });
    for (const v of [null, undefined, 5, [], "[]"]) expect(validateDescription(v).ok).toBe(false);
    const d = good();
    d.baby_state.pose = "levitating";
    expect(validateDescription(d).ok).toBe(false);
  });
});

describe("mergeOverrides", () => {
  it("overrides win and the input is untouched", () => {
    const base = validateDescription(good());
    if (!base.ok) throw new Error("fixture");
    const out = mergeOverrides(base.value, { caption: "Mine" });
    expect(out.caption).toBe("Mine");
    expect(base.value.caption).not.toBe("Mine");
  });
});
