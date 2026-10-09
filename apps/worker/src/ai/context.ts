import type { VisionContext } from "@littlelight/ai";

// Per-photo prompt context (PRD FR-5.4; docs/plans/step-6.md 2.6 "Submit"). Built from the
// `LOAD_PENDING_SQL` row only: age, capture date/time (local wall clock), a coarse place label
// and the parents' people / note / milestone name. There is no coordinate field to fill, no GPS
// column is ever selected, and the baby's name is not part of it. Never logged.

export interface PendingRow {
  photo_id: string;
  baby_id: string;
  attempt: number;
  storage_key: string | null;
  age_days: number | null;
  taken_at: Date | null;
  taken_at_estimated: boolean | null;
  exif_taken_at: Date | null;
  tz_offset_minutes: number | null;
  place_label: string | null;
  people: string[] | null;
  note: string | null;
  location_label: string | null;
  milestone_name: string | null;
}

function validDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * Capture time as the model should read it:
 * - EXIF time with a known offset ⇒ local wall-clock date-time (`2026-06-14T10:42:00`);
 * - EXIF time without an offset, or a non-estimated `photos.taken_at` ⇒ the date only (the local
 *   hour is unknown, so none is claimed);
 * - an estimated time (upload time fallback) ⇒ nothing.
 */
export function captureTime(
  row: Pick<PendingRow, "exif_taken_at" | "tz_offset_minutes" | "taken_at" | "taken_at_estimated">,
): string | null {
  if (validDate(row.exif_taken_at)) {
    if (typeof row.tz_offset_minutes === "number" && Number.isFinite(row.tz_offset_minutes)) {
      const local = new Date(row.exif_taken_at.getTime() + row.tz_offset_minutes * 60_000);
      return local.toISOString().slice(0, 19);
    }
    return row.exif_taken_at.toISOString().slice(0, 10);
  }
  if (validDate(row.taken_at) && row.taken_at_estimated === false) {
    return row.taken_at.toISOString().slice(0, 10);
  }
  return null;
}

/** `VisionContext` for one pending item. The parents' location label wins over the EXIF place label. */
export function buildVisionContext(row: PendingRow): VisionContext {
  const place = row.location_label?.trim() || row.place_label?.trim() || null;
  return {
    babyAgeDays:
      typeof row.age_days === "number" && Number.isFinite(row.age_days) ? row.age_days : null,
    takenAt: captureTime(row),
    placeLabel: place,
    people: Array.isArray(row.people)
      ? row.people.filter((p) => typeof p === "string" && p.trim())
      : [],
    milestone: row.milestone_name?.trim() || null,
    parentNotes: row.note?.trim() || null,
  };
}
