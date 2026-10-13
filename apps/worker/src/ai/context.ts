import type { VisionContext } from "@tinyglow/ai";
import { AI_VIDEO_MAX_FRAMES } from "@tinyglow/shared";

// Per-photo prompt context (PRD FR-5.4; docs/plans/step-6.md 2.6 "Submit"). Built from the
// `LOAD_PENDING_SQL` row only: age, capture date/time (local wall clock), a coarse place label
// and the parents' people / note / milestone name. There is no coordinate field to fill, no GPS
// column is ever selected, and the baby's name is not part of it. Never logged.
// Step 12 (docs/plans/step-12.md 2.7): a video row adds `media` (duration in whole seconds and
// the number of frames the request carries: poster + keyframes, up to `AI_VIDEO_MAX_FRAMES`).

export interface PendingRow {
  photo_id: string;
  baby_id: string;
  attempt: number;
  /** The `analysis` derivative (a video's poster frame). */
  storage_key: string | null;
  /** `photos.media_kind` (absent in rows from before step 12 ⇒ photo). */
  media_kind?: "photo" | "video" | null;
  /** `photos.duration_ms` (videos). */
  duration_ms?: number | null;
  /** `keyframe1..3` derivative keys in kind order (videos after transcode; `[]` otherwise). */
  keyframe_keys?: string[] | null;
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

/** True for a `media_kind = 'video'` row. */
export function isVideoRow(row: Pick<PendingRow, "media_kind">): boolean {
  return row.media_kind === "video";
}

/**
 * Keyframe keys of a video row, deduplicated, at most `AI_VIDEO_MAX_FRAMES - 1` (the poster is
 * the first image). Photos get none, whatever the row says.
 */
export function keyframeKeys(row: Pick<PendingRow, "media_kind" | "keyframe_keys">): string[] {
  if (!isVideoRow(row) || !Array.isArray(row.keyframe_keys)) return [];
  const keys = [...new Set(row.keyframe_keys.filter((k) => typeof k === "string" && k))];
  return keys.slice(0, AI_VIDEO_MAX_FRAMES - 1);
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

/**
 * `VisionContext` for one pending item. The parents' location label wins over the EXIF place
 * label. `frameCount` is how many images the request carries (poster + loaded keyframes); it
 * only matters for a video row, which gets `media` (duration rounded to whole seconds, ≥ 1).
 */
export function buildVisionContext(row: PendingRow, frameCount = 1): VisionContext {
  const place = row.location_label?.trim() || row.place_label?.trim() || null;
  const context: VisionContext = {
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
  if (isVideoRow(row)) {
    const ms =
      typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms) ? row.duration_ms : 0;
    context.media = {
      kind: "video",
      durationSeconds: Math.max(1, Math.round(ms / 1000)),
      frameCount: Math.min(AI_VIDEO_MAX_FRAMES, Math.max(1, Math.round(frameCount))),
    };
  }
  return context;
}
