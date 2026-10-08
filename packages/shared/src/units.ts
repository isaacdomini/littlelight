import type { MeasurementKind, MeasurementUnit, Units } from "./db-enums";

// Measurement units and normalization (docs/plans/step-5.md 2.6, 2.7; PRD "Data model" →
// `measurements`). Storage is metric: `value_metric` is **grams** for `weight` and
// **millimetres** for `height`/`head`, `numeric(10,3)`. The **server** normalizes with `toMetric`
// (clients never send a metric value); `value_entered` + `unit_entered` keep what the parent
// typed. Display follows `profiles.units`: metric shows kg / cm, imperial shows lb (+ oz) / in.
// Round trip: 7 lb 8 oz → 3401.943 g → "7 lb 8.0 oz" (imperial) / "3.40 kg" (metric);
// 66 cm → 660 mm → "26.0 in". Pure functions, no zod, browser-safe.

/** Units a parent may enter for each kind. */
export const MEASUREMENT_UNITS_FOR_KIND: {
  readonly [K in MeasurementKind]: readonly MeasurementUnit[];
} = {
  weight: ["g", "kg", "oz", "lb"],
  height: ["mm", "cm", "in"],
  head: ["mm", "cm", "in"],
};

/**
 * Input sanity bounds in metric storage units (grams / millimetres), inclusive: weight
 * 0.2–50 kg, height 20–150 cm, head 20–70 cm. Not medical ranges; nothing interprets them.
 */
export const MEASUREMENT_LIMITS: {
  readonly [K in MeasurementKind]: { readonly min: number; readonly max: number };
} = {
  weight: { min: 200, max: 50_000 },
  height: { min: 200, max: 1_500 },
  head: { min: 200, max: 700 },
};

export const G_PER_LB = 453.59237;
export const G_PER_OZ = 28.349523125;
export const MM_PER_IN = 25.4;
export const OZ_PER_LB = 16;

/** Metric storage units per entered unit (grams for weights, millimetres for lengths). */
const METRIC_PER_UNIT: { readonly [U in MeasurementUnit]: number } = {
  g: 1,
  kg: 1000,
  oz: G_PER_OZ,
  lb: G_PER_LB,
  mm: 1,
  cm: 10,
  in: MM_PER_IN,
};

/**
 * Rounds half away from zero to `dp` decimals, first snapping binary noise to 15 significant
 * digits so `3401.9427749999997` rounds like `3401.942775` (and `1.005` to `1.01`).
 */
export function roundTo(x: number, dp: number): number {
  const scaled = Number((Math.abs(x) * 10 ** dp).toPrecision(15));
  const r = (Math.sign(x) * Math.round(scaled)) / 10 ** dp;
  return Object.is(r, -0) ? 0 : r;
}

function assertFinite(n: number, name: string): void {
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be a finite number`);
}

/** True when `unit` may be entered for `kind` (`weight`: g/kg/oz/lb; `height`/`head`: mm/cm/in). */
export function unitIsValidForKind(kind: MeasurementKind, unit: string): unit is MeasurementUnit {
  return (MEASUREMENT_UNITS_FOR_KIND[kind] as readonly string[]).includes(unit);
}

/**
 * Normalizes an entered value to storage units (grams or millimetres), rounded to 3 decimals:
 * `toMetric('weight', 7.5, 'lb') === 3401.943`, `toMetric('height', 66, 'cm') === 660`.
 * Throws `RangeError` when `unit` is not valid for `kind` or `value` is not finite. Does not
 * check `MEASUREMENT_LIMITS` (see `measurementValueIssue` in `api/measurements.ts`).
 */
export function toMetric(kind: MeasurementKind, value: number, unit: MeasurementUnit): number {
  if (!unitIsValidForKind(kind, unit))
    throw new RangeError(`unit ${unit} is not valid for ${kind}`);
  assertFinite(value, "value");
  return roundTo(value * METRIC_PER_UNIT[unit], 3);
}

/**
 * A stored metric value in the display unit of a profile: metric ⇒ `kg` (2 dp) / `cm` (1 dp),
 * imperial ⇒ `lb` (2 dp) / `in` (1 dp). For the lb + oz form use `splitLbOz`.
 */
export function fromMetric(
  kind: MeasurementKind,
  metric: number,
  units: Units,
): { value: number; unit: MeasurementUnit } {
  assertFinite(metric, "metric");
  if (kind === "weight") {
    return units === "imperial"
      ? { value: roundTo(metric / G_PER_LB, 2), unit: "lb" }
      : { value: roundTo(metric / 1000, 2), unit: "kg" };
  }
  return units === "imperial"
    ? { value: roundTo(metric / MM_PER_IN, 1), unit: "in" }
    : { value: roundTo(metric / 10, 1), unit: "cm" };
}

/**
 * Grams as whole pounds plus ounces (1 dp), carrying 16.0 oz into the pounds:
 * `splitLbOz(3401.943)` ⇒ `{ lb: 7, oz: 8 }`. Throws `RangeError` for a negative or non-finite
 * value.
 */
export function splitLbOz(grams: number): { lb: number; oz: number } {
  assertFinite(grams, "grams");
  if (grams < 0) throw new RangeError("grams must not be negative");
  const tenthsOz = Math.round(Number(((grams / G_PER_OZ) * 10).toPrecision(15)));
  const lb = Math.floor(tenthsOz / (OZ_PER_LB * 10));
  return { lb, oz: (tenthsOz - lb * OZ_PER_LB * 10) / 10 };
}

/**
 * Pounds + ounces to grams, rounded to 3 decimals like `toMetric`:
 * `lbOzToGrams(7, 8) === 3401.943`. The API takes a single `{value, unit: 'lb'}`; a client
 * entering lb + oz sends `value = lb + oz / 16`, which normalizes to the same grams.
 */
export function lbOzToGrams(lb: number, oz: number): number {
  assertFinite(lb, "lb");
  assertFinite(oz, "oz");
  return roundTo(lb * G_PER_LB + oz * G_PER_OZ, 3);
}

/**
 * Display string of a stored metric value in a profile's units: "3.40 kg", "7 lb 8.0 oz",
 * "66.0 cm", "26.0 in".
 */
export function formatMeasurement(kind: MeasurementKind, metric: number, units: Units): string {
  if (kind === "weight" && units === "imperial") {
    const { lb, oz } = splitLbOz(metric);
    return `${lb} lb ${oz.toFixed(1)} oz`;
  }
  const { value, unit } = fromMetric(kind, metric, units);
  return `${value.toFixed(kind === "weight" ? 2 : 1)} ${unit}`;
}
