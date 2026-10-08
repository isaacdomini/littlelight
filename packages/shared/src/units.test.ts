import { describe, expect, it } from "vitest";
import type { MeasurementKind, MeasurementUnit } from "./db-enums";
import {
  formatMeasurement,
  fromMetric,
  lbOzToGrams,
  MEASUREMENT_LIMITS,
  MEASUREMENT_UNITS_FOR_KIND,
  roundTo,
  splitLbOz,
  toMetric,
  unitIsValidForKind,
} from "./units";

describe("toMetric", () => {
  it("normalizes the documented examples", () => {
    expect(toMetric("weight", 7.5, "lb")).toBe(3401.943);
    expect(lbOzToGrams(7, 8)).toBe(3401.943);
    expect(toMetric("weight", 7 + 8 / 16, "lb")).toBe(3401.943);
    expect(toMetric("height", 66, "cm")).toBe(660);
    expect(toMetric("weight", 3.4, "kg")).toBe(3400);
    expect(toMetric("weight", 3400, "g")).toBe(3400);
    expect(toMetric("weight", 16, "oz")).toBe(453.592);
    expect(toMetric("height", 26, "in")).toBe(660.4);
    expect(toMetric("head", 350, "mm")).toBe(350);
    expect(toMetric("head", 14, "in")).toBe(355.6);
  });

  it("rejects a unit that does not fit the kind", () => {
    expect(() => toMetric("weight", 5, "in")).toThrow(RangeError);
    expect(() => toMetric("height", 5, "lb")).toThrow(RangeError);
    expect(() => toMetric("head", 5, "kg")).toThrow(RangeError);
    expect(() => toMetric("weight", 5, "bogus" as MeasurementUnit)).toThrow(RangeError);
  });

  it("rejects non-finite values", () => {
    expect(() => toMetric("weight", Number.NaN, "kg")).toThrow(RangeError);
    expect(() => toMetric("weight", Number.POSITIVE_INFINITY, "kg")).toThrow(RangeError);
  });
});

describe("unitIsValidForKind", () => {
  it("matches MEASUREMENT_UNITS_FOR_KIND exactly", () => {
    const all: MeasurementUnit[] = ["g", "kg", "oz", "lb", "mm", "cm", "in"];
    for (const kind of ["weight", "height", "head"] as MeasurementKind[])
      for (const u of all)
        expect(unitIsValidForKind(kind, u)).toBe(MEASUREMENT_UNITS_FOR_KIND[kind].includes(u));
    expect(unitIsValidForKind("weight", "kg")).toBe(true);
    expect(unitIsValidForKind("weight", "cm")).toBe(false);
    expect(unitIsValidForKind("height", "in")).toBe(true);
    expect(unitIsValidForKind("height", "nope")).toBe(false);
  });
});

describe("roundTo", () => {
  it("rounds half away from zero and snaps binary noise", () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(-1.005, 2)).toBe(-1.01);
    expect(roundTo(3401.9427749999995, 3)).toBe(3401.943);
    expect(roundTo(-0.0001, 2)).toBe(0);
    expect(Object.is(roundTo(-0.0001, 2), -0)).toBe(false);
  });
});

describe("display", () => {
  it("fromMetric follows the profile units", () => {
    expect(fromMetric("weight", 3401.943, "metric")).toEqual({ value: 3.4, unit: "kg" });
    expect(fromMetric("weight", 3401.943, "imperial")).toEqual({ value: 7.5, unit: "lb" });
    expect(fromMetric("height", 660, "metric")).toEqual({ value: 66, unit: "cm" });
    expect(fromMetric("height", 660, "imperial")).toEqual({ value: 26, unit: "in" });
    expect(fromMetric("head", 350, "metric")).toEqual({ value: 35, unit: "cm" });
    expect(() => fromMetric("weight", Number.NaN, "metric")).toThrow(RangeError);
  });

  it("formatMeasurement strings", () => {
    expect(formatMeasurement("weight", 3401.943, "metric")).toBe("3.40 kg");
    expect(formatMeasurement("weight", 3401.943, "imperial")).toBe("7 lb 8.0 oz");
    expect(formatMeasurement("height", 660, "metric")).toBe("66.0 cm");
    expect(formatMeasurement("height", 660, "imperial")).toBe("26.0 in");
    expect(formatMeasurement("head", 355.6, "imperial")).toBe("14.0 in");
  });

  it("splitLbOz carries 16.0 oz into the pounds and rejects bad input", () => {
    expect(splitLbOz(3401.943)).toEqual({ lb: 7, oz: 8 });
    expect(splitLbOz(0)).toEqual({ lb: 0, oz: 0 });
    const almostTwoLb = 2 * 453.59237 - 0.01;
    expect(splitLbOz(almostTwoLb)).toEqual({ lb: 2, oz: 0 });
    expect(() => splitLbOz(-1)).toThrow(RangeError);
    expect(() => splitLbOz(Number.NaN)).toThrow(RangeError);
  });

  it("imperial round trip: enter lb + oz, store, display the same", () => {
    for (let lb = 0; lb <= 30; lb++) {
      for (const oz of [0, 0.5, 4, 8, 12, 15.5]) {
        const g = lbOzToGrams(lb, oz);
        const back = splitLbOz(g);
        expect(back.lb * 16 + back.oz, `${lb} lb ${oz} oz`).toBeCloseTo(lb * 16 + oz, 1);
      }
    }
  });

  it("metric round trip for lengths", () => {
    for (let cm = 20; cm <= 150; cm += 0.5) {
      expect(fromMetric("height", toMetric("height", cm, "cm"), "metric").value).toBe(cm);
    }
  });
});

describe("MEASUREMENT_LIMITS", () => {
  it("are 0.2-50 kg, 20-150 cm, 20-70 cm in storage units", () => {
    expect(MEASUREMENT_LIMITS).toEqual({
      weight: { min: 200, max: 50_000 },
      height: { min: 200, max: 1_500 },
      head: { min: 200, max: 700 },
    });
  });
});
