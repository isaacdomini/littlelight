-- Up Migration

-- Sharing (docs/plans/step-2.md 2.4-2.6; PRD FR-9, "Share-link viewers (no account)"). Tokens are
-- stored only as sha256; links expire after 24 hours by default; the `viewer` role can reach only
-- the allow-list below for the one share_link_id in its claims, and only while the link is
-- active; it never sees chat, notes, EXIF, AI rows, originals or hashes. Sensitive photos are
-- never auto-shared (FR-9.5).

-------------------------------------------------------------------------------------------------
-- share_links
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.share_links (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id         uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  name            text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  token_hash      bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  passcode_hash   text,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  allow_download  boolean     NOT NULL DEFAULT false,
  revoked_at      timestamptz,
  created_by      uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  last_viewed_at  timestamptz,
  view_count      integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS share_links_baby_id_idx ON public.share_links (baby_id);
COMMENT ON COLUMN public.share_links.token_hash IS
  'sha256 of the >=128-bit share token; the plaintext exists only in the URL. Exchanged for a viewer session by the API under service_role.';
COMMENT ON COLUMN public.share_links.passcode_hash IS
  'argon2id string computed by the API (optional 6-digit passcode). Never readable by user roles.';
ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_links FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS share_links_set_updated_at ON public.share_links;
CREATE TRIGGER share_links_set_updated_at BEFORE UPDATE ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------------------------
-- share_rules: auto-share rules per link (FR-9.4). No row = manual sharing only.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.share_rules (
  share_link_id  uuid        PRIMARY KEY REFERENCES public.share_links (id) ON DELETE CASCADE,
  mode           text        NOT NULL CHECK (mode IN ('all', 'milestones', 'tags')),
  include_tags   text[]      NOT NULL DEFAULT '{}',
  exclude_tags   text[]      NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.share_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_rules FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS share_rules_set_updated_at ON public.share_rules;
CREATE TRIGGER share_rules_set_updated_at BEFORE UPDATE ON public.share_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------------------------
-- shared_photos: the album behind a link.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shared_photos (
  share_link_id     uuid        NOT NULL REFERENCES public.share_links (id) ON DELETE CASCADE,
  photo_id          uuid        NOT NULL REFERENCES public.photos (id) ON DELETE CASCADE,
  added_by          text        NOT NULL CHECK (added_by IN ('user', 'rule')),
  added_by_user_id  uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  added_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (share_link_id, photo_id)
);
CREATE INDEX IF NOT EXISTS shared_photos_photo_id_idx ON public.shared_photos (photo_id);
ALTER TABLE public.shared_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_photos FORCE ROW LEVEL SECURITY;

-- Gate: same baby, approved, live; a rule can never share a sensitive photo (FR-9.5).
CREATE OR REPLACE FUNCTION public.shared_photos_gate() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  link_baby uuid;
  photo public.photos%ROWTYPE;
BEGIN
  SELECT l.baby_id INTO link_baby FROM public.share_links l WHERE l.id = NEW.share_link_id;
  SELECT p.* INTO photo FROM public.photos p WHERE p.id = NEW.photo_id;
  IF link_baby IS NULL OR photo.id IS NULL OR photo.baby_id <> link_baby THEN
    RAISE EXCEPTION 'photo does not belong to the share link''s baby' USING ERRCODE = 'check_violation';
  END IF;
  IF photo.approval <> 'approved' OR photo.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'only approved, non-deleted photos can be shared' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.added_by = 'rule' AND photo.is_sensitive THEN
    RAISE EXCEPTION 'sensitive photos are never auto-shared' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.shared_photos_gate() FROM PUBLIC;
DROP TRIGGER IF EXISTS shared_photos_gate ON public.shared_photos;
CREATE TRIGGER shared_photos_gate BEFORE INSERT OR UPDATE ON public.shared_photos
  FOR EACH ROW EXECUTE FUNCTION public.shared_photos_gate();

-- When a photo becomes sensitive after it was auto-shared (AI flags arriving later, or an admin
-- flagging it), rule-added shares are withdrawn immediately; manual shares stay (admin consent).
CREATE OR REPLACE FUNCTION public.photos_sensitive_unshare_rules() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.is_sensitive AND NOT OLD.is_sensitive THEN
    DELETE FROM public.shared_photos sp WHERE sp.photo_id = NEW.id AND sp.added_by = 'rule';
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photos_sensitive_unshare_rules() FROM PUBLIC;
DROP TRIGGER IF EXISTS photos_sensitive_unshare_rules ON public.photos;
CREATE TRIGGER photos_sensitive_unshare_rules AFTER UPDATE OF is_sensitive ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_sensitive_unshare_rules();

-------------------------------------------------------------------------------------------------
-- viewer_sessions: written by the API (service_role) when a token is exchanged. Hashes only.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.viewer_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  share_link_id    uuid        NOT NULL REFERENCES public.share_links (id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  ip_hash          bytea,
  user_agent_hash  bytea,
  last_seen_at     timestamptz
);
CREATE INDEX IF NOT EXISTS viewer_sessions_share_link_id_created_at_idx
  ON public.viewer_sessions (share_link_id, created_at DESC);
COMMENT ON TABLE public.viewer_sessions IS
  'Viewer cookie sessions. Only hashes of IP / user agent; the viewer role itself cannot read this table.';
ALTER TABLE public.viewer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viewer_sessions FORCE ROW LEVEL SECURITY;

-------------------------------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER; read share_links/shared_photos/babies as the owner).
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_share_link_active(p_share_link_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.share_links l
    JOIN public.babies b ON b.id = l.baby_id
    WHERE l.id = p_share_link_id
      AND l.revoked_at IS NULL
      AND l.expires_at > now()
      AND b.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.share_link_baby(p_share_link_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT l.baby_id FROM public.share_links l WHERE l.id = p_share_link_id
$$;

CREATE OR REPLACE FUNCTION public.viewer_baby_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT public.share_link_baby(public.auth_share_link_id())
  WHERE public.is_share_link_active(public.auth_share_link_id())
$$;

-- A sensitive photo is visible to a viewer only when an admin shared it by hand (FR-9.5): a
-- rule-added row never exposes a photo that is (or later became) sensitive.
CREATE OR REPLACE FUNCTION public.viewer_can_see_photo(p_photo_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT public.auth_share_link_id() IS NOT NULL
     AND public.is_share_link_active(public.auth_share_link_id())
     AND EXISTS (
       SELECT 1
       FROM public.shared_photos sp
       JOIN public.photos p ON p.id = sp.photo_id
       WHERE sp.share_link_id = public.auth_share_link_id()
         AND sp.photo_id = p_photo_id
         AND (NOT p.is_sensitive OR sp.added_by = 'user')
     )
$$;

REVOKE EXECUTE ON FUNCTION public.is_share_link_active(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.share_link_baby(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.viewer_baby_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.viewer_can_see_photo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_share_link_active(uuid) TO authenticated, viewer, pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.share_link_baby(uuid) TO authenticated, viewer, pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.viewer_baby_id() TO viewer, service_role;
GRANT EXECUTE ON FUNCTION public.viewer_can_see_photo(uuid) TO viewer, service_role;

-------------------------------------------------------------------------------------------------
-- Grants and policies on the sharing tables.
-------------------------------------------------------------------------------------------------
GRANT ALL ON public.share_links, public.share_rules, public.shared_photos, public.viewer_sessions TO service_role;

-- share_links: hashes are never readable by user roles ------------------------------------------
GRANT SELECT (id, baby_id, name, expires_at, allow_download, revoked_at, created_by, last_viewed_at,
              view_count, created_at, updated_at) ON public.share_links TO authenticated;
GRANT INSERT (id, baby_id, name, token_hash, passcode_hash, expires_at, allow_download, created_by)
  ON public.share_links TO authenticated;
GRANT UPDATE (name, token_hash, passcode_hash, expires_at, allow_download, revoked_at, updated_at)
  ON public.share_links TO authenticated;
GRANT DELETE ON public.share_links TO authenticated;
GRANT SELECT (id, baby_id, name, expires_at, revoked_at, allow_download) ON public.share_links TO viewer;
GRANT SELECT (id, baby_id, expires_at, revoked_at) ON public.share_links TO pipeline;

DROP POLICY IF EXISTS share_links_authenticated_select ON public.share_links;
CREATE POLICY share_links_authenticated_select ON public.share_links FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS share_links_authenticated_insert ON public.share_links;
CREATE POLICY share_links_authenticated_insert ON public.share_links FOR INSERT TO authenticated
  WITH CHECK (public.is_baby_admin(baby_id) AND created_by = public.auth_uid());
DROP POLICY IF EXISTS share_links_authenticated_update ON public.share_links;
CREATE POLICY share_links_authenticated_update ON public.share_links FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id)) WITH CHECK (public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS share_links_authenticated_delete ON public.share_links;
CREATE POLICY share_links_authenticated_delete ON public.share_links FOR DELETE TO authenticated
  USING (public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS share_links_viewer_select ON public.share_links;
CREATE POLICY share_links_viewer_select ON public.share_links FOR SELECT TO viewer
  USING (id = public.auth_share_link_id() AND public.is_share_link_active(id));
DROP POLICY IF EXISTS share_links_pipeline_select ON public.share_links;
CREATE POLICY share_links_pipeline_select ON public.share_links FOR SELECT TO pipeline USING (true);

-- share_rules -----------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.share_rules TO authenticated;
GRANT SELECT ON public.share_rules TO pipeline;

DROP POLICY IF EXISTS share_rules_authenticated_all ON public.share_rules;
CREATE POLICY share_rules_authenticated_all ON public.share_rules FOR ALL TO authenticated
  USING (public.is_baby_admin(public.share_link_baby(share_link_id)))
  WITH CHECK (public.is_baby_admin(public.share_link_baby(share_link_id)));
DROP POLICY IF EXISTS share_rules_pipeline_select ON public.share_rules;
CREATE POLICY share_rules_pipeline_select ON public.share_rules FOR SELECT TO pipeline USING (true);

-- shared_photos ---------------------------------------------------------------------------------
GRANT SELECT, UPDATE, DELETE ON public.shared_photos TO authenticated;
GRANT INSERT (share_link_id, photo_id, added_by, added_by_user_id) ON public.shared_photos TO authenticated;
GRANT SELECT ON public.shared_photos TO viewer;
GRANT SELECT ON public.shared_photos TO pipeline;
GRANT INSERT (share_link_id, photo_id, added_by) ON public.shared_photos TO pipeline;

DROP POLICY IF EXISTS shared_photos_authenticated_select ON public.shared_photos;
CREATE POLICY shared_photos_authenticated_select ON public.shared_photos FOR SELECT TO authenticated
  USING (public.is_baby_admin(public.share_link_baby(share_link_id)));
DROP POLICY IF EXISTS shared_photos_authenticated_insert ON public.shared_photos;
CREATE POLICY shared_photos_authenticated_insert ON public.shared_photos FOR INSERT TO authenticated
  WITH CHECK (
    public.is_baby_admin(public.share_link_baby(share_link_id))
    AND added_by = 'user' AND added_by_user_id = public.auth_uid()
  );
DROP POLICY IF EXISTS shared_photos_authenticated_update ON public.shared_photos;
CREATE POLICY shared_photos_authenticated_update ON public.shared_photos FOR UPDATE TO authenticated
  USING (public.is_baby_admin(public.share_link_baby(share_link_id)))
  WITH CHECK (public.is_baby_admin(public.share_link_baby(share_link_id)));
DROP POLICY IF EXISTS shared_photos_authenticated_delete ON public.shared_photos;
CREATE POLICY shared_photos_authenticated_delete ON public.shared_photos FOR DELETE TO authenticated
  USING (public.is_baby_admin(public.share_link_baby(share_link_id)));
DROP POLICY IF EXISTS shared_photos_viewer_select ON public.shared_photos;
CREATE POLICY shared_photos_viewer_select ON public.shared_photos FOR SELECT TO viewer
  USING (
    share_link_id = public.auth_share_link_id()
    AND public.is_share_link_active(share_link_id)
    AND public.photo_visible(photo_id)
  );
DROP POLICY IF EXISTS shared_photos_pipeline_select ON public.shared_photos;
CREATE POLICY shared_photos_pipeline_select ON public.shared_photos FOR SELECT TO pipeline USING (true);
DROP POLICY IF EXISTS shared_photos_pipeline_insert ON public.shared_photos;
CREATE POLICY shared_photos_pipeline_insert ON public.shared_photos FOR INSERT TO pipeline
  WITH CHECK (added_by = 'rule' AND added_by_user_id IS NULL);

-- viewer_sessions: admins see their links' sessions (no hashes); the viewer role sees nothing ------
GRANT SELECT (id, share_link_id, created_at, expires_at, last_seen_at) ON public.viewer_sessions TO authenticated;

DROP POLICY IF EXISTS viewer_sessions_authenticated_select ON public.viewer_sessions;
CREATE POLICY viewer_sessions_authenticated_select ON public.viewer_sessions FOR SELECT TO authenticated
  USING (public.is_baby_admin(public.share_link_baby(share_link_id)));

-------------------------------------------------------------------------------------------------
-- Viewer allow-list on earlier tables (the only rows/columns a share-link viewer can ever read).
-------------------------------------------------------------------------------------------------
GRANT SELECT (id, name, nickname, birth_date) ON public.babies TO viewer;
DROP POLICY IF EXISTS babies_viewer_select ON public.babies;
CREATE POLICY babies_viewer_select ON public.babies FOR SELECT TO viewer
  USING (id = public.viewer_baby_id());

GRANT SELECT (id, baby_id, name, category) ON public.milestones TO viewer;
DROP POLICY IF EXISTS milestones_viewer_select ON public.milestones;
CREATE POLICY milestones_viewer_select ON public.milestones FOR SELECT TO viewer
  USING (baby_id IS NULL OR baby_id = public.viewer_baby_id());

-- never storage_key_original, sha256, phash, bytes, uploader, approval state or trash state.
-- is_sensitive is exposed so the share grid can blur manually shared sensitive photos.
GRANT SELECT (id, baby_id, taken_at, taken_at_estimated, age_days, width, height, mime, is_sensitive, created_at)
  ON public.photos TO viewer;
DROP POLICY IF EXISTS photos_viewer_select ON public.photos;
CREATE POLICY photos_viewer_select ON public.photos FOR SELECT TO viewer
  USING (public.viewer_can_see_photo(id) AND deleted_at IS NULL AND approval = 'approved');

GRANT SELECT ON public.photo_derivatives TO viewer;
DROP POLICY IF EXISTS photo_derivatives_viewer_select ON public.photo_derivatives;
CREATE POLICY photo_derivatives_viewer_select ON public.photo_derivatives FOR SELECT TO viewer
  USING (kind IN ('thumb', 'display') AND public.photo_visible(photo_id));

GRANT SELECT (photo_id, milestone_id) ON public.photo_details TO viewer;
DROP POLICY IF EXISTS photo_details_viewer_select ON public.photo_details;
CREATE POLICY photo_details_viewer_select ON public.photo_details FOR SELECT TO viewer
  USING (public.photo_visible(photo_id));

-- Down Migration

DROP TRIGGER IF EXISTS photos_sensitive_unshare_rules ON public.photos;
DROP FUNCTION IF EXISTS public.photos_sensitive_unshare_rules();
DROP POLICY IF EXISTS photo_details_viewer_select ON public.photo_details;
REVOKE ALL ON public.photo_details FROM viewer;
DROP POLICY IF EXISTS photo_derivatives_viewer_select ON public.photo_derivatives;
REVOKE ALL ON public.photo_derivatives FROM viewer;
DROP POLICY IF EXISTS photos_viewer_select ON public.photos;
REVOKE ALL ON public.photos FROM viewer;
DROP POLICY IF EXISTS milestones_viewer_select ON public.milestones;
REVOKE ALL ON public.milestones FROM viewer;
DROP POLICY IF EXISTS babies_viewer_select ON public.babies;
REVOKE ALL ON public.babies FROM viewer;

DROP TABLE IF EXISTS public.viewer_sessions;
DROP TABLE IF EXISTS public.shared_photos;
DROP TABLE IF EXISTS public.share_rules;
DROP TABLE IF EXISTS public.share_links;

DROP FUNCTION IF EXISTS public.shared_photos_gate();
DROP FUNCTION IF EXISTS public.viewer_can_see_photo(uuid);
DROP FUNCTION IF EXISTS public.viewer_baby_id();
DROP FUNCTION IF EXISTS public.share_link_baby(uuid);
DROP FUNCTION IF EXISTS public.is_share_link_active(uuid);
