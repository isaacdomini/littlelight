import type { ChatModel, Embedder } from "@tinyglow/ai";
import {
  SEARCH_CANDIDATES,
  SEARCH_RERANK_CANDIDATES,
  type SearchMediaFilter,
} from "@tinyglow/shared";
import type { Tx } from "../auth";
import { rerankWithChat } from "./rerank";
import { reciprocalRankFusion } from "./rrf";

// Hybrid retrieval (docs/plans/step-7.md 2.8 "hybrid.ts"; PRD FR-7.3, "Chat and RAG pipeline":
// SQL filters → top 50 by vector cosine + top 50 by full-text → RRF → optional LLM re-rank → top
// N). Everything runs inside the caller's claims transaction: `photo_search` RLS
// (`search_baby_ids()`: admin of a paid baby) and `photos` RLS both apply, and the `SET LOCAL
// hnsw.*` settings die with the transaction. Never selects `search_text` (it holds parent notes)
// except inside the full-text predicate; never logs the query or a document.
//
// Vector leg, two paths (D9): pgvector applies WHERE filters *after* an HNSW scan, so a selective
// filter ("first steps" = 3 photos of 50k) would come back nearly empty from the index. When the
// filtered candidate set is small (≤ SEARCH_EXACT_MAX) we scan it exactly behind a MATERIALIZED
// CTE (the btree/GIN filters run first); otherwise HNSW with `hnsw.iterative_scan =
// relaxed_order` (pgvector ≥ 0.8) keeps scanning until enough filtered rows are found.
//
// Full-text leg (`photo_search_text_candidates`, SECURITY DEFINER): the query's lexemes OR-ed
// (`plainto_tsquery` with `&` → `|`), ranked by `ts_rank_cd` on the GIN index; documents matching more words rank higher, a document need not
// contain every word (the vector leg already rewards overlap; AND would starve recall).
// Tag/people leg (`photo_search_term_candidates`): query words and adjacent word pairs against
// `tags` (GIN) and lower(`people`), so
// "Grandma" or "bath" still finds photos when vectors are missing (degraded mode).
//
// Media filter (step 12, docs/plans/step-12.md 2.7): `media: "photo" | "video"` adds
// `p.media_kind = …` to the SQL filters of the count, filter-only and vector legs. The two
// SECURITY DEFINER candidate functions have no media argument (migration 22 left them alone), so
// their results are narrowed afterwards under RLS (`MEDIA_NARROW_SQL`); to keep recall, they are
// asked for `MEDIA_OVERFETCH ×` candidates when a media filter is on, then cut back to
// `SEARCH_CANDIDATES`. `any` (the default) changes nothing.

/** Lexical-leg over-fetch factor when a media filter is on (the functions cannot filter it). */
export const MEDIA_OVERFETCH = 4;

export interface HybridInput {
  babyId: string;
  /** Free text; null = filters only (newest first, no model call). */
  query: string | null;
  /** Inclusive local calendar dates (`YYYY-MM-DD`) in `timezone`. */
  dateFrom: string | null;
  dateTo: string | null;
  ageFromDays: number | null;
  ageToDays: number | null;
  milestoneIds: readonly string[];
  /** Any of these (case-insensitive). */
  people: readonly string[];
  /** Any of these (lower-case). */
  tags: readonly string[];
  /** Lower-cased coarse place label. */
  place: string | null;
  /** Step 12: only photos or only videos; omitted / `any` = both. */
  media?: SearchMediaFilter;
  limit: number;
  /** IANA zone the dates are local to (the caller's profile). */
  timezone: string;
}

/** The effective media filter (`any` and undefined are no filter). */
export function mediaFilter(input: Pick<HybridInput, "media">): "photo" | "video" | null {
  return input.media === "photo" || input.media === "video" ? input.media : null;
}

export interface HybridOptions {
  embedder: Embedder | null;
  /** `SEARCH_EXACT_MAX`. */
  exactMax: number;
  /** `SEARCH_HNSW_EF_SEARCH`. */
  efSearch: number;
  /** `SEARCH_RERANK=llm` and a chat model: re-rank the top 30 by captions. */
  rerank?: { chat: ChatModel; userId: string } | null;
  /**
   * `SEARCH_MIN_SIMILARITY`: minimum cosine similarity for a candidate found by the vector leg
   * only. null/undefined ⇒ `defaultMinSimilarity(embedder.model)`.
   */
  minSimilarity?: number | null;
  log?: { info(obj: Record<string, unknown>, msg: string): void };
}

/**
 * Relevance floor of the vector leg (PRD FR-7.4 / "Chat and RAG pipeline" step 4: "if nothing
 * matches, say so"). Vector search always returns the *nearest* rows, however unrelated, so a
 * candidate that only the vector leg found (no full-text or tag/people hit) must reach this cosine
 * similarity; candidates with a lexical hit are always kept, and filter-only queries are not
 * affected.
 * - `text-embedding-3-small` (1024 dims): 0.30, from the real calibration run
 *   (`pnpm search:calibrate --provider real`, 2,000-photo Golden seed, ~$0.004):
 *   - unrelated queries, best vector-only similarity: n=30, p50 0.182, p90 0.261, p95 0.299,
 *     max 0.364;
 *   - golden targets: n=48, min 0.199, p10 0.306, p50 0.397, all also found lexically;
 *   - paraphrase targets (no shared word): n=20, min 0.118, p10 0.237, p50 0.315; 4/20 found
 *     lexically, 11/20 in the vector top 5.
 *   The script's 0.38 would cut 14 of the 16 vector-only paraphrase targets. 0.30 cuts about 95 %
 *   of the measured noise and keeps 10/16 of them (orchestrator decision). Re-run the calibration
 *   and override with `SEARCH_MIN_SIMILARITY` when the model or the document template changes.
 * - `fake` (hashed bag of words): 0.60. Its vectors only encode shared words, and every shared
 *   word is also found by the full-text/term legs (exempt from the floor), so a vector-only fake
 *   candidate is hash-collision noise. Measured on the 2,000-photo search seed: the best
 *   zero-overlap cosine per random 1-3-word query is p50 0.07, p95 0.24, p99/max 0.44 (a short
 *   query colliding with a heavy document feature), so 0.60 drops all of it.
 */
export function defaultMinSimilarity(model: string | null | undefined): number {
  return model === "fake" ? 0.6 : 0.3;
}

export interface HybridResult {
  /** Best first; at most `limit`. */
  ids: string[];
  /** Photos matching the filters (capped at `exactMax + 1`). */
  candidates: number;
  /** More fused results existed than `limit`. */
  truncated: boolean;
  degraded: "no_embeddings" | null;
  /** Database time (ms), excluding the embedding call. */
  tookMs: number;
  /** The query embedding call (ms), 0 when none. */
  embedMs: number;
  path: "empty" | "filters" | "exact" | "hnsw" | "text";
  /**
   * Returned ids that the full-text or tag/people leg found (a lexical match). Server-side only
   * (confidence of the chat fast path); never sent to the model.
   */
  lexicalIds?: string[];
  /** Cosine similarity of returned ids that the vector leg scored (server-side only). */
  similarity?: Record<string, number>;
}

/**
 * Confidence floor of the chat's find-photos fast path (`CHAT_FAST_PATH_MIN_SIMILARITY`): without a
 * lexical match, the best result must reach this similarity for the server to answer "Here are N
 * photos that match" by itself; otherwise the model writes the answer.
 * - `text-embedding-3-small`: 0.38, the calibration script's recommendation from the real run
 *   (unrelated-probe max 0.364, e.g. "zebra submarine"; golden target p10 0.306).
 * - `fake`: 0.60 (same reasoning as `defaultMinSimilarity`).
 */
export function defaultFastPathMinSimilarity(model: string | null | undefined): number {
  return model === "fake" ? 0.6 : 0.38;
}

/** Filter fragment over `photo_search s JOIN photos p`; `$1` is the baby id. Exported for tests. */
export function filterSql(input: HybridInput): { where: string; values: unknown[] } {
  const values: unknown[] = [input.babyId];
  const add = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const parts = [
    "s.baby_id = $1",
    "p.deleted_at IS NULL",
    "p.approval = 'approved'",
    "p.quarantined_at IS NULL",
  ];
  if (input.dateFrom !== null || input.dateTo !== null) {
    const tz = add(input.timezone);
    if (input.dateFrom !== null) {
      parts.push(`s.taken_at >= (${add(input.dateFrom)}::date::timestamp AT TIME ZONE ${tz})`);
    }
    if (input.dateTo !== null) {
      parts.push(`s.taken_at < ((${add(input.dateTo)}::date + 1)::timestamp AT TIME ZONE ${tz})`);
    }
  }
  if (input.ageFromDays !== null) parts.push(`s.age_days >= ${add(input.ageFromDays)}::int`);
  if (input.ageToDays !== null) parts.push(`s.age_days <= ${add(input.ageToDays)}::int`);
  if (input.milestoneIds.length > 0) {
    parts.push(`s.milestone_ids && ${add([...input.milestoneIds])}::uuid[]`);
  }
  if (input.people.length > 0) {
    parts.push(
      `EXISTS (SELECT 1 FROM unnest(s.people) x WHERE lower(x) = ANY(${add(input.people.map((x) => x.toLowerCase()))}::text[]))`,
    );
  }
  if (input.tags.length > 0) {
    parts.push(`s.tags && ${add(input.tags.map((t) => t.toLowerCase()))}::text[]`);
  }
  if (input.place !== null) parts.push(`s.place = lower(${add(input.place)})`);
  const media = mediaFilter(input);
  if (media !== null) parts.push(`p.media_kind = ${add(media)}::text`);
  return { where: parts.join(" AND "), values };
}

const FROM = "public.photo_search s JOIN public.photos p ON p.id = s.photo_id";

/**
 * Narrows candidate ids from the SECURITY DEFINER legs to one media kind, under the caller's
 * claims (`photos` RLS). Exported for tests.
 */
export const MEDIA_NARROW_SQL =
  "SELECT p.id AS photo_id FROM public.photos p WHERE p.id = ANY($1::uuid[]) AND p.media_kind = $2::text";

/**
 * Keeps only the candidate ids of `media` kind, in their original order and cut to `limit`.
 * No-op (no query) without a media filter.
 */
export async function narrowToMedia(
  client: Tx,
  ids: readonly string[],
  media: "photo" | "video" | null,
  limit: number,
): Promise<string[]> {
  if (media === null) return ids.slice(0, limit);
  if (ids.length === 0) return [];
  const { rows } = await client.query<{ photo_id: string }>(MEDIA_NARROW_SQL, [ids, media]);
  const keep = new Set(rows.map((r) => r.photo_id));
  return ids.filter((id) => keep.has(id)).slice(0, limit);
}

/** Query embeddings per embedder instance, by text (LRU; no user or baby in the key). */
const QUERY_VECTOR_CACHE_MAX = 500;
const queryVectorCaches = new WeakMap<Embedder, Map<string, number[]>>();

/**
 * The query's vector, from a small LRU so a repeated query (the chat tool after a classic search,
 * a retry, a suggested prompt) skips the embedding round trip. Never logged.
 */
export async function embedQuery(embedder: Embedder, query: string): Promise<number[]> {
  let queryVectorCache = queryVectorCaches.get(embedder);
  if (!queryVectorCache) {
    queryVectorCache = new Map();
    queryVectorCaches.set(embedder, queryVectorCache);
  }
  const key = query;
  const hit = queryVectorCache.get(key);
  if (hit) {
    queryVectorCache.delete(key);
    queryVectorCache.set(key, hit);
    return hit;
  }
  const { vectors } = await embedder.embed([query]);
  const v = vectors[0] ?? [];
  queryVectorCache.set(key, v);
  if (queryVectorCache.size > QUERY_VECTOR_CACHE_MAX) {
    const oldest = queryVectorCache.keys().next().value;
    if (oldest !== undefined) queryVectorCache.delete(oldest);
  }
  return v;
}

/** `[0.1,0.2,…]` (pgvector text input). */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}

/** Query words (lower-case) and adjacent pairs, for the tag/people leg. Exported for tests. */
export function queryTokens(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length > 1);
  const out = new Set<string>(words);
  for (let i = 1; i < words.length; i++) out.add(`${words[i - 1]} ${words[i]}`);
  return [...out].slice(0, 40);
}

/** SQL of the exact vector path (filters run first behind the fence). */
export function exactVectorSql(where: string, qParam: string, limit: number): string {
  return `WITH cand AS MATERIALIZED (
      SELECT s.photo_id, s.embedding FROM ${FROM}
       WHERE ${where} AND s.embedding IS NOT NULL)
    SELECT photo_id, embedding <=> ${qParam}::vector AS d FROM cand ORDER BY d LIMIT ${limit}`;
}

/** SQL of the HNSW vector path (`ORDER BY embedding <=> q LIMIT n` is what uses the index). */
export function hnswVectorSql(where: string, qParam: string, limit: number): string {
  return `SELECT s.photo_id, s.embedding <=> ${qParam}::vector AS d FROM ${FROM}
     WHERE ${where} AND s.embedding IS NOT NULL
     ORDER BY s.embedding <=> ${qParam}::vector LIMIT ${limit}`;
}

/**
 * The 11 arguments of `photo_search_text_candidates` / `photo_search_term_candidates` after the
 * leg's own (`$2`: tsquery text or term array): filters as bind parameters, dates converted to the
 * half-open `[from, to)` instants in the caller's zone. Exported for the bench.
 */
export function candidateCall(
  fn: "text" | "term",
  input: HybridInput,
  limit: number,
): { text: string; values: unknown[] } {
  const leg =
    fn === "text"
      ? "replace(plainto_tsquery('english', $2::text)::text, ' & ', ' | ')::tsquery"
      : "$2::text[]";
  const name = fn === "text" ? "photo_search_text_candidates" : "photo_search_term_candidates";
  return {
    text: `SELECT photo_id FROM public.${name}(
        $1::uuid, ${leg}, $3::int,
        CASE WHEN $4::date IS NULL THEN NULL ELSE ($4::date::timestamp AT TIME ZONE $12::text) END,
        CASE WHEN $5::date IS NULL THEN NULL ELSE (($5::date + 1)::timestamp AT TIME ZONE $12::text) END,
        $6::int, $7::int, $8::uuid[], $9::text[], $10::text[], $11::text)`,
    values: [
      input.babyId,
      fn === "text" ? (input.query ?? "") : queryTokens(input.query ?? ""),
      limit,
      input.dateFrom,
      input.dateTo,
      input.ageFromDays,
      input.ageToDays,
      input.milestoneIds.length ? [...input.milestoneIds] : null,
      input.people.length ? input.people.map((x) => x.toLowerCase()) : null,
      input.tags.length ? input.tags.map((t) => t.toLowerCase()) : null,
      input.place,
      input.timezone,
    ],
  };
}

/** Sets the HNSW knobs for the rest of the (claims) transaction. */
export async function setHnswLocals(client: Tx, efSearch: number): Promise<void> {
  await client.query(
    `SELECT set_config('hnsw.ef_search', $1, true),
            set_config('hnsw.iterative_scan', 'relaxed_order', true),
            set_config('hnsw.max_scan_tuples', '20000', true)`,
    [String(Math.trunc(efSearch))],
  );
}

/**
 * Runs the hybrid search (see module doc). The embedding call happens only when there is a query,
 * an embedder and at least one candidate row with a vector, after the caller's gate.
 */
export async function hybridSearch(
  client: Tx,
  input: HybridInput,
  opts: HybridOptions,
): Promise<HybridResult> {
  const started = performance.now();
  let embedMs = 0;
  const { where, values } = filterSql(input);
  const done = (r: Omit<HybridResult, "tookMs" | "embedMs">): HybridResult => ({
    ...r,
    embedMs: Math.round(embedMs),
    tookMs: Math.max(0, Math.round(performance.now() - started - embedMs)),
  });

  // 2. Candidate count (capped) and how many of them have a vector.
  const capIdx = values.length + 1;
  const count = await client.query<{ n: number; embedded: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE c.has_vec)::int AS embedded
       FROM (SELECT (s.embedding IS NOT NULL) AS has_vec FROM ${FROM}
              WHERE ${where} LIMIT $${capIdx}) c`,
    [...values, opts.exactMax + 1],
  );
  const candidates = count.rows[0]?.n ?? 0;
  const embedded = count.rows[0]?.embedded ?? 0;
  if (candidates === 0) {
    return done({ ids: [], candidates: 0, truncated: false, degraded: null, path: "empty" });
  }

  // 3. Filters only: newest first, no model call.
  const query = input.query?.trim() || null;
  if (query === null) {
    const { rows } = await client.query<{ photo_id: string }>(
      `SELECT s.photo_id FROM ${FROM} WHERE ${where}
        ORDER BY s.taken_at DESC NULLS LAST, s.photo_id DESC LIMIT $${capIdx}`,
      [...values, input.limit + 1],
    );
    return done({
      ids: rows.slice(0, input.limit).map((r) => r.photo_id),
      candidates,
      truncated: rows.length > input.limit,
      degraded: null,
      path: "filters",
    });
  }

  // 4. Vector leg (with distances; the relevance floor is applied after the lexical legs).
  let vectorRows: { photo_id: string; d: number }[] = [];
  let path: HybridResult["path"] = "text";
  const degraded = opts.embedder === null || embedded === 0 ? ("no_embeddings" as const) : null;
  if (degraded === null && opts.embedder) {
    const t0 = performance.now();
    const queryVector = await embedQuery(opts.embedder, query);
    embedMs = performance.now() - t0;
    const qParam = `$${capIdx}`;
    const qv = vectorLiteral(queryVector);
    if (candidates <= opts.exactMax) {
      path = "exact";
      const { rows } = await client.query<{ photo_id: string; d: number }>(
        exactVectorSql(where, qParam, SEARCH_CANDIDATES),
        [...values, qv],
      );
      vectorRows = rows;
    } else {
      path = "hnsw";
      await setHnswLocals(client, opts.efSearch);
      const { rows } = await client.query<{ photo_id: string; d: number }>(
        hnswVectorSql(where, qParam, SEARCH_CANDIDATES),
        [...values, qv],
      );
      vectorRows = rows;
    }
  }

  // 5. Full-text and tag/people legs: SECURITY DEFINER candidate functions (authorised by
  // `search_baby_ids()`), because under RLS Postgres never uses the non-leakproof `tsv @@ q` /
  // `tags && x` operators as index conditions. With a media filter they over-fetch and are
  // narrowed to the media kind afterwards (the functions take no media argument).
  const media = mediaFilter(input);
  const legLimit = media === null ? SEARCH_CANDIDATES : SEARCH_CANDIDATES * MEDIA_OVERFETCH;
  const textCall = candidateCall("text", { ...input, query }, legLimit);
  const text = await client.query<{ photo_id: string }>(textCall.text, textCall.values);
  const tokens = queryTokens(query);
  const termCall = candidateCall("term", { ...input, query }, legLimit);
  const tag =
    tokens.length > 0
      ? await client.query<{ photo_id: string }>(termCall.text, termCall.values)
      : { rows: [] };
  const textIds = await narrowToMedia(
    client,
    text.rows.map((r) => r.photo_id),
    media,
    SEARCH_CANDIDATES,
  );
  const tagIds = await narrowToMedia(
    client,
    tag.rows.map((r) => r.photo_id),
    media,
    SEARCH_CANDIDATES,
  );

  // Relevance floor: vector-only candidates below the minimum similarity are dropped.
  const lexical = new Set([...textIds, ...tagIds]);
  const minSimilarity = opts.minSimilarity ?? defaultMinSimilarity(opts.embedder?.model);
  const vectorIds = vectorRows
    .filter((r) => lexical.has(r.photo_id) || 1 - Number(r.d) >= minSimilarity)
    .map((r) => r.photo_id);
  const belowFloor = vectorRows.length - vectorIds.length;

  // 6. RRF (ties by capture time).
  const legIds = [vectorIds, textIds, tagIds];
  const all = [...new Set(legIds.flat())];
  const takenAt = new Map<string, number>();
  if (all.length > 0) {
    const { rows } = await client.query<{ photo_id: string; t: Date | null }>(
      "SELECT s.photo_id, s.taken_at AS t FROM public.photo_search s WHERE s.photo_id = ANY($1::uuid[])",
      [all],
    );
    for (const r of rows) takenAt.set(r.photo_id, r.t?.getTime() ?? Number.NEGATIVE_INFINITY);
  }
  let fused = reciprocalRankFusion(legIds, { takenAt }).map((f) => f.id);

  // 7. Optional re-rank of the top 30 by captions (off by default, D6).
  if (opts.rerank && fused.length > 1) {
    const head = fused.slice(0, SEARCH_RERANK_CANDIDATES);
    const reranked = await rerankWithChat(client, opts.rerank, input.babyId, query, head);
    if (reranked) fused = [...reranked, ...fused.slice(head.length)];
  }

  opts.log?.info(
    {
      search: path,
      candidates,
      vector: vectorIds.length,
      belowFloor,
      text: textIds.length,
      tag: tagIds.length,
      media,
      fused: fused.length,
    },
    "hybrid search",
  );
  const returned = fused.slice(0, input.limit);
  const sims = new Map(vectorRows.map((r) => [r.photo_id, 1 - Number(r.d)]));
  return done({
    lexicalIds: returned.filter((id) => lexical.has(id)),
    similarity: Object.fromEntries(
      returned.filter((id) => sims.has(id)).map((id) => [id, sims.get(id) as number]),
    ),
    ids: returned,
    candidates,
    truncated: fused.length > input.limit,
    degraded,
    path,
  });
}
