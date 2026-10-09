-- Up Migration

-- photo_ai tripwire: let a row be detached from its batch (docs/plans/step-9.md; step-9 debugger
-- report on e2e/ai/details.spec.ts cleanup).
--
-- `photo_ai.batch_id` references `ai_batches` ON DELETE SET NULL. That FK action is an UPDATE of
-- `photo_ai`, and `photo_ai_paid_tier_tripwire` (migration 4) refuses every INSERT/UPDATE for a
-- photo whose baby is not `baby_ai_enabled` (free, lapsed or trashed). Batches mix babies, so
-- once any one baby in a batch is downgraded or trashed, that batch row can never be deleted.
--
-- The tripwire's purpose (FR-5.8) is that a free-tier / AI-disabled baby never *gains* AI content.
-- Clearing `batch_id` adds nothing: it drops a cost-ledger link. So exactly one UPDATE shape is
-- exempt: the new `batch_id` is NULL and every other column except `updated_at` is unchanged
-- (compared as whole-row jsonb, so a column added later is covered automatically). Anything else
-- (description, sensitive_flags, model/versions, confidence, tokens, photo_id, re-pointing to
-- another batch, any INSERT) is still refused with the same fixed message and SQLSTATE 23514.
-- The message never echoes row content.

CREATE OR REPLACE FUNCTION public.photo_ai_paid_tier_tripwire() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_baby_id uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.batch_id IS NULL
     AND (to_jsonb(NEW) - 'batch_id' - 'updated_at') = (to_jsonb(OLD) - 'batch_id' - 'updated_at')
  THEN
    RETURN NEW;
  END IF;
  SELECT p.baby_id INTO v_baby_id FROM public.photos p WHERE p.id = NEW.photo_id;
  IF v_baby_id IS NULL OR NOT public.baby_ai_enabled(v_baby_id) THEN
    RAISE EXCEPTION 'AI results can only be stored for photos of a paid-tier baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_ai_paid_tier_tripwire() FROM PUBLIC;
COMMENT ON FUNCTION public.photo_ai_paid_tier_tripwire() IS
  'FR-5.8 defence in depth: no photo_ai INSERT/UPDATE unless the photo''s baby is baby_ai_enabled. Sole exemption: an UPDATE that only sets batch_id to NULL (ai_batches ON DELETE SET NULL), which adds no AI content.';

-- Down Migration

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
COMMENT ON FUNCTION public.photo_ai_paid_tier_tripwire() IS NULL;
