-- Up Migration

-- Native push (docs/plans/step-9.md 2.8, 2.9; PRD "Capacitor plugins" (push, opt-in), "Privacy and
-- child safety", "Sessions and tokens"; user decisions 2026-10-09: push is opt-in, generic text).
-- What this migration makes a database rule, independent of the API and the worker:
--
-- * Devices (`push_devices`) are written only through `register_push_device()` /
--   `unregister_push_devices_for_session()` (authenticated, SECURITY DEFINER): one row per GoTrue
--   session, a token belongs to exactly one row (a token seen again for another user or session
--   moves there, so a shared phone never notifies the previous user). The signed-in user can list
--   and delete their own rows but can never read `token`, `session_id` or `user_id` back.
-- * Who gets a push is decided here, not in the worker: `push_targets()` returns only enabled
--   devices of **admins** of a **live** baby (contributors and viewers never), whose profile is
--   live and has the kind's opt-out on, and whose GoTrue session is still live in `auth.sessions`
--   (row present, timebox not passed, used within the 90-day inactivity window). Sign-out, sign-out
--   everywhere, per-device sign-out, idle expiry and account deletion therefore stop pushes with no
--   extra code path. `photos_analyzed` additionally needs `baby_ai_enabled()` (paid tier only: a
--   free baby has no `photo_ai` rows and never gets that push).
-- * The worker (`pipeline`) gets EXECUTE on the four push functions only: no grant on either table.
-- * The ledger (`push_deliveries`) holds ids, kind, status and a count: never a token or text.
--
-- Tokens never appear in an error message or in the server log:
-- * every shape rule is checked by `push_devices_shape` (BEFORE INSERT/UPDATE) with fixed text
--   before the CHECK constraints run (the CHECKs stay as a backstop and for `db:types`; a CHECK
--   violation's DETAIL would print the whole row, token included);
-- * uniqueness is on `digest(token, 'sha256')`, not on `token`: a unique violation's DETAIL then
--   shows a hash, and a btree on the raw column would also fail for tokens above ~2,700 bytes
--   while the contract allows 4,096 characters;
-- * `register_push_device` serializes per token (advisory lock) so concurrent registrations of
--   one token cannot hit the unique index at all.
--
-- Coupling: `auth.sessions` columns of supabase/auth v2.197.0 (as in migration 10) and
-- GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=2160h (90 days; PRD "Sessions and tokens") in both Compose files.

DO $guard$
BEGIN
  IF to_regclass('auth.sessions') IS NULL THEN
    RAISE EXCEPTION 'auth.sessions is missing: start the auth (GoTrue) service before running migrations';
  END IF;
END
$guard$;

-------------------------------------------------------------------------------------------------
-- profiles: per-kind push opt-outs. Default true: the OS permission plus "Turn on notifications"
-- is the opt-in (D14); these toggles only switch a kind off. Own row only (existing policies).
-------------------------------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS notify_photos_analyzed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_share_viewed    boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.profiles.notify_photos_analyzed IS
  'Push opt-out for "N new photos are ready to search" (admins of Plus babies). Read by push_targets().';
COMMENT ON COLUMN public.profiles.notify_share_viewed IS
  'Push opt-out for "Someone opened your shared album" (admins). Read by push_targets().';
-- authenticated already has table-level SELECT on profiles; UPDATE is column-level.
GRANT UPDATE (notify_photos_analyzed, notify_share_viewed) ON public.profiles TO authenticated;

-------------------------------------------------------------------------------------------------
-- push_devices: one row per signed-in app session that turned notifications on.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_devices (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  session_id          uuid        NOT NULL,
  platform            text        NOT NULL CHECK (platform IN ('ios', 'android')),
  provider            text        NOT NULL CHECK (provider IN ('apns', 'fcm')),
  token               text        NOT NULL,
  app_version         text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_registered_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at         timestamptz,
  disabled_reason     text        CHECK (disabled_reason IN ('invalid_token')),
  CONSTRAINT push_devices_platform_provider CHECK ((platform = 'ios') = (provider = 'apns')),
  CONSTRAINT push_devices_token_shape CHECK (length(token) BETWEEN 8 AND 4096 AND token !~ '\s'),
  CONSTRAINT push_devices_app_version_shape CHECK (app_version ~ '^[0-9A-Za-z.+-]{1,32}$'),
  CONSTRAINT push_devices_disabled_pair CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);
COMMENT ON TABLE public.push_devices IS
  'APNs/FCM device tokens per GoTrue session (step 9). Written only by register_push_device / unregister_push_devices_for_session; tokens are never selectable by user roles and never logged.';
COMMENT ON COLUMN public.push_devices.session_id IS
  'GoTrue auth.sessions.id of the registering session (no FK into auth). push_targets() requires the session to be live.';
COMMENT ON COLUMN public.push_devices.token IS
  'Provider device token (secret-ish). Readable only through push_targets() (pipeline) and service_role.';
CREATE UNIQUE INDEX IF NOT EXISTS push_devices_token_sha256_key
  ON public.push_devices (public.digest(token, 'sha256'));
CREATE INDEX IF NOT EXISTS push_devices_user_id_idx ON public.push_devices (user_id);
CREATE INDEX IF NOT EXISTS push_devices_session_id_idx ON public.push_devices (session_id);
ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_devices FORCE ROW LEVEL SECURITY;

-- Shape with fixed messages, BEFORE the CHECKs (see header): nothing here prints the row.
CREATE OR REPLACE FUNCTION public.push_devices_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.platform IS NULL OR NEW.platform NOT IN ('ios', 'android') THEN
    RAISE EXCEPTION 'push_devices.platform must be ios or android' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provider IS NULL OR NEW.provider NOT IN ('apns', 'fcm') THEN
    RAISE EXCEPTION 'push_devices.provider must be apns or fcm' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.platform = 'ios') <> (NEW.provider = 'apns') THEN
    RAISE EXCEPTION 'push_devices: ios uses apns and android uses fcm' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.token IS NULL OR length(NEW.token) < 8 OR length(NEW.token) > 4096 OR NEW.token ~ '\s' THEN
    RAISE EXCEPTION 'push_devices.token has an invalid shape' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.app_version IS NULL OR NEW.app_version !~ '^[0-9A-Za-z.+-]{1,32}$' THEN
    RAISE EXCEPTION 'push_devices.app_version has an invalid shape' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.disabled_at IS NULL) <> (NEW.disabled_reason IS NULL)
     OR (NEW.disabled_reason IS NOT NULL AND NEW.disabled_reason <> 'invalid_token') THEN
    RAISE EXCEPTION 'push_devices.disabled_at and disabled_reason go together' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.push_devices_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS push_devices_shape ON public.push_devices;
CREATE TRIGGER push_devices_shape BEFORE INSERT OR UPDATE ON public.push_devices
  FOR EACH ROW EXECUTE FUNCTION public.push_devices_shape();

-------------------------------------------------------------------------------------------------
-- push_deliveries: append-mostly ledger (gap rule, gate proof, support). Ids and counts only.
-- Rows are per USER: unregistering or pruning a device keeps its rows (device_id becomes NULL),
-- so signing out and back in does not reset the PUSH_MIN_GAP_MIN gap. Rows go with the profile
-- (account deletion) or the baby, and are pruned per user after 30 days.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_deliveries (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id      uuid        REFERENCES public.push_devices (id) ON DELETE SET NULL,
  user_id        uuid        NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  baby_id        uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  share_link_id  uuid        REFERENCES public.share_links (id) ON DELETE SET NULL,
  kind           text        NOT NULL CHECK (kind IN ('photos_analyzed', 'share_viewed')),
  status         text        NOT NULL CHECK (status IN ('sent', 'fake', 'failed', 'invalid_token', 'unconfigured')),
  item_count     integer     CHECK (item_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.push_deliveries IS
  'One row per push attempt (step 9): ids, kind, status, count. Written by push_record_delivery(); service_role only otherwise. Kept when the device row goes (device_id SET NULL) so the per-user gap survives sign-out; rows older than 30 days are pruned per user.';
CREATE INDEX IF NOT EXISTS push_deliveries_user_baby_kind_created_idx
  ON public.push_deliveries (user_id, baby_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS push_deliveries_device_id_created_idx
  ON public.push_deliveries (device_id, created_at);
ALTER TABLE public.push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_deliveries FORCE ROW LEVEL SECURITY;

-------------------------------------------------------------------------------------------------
-- Grants and policies. service_role: ALL (default privileges; BYPASSRLS). authenticated: own
-- device rows, safe columns, DELETE. pipeline / viewer / anon: nothing on either table.
-------------------------------------------------------------------------------------------------
GRANT ALL ON public.push_devices, public.push_deliveries TO service_role;
GRANT SELECT (id, platform, provider, app_version, created_at, last_registered_at, disabled_at)
  ON public.push_devices TO authenticated;
GRANT DELETE ON public.push_devices TO authenticated;

DROP POLICY IF EXISTS push_devices_authenticated_select ON public.push_devices;
CREATE POLICY push_devices_authenticated_select ON public.push_devices FOR SELECT TO authenticated
  USING (user_id = public.auth_uid());
DROP POLICY IF EXISTS push_devices_authenticated_delete ON public.push_devices;
CREATE POLICY push_devices_authenticated_delete ON public.push_devices FOR DELETE TO authenticated
  USING (user_id = public.auth_uid());

-------------------------------------------------------------------------------------------------
-- Session liveness for push (internal; not granted to any role). Same rule as
-- auth_session_info() plus GoTrue's 90-day inactivity window, which GoTrue enforces only at
-- refresh time (the row stays until then), so an abandoned session stops receiving pushes too.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.push_session_live(p_session_id uuid, p_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.sessions s
    WHERE s.id = p_session_id
      AND s.user_id = p_user_id
      AND (s.not_after IS NULL OR s.not_after > now())
      AND coalesce((s.refreshed_at AT TIME ZONE 'UTC')::timestamptz, s.updated_at, s.created_at)
          > now() - interval '90 days'
  )
$$;
COMMENT ON FUNCTION public.push_session_live(uuid, uuid) IS
  'True while the GoTrue session exists for that user, its timebox has not passed and it was used within 90 days. Internal to the push functions.';
REVOKE EXECUTE ON FUNCTION public.push_session_live(uuid, uuid) FROM PUBLIC;

-- The session id of the current authenticated claims, or NULL (never raises on a malformed claim).
CREATE OR REPLACE FUNCTION public.push_claims_session_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN public.auth_uid() IS NOT NULL
     AND (public.auth_claims() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (public.auth_claims() ->> 'session_id')::uuid
  END
$$;
REVOKE EXECUTE ON FUNCTION public.push_claims_session_id() FROM PUBLIC;

-------------------------------------------------------------------------------------------------
-- authenticated: register / unregister the current session's device.
-------------------------------------------------------------------------------------------------
-- Registers (or refreshes) the calling session's device and returns its id. Needs authenticated
-- claims with a live session_id. A token already held by another user or session moves here
-- (that row is deleted: a shared phone stops notifying the previous user); any other row of this
-- session is replaced (one device per session). Re-registering the same token from the same
-- session keeps the id, refreshes last_registered_at/app_version and clears a disable. Also
-- drops the caller's rows whose sessions are no longer live (housekeeping).
CREATE OR REPLACE FUNCTION public.register_push_device(
  p_platform text, p_provider text, p_token text, p_app_version text
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := public.auth_uid();
  v_sid uuid := public.push_claims_session_id();
  v_existing public.push_devices%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR v_sid IS NULL OR NOT public.push_session_live(v_sid, v_uid) THEN
    RAISE EXCEPTION 'push registration needs a session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = v_uid AND p.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'push registration needs a profile' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Shape first, with fixed text (the trigger would also catch it).
  IF p_platform IS NULL OR p_platform NOT IN ('ios', 'android')
     OR p_provider IS NULL OR p_provider NOT IN ('apns', 'fcm')
     OR (p_platform = 'ios') <> (p_provider = 'apns') THEN
    RAISE EXCEPTION 'push registration has an invalid platform or provider' USING ERRCODE = 'check_violation';
  END IF;
  IF p_token IS NULL OR length(p_token) < 8 OR length(p_token) > 4096 OR p_token ~ '\s' THEN
    RAISE EXCEPTION 'push_devices.token has an invalid shape' USING ERRCODE = 'check_violation';
  END IF;
  IF p_app_version IS NULL OR p_app_version !~ '^[0-9A-Za-z.+-]{1,32}$' THEN
    RAISE EXCEPTION 'push_devices.app_version has an invalid shape' USING ERRCODE = 'check_violation';
  END IF;

  -- One registration of a given token at a time (no unique-index race, no echo of the token).
  PERFORM pg_advisory_xact_lock(hashtextextended('push_devices:' || p_token, 0));

  SELECT d.* INTO v_existing
  FROM public.push_devices d
  WHERE public.digest(d.token, 'sha256') = public.digest(p_token, 'sha256')
  FOR UPDATE;

  IF FOUND AND v_existing.user_id = v_uid AND v_existing.session_id = v_sid THEN
    DELETE FROM public.push_devices d
     WHERE d.user_id = v_uid AND d.session_id = v_sid AND d.id <> v_existing.id;
    UPDATE public.push_devices d
       SET platform = p_platform, provider = p_provider, app_version = p_app_version,
           last_registered_at = now(), disabled_at = NULL, disabled_reason = NULL
     WHERE d.id = v_existing.id;
    v_id := v_existing.id;
  ELSE
    IF FOUND THEN
      DELETE FROM public.push_devices d WHERE d.id = v_existing.id;
    END IF;
    DELETE FROM public.push_devices d WHERE d.user_id = v_uid AND d.session_id = v_sid;
    INSERT INTO public.push_devices (user_id, session_id, platform, provider, token, app_version)
    VALUES (v_uid, v_sid, p_platform, p_provider, p_token, p_app_version)
    RETURNING id INTO v_id;
  END IF;

  DELETE FROM public.push_devices d
   WHERE d.user_id = v_uid AND d.session_id <> v_sid
     AND NOT public.push_session_live(d.session_id, d.user_id);
  RETURN v_id;
END
$$;
COMMENT ON FUNCTION public.register_push_device(text, text, text, text) IS
  'POST /me/push-devices: register the current session''s device (authenticated claims with a live session_id). Returns push_devices.id. Fixed error text; never echoes the token.';

-- Deletes the calling session's device rows (sign-out, notifications off). 0 without claims.
CREATE OR REPLACE FUNCTION public.unregister_push_devices_for_session() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := public.auth_uid();
  v_sid uuid := public.push_claims_session_id();
  deleted integer;
BEGIN
  IF v_uid IS NULL OR v_sid IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM public.push_devices d WHERE d.user_id = v_uid AND d.session_id = v_sid;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$$;
COMMENT ON FUNCTION public.unregister_push_devices_for_session() IS
  'DELETE /me/push-devices/current: delete the device rows of the caller''s current session (claims session_id). Returns the number deleted.';

-------------------------------------------------------------------------------------------------
-- pipeline (worker push.notify): targets, count, link -> baby, ledger.
-------------------------------------------------------------------------------------------------
-- Devices to notify for (baby, kind). Unknown kind => error. Also deletes device rows whose
-- sessions are no longer live (any user), so tokens do not outlive sign-out for long; this is
-- the reason the function is VOLATILE.
CREATE OR REPLACE FUNCTION public.push_targets(p_baby_id uuid, p_kind text)
  RETURNS TABLE (device_id uuid, user_id uuid, provider text, token text, last_sent_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('photos_analyzed', 'share_viewed') THEN
    RAISE EXCEPTION 'unknown push kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM public.push_devices d WHERE NOT public.push_session_live(d.session_id, d.user_id);

  IF p_kind = 'photos_analyzed' AND NOT public.baby_ai_enabled(p_baby_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT d.id, d.user_id, d.provider, d.token,
         (SELECT max(x.created_at)
            FROM public.push_deliveries x
           WHERE x.user_id = d.user_id AND x.baby_id = p_baby_id AND x.kind = p_kind
             AND x.status IN ('sent', 'fake'))
  FROM public.push_devices d
  JOIN public.baby_members m ON m.user_id = d.user_id AND m.baby_id = p_baby_id AND m.role = 'admin'
  JOIN public.babies b ON b.id = m.baby_id AND b.deleted_at IS NULL
  JOIN public.profiles p ON p.user_id = d.user_id AND p.deleted_at IS NULL
  WHERE d.disabled_at IS NULL
    AND CASE p_kind
          WHEN 'photos_analyzed' THEN p.notify_photos_analyzed
          WHEN 'share_viewed' THEN p.notify_share_viewed
          ELSE false
        END
    AND public.push_session_live(d.session_id, d.user_id)
  ORDER BY d.user_id, d.id;
END
$$;
COMMENT ON FUNCTION public.push_targets(uuid, text) IS
  'Enabled devices of admins of a live baby with the kind''s pref on and a live GoTrue session; photos_analyzed only for baby_ai_enabled. last_sent_at = latest sent/fake delivery to that user for (baby, kind).';

-- Photos of the baby newly described since p_since (approved, live, not quarantined, not duplicates).
CREATE OR REPLACE FUNCTION public.push_photos_analyzed_count(p_baby_id uuid, p_since timestamptz)
  RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM public.photos ph
  JOIN public.photo_ai a ON a.photo_id = ph.id
  WHERE ph.baby_id = p_baby_id
    AND a.created_at > p_since
    AND ph.approval = 'approved'
    AND ph.deleted_at IS NULL
    AND ph.quarantined_at IS NULL
    AND ph.status <> 'duplicate'
$$;
COMMENT ON FUNCTION public.push_photos_analyzed_count(uuid, timestamptz) IS
  'Number of approved, live, unquarantined photos of the baby whose photo_ai row was created after p_since.';

-- The link's baby while that baby is live; NULL otherwise (unknown link, trashed baby).
CREATE OR REPLACE FUNCTION public.push_link_baby(p_share_link_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT l.baby_id
  FROM public.share_links l
  JOIN public.babies b ON b.id = l.baby_id AND b.deleted_at IS NULL
  WHERE l.id = p_share_link_id
$$;
COMMENT ON FUNCTION public.push_link_baby(uuid) IS
  'share_viewed: the share link''s baby id if the baby is live, else NULL.';

-- Ledger row for one send. The user comes from the device row; a device deleted in the
-- meantime (sign-out during the send) records nothing. invalid_token disables the device.
-- Prunes the user's ledger rows older than 30 days, including rows whose device is gone
-- (device_id NULL after unregister/prune).
CREATE OR REPLACE FUNCTION public.push_record_delivery(
  p_device_id uuid, p_baby_id uuid, p_share_link_id uuid, p_kind text, p_status text, p_count integer
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('photos_analyzed', 'share_viewed') THEN
    RAISE EXCEPTION 'unknown push kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('sent', 'fake', 'failed', 'invalid_token', 'unconfigured') THEN
    RAISE EXCEPTION 'unknown push delivery status' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_count IS NOT NULL AND p_count < 0 THEN
    RAISE EXCEPTION 'push delivery count must not be negative' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_share_link_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.share_links l WHERE l.id = p_share_link_id AND l.baby_id = p_baby_id
  ) THEN
    RAISE EXCEPTION 'share link does not belong to the baby' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT d.user_id INTO v_user FROM public.push_devices d WHERE d.id = p_device_id FOR UPDATE;
  IF v_user IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.push_deliveries (device_id, user_id, baby_id, share_link_id, kind, status, item_count)
  VALUES (p_device_id, v_user, p_baby_id, p_share_link_id, p_kind, p_status, p_count);

  IF p_status = 'invalid_token' THEN
    UPDATE public.push_devices d
       SET disabled_at = now(), disabled_reason = 'invalid_token'
     WHERE d.id = p_device_id AND d.disabled_at IS NULL;
  END IF;

  DELETE FROM public.push_deliveries x
   WHERE x.user_id = v_user AND x.created_at < now() - interval '30 days';
END
$$;
COMMENT ON FUNCTION public.push_record_delivery(uuid, uuid, uuid, text, text, integer) IS
  'Worker ledger write for one push send; invalid_token disables the device; prunes the user''s rows older than 30 days (device_id NULL rows included).';

REVOKE EXECUTE ON FUNCTION public.push_claims_session_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.register_push_device(text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.unregister_push_devices_for_session() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.push_targets(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.push_photos_analyzed_count(uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.push_link_baby(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.push_record_delivery(uuid, uuid, uuid, text, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.register_push_device(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unregister_push_devices_for_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.push_targets(uuid, text) TO pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.push_photos_analyzed_count(uuid, timestamptz) TO pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.push_link_baby(uuid) TO pipeline;
GRANT EXECUTE ON FUNCTION public.push_record_delivery(uuid, uuid, uuid, text, text, integer) TO pipeline;

-- Down Migration

DROP FUNCTION IF EXISTS public.push_record_delivery(uuid, uuid, uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.push_link_baby(uuid);
DROP FUNCTION IF EXISTS public.push_photos_analyzed_count(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.push_targets(uuid, text);
DROP FUNCTION IF EXISTS public.unregister_push_devices_for_session();
DROP FUNCTION IF EXISTS public.register_push_device(text, text, text, text);
DROP FUNCTION IF EXISTS public.push_claims_session_id();
DROP FUNCTION IF EXISTS public.push_session_live(uuid, uuid);

DROP TABLE IF EXISTS public.push_deliveries;
DROP TABLE IF EXISTS public.push_devices;
DROP FUNCTION IF EXISTS public.push_devices_shape();

REVOKE UPDATE (notify_photos_analyzed, notify_share_viewed) ON public.profiles FROM authenticated;
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS notify_share_viewed,
  DROP COLUMN IF EXISTS notify_photos_analyzed;
