-- Up Migration

-- Step 3 (docs/plans/step-3.md 2.5): session liveness over GoTrue's auth.sessions, co-admin
-- removal requests, and "the plan follows the paying admin".
--
-- Security notes:
-- * The four session functions below are the ONLY access path from any app role into auth.*.
--   No GRANT on any auth table or schema is given to authenticated / viewer / pipeline /
--   service_role / tinyglow_api / tinyglow_worker, now or later. GoTrue enables RLS on
--   auth.sessions with no policies, so even a stray table grant would return nothing.
-- * Every function is SECURITY DEFINER, owned by the superuser that runs migrations (postgres),
--   pins search_path to pg_catalog, public (auth.* is schema-qualified; the search path never
--   includes auth), filters by auth_uid() so a user only ever sees or deletes their own
--   sessions, is REVOKEd from PUBLIC and granted to authenticated only.
-- * baby_members.removal_requested_by / removal_requested_at are written by service_role only:
--   authenticated keeps its column-level UPDATE (role) grant, so a member cannot forge or clear
--   a removal request (and a self-updatable row would let a contributor rewrite role). RLS stays
--   ENABLE + FORCE on baby_members.

DO $guard$
BEGIN
  IF to_regclass('auth.sessions') IS NULL THEN
    RAISE EXCEPTION 'auth.sessions is missing: start the auth (GoTrue) service before running migrations';
  END IF;
END
$guard$;

-------------------------------------------------------------------------------------------------
-- Session liveness and devices (PRD "Sessions and tokens"; step-3 D2). Coupled to the
-- auth.sessions columns of supabase/auth v2.197.0: id uuid, user_id uuid, created_at timestamptz,
-- updated_at timestamptz, refreshed_at timestamp WITHOUT time zone (GoTrue writes UTC wall-clock
-- time; converted here so callers only ever see timestamptz), not_after timestamptz (session
-- timebox; NULL unless GOTRUE_SESSIONS_TIMEBOX is set), user_agent text, ip inet (never exposed).
-- A session is "live" for the API when its row exists and its timebox has not passed; GoTrue
-- deletes rows on sign-out, refresh-token reuse and user deletion, so a deleted row revokes the
-- session within one request regardless of the JWT's remaining lifetime.
-------------------------------------------------------------------------------------------------

-- The current user's session row, or no row. The API calls this at the start of every
-- authenticated transaction with the JWT's session_id: no row => 401 session_revoked.
-- created_at drives "fresh sign-in" (<= 10 min); refreshed_at is NULL until the first refresh.
CREATE OR REPLACE FUNCTION public.auth_session_info(p_session_id uuid)
  RETURNS TABLE (created_at timestamptz, refreshed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.created_at,
         (s.refreshed_at AT TIME ZONE 'UTC')::timestamptz
  FROM auth.sessions s
  WHERE s.id = p_session_id
    AND s.user_id = public.auth_uid()
    AND (s.not_after IS NULL OR s.not_after > now())
$$;
COMMENT ON FUNCTION public.auth_session_info(uuid) IS
  'auth.sessions row of the signed-in user (auth_uid()) for one session id; empty when the session is gone, belongs to someone else, or its timebox passed.';

-- Devices list for the settings screen: the current user's live sessions, newest first.
-- Deliberately omits ip (PRD: no IPs shown to users; the API reduces user_agent to a label).
CREATE OR REPLACE FUNCTION public.list_user_sessions()
  RETURNS TABLE (id uuid, created_at timestamptz, updated_at timestamptz, refreshed_at timestamptz, user_agent text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.id,
         s.created_at,
         s.updated_at,
         (s.refreshed_at AT TIME ZONE 'UTC')::timestamptz,
         s.user_agent
  FROM auth.sessions s
  WHERE s.user_id = public.auth_uid()
    AND (s.not_after IS NULL OR s.not_after > now())
  ORDER BY s.created_at DESC, s.id
$$;
COMMENT ON FUNCTION public.list_user_sessions() IS
  'Live auth.sessions of the signed-in user (auth_uid()), no ip. Empty without authenticated claims.';

-- Per-device sign-out: deletes one of the current user's sessions (GoTrue cascades
-- auth.refresh_tokens and auth.mfa_amr_claims). True when a row was deleted; false when the
-- session does not exist or belongs to another user (indistinguishable on purpose).
CREATE OR REPLACE FUNCTION public.delete_user_session(p_session_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM auth.sessions s
   WHERE s.id = p_session_id
     AND s.user_id = public.auth_uid();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted > 0;
END
$$;
COMMENT ON FUNCTION public.delete_user_session(uuid) IS
  'Delete one auth.sessions row of the signed-in user (auth_uid()). Never touches other users'' sessions.';

-- New-device detection: number of live sessions of the current user (the API treats a sign-in
-- as a "new device" when another session already existed).
CREATE OR REPLACE FUNCTION public.count_user_sessions() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM auth.sessions s
  WHERE s.user_id = public.auth_uid()
    AND (s.not_after IS NULL OR s.not_after > now())
$$;
COMMENT ON FUNCTION public.count_user_sessions() IS
  'Number of live auth.sessions of the signed-in user (auth_uid()); 0 without authenticated claims.';

REVOKE EXECUTE ON FUNCTION public.auth_session_info(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_user_sessions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_user_session(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.count_user_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_session_info(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_user_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_user_sessions() TO authenticated;

-------------------------------------------------------------------------------------------------
-- Co-admin removal requests (FR-1.5, step-3 D4): an admin asks to remove the other admin; the
-- target confirms (or declines) within 7 days. Both columns are service_role-written: no grant
-- change for authenticated (SELECT on the whole table already lets members see a pending
-- request; UPDATE stays limited to role). removal_requested_at is the source of truth for
-- liveness (the API ignores requests older than 7 days); removal_requested_by becomes NULL if
-- the requesting admin's account is deleted while the request is open.
-------------------------------------------------------------------------------------------------
ALTER TABLE public.baby_members
  ADD COLUMN IF NOT EXISTS removal_requested_by uuid REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS removal_requested_at timestamptz;
COMMENT ON COLUMN public.baby_members.removal_requested_by IS
  'Admin who asked to remove this member (FR-1.5). service_role-written; the target confirms within 7 days.';
COMMENT ON COLUMN public.baby_members.removal_requested_at IS
  'When the removal was requested; NULL = no open request. Requests older than 7 days are ignored.';

-------------------------------------------------------------------------------------------------
-- The plan follows the paying admin (step-3 D5, settles the step-2 open issue). Two triggers so
-- every path agrees: the API removing/leaving (DELETE baby_members), GoTrue hard-deleting the
-- user (profiles cascade -> baby_members cascade, and babies.plan_owner_user_id ON DELETE SET
-- NULL), or billing clearing the owner directly. Consequence: baby_ai_enabled() turns false
-- (FR-5.8 gate), photos_status_guard and the photo_ai tripwire keep the photos away from any
-- model; photos already above the 1,000 free cap stay but no new ones can be added until a
-- remaining admin upgrades.
-------------------------------------------------------------------------------------------------
-- When the owner is cleared (by anyone, including the FK SET NULL action, which fires row
-- triggers), a plus plan reverts to free. A plus plan that never had an owner (seed, manual
-- grant) is left alone: only a non-NULL -> NULL transition triggers the revert.
CREATE OR REPLACE FUNCTION public.babies_plan_follows_owner() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.plan_owner_user_id IS NULL AND OLD.plan_owner_user_id IS NOT NULL AND NEW.plan = 'plus' THEN
    NEW.plan := 'free';
    NEW.entitlement_expires_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.babies_plan_follows_owner() FROM PUBLIC;
DROP TRIGGER IF EXISTS babies_plan_follows_owner ON public.babies;
CREATE TRIGGER babies_plan_follows_owner BEFORE UPDATE OF plan_owner_user_id ON public.babies
  FOR EACH ROW EXECUTE FUNCTION public.babies_plan_follows_owner();

-- Leaving, being removed, or stepping down from admin to contributor releases the plan: only
-- an admin can own the baby's plan (PRD "Roles and permissions": manage plan = admin). SECURITY
-- DEFINER: the member row is deleted/updated under authenticated (leave, self-demotion), which
-- has no UPDATE grant on babies.plan_owner_user_id. When the delete is a cascade from a
-- hard-deleted baby the UPDATE matches nothing. A role change that is not admin -> contributor
-- (promotion, or a no-op write) leaves the owner alone.
CREATE OR REPLACE FUNCTION public.baby_members_release_plan() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.role = 'admin' AND NEW.role <> 'admin') THEN
    RETURN NULL;
  END IF;
  UPDATE public.babies b
     SET plan_owner_user_id = NULL
   WHERE b.id = OLD.baby_id
     AND b.plan_owner_user_id = OLD.user_id;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.baby_members_release_plan() FROM PUBLIC;
DROP TRIGGER IF EXISTS baby_members_release_plan ON public.baby_members;
CREATE TRIGGER baby_members_release_plan AFTER DELETE OR UPDATE OF role ON public.baby_members
  FOR EACH ROW EXECUTE FUNCTION public.baby_members_release_plan();

-- Down Migration

DROP TRIGGER IF EXISTS baby_members_release_plan ON public.baby_members;
DROP FUNCTION IF EXISTS public.baby_members_release_plan();
DROP TRIGGER IF EXISTS babies_plan_follows_owner ON public.babies;
DROP FUNCTION IF EXISTS public.babies_plan_follows_owner();

ALTER TABLE public.baby_members
  DROP COLUMN IF EXISTS removal_requested_at,
  DROP COLUMN IF EXISTS removal_requested_by;

DROP FUNCTION IF EXISTS public.count_user_sessions();
DROP FUNCTION IF EXISTS public.delete_user_session(uuid);
DROP FUNCTION IF EXISTS public.list_user_sessions();
DROP FUNCTION IF EXISTS public.auth_session_info(uuid);
