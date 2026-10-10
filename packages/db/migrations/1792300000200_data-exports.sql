-- Up Migration

-- Data export (FR-10.1 "Export all originals + a JSON/CSV of metadata as a ZIP"; PRD "Roles and
-- permissions": export data is Admin only; docs/plans/review-fixes.md 2.1 B, D1-D5).
--
-- Rules enforced here, not in the API or the UI:
-- * `data_exports` is baby-scoped: ENABLE + FORCE RLS, `authenticated` policies on
--   `is_baby_admin` only (contributors see and request nothing; both admins see every export of
--   their album, D3). `viewer` has no grant at all.
-- * Only an admin can request, for themselves (`requested_by = auth_uid()`), for a live album
--   (`data_exports_baby_live`), at most one queued/running export per album and at most 3 per
--   album per rolling 24 h (`data_exports_rate_limit`, which locks the baby row so concurrent
--   requests serialise; the partial unique index is the backstop).
-- * `storage_key` (`babies/<baby>/exports/<id>.zip`, generated) is not granted to
--   `authenticated`: the API recomputes it with `exportKey()` and signs it only for the
--   requester. Consequence for API code: `INSERT ... RETURNING *` / `SELECT *` fail for
--   `authenticated`; always name columns.
-- * `authenticated` may only shorten `expires_at` (early expiry by either admin) and move the
--   download counter forward (`data_exports_user_update_guard`); nobody can extend an export
--   past its 7-day expiry from a user role.
-- * `pipeline` (the export worker and `purge.trash`) reads every row, updates progress / result /
--   purge columns only, and hard-deletes rows purged more than 30 days ago.
-- * `export_requester_is_admin()` is the run-time gate before the worker decrypts GPS and
--   `export_requester_email()` the only path to the requester's address (`auth.users.email`): an
--   address is returned only for a finished export whose requester is still an admin of the
--   album with a live profile. Both are SECURITY DEFINER, pinned search_path, EXECUTE to
--   `pipeline` only. The email is never logged by the caller.
-- * Every RAISE uses a fixed message (SQLSTATE 23514); no row content is echoed.
--
-- Grants audit for the export worker's read (2.1 B): `profiles(user_id, display_name,
-- relationship_label)`, `photos`, `photo_exif`, `photo_details`, `milestones`, `measurements`,
-- `photo_ai`, `photo_ai_overrides` and `audit_log` INSERT (actor NULL) already exist for
-- `pipeline`. Added here: `babies` profile columns for `album.json` (name, nickname,
-- birth_date_is_due_date, birth_weight_g, birth_length_mm, home_label) and `baby_members`
-- (baby_id, user_id, role, joined_at) for the members list; never `invited_by` or the removal
-- request columns.

DO $guard$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'auth.users is missing: start the auth (GoTrue) service before running migrations';
  END IF;
END
$guard$;

-------------------------------------------------------------------------------------------------
-- data_exports
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.data_exports (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id             uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  requested_by        uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  include_location    boolean     NOT NULL DEFAULT false,
  status              text        NOT NULL DEFAULT 'queued'
                                  CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  error               text        CHECK (error IN ('storage_error', 'too_large', 'requester_not_admin', 'internal')),
  storage_key         text        NOT NULL GENERATED ALWAYS AS
                                  ('babies/' || baby_id::text || '/exports/' || id::text || '.zip') STORED,
  photo_count         integer     CHECK (photo_count >= 0),
  photos_done         integer     NOT NULL DEFAULT 0 CHECK (photos_done >= 0),
  bytes               bigint      CHECK (bytes >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '7 days',
  purged_at           timestamptz,
  downloads           integer     NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  last_downloaded_at  timestamptz
);
CREATE INDEX IF NOT EXISTS data_exports_baby_id_created_at_idx
  ON public.data_exports (baby_id, created_at DESC);
CREATE INDEX IF NOT EXISTS data_exports_status_active_idx
  ON public.data_exports (status) WHERE status IN ('queued', 'running');
-- Backstop for "one in progress per album" (the trigger serialises on the baby row first, so a
-- caller normally sees its fixed check_violation message rather than this index).
CREATE UNIQUE INDEX IF NOT EXISTS data_exports_one_active_per_baby
  ON public.data_exports (baby_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS data_exports_requested_by_idx ON public.data_exports (requested_by);
CREATE INDEX IF NOT EXISTS data_exports_purge_idx ON public.data_exports (expires_at) WHERE purged_at IS NULL;

COMMENT ON TABLE public.data_exports IS
  'FR-10.1 album export requests (admins only). The ZIP lives at storage_key until expires_at (7 days) or until the requester leaves / is deleted; purge.trash removes the object and sets purged_at, then deletes the row 30 days later.';
COMMENT ON COLUMN public.data_exports.storage_key IS
  'Object key of the ZIP. Not readable by authenticated; the API recomputes it with exportKey() and signs it for the requester only.';
COMMENT ON COLUMN public.data_exports.include_location IS
  'Whether photos.csv/json carry decrypted GPS. Decryption happens only in the worker, only if export_requester_is_admin() at run time.';

ALTER TABLE public.data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_exports FORCE ROW LEVEL SECURITY;

-------------------------------------------------------------------------------------------------
-- Triggers
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.data_exports_baby_live() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.babies b WHERE b.id = NEW.baby_id AND b.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'cannot export a trashed album' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.data_exports_baby_live() FROM PUBLIC;
DROP TRIGGER IF EXISTS data_exports_baby_live ON public.data_exports;
CREATE TRIGGER data_exports_baby_live BEFORE INSERT ON public.data_exports
  FOR EACH ROW EXECUTE FUNCTION public.data_exports_baby_live();

-- One queued/running export per album; 3 per album per rolling 24 h (EXPORTS_PER_BABY_PER_DAY).
-- Locks the baby row so two concurrent requests serialise and the second sees the first
-- (NO KEY UPDATE: conflicts with itself but not with the KEY SHARE locks of FK inserts such as
-- uploads into the same album).
CREATE OR REPLACE FUNCTION public.data_exports_rate_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  recent integer;
BEGIN
  PERFORM 1 FROM public.babies b WHERE b.id = NEW.baby_id FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.data_exports e
    WHERE e.baby_id = NEW.baby_id AND e.status IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'an export is already in progress for this album' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO recent
  FROM public.data_exports e
  WHERE e.baby_id = NEW.baby_id AND e.created_at > now() - interval '24 hours';
  IF recent >= 3 THEN
    RAISE EXCEPTION 'export rate limit reached: 3 per album per day' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.data_exports_rate_limit() FROM PUBLIC;
DROP TRIGGER IF EXISTS data_exports_rate_limit ON public.data_exports;
CREATE TRIGGER data_exports_rate_limit BEFORE INSERT ON public.data_exports
  FOR EACH ROW EXECUTE FUNCTION public.data_exports_rate_limit();

-- User-role updates: expiry may only move earlier, the download counter only forward. SECURITY
-- INVOKER so current_user is the caller's role; pipeline/service_role are not constrained here
-- (pipeline has no grant on these columns; service_role is trusted).
CREATE OR REPLACE FUNCTION public.data_exports_user_update_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'an export cannot be extended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.downloads < OLD.downloads
     OR (OLD.last_downloaded_at IS NOT NULL
         AND (NEW.last_downloaded_at IS NULL OR NEW.last_downloaded_at < OLD.last_downloaded_at)) THEN
    RAISE EXCEPTION 'export download history cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.data_exports_user_update_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS data_exports_user_update_guard ON public.data_exports;
CREATE TRIGGER data_exports_user_update_guard BEFORE UPDATE ON public.data_exports
  FOR EACH ROW EXECUTE FUNCTION public.data_exports_user_update_guard();

-------------------------------------------------------------------------------------------------
-- Worker functions (pipeline only)
-------------------------------------------------------------------------------------------------
-- Run-time gate before any GPS decryption (and before the email): the requester still exists,
-- has a live profile and is an admin of the export's baby right now.
CREATE OR REPLACE FUNCTION public.export_requester_is_admin(p_export_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.data_exports e
    JOIN public.baby_members m
      ON m.baby_id = e.baby_id AND m.user_id = e.requested_by AND m.role = 'admin'
    JOIN public.profiles p ON p.user_id = e.requested_by AND p.deleted_at IS NULL
    WHERE e.id = p_export_id
  )
$$;
COMMENT ON FUNCTION public.export_requester_is_admin(uuid) IS
  'True while the export''s requester is an admin of its baby with a live profile. The worker calls it before decrypting GPS; false => failed/requester_not_admin.';

-- The requester's address for the ready/failed email, or NULL. Never for a queued/running/expired
-- export, a requester who left or was demoted, or a deleted profile.
CREATE OR REPLACE FUNCTION public.export_requester_email(p_export_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT u.email::text
  FROM public.data_exports e
  JOIN public.baby_members m
    ON m.baby_id = e.baby_id AND m.user_id = e.requested_by AND m.role = 'admin'
  JOIN public.profiles p ON p.user_id = e.requested_by AND p.deleted_at IS NULL
  JOIN auth.users u ON u.id = e.requested_by
  WHERE e.id = p_export_id
    AND e.status IN ('ready', 'failed')
    AND u.email IS NOT NULL
  LIMIT 1
$$;
COMMENT ON FUNCTION public.export_requester_email(uuid) IS
  'auth.users.email of the export requester, only for a ready/failed export whose requester is still an admin with a live profile; else NULL. pipeline only; never log the result.';

REVOKE EXECUTE ON FUNCTION public.export_requester_is_admin(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_requester_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_requester_is_admin(uuid) TO pipeline;
GRANT EXECUTE ON FUNCTION public.export_requester_email(uuid) TO pipeline;

-------------------------------------------------------------------------------------------------
-- Grants and policies
-------------------------------------------------------------------------------------------------
GRANT ALL ON public.data_exports TO service_role;

GRANT SELECT (id, baby_id, requested_by, include_location, status, error, photo_count, photos_done,
              bytes, created_at, started_at, finished_at, expires_at, purged_at, downloads,
              last_downloaded_at) ON public.data_exports TO authenticated;
GRANT INSERT (baby_id, requested_by, include_location) ON public.data_exports TO authenticated;
GRANT UPDATE (expires_at, downloads, last_downloaded_at) ON public.data_exports TO authenticated;

GRANT SELECT ON public.data_exports TO pipeline;
GRANT UPDATE (status, error, photo_count, photos_done, bytes, started_at, finished_at, purged_at)
  ON public.data_exports TO pipeline;
GRANT DELETE ON public.data_exports TO pipeline;

DROP POLICY IF EXISTS data_exports_authenticated_select ON public.data_exports;
CREATE POLICY data_exports_authenticated_select ON public.data_exports FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS data_exports_authenticated_insert ON public.data_exports;
CREATE POLICY data_exports_authenticated_insert ON public.data_exports FOR INSERT TO authenticated
  WITH CHECK (public.is_baby_admin(baby_id) AND requested_by = public.auth_uid());
DROP POLICY IF EXISTS data_exports_authenticated_update ON public.data_exports;
CREATE POLICY data_exports_authenticated_update ON public.data_exports FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id)) WITH CHECK (public.is_baby_admin(baby_id));

DROP POLICY IF EXISTS data_exports_pipeline_select ON public.data_exports;
CREATE POLICY data_exports_pipeline_select ON public.data_exports FOR SELECT TO pipeline USING (true);
DROP POLICY IF EXISTS data_exports_pipeline_update ON public.data_exports;
CREATE POLICY data_exports_pipeline_update ON public.data_exports FOR UPDATE TO pipeline
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS data_exports_pipeline_delete ON public.data_exports;
CREATE POLICY data_exports_pipeline_delete ON public.data_exports FOR DELETE TO pipeline
  USING (purged_at IS NOT NULL AND purged_at < now() - interval '30 days');

-- Export worker reads (grants audit above). babies already has babies_pipeline_select USING (true).
GRANT SELECT (name, nickname, birth_date_is_due_date, birth_weight_g, birth_length_mm, home_label)
  ON public.babies TO pipeline;
GRANT SELECT (baby_id, user_id, role, joined_at) ON public.baby_members TO pipeline;
DROP POLICY IF EXISTS baby_members_pipeline_select ON public.baby_members;
CREATE POLICY baby_members_pipeline_select ON public.baby_members FOR SELECT TO pipeline USING (true);

-- Down Migration

DROP POLICY IF EXISTS baby_members_pipeline_select ON public.baby_members;
REVOKE SELECT (baby_id, user_id, role, joined_at) ON public.baby_members FROM pipeline;
REVOKE SELECT (name, nickname, birth_date_is_due_date, birth_weight_g, birth_length_mm, home_label)
  ON public.babies FROM pipeline;

DROP FUNCTION IF EXISTS public.export_requester_email(uuid);
DROP FUNCTION IF EXISTS public.export_requester_is_admin(uuid);
DROP TABLE IF EXISTS public.data_exports;
DROP FUNCTION IF EXISTS public.data_exports_user_update_guard();
DROP FUNCTION IF EXISTS public.data_exports_rate_limit();
DROP FUNCTION IF EXISTS public.data_exports_baby_live();
