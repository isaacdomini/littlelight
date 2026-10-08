-- Up Migration

-- AI results and search (docs/plans/step-2.md 2.4-2.6). Paid tier only: photo_ai rows cannot be
-- written for a free-tier baby (tripwire), photo_search is readable only by admins of a paid-tier
-- baby (FR-7.7 / FR-5.8). Sensitive flags from the model raise photos.is_sensitive (FR-9.5).

-------------------------------------------------------------------------------------------------
-- ai_batches: operational cost tracking, not baby-scoped; pipeline/service_role only.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_batches (
  id                   uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text           NOT NULL,
  model                text           NOT NULL,
  provider_batch_id    text,
  status               text           NOT NULL DEFAULT 'building'
                                      CHECK (status IN ('building', 'submitted', 'in_progress', 'completed', 'failed', 'expired', 'cancelled')),
  photo_count          integer        NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  submitted_at         timestamptz,
  completed_at         timestamptz,
  input_tokens         bigint,
  cached_input_tokens  bigint,
  output_tokens        bigint,
  cost_usd             numeric(12,6),
  error                text,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  updated_at           timestamptz    NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ai_batches IS
  'One provider Batch API job. error must never contain prompts, notes or image data.';
ALTER TABLE public.ai_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_batches FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS ai_batches_set_updated_at ON public.ai_batches;
CREATE TRIGGER ai_batches_set_updated_at BEFORE UPDATE ON public.ai_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------------------------
-- photo_ai: the structured description (schema validated in packages/ai before insert).
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.photo_ai (
  photo_id         uuid        PRIMARY KEY REFERENCES public.photos (id) ON DELETE CASCADE,
  model            text        NOT NULL,
  prompt_version   text        NOT NULL,
  schema_version   text        NOT NULL,
  description      jsonb       NOT NULL,
  sensitive_flags  text[]      NOT NULL DEFAULT '{}',
  confidence       real        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  batch_id         uuid        REFERENCES public.ai_batches (id) ON DELETE SET NULL,
  input_tokens     integer,
  output_tokens    integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_ai_batch_id_idx ON public.photo_ai (batch_id);
COMMENT ON TABLE public.photo_ai IS
  'Model output per photo (paid tier only; see photo_ai_paid_tier_tripwire). description.text_in_image is untrusted input.';
ALTER TABLE public.photo_ai ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_ai FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS photo_ai_set_updated_at ON public.photo_ai;
CREATE TRIGGER photo_ai_set_updated_at BEFORE UPDATE ON public.photo_ai
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Defence in depth for FR-5.8: no AI row for a free-tier (or deleted) baby, ever.
CREATE OR REPLACE FUNCTION public.photo_ai_paid_tier_tripwire() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_baby_id uuid;
BEGIN
  SELECT p.baby_id INTO v_baby_id FROM public.photos p WHERE p.id = NEW.photo_id;
  IF v_baby_id IS NULL OR NOT public.baby_ai_enabled(v_baby_id) THEN
    RAISE EXCEPTION 'AI results can only be stored for photos of a paid-tier baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_ai_paid_tier_tripwire() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_ai_paid_tier_tripwire ON public.photo_ai;
CREATE TRIGGER photo_ai_paid_tier_tripwire BEFORE INSERT OR UPDATE ON public.photo_ai
  FOR EACH ROW EXECUTE FUNCTION public.photo_ai_paid_tier_tripwire();

-- Any sensitive flag raises photos.is_sensitive (never lowers it; admins clear it manually).
CREATE OR REPLACE FUNCTION public.photo_ai_sync_sensitive() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF cardinality(NEW.sensitive_flags) > 0 THEN
    UPDATE public.photos SET is_sensitive = true WHERE id = NEW.photo_id AND NOT is_sensitive;
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_ai_sync_sensitive() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_ai_sync_sensitive ON public.photo_ai;
CREATE TRIGGER photo_ai_sync_sensitive AFTER INSERT OR UPDATE OF sensitive_flags ON public.photo_ai
  FOR EACH ROW EXECUTE FUNCTION public.photo_ai_sync_sensitive();

-------------------------------------------------------------------------------------------------
-- photo_search: denormalised search row (PRD "Search document"). Contains parent notes in
-- search_text, so it is readable only by admins of a paid-tier baby.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.photo_search (
  photo_id       uuid          PRIMARY KEY REFERENCES public.photos (id) ON DELETE CASCADE,
  baby_id        uuid          NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  search_text    text          NOT NULL,
  tsv            tsvector      GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED,
  embedding      vector(1024),
  embed_model    text,
  taken_at       timestamptz,
  age_days       integer,
  milestone_ids  uuid[]        NOT NULL DEFAULT '{}',
  people         text[]        NOT NULL DEFAULT '{}',
  tags           text[]        NOT NULL DEFAULT '{}',
  is_sensitive   boolean       NOT NULL DEFAULT false,
  updated_at     timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_search_embedding_idx ON public.photo_search
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS photo_search_tsv_idx ON public.photo_search USING gin (tsv);
CREATE INDEX IF NOT EXISTS photo_search_tags_idx ON public.photo_search USING gin (tags);
CREATE INDEX IF NOT EXISTS photo_search_baby_id_taken_at_idx ON public.photo_search (baby_id, taken_at);
CREATE INDEX IF NOT EXISTS photo_search_baby_id_age_days_idx ON public.photo_search (baby_id, age_days);
COMMENT ON COLUMN public.photo_search.milestone_ids IS
  'uuid[] (PRD says int[]; milestone ids are uuid in this schema).';
ALTER TABLE public.photo_search ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_search FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS photo_search_set_updated_at ON public.photo_search;
CREATE TRIGGER photo_search_set_updated_at BEFORE UPDATE ON public.photo_search
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------------------------
-- Grants and policies.
-------------------------------------------------------------------------------------------------
GRANT ALL ON public.ai_batches, public.photo_ai, public.photo_search TO service_role;
GRANT ALL ON public.ai_batches, public.photo_ai, public.photo_search TO pipeline;
GRANT SELECT ON public.photo_ai TO authenticated;
GRANT SELECT ON public.photo_search TO authenticated;

DROP POLICY IF EXISTS ai_batches_pipeline_all ON public.ai_batches;
CREATE POLICY ai_batches_pipeline_all ON public.ai_batches FOR ALL TO pipeline USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS photo_ai_authenticated_select ON public.photo_ai;
CREATE POLICY photo_ai_authenticated_select ON public.photo_ai FOR SELECT TO authenticated
  USING (public.photo_visible(photo_id));
DROP POLICY IF EXISTS photo_ai_pipeline_all ON public.photo_ai;
CREATE POLICY photo_ai_pipeline_all ON public.photo_ai FOR ALL TO pipeline USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS photo_search_authenticated_select ON public.photo_search;
CREATE POLICY photo_search_authenticated_select ON public.photo_search FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id) AND public.baby_ai_enabled(baby_id) AND public.photo_visible(photo_id));
DROP POLICY IF EXISTS photo_search_pipeline_all ON public.photo_search;
CREATE POLICY photo_search_pipeline_all ON public.photo_search FOR ALL TO pipeline USING (true) WITH CHECK (true);

-- Down Migration

DROP TABLE IF EXISTS public.photo_search;
DROP TABLE IF EXISTS public.photo_ai;
DROP TABLE IF EXISTS public.ai_batches;
DROP FUNCTION IF EXISTS public.photo_ai_sync_sensitive();
DROP FUNCTION IF EXISTS public.photo_ai_paid_tier_tripwire();
