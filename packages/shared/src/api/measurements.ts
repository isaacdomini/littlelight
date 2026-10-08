import { z } from "zod";
import {
  type MeasurementKind,
  type MeasurementUnit,
  measurementKindSchema,
  measurementUnitSchema,
} from "../db-enums";
import { MEASUREMENT_LIMITS, toMetric, unitIsValidForKind } from "../units";
import { isoDateTimeSchema } from "./common";

// `/api/babies/:id/measurements` and `/api/measurements/:id` contracts (docs/plans/step-5.md
// 2.4, 2.6, 2.7; PRD "Data model" → `measurements`). The server normalizes `{value, unit}` with
// `toMetric`; clients never send a metric value. Writes are admin-only (RLS). Values are never
// audited or logged.

/** Max length of a measurement note (trimmed). */
export const MEASUREMENT_NOTE_MAX = 2000;

/** Route params `/measurements/:id`. */
export const measurementIdParamsSchema = z.object({ id: z.uuid() });
export type MeasurementIdParams = z.infer<typeof measurementIdParamsSchema>;

/** A `measurements` row on the wire. `valueMetric` is grams (`weight`) or millimetres. */
export const measurementSchema = z.object({
  id: z.uuid(),
  babyId: z.uuid(),
  photoId: z.uuid().nullable(),
  kind: measurementKindSchema,
  valueMetric: z.number(),
  /** What the parent typed, with `unitEntered` (display fidelity, imperial round trip). */
  valueEntered: z.number(),
  unitEntered: measurementUnitSchema,
  measuredAt: isoDateTimeSchema,
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Measurement = z.infer<typeof measurementSchema>;

/**
 * Why `{value, unit}` is not acceptable for `kind`, or `null` when it is: the unit must be valid
 * for the kind (`unit` issue) and the normalized value must lie within `MEASUREMENT_LIMITS[kind]`
 * (`value` issue). Used by the request schemas and by the API when an update changes
 * `value`/`unit` of a row whose `kind` only the database knows. Messages name no values.
 */
export function measurementValueIssue(
  kind: MeasurementKind,
  value: number,
  unit: MeasurementUnit,
): { path: "unit" | "value"; message: string } | null {
  if (!unitIsValidForKind(kind, unit)) {
    return { path: "unit", message: `Unit is not valid for ${kind}` };
  }
  if (!Number.isFinite(value)) return { path: "value", message: "Value must be a number" };
  const metric = toMetric(kind, value, unit);
  const { min, max } = MEASUREMENT_LIMITS[kind];
  if (metric < min || metric > max) {
    return { path: "value", message: `Value is outside the accepted range for ${kind}` };
  }
  return null;
}

const noteSchema = z.string().trim().max(MEASUREMENT_NOTE_MAX).nullable();

/** `POST /babies/:id/measurements` → 201 `measurement`. */
export const measurementCreateSchema = z
  .object({
    kind: measurementKindSchema,
    value: z.number().positive(),
    unit: measurementUnitSchema,
    measuredAt: isoDateTimeSchema,
    photoId: z.uuid().nullish(),
    note: noteSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const issue = measurementValueIssue(v.kind, v.value, v.unit);
    if (issue) ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
  });
export type MeasurementCreate = z.infer<typeof measurementCreateSchema>;

/**
 * `PATCH /measurements/:id` → `measurement`. Any subset, at least one key. `value` and `unit`
 * come together; changing `kind` needs both too (the old unit may not fit the new kind). When
 * all three are present they are checked here; with `value`/`unit` only, the API checks them
 * against the row's kind with `measurementValueIssue` (400 `validation_failed`).
 */
export const measurementUpdateSchema = z
  .object({
    kind: measurementKindSchema.optional(),
    value: z.number().positive().optional(),
    unit: measurementUnitSchema.optional(),
    measuredAt: isoDateTimeSchema.optional(),
    photoId: z.uuid().nullable().optional(),
    note: noteSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({ code: "custom", path: [], message: "Nothing to update" });
      return;
    }
    if ((v.value === undefined) !== (v.unit === undefined)) {
      const path = v.value === undefined ? "value" : "unit";
      ctx.addIssue({ code: "custom", path: [path], message: "value and unit must come together" });
      return;
    }
    if (v.kind !== undefined && v.value === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Changing kind needs value and unit",
      });
      return;
    }
    if (v.kind !== undefined && v.value !== undefined && v.unit !== undefined) {
      const issue = measurementValueIssue(v.kind, v.value, v.unit);
      if (issue) ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
    }
  });
export type MeasurementUpdate = z.infer<typeof measurementUpdateSchema>;

/** `GET /babies/:id/measurements` query. */
export const measurementsListQuerySchema = z.object({
  kind: measurementKindSchema.optional(),
});
export type MeasurementsListQuery = z.infer<typeof measurementsListQuerySchema>;

/** Ordered by `measuredAt` ascending; at most 2,000 rows (no paging). */
export const measurementsListResponseSchema = z.object({
  measurements: z.array(measurementSchema),
});
export type MeasurementsListResponse = z.infer<typeof measurementsListResponseSchema>;
