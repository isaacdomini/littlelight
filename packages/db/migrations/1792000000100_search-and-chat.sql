-- Up Migration

-- Search and chat (docs/plans/step-7.md 2.3; PRD FR-6.3/6.4, FR-7.3-7.7, "Cost controls").
-- What this migration makes a database rule, independent of the API and the worker:
--
-- * `photo_search` holds parent notes inside `search_text`. It is readable by admins of a
--   paid-tier baby and by nobody else (contributors, viewers, strangers, admins of a free or
--   expired baby: 0 rows). The SELECT policy is rewritten to the set-returning helper pattern of
--   step 5 (`search_baby_ids()` on top of `admin_baby_ids()`), in the
--   `baby_id = ANY (ARRAY(SELECT ...))` form: one membership + plan evaluation per statement, an
--   InitPlan the planner can estimate, and a leakproof `uuid = ANY(array)` qual that the btree
--   indexes take as an Index Cond (plan D8, step-5 lesson).
-- * Under RLS the planner never pushes a non-leakproof user qual into an index (`tsv @@ q`,
--   `tags && x` are not leakproof), so the full-text and tag/people legs could not use their GIN
--   indexes as `authenticated`. Two SECURITY DEFINER candidate functions
--   (`photo_search_text_candidates`, `photo_search_term_candidates`) authorise the caller with the
--   same `search_baby_ids()` and return only photo ids and scores, so those legs keep their GIN
--   indexes without exposing a column RLS would hide. The vector leg needs no helper: an index
--   ORDER BY is not a qual, and HNSW is used under the policy above (verified with EXPLAIN).
-- * `photo_search_guard`: search content can only be written for an approved, live,
--   unquarantined photo of a `baby_ai_enabled` baby, for every role including the
--   pipeline and the seed. Free-tier babies get no search rows and no embeddings, ever (FR-5.8;
--   plan D3/D8). `photos_search_cleanup` deletes the row the moment its photo is trashed,
--   un-approved, quarantined, failed or marked duplicate (a quarantined photo exists for nobody,
--   and the policy no longer re-checks `photo_visible`).
-- * `search_stale_photos(...)` / `photo_search_orphans(...)`: the one definition of "needs
--   (re)indexing" and of "row to delete". Deleting a source row (detail, override, AI row,
--   linked measurement) clears `content_hash` so it is noticed too. Neither selects a GPS column.
-- * `ai_spend` (plan D7): the ledger for everything that is not a vision batch item. ENABLE +
--   FORCE RLS; `pipeline` writes embed rows only; admins of a paid baby write their own chat /
--   re-rank rows; `viewer` and contributors nothing; `ai_spend_guard` refuses a row for a
--   free-tier baby for every role. `ai_baby_month_cost_usd()` now sums `ai_batch_items` +
--   `ai_spend`, so the step-6 budget check, usage endpoint and alert cover embeddings and chat.
-- * Chat: one thread per user per baby (unique index, D4); `chat_messages` gains
--   `cited_measurement_ids`, `cost_usd`, `tools_used` (closed set of tool names, never
--   arguments) and `status`; `chat_messages_shape` bounds content and citation arrays (a
--   trigger, not a CHECK: the row holds parent-entered text). The 100 turns/day/user limit is
--   counted in `chat_turns`, a ledger that clearing the history does not reset:
--   `chat_reserve_turn(limit)` serialises one user's turns and reserves one,
--   `chat_messages_claim_turn` refuses a user message from `authenticated` that has no
--   reservation in its transaction. Viewers, contributors and the pipeline have no grant on any
--   chat table.
--
-- Nothing here stores, raises or logs a note, a document, a message, a prompt or bytes: every
-- error message is fixed text; `tools_used` is a list of tool names; `ai_spend` and
-- `chat_turns` hold numbers and ids. `viewer` gains nothing. `pipeline` gains only `ai_spend`
-- (embed rows), EXECUTE on the two reindex helpers and `lower_text_array`, and needs no data key.
-- Reversible: the down migration restores the step-2 `photo_search` policy and the step-6
-- `ai_baby_month_cost_usd` body verbatim.

-------------------------------------------------------------------------------------------------
-- photo_search: versioning / re-embed bookkeeping and the coarse place label (plan 2.3.1).
-- Existing since step 2 (unchanged): embedding vector(1024) with HNSW vector_cosine_ops
-- (m 16, ef_construction 64), GIN on tsv and on tags, btree (baby_id, taken_at|age_days).
-------------------------------------------------------------------------------------------------
ALTER TABLE public.photo_search
  ADD COLUMN IF NOT EXISTS doc_version  text,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS embedded_at  timestamptz,
  ADD COLUMN IF NOT EXISTS place        text;
COMMENT ON TABLE public.photo_search IS
  'Denormalised search document per approved live photo of a paid-tier baby (photo_search_guard). search_text contains parent notes; readable by admins of a paid baby only (search_baby_ids). Never a coordinate: place is a coarse label.';
COMMENT ON COLUMN public.photo_search.search_text IS
  'The embedded document (PRD "Search document"). Contains parent notes; readable by admins of a paid baby only. Never logged, never returned by a chat tool.';
COMMENT ON COLUMN public.photo_search.doc_version IS
  'SEARCH_DOC_VERSION the document was built with; a mismatch with the running version marks the row for re-indexing (search_stale_photos reason "version").';
COMMENT ON COLUMN public.photo_search.content_hash IS
  'sha256 hex of search_text at index time: an unchanged hash skips the embedding call. NULL = rebuild (a source row was deleted, or the seed wrote the row).';
COMMENT ON COLUMN public.photo_search.embedded_at IS
  'When `embedding` was last written by a model call; NULL while the row has no vector (no key, budget, seed).';
COMMENT ON COLUMN public.photo_search.embed_model IS
  'Embedding model tag, e.g. text-embedding-3-small/1024 or fake/1024; mismatch => re-embed.';
COMMENT ON COLUMN public.photo_search.place IS
  'Lower-cased coarse place label: photo_details.location_label, else photo_exif.place_label. Never coordinates (the FR-7.5 place chip).';
COMMENT ON COLUMN public.photo_search.taken_at IS
  'photos.sort_at at index time (capture date, else upload time) so date filters always match the timeline.';

-- lower_text_array: lower() over a text[] (IMMUTABLE, so it can back an expression index). The
-- people match of the tag/people leg is case-insensitive and needs a GIN index to stay an index
-- scan inside photo_search_term_candidates.
CREATE OR REPLACE FUNCTION public.lower_text_array(p text[]) RETURNS text[]
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT COALESCE(array_agg(lower(x) ORDER BY o), '{}'::text[]) FROM unnest(p) WITH ORDINALITY AS u(x, o)
$$;
COMMENT ON FUNCTION public.lower_text_array(text[]) IS
  'lower() of every element, order kept; {} for an empty array. IMMUTABLE (backs photo_search_people_lower_idx).';
REVOKE EXECUTE ON FUNCTION public.lower_text_array(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lower_text_array(text[]) TO authenticated, pipeline, service_role;

-- Reconcile: rows without a vector; facets/filters: (baby, place); people leg: lower(people).
CREATE INDEX IF NOT EXISTS photo_search_unembedded_idx ON public.photo_search (baby_id) WHERE embedding IS NULL;
CREATE INDEX IF NOT EXISTS photo_search_baby_id_place_idx ON public.photo_search (baby_id, place);
CREATE INDEX IF NOT EXISTS photo_search_people_lower_idx ON public.photo_search USING gin (public.lower_text_array(people));

-------------------------------------------------------------------------------------------------
-- search_baby_ids(): the babies whose search index the caller may read = babies the signed-in
-- user administers (admin_baby_ids(), i.e. baby_members, never client claims) AND that are
-- baby_ai_enabled (plus plan, live entitlement, not trashed). Empty without authenticated
-- claims. Used by the photo_search policy and the two candidate functions below.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_baby_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT b FROM public.admin_baby_ids() AS b WHERE public.baby_ai_enabled(b)
$$;
COMMENT ON FUNCTION public.search_baby_ids() IS
  'Baby ids the signed-in user administers that are baby_ai_enabled: who may read photo_search and use search and chat. Empty without authenticated claims. Set form for once-per-statement RLS.';
REVOKE EXECUTE ON FUNCTION public.search_baby_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_baby_ids() TO authenticated, service_role;

-- The SELECT policy (plan D8). The step-2 body was
--   is_baby_admin(baby_id) AND baby_ai_enabled(baby_id) AND photo_visible(photo_id)
-- (restored verbatim by the down migration): three SECURITY DEFINER calls per candidate row.
-- Liveness of the photo is no longer re-checked per row: photo_search_guard means a row is
-- written only for an approved live photo, photos_search_cleanup deletes it when that stops
-- being true, and the API joins `photos` (whose own RLS applies). The ARRAY(...) form (not
-- `IN (SELECT ...)`) gives the planner a real estimate (a hashed SubPlan is guessed at 50 %,
-- which made it prefer a sequential scan over HNSW) and is a btree Index Cond.
DROP POLICY IF EXISTS photo_search_authenticated_select ON public.photo_search;
CREATE POLICY photo_search_authenticated_select ON public.photo_search FOR SELECT TO authenticated
  USING (baby_id = ANY (ARRAY(SELECT public.search_baby_ids())));

-------------------------------------------------------------------------------------------------
-- photo_search_guard: search content only for an approved, live, unquarantined photo (not
-- failed, not a duplicate marker) of a paid-tier baby, and baby_id must be the photo's own. Every role, including pipeline and
-- the superuser-run seed. Fires on INSERT and on any write of the content columns (a new text
-- or vector for a downgraded baby would mean its data was processed); bookkeeping-only updates
-- (content_hash, updated_at) pass so the stale markers below work for every baby. SECURITY
-- DEFINER so the check does not depend on the writer's grants. Fixed message; nothing from the
-- row is echoed (it holds parent text).
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.photo_search_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.photos p
    WHERE p.id = NEW.photo_id
      AND p.baby_id = NEW.baby_id
      AND p.approval = 'approved'
      AND p.deleted_at IS NULL
      AND p.quarantined_at IS NULL
      AND p.status NOT IN ('failed', 'duplicate')
      AND public.baby_ai_enabled(p.baby_id)
  ) THEN
    RAISE EXCEPTION 'search rows can only be stored for approved live photos of a paid-tier baby'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_search_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_search_guard ON public.photo_search;
CREATE TRIGGER photo_search_guard
  BEFORE INSERT OR UPDATE OF photo_id, baby_id, search_text, embedding ON public.photo_search
  FOR EACH ROW EXECUTE FUNCTION public.photo_search_guard();

-- photos_search_cleanup: the photo stopped being indexable => its search row goes now, not at
-- the next reconcile. Restoring from trash makes it "missing" for search_stale_photos.
CREATE OR REPLACE FUNCTION public.photos_search_cleanup() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.photo_search s WHERE s.photo_id = NEW.id;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photos_search_cleanup() FROM PUBLIC;
DROP TRIGGER IF EXISTS photos_search_cleanup ON public.photos;
CREATE TRIGGER photos_search_cleanup
  AFTER UPDATE OF deleted_at, approval, quarantined_at, status ON public.photos
  FOR EACH ROW
  WHEN (NEW.deleted_at IS NOT NULL OR NEW.approval <> 'approved' OR NEW.quarantined_at IS NOT NULL
        OR NEW.status IN ('failed', 'duplicate'))
  EXECUTE FUNCTION public.photos_search_cleanup();

-- photo_search_mark_stale: a source row of the document was deleted (or a measurement moved to
-- another photo). updated_at comparisons cannot see a deletion, so clear content_hash: the row is
-- "stale" for search_stale_photos and the worker cannot skip it by hash. Skipped when the photo
-- itself is gone (cascade from a photo/baby delete removes the search row anyway).
CREATE OR REPLACE FUNCTION public.photo_search_mark_stale() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.photo_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.photos p WHERE p.id = OLD.photo_id) THEN
    UPDATE public.photo_search s SET content_hash = NULL
    WHERE s.photo_id = OLD.photo_id AND s.content_hash IS NOT NULL;
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_search_mark_stale() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_details_search_stale ON public.photo_details;
CREATE TRIGGER photo_details_search_stale AFTER DELETE ON public.photo_details
  FOR EACH ROW EXECUTE FUNCTION public.photo_search_mark_stale();
DROP TRIGGER IF EXISTS photo_ai_search_stale ON public.photo_ai;
CREATE TRIGGER photo_ai_search_stale AFTER DELETE ON public.photo_ai
  FOR EACH ROW EXECUTE FUNCTION public.photo_search_mark_stale();
DROP TRIGGER IF EXISTS photo_ai_overrides_search_stale ON public.photo_ai_overrides;
CREATE TRIGGER photo_ai_overrides_search_stale AFTER DELETE ON public.photo_ai_overrides
  FOR EACH ROW EXECUTE FUNCTION public.photo_search_mark_stale();
DROP TRIGGER IF EXISTS measurements_search_stale ON public.measurements;
CREATE TRIGGER measurements_search_stale AFTER DELETE ON public.measurements
  FOR EACH ROW EXECUTE FUNCTION public.photo_search_mark_stale();
DROP TRIGGER IF EXISTS measurements_search_stale_move ON public.measurements;
CREATE TRIGGER measurements_search_stale_move AFTER UPDATE OF photo_id ON public.measurements
  FOR EACH ROW WHEN (OLD.photo_id IS DISTINCT FROM NEW.photo_id)
  EXECUTE FUNCTION public.photo_search_mark_stale();

-------------------------------------------------------------------------------------------------
-- search_stale_photos: THE definition of "needs (re)indexing" (plan 2.3.4). Live, approved,
-- unquarantined photos of baby_ai_enabled babies whose ingest produced something to index
-- (status ingested/queued/analyzing/ready) where
--   missing     no photo_search row,
--   unembedded  the row has no vector (no key at the time, budget, seed),
--   version     embed_model / doc_version differ from the running pair,
--   stale       content_hash is NULL (a source row was deleted) or photo_search.updated_at is
--               older than any source: photos, photo_exif, photo_details, photo_ai, the tagged
--               milestone, the newest override, the newest linked measurement.
-- Oldest photo first; p_limit NULL = no limit. SECURITY INVOKER: the pipeline reads every photo
-- and these tables already. Only updated_at is read from photo_exif: no GPS column is selected.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_stale_photos(
  p_limit integer,
  p_embed_model text,
  p_doc_version text,
  p_baby_id uuid DEFAULT NULL
) RETURNS TABLE (photo_id uuid, baby_id uuid, reason text)
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT p.id AS photo_id,
         p.baby_id,
         CASE
           WHEN s.photo_id IS NULL THEN 'missing'
           WHEN s.embedding IS NULL THEN 'unembedded'
           WHEN s.embed_model IS DISTINCT FROM p_embed_model
             OR s.doc_version IS DISTINCT FROM p_doc_version THEN 'version'
           ELSE 'stale'
         END AS reason
  FROM public.photos p
  LEFT JOIN public.photo_search s ON s.photo_id = p.id
  LEFT JOIN public.photo_exif e ON e.photo_id = p.id
  LEFT JOIN public.photo_details d ON d.photo_id = p.id
  LEFT JOIN public.photo_ai a ON a.photo_id = p.id
  LEFT JOIN public.milestones m ON m.id = d.milestone_id
  WHERE p.approval = 'approved'
    AND p.deleted_at IS NULL
    AND p.quarantined_at IS NULL
    AND p.status NOT IN ('uploaded', 'failed', 'duplicate')
    AND p.baby_id IN (
      SELECT b.id FROM public.babies b
      WHERE (p_baby_id IS NULL OR b.id = p_baby_id) AND public.baby_ai_enabled(b.id)
    )
    AND (
      s.photo_id IS NULL
      OR s.embedding IS NULL
      OR s.embed_model IS DISTINCT FROM p_embed_model
      OR s.doc_version IS DISTINCT FROM p_doc_version
      OR s.content_hash IS NULL
      OR s.updated_at < GREATEST(
           p.updated_at,
           e.updated_at,
           d.updated_at,
           a.updated_at,
           m.updated_at,
           (SELECT max(o.updated_at) FROM public.photo_ai_overrides o WHERE o.photo_id = p.id),
           (SELECT max(x.updated_at) FROM public.measurements x WHERE x.photo_id = p.id)
         )
    )
  ORDER BY p.created_at, p.id
  LIMIT p_limit
$$;
COMMENT ON FUNCTION public.search_stale_photos(integer, text, text, uuid) IS
  'Photos of paid babies that need (re)indexing with the reason missing | unembedded | version | stale (docs/plans/step-7.md 2.3.4); oldest first; p_limit NULL = no limit. Never returns a photo of a free-tier baby, a pending/trashed/quarantined photo or a GPS column.';
REVOKE EXECUTE ON FUNCTION public.search_stale_photos(integer, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_stale_photos(integer, text, text, uuid) TO pipeline, service_role;

-- photo_search_orphans: rows whose photo may no longer be indexed. photos_search_cleanup removes
-- them as they appear; this is the safety net (rows from before this migration, manual writes).
-- Downgraded babies keep their rows: hidden by RLS, live again on re-upgrade (FR-5.8).
CREATE OR REPLACE FUNCTION public.photo_search_orphans(p_limit integer) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.photo_id
  FROM public.photo_search s
  JOIN public.photos p ON p.id = s.photo_id
  WHERE p.deleted_at IS NOT NULL
     OR p.approval <> 'approved'
     OR p.quarantined_at IS NOT NULL
     OR p.status IN ('failed', 'duplicate')
     OR p.baby_id <> s.baby_id
  ORDER BY s.photo_id
  LIMIT p_limit
$$;
COMMENT ON FUNCTION public.photo_search_orphans(integer) IS
  'photo_search rows whose photo is trashed, not approved, quarantined, failed, a duplicate marker or of another baby: delete targets for the reconcile. Downgraded babies keep their rows (hidden by RLS).';
REVOKE EXECUTE ON FUNCTION public.photo_search_orphans(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.photo_search_orphans(integer) TO pipeline, service_role;

-------------------------------------------------------------------------------------------------
-- Candidate functions for the GIN legs of hybrid search (see the header). SECURITY DEFINER,
-- authenticated/service_role only, no dynamic SQL. Authorisation: p_baby_id must be in
-- search_baby_ids() (admin of that baby + baby_ai_enabled, from baby_members and auth_uid()),
-- else the result is empty, exactly what RLS would return. Output: photo ids and a score of
-- live approved unquarantined photos of that one baby; never search_text, a note or any other
-- column. Filters mirror the API's filterSql (every filter optional: NULL or empty = off):
-- taken_at in [p_taken_from, p_taken_to), age_days in [p_age_from, p_age_to], milestone_ids
-- overlap, any of p_people (case-insensitive), tags overlap (lower-case), place = lower(p_place).
-- p_limit is clamped to 1..200.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.photo_search_text_candidates(
  p_baby_id uuid,
  p_query tsquery,
  p_limit integer,
  p_taken_from timestamptz DEFAULT NULL,
  p_taken_to timestamptz DEFAULT NULL,
  p_age_from integer DEFAULT NULL,
  p_age_to integer DEFAULT NULL,
  p_milestone_ids uuid[] DEFAULT NULL,
  p_people text[] DEFAULT NULL,
  p_tags text[] DEFAULT NULL,
  p_place text DEFAULT NULL
) RETURNS TABLE (photo_id uuid, rank real)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_people text[] := public.lower_text_array(p_people);
BEGIN
  IF p_baby_id IS NULL OR p_query IS NULL OR numnode(p_query) = 0
     OR NOT (p_baby_id = ANY (ARRAY(SELECT public.search_baby_ids()))) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT s.photo_id, ts_rank_cd(s.tsv, p_query) AS rank
    FROM public.photo_search s
    JOIN public.photos p ON p.id = s.photo_id
    WHERE s.baby_id = p_baby_id
      AND s.tsv @@ p_query
      AND p.baby_id = p_baby_id
      AND p.deleted_at IS NULL
      AND p.approval = 'approved'
      AND p.quarantined_at IS NULL
      AND (p_taken_from IS NULL OR s.taken_at >= p_taken_from)
      AND (p_taken_to IS NULL OR s.taken_at < p_taken_to)
      AND (p_age_from IS NULL OR s.age_days >= p_age_from)
      AND (p_age_to IS NULL OR s.age_days <= p_age_to)
      AND (COALESCE(cardinality(p_milestone_ids), 0) = 0 OR s.milestone_ids && p_milestone_ids)
      AND (COALESCE(cardinality(v_people), 0) = 0
           OR EXISTS (SELECT 1 FROM unnest(s.people) x WHERE lower(x) = ANY (v_people)))
      AND (COALESCE(cardinality(p_tags), 0) = 0 OR s.tags && p_tags)
      AND (p_place IS NULL OR s.place = lower(p_place))
    ORDER BY 2 DESC, s.taken_at DESC NULLS LAST, s.photo_id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END
$$;
COMMENT ON FUNCTION public.photo_search_text_candidates(uuid, tsquery, integer, timestamptz, timestamptz, integer, integer, uuid[], text[], text[], text) IS
  'Full-text leg of hybrid search on the GIN tsv index: (photo_id, ts_rank_cd) of one baby the caller may search (search_baby_ids), best first. Empty for anyone else. Ids and scores only.';
REVOKE EXECUTE ON FUNCTION public.photo_search_text_candidates(uuid, tsquery, integer, timestamptz, timestamptz, integer, integer, uuid[], text[], text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.photo_search_text_candidates(uuid, tsquery, integer, timestamptz, timestamptz, integer, integer, uuid[], text[], text[], text) TO authenticated, service_role;

-- Tag/people leg: p_terms (query words and adjacent pairs) against tags (GIN) and lower(people)
-- (GIN photo_search_people_lower_idx). hits = matching tags + 2 x matching people.
CREATE OR REPLACE FUNCTION public.photo_search_term_candidates(
  p_baby_id uuid,
  p_terms text[],
  p_limit integer,
  p_taken_from timestamptz DEFAULT NULL,
  p_taken_to timestamptz DEFAULT NULL,
  p_age_from integer DEFAULT NULL,
  p_age_to integer DEFAULT NULL,
  p_milestone_ids uuid[] DEFAULT NULL,
  p_people text[] DEFAULT NULL,
  p_tags text[] DEFAULT NULL,
  p_place text DEFAULT NULL
) RETURNS TABLE (photo_id uuid, hits integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_terms  text[] := public.lower_text_array(p_terms);
  v_people text[] := public.lower_text_array(p_people);
BEGIN
  IF p_baby_id IS NULL OR COALESCE(cardinality(v_terms), 0) = 0
     OR NOT (p_baby_id = ANY (ARRAY(SELECT public.search_baby_ids()))) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT s.photo_id,
           ((SELECT count(*) FROM unnest(s.tags) t WHERE t = ANY (v_terms))
            + 2 * (SELECT count(*) FROM unnest(s.people) x WHERE lower(x) = ANY (v_terms)))::integer AS hits
    FROM public.photo_search s
    JOIN public.photos p ON p.id = s.photo_id
    WHERE s.baby_id = p_baby_id
      AND (s.tags && v_terms OR public.lower_text_array(s.people) && v_terms)
      AND p.baby_id = p_baby_id
      AND p.deleted_at IS NULL
      AND p.approval = 'approved'
      AND p.quarantined_at IS NULL
      AND (p_taken_from IS NULL OR s.taken_at >= p_taken_from)
      AND (p_taken_to IS NULL OR s.taken_at < p_taken_to)
      AND (p_age_from IS NULL OR s.age_days >= p_age_from)
      AND (p_age_to IS NULL OR s.age_days <= p_age_to)
      AND (COALESCE(cardinality(p_milestone_ids), 0) = 0 OR s.milestone_ids && p_milestone_ids)
      AND (COALESCE(cardinality(v_people), 0) = 0
           OR EXISTS (SELECT 1 FROM unnest(s.people) x WHERE lower(x) = ANY (v_people)))
      AND (COALESCE(cardinality(p_tags), 0) = 0 OR s.tags && p_tags)
      AND (p_place IS NULL OR s.place = lower(p_place))
    ORDER BY 2 DESC, s.taken_at DESC NULLS LAST, s.photo_id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END
$$;
COMMENT ON FUNCTION public.photo_search_term_candidates(uuid, text[], integer, timestamptz, timestamptz, integer, integer, uuid[], text[], text[], text) IS
  'Tag/people leg of hybrid search on the GIN tags and lower(people) indexes: (photo_id, hits) of one baby the caller may search (search_baby_ids), best first. Empty for anyone else. Ids and counts only.';
REVOKE EXECUTE ON FUNCTION public.photo_search_term_candidates(uuid, text[], integer, timestamptz, timestamptz, integer, integer, uuid[], text[], text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.photo_search_term_candidates(uuid, text[], integer, timestamptz, timestamptz, integer, integer, uuid[], text[], text[], text) TO authenticated, service_role;

-------------------------------------------------------------------------------------------------
-- ai_spend: the non-batch spend ledger (plan 2.3.6, D7). No column holds parent text, so plain
-- CHECKs are safe here (a failing CHECK echoes only numbers, ids and a model name).
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_spend (
  id                   uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id              uuid           NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  -- The chat actor; NULL for embeddings (pipeline rows never carry a user).
  user_id              uuid           REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  kind                 text           NOT NULL CHECK (kind IN ('embed', 'chat', 'rerank')),
  -- chat: the assistant chat_messages.id; embed: NULL. No FK: clearing the history must not
  -- remove spend from the ledger.
  ref_id               uuid,
  model                text           NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  input_tokens         integer        CHECK (input_tokens >= 0),
  cached_input_tokens  integer        CHECK (cached_input_tokens >= 0),
  output_tokens        integer        CHECK (output_tokens >= 0),
  reasoning_tokens     integer        CHECK (reasoning_tokens >= 0),
  -- embed: documents in the call; chat: model calls in the turn.
  item_count           integer        CHECK (item_count >= 0),
  cost_usd             numeric(12,8)  NOT NULL CHECK (cost_usd >= 0),
  created_at           timestamptz    NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ai_spend IS
  'Spend that is not a vision batch item: embeddings (pipeline), chat turns and optional re-rank (admins). Summed into ai_baby_month_cost_usd with ai_batch_items. Numbers, ids and a model name only: never text, prompts, notes or messages.';
CREATE INDEX IF NOT EXISTS ai_spend_baby_id_created_at_idx ON public.ai_spend (baby_id, created_at);
ALTER TABLE public.ai_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_spend FORCE ROW LEVEL SECURITY;

-- No spend row for a free-tier (or trashed) baby, for every role incl. service_role and the
-- superuser: a free baby never reaches a model, so a cost for it is a bug, not a fact.
CREATE OR REPLACE FUNCTION public.ai_spend_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.baby_ai_enabled(NEW.baby_id) THEN
    RAISE EXCEPTION 'AI spend can only be recorded for a paid-tier baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.ai_spend_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS ai_spend_guard ON public.ai_spend;
CREATE TRIGGER ai_spend_guard BEFORE INSERT ON public.ai_spend
  FOR EACH ROW EXECUTE FUNCTION public.ai_spend_guard();

-- Grants: service_role everything (billing, deletion; BYPASSRLS). pipeline: INSERT of embed rows
-- without a user, SELECT of every row (ai_baby_month_cost_usd is SECURITY INVOKER and the
-- worker's budget check must see chat spend too; the rows are numbers). authenticated: INSERT of
-- own chat/rerank rows for a paid baby they administer, SELECT of the rows of babies they
-- administer (usage endpoint, chat budget check). Neither can backdate a row (created_at is not
-- granted) nor UPDATE/DELETE: the ledger is append-only below service_role.
-- viewer and contributors: nothing.
GRANT ALL ON public.ai_spend TO service_role;
GRANT SELECT ON public.ai_spend TO pipeline;
GRANT INSERT (baby_id, user_id, kind, ref_id, model, input_tokens, cached_input_tokens, output_tokens,
              reasoning_tokens, item_count, cost_usd) ON public.ai_spend TO pipeline;
GRANT SELECT ON public.ai_spend TO authenticated;
GRANT INSERT (id, baby_id, user_id, kind, ref_id, model, input_tokens, cached_input_tokens, output_tokens,
              reasoning_tokens, item_count, cost_usd) ON public.ai_spend TO authenticated;

DROP POLICY IF EXISTS ai_spend_pipeline_select ON public.ai_spend;
CREATE POLICY ai_spend_pipeline_select ON public.ai_spend FOR SELECT TO pipeline USING (true);
DROP POLICY IF EXISTS ai_spend_pipeline_insert ON public.ai_spend;
CREATE POLICY ai_spend_pipeline_insert ON public.ai_spend FOR INSERT TO pipeline
  WITH CHECK (kind = 'embed' AND user_id IS NULL AND ref_id IS NULL);
DROP POLICY IF EXISTS ai_spend_authenticated_select ON public.ai_spend;
CREATE POLICY ai_spend_authenticated_select ON public.ai_spend FOR SELECT TO authenticated
  USING (baby_id = ANY (ARRAY(SELECT public.admin_baby_ids())));
DROP POLICY IF EXISTS ai_spend_authenticated_insert ON public.ai_spend;
CREATE POLICY ai_spend_authenticated_insert ON public.ai_spend FOR INSERT TO authenticated
  WITH CHECK (
    public.is_baby_admin(baby_id)
    AND user_id = public.auth_uid()
    AND public.baby_ai_enabled(baby_id)
    AND kind IN ('chat', 'rerank')
  );

-------------------------------------------------------------------------------------------------
-- ai_baby_month_cost_usd: now ai_batch_items + ai_spend for the UTC month (plan 2.3.7). Same
-- signature and grants; the step-6 budget check, usage endpoint and alert pick it up unchanged.
-- SECURITY INVOKER: pipeline / service_role see everything; an authenticated admin sees all
-- items and spend of their baby (a stranger gets 0).
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_baby_month_cost_usd(p_baby_id uuid, p_month date) RETURNS numeric
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  WITH bounds AS (
    SELECT (date_trunc('month', p_month::timestamp) AT TIME ZONE 'UTC') AS lo,
           ((date_trunc('month', p_month::timestamp) + interval '1 month') AT TIME ZONE 'UTC') AS hi
  )
  SELECT (
      COALESCE((SELECT sum(i.cost_usd) FROM public.ai_batch_items i, bounds w
                WHERE i.baby_id = p_baby_id AND i.created_at >= w.lo AND i.created_at < w.hi), 0)
    + COALESCE((SELECT sum(s.cost_usd) FROM public.ai_spend s, bounds w
                WHERE s.baby_id = p_baby_id AND s.created_at >= w.lo AND s.created_at < w.hi), 0)
  )::numeric
$$;
COMMENT ON FUNCTION public.ai_baby_month_cost_usd(uuid, date) IS
  'Sum of ai_batch_items.cost_usd and ai_spend.cost_usd for the baby in the UTC calendar month containing p_month (0 when none). Attributed by created_at. Covers vision batches, embeddings, chat and re-rank.';

-------------------------------------------------------------------------------------------------
-- Chat. Policies are unchanged from step 2: every chat row is the caller's own and requires
-- is_baby_admin; writing a thread or message also requires baby_ai_enabled (FR-7.7). Reading
-- and clearing one's own history stays possible after a downgrade (data rights; the API answers
-- plan_required before any read). viewer, contributors (not admins) and pipeline: nothing.
-------------------------------------------------------------------------------------------------

-- One history thread per user per baby (plan D4): find-or-create cannot race into two threads.
CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_baby_id_user_id_key ON public.chat_threads (baby_id, user_id);

-- chat_messages: citations of measurements, per-turn cost, tool names, status (plan 2.3.8).
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS cited_measurement_ids uuid[]        NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cost_usd              numeric(12,8),
  ADD COLUMN IF NOT EXISTS tools_used            text[]        NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status                text          NOT NULL DEFAULT 'complete';
-- `col IN (...)` is the only CHECK form allowed on a table holding parent text (README "Writing
-- a migration"); everything else is in chat_messages_shape below, so a violation by a role that
-- bypasses RLS never writes "Failing row contains (...)" (the message text) into the log.
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_status_check;
ALTER TABLE public.chat_messages ADD CONSTRAINT chat_messages_status_check
  CHECK (status IN ('complete', 'error'));
COMMENT ON COLUMN public.chat_messages.tools_used IS
  'Names of the tools the assistant called for this turn (closed set = @littlelight/shared CHAT_TOOL_NAMES); never arguments or results.';
COMMENT ON COLUMN public.chat_messages.status IS
  'complete, or error for an assistant message written after a model/tool failure (fixed text, no provider message).';
COMMENT ON COLUMN public.chat_messages.cited_measurement_ids IS
  'measurement ids the answer cited; validated by the API against the turn''s tool results.';
-- Column grants are additive: the step-2 lists keep working and gain the new columns.
GRANT INSERT (cited_measurement_ids, cost_usd, tools_used, status) ON public.chat_messages TO authenticated;
GRANT UPDATE (cited_measurement_ids, cost_usd, tools_used, status) ON public.chat_messages TO authenticated;

-- chat_messages_shape: content 1..8000 characters, at most 50 cited photo ids, 50 cited
-- measurement ids and 16 tool names, every tool name in the closed set (= @littlelight/shared
-- CHAT_TOOL_NAMES: never arguments), cost_usd >= 0. A trigger, not a CHECK: the row holds the
-- parent's question and the model's answer (which may quote notes). Fixed messages.
CREATE OR REPLACE FUNCTION public.chat_messages_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF length(NEW.content) < 1 OR length(NEW.content) > 8000 THEN
    RAISE EXCEPTION 'chat_messages.content must be 1 to 8000 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW.cited_photo_ids) > 50 THEN
    RAISE EXCEPTION 'chat_messages.cited_photo_ids holds more than 50 ids' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW.cited_measurement_ids) > 50 THEN
    RAISE EXCEPTION 'chat_messages.cited_measurement_ids holds more than 50 ids' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW.tools_used) > 16 THEN
    RAISE EXCEPTION 'chat_messages.tools_used holds more than 16 entries' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW.tools_used <@ ARRAY['search_photos', 'get_measurements', 'get_milestones', 'get_photo']::text[]) THEN
    RAISE EXCEPTION 'chat_messages.tools_used holds a name that is not a chat tool' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.cost_usd < 0 THEN
    RAISE EXCEPTION 'chat_messages.cost_usd must not be negative' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.chat_messages_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS chat_messages_shape ON public.chat_messages;
CREATE TRIGGER chat_messages_shape
  BEFORE INSERT OR UPDATE OF content, cited_photo_ids, cited_measurement_ids, tools_used, cost_usd ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_messages_shape();

-------------------------------------------------------------------------------------------------
-- The 100 turns/day/user limit ("Cost controls"; CHAT_TURNS_PER_DAY). Counted in `chat_turns`,
-- not in chat_messages: clearing the history (DELETE thread, cascade) must not reset the limit.
-- A rolling 24 h window per user across all babies, regardless of current membership.
--
--   chat_reserve_turn(p_limit)  takes a transaction-scoped advisory lock on the user (concurrent
--                               turns of one user queue here), drops the user's rows older than
--                               24 h and unclaimed reservations of other transactions, counts the
--                               claimed turns and, when turns < p_limit, records a reservation
--                               for this transaction (idempotent). Returns (turns before this
--                               one, oldest counted turn, allowed).
--   chat_messages_claim_turn    AFTER INSERT of a role 'user' message: claims this
--                               transaction's reservation; from `authenticated` a user message
--                               without one is refused (check_violation), so the limit holds
--                               even if the API forgets to reserve. Inserts by service_role or
--                               the superuser (fixtures) are counted without a reservation.
--
-- A reservation that is never claimed (the API refused for budget and committed) does not count.
-- The ledger holds a user id, a transaction id and times: nothing about the conversation.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_turns (
  id            bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid         NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  reserved_xid  xid8         NOT NULL,
  claimed_at    timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.chat_turns IS
  'Chat turn ledger for the 24 h per-user limit (chat_reserve_turn / chat_messages_claim_turn). Survives clearing the history; rows older than 24 h are pruned on the next reservation. No conversation data.';
CREATE INDEX IF NOT EXISTS chat_turns_user_id_created_at_idx ON public.chat_turns (user_id, created_at);
ALTER TABLE public.chat_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_turns FORCE ROW LEVEL SECURITY;
-- Written and read only through the SECURITY DEFINER functions below; service_role (BYPASSRLS)
-- for operations. No grant to authenticated, viewer or pipeline.
GRANT ALL ON public.chat_turns TO service_role;

CREATE OR REPLACE FUNCTION public.chat_user_turns_24h() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM public.chat_turns t
  WHERE t.user_id = public.auth_uid()
    AND t.claimed_at IS NOT NULL
    AND t.created_at > now() - interval '24 hours'
$$;
COMMENT ON FUNCTION public.chat_user_turns_24h() IS
  'Chat turns of the signed-in user in the last 24 hours, across all babies regardless of current membership and of cleared history (the 100 turns/day/user limit; CHAT_TURNS_PER_DAY). 0 without authenticated claims.';
REVOKE EXECUTE ON FUNCTION public.chat_user_turns_24h() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_user_turns_24h() TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_reserve_turn(p_limit integer)
  RETURNS TABLE (turns integer, oldest_at timestamptz, allowed boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid    uuid := public.auth_uid();
  v_xid    xid8;
  v_turns  integer;
  v_oldest timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat_reserve_turn requires authenticated claims' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'chat_reserve_turn expects a positive limit' USING ERRCODE = 'check_violation';
  END IF;
  v_xid := pg_current_xact_id();
  -- Serialises this user's turns until the caller's transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('chat.turn'), hashtext(v_uid::text));
  DELETE FROM public.chat_turns t
  WHERE t.user_id = v_uid
    AND (t.created_at <= now() - interval '24 hours'
         OR (t.claimed_at IS NULL AND t.reserved_xid <> v_xid));
  SELECT count(*)::integer, min(t.created_at) INTO v_turns, v_oldest
  FROM public.chat_turns t
  WHERE t.user_id = v_uid AND t.claimed_at IS NOT NULL;
  IF v_turns < p_limit AND NOT EXISTS (
    SELECT 1 FROM public.chat_turns t
    WHERE t.user_id = v_uid AND t.reserved_xid = v_xid AND t.claimed_at IS NULL
  ) THEN
    INSERT INTO public.chat_turns (user_id, reserved_xid) VALUES (v_uid, v_xid);
  END IF;
  RETURN QUERY SELECT v_turns, v_oldest, v_turns < p_limit;
END
$$;
COMMENT ON FUNCTION public.chat_reserve_turn(integer) IS
  'Advisory-lock the signed-in user for the rest of the transaction, count their claimed turns in the last 24 h and, when turns < p_limit, reserve one for this transaction. Returns (turns before this one, oldest counted turn, allowed). The user message inserted in the same transaction claims the reservation; on allowed = false answer 429 with Retry-After = oldest_at + 24 h - now().';
REVOKE EXECUTE ON FUNCTION public.chat_reserve_turn(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_reserve_turn(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_messages_claim_turn() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_xid xid8 := pg_current_xact_id();
BEGIN
  UPDATE public.chat_turns t SET claimed_at = now()
  WHERE t.id = (
    SELECT t2.id FROM public.chat_turns t2
    WHERE t2.user_id = NEW.user_id AND t2.reserved_xid = v_xid AND t2.claimed_at IS NULL
    ORDER BY t2.id LIMIT 1
  );
  IF NOT FOUND THEN
    -- current_setting('role') is the caller's SET ROLE, unchanged by SECURITY DEFINER.
    IF current_setting('role', true) = 'authenticated' THEN
      RAISE EXCEPTION 'a user chat message needs a turn reserved with chat_reserve_turn in the same transaction'
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.chat_turns (user_id, reserved_xid, claimed_at) VALUES (NEW.user_id, v_xid, now());
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.chat_messages_claim_turn() FROM PUBLIC;
-- AFTER, so RLS / thread-guard violations are reported first and unchanged.
DROP TRIGGER IF EXISTS chat_messages_claim_turn ON public.chat_messages;
CREATE TRIGGER chat_messages_claim_turn AFTER INSERT ON public.chat_messages
  FOR EACH ROW WHEN (NEW.role = 'user')
  EXECUTE FUNCTION public.chat_messages_claim_turn();

-- Down Migration

-- chat ----------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS chat_messages_claim_turn ON public.chat_messages;
DROP FUNCTION IF EXISTS public.chat_messages_claim_turn();
DROP FUNCTION IF EXISTS public.chat_reserve_turn(integer);
DROP FUNCTION IF EXISTS public.chat_user_turns_24h();
DROP TABLE IF EXISTS public.chat_turns;
DROP TRIGGER IF EXISTS chat_messages_shape ON public.chat_messages;
DROP FUNCTION IF EXISTS public.chat_messages_shape();
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_status_check;
ALTER TABLE public.chat_messages
  DROP COLUMN IF EXISTS cited_measurement_ids,
  DROP COLUMN IF EXISTS cost_usd,
  DROP COLUMN IF EXISTS tools_used,
  DROP COLUMN IF EXISTS status;
DROP INDEX IF EXISTS public.chat_threads_baby_id_user_id_key;

-- ai_baby_month_cost_usd: the step-6 body, verbatim (ai_batch_items only).
CREATE OR REPLACE FUNCTION public.ai_baby_month_cost_usd(p_baby_id uuid, p_month date) RETURNS numeric
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(sum(i.cost_usd), 0)::numeric
  FROM public.ai_batch_items i
  WHERE i.baby_id = p_baby_id
    AND i.created_at >= (date_trunc('month', p_month::timestamp) AT TIME ZONE 'UTC')
    AND i.created_at <  ((date_trunc('month', p_month::timestamp) + interval '1 month') AT TIME ZONE 'UTC')
$$;
COMMENT ON FUNCTION public.ai_baby_month_cost_usd(uuid, date) IS
  'Sum of ai_batch_items.cost_usd for the baby in the UTC calendar month containing p_month (0 when none). Items are attributed by created_at (claim time), which is when the budget check happens.';

-- ai_spend ------------------------------------------------------------------------------------
DROP TABLE IF EXISTS public.ai_spend;
DROP FUNCTION IF EXISTS public.ai_spend_guard();

-- search helpers ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.photo_search_term_candidates(uuid, text[], integer, timestamptz, timestamptz, integer, integer, uuid[], text[], text[], text);
DROP FUNCTION IF EXISTS public.photo_search_text_candidates(uuid, tsquery, integer, timestamptz, timestamptz, integer, integer, uuid[], text[], text[], text);
DROP FUNCTION IF EXISTS public.photo_search_orphans(integer);
DROP FUNCTION IF EXISTS public.search_stale_photos(integer, text, text, uuid);
DROP TRIGGER IF EXISTS measurements_search_stale_move ON public.measurements;
DROP TRIGGER IF EXISTS measurements_search_stale ON public.measurements;
DROP TRIGGER IF EXISTS photo_ai_overrides_search_stale ON public.photo_ai_overrides;
DROP TRIGGER IF EXISTS photo_ai_search_stale ON public.photo_ai;
DROP TRIGGER IF EXISTS photo_details_search_stale ON public.photo_details;
DROP FUNCTION IF EXISTS public.photo_search_mark_stale();
DROP TRIGGER IF EXISTS photos_search_cleanup ON public.photos;
DROP FUNCTION IF EXISTS public.photos_search_cleanup();
DROP TRIGGER IF EXISTS photo_search_guard ON public.photo_search;
DROP FUNCTION IF EXISTS public.photo_search_guard();

-- photo_search policy: the step-2 body, verbatim.
DROP POLICY IF EXISTS photo_search_authenticated_select ON public.photo_search;
CREATE POLICY photo_search_authenticated_select ON public.photo_search FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id) AND public.baby_ai_enabled(baby_id) AND public.photo_visible(photo_id));
DROP FUNCTION IF EXISTS public.search_baby_ids();

DROP INDEX IF EXISTS public.photo_search_people_lower_idx;
DROP INDEX IF EXISTS public.photo_search_baby_id_place_idx;
DROP INDEX IF EXISTS public.photo_search_unembedded_idx;
DROP FUNCTION IF EXISTS public.lower_text_array(text[]);
COMMENT ON TABLE public.photo_search IS NULL;
COMMENT ON COLUMN public.photo_search.search_text IS NULL;
COMMENT ON COLUMN public.photo_search.embed_model IS NULL;
COMMENT ON COLUMN public.photo_search.taken_at IS NULL;
ALTER TABLE public.photo_search
  DROP COLUMN IF EXISTS doc_version,
  DROP COLUMN IF EXISTS content_hash,
  DROP COLUMN IF EXISTS embedded_at,
  DROP COLUMN IF EXISTS place;
