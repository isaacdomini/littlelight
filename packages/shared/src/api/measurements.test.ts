import { describe, expect, it } from "vitest";
import {
  MEASUREMENT_NOTE_MAX,
  measurementCreateSchema,
  measurementUpdateSchema,
  measurementValueIssue,
} from "./measurements";

const base = { kind: "weight", value: 7.5, unit: "lb", measuredAt: "2026-05-01T10:00:00.000Z" };

describe("measurementValueIssue", () => {
  it("accepts in-range values at the inclusive bounds", () => {
    expect(measurementValueIssue("weight", 7.5, "lb")).toBeNull();
    expect(measurementValueIssue("weight", 200, "g")).toBeNull();
    expect(measurementValueIssue("weight", 50, "kg")).toBeNull();
    expect(measurementValueIssue("height", 20, "cm")).toBeNull();
    expect(measurementValueIssue("height", 150, "cm")).toBeNull();
    expect(measurementValueIssue("head", 70, "cm")).toBeNull();
  });

  it("flags a unit that does not fit the kind on the unit path", () => {
    expect(measurementValueIssue("weight", 5, "in")).toMatchObject({ path: "unit" });
    expect(measurementValueIssue("height", 5, "kg")).toMatchObject({ path: "unit" });
  });

  it("flags out-of-range and non-finite values on the value path, naming no value", () => {
    for (const [k, v, u] of [
      ["weight", 199, "g"],
      ["weight", 50.1, "kg"],
      ["height", 19, "cm"],
      ["height", 151, "cm"],
      ["head", 71, "cm"],
      ["head", 1, "mm"],
    ] as const) {
      const issue = measurementValueIssue(k, v, u);
      expect(issue, `${k} ${v}${u}`).toMatchObject({ path: "value" });
      expect(issue?.message).not.toContain(String(v));
    }
    expect(measurementValueIssue("weight", Number.NaN, "kg")).toMatchObject({ path: "value" });
  });
});

describe("measurementCreateSchema", () => {
  it("parses and trims the note", () => {
    const r = measurementCreateSchema.parse({ ...base, note: "  at the clinic  " });
    expect(r.note).toBe("at the clinic");
    expect(measurementCreateSchema.parse({ ...base, photoId: null }).photoId).toBeNull();
  });

  it.each([
    ["in for weight", { ...base, unit: "in" }, "unit"],
    ["lb for height", { ...base, kind: "height", unit: "lb" }, "unit"],
    ["too heavy", { ...base, value: 120 }, "value"],
    ["too light", { ...base, value: 0.1 }, "value"],
    ["zero", { ...base, value: 0 }, "value"],
    ["negative", { ...base, value: -3 }, "value"],
  ])("rejects %s", (_n, body, path) => {
    const r = measurementCreateSchema.safeParse(body);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === path)).toBe(true);
  });

  it("rejects a client-sent metric value as an unknown shape? (extra keys are stripped, not trusted)", () => {
    const r = measurementCreateSchema.parse({ ...base, valueMetric: 1 });
    expect(r).not.toHaveProperty("valueMetric");
  });

  it("rejects a bad photo id, a missing date and an over-long note", () => {
    expect(measurementCreateSchema.safeParse({ ...base, photoId: "x" }).success).toBe(false);
    expect(measurementCreateSchema.safeParse({ ...base, measuredAt: undefined }).success).toBe(
      false,
    );
    expect(
      measurementCreateSchema.safeParse({ ...base, note: "x".repeat(MEASUREMENT_NOTE_MAX + 1) })
        .success,
    ).toBe(false);
    expect(
      measurementCreateSchema.safeParse({ ...base, note: "x".repeat(MEASUREMENT_NOTE_MAX) })
        .success,
    ).toBe(true);
  });
});

describe("measurementUpdateSchema", () => {
  it("needs at least one key", () => {
    expect(measurementUpdateSchema.safeParse({}).success).toBe(false);
    expect(measurementUpdateSchema.safeParse({ note: null }).success).toBe(true);
    expect(measurementUpdateSchema.safeParse({ photoId: null }).success).toBe(true);
  });

  it("value and unit come together", () => {
    expect(measurementUpdateSchema.safeParse({ value: 5 }).success).toBe(false);
    expect(measurementUpdateSchema.safeParse({ unit: "kg" }).success).toBe(false);
    expect(measurementUpdateSchema.safeParse({ value: 5, unit: "kg" }).success).toBe(true);
  });

  it("changing kind needs value and unit and validates the three together", () => {
    expect(measurementUpdateSchema.safeParse({ kind: "height" }).success).toBe(false);
    expect(
      measurementUpdateSchema.safeParse({ kind: "height", value: 66, unit: "lb" }).success,
    ).toBe(false);
    expect(
      measurementUpdateSchema.safeParse({ kind: "height", value: 66, unit: "cm" }).success,
    ).toBe(true);
  });

  it("does not check the unit against the stored kind (the API does)", () => {
    expect(measurementUpdateSchema.safeParse({ value: 5, unit: "in" }).success).toBe(true);
  });
});
