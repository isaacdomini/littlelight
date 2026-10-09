import { z } from "zod";
import { SEARCH_FACET_TAGS_MAX, SEARCH_PAGE_DEFAULT, SEARCH_PAGE_MAX } from "../constants";
import { isoDateSchema } from "./common";
import { photoSummarySchema } from "./photos";

// `GET /api/babies/:id/search` and `GET /api/babies/:id/search/facets` (docs/plans/step-7.md 2.4,
// 2.8; PRD FR-7.3 hybrid retrieval, FR-7.5 classic search bar and filter chips). Admins of a
// paid baby only: contributors get 403 `forbidden`, free/expired babies 403 `plan_required`,
// strangers 404. Results are photo summaries (signed thumbs, override-merged captions): never the
// search document, notes, GPS or `raw_json`. The query string never reaches a log (the API's
// request serializer drops query strings).

/** Age bounds of a search, in days (negative = before birth, as `photos.age_days`). */
export const SEARCH_AGE_MIN_DAYS = -300;
export const SEARCH_AGE_MAX_DAYS = 7300;

/** Free-text limits of the query and the chip values (characters, trimmed). */
export const SEARCH_QUERY_LIMITS = {
  q: 200,
  person: 60,
  place: 120,
  tag: 60,
} as const;

const L = SEARCH_QUERY_LIMITS;
const ageSchema = z.coerce.number().int().min(SEARCH_AGE_MIN_DAYS).max(SEARCH_AGE_MAX_DAYS);

/**
 * `GET /babies/:id/search` query (strings from the query string; numbers coerced). Clients omit
 * empty values (an empty `q` is a 400, not "no query"). Dates are inclusive calendar dates;
 * `ageFrom`/`ageTo` are inclusive ages in days. `person` matches a people chip
 * case-insensitively; `place` the lower-cased coarse place; `tag` one lower-cased tag;
 * `milestoneId` a preset or one of the baby's custom milestones. At least one of `q` or a
 * filter; ranges must not be reversed. Without `q` the results are filtered only, newest first
 * (no model call).
 */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(L.q).optional(),
    dateFrom: isoDateSchema.optional(),
    dateTo: isoDateSchema.optional(),
    ageFrom: ageSchema.optional(),
    ageTo: ageSchema.optional(),
    milestoneId: z.uuid().optional(),
    person: z.string().trim().min(1).max(L.person).optional(),
    place: z.string().trim().min(1).max(L.place).optional(),
    tag: z.string().trim().toLowerCase().min(1).max(L.tag).optional(),
    limit: z.coerce.number().int().min(1).max(SEARCH_PAGE_MAX).default(SEARCH_PAGE_DEFAULT),
  })
  .superRefine((v, ctx) => {
    const { limit: _limit, ...rest } = v;
    if (Object.values(rest).every((x) => x === undefined)) {
      ctx.addIssue({ code: "custom", path: ["q"], message: "Enter a search or pick a filter" });
    }
    if (v.dateFrom !== undefined && v.dateTo !== undefined && v.dateFrom > v.dateTo) {
      ctx.addIssue({ code: "custom", path: ["dateTo"], message: "dateTo is before dateFrom" });
    }
    if (v.ageFrom !== undefined && v.ageTo !== undefined && v.ageFrom > v.ageTo) {
      ctx.addIssue({ code: "custom", path: ["ageTo"], message: "ageTo is below ageFrom" });
    }
  });
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Why results came from keyword + filters only: `no_embeddings` when no embedder is configured
 * (no provider key) or every candidate row has a NULL vector (not yet embedded, or the budget
 * was spent). `null` = full hybrid.
 */
export const SEARCH_DEGRADED_REASONS = ["no_embeddings"] as const;
export const searchDegradedSchema = z.enum(SEARCH_DEGRADED_REASONS);
export type SearchDegraded = z.infer<typeof searchDegradedSchema>;

/**
 * Best match first (RRF over vector, full-text and tag/people legs; filtered-only queries newest
 * first). `tookMs` is database time (the embedding call is excluded).
 */
export const searchResponseSchema = z.object({
  photos: z.array(photoSummarySchema),
  tookMs: z.number().int().nonnegative(),
  degraded: searchDegradedSchema.nullable(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** `GET /babies/:id/search/facets`: no parameters. */
export const searchFacetsQuerySchema = z.object({});
export type SearchFacetsQuery = z.infer<typeof searchFacetsQuerySchema>;

const count = z.number().int().nonnegative();

/**
 * Chip values with counts over the baby's live approved indexed photos (FR-7.5). Each list is
 * most frequent first; `tags` is capped at `SEARCH_FACET_TAGS_MAX`. `dateRange` spans the
 * indexed capture dates (`null` when nothing is indexed). Clients cache it for 60 s.
 */
export const searchFacetsResponseSchema = z.object({
  people: z.array(z.object({ name: z.string(), count })),
  milestones: z.array(z.object({ id: z.uuid(), name: z.string(), count })),
  tags: z.array(z.object({ tag: z.string(), count })).max(SEARCH_FACET_TAGS_MAX),
  places: z.array(z.object({ place: z.string(), count })),
  dateRange: z.object({ from: isoDateSchema, to: isoDateSchema }).nullable(),
});
export type SearchFacetsResponse = z.infer<typeof searchFacetsResponseSchema>;
