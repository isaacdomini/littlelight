import { SEARCH_FACET_TAGS_MAX, type SearchFacetsResponse } from "@tinyglow/shared";
import type { Tx } from "../auth";

// FR-7.5 chip values (docs/plans/step-7.md 2.8 "routes.ts"): people, milestones, tags (top 30),
// places with counts and the indexed date range, over the baby's live approved `photo_search`
// rows, under the caller's claims (RLS: admin of a paid baby). Never reads `search_text`.

const LIVE = `public.photo_search s JOIN public.photos p ON p.id = s.photo_id
  WHERE s.baby_id = $1 AND p.deleted_at IS NULL AND p.approval = 'approved' AND p.quarantined_at IS NULL`;

/** Most frequent first; at most this many people / milestones / places. */
const FACET_MAX = 50;

export async function searchFacets(
  client: Tx,
  babyId: string,
  timezone: string,
): Promise<SearchFacetsResponse> {
  const people = await client.query<{ name: string; count: number }>(
    `SELECT min(x) AS name, count(*)::int AS count
       FROM ${LIVE.replace("WHERE", ", unnest(s.people) x WHERE")}
      GROUP BY lower(x) ORDER BY count DESC, lower(x) LIMIT ${FACET_MAX}`,
    [babyId],
  );
  const milestones = await client.query<{ id: string; name: string; count: number }>(
    `SELECT m.id, m.name, count(*)::int AS count
       FROM ${LIVE.replace("WHERE", ", unnest(s.milestone_ids) mid JOIN public.milestones m ON m.id = mid WHERE")}
      GROUP BY m.id, m.name ORDER BY count DESC, m.name LIMIT ${FACET_MAX}`,
    [babyId],
  );
  const tags = await client.query<{ tag: string; count: number }>(
    `SELECT t AS tag, count(*)::int AS count
       FROM ${LIVE.replace("WHERE", ", unnest(s.tags) t WHERE")}
      GROUP BY t ORDER BY count DESC, t LIMIT ${SEARCH_FACET_TAGS_MAX}`,
    [babyId],
  );
  const places = await client.query<{ place: string; count: number }>(
    `SELECT s.place AS place, count(*)::int AS count FROM ${LIVE} AND s.place IS NOT NULL
      GROUP BY s.place ORDER BY count DESC, s.place LIMIT ${FACET_MAX}`,
    [babyId],
  );
  const range = await client.query<{ from: string | null; to: string | null }>(
    `SELECT to_char(min(s.taken_at) AT TIME ZONE $2, 'YYYY-MM-DD') AS "from",
            to_char(max(s.taken_at) AT TIME ZONE $2, 'YYYY-MM-DD') AS "to"
       FROM ${LIVE}`,
    [babyId, timezone],
  );
  const r = range.rows[0];
  return {
    people: people.rows,
    milestones: milestones.rows,
    tags: tags.rows,
    places: places.rows,
    dateRange: r?.from && r.to ? { from: r.from, to: r.to } : null,
  };
}
