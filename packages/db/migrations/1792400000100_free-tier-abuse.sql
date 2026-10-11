-- Up Migration

-- Free-tier abuse safeguards, family model (docs/plans/step-11.md, amended 2026-10-11: section 2.2
-- A-G, task 11.2b; decisions D-A..D-I). PRD FR-5.8 ("The free tier (up to 1,000 photos)"),
-- "Accounts and authentication", "Invites", "Roles and permissions", FR-2.7, "Account deletion and
-- recovery" (FR-10.3), "Non-functional requirements -> Privacy and child safety / Security".
--
-- Rules enforced here, not in the API, the worker or the UI:
-- * Families (D-A). Every album belongs to exactly one `families` row (`babies.family_id`, NOT
--   NULL, trigger-maintained; no user role can write it). A new album joins its creator's family,
--   or starts one. An account is a parent (admin) in at most one family (`baby_members_one_family`,
--   race-free under advisory lock class 1012). Starting a family is refused when another live
--   account with the same canonical address is already a parent (D-B, lock class 1013). The
--   family survives parents leaving, being removed or deleted; it is dropped when its last album
--   is hard-deleted (purge).
-- * The 1,000-photo free pool is per family and counts APPROVED photos only, across the family's
--   free, live albums (`photos_free_tier_cap`, lock class 1011): checked on insert, on approval
--   and on restore. Prefix `free tier photo limit reached` unchanged (every caller maps it).
-- * Pending photos are capped per uploader per family (`photos_pending_cap`, lock class 1014;
--   default 200, GUC `app.pending_photo_limit`; every plan, D-C, D-D). Prefix `pending photo limit
--   reached`.
-- * Canonical email: a lookup (plain index), no longer unique. Invites match exactly or by
--   canonical form.
-- * `family_starts` ledger: one row per family start; HMAC'd IP only (never an IP, an email or a
--   user agent); ENABLE + FORCE RLS; service_role S/I/D only; 30-day retention.
-- * Suspension: `profiles.suspended_at/suspended_reason`, `auth_session_info().suspended`.
-- * `pending_limit` joins the error vocabularies of `upload_files`, `import_sources` and
--   `import_items`, and is an outcome of `import_book_photo()`.
-- * Every RAISE uses a fixed message naming no value (no email, IP, id or count of a row).

DO $guard$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'auth.users is missing: start the auth (GoTrue) service before running migrations';
  END IF;
  IF to_regclass('auth.sessions') IS NULL THEN
    RAISE EXCEPTION 'auth.sessions is missing: start the auth (GoTrue) service before running migrations';
  END IF;
END
$guard$;

-------------------------------------------------------------------------------------------------
-- F (columns). Suspension: added first because the helpers below read them.
-------------------------------------------------------------------------------------------------
-- No INSERT/UPDATE grant for any user role (authenticated's grants on profiles are column
-- lists); written by the operator tool (superuser) only. authenticated keeps table-level SELECT
-- under the self-only policy, so a user can see their own suspended_at.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason text CHECK (suspended_reason IN ('abuse', 'other'));
COMMENT ON COLUMN public.profiles.suspended_at IS
  'Set by pnpm admin:suspend (operator). Every request answers 403 account_suspended while set (auth_session_info.suspended).';

-------------------------------------------------------------------------------------------------
-- D. Canonical email (a lookup; uniqueness is not a rule). Added before the families section:
-- babies_set_family reads profiles.email_canonical.
--
-- Mirror of canonicalEmail() in @tinyglow/shared, step by step (CANONICAL_EMAIL_FIXTURES are the
-- parity test):
--   s := lower(trim(NFC(p_email)))   trim = the JS String.prototype.trim set (ECMAScript
--                                    WhiteSpace + LineTerminator: TAB VT FF SP NBSP ZWNBSP, Zs,
--                                    LF CR LS PS); lower = Unicode simple lowercase (builtin
--                                    pg_c_utf8: stable, independent of the server locale). Known
--                                    divergence from JS toLowerCase (full mapping): U+0130 and a
--                                    word-final capital sigma only.
--   no '@' -> return s
--   local := before the LAST '@'; domain := after it, every trailing '.' removed
--   domain 'googlemail.com' -> 'gmail.com' (after the trailing dots are removed)
--   local := part before the first '+', unless that is '' (a leading '+': local kept as is)
--   domain 'gmail.com' -> every '.' removed from local (no empty guard, as in TS)
--   return local || '@' || domain
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_canonical(p_email text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, public
AS $$
DECLARE
  s text;
  rev_at integer;
  v_local text;
  v_domain text;
  v_part text;
BEGIN
  s := lower(btrim(normalize(p_email, NFC),
                   E' \t\n\r\f\u000b ﻿                　')
             COLLATE "pg_c_utf8");
  rev_at := strpos(reverse(s), '@');
  IF rev_at = 0 THEN
    RETURN s;
  END IF;
  v_local := left(s, length(s) - rev_at);
  v_domain := rtrim(right(s, rev_at - 1), '.');
  IF v_domain = 'googlemail.com' THEN
    v_domain := 'gmail.com';
  END IF;
  v_part := split_part(v_local, '+', 1);
  IF v_part <> '' THEN
    v_local := v_part;
  END IF;
  IF v_domain = 'gmail.com' THEN
    -- No empty guard here (parity: '.@gmail.com' -> '@gmail.com', like the TS twin).
    v_local := replace(v_local, '.', '');
  END IF;
  RETURN v_local || '@' || v_domain;
END
$$;
COMMENT ON FUNCTION public.email_canonical(text) IS
  'Canonical mailbox of an address (D6): NFC, trimmed, lowercase; +tag stripped for every domain; googlemail.com -> gmail.com and dots folded for gmail.com. Mirror of canonicalEmail() in @tinyglow/shared.';
REVOKE EXECUTE ON FUNCTION public.email_canonical(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.email_canonical(text) TO authenticated, service_role;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email_canonical text;
COMMENT ON COLUMN public.profiles.email_canonical IS
  'email_canonical(auth.users.email), set on insert by trigger. Not unique: two accounts may share an inbox; only starting a family is arbitrated (babies_set_family). NULL = no auth.users row or no email.';

DO $backfill$
DECLARE
  n_set integer;
BEGIN
  UPDATE public.profiles p
     SET email_canonical = NULLIF(public.email_canonical(u.email), '')
    FROM auth.users u
   WHERE u.id = p.user_id
     AND p.email_canonical IS NULL
     AND u.email IS NOT NULL;
  GET DIAGNOSTICS n_set = ROW_COUNT;
  RAISE NOTICE 'email_canonical backfill: % profiles set', n_set;
END
$backfill$;

CREATE INDEX IF NOT EXISTS profiles_email_canonical_idx
  ON public.profiles (email_canonical) WHERE email_canonical IS NOT NULL;

-- Filled from auth.users on every insert, whatever the inserter passed (no user role has a
-- grant on the column anyway). NULL when there is no auth.users row or no email (fixtures).
CREATE OR REPLACE FUNCTION public.profiles_set_email_canonical() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.email_canonical := NULLIF(
    public.email_canonical((SELECT u.email::text FROM auth.users u WHERE u.id = NEW.user_id)), '');
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.profiles_set_email_canonical() FROM PUBLIC;
DROP TRIGGER IF EXISTS profiles_set_email_canonical ON public.profiles;
CREATE TRIGGER profiles_set_email_canonical BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_set_email_canonical();

-- Canonical lookups of live invites.
CREATE INDEX IF NOT EXISTS invites_email_canonical_live_idx
  ON public.invites (public.email_canonical(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- An invite to mom+baby@gmail.com can be accepted by the account mom@gmail.com. Otherwise
-- unchanged.
CREATE OR REPLACE FUNCTION public.invite_allows_join(p_baby_id uuid, p_role text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT public.auth_email() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.invites i
    WHERE i.baby_id = p_baby_id
      AND (i.email = public.auth_email()
           OR public.email_canonical(i.email) = public.email_canonical(public.auth_email()))
      AND i.role = p_role
      AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL
      AND i.expires_at > now()
  )
$$;

CREATE OR REPLACE FUNCTION public.baby_members_consume_invite() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  member_email text;
  consumed integer;
BEGIN
  SELECT lower(u.email) INTO member_email FROM auth.users u WHERE u.id = NEW.user_id;
  IF member_email IS NOT NULL THEN
    UPDATE public.invites i
       SET accepted_at = now(), accepted_by = NEW.user_id
     WHERE i.baby_id = NEW.baby_id
       AND (i.email = member_email
            OR public.email_canonical(i.email) = public.email_canonical(member_email))
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > now();
    GET DIAGNOSTICS consumed = ROW_COUNT;
  ELSE
    consumed := 0;
  END IF;
  -- Self-join under SET ROLE authenticated (the role GUC; SECURITY DEFINER does not change it)
  -- that is not the creator's own first row: it was authorised by the invite branch only, so the
  -- invite must still have been live. service_role redemptions are never second-guessed.
  IF consumed = 0
     AND current_setting('role', true) = 'authenticated'
     AND NEW.user_id = public.auth_uid()
     AND EXISTS (SELECT 1 FROM public.baby_members m WHERE m.baby_id = NEW.baby_id AND m.user_id <> NEW.user_id)
  THEN
    RAISE EXCEPTION 'invite is no longer valid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-------------------------------------------------------------------------------------------------
-- A. Families (D-A, D-B, D-E)
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.families (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by  uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS families_created_by_idx ON public.families (created_by) WHERE created_by IS NOT NULL;
COMMENT ON TABLE public.families IS
  'One free-tier pool (1,000 approved photos across its free, live albums) and the unit of "one family per parent". Trigger-maintained: created by babies_set_family, dropped by babies_release_family when its last album is hard-deleted. No user role writes it.';
COMMENT ON COLUMN public.families.created_by IS
  'Founder (the account whose first album started the family); NULL after that account is deleted. While the family has a live album the founder belongs to it even without an admin row (parent_family_of): stepping down or leaving does not free the account to start another family.';
COMMENT ON COLUMN public.families.created_at IS
  'now() of the transaction that created the row (babies_set_family). POST /babies detects a family start by created_at = now() in its own insert transaction; backfilled rows carry their founding album''s created_at instead.';
ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.families FORCE ROW LEVEL SECURITY;
-- The schema's default privileges hand service_role ALL on new tables; narrow every role.
REVOKE ALL ON public.families FROM PUBLIC, authenticated, viewer, pipeline, service_role;
GRANT SELECT ON public.families TO authenticated, service_role;

ALTER TABLE public.babies
  ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES public.families (id) ON DELETE RESTRICT;
COMMENT ON COLUMN public.babies.family_id IS
  'Family whose free pool this album draws from (step 11). Set on insert by babies_set_family (creator''s family, else a new one); never writable by a user role.';

-- Backfill (dev databases; production has no data): connected components of "shares an admin",
-- visiting albums in (created_at, id) order. No neighbour family => new family (founder: the
-- album's creator while still one of its admins, else its earliest-joined admin, else NULL, so
-- an ex-member is never bound to it as founder; created_at: the album's); one =>
-- join it; several => merge them into the oldest (first created in this walk). The updated_at
-- trigger is paused so the walk does not touch babies.updated_at. NOTICE: counts only.
ALTER TABLE public.babies DISABLE TRIGGER babies_set_updated_at;
DO $backfill$
DECLARE
  r record;
  v_fams uuid[];
  v_target uuid;
  v_order uuid[] := ARRAY[]::uuid[];
  n_babies integer := 0;
  n_created integer := 0;
  n_merged integer := 0;
BEGIN
  FOR r IN SELECT b.id, b.created_by, b.created_at FROM public.babies b
            WHERE b.family_id IS NULL ORDER BY b.created_at, b.id
  LOOP
    n_babies := n_babies + 1;
    SELECT array_agg(DISTINCT o.family_id) INTO v_fams
    FROM public.baby_members m
    JOIN public.baby_members om ON om.user_id = m.user_id AND om.role = 'admin' AND om.baby_id <> m.baby_id
    JOIN public.babies o ON o.id = om.baby_id AND o.family_id IS NOT NULL
    WHERE m.baby_id = r.id AND m.role = 'admin';

    IF v_fams IS NULL THEN
      INSERT INTO public.families (created_by, created_at)
      VALUES ((SELECT m.user_id FROM public.baby_members m
                WHERE m.baby_id = r.id AND m.role = 'admin'
                ORDER BY (m.user_id IS NOT DISTINCT FROM r.created_by) DESC, m.joined_at, m.user_id
                LIMIT 1),
              r.created_at)
      RETURNING id INTO v_target;
      v_order := v_order || v_target;
      n_created := n_created + 1;
    ELSE
      SELECT f INTO v_target FROM unnest(v_fams) AS f ORDER BY array_position(v_order, f) LIMIT 1;
      IF cardinality(v_fams) > 1 THEN
        UPDATE public.babies SET family_id = v_target
         WHERE family_id = ANY (v_fams) AND family_id <> v_target;
        DELETE FROM public.families WHERE id = ANY (v_fams) AND id <> v_target;
        n_merged := n_merged + cardinality(v_fams) - 1;
      END IF;
    END IF;
    UPDATE public.babies SET family_id = v_target WHERE id = r.id;
  END LOOP;
  RAISE NOTICE 'family backfill: % albums, % families created, % merged away, % families now',
    n_babies, n_created, n_merged, (SELECT count(*) FROM public.families);
END
$backfill$;
ALTER TABLE public.babies ENABLE TRIGGER babies_set_updated_at;

ALTER TABLE public.babies ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS babies_family_idx ON public.babies (family_id);
CREATE INDEX IF NOT EXISTS babies_family_free_live_idx
  ON public.babies (family_id) WHERE deleted_at IS NULL AND plan = 'free';

-- Readable like created_by; never insertable or updatable by a user role (trigger-maintained;
-- service_role and the seeds may pass it explicitly).
GRANT SELECT (family_id) ON public.babies TO authenticated;

-- The family in which p_user is a parent:
-- 1. the family of their oldest album where they are admin, trashed albums included (D-E: a
--    parent of only trashed albums still belongs to that family until purge; no trash-cycling to
--    a fresh pool);
-- 2. else the family they founded (`families.created_by`) while it has a live album: a founder
--    who stepped down or left (after making someone else admin) is still bound to it, so
--    "start F1, hand it over, start F2" cannot double the free photos. The tie ends when the
--    family has no live album left or the founder's account is deleted (created_by NULL).
-- NULL when a parent nowhere. Not granted to any user role (it answers a question about another
-- account). The two branches agree for every account the triggers below have accepted.
CREATE OR REPLACE FUNCTION public.parent_family_of(p_user uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT c.family_id
  FROM (
    SELECT b.family_id, 0 AS rank, b.created_at, b.id
    FROM public.baby_members m
    JOIN public.babies b ON b.id = m.baby_id
    WHERE m.user_id = p_user AND m.role = 'admin'
    UNION ALL
    SELECT f.id, 1, f.created_at, f.id
    FROM public.families f
    WHERE f.created_by = p_user
      AND EXISTS (SELECT 1 FROM public.babies lb WHERE lb.family_id = f.id AND lb.deleted_at IS NULL)
  ) c
  ORDER BY c.rank, c.created_at, c.id
  LIMIT 1
$$;
COMMENT ON FUNCTION public.parent_family_of(uuid) IS
  'Family where this account is a parent: admin of any of its albums (trashed included), else founder of it while it has a live album; else NULL. Not granted to user roles.';
REVOKE EXECUTE ON FUNCTION public.parent_family_of(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.my_family_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT public.parent_family_of(public.auth_uid())
$$;
COMMENT ON FUNCTION public.my_family_id() IS
  'parent_family_of(auth_uid()): the caller''s own family, NULL when the caller is a parent nowhere (POST /babies then runs the family-start guards).';
REVOKE EXECUTE ON FUNCTION public.my_family_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_family_id() TO authenticated;

-- Member of a live album of the family, or admin of any album of it (trashed included). Mirrors
-- the babies SELECT policy without depending on it.
CREATE OR REPLACE FUNCTION public.is_family_member(p_family_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.baby_members m
    JOIN public.babies b ON b.id = m.baby_id
    WHERE b.family_id = p_family_id
      AND m.user_id = public.auth_uid()
      AND (b.deleted_at IS NULL OR m.role = 'admin')
  )
$$;
REVOKE EXECUTE ON FUNCTION public.is_family_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_family_member(uuid) TO authenticated;

DROP POLICY IF EXISTS families_authenticated_select ON public.families;
CREATE POLICY families_authenticated_select ON public.families FOR SELECT TO authenticated
  USING (public.is_family_member(id));

-- Every new album: an explicit family (service_role / seeds) is kept; an upsert of an existing
-- album keeps that album's family (INSERT ... ON CONFLICT (id) DO UPDATE never touches
-- family_id); else the creator's family (or, within one multi-row INSERT, the family of the
-- creator's earlier row); else a new family. Lock class 1012 (per creator) makes
-- two concurrent first albums of one account land in one family. Starting a family is refused
-- when another live account with the same canonical address is already a parent (D-B; lock class
-- 1013 per canonical address: two concurrent starts for one inbox admit exactly one). A NULL
-- creator (fixtures) gets a family of its own.
CREATE OR REPLACE FUNCTION public.babies_set_family() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_family uuid;
  v_canon text;
BEGIN
  IF NEW.family_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT b.family_id INTO v_family FROM public.babies b WHERE b.id = NEW.id;
  IF v_family IS NOT NULL THEN
    NEW.family_id := v_family;
    RETURN NEW;
  END IF;
  IF NEW.created_by IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(1012, hashtext(NEW.created_by::text));
    v_family := public.parent_family_of(NEW.created_by);
    -- A multi-row INSERT by one creator: the earlier rows of this statement are in place but
    -- their creator-admin rows (babies_add_creator_admin, AFTER INSERT) come only at the end of
    -- the statement. A live album with no member at all exists only in that window
    -- (baby_members_keep_last_admin keeps an admin on every live album), so join its family.
    IF v_family IS NULL THEN
      SELECT b.family_id INTO v_family
      FROM public.babies b
      WHERE b.created_by = NEW.created_by
        AND b.id <> NEW.id
        AND b.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.baby_members m WHERE m.baby_id = b.id)
      ORDER BY b.created_at, b.id
      LIMIT 1;
    END IF;
    IF v_family IS NOT NULL THEN
      NEW.family_id := v_family;
      RETURN NEW;
    END IF;
    SELECT p.email_canonical INTO v_canon FROM public.profiles p WHERE p.user_id = NEW.created_by;
    IF v_canon IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(1013, hashtext(v_canon));
      -- An account in its deletion window (profiles.deleted_at set, GoTrue delete pending or
      -- failed and being retried) still holds the inbox until it is hard-deleted.
      IF EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.email_canonical = v_canon
                    AND p.user_id <> NEW.created_by
                    AND public.parent_family_of(p.user_id) IS NOT NULL) THEN
        RAISE EXCEPTION 'another account for this inbox already has a family' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  INSERT INTO public.families (created_by) VALUES (NEW.created_by) RETURNING id INTO v_family;
  NEW.family_id := v_family;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.babies_set_family() FROM PUBLIC;
DROP TRIGGER IF EXISTS babies_set_family ON public.babies;
CREATE TRIGGER babies_set_family BEFORE INSERT ON public.babies
  FOR EACH ROW EXECUTE FUNCTION public.babies_set_family();

-- One family per parent: becoming admin (insert, upsert, promotion) is refused when the user is
-- admin of an album in another family (trashed albums count) or founded another family that
-- still has a live album (see parent_family_of). Lock class 1012 per user: two
-- admin invites accepted at once serialise, and the second sees the first (READ COMMITTED). The
-- creator's own first row (babies_add_creator_admin) always passes: babies_set_family placed the
-- album in the creator's family a moment earlier.
CREATE OR REPLACE FUNCTION public.baby_members_one_family() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_family uuid;
BEGIN
  IF NEW.role <> 'admin' OR (TG_OP = 'UPDATE' AND OLD.role = 'admin') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(1012, hashtext(NEW.user_id::text));
  SELECT b.family_id INTO v_family FROM public.babies b WHERE b.id = NEW.baby_id;
  IF EXISTS (SELECT 1 FROM public.baby_members m
               JOIN public.babies b ON b.id = m.baby_id
              WHERE m.user_id = NEW.user_id
                AND m.role = 'admin'
                AND m.baby_id <> NEW.baby_id
                AND b.family_id <> v_family)
     OR EXISTS (SELECT 1 FROM public.families f
                 WHERE f.created_by = NEW.user_id
                   AND f.id <> v_family
                   AND EXISTS (SELECT 1 FROM public.babies lb
                                WHERE lb.family_id = f.id AND lb.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'user is already a parent in another family' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.baby_members_one_family() FROM PUBLIC;
DROP TRIGGER IF EXISTS baby_members_one_family ON public.baby_members;
CREATE TRIGGER baby_members_one_family BEFORE INSERT OR UPDATE OF role ON public.baby_members
  FOR EACH ROW EXECUTE FUNCTION public.baby_members_one_family();

-- Moving an album to another family (service_role / operator tools only; no user grant): every
-- admin of the album must then be a parent in that family only. Same message and lock class as
-- baby_members_one_family.
CREATE OR REPLACE FUNCTION public.babies_family_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.family_id IS NOT DISTINCT FROM OLD.family_id THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(1012, hashtext(m.user_id::text))
     FROM public.baby_members m
    WHERE m.baby_id = NEW.id AND m.role = 'admin'
    ORDER BY m.user_id;
  IF EXISTS (SELECT 1 FROM public.baby_members m
               JOIN public.baby_members om ON om.user_id = m.user_id AND om.role = 'admin' AND om.baby_id <> m.baby_id
               JOIN public.babies ob ON ob.id = om.baby_id
              WHERE m.baby_id = NEW.id
                AND m.role = 'admin'
                AND ob.family_id <> NEW.family_id)
     OR EXISTS (SELECT 1 FROM public.baby_members m
                  JOIN public.families f ON f.created_by = m.user_id
                 WHERE m.baby_id = NEW.id
                   AND m.role = 'admin'
                   AND f.id <> NEW.family_id
                   AND EXISTS (SELECT 1 FROM public.babies lb
                                WHERE lb.family_id = f.id AND lb.deleted_at IS NULL AND lb.id <> NEW.id)) THEN
    RAISE EXCEPTION 'user is already a parent in another family' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.babies_family_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS babies_family_guard ON public.babies;
CREATE TRIGGER babies_family_guard BEFORE UPDATE OF family_id ON public.babies
  FOR EACH ROW EXECUTE FUNCTION public.babies_family_guard();

-- The purge of a family's last album (or moving it away) drops the family. The family row is
-- locked first, so two transactions removing its last two albums at once cannot both keep it
-- (the second re-checks in a snapshot taken after the first committed). FK RESTRICT protects
-- the other direction; family_starts.family_id goes NULL.
CREATE OR REPLACE FUNCTION public.babies_release_family() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.family_id IS NOT DISTINCT FROM OLD.family_id THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.families f WHERE f.id = OLD.family_id FOR UPDATE;
  DELETE FROM public.families f
   WHERE f.id = OLD.family_id
     AND NOT EXISTS (SELECT 1 FROM public.babies b WHERE b.family_id = f.id);
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.babies_release_family() FROM PUBLIC;
DROP TRIGGER IF EXISTS babies_release_family ON public.babies;
CREATE TRIGGER babies_release_family AFTER DELETE OR UPDATE OF family_id ON public.babies
  FOR EACH ROW EXECUTE FUNCTION public.babies_release_family();

-------------------------------------------------------------------------------------------------
-- B. Pool count and the cap trigger (per family, approved only)
--
-- Photos that count (keep the copies identical: free_tier_pool_used, photos_free_tier_cap):
--   p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
--   AND p.status NOT IN ('failed', 'duplicate')
-- Pool of a baby: the free, live albums of its family. Plus and trashed albums are outside.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.free_tier_pool_used(p_baby_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM public.babies t
  JOIN public.babies b ON b.family_id = t.family_id
  JOIN public.photos p ON p.baby_id = b.id
  WHERE t.id = p_baby_id
    AND b.deleted_at IS NULL
    AND b.plan = 'free'
    AND p.approval = 'approved'
    AND p.deleted_at IS NULL
    AND p.quarantined_at IS NULL
    AND p.status NOT IN ('failed', 'duplicate')
    AND (public.auth_claims() IS NULL OR public.is_baby_member(p_baby_id))
$$;
COMMENT ON FUNCTION public.free_tier_pool_used(uuid) IS
  'Approved photos counting toward the 1,000-photo free pool of this baby''s family (every free, live album of the family). 0 for a non-member; full count without claims.';

CREATE OR REPLACE FUNCTION public.free_tier_pool_albums(p_baby_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM public.babies t
  JOIN public.babies b ON b.family_id = t.family_id
  WHERE t.id = p_baby_id
    AND b.deleted_at IS NULL
    AND b.plan = 'free'
    AND (public.auth_claims() IS NULL OR public.is_baby_member(p_baby_id))
$$;
COMMENT ON FUNCTION public.free_tier_pool_albums(uuid) IS
  'Free, live albums of this baby''s family (>= 1 for a free live baby). 0 for a non-member; full value without claims.';

REVOKE EXECUTE ON FUNCTION public.free_tier_pool_used(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.free_tier_pool_albums(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.free_tier_pool_used(uuid) TO authenticated, pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.free_tier_pool_albums(uuid) TO authenticated, pipeline, service_role;

-- The hard stop. Fires for every role (superuser included) whenever a photo starts counting:
-- inserted approved (admin upload, import, seed), approved (pending -> approved), restored from
-- the trash while approved. A guest's pending upload and a rejected photo restored to pending do
-- not count. Counting runs after the advisory lock, in a fresh statement snapshot (READ
-- COMMITTED), so two concurrent approvals/inserts into one family at 999 admit exactly one. A
-- family already at or over 1,000 keeps its photos and refuses the next.
CREATE OR REPLACE FUNCTION public.photos_free_tier_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_plan text;
  v_family uuid;
  v_used integer;
BEGIN
  IF NOT (NEW.approval = 'approved' AND NEW.deleted_at IS NULL AND NEW.quarantined_at IS NULL
          AND NEW.status NOT IN ('failed', 'duplicate')) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.approval = 'approved' AND OLD.deleted_at IS NULL
     AND OLD.quarantined_at IS NULL AND OLD.status NOT IN ('failed', 'duplicate') THEN
    RETURN NEW;
  END IF;
  SELECT b.plan, b.family_id INTO v_plan, v_family FROM public.babies b WHERE b.id = NEW.baby_id;
  IF v_plan = 'free' THEN
    PERFORM pg_advisory_xact_lock(1011, hashtext(v_family::text));
    SELECT count(*) INTO v_used
    FROM public.photos p
    JOIN public.babies b ON b.id = p.baby_id
    WHERE b.family_id = v_family
      AND b.deleted_at IS NULL
      AND b.plan = 'free'
      AND p.approval = 'approved'
      AND p.deleted_at IS NULL
      AND p.quarantined_at IS NULL
      AND p.status NOT IN ('failed', 'duplicate');
    IF v_used >= 1000 THEN
      RAISE EXCEPTION 'free tier photo limit reached (1000 approved photos per family)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photos_free_tier_cap() FROM PUBLIC;
DROP TRIGGER IF EXISTS photos_free_tier_cap ON public.photos;
CREATE TRIGGER photos_free_tier_cap BEFORE INSERT OR UPDATE OF approval, deleted_at ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_free_tier_cap();

-------------------------------------------------------------------------------------------------
-- C. Pending cap (per uploader per family; every plan, D-C; GUC override, D-D)
--
-- Pending photos (keep the copies identical: my_pending_photo_count, photos_pending_cap):
--   p.approval = 'pending' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
--   AND p.status NOT IN ('failed', 'duplicate')
-------------------------------------------------------------------------------------------------
-- 200 unless the operator set `ALTER DATABASE tinyglow SET app.pending_photo_limit = '<n>'`
-- (PENDING_PHOTOS_PER_GUEST_PER_FAMILY in @tinyglow/shared mirrors the default). Never below 1.
CREATE OR REPLACE FUNCTION public.pending_photo_limit() RETURNS integer
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT GREATEST(1, COALESCE(NULLIF(btrim(current_setting('app.pending_photo_limit', true)), '')::integer, 200))
$$;
COMMENT ON FUNCTION public.pending_photo_limit() IS
  'Most pending (awaiting approval) photos one uploader may have in one family: 200, or the app.pending_photo_limit setting (minimum 1).';

CREATE OR REPLACE FUNCTION public.my_pending_photo_count(p_baby_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM public.babies t
  JOIN public.babies b ON b.family_id = t.family_id
  JOIN public.photos p ON p.baby_id = b.id
  WHERE t.id = p_baby_id
    AND b.deleted_at IS NULL
    AND p.uploaded_by = public.auth_uid()
    AND p.approval = 'pending'
    AND p.deleted_at IS NULL
    AND p.quarantined_at IS NULL
    AND p.status NOT IN ('failed', 'duplicate')
    AND public.is_baby_member(p_baby_id)
$$;
COMMENT ON FUNCTION public.my_pending_photo_count(uuid) IS
  'Live pending photos uploaded by the caller across the family of this baby. 0 for a non-member or without claims.';

REVOKE EXECUTE ON FUNCTION public.pending_photo_limit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_pending_photo_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pending_photo_limit() TO authenticated, pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.my_pending_photo_count(uuid) TO authenticated, pipeline, service_role;

-- Fires for every role whenever a photo becomes pending: inserted pending (guest upload, guest
-- import), restored from the trash while pending (or rejected -> pending). Admin uploads are
-- inserted approved, so this only ever bites guests. A photo with no uploader passes.
CREATE OR REPLACE FUNCTION public.photos_pending_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_family uuid;
  v_pending integer;
BEGIN
  IF NEW.uploaded_by IS NULL
     OR NOT (NEW.approval = 'pending' AND NEW.deleted_at IS NULL AND NEW.quarantined_at IS NULL
             AND NEW.status NOT IN ('failed', 'duplicate')) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.approval = 'pending' AND OLD.deleted_at IS NULL
     AND OLD.quarantined_at IS NULL AND OLD.status NOT IN ('failed', 'duplicate')
     AND OLD.uploaded_by IS NOT DISTINCT FROM NEW.uploaded_by THEN
    RETURN NEW;
  END IF;
  SELECT b.family_id INTO v_family FROM public.babies b WHERE b.id = NEW.baby_id;
  PERFORM pg_advisory_xact_lock(1014, hashtext(v_family::text || ':' || NEW.uploaded_by::text));
  SELECT count(*) INTO v_pending
  FROM public.photos p
  JOIN public.babies b ON b.id = p.baby_id
  WHERE b.family_id = v_family
    AND b.deleted_at IS NULL
    AND p.uploaded_by = NEW.uploaded_by
    AND p.approval = 'pending'
    AND p.deleted_at IS NULL
    AND p.quarantined_at IS NULL
    AND p.status NOT IN ('failed', 'duplicate');
  IF v_pending >= public.pending_photo_limit() THEN
    RAISE EXCEPTION 'pending photo limit reached (per guest per family)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photos_pending_cap() FROM PUBLIC;
DROP TRIGGER IF EXISTS photos_pending_cap ON public.photos;
CREATE TRIGGER photos_pending_cap BEFORE INSERT OR UPDATE OF approval, deleted_at ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_pending_cap();

-- `pending_limit` joins the three error vocabularies (appended last, the order of the shared
-- enums uploadFileErrorSchema, IMPORT_SOURCE_ERRORS, IMPORT_ITEM_ERRORS).
ALTER TABLE public.upload_files DROP CONSTRAINT IF EXISTS upload_files_error_check;
ALTER TABLE public.upload_files ADD CONSTRAINT upload_files_error_check
  CHECK (error IN ('unsupported_media_type', 'file_too_large', 'decode_failed', 'free_tier_limit',
                   'rejected', 'expired', 'storage_error', 'upload_incomplete', 'pending_limit'));
ALTER TABLE public.import_sources DROP CONSTRAINT IF EXISTS import_sources_last_error_check;
ALTER TABLE public.import_sources ADD CONSTRAINT import_sources_last_error_check
  CHECK (last_error IN ('free_tier_limit', 'permission_denied', 'album_missing',
                        'network', 'storage_error', 'baby_trashed', 'signed_out', 'pending_limit'));
ALTER TABLE public.import_items DROP CONSTRAINT IF EXISTS import_items_error_check;
ALTER TABLE public.import_items ADD CONSTRAINT import_items_error_check
  CHECK (error IN ('unsupported_media_type', 'file_too_large', 'download_failed',
                   'free_tier_limit', 'storage_error', 'not_member', 'baby_trashed', 'pending_limit'));

-------------------------------------------------------------------------------------------------
-- D (cont.). API helpers (service_role only; never authenticated: they answer questions about
-- other people's addresses). Inputs are bind parameters; nothing is logged or raised with them.
-------------------------------------------------------------------------------------------------
-- 'none' (no profile for an auth.users row with this address), 'active', or 'suspended'.
-- GoTrue stores addresses lowercased (and the API lowercases before calling it), so the exact
-- match uses GoTrue's users_email_partial_key index.
CREATE OR REPLACE FUNCTION public.account_state_for_email(p_email text) RETURNS text
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN bool_or(p.suspended_at IS NOT NULL) THEN 'suspended'
           WHEN count(p.user_id) > 0 THEN 'active'
           ELSE 'none'
         END
  FROM auth.users u
  JOIN public.profiles p ON p.user_id = u.id
  WHERE u.email = lower(btrim(p_email))
    AND u.is_sso_user = false
$$;
COMMENT ON FUNCTION public.account_state_for_email(text) IS
  'none | active | suspended for the account holding exactly this address (service_role only).';

-- The address of the (oldest) account with this canonical form that is a parent somewhere (an
-- account in its deletion window included, like the arbiter in babies_set_family): the masked
-- hint of 409 inbox_has_family. NULL if none.
CREATE OR REPLACE FUNCTION public.family_holder_email_for_canonical(p_canonical text) RETURNS text
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT u.email::text
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.user_id
  WHERE p.email_canonical = p_canonical
    AND public.parent_family_of(p.user_id) IS NOT NULL
  ORDER BY p.created_at, p.user_id
  LIMIT 1
$$;
COMMENT ON FUNCTION public.family_holder_email_for_canonical(text) IS
  'auth.users.email of the oldest account with this canonical address that is a parent in a family (deletion window included), else NULL (service_role only; the API masks it before use).';

REVOKE EXECUTE ON FUNCTION public.account_state_for_email(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.family_holder_email_for_canonical(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_state_for_email(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.family_holder_email_for_canonical(text) TO service_role;

-------------------------------------------------------------------------------------------------
-- E. Family-start ledger
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.family_starts (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id     uuid        REFERENCES public.families (id) ON DELETE SET NULL,
  user_id       uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  ip_hash       bytea       NOT NULL CHECK (octet_length(ip_hash) = 32),
  ip_country    text        CHECK (ip_country ~ '^[A-Z0-9]{2}$'),
  client        text        NOT NULL CHECK (client IN ('web', 'native')),
  plus_tag      boolean     NOT NULL DEFAULT false,
  dots_folded   boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS family_starts_ip_hash_created_idx ON public.family_starts (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS family_starts_created_idx ON public.family_starts (created_at);
CREATE INDEX IF NOT EXISTS family_starts_user_id_idx ON public.family_starts (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS family_starts_family_id_idx ON public.family_starts (family_id) WHERE family_id IS NOT NULL;
COMMENT ON TABLE public.family_starts IS
  'One row per family start (first album of an account that was a parent nowhere). No email, no IP, no user agent. 30-day retention (FR-10.3), pruned by family_starts_prune.';
COMMENT ON COLUMN public.family_starts.family_id IS
  'NULL while the API holds the row as a reservation (between the family-start guards and the album insert; a row whose insert never completed stays NULL and keeps counting against its network), and again after the family is purged.';
COMMENT ON COLUMN public.family_starts.user_id IS
  'Kept (as NULL) after account deletion: start -> delete -> start still counts against the network.';
COMMENT ON COLUMN public.family_starts.ip_hash IS
  'HMAC-SHA256(client IP) under HKDF(JWT_SECRET, "tinyglow", "family-ip-v1"). Never the IP.';
COMMENT ON COLUMN public.family_starts.ip_country IS
  'CF-IPCountry (two characters, coarse); NULL in dev.';
ALTER TABLE public.family_starts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_starts FORCE ROW LEVEL SECURITY;
-- Deny-all below service_role: no grant and no policy for authenticated, viewer or pipeline.
REVOKE ALL ON public.family_starts FROM PUBLIC, authenticated, viewer, pipeline, service_role;
-- UPDATE of family_id only: the API reserves a row before the album insert (per-network cap,
-- lock class 1015 in family-guards.ts) and fills in the family afterwards, or deletes it.
GRANT SELECT, INSERT, DELETE ON public.family_starts TO service_role;
GRANT UPDATE (family_id) ON public.family_starts TO service_role;
REVOKE ALL ON SEQUENCE public.family_starts_id_seq FROM PUBLIC, authenticated, viewer, pipeline, service_role;

-- 30-day retention. Called by the api after each insert and by the worker's purge (pipeline has
-- no grant on the table itself). Returns the number of rows removed.
CREATE OR REPLACE FUNCTION public.family_starts_prune() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.family_starts WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
COMMENT ON FUNCTION public.family_starts_prune() IS
  'Delete family_starts rows older than 30 days (FR-10.3 retention); returns the count.';
REVOKE EXECUTE ON FUNCTION public.family_starts_prune() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.family_starts_prune() TO service_role, pipeline;

-------------------------------------------------------------------------------------------------
-- F. Suspension: auth_session_info gains `suspended`
-------------------------------------------------------------------------------------------------
-- RETURNS TABLE gains a column: drop and recreate (callers selecting created_at/refreshed_at by
-- name are unaffected).
DROP FUNCTION IF EXISTS public.auth_session_info(uuid);
CREATE FUNCTION public.auth_session_info(p_session_id uuid)
  RETURNS TABLE (created_at timestamptz, refreshed_at timestamptz, suspended boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.created_at,
         (s.refreshed_at AT TIME ZONE 'UTC')::timestamptz,
         EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.user_id = s.user_id AND p.suspended_at IS NOT NULL)
  FROM auth.sessions s
  WHERE s.id = p_session_id
    AND s.user_id = public.auth_uid()
    AND (s.not_after IS NULL OR s.not_after > now())
$$;
COMMENT ON FUNCTION public.auth_session_info(uuid) IS
  'auth.sessions row of the signed-in user (auth_uid()) for one session id, plus whether the account is suspended; empty when the session is gone, belongs to someone else, or its timebox passed.';
REVOKE EXECUTE ON FUNCTION public.auth_session_info(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_session_info(uuid) TO authenticated;

-------------------------------------------------------------------------------------------------
-- G. import_book_photo(): the step-10 body plus one outcome, 'pending_limit' (photos_pending_cap
-- refused a guest's pending insert). Grants are kept by CREATE OR REPLACE.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_book_photo(p_item_id uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_item record;
  v_role text;
  v_constraint text;
  v_message text;
BEGIN
  SELECT i.id, i.baby_id, i.storage_key, i.mime_hint, i.bytes, i.sha256, i.taken_at_hint, i.status,
         b.requested_by, b.status AS batch_status
    INTO v_item
  FROM public.import_items i
  JOIN public.import_batches b ON b.id = i.batch_id AND b.baby_id = i.baby_id
  WHERE i.id = p_item_id
  FOR UPDATE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import item not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_item.status <> 'downloaded' OR v_item.bytes IS NULL OR v_item.sha256 IS NULL OR v_item.mime_hint IS NULL THEN
    RAISE EXCEPTION 'import item is not ready to book' USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.batch_status <> 'running' THEN
    RAISE EXCEPTION 'import batch is not running' USING ERRCODE = 'check_violation';
  END IF;

  -- Role at run time; FOR SHARE holds it (no concurrent removal or role change) until commit.
  IF v_item.requested_by IS NOT NULL THEN
    SELECT m.role INTO v_role
    FROM public.baby_members m
    JOIN public.profiles p ON p.user_id = m.user_id AND p.deleted_at IS NULL
    WHERE m.baby_id = v_item.baby_id AND m.user_id = v_item.requested_by
    FOR SHARE OF m;
  END IF;
  IF v_role IS NULL THEN
    RETURN 'not_member';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.babies bb WHERE bb.id = v_item.baby_id AND bb.deleted_at IS NULL) THEN
    RETURN 'baby_trashed';
  END IF;

  BEGIN
    -- Mirrors photos_authenticated_insert: admin => approved by themselves; else pending, no
    -- approver. photos_free_tier_cap fires for every insert.
    INSERT INTO public.photos
      (id, baby_id, uploaded_by, storage_key_original, mime, bytes, sha256, approval, approved_by,
       approved_at, taken_at, taken_at_estimated)
    VALUES
      (v_item.id, v_item.baby_id, v_item.requested_by, v_item.storage_key, v_item.mime_hint,
       v_item.bytes, v_item.sha256,
       CASE WHEN v_role = 'admin' THEN 'approved' ELSE 'pending' END,
       CASE WHEN v_role = 'admin' THEN v_item.requested_by END,
       CASE WHEN v_role = 'admin' THEN now() END,
       v_item.taken_at_hint, true);
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'photos_baby_id_sha256_key' THEN
        RETURN 'duplicate';
      END IF;
      RAISE EXCEPTION 'import item could not be booked' USING ERRCODE = 'unique_violation';
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      IF v_message LIKE 'free tier photo limit%' THEN
        RETURN 'free_tier_limit';
      ELSIF v_message LIKE 'pending photo limit%' THEN
        RETURN 'pending_limit';
      END IF;
      RAISE EXCEPTION 'import item could not be booked' USING ERRCODE = 'check_violation';
  END;

  UPDATE public.import_items SET status = 'booked', photo_id = id, error = NULL WHERE id = p_item_id;
  RETURN 'booked';
END
$$;
COMMENT ON FUNCTION public.import_book_photo(uuid) IS
  'D10: books a downloaded import item as a photo under the requester''s run-time role (admin => approved by the requester; contributor => pending, approved_by NULL). booked | duplicate | free_tier_limit | pending_limit | not_member | baby_trashed. pipeline only.';

-- Down Migration

-- G. import_book_photo: the step-10 body and comment verbatim.
CREATE OR REPLACE FUNCTION public.import_book_photo(p_item_id uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_item record;
  v_role text;
  v_constraint text;
  v_message text;
BEGIN
  SELECT i.id, i.baby_id, i.storage_key, i.mime_hint, i.bytes, i.sha256, i.taken_at_hint, i.status,
         b.requested_by, b.status AS batch_status
    INTO v_item
  FROM public.import_items i
  JOIN public.import_batches b ON b.id = i.batch_id AND b.baby_id = i.baby_id
  WHERE i.id = p_item_id
  FOR UPDATE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import item not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_item.status <> 'downloaded' OR v_item.bytes IS NULL OR v_item.sha256 IS NULL OR v_item.mime_hint IS NULL THEN
    RAISE EXCEPTION 'import item is not ready to book' USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.batch_status <> 'running' THEN
    RAISE EXCEPTION 'import batch is not running' USING ERRCODE = 'check_violation';
  END IF;

  -- Role at run time; FOR SHARE holds it (no concurrent removal or role change) until commit.
  IF v_item.requested_by IS NOT NULL THEN
    SELECT m.role INTO v_role
    FROM public.baby_members m
    JOIN public.profiles p ON p.user_id = m.user_id AND p.deleted_at IS NULL
    WHERE m.baby_id = v_item.baby_id AND m.user_id = v_item.requested_by
    FOR SHARE OF m;
  END IF;
  IF v_role IS NULL THEN
    RETURN 'not_member';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.babies bb WHERE bb.id = v_item.baby_id AND bb.deleted_at IS NULL) THEN
    RETURN 'baby_trashed';
  END IF;

  BEGIN
    -- Mirrors photos_authenticated_insert: admin => approved by themselves; else pending, no
    -- approver. photos_free_tier_cap fires for every insert.
    INSERT INTO public.photos
      (id, baby_id, uploaded_by, storage_key_original, mime, bytes, sha256, approval, approved_by,
       approved_at, taken_at, taken_at_estimated)
    VALUES
      (v_item.id, v_item.baby_id, v_item.requested_by, v_item.storage_key, v_item.mime_hint,
       v_item.bytes, v_item.sha256,
       CASE WHEN v_role = 'admin' THEN 'approved' ELSE 'pending' END,
       CASE WHEN v_role = 'admin' THEN v_item.requested_by END,
       CASE WHEN v_role = 'admin' THEN now() END,
       v_item.taken_at_hint, true);
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'photos_baby_id_sha256_key' THEN
        RETURN 'duplicate';
      END IF;
      RAISE EXCEPTION 'import item could not be booked' USING ERRCODE = 'unique_violation';
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      IF v_message LIKE 'free tier photo limit%' THEN
        RETURN 'free_tier_limit';
      END IF;
      RAISE EXCEPTION 'import item could not be booked' USING ERRCODE = 'check_violation';
  END;

  UPDATE public.import_items SET status = 'booked', photo_id = id, error = NULL WHERE id = p_item_id;
  RETURN 'booked';
END
$$;
COMMENT ON FUNCTION public.import_book_photo(uuid) IS
  'D10: books a downloaded import item as a photo under the requester''s run-time role (admin => approved by the requester; contributor => pending, approved_by NULL). booked | duplicate | free_tier_limit | not_member | baby_trashed. pipeline only.';

-- F. Suspension: restore the step-3 auth_session_info shape and grants, drop the columns (below).
DROP FUNCTION IF EXISTS public.auth_session_info(uuid);
CREATE FUNCTION public.auth_session_info(p_session_id uuid)
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
REVOKE EXECUTE ON FUNCTION public.auth_session_info(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_session_info(uuid) TO authenticated;

-- E. Ledger.
DROP FUNCTION IF EXISTS public.family_starts_prune();
DROP TABLE IF EXISTS public.family_starts;

-- D. Helpers.
DROP FUNCTION IF EXISTS public.family_holder_email_for_canonical(text);
DROP FUNCTION IF EXISTS public.account_state_for_email(text);

-- C. Pending cap; the three error vocabularies as before.
DROP TRIGGER IF EXISTS photos_pending_cap ON public.photos;
DROP FUNCTION IF EXISTS public.photos_pending_cap();
DROP FUNCTION IF EXISTS public.my_pending_photo_count(uuid);
DROP FUNCTION IF EXISTS public.pending_photo_limit();
ALTER TABLE public.upload_files DROP CONSTRAINT IF EXISTS upload_files_error_check;
ALTER TABLE public.upload_files ADD CONSTRAINT upload_files_error_check
  CHECK (error IN ('unsupported_media_type', 'file_too_large', 'decode_failed', 'free_tier_limit',
                   'rejected', 'expired', 'storage_error', 'upload_incomplete'));
ALTER TABLE public.import_sources DROP CONSTRAINT IF EXISTS import_sources_last_error_check;
ALTER TABLE public.import_sources ADD CONSTRAINT import_sources_last_error_check
  CHECK (last_error IN ('free_tier_limit', 'permission_denied', 'album_missing',
                        'network', 'storage_error', 'baby_trashed', 'signed_out'));
ALTER TABLE public.import_items DROP CONSTRAINT IF EXISTS import_items_error_check;
ALTER TABLE public.import_items ADD CONSTRAINT import_items_error_check
  CHECK (error IN ('unsupported_media_type', 'file_too_large', 'download_failed',
                   'free_tier_limit', 'storage_error', 'not_member', 'baby_trashed'));

-- B. Cap: restore the step-4 trigger (INSERT only) and body verbatim, drop the pool helpers.
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
REVOKE EXECUTE ON FUNCTION public.photos_free_tier_cap() FROM PUBLIC;
DROP TRIGGER IF EXISTS photos_free_tier_cap ON public.photos;
CREATE TRIGGER photos_free_tier_cap BEFORE INSERT ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_free_tier_cap();
DROP FUNCTION IF EXISTS public.free_tier_pool_albums(uuid);
DROP FUNCTION IF EXISTS public.free_tier_pool_used(uuid);

-- A. Families.
DROP TRIGGER IF EXISTS babies_release_family ON public.babies;
DROP FUNCTION IF EXISTS public.babies_release_family();
DROP TRIGGER IF EXISTS babies_family_guard ON public.babies;
DROP FUNCTION IF EXISTS public.babies_family_guard();
DROP TRIGGER IF EXISTS baby_members_one_family ON public.baby_members;
DROP FUNCTION IF EXISTS public.baby_members_one_family();
DROP TRIGGER IF EXISTS babies_set_family ON public.babies;
DROP FUNCTION IF EXISTS public.babies_set_family();
DROP FUNCTION IF EXISTS public.my_family_id();
DROP FUNCTION IF EXISTS public.parent_family_of(uuid);
DROP INDEX IF EXISTS public.babies_family_free_live_idx;
DROP INDEX IF EXISTS public.babies_family_idx;
ALTER TABLE public.babies DROP COLUMN IF EXISTS family_id;
DROP TABLE IF EXISTS public.families;
DROP FUNCTION IF EXISTS public.is_family_member(uuid);

-- D. Canonical email: restore the step-2 invite functions verbatim, drop the rest.
CREATE OR REPLACE FUNCTION public.invite_allows_join(p_baby_id uuid, p_role text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT public.auth_email() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.invites i
    WHERE i.baby_id = p_baby_id
      AND i.email = public.auth_email()
      AND i.role = p_role
      AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL
      AND i.expires_at > now()
  )
$$;

CREATE OR REPLACE FUNCTION public.baby_members_consume_invite() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  member_email text;
  consumed integer;
BEGIN
  SELECT lower(u.email) INTO member_email FROM auth.users u WHERE u.id = NEW.user_id;
  IF member_email IS NOT NULL THEN
    UPDATE public.invites i
       SET accepted_at = now(), accepted_by = NEW.user_id
     WHERE i.baby_id = NEW.baby_id
       AND i.email = member_email
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > now();
    GET DIAGNOSTICS consumed = ROW_COUNT;
  ELSE
    consumed := 0;
  END IF;
  -- Self-join under SET ROLE authenticated (the role GUC; SECURITY DEFINER does not change it)
  -- that is not the creator's own first row: it was authorised by the invite branch only, so the
  -- invite must still have been live. service_role redemptions are never second-guessed.
  IF consumed = 0
     AND current_setting('role', true) = 'authenticated'
     AND NEW.user_id = public.auth_uid()
     AND EXISTS (SELECT 1 FROM public.baby_members m WHERE m.baby_id = NEW.baby_id AND m.user_id <> NEW.user_id)
  THEN
    RAISE EXCEPTION 'invite is no longer valid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

DROP INDEX IF EXISTS public.invites_email_canonical_live_idx;
DROP TRIGGER IF EXISTS profiles_set_email_canonical ON public.profiles;
DROP FUNCTION IF EXISTS public.profiles_set_email_canonical();
DROP INDEX IF EXISTS public.profiles_email_canonical_idx;

ALTER TABLE public.profiles DROP COLUMN IF EXISTS email_canonical;
DROP FUNCTION IF EXISTS public.email_canonical(text);

-- F (columns).
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS suspended_reason,
  DROP COLUMN IF EXISTS suspended_at;
