-- Up Migration

-- AI batch pipeline (docs/plans/step-6.md 2.3; PRD FR-5.2/5.3/5.6/5.7/5.8, "LLM selection and
-- cost" -> "Cost controls"). Everything a photo needs to be described by a model, and nothing a
-- free-tier photo could ever use:
--
-- * `ai_batch_items` (new): one row per photo per attempt; the per-photo cost ledger, the
--   attempt counter behind FR-5.3 ("retried once, then marked") and the idempotency key for
--   result streaming (`custom_id = photo_id`). ENABLE + FORCE RLS. `pipeline` and `service_role`
--   write it; members read a few columns of items for photos they can see; `viewer` nothing.
--   The `ai_batch_items_guard` trigger refuses to insert an item for anything but an approved,
--   live photo of a paid-tier baby, so "free-tier photos are never submitted" is a database rule
--   in three places (`photos_status_guard`, this guard, `photo_ai_paid_tier_tripwire`), not a
--   worker promise.
-- * `ai_batches`: provider file ids (deleted after results are retrieved), prompt/schema
--   versions, extra token counters, provider request counts, expiry, polling bookkeeping.
-- * `photos.ai_retry_requested_at`: the admin "Retry" after the attempts are used up (plan D4:
--   AI failures never set `photos.status = 'failed'`, which step 4 reserves for ingest failures).
-- * `ai_eligible_photos(...)`: the single definition of "eligible for a batch" shared by the
--   worker's flush, the upgrade/version backfill and the tests.
-- * `ai_baby_month_cost_usd(...)`: the per-baby UTC-month spend behind the monthly budget.
-- * `record_ai_budget_exceeded(...)`: the once-per-baby-per-month `ai.budget_exceeded` audit row,
--   deduplicated in the database (the pipeline has no SELECT on audit_log and must not get one).
-- * `photo_ai_overrides_shape` now also pins `field_path` to the three overridable fields and
--   `value` to the right JSON shape (fixed messages, nothing echoed; the row holds parent text).
--
-- Nothing here stores, raises or logs prompt text, notes, captions, provider messages or bytes:
-- `failure_kind` and `ai_batches.error` are closed sets / categories only.

-------------------------------------------------------------------------------------------------
-- photos.ai_retry_requested_at
-------------------------------------------------------------------------------------------------
ALTER TABLE public.photos ADD COLUMN IF NOT EXISTS ai_retry_requested_at timestamptz;
COMMENT ON COLUMN public.photos.ai_retry_requested_at IS
  'Admin "Retry" after the AI attempts were used up: failed ai_batch_items created before this timestamp no longer count (ai_eligible_photos). Never clears status; an AI failure leaves status = ingested (never failed).';
-- Admins (and, harmlessly, the uploader of a pending photo, which is never eligible) may set it;
-- the step-2/4 photos_authenticated_update policy decides who. The pipeline never touches it.
GRANT UPDATE (ai_retry_requested_at) ON public.photos TO authenticated;

-------------------------------------------------------------------------------------------------
-- ai_batches: provider artefacts, versions, counters.
-------------------------------------------------------------------------------------------------
ALTER TABLE public.ai_batches
  ADD COLUMN IF NOT EXISTS provider_input_file_id  text,
  ADD COLUMN IF NOT EXISTS provider_output_file_id text,
  ADD COLUMN IF NOT EXISTS provider_error_file_id  text,
  ADD COLUMN IF NOT EXISTS files_deleted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS prompt_version          text,
  ADD COLUMN IF NOT EXISTS schema_version          text,
  ADD COLUMN IF NOT EXISTS reasoning_tokens        bigint,
  ADD COLUMN IF NOT EXISTS image_tokens            bigint,
  ADD COLUMN IF NOT EXISTS request_counts          jsonb,
  ADD COLUMN IF NOT EXISTS last_polled_at          timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at              timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_bytes         bigint;
COMMENT ON COLUMN public.ai_batches.files_deleted_at IS
  'When the provider input/output/error files (OpenAI) or the batch (Anthropic) were deleted after results were stored (PRD: provider files are deleted after retrieval). NULL on a terminal batch = retry the deletion.';
COMMENT ON COLUMN public.ai_batches.request_counts IS
  'Provider request counts only ({total, completed, failed} or Anthropic''s {processing, succeeded, errored, canceled, expired}); never results, errors or messages.';
COMMENT ON COLUMN public.ai_batches.error IS
  'Error category (e.g. provider_error, rate_limited, validation) only; never a provider message, prompt, note or image.';
CREATE INDEX IF NOT EXISTS ai_batches_open_idx ON public.ai_batches (status)
  WHERE status IN ('building', 'submitted', 'in_progress');

-------------------------------------------------------------------------------------------------
-- ai_batch_items: one row per photo per attempt (plan D3).
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_batch_items (
  batch_id             uuid           NOT NULL REFERENCES public.ai_batches (id) ON DELETE CASCADE,
  photo_id             uuid           NOT NULL REFERENCES public.photos (id) ON DELETE CASCADE,
  -- Denormalised from photos for the monthly budget sum and for RLS; ai_batch_items_guard pins it.
  baby_id              uuid           NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  attempt              smallint       NOT NULL CHECK (attempt BETWEEN 1 AND 9),
  prompt_version       text           NOT NULL,
  schema_version       text           NOT NULL,
  state                text           NOT NULL DEFAULT 'pending'
                                      CHECK (state IN ('pending', 'submitted', 'succeeded', 'failed', 'dropped')),
  failure_kind         text           CHECK (failure_kind IN ('refusal', 'invalid_output', 'expired', 'rate_limited', 'provider_error', 'budget')),
  input_tokens         integer        CHECK (input_tokens >= 0),
  cached_input_tokens  integer        CHECK (cached_input_tokens >= 0),
  output_tokens        integer        CHECK (output_tokens >= 0),
  reasoning_tokens     integer        CHECK (reasoning_tokens >= 0),
  image_tokens         integer        CHECK (image_tokens >= 0),
  cost_usd             numeric(12,8)  CHECK (cost_usd >= 0),
  created_at           timestamptz    NOT NULL DEFAULT now(),
  updated_at           timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, photo_id),
  -- A failed item always says why (a category); nothing else carries a failure kind except a
  -- dropped item (re-check before submit, budget).
  CONSTRAINT ai_batch_items_failure_kind_state_check
    CHECK ((state = 'failed' AND failure_kind IS NOT NULL) OR (state = 'dropped') OR (state <> 'failed' AND failure_kind IS NULL))
);
COMMENT ON TABLE public.ai_batch_items IS
  'One row per photo per batch attempt: the per-photo cost ledger and attempt counter (FR-5.3). failure_kind and no other column may ever hold prompt text, notes or a provider message longer than an error code. No column of this table holds parent-entered text, so plain CHECKs are safe here.';
CREATE INDEX IF NOT EXISTS ai_batch_items_photo_id_created_at_idx ON public.ai_batch_items (photo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_batch_items_baby_id_created_at_idx ON public.ai_batch_items (baby_id, created_at);
CREATE INDEX IF NOT EXISTS ai_batch_items_open_idx ON public.ai_batch_items (state)
  WHERE state IN ('pending', 'submitted');
ALTER TABLE public.ai_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_batch_items FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS ai_batch_items_set_updated_at ON public.ai_batch_items;
CREATE TRIGGER ai_batch_items_set_updated_at BEFORE UPDATE ON public.ai_batch_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- An item may only ever be created for an approved, live (not trashed, not quarantined) photo
-- of a paid-tier baby, and baby_id must be the photo's own. Checked on INSERT (and when the
-- keys change); a later downgrade leaves the historical ledger alone. SECURITY DEFINER so the
-- check does not depend on the writer's grants on photos.
CREATE OR REPLACE FUNCTION public.ai_batch_items_guard() RETURNS trigger
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
      AND public.baby_ai_enabled(p.baby_id)
  ) THEN
    RAISE EXCEPTION 'ai batch item must reference an approved, live photo of a paid-tier baby'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.ai_batch_items_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS ai_batch_items_guard ON public.ai_batch_items;
CREATE TRIGGER ai_batch_items_guard BEFORE INSERT OR UPDATE OF photo_id, baby_id ON public.ai_batch_items
  FOR EACH ROW EXECUTE FUNCTION public.ai_batch_items_guard();

-- Grants. pipeline / service_role: everything. authenticated: a read-only view of the state and
-- cost of items for photos they can see (contributors see their own approved photos' state too;
-- cost per photo is not secret). Never INSERT/UPDATE/DELETE for any user role; viewer: nothing.
GRANT ALL ON public.ai_batch_items TO service_role;
GRANT ALL ON public.ai_batch_items TO pipeline;
GRANT SELECT (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, state, failure_kind,
              cost_usd, created_at, updated_at) ON public.ai_batch_items TO authenticated;

DROP POLICY IF EXISTS ai_batch_items_pipeline_all ON public.ai_batch_items;
CREATE POLICY ai_batch_items_pipeline_all ON public.ai_batch_items FOR ALL TO pipeline
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ai_batch_items_authenticated_select ON public.ai_batch_items;
CREATE POLICY ai_batch_items_authenticated_select ON public.ai_batch_items FOR SELECT TO authenticated
  USING (public.photo_visible(photo_id));

-------------------------------------------------------------------------------------------------
-- ai_eligible_photos: THE definition of "may be claimed into a batch" (plan 2.3.6 / 2.6).
--
--   status = ingested (reprocess: or ready), approved, not trashed, not quarantined,
--   baby_ai_enabled (plus plan, entitlement live, baby not deleted) -> free-tier babies, the
--   perf baby and expired entitlements never appear,
--   an `analysis` derivative exists (the only copy that may reach a model),
--   regular mode: no photo_ai row; reprocess mode: a photo_ai row for other versions,
--   no item in flight (pending/submitted),
--   fewer than p_max_attempts failed items for these versions since ai_retry_requested_at.
--
-- Oldest first (photos.created_at). SECURITY INVOKER: it runs with the caller's grants and RLS
-- (pipeline sees every photo; it needs no GPS column and selects none). The DB triggers
-- (photos_status_guard, ai_batch_items_guard, photo_ai_paid_tier_tripwire) re-check the paid
-- gate on every write regardless of what this function returns.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_eligible_photos(
  p_limit integer,
  p_prompt_version text,
  p_schema_version text,
  p_baby_id uuid DEFAULT NULL,
  p_reprocess boolean DEFAULT false,
  p_max_attempts integer DEFAULT 2
) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT p.id
  FROM public.photos p
  WHERE p.approval = 'approved'
    AND p.deleted_at IS NULL
    AND p.quarantined_at IS NULL
    AND (p.status = 'ingested' OR (p_reprocess AND p.status = 'ready'))
    AND p.baby_id IN (
      SELECT b.id FROM public.babies b
      WHERE (p_baby_id IS NULL OR b.id = p_baby_id) AND public.baby_ai_enabled(b.id)
    )
    AND EXISTS (SELECT 1 FROM public.photo_derivatives d WHERE d.photo_id = p.id AND d.kind = 'analysis')
    AND CASE WHEN p_reprocess
          THEN EXISTS (SELECT 1 FROM public.photo_ai a
                       WHERE a.photo_id = p.id
                         AND (a.prompt_version, a.schema_version) IS DISTINCT FROM (p_prompt_version, p_schema_version))
          ELSE NOT EXISTS (SELECT 1 FROM public.photo_ai a WHERE a.photo_id = p.id)
        END
    AND NOT EXISTS (SELECT 1 FROM public.ai_batch_items i
                    WHERE i.photo_id = p.id AND i.state IN ('pending', 'submitted'))
    AND (SELECT count(*) FROM public.ai_batch_items i
         WHERE i.photo_id = p.id AND i.state = 'failed'
           AND i.prompt_version = p_prompt_version AND i.schema_version = p_schema_version
           AND i.created_at > COALESCE(p.ai_retry_requested_at, '-infinity'::timestamptz)) < p_max_attempts
  ORDER BY p.created_at, p.id
  LIMIT p_limit
$$;
COMMENT ON FUNCTION public.ai_eligible_photos(integer, text, text, uuid, boolean, integer) IS
  'Photo ids eligible for an AI batch, oldest first (docs/plans/step-6.md 2.6). p_limit NULL = no limit; p_reprocess = version backfill (photo_ai exists for other versions); p_max_attempts mirrors AI_MAX_ATTEMPTS (default 2). Never returns a photo of a free-tier baby.';
REVOKE EXECUTE ON FUNCTION public.ai_eligible_photos(integer, text, text, uuid, boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_eligible_photos(integer, text, text, uuid, boolean, integer) TO pipeline, service_role;

-------------------------------------------------------------------------------------------------
-- ai_baby_month_cost_usd: spend of one baby in one UTC calendar month (budget, usage endpoint).
-- SECURITY INVOKER: for authenticated callers RLS on ai_batch_items applies (members of the
-- baby only; a stranger gets 0).
-------------------------------------------------------------------------------------------------
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
REVOKE EXECUTE ON FUNCTION public.ai_baby_month_cost_usd(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_baby_month_cost_usd(uuid, date) TO authenticated, pipeline, service_role;

-------------------------------------------------------------------------------------------------
-- record_ai_budget_exceeded: write the `ai.budget_exceeded` audit row for one baby and one UTC
-- month at most once, across worker restarts and concurrent workers. The pipeline has INSERT but
-- no SELECT on audit_log (the log holds admin/auth activity of every family, so it keeps none),
-- which is why the existence check lives here as SECURITY DEFINER instead of in the worker. The
-- row is exactly the one the worker wrote before: event 'ai.budget_exceeded', no actor,
-- metadata {"month": "YYYY-MM"} and nothing else. Returns true when it inserted, false when the
-- row already existed. A transaction-scoped, namespaced advisory lock on (baby, month) serialises
-- concurrent callers so two cannot both insert. Append-only semantics are untouched: this only
-- ever INSERTs, and only this one closed event.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_ai_budget_exceeded(p_baby_id uuid, p_month text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_baby_id IS NULL OR p_month IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'record_ai_budget_exceeded expects a baby id and a UTC month formatted YYYY-MM'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ai.budget_exceeded'), hashtext(p_baby_id::text || ':' || p_month));
  IF EXISTS (
    SELECT 1 FROM public.audit_log a
    WHERE a.event = 'ai.budget_exceeded'
      AND a.baby_id = p_baby_id
      AND a.metadata->>'month' = p_month
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit_log (baby_id, event, metadata)
  VALUES (p_baby_id, 'ai.budget_exceeded', jsonb_build_object('month', p_month));
  RETURN true;
END
$$;
COMMENT ON FUNCTION public.record_ai_budget_exceeded(uuid, text) IS
  'Insert the ai.budget_exceeded audit row for (baby, UTC month YYYY-MM) unless one exists; true = inserted, false = already recorded. Advisory-locked per (baby, month). Pipeline/service_role only; the pipeline never gains SELECT on audit_log.';
REVOKE EXECUTE ON FUNCTION public.record_ai_budget_exceeded(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_ai_budget_exceeded(uuid, text) TO pipeline, service_role;

-------------------------------------------------------------------------------------------------
-- photo_ai_overrides_shape: field_path in the overridable set and value of the right JSON shape
-- (plan 2.3.5 / 2.4 AI_FIELD_OVERRIDABLE). Fixed messages; the row holds parent text, so no
-- CHECK constraint (a failing CHECK echoes the row into the server log).
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.photo_ai_overrides_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_max integer;
BEGIN
  IF NEW.field_path NOT IN ('caption', 'detailed_description', 'search_tags') THEN
    RAISE EXCEPTION 'photo_ai_overrides.field_path is not an overridable field' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.field_path = 'search_tags' THEN
    IF jsonb_typeof(NEW.value) <> 'array'
       OR jsonb_array_length(NEW.value) < 1
       OR jsonb_array_length(NEW.value) > 20
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.value) e
                  WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') < 1 OR length(e #>> '{}') > 60) THEN
      RAISE EXCEPTION 'photo_ai_overrides.value must be an array of 1 to 20 strings of at most 60 characters for search_tags'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    v_max := CASE NEW.field_path WHEN 'caption' THEN 200 ELSE 1200 END;
    IF jsonb_typeof(NEW.value) <> 'string'
       OR length(NEW.value #>> '{}') < 1
       OR length(NEW.value #>> '{}') > v_max THEN
      RAISE EXCEPTION 'photo_ai_overrides.value must be a non-empty string within the length limit of this field'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_ai_overrides_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_ai_overrides_shape ON public.photo_ai_overrides;
CREATE TRIGGER photo_ai_overrides_shape BEFORE INSERT OR UPDATE OF field_path, value ON public.photo_ai_overrides
  FOR EACH ROW EXECUTE FUNCTION public.photo_ai_overrides_shape();

-- Down Migration

-- photo_ai_overrides_shape: the step-5 body and trigger, verbatim.
CREATE OR REPLACE FUNCTION public.photo_ai_overrides_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF length(NEW.field_path) < 1 OR length(NEW.field_path) > 200 THEN
    RAISE EXCEPTION 'photo_ai_overrides.field_path must be 1 to 200 characters' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_ai_overrides_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_ai_overrides_shape ON public.photo_ai_overrides;
CREATE TRIGGER photo_ai_overrides_shape BEFORE INSERT OR UPDATE OF field_path ON public.photo_ai_overrides
  FOR EACH ROW EXECUTE FUNCTION public.photo_ai_overrides_shape();

DROP FUNCTION IF EXISTS public.record_ai_budget_exceeded(uuid, text);
DROP FUNCTION IF EXISTS public.ai_baby_month_cost_usd(uuid, date);
DROP FUNCTION IF EXISTS public.ai_eligible_photos(integer, text, text, uuid, boolean, integer);

DROP TABLE IF EXISTS public.ai_batch_items;
DROP FUNCTION IF EXISTS public.ai_batch_items_guard();

DROP INDEX IF EXISTS public.ai_batches_open_idx;
ALTER TABLE public.ai_batches
  DROP COLUMN IF EXISTS provider_input_file_id,
  DROP COLUMN IF EXISTS provider_output_file_id,
  DROP COLUMN IF EXISTS provider_error_file_id,
  DROP COLUMN IF EXISTS files_deleted_at,
  DROP COLUMN IF EXISTS prompt_version,
  DROP COLUMN IF EXISTS schema_version,
  DROP COLUMN IF EXISTS reasoning_tokens,
  DROP COLUMN IF EXISTS image_tokens,
  DROP COLUMN IF EXISTS request_counts,
  DROP COLUMN IF EXISTS last_polled_at,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS submitted_bytes;
COMMENT ON COLUMN public.ai_batches.error IS NULL;

REVOKE UPDATE (ai_retry_requested_at) ON public.photos FROM authenticated;
ALTER TABLE public.photos DROP COLUMN IF EXISTS ai_retry_requested_at;
