-- Up Migration

-- Review hardening (docs/plans/review-fixes.md 2.1 A; decisions D11, D12, D13). Moves three rules
-- that the API already applied into the database so a bug or a bypass in the API cannot break
-- them:
--
-- 1. FR-1.5 "Removing an admin requires the other admin's confirmation" (D11). An
--    `authenticated` actor may delete or demote an *admin* row only when it is their own (leave,
--    step down, or confirm a removal request addressed to them). Removing or promoting a
--    contributor is unchanged. The removal *request* is still written under `service_role`; the
--    `baby_members_keep_last_admin` / `baby_members_max_two_admins` triggers stay. A denied
--    UPDATE/DELETE affects 0 rows (USING), it does not raise.
-- 2. Co-member profile exposure (D12). `profiles` becomes self-only for `authenticated` (a
--    self-read keeps every granted column: consent versions, timezone, units, notify_*). The new
--    `member_profiles` view exposes exactly `user_id, display_name, relationship_label` of the
--    caller and of users who share a baby with the caller, never of a deleted profile. The view
--    is owned by the migration role (superuser), so it reads `profiles` past RLS and applies its
--    own WHERE, which is the policy; `security_barrier` keeps a caller's predicates from being
--    evaluated before that WHERE. `pipeline` keeps its 3-column grant on `profiles`.
-- 3. Photos approval columns (D13). `WITH CHECK` cannot see the old row, so a BEFORE trigger does
--    the column-level part for `authenticated` writes only (pipeline / service_role / the
--    superuser and SECURITY DEFINER functions such as `photo_ai_sync_sensitive` run as another
--    current_user and are untouched):
--    * a non-admin (contributor) may not change `is_sensitive`, `approval`, `approved_by` or
--      `approved_at` (their only legitimate UPDATE is trashing their own pending upload);
--    * an admin moving a photo to `approved` gets `approved_by := auth_uid()` and
--      `approved_at := now()` whatever the statement supplied (pinned, not validated);
--    * any other admin UPDATE must leave `approved_by` / `approved_at` as they were;
--    * on INSERT an `approved` row with no `approved_by` is filled with the actor (an admin's own
--      upload is approved by that admin; the step-4 upload insert sets only `approval`), and
--      `photos_authenticated_insert` then requires `approved_by = auth_uid()` for `approved` rows
--      and `approved_by IS NULL` otherwise, so a foreign approver can never be written.
--
-- Every RAISE uses a fixed message; no row content is echoed. The contributor case raises 42501
-- (insufficient_privilege), the same SQLSTATE the step-2 policy produced for a contributor's
-- self-approval, so the API keeps mapping it to 403; the admin approver case raises 23514
-- (check_violation; no API path writes that shape). Reversible: the down migration restores the
-- step-2/4 policies verbatim and drops the view and the trigger.

-------------------------------------------------------------------------------------------------
-- 1. baby_members: FR-1.5 at the database.
-------------------------------------------------------------------------------------------------
-- USING sees the existing row: an admin may update any contributor row (promote) and their own
-- row (step down); the other admin's row is invisible to the UPDATE. WITH CHECK is unchanged.
DROP POLICY IF EXISTS baby_members_authenticated_update ON public.baby_members;
CREATE POLICY baby_members_authenticated_update ON public.baby_members FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id) AND (role <> 'admin' OR user_id = public.auth_uid()))
  WITH CHECK (public.is_baby_admin(baby_id));

-- Anyone may delete their own row (leave; the FR-1.5 confirm is the target deleting their own
-- row); an admin may delete contributor rows; nobody may delete another admin's row directly.
DROP POLICY IF EXISTS baby_members_authenticated_delete ON public.baby_members;
CREATE POLICY baby_members_authenticated_delete ON public.baby_members FOR DELETE TO authenticated
  USING (user_id = public.auth_uid() OR (public.is_baby_admin(baby_id) AND role <> 'admin'));

-------------------------------------------------------------------------------------------------
-- 2. profiles: self-only; co-members through member_profiles.
-------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_authenticated_select ON public.profiles;
CREATE POLICY profiles_authenticated_select ON public.profiles FOR SELECT TO authenticated
  USING (user_id = public.auth_uid());

CREATE OR REPLACE VIEW public.member_profiles WITH (security_barrier = true) AS
  SELECT p.user_id, p.display_name, p.relationship_label
  FROM public.profiles p
  WHERE p.deleted_at IS NULL
    AND (p.user_id = public.auth_uid() OR public.shares_baby_with(p.user_id));
COMMENT ON VIEW public.member_profiles IS
  'Display name and relationship label of the caller and of users who share a baby with the caller (live profiles only). The only way an authenticated user reads another user''s profile; profiles itself is self-only. Owned by the migration role so it reads profiles past RLS; its WHERE is the policy.';
REVOKE ALL ON public.member_profiles FROM PUBLIC;
GRANT SELECT ON public.member_profiles TO authenticated;

-------------------------------------------------------------------------------------------------
-- 3. photos: approval columns guard (contributors) and approver pin (admins).
-------------------------------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user must be the caller's role. Firing a trigger does not
-- check EXECUTE, so REVOKE FROM PUBLIC does not stop it.
CREATE OR REPLACE FUNCTION public.photos_user_write_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The INSERT policy decides who may insert what; this only fills the approver of an admin's
    -- own approved upload so the policy's `approved_by = auth_uid()` holds.
    IF NEW.approval = 'approved' AND NEW.approved_by IS NULL THEN
      NEW.approved_by := public.auth_uid();
      NEW.approved_at := COALESCE(NEW.approved_at, now());
    END IF;
    RETURN NEW;
  END IF;

  IF NOT public.is_baby_admin(NEW.baby_id) THEN
    IF NEW.is_sensitive IS DISTINCT FROM OLD.is_sensitive
       OR NEW.approval IS DISTINCT FROM OLD.approval
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'contributors may only trash their own pending uploads'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.approval = 'approved' AND OLD.approval IS DISTINCT FROM 'approved' THEN
    NEW.approved_by := public.auth_uid();
    NEW.approved_at := now();
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'approved_by and approved_at are set by the database when a photo is approved'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photos_user_write_guard() FROM PUBLIC;
COMMENT ON FUNCTION public.photos_user_write_guard() IS
  'D13: for current_user = authenticated only. Contributors cannot change is_sensitive/approval/approved_by/approved_at; an admin approval pins approved_by to auth_uid() and approved_at to now(); other admin updates keep approved_by/approved_at; an approved INSERT without approver gets auth_uid().';

DROP TRIGGER IF EXISTS photos_user_update_guard ON public.photos;
CREATE TRIGGER photos_user_update_guard BEFORE INSERT OR UPDATE ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_user_write_guard();

-- Same body as step 2 plus the approver pin. A contributor still inserts only `pending` rows.
DROP POLICY IF EXISTS photos_authenticated_insert ON public.photos;
CREATE POLICY photos_authenticated_insert ON public.photos FOR INSERT TO authenticated
  WITH CHECK (
    public.is_baby_member(baby_id)
    AND uploaded_by = public.auth_uid()
    AND (public.is_baby_admin(baby_id) OR approval = 'pending')
    AND CASE WHEN approval = 'approved' THEN approved_by IS NOT DISTINCT FROM public.auth_uid()
             ELSE approved_by IS NULL END
  );

-- Down Migration

DROP POLICY IF EXISTS photos_authenticated_insert ON public.photos;
CREATE POLICY photos_authenticated_insert ON public.photos FOR INSERT TO authenticated
  WITH CHECK (
    public.is_baby_member(baby_id)
    AND uploaded_by = public.auth_uid()
    AND (public.is_baby_admin(baby_id) OR approval = 'pending')
  );
DROP TRIGGER IF EXISTS photos_user_update_guard ON public.photos;
DROP FUNCTION IF EXISTS public.photos_user_write_guard();

DROP VIEW IF EXISTS public.member_profiles;
DROP POLICY IF EXISTS profiles_authenticated_select ON public.profiles;
CREATE POLICY profiles_authenticated_select ON public.profiles FOR SELECT TO authenticated
  USING (user_id = public.auth_uid() OR public.shares_baby_with(user_id));

DROP POLICY IF EXISTS baby_members_authenticated_delete ON public.baby_members;
CREATE POLICY baby_members_authenticated_delete ON public.baby_members FOR DELETE TO authenticated
  USING (public.is_baby_admin(baby_id) OR user_id = public.auth_uid());
DROP POLICY IF EXISTS baby_members_authenticated_update ON public.baby_members;
CREATE POLICY baby_members_authenticated_update ON public.baby_members FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id)) WITH CHECK (public.is_baby_admin(baby_id));
