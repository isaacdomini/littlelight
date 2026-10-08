import { describe, expect, it } from "vitest";
import {
  ageGroupKey,
  ageGroupLabel,
  ageGroupSortValue,
  formatAge,
  isAgeGroupKey,
  parseAgeGroupKey,
} from "./age";

describe("ageGroupKey boundaries (docs/plans/step-5.md 2.2)", () => {
  it.each([
    [null, "unknown"],
    [Number.NaN, "unknown"],
    [Number.POSITIVE_INFINITY, "unknown"],
    [-1000, "pre"],
    [-1, "pre"],
    [-0.5, "pre"],
    [0, "w1"],
    [6, "w1"],
    [6.9, "w1"],
    [7, "w2"],
    [13, "w2"],
    [14, "w3"],
    [77, "w12"],
    [83, "w12"],
    [84, "m3"],
    [91, "m3"],
    [92, "m4"],
    [364, "m12"],
    [365, "m12"],
    [366, "m13"],
    [729, "m24"],
    [730, "y2"],
    [1094, "y2"],
    [1095, "y3"],
    [1460, "y4"],
  ])("ageDays %s -> %s", (d, key) => {
    expect(ageGroupKey(d)).toBe(key);
  });

  it("every key produced over -10..4000 parses, and keys are monotone in age", () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (let d = -10; d <= 4000; d++) {
      const key = ageGroupKey(d);
      expect(isAgeGroupKey(key), `${d} -> ${key}`).toBe(true);
      const v = ageGroupSortValue(key);
      expect(v, `${d}`).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(Math.max(d, -1));
      prev = v;
    }
  });

  it("the sort value is the smallest age in the group (round trip)", () => {
    for (let d = 0; d <= 4000; d++) {
      const key = ageGroupKey(d);
      const first = ageGroupSortValue(key);
      expect(ageGroupKey(first), key).toBe(key);
      if (first > 0) expect(ageGroupKey(first - 1), key).not.toBe(key);
    }
  });

  it("covers w1..w12 and m3..m24 exactly", () => {
    const keys = new Set<string>();
    for (let d = 0; d < 730; d++) keys.add(ageGroupKey(d));
    const expected = [
      ...Array.from({ length: 12 }, (_, i) => `w${i + 1}`),
      ...Array.from({ length: 22 }, (_, i) => `m${i + 3}`),
    ];
    expect([...keys]).toEqual(expected);
  });
});

describe("ageGroupSortValue ordering (newest first = descending)", () => {
  it("unknown > years > months > weeks > pre", () => {
    expect(ageGroupSortValue("unknown")).toBe(Number.POSITIVE_INFINITY);
    expect(ageGroupSortValue("pre")).toBe(-1);
    expect(ageGroupSortValue("w1")).toBe(0);
    expect(ageGroupSortValue("w3")).toBe(14);
    expect(ageGroupSortValue("m3")).toBe(84);
    expect(ageGroupSortValue("m4")).toBe(92);
    expect(ageGroupSortValue("y2")).toBe(730);
    const order = ["y3", "y2", "m24", "m12", "m3", "w12", "w1", "pre"];
    const sorted = [...order].sort((a, b) => ageGroupSortValue(b) - ageGroupSortValue(a));
    expect(sorted).toEqual(order);
  });

  it("throws RangeError for an invalid key", () => {
    for (const k of ["", "w0", "w13", "m2", "m25", "y1", "y0", "x5", "w01", "W1", "unknown "])
      expect(() => ageGroupSortValue(k), k).toThrow(RangeError);
  });
});

describe("parseAgeGroupKey / ageGroupLabel", () => {
  it("parses every kind", () => {
    expect(parseAgeGroupKey("unknown")).toEqual({ kind: "unknown", n: null });
    expect(parseAgeGroupKey("pre")).toEqual({ kind: "pre", n: null });
    expect(parseAgeGroupKey("w12")).toEqual({ kind: "week", n: 12 });
    expect(parseAgeGroupKey("m3")).toEqual({ kind: "month", n: 3 });
    expect(parseAgeGroupKey("m24")).toEqual({ kind: "month", n: 24 });
    expect(parseAgeGroupKey("y2")).toEqual({ kind: "year", n: 2 });
    expect(parseAgeGroupKey("y10")).toEqual({ kind: "year", n: 10 });
  });

  it.each(["", "w0", "w13", "m1", "m2", "m25", "y0", "y1", "y01", "w", "5", "pre1", "unknown1"])(
    "rejects %j",
    (k) => {
      expect(parseAgeGroupKey(k)).toBeNull();
      expect(isAgeGroupKey(k)).toBe(false);
    },
  );

  it("labels", () => {
    expect(ageGroupLabel("unknown")).toBe("Just uploaded");
    expect(ageGroupLabel("pre")).toBe("Before birth");
    expect(ageGroupLabel("w1")).toBe("Week 1");
    expect(ageGroupLabel("w12")).toBe("Week 12");
    expect(ageGroupLabel("m3")).toBe("Month 3");
    expect(ageGroupLabel("m24")).toBe("Month 24");
    expect(ageGroupLabel("y2")).toBe("2 years");
    expect(() => ageGroupLabel("nope")).toThrow(RangeError);
  });
});

describe("formatAge", () => {
  it.each([
    [-1, "before birth"],
    [0, "0 days"],
    [1, "1 day"],
    [3, "3 days"],
    [6, "6 days"],
    [7, "1 week"],
    [8, "1 week 1 day"],
    [17, "2 weeks 3 days"],
    [83, "11 weeks 6 days"],
    [84, "2 months 3 weeks"],
    [91, "3 months"],
    [730, "2 years"],
    [3.9, "3 days"],
  ])("%s -> %s", (d, s) => {
    expect(formatAge(d)).toBe(s);
  });

  it("never prints zero parts and handles years", () => {
    expect(formatAge(364)).toBe("11 months 3 weeks");
    expect(formatAge(365)).toBe("12 months"); // still the m12 group
    expect(formatAge(366)).toBe("12 months"); // 12 x 30.4375 = 365.25
    expect(formatAge(729)).toBe("23 months 3 weeks");
    expect(formatAge(760)).toBe("2 years 1 month");
    expect(formatAge(1095)).toBe("3 years");
    for (let d = 84; d <= 729; d++) expect(formatAge(d)).not.toContain("4 weeks");
    expect(formatAge(730)).toBe("2 years");
    expect(formatAge(800)).toBe("2 years 2 months");
    expect(formatAge(364)).not.toMatch(/\b0 /);
  });

  it("rejects non-finite numbers", () => {
    expect(() => formatAge(Number.NaN)).toThrow(RangeError);
    expect(() => formatAge(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
