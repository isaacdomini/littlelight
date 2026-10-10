import type { ChatModel, Embedder } from "@tinyglow/ai";
import {
  aiDescriptionV1Schema,
  applyAiOverrides,
  CHAT_MEASUREMENTS_MAX,
  CHAT_TOOL_RESULT_SCHEMAS,
  type ChatMeasurementResultItem,
  type ChatToolArgsByName,
  type ChatToolErrorResult,
  type ChatToolName,
  formatAge,
  formatMeasurement,
  type GetMeasurementsResult,
  type GetMilestonesResult,
  type GetPhotoResult,
  type MeasurementKind,
  SEARCH_RESULT_LIMIT,
  SEARCH_TOOL_MAX_RESULTS,
  type SearchPhotosResult,
} from "@tinyglow/shared";
import type { Tx, TxContext } from "../auth";
import { photoAiOverrides } from "../photos/ai-queries";
import { hybridSearch } from "../search/hybrid";

// The chat's four server-side tools (docs/plans/step-7.md 2.8 "Tools"; PRD "Chat and RAG
// pipeline"). Read-only, each in its own short transaction under the caller's claims (RLS
// decides; no `withServiceRole`), scoped to the baby of the conversation. Every result is
// validated against its strict schema in `@tinyglow/shared` before it is serialised for the
// model, so nothing else can leak: `search_photos` never returns `search_text` or a parent note;
// only `get_photo` returns the note and `text_in_image` (the system prompt declares both data).
// Never GPS, `raw_json`, storage keys or signed URLs. Arguments and results are never logged.

export interface ToolContext {
  babyId: string;
  /** `YYYY-MM-DD`. */
  birthDate: string;
  timezone: string;
  units: "metric" | "imperial";
  embedder: Embedder | null;
  exactMax: number;
  efSearch: number;
  /** `SEARCH_MIN_SIMILARITY` (null ⇒ the embedder model's default). */
  minSimilarity?: number | null;
  /** `SEARCH_RERANK=llm`: the chat model and the caller, for the optional re-rank. */
  rerank: { chat: ChatModel; userId: string } | null;
  /** Runs `fn` in a fresh transaction under the caller's claims (`withClaims`). */
  runClaims<T>(fn: (client: Tx, ctx: TxContext) => Promise<T>): Promise<T>;
  /** Argument *shapes* only (which keys were set, counts), never values. */
  log?: { info(obj: Record<string, unknown>, msg: string): void };
}

export interface ToolOutcome {
  /** JSON string handed to the model as the tool message. */
  content: string;
  /** Ids the model may cite after this call. */
  photoIds: string[];
  measurementIds: string[];
  /** `search_photos` results in rank order (the grid fallback). */
  searchPhotoIds: string[] | null;
  /** Measurement id → its linked photo id (the photo joins the grid when the measurement is cited). */
  measurementPhotos?: Record<string, string>;
  /** `search_photos` only: key names, counts and flags for the turn log (never values). */
  searchLog?: Record<string, unknown>;
  /**
   * `search_photos` only, server-side: how sure the results are (for the chat fast path). Never
   * serialised to the model.
   */
  searchConfidence?: {
    results: number;
    /** No free-text query: every result matches the filters exactly. */
    filtersOnly: boolean;
    /** At least one result has a full-text or tag/people match. */
    lexical: boolean;
    /** Best vector similarity among the results (null when the vector leg did not run). */
    topSimilarity: number | null;
  };
  /** The tool returned data (anything citable). */
  hasData: boolean;
}

/** A validated error result (`invalid_arguments` paths, `not_found`, `unavailable`). */
export function toolError(error: ChatToolErrorResult["error"], issues?: string[]): ToolOutcome {
  const body: ChatToolErrorResult = issues?.length ? { error, issues } : { error };
  return {
    content: JSON.stringify(body),
    photoIds: [],
    measurementIds: [],
    searchPhotoIds: null,
    measurementPhotos: {},
    hasData: false,
  };
}

/** Serialises a result after validating it against the tool's strict result schema. */
function serialise<N extends ChatToolName>(name: N, result: unknown): string {
  return JSON.stringify(CHAT_TOOL_RESULT_SCHEMAS[name].parse(result));
}

const ageText = (days: number | null): string | null =>
  days === null || !Number.isFinite(days) ? null : formatAge(days);

// ---- search_photos -------------------------------------------------------------------------------

/** Extra days on each side of an age window when the search also has free text. */
export const AGE_WINDOW_MARGIN_DAYS = 15;

/** Margin of the one wider retry when a text search inside a time window has no lexical match. */
export const WINDOW_RETRY_MARGIN_DAYS = 45;

/** `YYYY-MM-DD` shifted by `days`. */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A date window widened by `margin` days on each side when the search has free text. */
export function widenDates(
  from: string | null,
  to: string | null,
  hasText: boolean,
  margin = AGE_WINDOW_MARGIN_DAYS,
): { from: string | null; to: string | null } {
  if (!hasText || (from === null && to === null)) return { from, to };
  return {
    from: from === null ? null : shiftDate(from, -margin),
    to: to === null ? null : shiftDate(to, margin),
  };
}

/** The age window actually searched (see the comment in `searchPhotos`). Exported for tests. */
export function widenAges(
  from: number | null,
  to: number | null,
  hasText: boolean,
  margin = AGE_WINDOW_MARGIN_DAYS,
): { from: number | null; to: number | null } {
  if (!hasText || (from === null && to === null)) return { from, to };
  return {
    from: from === null ? null : Math.max(-300, from - margin),
    to: to === null ? null : to + margin,
  };
}

async function searchPhotos(
  ctx: ToolContext,
  args: ChatToolArgsByName["search_photos"],
): Promise<ToolOutcome> {
  return ctx.runClaims(async (client) => {
    // Milestone names → ids (presets + this baby's custom, case-insensitive).
    let milestoneIds: string[] = [];
    const unknown: string[] = [];
    const milestones = args.milestones ?? [];
    if (milestones.length > 0) {
      const wanted = milestones.map((m) => m.toLowerCase());
      const { rows } = await client.query<{ id: string; lname: string }>(
        `SELECT m.id, lower(m.name) AS lname FROM public.milestones m
          WHERE (m.baby_id IS NULL OR m.baby_id = $1) AND lower(m.name) = ANY($2::text[])`,
        [ctx.babyId, wanted],
      );
      milestoneIds = rows.map((r) => r.id);
      const found = new Set(rows.map((r) => r.lname));
      for (const m of milestones) if (!found.has(m.toLowerCase())) unknown.push(m);
    }
    const limit = Math.min(args.limit ?? SEARCH_RESULT_LIMIT, SEARCH_TOOL_MAX_RESULTS);
    // With a free-text query the results are ranked by relevance, so a time window (age or date)
    // is widened by AGE_WINDOW_MARGIN_DAYS on each side: models resolve "at 12 months" to a single
    // day, [365, 395], [335, 365] or the calendar month after the birthday, and a photo 3 days off
    // must not be filtered out. Filter-only searches keep exact windows.
    const hasText = (args.query ?? "").trim() !== "";
    const hasWindow =
      args.age_from_days !== null ||
      args.age_to_days !== null ||
      args.date_from !== null ||
      args.date_to !== null;
    const ages = widenAges(args.age_from_days, args.age_to_days, hasText);
    const dates = widenDates(args.date_from, args.date_to, hasText);
    const base = {
      babyId: ctx.babyId,
      dateFrom: dates.from,
      dateTo: dates.to,
      ageFromDays: ages.from,
      ageToDays: ages.to,
      place: null,
      limit,
      timezone: ctx.timezone,
    };
    const opts = {
      embedder: ctx.embedder,
      exactMax: ctx.exactMax,
      efSearch: ctx.efSearch,
      minSimilarity: ctx.minSimilarity ?? null,
      rerank: ctx.rerank,
    };
    const people = args.people ?? [];
    const tags = args.tags ?? [];
    // Every requested milestone unknown: search for the words instead of an impossible filter.
    const allUnknown = milestones.length > 0 && milestoneIds.length === 0;
    let result = await hybridSearch(
      client,
      {
        ...base,
        query: allUnknown ? [args.query, ...unknown].filter(Boolean).join(" ") : args.query,
        milestoneIds,
        people,
        tags,
      },
      opts,
    );
    // Models sometimes put a place or a scene word into `people` / `tags` ("telescope at Home" ⇒
    // people ["Home"]). When those strict filters leave nothing, retry once with their words
    // moved into the free-text query; explicit dates, ages and known milestones stay.
    let relaxed = false;
    if (result.ids.length === 0 && people.length + tags.length > 0) {
      relaxed = true;
      result = await hybridSearch(
        client,
        {
          ...base,
          query: [args.query, ...people, ...tags, ...(allUnknown ? unknown : [])]
            .filter(Boolean)
            .join(" "),
          milestoneIds,
          people: [],
          tags: [],
        },
        opts,
      );
    }
    // A text search inside a time window that found no lexical match: one retry with the window
    // widened by WINDOW_RETRY_MARGIN_DAYS; kept only if it finds a lexical match.
    let windowRetry = false;
    let windowRetryTried = false;
    let retryLexical: number | null = null;
    if (hasText && hasWindow && (result.lexicalIds ?? []).length === 0) {
      windowRetryTried = true;
      const wa = widenAges(args.age_from_days, args.age_to_days, true, WINDOW_RETRY_MARGIN_DAYS);
      const wd = widenDates(args.date_from, args.date_to, true, WINDOW_RETRY_MARGIN_DAYS);
      const wider = await hybridSearch(
        client,
        {
          ...base,
          dateFrom: wd.from,
          dateTo: wd.to,
          ageFromDays: wa.from,
          ageToDays: wa.to,
          query: args.query,
          milestoneIds,
          people: relaxed ? [] : people,
          tags: relaxed ? [] : tags,
        },
        opts,
      );
      retryLexical = (wider.lexicalIds ?? []).length;
      if (retryLexical > 0) {
        result = wider;
        windowRetry = true;
      }
    }
    // Diagnostics when nothing matched lexically (values never logged): how many lexemes the
    // query has and how many photos match them with NO filter at all (window, people, tags).
    let queryTerms: number | null = null;
    let textCandidates: number | null = null;
    if (hasText && (result.lexicalIds ?? []).length === 0) {
      const { rows } = await client.query<{ terms: number; matches: number }>(
        `SELECT coalesce(array_length(tsvector_to_array(to_tsvector('english', $2::text)), 1), 0)::int AS terms,
                (SELECT count(*)::int FROM public.photo_search_text_candidates(
                   $1::uuid, replace(plainto_tsquery('english', $2::text)::text, ' & ', ' | ')::tsquery,
                   200)) AS matches`,
        [ctx.babyId, args.query],
      );
      queryTerms = rows[0]?.terms ?? 0;
      textCandidates = rows[0]?.matches ?? 0;
    }
    const summary = {
      tool: "search_photos" as const,
      set: Object.entries(args)
        .filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => (Array.isArray(v) ? `${k}[${v.length}]` : k)),
      ageWindow:
        args.age_from_days !== null || args.age_to_days !== null
          ? (args.age_to_days ?? 0) - (args.age_from_days ?? 0)
          : null,
      windowWidened: hasText && hasWindow,
      windowRetryTried,
      windowRetry,
      retryLexical,
      queryTerms,
      textCandidates,
      relaxed,
      unknownMilestones: unknown.length,
      lexical: (result.lexicalIds ?? []).length,
      candidates: result.candidates,
      results: result.ids.length,
    };
    const rows =
      result.ids.length === 0
        ? []
        : (
            await client.query<{
              photo_id: string;
              taken_at: string | null;
              age_days: number | null;
              caption: string | null;
              people: string[];
              place: string | null;
              milestone: string | null;
              tags: string[];
            }>(
              `SELECT s.photo_id,
                      to_char(s.taken_at AT TIME ZONE $2, 'YYYY-MM-DD') AS taken_at,
                      s.age_days, s.people, s.place, s.tags,
                      COALESCE(
                        (SELECT CASE WHEN jsonb_typeof(ov.value) = 'string' THEN ov.value #>> '{}' END
                           FROM public.photo_ai_overrides ov
                          WHERE ov.photo_id = s.photo_id AND ov.field_path = 'caption'),
                        (SELECT CASE WHEN jsonb_typeof(ai.description -> 'caption') = 'string'
                                     THEN ai.description ->> 'caption' END
                           FROM public.photo_ai ai WHERE ai.photo_id = s.photo_id)
                      ) AS caption,
                      (SELECT m.name FROM public.milestones m
                        WHERE m.id = s.milestone_ids[1]) AS milestone
                 FROM public.photo_search s
                 JOIN public.photos p ON p.id = s.photo_id
                WHERE s.photo_id = ANY($1::uuid[]) AND p.deleted_at IS NULL`,
              [result.ids, ctx.timezone],
            )
          ).rows;
    const byId = new Map(rows.map((r) => [r.photo_id, r]));
    const ordered = result.ids.map((id) => byId.get(id)).filter((r) => r !== undefined);
    const body: SearchPhotosResult = {
      results: ordered.map((r) => ({
        photo_id: r.photo_id,
        taken_at: r.taken_at,
        age: ageText(r.age_days),
        caption: r.caption,
        people: r.people.slice(0, 20),
        place: r.place,
        milestone: r.milestone,
        tags: r.tags.slice(0, 6),
      })),
      candidates: result.candidates,
      truncated: result.truncated,
      unknown_milestones: unknown.slice(0, 5),
    };
    const ids = body.results.map((x) => x.photo_id);
    return {
      content: serialise("search_photos", body),
      photoIds: ids,
      measurementIds: [],
      searchPhotoIds: ids,
      searchLog: summary,
      searchConfidence: {
        results: ids.length,
        filtersOnly: !hasText && !relaxed,
        lexical: (result.lexicalIds ?? []).length > 0,
        topSimilarity: ids.reduce<number | null>((best, id) => {
          const sim = result.similarity?.[id];
          return sim === undefined ? best : best === null ? sim : Math.max(best, sim);
        }, null),
      },
      measurementPhotos: {},
      hasData: ids.length > 0,
    };
  });
}

// ---- get_measurements ------------------------------------------------------------------------------

interface MeasurementToolRow {
  id: string;
  kind: MeasurementKind;
  value_metric: string;
  measured_on: string;
  age_days: number | null;
  photo_id: string | null;
}

const MEASUREMENT_TOOL_COLUMNS = `ms.id, ms.kind, ms.value_metric, ms.photo_id,
  to_char(ms.measured_at AT TIME ZONE $2, 'YYYY-MM-DD') AS measured_on,
  ((ms.measured_at AT TIME ZONE $2)::date - b.birth_date) AS age_days`;

function toMeasurementItem(ctx: ToolContext, r: MeasurementToolRow): ChatMeasurementResultItem {
  const metric = Number(r.value_metric);
  return {
    measurement_id: r.id,
    kind: r.kind,
    value: formatMeasurement(r.kind, metric, ctx.units),
    value_metric: metric,
    measured_at: r.measured_on,
    age: ageText(r.age_days),
    photo_id: r.photo_id,
  };
}

async function getMeasurements(
  ctx: ToolContext,
  args: ChatToolArgsByName["get_measurements"],
): Promise<ToolOutcome> {
  return ctx.runClaims(async (client) => {
    const values: unknown[] = [ctx.babyId, ctx.timezone];
    const where = ["ms.baby_id = $1"];
    if (args.kind !== null) {
      values.push(args.kind);
      where.push(`ms.kind = $${values.length}`);
    }
    if (args.date_from !== null) {
      values.push(args.date_from);
      where.push(`ms.measured_at >= ($${values.length}::date::timestamp AT TIME ZONE $2)`);
    }
    if (args.date_to !== null) {
      values.push(args.date_to);
      where.push(`ms.measured_at < (($${values.length}::date + 1)::timestamp AT TIME ZONE $2)`);
    }
    const { rows } = await client.query<MeasurementToolRow>(
      `SELECT ${MEASUREMENT_TOOL_COLUMNS}
         FROM public.measurements ms JOIN public.babies b ON b.id = ms.baby_id
        WHERE ${where.join(" AND ")}
        ORDER BY ms.measured_at, ms.id LIMIT ${CHAT_MEASUREMENTS_MAX + 1}`,
      values,
    );
    const body: GetMeasurementsResult = {
      measurements: rows.slice(0, CHAT_MEASUREMENTS_MAX).map((r) => toMeasurementItem(ctx, r)),
      truncated: rows.length > CHAT_MEASUREMENTS_MAX,
    };
    const ids = body.measurements.map((m) => m.measurement_id);
    const photoIds = body.measurements
      .map((m) => m.photo_id)
      .filter((x): x is string => x !== null);
    return {
      content: serialise("get_measurements", body),
      photoIds,
      measurementIds: ids,
      searchPhotoIds: null,
      measurementPhotos: Object.fromEntries(
        body.measurements
          .filter((m) => m.photo_id !== null)
          .map((m) => [m.measurement_id, m.photo_id as string]),
      ),
      hasData: ids.length > 0,
    };
  });
}

// ---- get_milestones --------------------------------------------------------------------------------

async function getMilestones(ctx: ToolContext): Promise<ToolOutcome> {
  return ctx.runClaims(async (client) => {
    const { rows } = await client.query<{
      milestone_id: string;
      name: string;
      first_on: string | null;
      age_days: number | null;
      photo_ids: string[];
    }>(
      `SELECT m.id AS milestone_id, m.name,
              to_char(min(p.sort_at) AT TIME ZONE $2, 'YYYY-MM-DD') AS first_on,
              ((min(p.sort_at) AT TIME ZONE $2)::date - b.birth_date) AS age_days,
              (array_agg(p.id ORDER BY p.sort_at, p.id))[1:5] AS photo_ids
         FROM public.photo_details d
         JOIN public.photos p ON p.id = d.photo_id
         JOIN public.milestones m ON m.id = d.milestone_id
         JOIN public.babies b ON b.id = p.baby_id
        WHERE p.baby_id = $1 AND p.deleted_at IS NULL AND p.approval = 'approved'
          AND p.quarantined_at IS NULL AND p.status NOT IN ('failed', 'duplicate')
        GROUP BY m.id, m.name, b.birth_date
        ORDER BY min(p.sort_at), m.name
        LIMIT 250`,
      [ctx.babyId, ctx.timezone],
    );
    const body: GetMilestonesResult = {
      milestones: rows.map((r) => ({
        milestone_id: r.milestone_id,
        name: r.name,
        date: r.first_on,
        age: ageText(r.age_days),
        photo_ids: r.photo_ids.slice(0, 5),
      })),
    };
    const photoIds = body.milestones.flatMap((m) => m.photo_ids);
    return {
      content: serialise("get_milestones", body),
      photoIds,
      measurementIds: [],
      searchPhotoIds: null,
      measurementPhotos: {},
      hasData: body.milestones.length > 0,
    };
  });
}

// ---- get_photo -------------------------------------------------------------------------------------

async function getPhoto(
  ctx: ToolContext,
  args: ChatToolArgsByName["get_photo"],
): Promise<ToolOutcome> {
  return ctx.runClaims(async (client) => {
    const { rows } = await client.query<{
      id: string;
      taken_on: string | null;
      age_days: number | null;
      note: string | null;
      people: string[] | null;
      location_label: string | null;
      place_label: string | null;
      milestone: string | null;
      description: unknown;
    }>(
      `SELECT p.id,
              to_char(p.sort_at AT TIME ZONE $3, 'YYYY-MM-DD') AS taken_on, p.age_days,
              d.note, d.people, d.location_label, e.place_label,
              (SELECT m.name FROM public.milestones m WHERE m.id = d.milestone_id) AS milestone,
              (SELECT ai.description FROM public.photo_ai ai WHERE ai.photo_id = p.id) AS description
         FROM public.photos p
         LEFT JOIN public.photo_details d ON d.photo_id = p.id
         LEFT JOIN public.photo_exif e ON e.photo_id = p.id
        WHERE p.id = $1 AND p.baby_id = $2 AND p.deleted_at IS NULL AND p.approval = 'approved'
          AND p.status NOT IN ('failed', 'duplicate')`,
      [args.photo_id, ctx.babyId, ctx.timezone],
    );
    const r = rows[0];
    if (!r) return toolError("not_found");
    const parsed = aiDescriptionV1Schema.safeParse(r.description);
    const desc = parsed.success
      ? applyAiOverrides(parsed.data, await photoAiOverrides(client, r.id))
      : null;
    const { rows: ms } = await client.query<MeasurementToolRow>(
      `SELECT ${MEASUREMENT_TOOL_COLUMNS}
         FROM public.measurements ms JOIN public.babies b ON b.id = ms.baby_id
        WHERE ms.photo_id = $1 ORDER BY ms.measured_at, ms.id LIMIT 20`,
      [r.id, ctx.timezone],
    );
    const measurements = ms.map((m) => toMeasurementItem(ctx, m));
    const body: GetPhotoResult = {
      photo_id: r.id,
      taken_at: r.taken_on,
      age: ageText(r.age_days),
      caption: desc?.caption ?? null,
      description: desc?.detailed_description ?? null,
      people: (r.people ?? []).slice(0, 20),
      place: r.location_label?.trim() || r.place_label?.trim() || null,
      milestone: r.milestone,
      tags: desc?.search_tags.slice(0, 30) ?? [],
      measurements,
      note: r.note,
      text_in_image: desc?.text_in_image ?? null,
    };
    return {
      content: serialise("get_photo", body),
      photoIds: [r.id],
      measurementIds: measurements.map((m) => m.measurement_id),
      searchPhotoIds: null,
      measurementPhotos: Object.fromEntries(measurements.map((m) => [m.measurement_id, r.id])),
      hasData: true,
    };
  });
}

/** Runs one validated tool call. Infrastructure errors propagate (the agent maps them). */
export function runTool<N extends ChatToolName>(
  ctx: ToolContext,
  name: N,
  args: ChatToolArgsByName[N],
): Promise<ToolOutcome> {
  switch (name) {
    case "search_photos":
      return searchPhotos(ctx, args as ChatToolArgsByName["search_photos"]);
    case "get_measurements":
      return getMeasurements(ctx, args as ChatToolArgsByName["get_measurements"]);
    case "get_milestones":
      return getMilestones(ctx);
    default:
      return getPhoto(ctx, args as ChatToolArgsByName["get_photo"]);
  }
}
