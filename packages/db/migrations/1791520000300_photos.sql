-- Up Migration

-- Photos and parent-supplied data (docs/plans/step-2.md 2.4-2.6, 2.8). Rules enforced here, not
-- only in the API: contributor uploads are pending (FR-2.7); nobody but pipeline hard-deletes and
-- only after 30 days in the trash (FR-10.2); GPS exists only encrypted and raw_json can never
-- carry coordinate keys at any depth (FR-4.3); free-tier babies are capped at 1,000 photos and
-- their photos can never enter the AI queue (FR-5.8).

-------------------------------------------------------------------------------------------------
-- milestones: NULL baby_id = global preset (2.8, fixed ids mirrored by MILESTONE_PRESETS).
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.milestones (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id     uuid        REFERENCES public.babies (id) ON DELETE CASCADE,
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  category    text        NOT NULL CHECK (category IN ('social', 'motor', 'feeding', 'growth', 'speech', 'event', 'custom')),
  sort_order  integer     NOT NULL DEFAULT 1000,
  created_by  uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS milestones_baby_id_lower_name_key
  ON public.milestones (baby_id, lower(name)) NULLS NOT DISTINCT;
ALTER TABLE public.milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.milestones FORCE ROW LEVEL SECURITY;

INSERT INTO public.milestones (id, baby_id, name, category, sort_order) VALUES
  ('10000000-0000-4000-8000-000000000001', NULL, 'First smile',              'social',  10),
  ('10000000-0000-4000-8000-000000000002', NULL, 'First laugh',              'social',  20),
  ('10000000-0000-4000-8000-000000000003', NULL, 'Rolled over',              'motor',   30),
  ('10000000-0000-4000-8000-000000000004', NULL, 'Sat up',                   'motor',   40),
  ('10000000-0000-4000-8000-000000000005', NULL, 'First food',               'feeding', 50),
  ('10000000-0000-4000-8000-000000000006', NULL, 'First tooth',              'growth',  60),
  ('10000000-0000-4000-8000-000000000007', NULL, 'Crawled',                  'motor',   70),
  ('10000000-0000-4000-8000-000000000008', NULL, 'First steps',              'motor',   80),
  ('10000000-0000-4000-8000-000000000009', NULL, 'First word',               'speech',  90),
  ('10000000-0000-4000-8000-000000000010', NULL, 'First haircut',            'event',  100),
  ('10000000-0000-4000-8000-000000000011', NULL, 'First birthday',           'event',  110),
  ('10000000-0000-4000-8000-000000000012', NULL, 'First time with [person]', 'social', 120)
ON CONFLICT (id) DO NOTHING;

-------------------------------------------------------------------------------------------------
-- photos
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.photos (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id                uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  uploaded_by            uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  storage_key_original   text        NOT NULL UNIQUE,
  sha256                 bytea       CHECK (octet_length(sha256) = 32),
  phash                  bit(64),
  duplicate_of_photo_id  uuid        REFERENCES public.photos (id) ON DELETE SET NULL,
  width                  integer     CHECK (width > 0),
  height                 integer     CHECK (height > 0),
  bytes                  bigint      CHECK (bytes >= 0),
  mime                   text        CHECK (mime IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp')),
  status                 text        NOT NULL DEFAULT 'uploaded'
                                     CHECK (status IN ('uploaded', 'ingested', 'queued', 'analyzing', 'ready', 'failed')),
  approval               text        NOT NULL DEFAULT 'approved' CHECK (approval IN ('pending', 'approved', 'rejected')),
  approved_by            uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  approved_at            timestamptz,
  taken_at               timestamptz,
  taken_at_estimated     boolean     NOT NULL DEFAULT false,
  age_days               integer,
  is_sensitive           boolean     NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz
);
CREATE INDEX IF NOT EXISTS photos_baby_id_taken_at_idx ON public.photos (baby_id, taken_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS photos_baby_id_status_idx ON public.photos (baby_id, status);
CREATE INDEX IF NOT EXISTS photos_baby_id_pending_idx ON public.photos (baby_id) WHERE approval = 'pending';
CREATE INDEX IF NOT EXISTS photos_uploaded_by_idx ON public.photos (uploaded_by);
CREATE UNIQUE INDEX IF NOT EXISTS photos_baby_id_sha256_key
  ON public.photos (baby_id, sha256) WHERE sha256 IS NOT NULL AND deleted_at IS NULL;
COMMENT ON TABLE public.photos IS
  'One row per uploaded original. approval = pending until an admin approves a contributor upload (FR-2.7). deleted_at = trash; hard delete by pipeline after 30 days (FR-10.2).';
COMMENT ON COLUMN public.photos.is_sensitive IS
  'Raised by the AI sensitive_flags sync or by an admin; sensitive photos are never auto-shared (FR-9.5).';
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photos FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS photos_set_updated_at ON public.photos;
CREATE TRIGGER photos_set_updated_at BEFORE UPDATE ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.babies DROP CONSTRAINT IF EXISTS babies_avatar_photo_id_fkey;
ALTER TABLE public.babies ADD CONSTRAINT babies_avatar_photo_id_fkey
  FOREIGN KEY (avatar_photo_id) REFERENCES public.photos (id) ON DELETE SET NULL;

-------------------------------------------------------------------------------------------------
-- photo_derivatives: written by the worker with all EXIF/GPS stripped (FR-4.4). `analysis` is the
-- only copy that may ever reach a model; viewers may only receive thumb/display.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.photo_derivatives (
  photo_id     uuid        NOT NULL REFERENCES public.photos (id) ON DELETE CASCADE,
  kind         text        NOT NULL CHECK (kind IN ('thumb', 'display', 'analysis')),
  storage_key  text        NOT NULL UNIQUE,
  width        integer     NOT NULL CHECK (width > 0),
  height       integer     NOT NULL CHECK (height > 0),
  bytes        bigint      NOT NULL CHECK (bytes >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, kind)
);
COMMENT ON TABLE public.photo_derivatives IS
  'Resized copies with all EXIF/GPS stripped. analysis is the only copy that may reach a model.';
ALTER TABLE public.photo_derivatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_derivatives FORCE ROW LEVEL SECURITY;

-------------------------------------------------------------------------------------------------
-- photo_exif: GPS only as pgcrypto ciphertext; raw_json can never carry coordinate keys (at any
-- depth). The tripwire is a trigger rather than a CHECK constraint on purpose: a CHECK failure
-- reports "Failing row contains (...)" in the error DETAIL, which Postgres writes to the server
-- log, so the smuggled coordinates would be logged by the very guard meant to keep them out.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.photo_exif (
  photo_id           uuid        PRIMARY KEY REFERENCES public.photos (id) ON DELETE CASCADE,
  taken_at           timestamptz,
  tz_offset_minutes  smallint,
  gps_lat_enc        bytea,
  gps_lng_enc        bytea,
  place_label        text,
  camera_make        text,
  camera_model       text,
  orientation        smallint,
  raw_json           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.photo_exif IS
  'EXIF per photo. GPS exists only encrypted (encrypt_coord); users see place_label only; raw_json is rejected (photo_exif_no_gps_keys) when any nested key looks like a coordinate.';
ALTER TABLE public.photo_exif ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_exif FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS photo_exif_set_updated_at ON public.photo_exif;
CREATE TRIGGER photo_exif_set_updated_at BEFORE UPDATE ON public.photo_exif
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The message names no key and no value; SQLSTATE 23514 like a CHECK would be. SECURITY DEFINER
-- so the check does not depend on the writing role holding EXECUTE on jsonb_has_gps_keys.
CREATE OR REPLACE FUNCTION public.photo_exif_no_gps_keys() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.jsonb_has_gps_keys(NEW.raw_json) THEN
    RAISE EXCEPTION 'photo_exif.raw_json must not carry coordinate keys' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_exif_no_gps_keys() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_exif_no_gps_keys ON public.photo_exif;
CREATE TRIGGER photo_exif_no_gps_keys BEFORE INSERT OR UPDATE OF raw_json ON public.photo_exif
  FOR EACH ROW EXECUTE FUNCTION public.photo_exif_no_gps_keys();

-------------------------------------------------------------------------------------------------
-- photo_details: parent-supplied (FR-3). Notes are private: never logged, never in viewer rows.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.photo_details (
  photo_id        uuid        PRIMARY KEY REFERENCES public.photos (id) ON DELETE CASCADE,
  milestone_id    uuid        REFERENCES public.milestones (id) ON DELETE SET NULL,
  note            text        CHECK (length(note) <= 2000),
  people          text[]      NOT NULL DEFAULT '{}',
  location_label  text,
  edited_by       uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_details_milestone_id_idx ON public.photo_details (milestone_id);
ALTER TABLE public.photo_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_details FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS photo_details_set_updated_at ON public.photo_details;
CREATE TRIGGER photo_details_set_updated_at BEFORE UPDATE ON public.photo_details
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------------------------
-- measurements: value_metric is grams for weight, millimetres for height/head (FR-3.3).
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.measurements (
  id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id        uuid           NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  photo_id       uuid           REFERENCES public.photos (id) ON DELETE SET NULL,
  kind           text           NOT NULL CHECK (kind IN ('weight', 'height', 'head')),
  value_metric   numeric(10,3)  NOT NULL CHECK (value_metric > 0),
  value_entered  numeric(10,3)  NOT NULL CHECK (value_entered > 0),
  unit_entered   text           NOT NULL CHECK (unit_entered IN ('g', 'kg', 'oz', 'lb', 'mm', 'cm', 'in')),
  measured_at    timestamptz    NOT NULL,
  note           text           CHECK (length(note) <= 2000),
  created_by     uuid           REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS measurements_baby_id_kind_measured_at_idx ON public.measurements (baby_id, kind, measured_at);
ALTER TABLE public.measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.measurements FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS measurements_set_updated_at ON public.measurements;
CREATE TRIGGER measurements_set_updated_at BEFORE UPDATE ON public.measurements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------------------------
-- photo_ai_overrides: parent corrections to AI fields win over photo_ai.description.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.photo_ai_overrides (
  photo_id    uuid        NOT NULL REFERENCES public.photos (id) ON DELETE CASCADE,
  field_path  text        NOT NULL CHECK (length(field_path) BETWEEN 1 AND 200),
  value       jsonb       NOT NULL,
  edited_by   uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, field_path)
);
ALTER TABLE public.photo_ai_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_ai_overrides FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS photo_ai_overrides_set_updated_at ON public.photo_ai_overrides;
CREATE TRIGGER photo_ai_overrides_set_updated_at BEFORE UPDATE ON public.photo_ai_overrides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------------------------
-- Visibility helpers.
-------------------------------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: it inherits the caller's photos policy, so every child table
-- follows exactly the parent's visibility for that role (authenticated, viewer or pipeline).
CREATE OR REPLACE FUNCTION public.photo_visible(p_photo_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.photos p WHERE p.id = p_photo_id)
$$;

-- Who may edit details/overrides: an admin of the photo's baby, or the uploader while the photo
-- is still pending; never a trashed photo.
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

REVOKE EXECUTE ON FUNCTION public.photo_visible(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.photo_editable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.photo_visible(uuid) TO authenticated, viewer, pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.photo_editable(uuid) TO authenticated, service_role;

-------------------------------------------------------------------------------------------------
-- Triggers (SECURITY DEFINER).
-------------------------------------------------------------------------------------------------
-- Free tier: 1,000 non-deleted photos per baby (FREE_TIER_PHOTO_LIMIT in @littlelight/shared).
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
REVOKE EXECUTE ON FUNCTION public.photos_free_tier_cap() FROM PUBLIC;
DROP TRIGGER IF EXISTS photos_free_tier_cap ON public.photos;
CREATE TRIGGER photos_free_tier_cap BEFORE INSERT ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_free_tier_cap();

-- Only approved, live photos of a paid-tier baby may enter the AI queue (FR-2.7, FR-5.8).
CREATE OR REPLACE FUNCTION public.photos_status_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IN ('queued', 'analyzing') AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.approval <> 'approved' OR NEW.deleted_at IS NOT NULL OR NOT public.baby_ai_enabled(NEW.baby_id) THEN
      RAISE EXCEPTION 'photo cannot enter the AI queue: it must be approved, not deleted and belong to a paid-tier baby'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photos_status_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS photos_status_guard ON public.photos;
CREATE TRIGGER photos_status_guard BEFORE UPDATE OF status ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_status_guard();

-- A baby's avatar must be one of its own approved, live photos.
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
REVOKE EXECUTE ON FUNCTION public.babies_avatar_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS babies_avatar_guard ON public.babies;
CREATE TRIGGER babies_avatar_guard BEFORE INSERT OR UPDATE OF avatar_photo_id ON public.babies
  FOR EACH ROW EXECUTE FUNCTION public.babies_avatar_guard();

-------------------------------------------------------------------------------------------------
-- Grants and policies (viewer policies live in the sharing migration).
-------------------------------------------------------------------------------------------------
GRANT ALL ON public.milestones, public.photos, public.photo_derivatives, public.photo_exif,
             public.photo_details, public.measurements, public.photo_ai_overrides TO service_role;

-- milestones ------------------------------------------------------------------------------------
GRANT SELECT, DELETE ON public.milestones TO authenticated;
GRANT INSERT (id, baby_id, name, category, sort_order, created_by) ON public.milestones TO authenticated;
GRANT UPDATE (name, category, sort_order) ON public.milestones TO authenticated;
GRANT SELECT ON public.milestones TO pipeline;

DROP POLICY IF EXISTS milestones_authenticated_select ON public.milestones;
CREATE POLICY milestones_authenticated_select ON public.milestones FOR SELECT TO authenticated
  USING (baby_id IS NULL OR public.is_baby_member(baby_id));
DROP POLICY IF EXISTS milestones_authenticated_insert ON public.milestones;
CREATE POLICY milestones_authenticated_insert ON public.milestones FOR INSERT TO authenticated
  WITH CHECK (baby_id IS NOT NULL AND public.is_baby_admin(baby_id) AND created_by = public.auth_uid());
DROP POLICY IF EXISTS milestones_authenticated_update ON public.milestones;
CREATE POLICY milestones_authenticated_update ON public.milestones FOR UPDATE TO authenticated
  USING (baby_id IS NOT NULL AND public.is_baby_admin(baby_id))
  WITH CHECK (baby_id IS NOT NULL AND public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS milestones_authenticated_delete ON public.milestones;
CREATE POLICY milestones_authenticated_delete ON public.milestones FOR DELETE TO authenticated
  USING (baby_id IS NOT NULL AND public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS milestones_pipeline_select ON public.milestones;
CREATE POLICY milestones_pipeline_select ON public.milestones FOR SELECT TO pipeline USING (true);

-- photos ----------------------------------------------------------------------------------------
-- authenticated never gets DELETE: "a contributor cannot delete" and admins only trash.
GRANT SELECT ON public.photos TO authenticated;
GRANT INSERT (id, baby_id, uploaded_by, storage_key_original, mime, bytes, width, height,
              approval, approved_by, approved_at, taken_at, taken_at_estimated) ON public.photos TO authenticated;
GRANT UPDATE (approval, approved_by, approved_at, is_sensitive, deleted_at, updated_at) ON public.photos TO authenticated;
GRANT SELECT ON public.photos TO pipeline;
GRANT UPDATE (status, sha256, phash, duplicate_of_photo_id, width, height, bytes, mime,
              taken_at, taken_at_estimated, age_days, is_sensitive, updated_at) ON public.photos TO pipeline;
GRANT DELETE ON public.photos TO pipeline;

-- Admins: everything incl. trash and the approval queue. Contributors: the approved live album
-- plus their own uploads in any state (PRD "Own uploads + approved album"; also needed so a
-- contributor's trash UPDATE passes the SELECT check Postgres applies to the new row).
DROP POLICY IF EXISTS photos_authenticated_select ON public.photos;
CREATE POLICY photos_authenticated_select ON public.photos FOR SELECT TO authenticated
  USING (
    public.is_baby_admin(baby_id)
    OR (public.is_baby_member(baby_id)
        AND ((approval = 'approved' AND deleted_at IS NULL) OR uploaded_by = public.auth_uid()))
  );
DROP POLICY IF EXISTS photos_authenticated_insert ON public.photos;
CREATE POLICY photos_authenticated_insert ON public.photos FOR INSERT TO authenticated
  WITH CHECK (
    public.is_baby_member(baby_id)
    AND uploaded_by = public.auth_uid()
    AND (public.is_baby_admin(baby_id) OR approval = 'pending')
  );
DROP POLICY IF EXISTS photos_authenticated_update ON public.photos;
CREATE POLICY photos_authenticated_update ON public.photos FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id) OR (uploaded_by = public.auth_uid() AND approval = 'pending'))
  WITH CHECK (public.is_baby_admin(baby_id) OR (uploaded_by = public.auth_uid() AND approval = 'pending'));
DROP POLICY IF EXISTS photos_pipeline_select ON public.photos;
CREATE POLICY photos_pipeline_select ON public.photos FOR SELECT TO pipeline USING (true);
DROP POLICY IF EXISTS photos_pipeline_update ON public.photos;
CREATE POLICY photos_pipeline_update ON public.photos FOR UPDATE TO pipeline USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS photos_pipeline_delete ON public.photos;
CREATE POLICY photos_pipeline_delete ON public.photos FOR DELETE TO pipeline
  USING (deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days');

-- photo_derivatives -----------------------------------------------------------------------------
GRANT SELECT ON public.photo_derivatives TO authenticated;
GRANT ALL ON public.photo_derivatives TO pipeline;

DROP POLICY IF EXISTS photo_derivatives_authenticated_select ON public.photo_derivatives;
CREATE POLICY photo_derivatives_authenticated_select ON public.photo_derivatives FOR SELECT TO authenticated
  USING (public.photo_visible(photo_id));
DROP POLICY IF EXISTS photo_derivatives_pipeline_all ON public.photo_derivatives;
CREATE POLICY photo_derivatives_pipeline_all ON public.photo_derivatives FOR ALL TO pipeline
  USING (true) WITH CHECK (true);

-- photo_exif: users never see the encrypted GPS columns (admins get place_label only) nor
-- raw_json (pipeline input; the CHECK is a tripwire, not a reason to expose it) ------------------
GRANT SELECT (photo_id, taken_at, tz_offset_minutes, place_label, camera_make, camera_model,
              orientation, created_at, updated_at) ON public.photo_exif TO authenticated;
GRANT ALL ON public.photo_exif TO pipeline;

DROP POLICY IF EXISTS photo_exif_authenticated_select ON public.photo_exif;
CREATE POLICY photo_exif_authenticated_select ON public.photo_exif FOR SELECT TO authenticated
  USING (public.photo_visible(photo_id));
DROP POLICY IF EXISTS photo_exif_pipeline_all ON public.photo_exif;
CREATE POLICY photo_exif_pipeline_all ON public.photo_exif FOR ALL TO pipeline
  USING (true) WITH CHECK (true);

-- photo_details ---------------------------------------------------------------------------------
GRANT SELECT, DELETE ON public.photo_details TO authenticated;
GRANT INSERT (photo_id, milestone_id, note, people, location_label, edited_by) ON public.photo_details TO authenticated;
GRANT UPDATE (milestone_id, note, people, location_label, edited_by, updated_at) ON public.photo_details TO authenticated;
GRANT SELECT ON public.photo_details TO pipeline;

DROP POLICY IF EXISTS photo_details_authenticated_select ON public.photo_details;
CREATE POLICY photo_details_authenticated_select ON public.photo_details FOR SELECT TO authenticated
  USING (public.photo_visible(photo_id));
DROP POLICY IF EXISTS photo_details_authenticated_insert ON public.photo_details;
CREATE POLICY photo_details_authenticated_insert ON public.photo_details FOR INSERT TO authenticated
  WITH CHECK (public.photo_editable(photo_id) AND edited_by = public.auth_uid());
DROP POLICY IF EXISTS photo_details_authenticated_update ON public.photo_details;
CREATE POLICY photo_details_authenticated_update ON public.photo_details FOR UPDATE TO authenticated
  USING (public.photo_editable(photo_id)) WITH CHECK (public.photo_editable(photo_id));
DROP POLICY IF EXISTS photo_details_authenticated_delete ON public.photo_details;
CREATE POLICY photo_details_authenticated_delete ON public.photo_details FOR DELETE TO authenticated
  USING (public.photo_editable(photo_id));
DROP POLICY IF EXISTS photo_details_pipeline_select ON public.photo_details;
CREATE POLICY photo_details_pipeline_select ON public.photo_details FOR SELECT TO pipeline USING (true);

-- measurements ----------------------------------------------------------------------------------
GRANT SELECT, DELETE ON public.measurements TO authenticated;
GRANT INSERT (id, baby_id, photo_id, kind, value_metric, value_entered, unit_entered, measured_at, note, created_by)
  ON public.measurements TO authenticated;
GRANT UPDATE (photo_id, kind, value_metric, value_entered, unit_entered, measured_at, note, updated_at)
  ON public.measurements TO authenticated;
GRANT SELECT ON public.measurements TO pipeline;

DROP POLICY IF EXISTS measurements_authenticated_select ON public.measurements;
CREATE POLICY measurements_authenticated_select ON public.measurements FOR SELECT TO authenticated
  USING (public.is_baby_member(baby_id));
DROP POLICY IF EXISTS measurements_authenticated_insert ON public.measurements;
CREATE POLICY measurements_authenticated_insert ON public.measurements FOR INSERT TO authenticated
  WITH CHECK (public.is_baby_admin(baby_id) AND created_by = public.auth_uid());
DROP POLICY IF EXISTS measurements_authenticated_update ON public.measurements;
CREATE POLICY measurements_authenticated_update ON public.measurements FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id)) WITH CHECK (public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS measurements_authenticated_delete ON public.measurements;
CREATE POLICY measurements_authenticated_delete ON public.measurements FOR DELETE TO authenticated
  USING (public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS measurements_pipeline_select ON public.measurements;
CREATE POLICY measurements_pipeline_select ON public.measurements FOR SELECT TO pipeline USING (true);

-- photo_ai_overrides ----------------------------------------------------------------------------
GRANT SELECT, DELETE ON public.photo_ai_overrides TO authenticated;
GRANT INSERT (photo_id, field_path, value, edited_by) ON public.photo_ai_overrides TO authenticated;
GRANT UPDATE (value, edited_by, updated_at) ON public.photo_ai_overrides TO authenticated;
GRANT SELECT ON public.photo_ai_overrides TO pipeline;

DROP POLICY IF EXISTS photo_ai_overrides_authenticated_select ON public.photo_ai_overrides;
CREATE POLICY photo_ai_overrides_authenticated_select ON public.photo_ai_overrides FOR SELECT TO authenticated
  USING (public.photo_visible(photo_id));
DROP POLICY IF EXISTS photo_ai_overrides_authenticated_insert ON public.photo_ai_overrides;
CREATE POLICY photo_ai_overrides_authenticated_insert ON public.photo_ai_overrides FOR INSERT TO authenticated
  WITH CHECK (public.photo_editable(photo_id) AND edited_by = public.auth_uid());
DROP POLICY IF EXISTS photo_ai_overrides_authenticated_update ON public.photo_ai_overrides;
CREATE POLICY photo_ai_overrides_authenticated_update ON public.photo_ai_overrides FOR UPDATE TO authenticated
  USING (public.photo_editable(photo_id)) WITH CHECK (public.photo_editable(photo_id));
DROP POLICY IF EXISTS photo_ai_overrides_authenticated_delete ON public.photo_ai_overrides;
CREATE POLICY photo_ai_overrides_authenticated_delete ON public.photo_ai_overrides FOR DELETE TO authenticated
  USING (public.photo_editable(photo_id));
DROP POLICY IF EXISTS photo_ai_overrides_pipeline_select ON public.photo_ai_overrides;
CREATE POLICY photo_ai_overrides_pipeline_select ON public.photo_ai_overrides FOR SELECT TO pipeline USING (true);

-- Down Migration

DROP TRIGGER IF EXISTS babies_avatar_guard ON public.babies;
DROP FUNCTION IF EXISTS public.babies_avatar_guard();
ALTER TABLE public.babies DROP CONSTRAINT IF EXISTS babies_avatar_photo_id_fkey;

DROP TABLE IF EXISTS public.photo_ai_overrides;
DROP TABLE IF EXISTS public.measurements;
DROP TABLE IF EXISTS public.photo_details;
DROP TABLE IF EXISTS public.photo_exif;
DROP TABLE IF EXISTS public.photo_derivatives;
DROP TABLE IF EXISTS public.photos;
DROP TABLE IF EXISTS public.milestones;

DROP FUNCTION IF EXISTS public.photos_status_guard();
DROP FUNCTION IF EXISTS public.photos_free_tier_cap();
DROP FUNCTION IF EXISTS public.photo_exif_no_gps_keys();
DROP FUNCTION IF EXISTS public.photo_editable(uuid);
DROP FUNCTION IF EXISTS public.photo_visible(uuid);
