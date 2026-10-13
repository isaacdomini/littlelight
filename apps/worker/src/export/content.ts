import {
  AI_FIELD_OVERRIDABLE,
  type AiDescriptionV1,
  type AiOverrides,
  aiDescriptionV1Schema,
  aiOverrideValueSchema,
  applyAiOverrides,
  EXPORT_FORMAT_VERSION,
  EXPORT_PHOTOS_CSV_VIDEO_COLUMNS,
} from "@tinyglow/shared";
import { type CsvValue, csvHeader, csvRow } from "./csv";

// Pure content builders of the export ZIP (docs/plans/review-fixes.md 2.3, layout version
// `EXPORT_FORMAT_VERSION`). No I/O: the handler feeds database rows in and appends the output.
// GPS appears only when the row carries `gps_lat`/`gps_lng`, which only the decrypting
// statement selects (sql.ts); without `includeLocation` the `gps_*` columns are omitted from
// `photos.csv` (not blank) and `photos.json` has no `gps` key. Step 12 (docs/plans/step-12.md
// 2.6): videos are exported like photos (`originals/<date>_<id>.mov|mp4`, byte-identical) and
// `photos.csv` / `photos.json` carry `media_kind`, `duration_ms`, `video_codec`
// (`EXPORT_PHOTOS_CSV_VIDEO_COLUMNS`).

/** One photo of the export's photo set, in ZIP order (manifest pass). */
export interface ManifestEntry {
  id: string;
  storageKey: string;
  mime: string | null;
  bytes: number;
  /** ZIP entry date: capture time, else upload time. */
  entryDate: Date;
  /** `originals/<YYYY-MM-DD>_<id>.<ext>` */
  file: string;
}

const EXT_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
});

/** File extension of an original (`bin` while the type is not known yet). */
export function extensionFor(mime: string | null | undefined): string {
  return (mime && EXT_BY_MIME[mime]) || "bin";
}

/** `originals/<date>_<photoId>.<ext>`: ids and a date only (no parent text in file names). */
export function originalFileName(fileDate: string, photoId: string, mime: string | null): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(fileDate) ? fileDate : "undated";
  return `originals/${date}_${photoId}.${extensionFor(mime)}`;
}

/** Metadata row of one photo (sql.ts `PHOTO_ROWS_SQL` / `PHOTO_ROWS_WITH_GPS_SQL`). */
export interface PhotoMetaRow {
  id: string;
  taken_at: Date | null;
  taken_at_estimated: boolean;
  tz_offset_minutes: number | null;
  age_days: number | null;
  status: string;
  approval: string;
  is_sensitive: boolean;
  uploaded_by_name: string | null;
  width: number | null;
  height: number | null;
  bytes: string | null;
  mime: string | null;
  sha256: string | null;
  /** Step 12: `photo` | `video`; `duration_ms` / `video_codec` for videos. */
  media_kind?: string | null;
  duration_ms?: number | null;
  video_codec?: string | null;
  milestone_id: string | null;
  milestone_name: string | null;
  milestone_category: string | null;
  people: string[] | null;
  note: string | null;
  location_label: string | null;
  exif_taken_at: Date | null;
  place_label: string | null;
  camera_make: string | null;
  camera_model: string | null;
  orientation: number | null;
  ai_model: string | null;
  ai_prompt_version: string | null;
  ai_schema_version: string | null;
  ai_description: unknown;
  ai_sensitive_flags: string[] | null;
  ai_analyzed_at: Date | null;
  ai_overrides: Record<string, unknown> | null;
  /** Present only in rows of the decrypting statement. */
  gps_lat?: number | null;
  gps_lng?: number | null;
}

export const PHOTOS_CSV_COLUMNS = [
  "file",
  "photo_id",
  "taken_at",
  "taken_at_estimated",
  "tz_offset_minutes",
  "age_days",
  "status",
  "approval",
  "is_sensitive",
  "uploaded_by",
  "width",
  "height",
  "bytes",
  "mime",
  "sha256",
  "milestone",
  "people",
  "note",
  "location_label",
  "place_label",
  "camera_make",
  "camera_model",
  "ai_caption",
  "ai_tags",
  "ai_sensitive_flags",
  "ai_model",
  ...EXPORT_PHOTOS_CSV_VIDEO_COLUMNS,
] as const;

export const PHOTOS_CSV_GPS_COLUMNS = ["gps_lat", "gps_lng"] as const;

/** Header of `photos.csv` (`gps_lat,gps_lng` last, only with location). */
export function photosCsvHeader(includeLocation: boolean): string {
  return csvHeader(
    includeLocation ? [...PHOTOS_CSV_COLUMNS, ...PHOTOS_CSV_GPS_COLUMNS] : PHOTOS_CSV_COLUMNS,
  );
}

const iso = (d: Date | null | undefined): string | null =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Valid overrides only (same rule as the api's `photoAiOverrides`). */
export function validOverrides(raw: Record<string, unknown> | null | undefined): AiOverrides {
  const out: AiOverrides = {};
  if (!raw) return out;
  for (const field of AI_FIELD_OVERRIDABLE) {
    if (!(field in raw)) continue;
    const parsed = aiOverrideValueSchema(field).safeParse(raw[field]);
    if (parsed.success) (out as Record<string, unknown>)[field] = parsed.data;
  }
  return out;
}

/** The description as shown in the app (overrides win), or null when none/unparseable. */
export function shownDescription(row: PhotoMetaRow): AiDescriptionV1 | null {
  if (row.ai_description === null || row.ai_description === undefined) return null;
  const parsed = aiDescriptionV1Schema.safeParse(row.ai_description);
  if (!parsed.success) return null;
  return applyAiOverrides(parsed.data, validOverrides(row.ai_overrides));
}

const hasGps = (row: PhotoMetaRow): boolean =>
  typeof row.gps_lat === "number" &&
  typeof row.gps_lng === "number" &&
  Number.isFinite(row.gps_lat) &&
  Number.isFinite(row.gps_lng);

/** One `photos.csv` record. `gps_*` cells only with `includeLocation` (else the columns do not exist). */
export function photoCsvRow(file: string, row: PhotoMetaRow, includeLocation: boolean): string {
  const ai = shownDescription(row);
  const values: CsvValue[] = [
    file,
    row.id,
    iso(row.taken_at),
    row.taken_at_estimated,
    row.tz_offset_minutes,
    row.age_days,
    row.status,
    row.approval,
    row.is_sensitive,
    row.uploaded_by_name,
    row.width,
    row.height,
    num(row.bytes),
    row.mime,
    row.sha256,
    row.milestone_name,
    (row.people ?? []).join(";"),
    row.note,
    row.location_label,
    row.place_label,
    row.camera_make,
    row.camera_model,
    ai?.caption ?? null,
    ai ? ai.search_tags.join(";") : null,
    (row.ai_sensitive_flags ?? []).join(";"),
    row.ai_model,
    row.media_kind ?? "photo",
    row.duration_ms ?? null,
    row.video_codec ?? null,
  ];
  if (includeLocation) {
    const gps = hasGps(row);
    values.push(gps ? (row.gps_lat as number) : null, gps ? (row.gps_lng as number) : null);
  }
  return csvRow(values);
}

/** One `photos.json` element (no `raw_json` EXIF, no raw model output). */
export function photoJson(
  file: string,
  row: PhotoMetaRow,
  includeLocation: boolean,
): Record<string, unknown> {
  const description = shownDescription(row);
  const exif: Record<string, unknown> = {
    takenAt: iso(row.exif_taken_at),
    tzOffsetMinutes: row.tz_offset_minutes,
    placeLabel: row.place_label,
    cameraMake: row.camera_make,
    cameraModel: row.camera_model,
    orientation: row.orientation,
  };
  if (includeLocation) {
    exif.gps = hasGps(row) ? { lat: row.gps_lat, lng: row.gps_lng } : null;
  }
  const analyzed = row.ai_model !== null && row.ai_model !== undefined;
  return {
    file,
    photoId: row.id,
    takenAt: iso(row.taken_at),
    takenAtEstimated: row.taken_at_estimated,
    tzOffsetMinutes: row.tz_offset_minutes,
    ageDays: row.age_days,
    status: row.status,
    approval: row.approval,
    isSensitive: row.is_sensitive,
    uploadedBy: row.uploaded_by_name,
    width: row.width,
    height: row.height,
    bytes: num(row.bytes),
    mime: row.mime,
    sha256: row.sha256,
    mediaKind: row.media_kind ?? "photo",
    durationMs: row.duration_ms ?? null,
    videoCodec: row.video_codec ?? null,
    details: {
      milestone: row.milestone_name
        ? { name: row.milestone_name, category: row.milestone_category }
        : null,
      note: row.note,
      people: row.people ?? [],
      locationLabel: row.location_label,
    },
    exif,
    ai: analyzed
      ? {
          description,
          overrides: validOverrides(row.ai_overrides),
          sensitiveFlags: row.ai_sensitive_flags ?? [],
          model: row.ai_model,
          promptVersion: row.ai_prompt_version,
          schemaVersion: row.ai_schema_version,
          analyzedAt: iso(row.ai_analyzed_at),
        }
      : null,
  };
}

export const MILESTONES_CSV_COLUMNS = [
  "id",
  "name",
  "category",
  "is_preset",
  "photo_count",
] as const;

export interface MilestoneRow {
  id: string;
  name: string;
  category: string;
  is_preset: boolean;
}

/**
 * `milestones.csv` body rows: every milestone of the baby, plus the presets used by at least one
 * exported photo (the unused presets are the same for every album).
 */
export function milestoneCsvRows(
  rows: readonly MilestoneRow[],
  counts: ReadonlyMap<string, number>,
): { csv: string; count: number } {
  let csv = "";
  let count = 0;
  for (const m of rows) {
    const n = counts.get(m.id) ?? 0;
    if (m.is_preset && n === 0) continue;
    csv += csvRow([m.id, m.name, m.category, m.is_preset, n]);
    count++;
  }
  return { csv, count };
}

export const MEASUREMENTS_CSV_COLUMNS = [
  "id",
  "kind",
  "value_metric",
  "value_entered",
  "unit_entered",
  "measured_at",
  "note",
  "photo_file",
] as const;

export interface MeasurementRow {
  id: string;
  kind: string;
  value_metric: string;
  value_entered: string;
  unit_entered: string;
  measured_at: Date;
  cursor_at: string;
  note: string | null;
  photo_id: string | null;
}

/** One `measurements.csv` record; `photo_file` only when the linked photo is in the export. */
export function measurementCsvRow(
  row: MeasurementRow,
  fileOf: (photoId: string) => string | undefined,
): string {
  return csvRow([
    row.id,
    row.kind,
    num(row.value_metric),
    num(row.value_entered),
    row.unit_entered,
    iso(row.measured_at),
    row.note,
    row.photo_id ? (fileOf(row.photo_id) ?? null) : null,
  ]);
}

export interface BabyRow {
  id: string;
  name: string;
  nickname: string | null;
  birth_date: string | null;
  birth_date_is_due_date: boolean;
  birth_weight_g: number | null;
  birth_length_mm: number | null;
  home_label: string | null;
}

export interface MemberRow {
  display_name: string | null;
  relationship_label: string | null;
  role: string;
}

/** `album.json`: no plan/billing, no coordinates, no emails, no user ids. */
export function albumJson(input: {
  exportedAt: Date;
  includeLocation: boolean;
  baby: BabyRow;
  members: readonly MemberRow[];
  counts: { photos: number; milestones: number; measurements: number };
}): string {
  const { baby } = input;
  return `${JSON.stringify(
    {
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: input.exportedAt.toISOString(),
      includeLocation: input.includeLocation,
      baby: {
        id: baby.id,
        name: baby.name,
        nickname: baby.nickname,
        birthDate: baby.birth_date,
        birthDateIsDueDate: baby.birth_date_is_due_date,
        birthWeightG: baby.birth_weight_g,
        birthLengthMm: baby.birth_length_mm,
        homeLabel: baby.home_label,
      },
      members: input.members.map((m) => ({
        displayName: m.display_name,
        relationshipLabel: m.relationship_label,
        role: m.role,
      })),
      counts: input.counts,
    },
    null,
    2,
  )}\n`;
}

/** `README.txt` (plain text, CRLF so Notepad shows it too). */
export function readmeText(input: { exportedAt: Date; includeLocation: boolean }): string {
  const lines = [
    "Tinyglow album export",
    "========================",
    "",
    `format_version: ${EXPORT_FORMAT_VERSION}`,
    `exported_at: ${input.exportedAt.toISOString()}`,
    `include_location: ${input.includeLocation}`,
    "",
    "What is in this ZIP",
    "-------------------",
    "originals/        Every photo and video of the album (trash, rejected and failed uploads",
    "                  are not included), named <capture date>_<photo id>.<extension>. Original",
    "                  files are byte-identical to what was uploaded and keep their own embedded",
    "                  metadata, including any location the camera recorded; videos (.mov/.mp4)",
    "                  are included as uploaded.",
    "photos.csv        One row per photo or video: dates, age, milestone, people, notes, place,",
    "                  camera, AI caption and tags, media_kind (photo/video), duration_ms and",
    "                  video_codec for videos. Multiple people / tags are separated by ';'.",
    "                  Cells that a spreadsheet would treat as a formula start with an",
    "                  apostrophe ('); photos.json has the exact text.",
    "photos.json       The same photos with full details, EXIF summary and the AI description",
    "                  (with your edits applied).",
    "milestones.csv    The album's milestones with the number of exported photos for each.",
    "measurements.csv  Weight, height and head measurements (value_metric is grams or",
    "                  millimetres) and the photo they are linked to, if any.",
    "album.json        The baby's profile, the album's members and their roles, and counts.",
    "",
    input.includeLocation
      ? "photos.csv has gps_lat/gps_lng columns and photos.json an exif.gps value where the photo had a location."
      : "Photo locations were not included in photos.csv / photos.json (the original files may still contain them).",
    "",
    "Dates are ISO 8601 in UTC; tz_offset_minutes is the camera's offset from UTC when known.",
    "",
  ];
  return lines.join("\r\n");
}
