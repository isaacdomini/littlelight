-- Up Migration

-- Sharing v1 (docs/plans/step-8.md 2.3; PRD "FR-9 Sharing", "Share-link viewers (no account)",
-- "Privacy and child safety", "Security"; user decisions D1 show-once link, D2 30-day maximum,
-- D3 auto-share is Plus-only, D9 viewer downloads are the 1600 px display derivative).
-- What this migration makes a database rule, independent of the API and the worker:
--
-- * Links: tokens stay sha256-only (D1; nothing here can return a plaintext token). Expiry is at
--   most 30 days ahead (`share_links_shape`, D2) and `ttl_hours` (1..720) is what "Renew"
--   re-applies. `passcode_hash` must be a hash string (`scrypt$...`, computed by the API, D7; the
--   step-2 `argon2id$` form is still accepted) so a plaintext 6-digit code can never be stored.
--   At most 20 links per baby (`share_links_cap`).
-- * Lifecycle (`share_links_lifecycle`, every role): a revoked link cannot be renewed and cannot be
--   un-revoked with the same token; only a new token (regenerate) revives it (D13).
--   `token_rotated_at` is maintained here (set whenever `token_hash` changes) and is not writable
--   by any user role, so "regenerate clears the passcode lock" is a database fact.
-- * Sessions end as a database rule (`share_links_end_sessions`): a new token, a new passcode or a
--   revoke marks every open `viewer_sessions` row of the link revoked in the same transaction.
--   `viewer_session_check(jti)` is the per-request check (session not revoked, link active, baby
--   live) and the viewer role's only write path (last seen, visit count, expiry extension).
-- * The sensitive gate (FR-9.5) lives in four places: (1) `shared_photos_gate` locks the photo row
--   FOR SHARE and refuses a `rule` row for a sensitive, unanalysed (no `photo_ai`), excluded or
--   released photo, and any row for a pending, trashed or quarantined photo; (2)
--   `photos_sensitive_unshare_rules` deletes rule rows the moment a photo becomes sensitive and
--   withdraws every earlier "show to family" release; (3) `viewer_can_see_photo` (step 2) never
--   shows a sensitive photo through a rule row; (4) `viewer_can_see_media` keeps the storage keys
--   of a hand-shared sensitive photo unreadable to `viewer` until an admin released it for that
--   link (D4), so the API cannot sign it even by mistake.
-- * Exclusions (`shared_photo_exclusions`): an admin's removal is remembered and the gate refuses a
--   rule row for it, so rules never re-add it.
-- * Auto-share rules are a Plus feature (`share_rules_shape`: `baby_ai_enabled`, D3) and only ever
--   share analysed photos (gate). DELETE of a rule is always allowed (a downgraded baby can remove it).
-- * Passcode failures are persistent (`share_passcode_failures`, service_role only; D8): 5 per
--   (link, IP hash) per 15 min and 20 per link per hour, counted after `token_rotated_at`.
--
-- * Viewer RLS is evaluated once per statement (R4, measured at 10,000 shared photos): the
--   `photos`, `shared_photos`, `photo_details` and `photo_derivatives` viewer policies use the
--   set helpers `viewer_link_id()`, `viewer_photo_ids()`, `viewer_media_photo_ids()` with exactly
--   the visibility of the step-2/4 per-row helpers.
--
-- Grants: `viewer` gains only EXECUTE on `viewer_session_check`, `viewer_can_see_media` and the
-- three set helpers, and loses column access to `shared_photos.added_by_user_id` (and never gets
-- `sensitive_released_by`).
-- `pipeline` gains only DELETE of its own `rule` rows, SELECT on exclusions and UPDATE of
-- `share_rules.evaluated_at`. ENABLE + FORCE RLS on both new tables. Every message below is fixed
-- text: nothing echoes a token, hash, passcode, IP, link name or tag. The down migration restores
-- the step-2 gate, unshare trigger, derivative policy and shared_photos grants/policies, the step-2
-- share_rules updated_at trigger and grants, and the step-5 `share_links_shape`, verbatim.

-------------------------------------------------------------------------------------------------
-- share_links: ttl, rotation time, passcode presence, shape, cap, lifecycle, ending sessions.
-------------------------------------------------------------------------------------------------
ALTER TABLE public.share_links
  ADD COLUMN IF NOT EXISTS ttl_hours        smallint    NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS token_rotated_at timestamptz,
  ADD COLUMN IF NOT EXISTS has_passcode     boolean     NOT NULL GENERATED ALWAYS AS (passcode_hash IS NOT NULL) STORED;
COMMENT ON COLUMN public.share_links.passcode_hash IS
  'scrypt string computed by the API (scrypt$1$N$r$p$salt$dk; optional 6-digit passcode). Never readable by user roles; has_passcode is.';
COMMENT ON COLUMN public.share_links.ttl_hours IS
  'Validity "Renew" re-applies (1..720 h; default 24, PRD). expires_at is at most 30 days ahead (D2).';
COMMENT ON COLUMN public.share_links.token_rotated_at IS
  'Set by share_links_lifecycle whenever token_hash changes (regenerate). Passcode-failure windows count only failures after it.';
COMMENT ON COLUMN public.share_links.view_count IS
  'Visits (FR-9.8): one per exchange and one per viewer session per 30-minute gap (viewer_session_check).';

GRANT SELECT (ttl_hours, has_passcode, token_rotated_at) ON public.share_links TO authenticated;
GRANT INSERT (ttl_hours) ON public.share_links TO authenticated;
GRANT UPDATE (ttl_hours) ON public.share_links TO authenticated;

-- Shape (step-5 trigger, extended): name 1..80, ttl 1..720 h, expiry within 30 days, hash format.
CREATE OR REPLACE FUNCTION public.share_links_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF length(NEW.name) < 1 OR length(NEW.name) > 80 THEN
    RAISE EXCEPTION 'share_links.name must be 1 to 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ttl_hours IS NULL OR NEW.ttl_hours < 1 OR NEW.ttl_hours > 720 THEN
    RAISE EXCEPTION 'share_links.ttl_hours must be 1 to 720' USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.expires_at IS DISTINCT FROM OLD.expires_at)
     AND NEW.expires_at > now() + interval '721 hours' THEN
    RAISE EXCEPTION 'share link expiry must be within 30 days' USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.passcode_hash IS DISTINCT FROM OLD.passcode_hash)
     AND NEW.passcode_hash IS NOT NULL
     AND NOT (NEW.passcode_hash LIKE 'scrypt$%' OR NEW.passcode_hash LIKE 'argon2id$%') THEN
    RAISE EXCEPTION 'share_links.passcode_hash has an unknown format' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.share_links_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS share_links_shape ON public.share_links;
CREATE TRIGGER share_links_shape BEFORE INSERT OR UPDATE OF name, passcode_hash, expires_at, ttl_hours ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.share_links_shape();

-- At most 20 links per baby (SHARE_LINKS_PER_BABY_MAX). The baby row is locked so two concurrent
-- inserts cannot both pass the count. An upsert of an existing id (the demo seed) is not a new link.
CREATE OR REPLACE FUNCTION public.share_links_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  n_links integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.share_links l WHERE l.id = NEW.id) THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.babies b WHERE b.id = NEW.baby_id FOR NO KEY UPDATE;
  SELECT count(*) INTO n_links FROM public.share_links l WHERE l.baby_id = NEW.baby_id;
  IF n_links >= 20 THEN
    RAISE EXCEPTION 'share link limit reached' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.share_links_cap() FROM PUBLIC;
DROP TRIGGER IF EXISTS share_links_cap ON public.share_links;
CREATE TRIGGER share_links_cap BEFORE INSERT ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.share_links_cap();

-- Lifecycle (D13), every role: revocation is never undone for holders of the old token.
CREATE OR REPLACE FUNCTION public.share_links_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    NEW.token_rotated_at := now();
  ELSE
    NEW.token_rotated_at := OLD.token_rotated_at;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    IF NEW.revoked_at IS NULL AND NEW.token_hash = OLD.token_hash THEN
      RAISE EXCEPTION 'a revoked share link can only be reactivated with a new token' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'a revoked share link cannot be renewed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.share_links_lifecycle() FROM PUBLIC;
DROP TRIGGER IF EXISTS share_links_lifecycle ON public.share_links;
CREATE TRIGGER share_links_lifecycle BEFORE UPDATE ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.share_links_lifecycle();

-- A new token, a new (non-NULL) passcode or a revoke ends every open viewer session of the link.
CREATE OR REPLACE FUNCTION public.share_links_end_sessions() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR (NEW.passcode_hash IS NOT NULL AND NEW.passcode_hash IS DISTINCT FROM OLD.passcode_hash)
     OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
    UPDATE public.viewer_sessions vs SET revoked_at = now()
    WHERE vs.share_link_id = NEW.id AND vs.revoked_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.share_links_end_sessions() FROM PUBLIC;

-------------------------------------------------------------------------------------------------
-- viewer_sessions: revocation, active-viewer index, insert guard.
-------------------------------------------------------------------------------------------------
ALTER TABLE public.viewer_sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
COMMENT ON COLUMN public.viewer_sessions.revoked_at IS
  'Set by share_links_end_sessions (new token, new passcode, revoke) or by the API on viewer sign-out. A revoked session never passes viewer_session_check.';
CREATE INDEX IF NOT EXISTS viewer_sessions_share_link_id_live_idx
  ON public.viewer_sessions (share_link_id) WHERE revoked_at IS NULL;
GRANT SELECT (revoked_at) ON public.viewer_sessions TO authenticated;

DROP TRIGGER IF EXISTS share_links_end_sessions ON public.share_links;
CREATE TRIGGER share_links_end_sessions AFTER UPDATE OF token_hash, passcode_hash, revoked_at ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.share_links_end_sessions();

-- A session can only be opened on an active link and never outlives it (every role).
CREATE OR REPLACE FUNCTION public.viewer_sessions_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  link_expires timestamptz;
BEGIN
  SELECT l.expires_at INTO link_expires
  FROM public.share_links l JOIN public.babies b ON b.id = l.baby_id
  WHERE l.id = NEW.share_link_id AND l.revoked_at IS NULL AND l.expires_at > now() AND b.deleted_at IS NULL;
  IF link_expires IS NULL THEN
    RAISE EXCEPTION 'share link is not active' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expires_at > link_expires THEN
    NEW.expires_at := link_expires;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.viewer_sessions_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS viewer_sessions_guard ON public.viewer_sessions;
CREATE TRIGGER viewer_sessions_guard BEFORE INSERT ON public.viewer_sessions
  FOR EACH ROW EXECUTE FUNCTION public.viewer_sessions_guard();

-- viewer_session_check(jti): first statement of every viewer request (docs/plans/step-8.md 2.6).
-- One row iff the claims carry role=viewer + share_link_id, the session belongs to that link and
-- is not revoked, and the link is active (not revoked, not expired, baby not trashed). Side
-- effects, the viewer role's only write path: last_seen_at (at most once a minute), one visit per
-- 30-minute gap (SHARE_VISIT_GAP_MIN; view_count, last_viewed_at), and the session's expiry follows
-- a renewed link. Reads no hash column. Concurrent calls count a visit once (the conditional
-- UPDATE re-checks its WHERE on the newest row version).
CREATE OR REPLACE FUNCTION public.viewer_session_check(p_session_id uuid)
  RETURNS TABLE (share_link_id uuid, baby_id uuid, link_name text, baby_name text, baby_nickname text,
                 expires_at timestamptz, allow_download boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_link uuid := public.auth_share_link_id();
  l record;
BEGIN
  IF v_link IS NULL OR p_session_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public.viewer_sessions vs
  WHERE vs.id = p_session_id AND vs.share_link_id = v_link AND vs.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT sl.id AS link_id, sl.baby_id AS link_baby_id, sl.name AS link_name, b.name AS baby_name,
         b.nickname AS baby_nickname, sl.expires_at AS link_expires_at, sl.allow_download AS link_allow_download
    INTO l
  FROM public.share_links sl
  JOIN public.babies b ON b.id = sl.baby_id
  WHERE sl.id = v_link AND sl.revoked_at IS NULL AND sl.expires_at > now() AND b.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.viewer_sessions vs SET last_seen_at = now()
  WHERE vs.id = p_session_id AND vs.revoked_at IS NULL
    AND (vs.last_seen_at IS NULL OR vs.last_seen_at < now() - interval '30 minutes');
  IF FOUND THEN
    UPDATE public.share_links sl SET view_count = sl.view_count + 1, last_viewed_at = now()
    WHERE sl.id = v_link;
  ELSE
    UPDATE public.viewer_sessions vs SET last_seen_at = now()
    WHERE vs.id = p_session_id AND vs.revoked_at IS NULL AND vs.last_seen_at < now() - interval '1 minute';
  END IF;
  UPDATE public.viewer_sessions vs SET expires_at = l.link_expires_at
  WHERE vs.id = p_session_id AND vs.expires_at < l.link_expires_at;

  RETURN QUERY SELECT l.link_id, l.link_baby_id, l.link_name, l.baby_name, l.baby_nickname,
                      l.link_expires_at, l.link_allow_download;
END
$$;
COMMENT ON FUNCTION public.viewer_session_check(uuid) IS
  'Per-request viewer check: one row (link, baby, names, expiry, allow_download) iff the jti session is live and the link active; else none (API: 410 share_link_expired). Records last seen / visits; extends the session after a renew.';
REVOKE EXECUTE ON FUNCTION public.viewer_session_check(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.viewer_session_check(uuid) TO viewer, service_role;

-------------------------------------------------------------------------------------------------
-- shared_photo_exclusions: "an admin removed this photo from this album; rules must not re-add it".
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shared_photo_exclusions (
  share_link_id  uuid        NOT NULL REFERENCES public.share_links (id) ON DELETE CASCADE,
  photo_id       uuid        NOT NULL REFERENCES public.photos (id) ON DELETE CASCADE,
  excluded_by    uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (share_link_id, photo_id)
);
CREATE INDEX IF NOT EXISTS shared_photo_exclusions_photo_id_idx ON public.shared_photo_exclusions (photo_id);
COMMENT ON TABLE public.shared_photo_exclusions IS
  'Photos an admin removed from a share link. shared_photos_gate refuses a rule row for them, so auto-share never re-adds them. Adding the photo by hand again deletes the exclusion (API).';
ALTER TABLE public.shared_photo_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_photo_exclusions FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.shared_photo_exclusions_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.share_links l JOIN public.photos p ON p.baby_id = l.baby_id
    WHERE l.id = NEW.share_link_id AND p.id = NEW.photo_id
  ) THEN
    RAISE EXCEPTION 'photo does not belong to the share link''s baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.shared_photo_exclusions_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS shared_photo_exclusions_guard ON public.shared_photo_exclusions;
CREATE TRIGGER shared_photo_exclusions_guard BEFORE INSERT OR UPDATE ON public.shared_photo_exclusions
  FOR EACH ROW EXECUTE FUNCTION public.shared_photo_exclusions_guard();

GRANT ALL ON public.shared_photo_exclusions TO service_role;
GRANT SELECT, DELETE ON public.shared_photo_exclusions TO authenticated;
GRANT INSERT (share_link_id, photo_id, excluded_by) ON public.shared_photo_exclusions TO authenticated;
GRANT SELECT ON public.shared_photo_exclusions TO pipeline;

DROP POLICY IF EXISTS shared_photo_exclusions_authenticated_select ON public.shared_photo_exclusions;
CREATE POLICY shared_photo_exclusions_authenticated_select ON public.shared_photo_exclusions FOR SELECT TO authenticated
  USING (public.is_baby_admin(public.share_link_baby(share_link_id)));
DROP POLICY IF EXISTS shared_photo_exclusions_authenticated_insert ON public.shared_photo_exclusions;
CREATE POLICY shared_photo_exclusions_authenticated_insert ON public.shared_photo_exclusions FOR INSERT TO authenticated
  WITH CHECK (public.is_baby_admin(public.share_link_baby(share_link_id)) AND excluded_by = public.auth_uid());
DROP POLICY IF EXISTS shared_photo_exclusions_authenticated_delete ON public.shared_photo_exclusions;
CREATE POLICY shared_photo_exclusions_authenticated_delete ON public.shared_photo_exclusions FOR DELETE TO authenticated
  USING (public.is_baby_admin(public.share_link_baby(share_link_id)));
DROP POLICY IF EXISTS shared_photo_exclusions_pipeline_select ON public.shared_photo_exclusions;
CREATE POLICY shared_photo_exclusions_pipeline_select ON public.shared_photo_exclusions FOR SELECT TO pipeline
  USING (true);

-------------------------------------------------------------------------------------------------
-- shared_photos: "show to family" release (D4), narrowed grants, pipeline rule-row deletes, gate.
-------------------------------------------------------------------------------------------------
ALTER TABLE public.shared_photos
  ADD COLUMN IF NOT EXISTS sensitive_released_at timestamptz,
  ADD COLUMN IF NOT EXISTS sensitive_released_by uuid REFERENCES public.profiles (user_id) ON DELETE SET NULL;
COMMENT ON COLUMN public.shared_photos.sensitive_released_at IS
  'An admin explicitly chose "Show to family" for this sensitive photo on this link (D4). NULL = viewers get a hidden tile and cannot read its derivatives. Cleared whenever the photo is (re)flagged sensitive; meaningless (forced NULL) for a non-sensitive photo; never on a rule row.';
CREATE INDEX IF NOT EXISTS shared_photos_share_link_id_added_at_idx
  ON public.shared_photos (share_link_id, added_at DESC);

-- authenticated: INSERT gains the release pair; UPDATE narrowed to attribution + release.
GRANT INSERT (sensitive_released_at, sensitive_released_by) ON public.shared_photos TO authenticated;
REVOKE UPDATE ON public.shared_photos FROM authenticated;
GRANT UPDATE (added_by, added_by_user_id, sensitive_released_at, sensitive_released_by) ON public.shared_photos TO authenticated;
-- viewer: no parent user ids (added_by_user_id, sensitive_released_by).
REVOKE SELECT ON public.shared_photos FROM viewer;
GRANT SELECT (share_link_id, photo_id, added_by, added_at, sensitive_released_at) ON public.shared_photos TO viewer;
-- pipeline: rule sync may remove only its own rows.
GRANT DELETE ON public.shared_photos TO pipeline;

DROP POLICY IF EXISTS shared_photos_authenticated_insert ON public.shared_photos;
CREATE POLICY shared_photos_authenticated_insert ON public.shared_photos FOR INSERT TO authenticated
  WITH CHECK (
    public.is_baby_admin(public.share_link_baby(share_link_id))
    AND added_by = 'user' AND added_by_user_id = public.auth_uid()
  );
DROP POLICY IF EXISTS shared_photos_authenticated_update ON public.shared_photos;
CREATE POLICY shared_photos_authenticated_update ON public.shared_photos FOR UPDATE TO authenticated
  USING (public.is_baby_admin(public.share_link_baby(share_link_id)))
  WITH CHECK (
    public.is_baby_admin(public.share_link_baby(share_link_id))
    AND added_by = 'user' AND added_by_user_id = public.auth_uid()
  );
DROP POLICY IF EXISTS shared_photos_pipeline_delete ON public.shared_photos;
CREATE POLICY shared_photos_pipeline_delete ON public.shared_photos FOR DELETE TO pipeline
  USING (added_by = 'rule');

-- Gate (step 2, hardened). The photo row is locked FOR SHARE, which conflicts with the row lock of
-- a concurrent `UPDATE photos SET is_sensitive = true`: whichever transaction commits second sees
-- the other, so a rule row and a sensitive flag can never both survive (R5). For every row: same
-- baby, approved, not trashed, not quarantined (one message for all three, so quarantine is not
-- disclosed). For `rule` rows also: not sensitive, analysed (a `photo_ai` row: free-tier photos are
-- never analysed, D3), not excluded by an admin, never released. The release pair is normalised:
-- no "released by" without "released at", no release on a non-sensitive photo, and a user-role
-- release must name the releasing admin. A write that only withdraws a release or re-attributes
-- a row (link, photo and added_by unchanged, no release) exposes nothing and is not re-gated, so
-- the unshare trigger can clear releases on trashed photos too.
CREATE OR REPLACE FUNCTION public.shared_photos_gate() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  link_baby uuid;
  photo record;
BEGIN
  IF NEW.sensitive_released_at IS NULL THEN
    NEW.sensitive_released_by := NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.share_link_id = OLD.share_link_id AND NEW.photo_id = OLD.photo_id
     AND NEW.added_by = OLD.added_by AND NEW.sensitive_released_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT l.baby_id INTO link_baby FROM public.share_links l WHERE l.id = NEW.share_link_id;
  SELECT p.id, p.baby_id, p.approval, p.deleted_at, p.quarantined_at, p.is_sensitive INTO photo
  FROM public.photos p WHERE p.id = NEW.photo_id
  FOR SHARE;
  IF link_baby IS NULL OR photo.id IS NULL OR photo.baby_id <> link_baby THEN
    RAISE EXCEPTION 'photo does not belong to the share link''s baby' USING ERRCODE = 'check_violation';
  END IF;
  IF photo.approval <> 'approved' OR photo.deleted_at IS NOT NULL OR photo.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'only approved, non-deleted photos can be shared' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.added_by = 'rule' THEN
    IF photo.is_sensitive THEN
      RAISE EXCEPTION 'sensitive photos are never auto-shared' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.photo_ai a WHERE a.photo_id = NEW.photo_id) THEN
      RAISE EXCEPTION 'only analysed photos can be auto-shared' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.shared_photo_exclusions x
      WHERE x.share_link_id = NEW.share_link_id AND x.photo_id = NEW.photo_id
    ) THEN
      RAISE EXCEPTION 'photo was removed from this album by an admin' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.sensitive_released_at IS NOT NULL THEN
      RAISE EXCEPTION 'only hand-picked photos can be shown to family' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT photo.is_sensitive THEN
    NEW.sensitive_released_at := NULL;
    NEW.sensitive_released_by := NULL;
  ELSIF NEW.sensitive_released_at IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.sensitive_released_at IS DISTINCT FROM OLD.sensitive_released_at
             OR NEW.sensitive_released_by IS DISTINCT FROM OLD.sensitive_released_by)
        AND current_setting('role', true) = 'authenticated'
        AND NEW.sensitive_released_by IS DISTINCT FROM public.auth_uid() THEN
    RAISE EXCEPTION 'a sensitive photo can only be shown by the admin releasing it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.shared_photos_gate() FROM PUBLIC;
DROP TRIGGER IF EXISTS shared_photos_gate ON public.shared_photos;
CREATE TRIGGER shared_photos_gate BEFORE INSERT OR UPDATE ON public.shared_photos
  FOR EACH ROW EXECUTE FUNCTION public.shared_photos_gate();

-- A photo that becomes sensitive loses its rule shares at once (step 2, kept) and every earlier
-- "show to family" release (an explicit release always refers to the flagged photo).
CREATE OR REPLACE FUNCTION public.photos_sensitive_unshare_rules() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.is_sensitive AND NOT OLD.is_sensitive THEN
    DELETE FROM public.shared_photos sp WHERE sp.photo_id = NEW.id AND sp.added_by = 'rule';
    UPDATE public.shared_photos sp SET sensitive_released_at = NULL, sensitive_released_by = NULL
    WHERE sp.photo_id = NEW.id AND sp.sensitive_released_at IS NOT NULL;
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photos_sensitive_unshare_rules() FROM PUBLIC;

-------------------------------------------------------------------------------------------------
-- Viewer visibility, once per statement (plan R4, measured). The step-2/4 viewer policies called
-- SECURITY DEFINER helpers per candidate row (`viewer_can_see_photo`, `is_share_link_active`,
-- `photo_visible` -> the photos policy again): at 10,000 shared photos the viewer's album count
-- took 3.4 s and a sparsely shared link walked every photo of the baby through them. The set
-- helpers below compute the viewer's link and photo ids once per statement; the policies use the
-- `col IN (SELECT f())` form (a hashed SubPlan: one build, O(1) probe per row). Not the step-7
-- `= ANY (ARRAY(...))` form: with thousands of ids that array is not hashed (Postgres hashes
-- `= ANY` only for constant arrays), so it would be a linear scan per row. Measured as `viewer`
-- at 10,000 shared photos: first page of 101 rows 34 ms (was 35 ms), keyset page near the end
-- 18 ms, album counts 20 ms (was 3,436 ms), thumbs for a page 8 ms (was 12 ms).
-- Semantics are identical to the per-row helpers (proved by the RLS matrix tests):
--   viewer_link_id()         = auth_share_link_id() when that link is active (not revoked, not
--                              expired, baby not trashed); else NULL.
--   viewer_photo_ids()       = viewer_can_see_photo() + the photos policy's live conditions:
--                              rows of that link whose photo is approved, not trashed, not
--                              quarantined and not (sensitive AND added by a rule).
--   viewer_media_photo_ids() = viewer_can_see_media(): as above, and a sensitive photo only when
--                              hand-added AND released ("show to family") for this link (D4).
-- `viewer_can_see_photo` / `viewer_can_see_media` stay for single-photo checks.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.viewer_link_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT l.id
  FROM public.share_links l
  JOIN public.babies b ON b.id = l.baby_id
  WHERE l.id = public.auth_share_link_id()
    AND l.revoked_at IS NULL
    AND l.expires_at > now()
    AND b.deleted_at IS NULL
$$;
COMMENT ON FUNCTION public.viewer_link_id() IS
  'The viewer''s share link id when the claims carry role=viewer and the link is active; else NULL.';

CREATE OR REPLACE FUNCTION public.viewer_photo_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT sp.photo_id
  FROM public.shared_photos sp
  JOIN public.photos p ON p.id = sp.photo_id
  WHERE sp.share_link_id = (SELECT public.viewer_link_id())
    AND p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
    AND (NOT p.is_sensitive OR sp.added_by = 'user')
$$;
COMMENT ON FUNCTION public.viewer_photo_ids() IS
  'Photo ids the viewer may list (hidden sensitive tiles included): set form of viewer_can_see_photo + the photos policy, for once-per-statement RLS. Empty without an active viewer link.';

CREATE OR REPLACE FUNCTION public.viewer_media_photo_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT sp.photo_id
  FROM public.shared_photos sp
  JOIN public.photos p ON p.id = sp.photo_id
  WHERE sp.share_link_id = (SELECT public.viewer_link_id())
    AND p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
    AND (NOT p.is_sensitive OR (sp.added_by = 'user' AND sp.sensitive_released_at IS NOT NULL))
$$;
COMMENT ON FUNCTION public.viewer_media_photo_ids() IS
  'Photo ids whose thumb/display keys the viewer may read: set form of viewer_can_see_media. A hidden (sensitive, not released) photo is never in it.';

REVOKE EXECUTE ON FUNCTION public.viewer_link_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.viewer_photo_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.viewer_media_photo_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.viewer_link_id() TO viewer, service_role;
GRANT EXECUTE ON FUNCTION public.viewer_photo_ids() TO viewer, service_role;
GRANT EXECUTE ON FUNCTION public.viewer_media_photo_ids() TO viewer, service_role;

DROP POLICY IF EXISTS photos_viewer_select ON public.photos;
CREATE POLICY photos_viewer_select ON public.photos FOR SELECT TO viewer
  USING (
    quarantined_at IS NULL AND deleted_at IS NULL AND approval = 'approved'
    AND id IN (SELECT public.viewer_photo_ids())
  );
DROP POLICY IF EXISTS shared_photos_viewer_select ON public.shared_photos;
CREATE POLICY shared_photos_viewer_select ON public.shared_photos FOR SELECT TO viewer
  USING (
    share_link_id = (SELECT public.viewer_link_id())
    AND photo_id IN (SELECT public.viewer_photo_ids())
  );
DROP POLICY IF EXISTS photo_details_viewer_select ON public.photo_details;
CREATE POLICY photo_details_viewer_select ON public.photo_details FOR SELECT TO viewer
  USING (photo_id IN (SELECT public.viewer_photo_ids()));

-------------------------------------------------------------------------------------------------
-- viewer_can_see_media: may the viewer read this photo's thumb/display storage keys?
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.viewer_can_see_media(p_photo_id uuid) RETURNS boolean
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
         AND p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
         AND (NOT p.is_sensitive OR (sp.added_by = 'user' AND sp.sensitive_released_at IS NOT NULL))
     )
$$;
COMMENT ON FUNCTION public.viewer_can_see_media(uuid) IS
  'Viewer may read the thumb/display keys: the photo is visible on the active link and is not sensitive, or an admin released it for this link (D4). A hidden photo''s keys are unreadable.';
REVOKE EXECUTE ON FUNCTION public.viewer_can_see_media(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.viewer_can_see_media(uuid) TO viewer, service_role;

DROP POLICY IF EXISTS photo_derivatives_viewer_select ON public.photo_derivatives;
CREATE POLICY photo_derivatives_viewer_select ON public.photo_derivatives FOR SELECT TO viewer
  USING (kind IN ('thumb', 'display') AND photo_id IN (SELECT public.viewer_media_photo_ids()));

-------------------------------------------------------------------------------------------------
-- share_rules: evaluation watermark, narrowed user grants, shape + paid-plan rule (D3).
-------------------------------------------------------------------------------------------------
ALTER TABLE public.share_rules ADD COLUMN IF NOT EXISTS evaluated_at timestamptz;
COMMENT ON COLUMN public.share_rules.evaluated_at IS
  'Start time of the last full sync by the worker (share.apply / share.reconcile). Written by pipeline only; does not move updated_at.';

-- updated_at means "the rule changed": the worker's evaluated_at write must not move it.
DROP TRIGGER IF EXISTS share_rules_set_updated_at ON public.share_rules;
CREATE TRIGGER share_rules_set_updated_at BEFORE UPDATE OF mode, include_tags, exclude_tags ON public.share_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE INSERT, UPDATE ON public.share_rules FROM authenticated;
GRANT INSERT (share_link_id, mode, include_tags, exclude_tags) ON public.share_rules TO authenticated;
GRANT UPDATE (mode, include_tags, exclude_tags) ON public.share_rules TO authenticated;
GRANT UPDATE (evaluated_at) ON public.share_rules TO pipeline;
DROP POLICY IF EXISTS share_rules_pipeline_update ON public.share_rules;
CREATE POLICY share_rules_pipeline_update ON public.share_rules FOR UPDATE TO pipeline
  USING (true) WITH CHECK (true);

-- Tags arrive normalised by @tinyglow/shared normalizeShareTag (NFC, trimmed, single inner
-- spaces, lower-case); this is the backstop. Every role, including the seed.
CREATE OR REPLACE FUNCTION public.share_rules_shape() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.include_tags IS NULL OR NEW.exclude_tags IS NULL
     OR cardinality(NEW.include_tags) > 20 OR cardinality(NEW.exclude_tags) > 20
     OR coalesce(array_ndims(NEW.include_tags), 1) <> 1 OR coalesce(array_ndims(NEW.exclude_tags), 1) <> 1 THEN
    RAISE EXCEPTION 'share_rules tags hold at most 20 entries per list' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.include_tags || NEW.exclude_tags) AS t(tag)
    WHERE t.tag IS NULL
       OR length(t.tag) < 1 OR length(t.tag) > 60
       OR t.tag <> lower(t.tag)
       OR t.tag ~ '^[[:space:]]|[[:space:]]$|[[:space:]][[:space:]]|[[:cntrl:]]'
       OR t.tag IS NOT NFC NORMALIZED
  ) THEN
    RAISE EXCEPTION 'share_rules tags must be 1 to 60 characters, trimmed and lower-case' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.mode = 'tags' AND cardinality(NEW.include_tags) = 0 THEN
    RAISE EXCEPTION 'share rule needs at least one include tag' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.baby_ai_enabled(public.share_link_baby(NEW.share_link_id)) THEN
    RAISE EXCEPTION 'auto-share rules need the paid plan' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.share_rules_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS share_rules_shape ON public.share_rules;
CREATE TRIGGER share_rules_shape BEFORE INSERT OR UPDATE OF share_link_id, mode, include_tags, exclude_tags ON public.share_rules
  FOR EACH ROW EXECUTE FUNCTION public.share_rules_shape();

-------------------------------------------------------------------------------------------------
-- share_passcode_failures: persistent passcode failure ledger (D8). service_role only.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.share_passcode_failures (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  share_link_id  uuid        NOT NULL REFERENCES public.share_links (id) ON DELETE CASCADE,
  ip_hash        bytea       NOT NULL CHECK (octet_length(ip_hash) = 32),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS share_passcode_failures_link_ip_created_idx
  ON public.share_passcode_failures (share_link_id, ip_hash, created_at);
CREATE INDEX IF NOT EXISTS share_passcode_failures_link_created_idx
  ON public.share_passcode_failures (share_link_id, created_at);
COMMENT ON TABLE public.share_passcode_failures IS
  'One row per wrong passcode at the token exchange (keyed HMAC of the IP, never the IP). Limits: 5 per (link, ip_hash) per 15 min, 20 per link per 60 min, counted after share_links.token_rotated_at. service_role only; the API prunes rows older than 24 h.';
ALTER TABLE public.share_passcode_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_passcode_failures FORCE ROW LEVEL SECURITY;
GRANT ALL ON public.share_passcode_failures TO service_role;

-- Exchange helper (service_role): serialises passcode attempts per link for the rest of the
-- transaction (advisory lock), then returns the failure counts in both windows and, when a limit
-- is reached, when it lifts. The API checks both limits BEFORE verifying a passcode, inserts a
-- failure row on a wrong one, and commits.
CREATE OR REPLACE FUNCTION public.share_passcode_lock_state(p_share_link_id uuid, p_ip_hash bytea)
  RETURNS TABLE (ip_failures integer, ip_retry_at timestamptz, link_failures integer, link_retry_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_since timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('share.passcode'), hashtext(p_share_link_id::text));
  SELECT COALESCE(l.token_rotated_at, '-infinity'::timestamptz) INTO v_since
  FROM public.share_links l WHERE l.id = p_share_link_id;
  IF v_since IS NULL THEN
    v_since := '-infinity'::timestamptz;
  END IF;
  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM public.share_passcode_failures f
      WHERE f.share_link_id = p_share_link_id AND f.ip_hash = p_ip_hash
        AND f.created_at > GREATEST(now() - interval '15 minutes', v_since)),
    (SELECT f.created_at + interval '15 minutes' FROM public.share_passcode_failures f
      WHERE f.share_link_id = p_share_link_id AND f.ip_hash = p_ip_hash
        AND f.created_at > GREATEST(now() - interval '15 minutes', v_since)
      ORDER BY f.created_at DESC OFFSET 4 LIMIT 1),
    (SELECT count(*)::integer FROM public.share_passcode_failures f
      WHERE f.share_link_id = p_share_link_id
        AND f.created_at > GREATEST(now() - interval '60 minutes', v_since)),
    (SELECT f.created_at + interval '60 minutes' FROM public.share_passcode_failures f
      WHERE f.share_link_id = p_share_link_id
        AND f.created_at > GREATEST(now() - interval '60 minutes', v_since)
      ORDER BY f.created_at DESC OFFSET 19 LIMIT 1);
END
$$;
COMMENT ON FUNCTION public.share_passcode_lock_state(uuid, bytea) IS
  'Token exchange (service_role): locks the link''s passcode attempts for this transaction and returns failures per (link, ip_hash) in 15 min and per link in 60 min (after token_rotated_at), with the time each limit (5 / 20) lifts, NULL below it.';
REVOKE EXECUTE ON FUNCTION public.share_passcode_lock_state(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.share_passcode_lock_state(uuid, bytea) TO service_role;

-- Admin card "Passcode locked" (FR-9.8 / D8): false unless the caller administers the link's baby
-- (or is service_role); true when the link has >= 20 failures in the last hour after rotation.
CREATE OR REPLACE FUNCTION public.share_link_passcode_locked(p_share_link_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((
    SELECT count(f.id) >= 20
    FROM public.share_links l
    JOIN public.share_passcode_failures f ON f.share_link_id = l.id
    WHERE l.id = p_share_link_id
      AND (current_setting('role', true) = 'service_role' OR public.is_baby_admin(l.baby_id))
      AND f.created_at > now() - interval '60 minutes'
      AND f.created_at > COALESCE(l.token_rotated_at, '-infinity'::timestamptz)
  ), false)
$$;
REVOKE EXECUTE ON FUNCTION public.share_link_passcode_locked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.share_link_passcode_locked(uuid) TO authenticated, service_role;

-- Down Migration

DROP FUNCTION IF EXISTS public.share_link_passcode_locked(uuid);
DROP FUNCTION IF EXISTS public.share_passcode_lock_state(uuid, bytea);
DROP TABLE IF EXISTS public.share_passcode_failures;

-- share_rules: restore the step-2 trigger and grants.
DROP TRIGGER IF EXISTS share_rules_shape ON public.share_rules;
DROP FUNCTION IF EXISTS public.share_rules_shape();
DROP POLICY IF EXISTS share_rules_pipeline_update ON public.share_rules;
REVOKE UPDATE ON public.share_rules FROM pipeline;
REVOKE INSERT, UPDATE ON public.share_rules FROM authenticated;
GRANT INSERT, UPDATE ON public.share_rules TO authenticated;
DROP TRIGGER IF EXISTS share_rules_set_updated_at ON public.share_rules;
CREATE TRIGGER share_rules_set_updated_at BEFORE UPDATE ON public.share_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.share_rules DROP COLUMN IF EXISTS evaluated_at;

-- Viewer policies: the step-2 bodies (photos: the step-4 body), then drop the set helpers.
DROP POLICY IF EXISTS photo_derivatives_viewer_select ON public.photo_derivatives;
CREATE POLICY photo_derivatives_viewer_select ON public.photo_derivatives FOR SELECT TO viewer
  USING (kind IN ('thumb', 'display') AND public.photo_visible(photo_id));
DROP FUNCTION IF EXISTS public.viewer_can_see_media(uuid);
DROP POLICY IF EXISTS photo_details_viewer_select ON public.photo_details;
CREATE POLICY photo_details_viewer_select ON public.photo_details FOR SELECT TO viewer
  USING (public.photo_visible(photo_id));
DROP POLICY IF EXISTS shared_photos_viewer_select ON public.shared_photos;
CREATE POLICY shared_photos_viewer_select ON public.shared_photos FOR SELECT TO viewer
  USING (
    share_link_id = public.auth_share_link_id()
    AND public.is_share_link_active(share_link_id)
    AND public.photo_visible(photo_id)
  );
DROP POLICY IF EXISTS photos_viewer_select ON public.photos;
CREATE POLICY photos_viewer_select ON public.photos FOR SELECT TO viewer
  USING (
    quarantined_at IS NULL
    AND public.viewer_can_see_photo(id) AND deleted_at IS NULL AND approval = 'approved'
  );
DROP FUNCTION IF EXISTS public.viewer_media_photo_ids();
DROP FUNCTION IF EXISTS public.viewer_photo_ids();
DROP FUNCTION IF EXISTS public.viewer_link_id();

-- photos_sensitive_unshare_rules: the step-2 body.
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

-- shared_photos_gate: the step-2 body.
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

-- shared_photos: the step-2 grants and policies.
DROP POLICY IF EXISTS shared_photos_pipeline_delete ON public.shared_photos;
REVOKE DELETE ON public.shared_photos FROM pipeline;
DROP POLICY IF EXISTS shared_photos_authenticated_update ON public.shared_photos;
CREATE POLICY shared_photos_authenticated_update ON public.shared_photos FOR UPDATE TO authenticated
  USING (public.is_baby_admin(public.share_link_baby(share_link_id)))
  WITH CHECK (public.is_baby_admin(public.share_link_baby(share_link_id)));
DROP POLICY IF EXISTS shared_photos_authenticated_insert ON public.shared_photos;
CREATE POLICY shared_photos_authenticated_insert ON public.shared_photos FOR INSERT TO authenticated
  WITH CHECK (
    public.is_baby_admin(public.share_link_baby(share_link_id))
    AND added_by = 'user' AND added_by_user_id = public.auth_uid()
  );
DROP INDEX IF EXISTS public.shared_photos_share_link_id_added_at_idx;
ALTER TABLE public.shared_photos DROP COLUMN IF EXISTS sensitive_released_by;
ALTER TABLE public.shared_photos DROP COLUMN IF EXISTS sensitive_released_at;
REVOKE SELECT ON public.shared_photos FROM viewer;
GRANT SELECT ON public.shared_photos TO viewer;
REVOKE UPDATE ON public.shared_photos FROM authenticated;
GRANT UPDATE ON public.shared_photos TO authenticated;

DROP TABLE IF EXISTS public.shared_photo_exclusions;
DROP FUNCTION IF EXISTS public.shared_photo_exclusions_guard();

-- viewer_sessions
DROP FUNCTION IF EXISTS public.viewer_session_check(uuid);
DROP TRIGGER IF EXISTS viewer_sessions_guard ON public.viewer_sessions;
DROP FUNCTION IF EXISTS public.viewer_sessions_guard();
DROP TRIGGER IF EXISTS share_links_end_sessions ON public.share_links;
DROP FUNCTION IF EXISTS public.share_links_end_sessions();
DROP INDEX IF EXISTS public.viewer_sessions_share_link_id_live_idx;
ALTER TABLE public.viewer_sessions DROP COLUMN IF EXISTS revoked_at;

-- share_links: lifecycle, cap, the step-5 shape trigger, columns, comments.
DROP TRIGGER IF EXISTS share_links_lifecycle ON public.share_links;
DROP FUNCTION IF EXISTS public.share_links_lifecycle();
DROP TRIGGER IF EXISTS share_links_cap ON public.share_links;
DROP FUNCTION IF EXISTS public.share_links_cap();
CREATE OR REPLACE FUNCTION public.share_links_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF length(NEW.name) < 1 OR length(NEW.name) > 80 THEN
    RAISE EXCEPTION 'share_links.name must be 1 to 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.share_links_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS share_links_shape ON public.share_links;
CREATE TRIGGER share_links_shape BEFORE INSERT OR UPDATE OF name ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.share_links_shape();
ALTER TABLE public.share_links DROP COLUMN IF EXISTS has_passcode;
ALTER TABLE public.share_links DROP COLUMN IF EXISTS token_rotated_at;
ALTER TABLE public.share_links DROP COLUMN IF EXISTS ttl_hours;
COMMENT ON COLUMN public.share_links.view_count IS NULL;
COMMENT ON COLUMN public.share_links.passcode_hash IS
  'argon2id string computed by the API (optional 6-digit passcode). Never readable by user roles.';
