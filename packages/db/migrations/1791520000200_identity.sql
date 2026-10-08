-- Up Migration

-- Identity: profiles, babies, baby_members, invites (docs/plans/step-2.md 2.4-2.6). Every table:
-- ENABLE + FORCE ROW LEVEL SECURITY in this file, policies written TO <role>, helpers that read
-- baby_members are SECURITY DEFINER (owned by the superuser, pinned search_path) so they never
-- trust client claims beyond auth_uid() and cannot recurse into their own policies.

-------------------------------------------------------------------------------------------------
-- profiles: the app's 1:1 row for a GoTrue user. public.users does not exist (D3).
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id              uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name         text        NOT NULL DEFAULT '',
  relationship_label   text,
  timezone             text        NOT NULL DEFAULT 'UTC',
  units                text        NOT NULL DEFAULT 'metric' CHECK (units IN ('metric', 'imperial')),
  terms_version        text,
  privacy_version      text,
  accepted_at          timestamptz,
  accepted_ip_country  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
COMMENT ON TABLE public.profiles IS
  'App profile per GoTrue user (auth.users). Deleting the auth user cascades here and to memberships.';
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------------------------
-- babies: one album space per baby. Home coordinates only encrypted (encrypt_coord). Billing
-- columns (plan, plan_owner_user_id, entitlement_expires_at) are written by service_role only.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.babies (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  nickname                text,
  birth_date              date        NOT NULL,
  birth_date_is_due_date  boolean     NOT NULL DEFAULT false,
  birth_weight_g          integer     CHECK (birth_weight_g > 0),
  birth_length_mm         integer     CHECK (birth_length_mm > 0),
  avatar_photo_id         uuid,       -- FK added by the photos migration (ON DELETE SET NULL)
  home_lat_enc            bytea,
  home_lng_enc            bytea,
  home_label              text,
  plan                    text        NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'plus')),
  plan_owner_user_id      uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  entitlement_expires_at  timestamptz,
  created_by              uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz
);
COMMENT ON TABLE public.babies IS
  'Baby album space. deleted_at = soft delete; pipeline hard-deletes after 30 days (FR-10.3).';
COMMENT ON COLUMN public.babies.home_lat_enc IS
  'pgcrypto ciphertext (encrypt_coord). Plaintext home coordinates never exist in the database.';
ALTER TABLE public.babies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.babies FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS babies_set_updated_at ON public.babies;
CREATE TRIGGER babies_set_updated_at BEFORE UPDATE ON public.babies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------------------------
-- baby_members: the only source of truth for permissions.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.baby_members (
  baby_id     uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('admin', 'contributor')),
  invited_by  uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (baby_id, user_id)
);
CREATE INDEX IF NOT EXISTS baby_members_user_id_idx ON public.baby_members (user_id);
COMMENT ON TABLE public.baby_members IS
  'Membership + role per baby. Max two admins and at least one admin are enforced by triggers.';
ALTER TABLE public.baby_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baby_members FORCE ROW LEVEL SECURITY;

-------------------------------------------------------------------------------------------------
-- invites: token stored only as sha256 (32 bytes); 7-day expiry; 20 per baby per day.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invites (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id      uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  email        text        NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  role         text        NOT NULL CHECK (role IN ('admin', 'contributor')),
  token_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by   uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at  timestamptz,
  accepted_by  uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_baby_id_created_at_idx ON public.invites (baby_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS invites_one_live_per_email_idx
  ON public.invites (baby_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
COMMENT ON COLUMN public.invites.token_hash IS
  'sha256 of the 256-bit invite token. The plaintext token exists only in the emailed link.';
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites FORCE ROW LEVEL SECURITY;

-------------------------------------------------------------------------------------------------
-- Membership helpers (SECURITY DEFINER). They read baby_members/babies as the owner, so the
-- policies on those tables do not apply inside them and cannot recurse.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_baby_member(p_baby_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.baby_members m
    WHERE m.baby_id = p_baby_id AND m.user_id = public.auth_uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.is_baby_admin(p_baby_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.baby_members m
    WHERE m.baby_id = p_baby_id AND m.user_id = public.auth_uid() AND m.role = 'admin'
  )
$$;

CREATE OR REPLACE FUNCTION public.shares_baby_with(p_other_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.baby_members mine
    JOIN public.baby_members theirs ON theirs.baby_id = mine.baby_id
    WHERE mine.user_id = public.auth_uid() AND theirs.user_id = p_other_user_id
  )
$$;

CREATE OR REPLACE FUNCTION public.baby_ai_enabled(p_baby_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.babies b
    WHERE b.id = p_baby_id
      AND b.plan = 'plus'
      AND (b.entitlement_expires_at IS NULL OR b.entitlement_expires_at > now())
      AND b.deleted_at IS NULL
  )
$$;
COMMENT ON FUNCTION public.baby_ai_enabled(uuid) IS
  'Paid tier gate (FR-5.8): AI queue, photo_ai, search and chat all require this.';

-- True while a baby has no members at all. The creator's SELECT policy uses it so the row is
-- visible during the INSERT that creates it (RETURNING is checked before the AFTER INSERT trigger
-- adds the creator as admin); once any member exists, membership alone decides.
CREATE OR REPLACE FUNCTION public.baby_has_members(p_baby_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.baby_members m WHERE m.baby_id = p_baby_id)
$$;

-- An invitee may join only with the invited email, the invited role, on a live invite.
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

REVOKE EXECUTE ON FUNCTION public.is_baby_member(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_baby_admin(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.shares_baby_with(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.baby_ai_enabled(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.baby_has_members(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.invite_allows_join(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_baby_member(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_baby_admin(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shares_baby_with(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.baby_ai_enabled(uuid) TO authenticated, pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.baby_has_members(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invite_allows_join(uuid, text) TO authenticated, service_role;

-------------------------------------------------------------------------------------------------
-- Triggers (SECURITY DEFINER so they see every row regardless of the caller's policies).
-------------------------------------------------------------------------------------------------
-- Creator becomes the first admin.
CREATE OR REPLACE FUNCTION public.babies_add_creator_admin() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.created_by IS NOT NULL THEN
    INSERT INTO public.baby_members (baby_id, user_id, role)
    VALUES (NEW.id, NEW.created_by, 'admin')
    ON CONFLICT (baby_id, user_id) DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.babies_add_creator_admin() FROM PUBLIC;
DROP TRIGGER IF EXISTS babies_add_creator_admin ON public.babies;
CREATE TRIGGER babies_add_creator_admin AFTER INSERT ON public.babies
  FOR EACH ROW EXECUTE FUNCTION public.babies_add_creator_admin();

-- Joining consumes the invite. Every new membership marks any live invite addressed to that
-- user's email (auth.users, not the client's claims) for that baby as accepted, so a removed
-- member cannot rejoin on the invite they already used and a directly-added member's pending
-- invite cannot be redeemed later. A self-join by a signed-in user (the invite branch of
-- baby_members_authenticated_insert) must consume exactly one invite, or it fails: the policy
-- saw a live invite in its snapshot, but a concurrent revoke/accept may have won in between.
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
REVOKE EXECUTE ON FUNCTION public.baby_members_consume_invite() FROM PUBLIC;
DROP TRIGGER IF EXISTS baby_members_consume_invite ON public.baby_members;
CREATE TRIGGER baby_members_consume_invite AFTER INSERT ON public.baby_members
  FOR EACH ROW EXECUTE FUNCTION public.baby_members_consume_invite();

-- Max two admins (PRD "Roles and permissions"). Locks the baby row so two concurrent admin
-- inserts serialise.
CREATE OR REPLACE FUNCTION public.baby_members_max_two_admins() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  admin_count integer;
BEGIN
  IF NEW.role = 'admin' AND (TG_OP = 'INSERT' OR OLD.role IS DISTINCT FROM 'admin') THEN
    PERFORM 1 FROM public.babies b WHERE b.id = NEW.baby_id FOR UPDATE;
    -- Exclude this user's own row: an upsert (INSERT ... ON CONFLICT DO UPDATE) fires BEFORE
    -- INSERT for a row that already exists, and an UPDATE must not count the row it changes.
    SELECT count(*) INTO admin_count
    FROM public.baby_members m
    WHERE m.baby_id = NEW.baby_id AND m.role = 'admin' AND m.user_id <> NEW.user_id;
    IF admin_count >= 2 THEN
      RAISE EXCEPTION 'baby already has two admins' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.baby_members_max_two_admins() FROM PUBLIC;
DROP TRIGGER IF EXISTS baby_members_max_two_admins ON public.baby_members;
CREATE TRIGGER baby_members_max_two_admins BEFORE INSERT OR UPDATE OF role ON public.baby_members
  FOR EACH ROW EXECUTE FUNCTION public.baby_members_max_two_admins();

-- The last admin cannot leave or be demoted while the baby is live (FR-1.5). A cascade from a
-- hard-deleted baby sees no baby row; a soft-deleted baby is exempt so account deletion can
-- proceed after the album was deleted (PRD "Account deletion and recovery").
CREATE OR REPLACE FUNCTION public.baby_members_keep_last_admin() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.role = 'admin' AND (TG_OP = 'DELETE' OR NEW.role <> 'admin') THEN
    PERFORM 1 FROM public.babies b WHERE b.id = OLD.baby_id AND b.deleted_at IS NULL FOR UPDATE;
    IF FOUND AND NOT EXISTS (
         SELECT 1 FROM public.baby_members m
         WHERE m.baby_id = OLD.baby_id AND m.role = 'admin' AND m.user_id <> OLD.user_id
       ) THEN
      RAISE EXCEPTION 'baby must keep at least one admin' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.baby_members_keep_last_admin() FROM PUBLIC;
DROP TRIGGER IF EXISTS baby_members_keep_last_admin ON public.baby_members;
CREATE TRIGGER baby_members_keep_last_admin BEFORE DELETE OR UPDATE OF role ON public.baby_members
  FOR EACH ROW EXECUTE FUNCTION public.baby_members_keep_last_admin();

-- 20 invites per baby per day (PRD "Invites").
CREATE OR REPLACE FUNCTION public.invites_rate_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  recent integer;
BEGIN
  SELECT count(*) INTO recent
  FROM public.invites i
  WHERE i.baby_id = NEW.baby_id AND i.created_at > now() - interval '24 hours';
  IF recent >= 20 THEN
    RAISE EXCEPTION 'invite rate limit reached: 20 invites per baby per day' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.invites_rate_limit() FROM PUBLIC;
DROP TRIGGER IF EXISTS invites_rate_limit ON public.invites;
CREATE TRIGGER invites_rate_limit BEFORE INSERT ON public.invites
  FOR EACH ROW EXECUTE FUNCTION public.invites_rate_limit();

-------------------------------------------------------------------------------------------------
-- Grants and policies. service_role: ALL (BYPASSRLS). pipeline: narrow SELECTs. viewer: nothing
-- here (its babies allow-list is added by the sharing migration). authenticated: column lists.
-------------------------------------------------------------------------------------------------
GRANT ALL ON public.profiles, public.babies, public.baby_members, public.invites TO service_role;

-- profiles --------------------------------------------------------------------------------------
GRANT SELECT ON public.profiles TO authenticated;
GRANT INSERT (user_id, display_name, relationship_label, timezone, units, terms_version,
              privacy_version, accepted_at, accepted_ip_country) ON public.profiles TO authenticated;
GRANT UPDATE (display_name, relationship_label, timezone, units, terms_version, privacy_version,
              accepted_at, accepted_ip_country, updated_at) ON public.profiles TO authenticated;
GRANT SELECT (user_id, display_name, relationship_label) ON public.profiles TO pipeline;

DROP POLICY IF EXISTS profiles_authenticated_select ON public.profiles;
CREATE POLICY profiles_authenticated_select ON public.profiles FOR SELECT TO authenticated
  USING (user_id = public.auth_uid() OR public.shares_baby_with(user_id));
DROP POLICY IF EXISTS profiles_authenticated_insert ON public.profiles;
CREATE POLICY profiles_authenticated_insert ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = public.auth_uid());
DROP POLICY IF EXISTS profiles_authenticated_update ON public.profiles;
CREATE POLICY profiles_authenticated_update ON public.profiles FOR UPDATE TO authenticated
  USING (user_id = public.auth_uid()) WITH CHECK (user_id = public.auth_uid());
DROP POLICY IF EXISTS profiles_pipeline_select ON public.profiles;
CREATE POLICY profiles_pipeline_select ON public.profiles FOR SELECT TO pipeline USING (true);

-- babies: the encrypted home coordinates are never readable or writable by a user role (users
-- cannot hold the data key); the API writes them under service_role. SELECT * fails: name columns.
GRANT SELECT (id, name, nickname, birth_date, birth_date_is_due_date, birth_weight_g, birth_length_mm,
              avatar_photo_id, home_label, plan, plan_owner_user_id, entitlement_expires_at, created_by,
              created_at, updated_at, deleted_at) ON public.babies TO authenticated;
GRANT INSERT (id, name, nickname, birth_date, birth_date_is_due_date, birth_weight_g, birth_length_mm,
              home_label, created_by) ON public.babies TO authenticated;
GRANT UPDATE (name, nickname, birth_date, birth_date_is_due_date, birth_weight_g, birth_length_mm,
              avatar_photo_id, home_label, deleted_at, updated_at)
  ON public.babies TO authenticated;
GRANT SELECT (id, birth_date, plan, entitlement_expires_at, home_lat_enc, home_lng_enc, deleted_at)
  ON public.babies TO pipeline;
GRANT DELETE ON public.babies TO pipeline;

DROP POLICY IF EXISTS babies_authenticated_select ON public.babies;
CREATE POLICY babies_authenticated_select ON public.babies FOR SELECT TO authenticated
  USING (
    (public.is_baby_member(id) AND (deleted_at IS NULL OR public.is_baby_admin(id)))
    OR (created_by = public.auth_uid() AND NOT public.baby_has_members(id))
  );
DROP POLICY IF EXISTS babies_authenticated_insert ON public.babies;
CREATE POLICY babies_authenticated_insert ON public.babies FOR INSERT TO authenticated
  WITH CHECK (created_by = public.auth_uid());
DROP POLICY IF EXISTS babies_authenticated_update ON public.babies;
CREATE POLICY babies_authenticated_update ON public.babies FOR UPDATE TO authenticated
  USING (public.is_baby_admin(id)) WITH CHECK (public.is_baby_admin(id));
DROP POLICY IF EXISTS babies_pipeline_select ON public.babies;
CREATE POLICY babies_pipeline_select ON public.babies FOR SELECT TO pipeline USING (true);
DROP POLICY IF EXISTS babies_pipeline_delete ON public.babies;
CREATE POLICY babies_pipeline_delete ON public.babies FOR DELETE TO pipeline
  USING (deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days');

-- baby_members ----------------------------------------------------------------------------------
GRANT SELECT, DELETE ON public.baby_members TO authenticated;
GRANT INSERT (baby_id, user_id, role, invited_by) ON public.baby_members TO authenticated;
GRANT UPDATE (role) ON public.baby_members TO authenticated;

DROP POLICY IF EXISTS baby_members_authenticated_select ON public.baby_members;
CREATE POLICY baby_members_authenticated_select ON public.baby_members FOR SELECT TO authenticated
  USING (public.is_baby_member(baby_id));
DROP POLICY IF EXISTS baby_members_authenticated_insert ON public.baby_members;
CREATE POLICY baby_members_authenticated_insert ON public.baby_members FOR INSERT TO authenticated
  WITH CHECK (
    public.is_baby_admin(baby_id)
    OR (user_id = public.auth_uid() AND public.invite_allows_join(baby_id, role))
  );
DROP POLICY IF EXISTS baby_members_authenticated_update ON public.baby_members;
CREATE POLICY baby_members_authenticated_update ON public.baby_members FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id)) WITH CHECK (public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS baby_members_authenticated_delete ON public.baby_members;
CREATE POLICY baby_members_authenticated_delete ON public.baby_members FOR DELETE TO authenticated
  USING (public.is_baby_admin(baby_id) OR user_id = public.auth_uid());

-- invites ---------------------------------------------------------------------------------------
-- token_hash is never readable by a user role; redemption runs under service_role in the API.
GRANT SELECT (id, baby_id, email, role, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at)
  ON public.invites TO authenticated;
GRANT INSERT (id, baby_id, email, role, token_hash, invited_by, expires_at) ON public.invites TO authenticated;
GRANT UPDATE (token_hash, expires_at, accepted_at, accepted_by, revoked_at) ON public.invites TO authenticated;
GRANT DELETE ON public.invites TO authenticated;

DROP POLICY IF EXISTS invites_authenticated_select ON public.invites;
CREATE POLICY invites_authenticated_select ON public.invites FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id) OR email = public.auth_email());
DROP POLICY IF EXISTS invites_authenticated_insert ON public.invites;
CREATE POLICY invites_authenticated_insert ON public.invites FOR INSERT TO authenticated
  WITH CHECK (public.is_baby_admin(baby_id) AND invited_by = public.auth_uid());
DROP POLICY IF EXISTS invites_authenticated_update ON public.invites;
CREATE POLICY invites_authenticated_update ON public.invites FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id)) WITH CHECK (public.is_baby_admin(baby_id));
DROP POLICY IF EXISTS invites_authenticated_delete ON public.invites;
CREATE POLICY invites_authenticated_delete ON public.invites FOR DELETE TO authenticated
  USING (public.is_baby_admin(baby_id));

-- Down Migration

DROP TABLE IF EXISTS public.invites;
DROP TABLE IF EXISTS public.baby_members;
DROP TABLE IF EXISTS public.babies;
DROP TABLE IF EXISTS public.profiles;

DROP FUNCTION IF EXISTS public.invites_rate_limit();
DROP FUNCTION IF EXISTS public.baby_members_consume_invite();
DROP FUNCTION IF EXISTS public.baby_members_keep_last_admin();
DROP FUNCTION IF EXISTS public.baby_members_max_two_admins();
DROP FUNCTION IF EXISTS public.babies_add_creator_admin();
DROP FUNCTION IF EXISTS public.invite_allows_join(uuid, text);
DROP FUNCTION IF EXISTS public.baby_has_members(uuid);
DROP FUNCTION IF EXISTS public.baby_ai_enabled(uuid);
DROP FUNCTION IF EXISTS public.shares_baby_with(uuid);
DROP FUNCTION IF EXISTS public.is_baby_admin(uuid);
DROP FUNCTION IF EXISTS public.is_baby_member(uuid);
