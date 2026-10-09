import {
  type AiDescriptionV1,
  aiDescriptionV1Schema,
  applyAiOverrides,
  measurementKindSchema,
  type SearchDocumentInput,
} from "@littlelight/shared";

// SQL and row mapping of the search indexer (docs/plans/step-7.md 2.6). Every statement runs as
// `pipeline` inside `runAsPipeline(pool, {}, …)` — never with the data key — and no statement here
// selects a GPS column (`photo_exif.gps_*_enc`) or `raw_json`, nor the baby's name (D2). Exported
// as consts so unit tests can answer them by exact text, and so the dev search seed builds its
// fixture rows through exactly the same read + mapping (its hashes then match the worker's).

/**
 * Everything one search document needs, for a set of photo ids. `ai_enabled` is the paid-tier
 * gate (`baby_ai_enabled`); `live` says whether the photo may be indexed at all. Overrides and
 * linked measurements come aggregated as JSON. The current `photo_search` bookkeeping
 * (`content_hash`, `embed_model`, `doc_version`, vector presence) decides whether a document must
 * be re-embedded.
 */
export const SEARCH_DOC_SQL = `
SELECT p.id AS photo_id,
       p.baby_id,
       public.baby_ai_enabled(p.baby_id) AS ai_enabled,
       (p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
        AND p.status NOT IN ('uploaded', 'failed', 'duplicate')) AS live,
       p.status,
       p.age_days,
       p.taken_at,
       p.taken_at_estimated,
       p.sort_at,
       p.is_sensitive,
       e.taken_at AS exif_taken_at,
       e.tz_offset_minutes,
       e.place_label,
       d.milestone_id,
       m.name AS milestone_name,
       d.people,
       d.note,
       d.location_label,
       a.description,
       (SELECT jsonb_object_agg(o.field_path, o.value)
          FROM photo_ai_overrides o WHERE o.photo_id = p.id) AS overrides,
       (SELECT jsonb_agg(jsonb_build_object('kind', x.kind, 'value_metric', x.value_metric,
                                            'measured_at', x.measured_at) ORDER BY x.measured_at, x.id)
          FROM measurements x WHERE x.photo_id = p.id) AS measurements,
       (s.photo_id IS NOT NULL) AS has_row,
       (s.embedding IS NOT NULL) AS has_vector,
       s.content_hash,
       s.embed_model,
       s.doc_version
FROM photos p
LEFT JOIN photo_exif e ON e.photo_id = p.id
LEFT JOIN photo_details d ON d.photo_id = p.id
LEFT JOIN milestones m ON m.id = d.milestone_id
LEFT JOIN photo_ai a ON a.photo_id = p.id
LEFT JOIN photo_search s ON s.photo_id = p.id
WHERE p.id = ANY($1::uuid[])
ORDER BY p.created_at, p.id`;

export interface SearchDocRow {
  photo_id: string;
  baby_id: string;
  ai_enabled: boolean;
  live: boolean;
  status: string;
  age_days: number | null;
  taken_at: Date | null;
  taken_at_estimated: boolean;
  sort_at: Date | null;
  is_sensitive: boolean;
  exif_taken_at: Date | null;
  tz_offset_minutes: number | null;
  place_label: string | null;
  milestone_id: string | null;
  milestone_name: string | null;
  people: string[] | null;
  note: string | null;
  location_label: string | null;
  description: unknown;
  overrides: Record<string, unknown> | null;
  measurements: { kind: string; value_metric: number | string; measured_at: string }[] | null;
  has_row: boolean;
  has_vector: boolean;
  content_hash: string | null;
  embed_model: string | null;
  doc_version: string | null;
}

function validDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * Local capture time for the document: EXIF time with a known offset ⇒ local wall-clock
 * date-time; EXIF time without offset or a non-estimated `taken_at` ⇒ its date; otherwise the
 * `sort_at` (upload) date, marked estimated ("around <date>").
 */
export function documentTime(
  row: Pick<
    SearchDocRow,
    "exif_taken_at" | "tz_offset_minutes" | "taken_at" | "taken_at_estimated" | "sort_at"
  >,
): { takenAtLocal: string | null; takenAtEstimated: boolean } {
  if (validDate(row.exif_taken_at)) {
    if (typeof row.tz_offset_minutes === "number" && Number.isFinite(row.tz_offset_minutes)) {
      const local = new Date(row.exif_taken_at.getTime() + row.tz_offset_minutes * 60_000);
      return { takenAtLocal: local.toISOString().slice(0, 19), takenAtEstimated: false };
    }
    return { takenAtLocal: row.exif_taken_at.toISOString().slice(0, 10), takenAtEstimated: false };
  }
  if (validDate(row.taken_at) && row.taken_at_estimated === false) {
    return { takenAtLocal: row.taken_at.toISOString().slice(0, 10), takenAtEstimated: false };
  }
  const fallback = validDate(row.taken_at) ? row.taken_at : row.sort_at;
  return {
    takenAtLocal: validDate(fallback) ? fallback.toISOString().slice(0, 10) : null,
    takenAtEstimated: true,
  };
}

/** The stored description with overrides applied (FR-5.6), or null when absent/invalid. */
export function mergedDescription(
  row: Pick<SearchDocRow, "description" | "overrides">,
): AiDescriptionV1 | null {
  const parsed = aiDescriptionV1Schema.safeParse(row.description);
  if (!parsed.success) return null;
  return applyAiOverrides(parsed.data, row.overrides ?? undefined);
}

/** `buildSearchDocument` input for one row (no name, no coordinates: none are read). */
export function toDocumentInput(row: SearchDocRow): SearchDocumentInput {
  const time = documentTime(row);
  const measurements = (row.measurements ?? [])
    .map((m) => {
      const kind = measurementKindSchema.safeParse(m.kind);
      const value = Number(m.value_metric);
      const at = new Date(m.measured_at);
      return kind.success && Number.isFinite(value) && value > 0 && validDate(at)
        ? { kind: kind.data, valueMetric: value, measuredAt: at.toISOString() }
        : null;
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  return {
    ageDays: typeof row.age_days === "number" ? row.age_days : null,
    takenAtLocal: time.takenAtLocal,
    takenAtEstimated: time.takenAtEstimated,
    place: row.location_label?.trim() || row.place_label?.trim() || null,
    milestone:
      row.milestone_id && row.milestone_name
        ? { id: row.milestone_id, name: row.milestone_name }
        : null,
    people: Array.isArray(row.people) ? row.people.filter((p) => typeof p === "string") : [],
    note: row.note,
    measurements,
    ai: mergedDescription(row),
    isSensitive: row.is_sensitive === true,
  };
}

/**
 * Upsert of `photo_search` rows from parallel arrays. Rows are written only where the photo is
 * still an approved live unquarantined photo of a paid baby at write time (the
 * `photo_search_guard` trigger would reject anything else; filtering here keeps one late change
 * from failing the whole batch). `$5` holds pgvector text (`[…]`) or NULL; people/tags travel as
 * JSON arrays (no ragged arrays in `unnest`); `$10` / `$11` are the embed model tag and the
 * document version.
 */
export const UPSERT_SEARCH_SQL = `
INSERT INTO photo_search (photo_id, baby_id, search_text, embedding, embed_model, doc_version,
  content_hash, embedded_at, taken_at, age_days, milestone_ids, people, tags, place, is_sensitive)
SELECT u.photo_id, p.baby_id, u.search_text, u.embedding::vector, $10::text, $11::text,
       u.content_hash, CASE WHEN u.embedding IS NULL THEN NULL ELSE now() END,
       p.sort_at, p.age_days,
       CASE WHEN u.milestone_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[u.milestone_id] END,
       ARRAY(SELECT jsonb_array_elements_text(u.people)),
       ARRAY(SELECT jsonb_array_elements_text(u.tags)),
       u.place, u.is_sensitive
FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::text[], $6::jsonb[], $7::jsonb[],
            $8::text[], $9::boolean[])
  AS u(photo_id, search_text, content_hash, milestone_id, embedding, people, tags, place, is_sensitive)
JOIN photos p ON p.id = u.photo_id
WHERE p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
  AND p.status NOT IN ('uploaded', 'failed', 'duplicate')
  AND public.baby_ai_enabled(p.baby_id)
ON CONFLICT (photo_id) DO UPDATE SET
  search_text = EXCLUDED.search_text, embedding = EXCLUDED.embedding,
  embed_model = EXCLUDED.embed_model, doc_version = EXCLUDED.doc_version,
  content_hash = EXCLUDED.content_hash, embedded_at = EXCLUDED.embedded_at,
  taken_at = EXCLUDED.taken_at, age_days = EXCLUDED.age_days,
  milestone_ids = EXCLUDED.milestone_ids, people = EXCLUDED.people, tags = EXCLUDED.tags,
  place = EXCLUDED.place, is_sensitive = EXCLUDED.is_sensitive
RETURNING photo_id`;

/** Unchanged documents: only `updated_at` moves (the stale signal is satisfied, no embedding). */
export const TOUCH_SEARCH_SQL = `
UPDATE photo_search SET updated_at = now(), taken_at = p.sort_at, age_days = p.age_days,
  is_sensitive = p.is_sensitive
FROM photos p
WHERE photo_search.photo_id = ANY($1::uuid[]) AND p.id = photo_search.photo_id`;

/** Rows of photos that may no longer be indexed (trashed, pending, rejected, quarantined, failed). */
export const DELETE_SEARCH_SQL = `
DELETE FROM photo_search WHERE photo_id = ANY($1::uuid[]) RETURNING photo_id`;

/** One spend row per baby per embedding call (`ai_spend_guard` re-checks the paid gate). */
export const INSERT_EMBED_SPEND_SQL = `
INSERT INTO ai_spend (baby_id, user_id, kind, ref_id, model, input_tokens, item_count, cost_usd)
SELECT $1::uuid, NULL, 'embed', NULL, $2::text, $3::int, $4::int, $5::numeric
WHERE public.baby_ai_enabled($1::uuid)`;

/** Month-to-date spend of one baby (vision batches + `ai_spend`), UTC month of `$2`. */
export const BABY_MONTH_COST_SQL = `
SELECT ai_baby_month_cost_usd($1::uuid, $2::date)::float8 AS spent`;

/** `ai.budget_exceeded {month}` once per baby per month (insert-if-absent, step 6). */
export const RECORD_BUDGET_EXCEEDED_SQL = `
SELECT public.record_ai_budget_exceeded($1::uuid, $2::text) AS inserted`;

/** `search_stale_photos(limit, embed_model, doc_version, baby)`. */
export const STALE_SQL = `
SELECT photo_id, baby_id, reason FROM search_stale_photos($1::int, $2::text, $3::text, $4::uuid)`;

/** `photo_search_orphans(limit)`. */
export const ORPHANS_SQL = `SELECT photo_search_orphans AS photo_id FROM photo_search_orphans($1::int)`;

/** Heartbeat: stale/missing count (excluding rows only missing a vector) and rows without a vector. */
export const STATS_SQL = `
SELECT (SELECT count(*) FROM search_stale_photos(NULL, $1::text, $2::text) s
         WHERE s.reason <> 'unembedded')::int AS stale,
       (SELECT count(*) FROM photo_search WHERE embedding IS NULL)::int AS unembedded`;
