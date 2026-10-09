import { z } from "zod";
import { formatAge } from "./age";
import {
  type AiDescriptionV1,
  aiDescriptionV1Schema,
  looksLikeCoordinates,
} from "./ai-description";
import { type MeasurementKind, measurementKindSchema } from "./db-enums";
import { roundTo } from "./units";

// The search document (PRD "Search document (what gets embedded)", FR-6.3, FR-6.4;
// docs/plans/step-7.md 2.4). One short natural-language string per photo, embedded with
// `text-embedding-3-small` (1024 dims) and indexed as a tsvector, plus the structured columns the
// retriever filters on first (`photo_search.tags`, `people`, `place`, `milestone_ids`,
// `is_sensitive`). Browser-safe: `zod` and this package only (no `node:*`; the worker hashes).
//
// Rules:
// - The baby's name is never part of it (plan D2): the input has no field for it.
// - No coordinates: there is no GPS field, and place/note/text-in-image values that look like
//   coordinates (`looksLikeCoordinates`) are blanked with a `coordinates_blanked` warning.
// - FR-5.6: `ai` arrives override-merged (`applyAiOverrides`), so parents' edits win.
// - Deterministic: same input ⇒ byte-identical output (fixed field order, NFC, collapsed
//   whitespace, sorted measurements), so `content_hash = sha256(text)` skips unchanged documents.
// - Absent fields are omitted, never rendered as "unknown".
// - It contains parent notes: never log it; it never leaves the database layer except as an
//   embedding request (tool results and API responses never carry `search_text`).

/** Bump when the template below changes; `search.backfill {reason: "model"}` re-embeds. */
export const SEARCH_DOC_VERSION = "v1";

/** Caps (characters / items) applied while building; the total `text` is capped last. */
export const SEARCH_DOC_LIMITS = {
  text: 4000,
  note: 600,
  tags: 30,
  people: 20,
} as const;

/** Longest single tag kept in `tags` (longer values stay in the text only). */
const TAG_MAX_CHARS = 60;
/** Linked measurements rendered (a photo rarely has more than three). */
const MEASUREMENTS_MAX = 10;

const takenAtLocalSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]);

/**
 * What the indexer reads for one photo (strict: no name, no coordinates, no account fields).
 * Bounds are loose on purpose (the database already caps parent text); the builder applies the
 * `SEARCH_DOC_LIMITS`.
 */
export const searchDocumentInputSchema = z.strictObject({
  /** `photos.age_days` (negative before birth). */
  ageDays: z.number().int().nullable(),
  /**
   * Local wall-clock capture time: `YYYY-MM-DD` or an ISO date-time (as the worker's
   * `captureTime()` produces), or the `sort_at` date when the time is estimated.
   */
  takenAtLocal: takenAtLocalSchema.nullable(),
  /** `photos.taken_at_estimated`: renders "around <date>" and no weekday / clock time of day. */
  takenAtEstimated: z.boolean(),
  /** Coarse place label: parents' `location_label`, else EXIF `place_label`. Never coordinates. */
  place: z.string().nullable(),
  /** The tagged milestone (`photo_details.milestone_id` → `milestones.name`). */
  milestone: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  /** `photo_details.people`, as entered. */
  people: z.array(z.string()),
  /** `photo_details.note` (sensitive: never logged). */
  note: z.string().nullable(),
  /** Measurements linked to the photo. `valueMetric`: grams (weight) or millimetres. */
  measurements: z.array(
    z.strictObject({
      kind: measurementKindSchema,
      valueMetric: z.number().positive(),
      measuredAt: z.iso.datetime({ offset: true }),
    }),
  ),
  /** `photo_ai.description` with `photo_ai_overrides` applied; null when not described. */
  ai: aiDescriptionV1Schema.nullable(),
  /** `photos.is_sensitive`. */
  isSensitive: z.boolean(),
});
export type SearchDocumentInput = z.input<typeof searchDocumentInputSchema>;

/** What the builder blanked or truncated (codes and field names, never the value). */
export type SearchDocumentWarning =
  | { code: "coordinates_blanked"; field: "place" | "note" | "text_in_image" }
  | { code: "truncated"; field: "note" | "text" };

export interface SearchDocument {
  /** `photo_search.search_text` (embedded and indexed). Contains parent notes: never log. */
  text: string;
  /** `photo_search.tags`: lower-cased, de-duplicated, ≤ 30. */
  tags: string[];
  /** `photo_search.people`: trimmed as entered, de-duplicated, ≤ 20. */
  people: string[];
  /** `photo_search.place`: lower-cased coarse label, or null. */
  place: string | null;
  /** `photo_search.milestone_ids`. */
  milestoneIds: string[];
  /** `photo_search.is_sensitive`. */
  isSensitive: boolean;
  /** `photo_search.doc_version` (`SEARCH_DOC_VERSION`). */
  docVersion: string;
  /** Safe to log (codes and field names only). */
  warnings: SearchDocumentWarning[];
}

// ---------------------------------------------------------------------------------------------
// Text helpers (pure, deterministic)
// ---------------------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** NFC, control characters removed, whitespace collapsed, trimmed; "" ⇒ null. */
function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const s = value.normalize("NFC").replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

const PLACEHOLDERS = new Set(["unknown", "none", "n/a", "na", "null", "-"]);

/** Like `clean`, and model placeholders ("unknown", "none", …) count as absent. */
function cleanModel(value: string | null | undefined): string | null {
  const s = clean(value);
  return s === null || PLACEHOLDERS.has(s.toLowerCase()) ? null : s;
}

/** Cleaned, non-empty, de-duplicated (exact, after cleaning) items in input order. */
function cleanList(values: readonly string[] | null | undefined, model = false): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values ?? []) {
    const s = model ? cleanModel(v) : clean(v);
    if (s === null || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** "a", "a and b", "a, b and c". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Ends `s` with a full stop unless it already ends with sentence punctuation. */
function sentence(s: string): string {
  return /[.!?…]["'”’)]*$/.test(s) ? s : `${s}.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Truncates to at most `max` UTF-16 units at a word boundary when one is close; never splits a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(" ");
  if (space >= max - 80) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Weekday of a `YYYY-MM-DD` calendar date. */
function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
}

/** Local hour (0..23) of an ISO date-time string, or null for a date. */
function localHour(takenAt: string): number | null {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):/.exec(takenAt);
  return m ? Number(m[1]) : null;
}

/** 05–11 morning, 12–16 afternoon, 17–20 evening, 21–04 night. */
function timeOfDayFromHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

const MEASUREMENT_ORDER: Record<MeasurementKind, number> = { weight: 0, height: 1, head: 2 };

/** Metric, user-agnostic (the document is shared by both parents): "Weight 7.2 kg", "Height 68 cm". */
function formatDocMeasurement(kind: MeasurementKind, valueMetric: number): string {
  if (kind === "weight") return `Weight ${roundTo(valueMetric / 1000, 2)} kg`;
  const cm = roundTo(valueMetric / 10, 1);
  return kind === "height" ? `Height ${cm} cm` : `Head circumference ${cm} cm`;
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

/**
 * Builds the search document of one photo. Validates `input` with `searchDocumentInputSchema`
 * (throws a `ZodError` naming paths only for a malformed input, e.g. an unexpected `babyName`
 * or `latitude` key). Template, in this fixed order (absent parts omitted):
 *
 * `<age> (<date>), <weekday> <time of day> at <place>.` `Milestone: <name>.` `With <people>.`
 * `<caption> <detailed description>` `Wearing <clothing>.` `Doing: <activities>.`
 * `Seen: <objects>.` `<Indoor/outdoor>, <place type>, <weather>.` `Mood: <mood>.`
 * `Occasion: <occasion>.` `Tags: <search tags>.` `Text in photo: "<text>".`
 * `<Weight 7.2 kg; Height 68 cm>.` `Note from parent: "<note>".`
 *
 * An estimated capture time renders "around <date>" with no weekday and no clock-derived time of
 * day. The time of day is the model's `setting.time_of_day`, else derived from the local hour.
 */
export function buildSearchDocument(rawInput: SearchDocumentInput): SearchDocument {
  const input = searchDocumentInputSchema.parse(rawInput);
  const ai: AiDescriptionV1 | null = input.ai;
  const warnings: SearchDocumentWarning[] = [];
  const parts: string[] = [];

  // Coordinates tripwire (never trusted as the guarantee: no GPS column is ever read).
  let place = clean(input.place);
  if (place !== null && looksLikeCoordinates(place)) {
    place = null;
    warnings.push({ code: "coordinates_blanked", field: "place" });
  }
  let note = clean(input.note);
  if (note !== null && looksLikeCoordinates(note)) {
    note = null;
    warnings.push({ code: "coordinates_blanked", field: "note" });
  }
  let textInImage = cleanModel(ai?.text_in_image);
  if (textInImage !== null && looksLikeCoordinates(textInImage)) {
    textInImage = null;
    warnings.push({ code: "coordinates_blanked", field: "text_in_image" });
  }

  // 1. "<age> (<date>), <weekday> <time of day> at <place>."
  const date = input.takenAtLocal?.slice(0, 10) ?? null;
  const dateText = date === null ? null : input.takenAtEstimated ? `around ${date}` : date;
  const age = input.ageDays === null ? null : formatAge(input.ageDays);
  const first = age !== null ? (dateText !== null ? `${age} (${dateText})` : age) : dateText;
  const hour =
    input.takenAtLocal !== null && !input.takenAtEstimated ? localHour(input.takenAtLocal) : null;
  const timeOfDay =
    cleanModel(ai?.setting.time_of_day)?.toLowerCase() ??
    (hour !== null ? timeOfDayFromHour(hour) : null);
  const day = date !== null && !input.takenAtEstimated ? weekday(date) : null;
  const when = [day, timeOfDay].filter((x): x is string => x !== null).join(" ") || null;
  let head = [first, when].filter((x): x is string => x !== null).join(", ");
  if (place !== null) head = head === "" ? `At ${place}` : `${head} at ${place}`;
  if (head !== "") parts.push(sentence(capitalize(head)));

  // 2. Milestone, people.
  const milestoneName = input.milestone ? clean(input.milestone.name) : null;
  if (milestoneName !== null) parts.push(sentence(`Milestone: ${milestoneName}`));
  const people = cleanList(input.people).slice(0, SEARCH_DOC_LIMITS.people);
  if (people.length > 0) parts.push(sentence(`With ${joinList(people)}`));

  // 3. The (override-merged) description.
  if (ai !== null) {
    const caption = cleanModel(ai.caption);
    const description = cleanModel(ai.detailed_description);
    const prose = [caption, description]
      .filter((x): x is string => x !== null)
      .map(sentence)
      .join(" ");
    if (prose !== "") parts.push(prose);

    const clothing = cleanList(ai.clothing, true);
    if (clothing.length > 0) parts.push(sentence(`Wearing ${joinList(clothing)}`));
    const activities = cleanList(ai.activities, true);
    if (activities.length > 0) parts.push(sentence(`Doing: ${activities.join(", ")}`));
    const objects = cleanList(ai.objects, true);
    if (objects.length > 0) parts.push(sentence(`Seen: ${objects.join(", ")}`));

    const setting = [
      ai.setting.indoor_outdoor === "unknown" ? null : ai.setting.indoor_outdoor,
      cleanModel(ai.setting.place_type)?.toLowerCase() ?? null,
      cleanModel(ai.setting.weather)?.toLowerCase() ?? null,
    ].filter((x): x is string => x !== null);
    if (setting.length > 0) parts.push(sentence(capitalize(setting.join(", "))));

    const mood = cleanList(ai.mood, true);
    if (mood.length > 0) parts.push(sentence(`Mood: ${mood.join(", ")}`));
    const occasion = cleanModel(ai.occasion);
    if (occasion !== null) parts.push(sentence(`Occasion: ${occasion}`));
    const searchTags = cleanList(ai.search_tags, true);
    if (searchTags.length > 0) parts.push(sentence(`Tags: ${searchTags.join(", ")}`));
    if (textInImage !== null) parts.push(`Text in photo: "${textInImage}".`);
  }

  // 4. Linked measurements (metric; sorted so the hash is stable).
  const measurements = [...input.measurements]
    .sort(
      (a, b) =>
        Date.parse(a.measuredAt) - Date.parse(b.measuredAt) ||
        MEASUREMENT_ORDER[a.kind] - MEASUREMENT_ORDER[b.kind] ||
        a.valueMetric - b.valueMetric,
    )
    .slice(0, MEASUREMENTS_MAX)
    .map((m) => formatDocMeasurement(m.kind, m.valueMetric));
  if (measurements.length > 0) parts.push(sentence(measurements.join("; ")));

  // 5. The parent's note, last (quoted: it is data).
  if (note !== null) {
    if (note.length > SEARCH_DOC_LIMITS.note) {
      note = truncate(note, SEARCH_DOC_LIMITS.note);
      warnings.push({ code: "truncated", field: "note" });
    }
    parts.push(`Note from parent: "${note}"${/[.!?…]$/.test(note) ? "" : "."}`);
  }

  let text = parts.join(" ");
  if (text.length > SEARCH_DOC_LIMITS.text) {
    text = truncate(text, SEARCH_DOC_LIMITS.text);
    warnings.push({ code: "truncated", field: "text" });
  }

  return {
    text,
    tags: searchTagsFor(ai, milestoneName),
    people,
    place: place?.toLowerCase() ?? null,
    milestoneIds: input.milestone ? [input.milestone.id] : [],
    isSensitive: input.isSensitive,
    docVersion: SEARCH_DOC_VERSION,
    warnings,
  };
}

/**
 * `photo_search.tags`: the lower-cased, de-duplicated union of `search_tags` (override-merged),
 * `activities`, `setting.place_type`, `occasion`, `sensitive_content` and the milestone name, in
 * that order, at most `SEARCH_DOC_LIMITS.tags`; values longer than 60 characters are skipped.
 *
 * Also the tag set auto-share rules match (`ShareRuleFacts.tags`, docs/plans/step-8.md 2.4), so
 * the tags an admin sees in search facets are exactly the tags rules see. `ai` must already be
 * override-merged (`applyAiOverrides`); `milestoneName` is the parent-tagged milestone's name.
 */
export function searchTagsFor(ai: AiDescriptionV1 | null, milestoneName: string | null): string[] {
  const candidates: (string | null | undefined)[] = [
    ...(ai?.search_tags ?? []),
    ...(ai?.activities ?? []),
    ai?.setting.place_type,
    ai?.occasion,
    ...(ai?.sensitive_content ?? []),
    milestoneName,
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const tag = cleanModel(c)?.toLowerCase();
    if (tag === undefined || tag.length > TAG_MAX_CHARS || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length === SEARCH_DOC_LIMITS.tags) break;
  }
  return out;
}
