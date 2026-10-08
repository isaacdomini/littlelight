import type { Measurement, MeasurementKind, MeasurementUnit } from "@littlelight/shared";
import type { Tx } from "../auth";

// Measurement reads shared by `/babies/:id/measurements`, `/measurements/:id` and
// `GET /photos/:id` (docs/plans/step-5.md 2.4, 2.7). Run under the caller's claims (RLS: members
// of the baby read). Values and notes are never logged.

/** Columns of `measurementSchema` (alias `ms`). */
export const MEASUREMENT_COLUMNS = `
  ms.id, ms.baby_id, ms.photo_id, ms.kind, ms.value_metric, ms.value_entered, ms.unit_entered,
  ms.measured_at, ms.note, ms.created_at, ms.updated_at`;

export interface MeasurementRow {
  id: string;
  baby_id: string;
  photo_id: string | null;
  kind: MeasurementKind;
  /** `numeric(10,3)`: node-postgres returns text. */
  value_metric: string;
  value_entered: string;
  unit_entered: MeasurementUnit;
  measured_at: Date;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toMeasurement(r: MeasurementRow): Measurement {
  return {
    id: r.id,
    babyId: r.baby_id,
    photoId: r.photo_id,
    kind: r.kind,
    valueMetric: Number(r.value_metric),
    valueEntered: Number(r.value_entered),
    unitEntered: r.unit_entered,
    measuredAt: r.measured_at.toISOString(),
    note: r.note,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Measurements linked to a photo (RLS: members of its baby), by `measured_at` ascending. */
export async function photoMeasurements(client: Tx, photoId: string): Promise<Measurement[]> {
  const { rows } = await client.query<MeasurementRow>(
    `SELECT ${MEASUREMENT_COLUMNS} FROM public.measurements ms
      WHERE ms.photo_id = $1 ORDER BY ms.measured_at, ms.id`,
    [photoId],
  );
  return rows.map(toMeasurement);
}
