-- Up Migration

-- Step 4 (docs/plans/step-4.md 2.3; PRD FR-2 Upload, FR-4 Metadata extraction, FR-6 Storage,
-- FR-10.2 Data rights, "Privacy and child safety"): upload sessions and files, the transient
-- `duplicate` photo marker, CSAM quarantine, and the Home place-label helper.
--
-- Rules enforced here, not in the API or the UI:
-- * `upload_sessions` / `upload_files` are baby-scoped: ENABLE + FORCE RLS, policies on
--   `is_baby_member` / `is_baby_admin` / the caller's own `created_by`. The `viewer` role gets
--   nothing on either table. `pipeline` can read and update files (ingest state) but can never
--   INSERT or DELETE a session or a file (no grant).
-- * No one uploads into someone else's session and no session holds more than 500 files: the
--   SECURITY DEFINER trigger `upload_files_session_owner` checks owner, expiry, finished state
--   and the cap on every INSERT (check_violation "upload session is full" / "upload session is
--   closed"), independently of the policies.
-- * `upload_files.id` IS the future `photos.id` (the object key is fixed before the row in
--   `photos` exists); a CHECK pins `photo_id` to `id` so a row can never point at another
--   user's photo. The `photos` row itself is still inserted under the uploader's own claims, so
--   `photos_authenticated_insert` (step 2) is what forces a contributor's upload to
--   `approval = 'pending'` (FR-2.7).
-- * Exact duplicates leave no `photos` row (D3): ingest marks the loser `status = 'duplicate'`
--   (new CHECK value) and hard-deletes it; `photos_pipeline_delete` gains exactly
--   `OR status = 'duplicate'`. The unique partial index `photos_baby_id_sha256_key` (step 2) is
--   the race arbiter. `duplicate_of_photo_id` therefore means "near-duplicate of" (pHash).
-- * `photos.quarantined_at` (CSAM hash match, 2.9): a quarantined row is invisible to every user
--   role (`authenticated`, `viewer`; child tables follow through `photo_visible`), cannot be
--   edited or made an avatar, is never purged automatically (evidence retention: an operator
--   decides) and only `pipeline` may set it. `service_role` still sees it.
-- * Home-within-150 m (FR-4.3 "home" label, D7) is computed in SQL by `home_place_label`
--   against the encrypted home coordinates: plaintext coordinates never leave Postgres, the
--   function is executable by `pipeline` and `service_role` only, and the data key is a
--   transaction-local bind parameter as for `encrypt_coord` / `decrypt_coord`.
-- * The free-tier cap counts only photos that are actually in the album: a failed ingest
--   (`status = 'failed'`: unsupported media, decode failure, storage error, CSAM quarantine) keeps
--   its `photos` row so the uploader can see why, but does not eat the 1,000-photo allowance, and
--   neither does the transient `duplicate` marker, a trashed row or a quarantined one.
--   `free_tier_photo_count` is the one definition of "counts toward the cap" for the
--   `photos_free_tier_cap` trigger and for the API's friendly pre-check.
-- * A trashed baby that still holds a quarantined photo cannot be hard-deleted by `pipeline`
--   (`babies_pipeline_delete` gains `NOT baby_has_quarantined_photos(id)`): the cascade would
--   destroy the evidence row. `service_role` (BYPASSRLS) and the superuser are unaffected, as for
--   every other purge rule; the operator flow decides.
-- * Nothing here logs or echoes coordinates, notes or bytes: every RAISE names no value.

-------------------------------------------------------------------------------------------------
-- photos: 'duplicate' status, quarantine, near-duplicate semantics.
-------------------------------------------------------------------------------------------------
ALTER TABLE public.photos DROP CONSTRAINT IF EXISTS photos_status_check;
ALTER TABLE public.photos ADD CONSTRAINT photos_status_check
  CHECK (status IN ('uploaded', 'ingested', 'queued', 'analyzing', 'ready', 'failed', 'duplicate'));

ALTER TABLE public.photos ADD COLUMN IF NOT EXISTS quarantined_at timestamptz;
CREATE INDEX IF NOT EXISTS photos_quarantined_at_idx ON public.photos (quarantined_at) WHERE quarantined_at IS NOT NULL;

COMMENT ON COLUMN public.photos.status IS
  'uploaded -> ingested -> queued -> analyzing -> ready | failed. duplicate = transient marker set by ingest right before the exact-duplicate row is hard-deleted; survives only if the worker dies in between (purge.trash removes it).';
COMMENT ON COLUMN public.photos.duplicate_of_photo_id IS
  'Near-duplicate (pHash within PHASH_NEAR_DUPLICATE_MAX_DISTANCE) of an earlier live photo; flag only. Exact duplicates never keep a row.';
COMMENT ON COLUMN public.photos.quarantined_at IS
  'Set by the pipeline on a CSAM hash match. Invisible to every user role, never purged automatically, no derivatives; the original is kept as evidence until an operator decides.';

-- Only the pipeline may quarantine (and only the pipeline could clear it; the API never does).
GRANT UPDATE (quarantined_at) ON public.photos TO pipeline;

-- The only change to the user-facing SELECT policies: a quarantined row does not exist for
-- users. Same bodies as step 2 / the sharing migration plus the one clause.
DROP POLICY IF EXISTS photos_authenticated_select ON public.photos;
CREATE POLICY photos_authenticated_select ON public.photos FOR SELECT TO authenticated
  USING (
    quarantined_at IS NULL
    AND (
      public.is_baby_admin(baby_id)
      OR (public.is_baby_member(baby_id)
          AND ((approval = 'approved' AND deleted_at IS NULL) OR uploaded_by = public.auth_uid()))
    )
  );
DROP POLICY IF EXISTS photos_viewer_select ON public.photos;
CREATE POLICY photos_viewer_select ON public.photos FOR SELECT TO viewer
  USING (
    quarantined_at IS NULL
    AND public.viewer_can_see_photo(id) AND deleted_at IS NULL AND approval = 'approved'
  );
-- Users cannot approve, trash, restore or re-flag a quarantined photo either (an UPDATE that
-- names the row in WHERE is already stopped by the SELECT policy; this closes the WHERE-less
-- form too).
DROP POLICY IF EXISTS photos_authenticated_update ON public.photos;
CREATE POLICY photos_authenticated_update ON public.photos FOR UPDATE TO authenticated
  USING (
    quarantined_at IS NULL
    AND (public.is_baby_admin(baby_id) OR (uploaded_by = public.auth_uid() AND approval = 'pending'))
  )
  WITH CHECK (public.is_baby_admin(baby_id) OR (uploaded_by = public.auth_uid() AND approval = 'pending'));

-- Hard delete by the pipeline: trash older than 30 days (FR-10.2) or the exact-duplicate marker.
-- Quarantined originals are never purged automatically.
DROP POLICY IF EXISTS photos_pipeline_delete ON public.photos;
CREATE POLICY photos_pipeline_delete ON public.photos FOR DELETE TO pipeline
  USING (
    (deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days' AND quarantined_at IS NULL)
    OR status = 'duplicate'
  );

-- A quarantined photo is not editable (details / overrides) and cannot become an avatar: the
-- SECURITY DEFINER helpers would otherwise see it even though the caller cannot.
CREATE OR REPLACE FUNCTION public.photo_editable(p_photo_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.photos p
    WHERE p.id = p_photo_id
      AND p.deleted_at IS NULL
      AND p.quarantined_at IS NULL
      AND (public.is_baby_admin(p.baby_id)
           OR (p.uploaded_by = public.auth_uid() AND p.approval = 'pending'))
  )
$$;

CREATE OR REPLACE FUNCTION public.babies_avatar_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.avatar_photo_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.photos p
    WHERE p.id = NEW.avatar_photo_id AND p.baby_id = NEW.id
      AND p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
  ) THEN
    RAISE EXCEPTION 'avatar must be an approved, non-deleted photo of this baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-------------------------------------------------------------------------------------------------
-- Free-tier cap (FREE_TIER_PHOTO_LIMIT = 1000 in @tinyglow/shared): what counts.
-- A photo counts when it is not trashed, not quarantined and its status is neither 'failed' nor
-- the transient 'duplicate' marker. Pending (unapproved) photos count: they are real uploads
-- that hold storage. The helper is SECURITY DEFINER so a contributor's pre-check is exact rather
-- than a lower bound (RLS hides other contributors' pending photos from them); it returns 0 for
-- a caller that is not a member of the baby, and the full count in a transaction without claims
-- (pipeline / service_role). The trigger below re-states the same predicate unconditionally so a
-- hard stop never depends on who is inserting; keep the two WHERE clauses identical.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.free_tier_photo_count(p_baby_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM public.photos p
  WHERE p.baby_id = p_baby_id
    AND p.deleted_at IS NULL
    AND p.quarantined_at IS NULL
    AND p.status NOT IN ('failed', 'duplicate')
    AND (public.auth_claims() IS NULL OR public.is_baby_member(p_baby_id))
$$;
COMMENT ON FUNCTION public.free_tier_photo_count(uuid) IS
  'Photos of the baby that count toward the 1,000-photo free-tier cap: not trashed, not quarantined, status not failed/duplicate. 0 for a non-member; full count without claims.';
REVOKE EXECUTE ON FUNCTION public.free_tier_photo_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.free_tier_photo_count(uuid) TO authenticated, pipeline, service_role;

CREATE OR REPLACE FUNCTION public.photos_free_tier_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  baby_plan text;
  live_count integer;
BEGIN
  SELECT b.plan INTO baby_plan FROM public.babies b WHERE b.id = NEW.baby_id;
  IF baby_plan = 'free' THEN
    -- Same predicate as free_tier_photo_count, without the membership gate.
    SELECT count(*) INTO live_count
    FROM public.photos p
    WHERE p.baby_id = NEW.baby_id
      AND p.deleted_at IS NULL
      AND p.quarantined_at IS NULL
      AND p.status NOT IN ('failed', 'duplicate');
    IF live_count >= 1000 THEN
      RAISE EXCEPTION 'free tier photo limit reached (1000 photos per baby)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-------------------------------------------------------------------------------------------------
-- Baby purge guard: a trashed baby holding a quarantined photo is never hard-deleted by the
-- pipeline (the cascade would delete the evidence row). Helper is SECURITY DEFINER so the policy
-- does not depend on the pipeline's own photos policy; pipeline / service_role only.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.baby_has_quarantined_photos(p_baby_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.photos p
    WHERE p.baby_id = p_baby_id AND p.quarantined_at IS NOT NULL
  )
$$;
COMMENT ON FUNCTION public.baby_has_quarantined_photos(uuid) IS
  'True while any photo of the baby is quarantined (CSAM hash match): the baby row must not be purged.';
REVOKE EXECUTE ON FUNCTION public.baby_has_quarantined_photos(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baby_has_quarantined_photos(uuid) TO pipeline, service_role;

DROP POLICY IF EXISTS babies_pipeline_delete ON public.babies;
CREATE POLICY babies_pipeline_delete ON public.babies FOR DELETE TO pipeline
  USING (
    deleted_at IS NOT NULL
    AND deleted_at < now() - interval '30 days'
    AND NOT public.baby_has_quarantined_photos(id)
  );

-------------------------------------------------------------------------------------------------
-- upload_sessions: one per picker session (FR-2.1 up to 500 files; FR-3.1 batch details).
-- Batch details (note, people, location) are parent data: never readable by pipeline or viewer.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.upload_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id         uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  created_by      uuid        NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  milestone_id    uuid        REFERENCES public.milestones (id) ON DELETE SET NULL,
  people          text[]      NOT NULL DEFAULT '{}',
  note            text        CHECK (length(note) <= 2000),
  location_label  text        CHECK (length(location_label) <= 120),
  finished_at     timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upload_sessions_baby_id_created_at_idx ON public.upload_sessions (baby_id, created_at DESC);
CREATE INDEX IF NOT EXISTS upload_sessions_expires_at_idx ON public.upload_sessions (expires_at);
COMMENT ON TABLE public.upload_sessions IS
  'One picker session (<= 500 files, 24 h). Batch details apply to every photo completed in it. Only the creator may add files (upload_files_session_owner); admins of the baby can see it.';
ALTER TABLE public.upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_sessions FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS upload_sessions_set_updated_at ON public.upload_sessions;
CREATE TRIGGER upload_sessions_set_updated_at BEFORE UPDATE ON public.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- SECURITY INVOKER on purpose (like photo_visible): it inherits the caller's upload_sessions
-- policy, so upload_files follows exactly the session's visibility for that role.
CREATE OR REPLACE FUNCTION public.upload_session_visible(p_session_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.upload_sessions s WHERE s.id = p_session_id)
$$;
REVOKE EXECUTE ON FUNCTION public.upload_session_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upload_session_visible(uuid) TO authenticated, pipeline, service_role;

-------------------------------------------------------------------------------------------------
-- upload_files: one per registered file; `id` becomes `photos.id` on completion.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.upload_files (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              uuid        NOT NULL REFERENCES public.upload_sessions (id) ON DELETE CASCADE,
  baby_id                 uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  client_id               text        CHECK (length(client_id) <= 64),
  declared_bytes          bigint      NOT NULL CHECK (declared_bytes > 0 AND declared_bytes <= 104857600),
  client_sha256           bytea       CHECK (octet_length(client_sha256) = 32),
  client_mime             text        CHECK (client_mime IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp')),
  taken_at_hint           timestamptz,
  tz_offset_hint_minutes  smallint    CHECK (tz_offset_hint_minutes BETWEEN -840 AND 840),
  storage_key             text        NOT NULL UNIQUE,
  multipart_upload_id     text,
  part_size               integer     NOT NULL CHECK (part_size > 0),
  state                   text        NOT NULL DEFAULT 'registered'
                                      CHECK (state IN ('registered', 'completed', 'ingested', 'duplicate', 'failed', 'aborted')),
  error                   text        CHECK (error IN ('unsupported_media_type', 'file_too_large', 'decode_failed', 'free_tier_limit',
                                                       'rejected', 'expired', 'storage_error', 'upload_incomplete')),
  photo_id                uuid        REFERENCES public.photos (id) ON DELETE SET NULL,
  duplicate_of_photo_id   uuid        REFERENCES public.photos (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- The photo row created at completion carries this very id: a file can never point elsewhere.
  CONSTRAINT upload_files_photo_id_is_id CHECK (photo_id IS NULL OR photo_id = id)
);
CREATE INDEX IF NOT EXISTS upload_files_session_id_idx ON public.upload_files (session_id);
CREATE INDEX IF NOT EXISTS upload_files_baby_id_state_idx ON public.upload_files (baby_id, state);
CREATE INDEX IF NOT EXISTS upload_files_sweep_idx ON public.upload_files (state)
  WHERE state IN ('registered', 'failed', 'aborted');
COMMENT ON TABLE public.upload_files IS
  'One registered file per upload session; id = the photos.id minted before the object exists. client_* columns are hints only (the worker re-sniffs and re-hashes). state: registered -> completed -> ingested | duplicate | failed; aborted.';
COMMENT ON COLUMN public.upload_files.client_sha256 IS
  'Browser-computed SHA-256 used only for the instant duplicate pre-check; never trusted.';
COMMENT ON COLUMN public.upload_files.duplicate_of_photo_id IS
  'For state = duplicate: the live photo of this baby with the same bytes (NULL when the duplicate was another file of the same session). Must belong to the same baby.';
ALTER TABLE public.upload_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_files FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS upload_files_set_updated_at ON public.upload_files;
CREATE TRIGGER upload_files_set_updated_at BEFORE UPDATE ON public.upload_files
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Session guard (SECURITY DEFINER: sees the session regardless of the caller's policies).
-- Every INSERT: the session must exist, belong to the same baby, be open (not finished, not
-- expired) and hold fewer than 500 files; in a user-context transaction (claims set) the caller
-- must be the session's creator. The session row is locked (NO KEY UPDATE) so two concurrent
-- registrations cannot both pass the count. On INSERT and UPDATE, duplicate_of_photo_id must be
-- a photo of the same baby. Messages name no value and map to API errors.
CREATE OR REPLACE FUNCTION public.upload_files_session_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  s record;
  n_files integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT us.baby_id, us.created_by, us.finished_at, us.expires_at
      INTO s
      FROM public.upload_sessions us
     WHERE us.id = NEW.session_id
       FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'upload session is closed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.baby_id <> s.baby_id THEN
      RAISE EXCEPTION 'upload file must belong to the baby of its session' USING ERRCODE = 'check_violation';
    END IF;
    IF public.auth_claims() IS NOT NULL AND s.created_by IS DISTINCT FROM public.auth_uid() THEN
      RAISE EXCEPTION 'upload session belongs to another user' USING ERRCODE = 'check_violation';
    END IF;
    IF s.finished_at IS NOT NULL OR s.expires_at <= now() THEN
      RAISE EXCEPTION 'upload session is closed' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO n_files FROM public.upload_files f WHERE f.session_id = NEW.session_id;
    IF n_files >= 500 THEN
      RAISE EXCEPTION 'upload session is full' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.duplicate_of_photo_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.duplicate_of_photo_id IS DISTINCT FROM OLD.duplicate_of_photo_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.photos p
       WHERE p.id = NEW.duplicate_of_photo_id AND p.baby_id = NEW.baby_id
     ) THEN
    RAISE EXCEPTION 'duplicate_of_photo_id must be a photo of the same baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.upload_files_session_owner() FROM PUBLIC;
DROP TRIGGER IF EXISTS upload_files_session_owner ON public.upload_files;
CREATE TRIGGER upload_files_session_owner BEFORE INSERT OR UPDATE OF duplicate_of_photo_id ON public.upload_files
  FOR EACH ROW EXECUTE FUNCTION public.upload_files_session_owner();

-------------------------------------------------------------------------------------------------
-- Home place label (FR-4.3 "home" within 150 m = HOME_RADIUS_M in @tinyglow/shared; D7).
-- Haversine on the decrypted home coordinates, entirely in SQL: the worker passes the photo's
-- coordinates as bind parameters (the same ones it hands to encrypt_coord) and only ever gets
-- 'Home' or NULL back. SECURITY INVOKER: the caller must itself hold the data key and the
-- pipeline-only SELECT grant on babies.home_*_enc, so no user role can call this even by name.
-- No branch raises with a coordinate in the message.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.home_place_label(p_baby_id uuid, p_lat double precision, p_lng double precision)
  RETURNS text
  LANGUAGE sql STABLE STRICT SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN 2 * 6371000.0 * asin(least(1.0, sqrt(
                  power(sin(radians(p_lat - public.decrypt_coord(b.home_lat_enc)) / 2), 2)
                  + cos(radians(public.decrypt_coord(b.home_lat_enc))) * cos(radians(p_lat))
                    * power(sin(radians(p_lng - public.decrypt_coord(b.home_lng_enc)) / 2), 2)
                ))) <= 150
           THEN 'Home'
         END
  FROM public.babies b
  WHERE b.id = p_baby_id
    AND b.home_lat_enc IS NOT NULL
    AND b.home_lng_enc IS NOT NULL
$$;
COMMENT ON FUNCTION public.home_place_label(uuid, double precision, double precision) IS
  '''Home'' when the point is within 150 m of the baby''s encrypted home location, else NULL (also NULL without a home). Needs app.data_key; pipeline/service_role only.';

-- Same, from already-encrypted coordinates (re-labelling photo_exif when a home is set later).
CREATE OR REPLACE FUNCTION public.home_place_label(p_baby_id uuid, p_lat_enc bytea, p_lng_enc bytea)
  RETURNS text
  LANGUAGE sql STABLE STRICT SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT public.home_place_label(p_baby_id, public.decrypt_coord(p_lat_enc), public.decrypt_coord(p_lng_enc))
$$;

REVOKE EXECUTE ON FUNCTION public.home_place_label(uuid, double precision, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.home_place_label(uuid, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.home_place_label(uuid, double precision, double precision) TO pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.home_place_label(uuid, bytea, bytea) TO pipeline, service_role;

-------------------------------------------------------------------------------------------------
-- Grants and policies for the new tables. service_role: ALL (BYPASSRLS). viewer: nothing.
-------------------------------------------------------------------------------------------------
GRANT ALL ON public.upload_sessions, public.upload_files TO service_role;

-- upload_sessions -------------------------------------------------------------------------------
GRANT SELECT ON public.upload_sessions TO authenticated;
GRANT INSERT (id, baby_id, created_by, milestone_id, people, note, location_label) ON public.upload_sessions TO authenticated;
GRANT UPDATE (finished_at, updated_at) ON public.upload_sessions TO authenticated;
-- The sweep needs liveness only: never the batch details (note, people, location, milestone).
GRANT SELECT (id, baby_id, finished_at, expires_at, created_at, updated_at) ON public.upload_sessions TO pipeline;

DROP POLICY IF EXISTS upload_sessions_authenticated_select ON public.upload_sessions;
CREATE POLICY upload_sessions_authenticated_select ON public.upload_sessions FOR SELECT TO authenticated
  USING (created_by = public.auth_uid() OR public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS upload_sessions_authenticated_insert ON public.upload_sessions;
CREATE POLICY upload_sessions_authenticated_insert ON public.upload_sessions FOR INSERT TO authenticated
  WITH CHECK (public.is_baby_member(baby_id) AND created_by = public.auth_uid());
DROP POLICY IF EXISTS upload_sessions_authenticated_update ON public.upload_sessions;
CREATE POLICY upload_sessions_authenticated_update ON public.upload_sessions FOR UPDATE TO authenticated
  USING (created_by = public.auth_uid()) WITH CHECK (created_by = public.auth_uid());
DROP POLICY IF EXISTS upload_sessions_pipeline_select ON public.upload_sessions;
CREATE POLICY upload_sessions_pipeline_select ON public.upload_sessions FOR SELECT TO pipeline USING (true);

-- upload_files ----------------------------------------------------------------------------------
GRANT SELECT ON public.upload_files TO authenticated;
GRANT INSERT (id, session_id, baby_id, client_id, declared_bytes, client_sha256, client_mime, taken_at_hint,
              tz_offset_hint_minutes, storage_key, multipart_upload_id, part_size, state, error, duplicate_of_photo_id)
  ON public.upload_files TO authenticated;
GRANT UPDATE (state, error, photo_id, multipart_upload_id, updated_at) ON public.upload_files TO authenticated;
GRANT SELECT ON public.upload_files TO pipeline;
GRANT UPDATE (state, error, photo_id, duplicate_of_photo_id, updated_at) ON public.upload_files TO pipeline;

DROP POLICY IF EXISTS upload_files_authenticated_select ON public.upload_files;
CREATE POLICY upload_files_authenticated_select ON public.upload_files FOR SELECT TO authenticated
  USING (public.upload_session_visible(session_id));
DROP POLICY IF EXISTS upload_files_authenticated_insert ON public.upload_files;
CREATE POLICY upload_files_authenticated_insert ON public.upload_files FOR INSERT TO authenticated
  WITH CHECK (
    public.upload_session_visible(session_id)
    AND baby_id = (SELECT s.baby_id FROM public.upload_sessions s WHERE s.id = session_id)
  );
DROP POLICY IF EXISTS upload_files_authenticated_update ON public.upload_files;
CREATE POLICY upload_files_authenticated_update ON public.upload_files FOR UPDATE TO authenticated
  USING (public.upload_session_visible(session_id)) WITH CHECK (public.upload_session_visible(session_id));
DROP POLICY IF EXISTS upload_files_pipeline_select ON public.upload_files;
CREATE POLICY upload_files_pipeline_select ON public.upload_files FOR SELECT TO pipeline USING (true);
DROP POLICY IF EXISTS upload_files_pipeline_update ON public.upload_files;
CREATE POLICY upload_files_pipeline_update ON public.upload_files FOR UPDATE TO pipeline USING (true) WITH CHECK (true);

-- Down Migration

DROP POLICY IF EXISTS upload_files_pipeline_update ON public.upload_files;
DROP POLICY IF EXISTS upload_files_pipeline_select ON public.upload_files;
DROP POLICY IF EXISTS upload_files_authenticated_update ON public.upload_files;
DROP POLICY IF EXISTS upload_files_authenticated_insert ON public.upload_files;
DROP POLICY IF EXISTS upload_files_authenticated_select ON public.upload_files;
DROP POLICY IF EXISTS upload_sessions_pipeline_select ON public.upload_sessions;
DROP POLICY IF EXISTS upload_sessions_authenticated_update ON public.upload_sessions;
DROP POLICY IF EXISTS upload_sessions_authenticated_insert ON public.upload_sessions;
DROP POLICY IF EXISTS upload_sessions_authenticated_select ON public.upload_sessions;

DROP FUNCTION IF EXISTS public.home_place_label(uuid, bytea, bytea);
DROP FUNCTION IF EXISTS public.home_place_label(uuid, double precision, double precision);

DROP TRIGGER IF EXISTS upload_files_session_owner ON public.upload_files;
DROP FUNCTION IF EXISTS public.upload_files_session_owner();
DROP TABLE IF EXISTS public.upload_files;
DROP FUNCTION IF EXISTS public.upload_session_visible(uuid);
DROP TABLE IF EXISTS public.upload_sessions;

-- babies: restore the step-2 purge policy, then drop the guard helper.
DROP POLICY IF EXISTS babies_pipeline_delete ON public.babies;
CREATE POLICY babies_pipeline_delete ON public.babies FOR DELETE TO pipeline
  USING (deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days');
DROP FUNCTION IF EXISTS public.baby_has_quarantined_photos(uuid);

-- Free-tier cap: restore the step-2 trigger body (every non-trashed row counts), drop the helper.
CREATE OR REPLACE FUNCTION public.photos_free_tier_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  baby_plan text;
  live_count integer;
BEGIN
  SELECT b.plan INTO baby_plan FROM public.babies b WHERE b.id = NEW.baby_id;
  IF baby_plan = 'free' THEN
    SELECT count(*) INTO live_count FROM public.photos p WHERE p.baby_id = NEW.baby_id AND p.deleted_at IS NULL;
    IF live_count >= 1000 THEN
      RAISE EXCEPTION 'free tier photo limit reached (1000 photos per baby)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP FUNCTION IF EXISTS public.free_tier_photo_count(uuid);

-- photos: restore the step-2 / sharing bodies exactly.
CREATE OR REPLACE FUNCTION public.babies_avatar_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.avatar_photo_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.photos p
    WHERE p.id = NEW.avatar_photo_id AND p.baby_id = NEW.id
      AND p.approval = 'approved' AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'avatar must be an approved, non-deleted photo of this baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.photo_editable(p_photo_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.photos p
    WHERE p.id = p_photo_id
      AND p.deleted_at IS NULL
      AND (public.is_baby_admin(p.baby_id)
           OR (p.uploaded_by = public.auth_uid() AND p.approval = 'pending'))
  )
$$;

DROP POLICY IF EXISTS photos_pipeline_delete ON public.photos;
CREATE POLICY photos_pipeline_delete ON public.photos FOR DELETE TO pipeline
  USING (deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days');
DROP POLICY IF EXISTS photos_authenticated_update ON public.photos;
CREATE POLICY photos_authenticated_update ON public.photos FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id) OR (uploaded_by = public.auth_uid() AND approval = 'pending'))
  WITH CHECK (public.is_baby_admin(baby_id) OR (uploaded_by = public.auth_uid() AND approval = 'pending'));
DROP POLICY IF EXISTS photos_viewer_select ON public.photos;
CREATE POLICY photos_viewer_select ON public.photos FOR SELECT TO viewer
  USING (public.viewer_can_see_photo(id) AND deleted_at IS NULL AND approval = 'approved');
DROP POLICY IF EXISTS photos_authenticated_select ON public.photos;
CREATE POLICY photos_authenticated_select ON public.photos FOR SELECT TO authenticated
  USING (
    public.is_baby_admin(baby_id)
    OR (public.is_baby_member(baby_id)
        AND ((approval = 'approved' AND deleted_at IS NULL) OR uploaded_by = public.auth_uid()))
  );

DROP INDEX IF EXISTS public.photos_quarantined_at_idx;
ALTER TABLE public.photos DROP COLUMN IF EXISTS quarantined_at;
COMMENT ON COLUMN public.photos.duplicate_of_photo_id IS NULL;
COMMENT ON COLUMN public.photos.status IS NULL;

-- Rows carrying the transient marker cannot satisfy the old CHECK: they are exact duplicates
-- whose object was (or is about to be) deleted, so dropping them loses nothing.
DELETE FROM public.photos WHERE status = 'duplicate';
ALTER TABLE public.photos DROP CONSTRAINT IF EXISTS photos_status_check;
ALTER TABLE public.photos ADD CONSTRAINT photos_status_check
  CHECK (status IN ('uploaded', 'ingested', 'queued', 'analyzing', 'ready', 'failed'));
