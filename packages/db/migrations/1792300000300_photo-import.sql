-- Up Migration

-- Photo import (docs/plans/step-10.md 2.2, task 10.3; decisions D1, D3, D6, D8, D10, D11). Apple
-- Photos album sync status (iPhone, admins only) and Google Photos Picker imports (admins and
-- contributors; a contributor's import lands pending, FR-2.7). PRD FR-2.1-2.7, FR-4, FR-6.1,
-- "Roles and permissions", "Privacy and child safety", "Security".
--
-- Rules enforced here, not in the API, the worker or the UI:
-- * Four new tables, every one ENABLE + FORCE RLS; `viewer` has no grant on any of them.
-- * `import_sources` (Apple sync status, one row per device x baby x kind). Only an admin may
--   create an `apple_photos` source, for themselves (D1). A row exists only while its owner is a
--   member of the baby (composite FK to `baby_members`, ON DELETE CASCADE: leaving, removal and
--   account deletion drop it) and an `apple_photos` row only while the owner is an admin
--   (`baby_members_drop_apple_sync` deletes it on demotion; the UPDATE policy is the backstop).
--   Counters only: PHAsset identifiers, hashes of them, file names and paths are never stored
--   (D3). `album_title` / `device_label` are parent text: shape trigger, no non-enum CHECK.
-- * `google_accounts` (one Google connection per user). The refresh token exists only as
--   pgcrypto ciphertext (`encrypt_secret`, key = DATA_ENCRYPTION_KEY bound per transaction).
--   `authenticated` reads four harmless columns of its own row and writes nothing (the API
--   writes under service_role); `pipeline` has no table grant at all and obtains the plaintext
--   only through `import_google_refresh_token()` for an active batch whose requester is still a
--   live member of a live baby and does not need to reconnect.
-- * `import_batches` / `import_items` (Google Picker imports). Users read their own batches,
--   admins every batch of their baby; `provider_session_id` and `provider_item_id` are never
--   granted to `authenticated`. One active (picking/queued/running) batch per baby, 20 per baby
--   per rolling 24 h, never into a trashed album. User-role status transitions are a fixed
--   matrix (`import_batches_user_transitions`); counters and `error` are pipeline-only.
-- * Photos are created only by `import_book_photo()` (SECURITY DEFINER, pipeline only, D10).
--   The worker has no INSERT on `photos` and never gets one. The function takes an item id and
--   nothing else, re-reads membership and role at run time and mirrors
--   `photos_authenticated_insert` exactly: an admin's import is `approved` with
--   `approved_by = requester`, a contributor's is `pending` with `approved_by NULL`; no caller
--   input can name an approver. `photos_free_tier_cap` fires unconditionally (D8) and the
--   per-baby SHA-256 unique index decides duplicates.
-- * Every RAISE uses a fixed message naming no value (no token, URL, id, album title or label).
--
-- Grants audit for the import worker (2.7): `photos (id, baby_id, sha256, deleted_at, status)`
-- and `babies (id, deleted_at)` are already readable by `pipeline` (step 2 / 4 / review fixes),
-- so the duplicate pre-check and the baby-live check need nothing new; `profiles` and
-- `baby_members` are read only inside the SECURITY DEFINER functions below.

DO $guard$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'auth.users is missing: start the auth (GoTrue) service before running migrations';
  END IF;
END
$guard$;

-------------------------------------------------------------------------------------------------
-- Secrets at rest (same key mechanism as encrypt_coord / decrypt_coord). SECURITY INVOKER like
-- the coordinate pair: the caller needs pgcrypto's own grants (service_role has them), so the
-- functions add no privilege. EXECUTE to service_role only: the worker never encrypts, and it
-- decrypts only through import_google_refresh_token() (owner rights).
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.encrypt_secret(p text) RETURNS bytea
  LANGUAGE plpgsql VOLATILE STRICT SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  data_key text := current_setting('app.data_key', true);
BEGIN
  IF coalesce(data_key, '') = '' THEN
    RAISE EXCEPTION 'data key not set for this transaction' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN public.pgp_sym_encrypt(p, data_key, 'cipher-algo=aes256');
END
$$;

CREATE OR REPLACE FUNCTION public.decrypt_secret(p bytea) RETURNS text
  LANGUAGE plpgsql STABLE STRICT SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  data_key text := current_setting('app.data_key', true);
BEGIN
  IF coalesce(data_key, '') = '' THEN
    RAISE EXCEPTION 'data key not set for this transaction' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN public.pgp_sym_decrypt(p, data_key);
END
$$;
COMMENT ON FUNCTION public.encrypt_secret(text) IS
  'pgcrypto ciphertext of a secret (OAuth refresh token) under app.data_key. service_role only; never log the argument.';
COMMENT ON FUNCTION public.decrypt_secret(bytea) IS
  'Plaintext of encrypt_secret ciphertext under app.data_key. service_role only (the worker uses import_google_refresh_token); never log the result.';
REVOKE EXECUTE ON FUNCTION public.encrypt_secret(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_secret(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.encrypt_secret(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_secret(bytea) TO service_role;

-------------------------------------------------------------------------------------------------
-- import_sources: Apple album sync status (one row per device x baby x kind).
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.import_sources (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id          uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  kind             text        NOT NULL CHECK (kind IN ('apple_photos')),
  device_id        uuid        NOT NULL,
  device_label     text        NOT NULL,
  album_title      text        NOT NULL,
  wifi_only        boolean     NOT NULL DEFAULT true,
  paused           boolean     NOT NULL DEFAULT false,
  last_sync_at     timestamptz,
  last_trigger     text        CHECK (last_trigger IN ('launch', 'resume', 'manual', 'background')),
  imported_count   integer     NOT NULL DEFAULT 0,
  duplicate_count  integer     NOT NULL DEFAULT 0,
  failed_count     integer     NOT NULL DEFAULT 0,
  skipped_count    integer     NOT NULL DEFAULT 0,
  last_error       text        CHECK (last_error IN ('free_tier_limit', 'permission_denied', 'album_missing',
                                                     'network', 'storage_error', 'baby_trashed', 'signed_out')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_sources_device_id_baby_id_kind_key UNIQUE (device_id, baby_id, kind),
  -- The owner must be a member of the baby; leaving / removal / account deletion drops the row.
  CONSTRAINT import_sources_member_fkey FOREIGN KEY (baby_id, user_id)
    REFERENCES public.baby_members (baby_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS import_sources_baby_id_user_id_idx ON public.import_sources (baby_id, user_id);
CREATE INDEX IF NOT EXISTS import_sources_user_id_idx ON public.import_sources (user_id);
COMMENT ON TABLE public.import_sources IS
  'Apple Photos album sync status per device x baby (step 10, D2/D3): counters, last run, last error. Never PHAsset ids, hashes of them, file names or paths. apple_photos rows: admins only (D1).';
COMMENT ON COLUMN public.import_sources.device_id IS
  'Per-install id from the device Keychain (ll.install.v1); not the push device.';
COMMENT ON COLUMN public.import_sources.album_title IS
  'Parent text (Apple album title) for display only. Never in logs or audit metadata.';
ALTER TABLE public.import_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_sources FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS import_sources_set_updated_at ON public.import_sources;
CREATE TRIGGER import_sources_set_updated_at BEFORE UPDATE ON public.import_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Parent text and counters (no non-enum CHECK on a table holding parent text: README "Shape
-- triggers"). NULLs are refused here, before NOT NULL would echo the row for a BYPASSRLS role.
CREATE OR REPLACE FUNCTION public.import_sources_shape() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.device_label IS NULL OR length(NEW.device_label) < 1 OR length(NEW.device_label) > 60
     OR NEW.device_label ~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]' THEN
    RAISE EXCEPTION 'import_sources.device_label must be 1 to 60 characters, trimmed, without control characters'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.album_title IS NULL OR length(NEW.album_title) < 1 OR length(NEW.album_title) > 120
     OR NEW.album_title ~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]' THEN
    RAISE EXCEPTION 'import_sources.album_title must be 1 to 120 characters, trimmed, without control characters'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.imported_count IS NULL OR NEW.duplicate_count IS NULL OR NEW.failed_count IS NULL
     OR NEW.skipped_count IS NULL OR NEW.imported_count < 0 OR NEW.duplicate_count < 0
     OR NEW.failed_count < 0 OR NEW.skipped_count < 0 THEN
    RAISE EXCEPTION 'import_sources counters must be zero or more' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.import_sources_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS import_sources_shape ON public.import_sources;
CREATE TRIGGER import_sources_shape BEFORE INSERT OR UPDATE ON public.import_sources
  FOR EACH ROW EXECUTE FUNCTION public.import_sources_shape();

-- Live baby and at most 10 sources per baby (IMPORT_SOURCES_PER_BABY_MAX). BEFORE INSERT also
-- fires for the proposed row of INSERT ... ON CONFLICT DO UPDATE, so the row this insert would
-- update (same device and kind) is not counted: re-enabling a device at the cap still works.
CREATE OR REPLACE FUNCTION public.import_sources_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.babies b WHERE b.id = NEW.baby_id AND b.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'cannot sync into a trashed album' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM public.import_sources s
      WHERE s.baby_id = NEW.baby_id
        AND NOT (s.device_id = NEW.device_id AND s.kind = NEW.kind)) >= 10 THEN
    RAISE EXCEPTION 'import source limit reached' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.import_sources_insert_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS import_sources_insert_guard ON public.import_sources;
CREATE TRIGGER import_sources_insert_guard BEFORE INSERT ON public.import_sources
  FOR EACH ROW EXECUTE FUNCTION public.import_sources_insert_guard();

GRANT ALL ON public.import_sources TO service_role;
GRANT SELECT ON public.import_sources TO authenticated;
GRANT INSERT (baby_id, user_id, kind, device_id, device_label, album_title, wifi_only)
  ON public.import_sources TO authenticated;
GRANT UPDATE (device_label, album_title, wifi_only, paused, last_sync_at, last_trigger, imported_count,
              duplicate_count, failed_count, skipped_count, last_error, updated_at)
  ON public.import_sources TO authenticated;
GRANT DELETE ON public.import_sources TO authenticated;

-- Admins of the baby see every device's status; anyone else only their own rows (and only
-- while a member, which the composite FK already guarantees).
DROP POLICY IF EXISTS import_sources_authenticated_select ON public.import_sources;
CREATE POLICY import_sources_authenticated_select ON public.import_sources FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id) OR (user_id = public.auth_uid() AND public.is_baby_member(baby_id)));
-- D1: Apple sync is admin-only. Also checked for the proposed row of an ON CONFLICT upsert.
DROP POLICY IF EXISTS import_sources_authenticated_insert ON public.import_sources;
CREATE POLICY import_sources_authenticated_insert ON public.import_sources FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.auth_uid()
    AND public.is_baby_member(baby_id)
    AND (kind <> 'apple_photos' OR public.is_baby_admin(baby_id))
  );
-- Owner only; an apple_photos row stays writable only while the owner is an admin.
DROP POLICY IF EXISTS import_sources_authenticated_update ON public.import_sources;
CREATE POLICY import_sources_authenticated_update ON public.import_sources FOR UPDATE TO authenticated
  USING (user_id = public.auth_uid() AND (kind <> 'apple_photos' OR public.is_baby_admin(baby_id)))
  WITH CHECK (user_id = public.auth_uid() AND (kind <> 'apple_photos' OR public.is_baby_admin(baby_id)));
DROP POLICY IF EXISTS import_sources_authenticated_delete ON public.import_sources;
CREATE POLICY import_sources_authenticated_delete ON public.import_sources FOR DELETE TO authenticated
  USING (user_id = public.auth_uid() OR public.is_baby_admin(baby_id));

-- Demotion from admin ends the user's Apple album sync for that baby (D1: an open-ended
-- automatic flow is an admin capability). Leaving / removal is the composite FK cascade.
CREATE OR REPLACE FUNCTION public.baby_members_drop_apple_sync() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.role = 'admin' AND NEW.role IS DISTINCT FROM 'admin' THEN
    DELETE FROM public.import_sources s
    WHERE s.baby_id = NEW.baby_id AND s.user_id = NEW.user_id AND s.kind = 'apple_photos';
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.baby_members_drop_apple_sync() FROM PUBLIC;
DROP TRIGGER IF EXISTS baby_members_drop_apple_sync ON public.baby_members;
CREATE TRIGGER baby_members_drop_apple_sync AFTER UPDATE OF role ON public.baby_members
  FOR EACH ROW EXECUTE FUNCTION public.baby_members_drop_apple_sync();

-------------------------------------------------------------------------------------------------
-- google_accounts: one Google connection per user. Written and deleted by the API under
-- service_role only (it must call encrypt_secret and revoke at Google first).
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.google_accounts (
  user_id            uuid        PRIMARY KEY REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  refresh_token_enc  bytea       NOT NULL,
  scope              text        NOT NULL,
  connected_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  refresh_failures   integer     NOT NULL DEFAULT 0,
  needs_reconnect    boolean     NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.google_accounts IS
  'Google Photos Picker connection per user (step 10, D6). refresh_token_enc = encrypt_secret(refresh token); never granted to any user role or to pipeline. Revoked at Google and deleted on disconnect / account deletion.';
COMMENT ON COLUMN public.google_accounts.refresh_token_enc IS
  'pgcrypto ciphertext under DATA_ENCRYPTION_KEY. Readable by service_role only; the worker gets the plaintext through import_google_refresh_token(). Never log the plaintext.';
COMMENT ON COLUMN public.google_accounts.needs_reconnect IS
  'Set when Google answered invalid_grant (revoked / expired); cleared by a new connect.';
ALTER TABLE public.google_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_accounts FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS google_accounts_set_updated_at ON public.google_accounts;
CREATE TRIGGER google_accounts_set_updated_at BEFORE UPDATE ON public.google_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A trigger, not CHECKs: service_role (BYPASSRLS) is the only writer, and a failing CHECK or NOT
-- NULL would put the whole row (ciphertext included) into the server log as DETAIL.
CREATE OR REPLACE FUNCTION public.google_accounts_shape() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.refresh_token_enc IS NULL OR octet_length(NEW.refresh_token_enc) < 1
     OR octet_length(NEW.refresh_token_enc) > 8192 THEN
    RAISE EXCEPTION 'google_accounts.refresh_token_enc must be encrypt_secret ciphertext' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.scope IS NULL OR length(NEW.scope) < 1 OR length(NEW.scope) > 2048 THEN
    RAISE EXCEPTION 'google_accounts.scope must be 1 to 2048 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.refresh_failures IS NULL OR NEW.refresh_failures < 0 THEN
    RAISE EXCEPTION 'google_accounts.refresh_failures must be zero or more' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.google_accounts_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS google_accounts_shape ON public.google_accounts;
CREATE TRIGGER google_accounts_shape BEFORE INSERT OR UPDATE ON public.google_accounts
  FOR EACH ROW EXECUTE FUNCTION public.google_accounts_shape();

GRANT ALL ON public.google_accounts TO service_role;
GRANT SELECT (user_id, connected_at, last_used_at, needs_reconnect) ON public.google_accounts TO authenticated;
DROP POLICY IF EXISTS google_accounts_authenticated_select ON public.google_accounts;
CREATE POLICY google_accounts_authenticated_select ON public.google_accounts FOR SELECT TO authenticated
  USING (user_id = public.auth_uid());

-------------------------------------------------------------------------------------------------
-- import_batches: one Google Picker session per batch.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.import_batches (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id              uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  requested_by         uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  kind                 text        NOT NULL CHECK (kind IN ('google_picker')),
  status               text        NOT NULL DEFAULT 'picking'
                                   CHECK (status IN ('picking', 'queued', 'running', 'done', 'failed', 'cancelled', 'expired')),
  error                text        CHECK (error IN ('google_denied', 'google_reconnect', 'session_expired', 'storage_error',
                                                  'requester_not_member', 'baby_trashed', 'too_many_items', 'internal')),
  provider_session_id  text        CHECK (length(provider_session_id) BETWEEN 1 AND 512),
  poll_interval_sec    integer     NOT NULL DEFAULT 5 CHECK (poll_interval_sec BETWEEN 1 AND 60),
  picker_expires_at    timestamptz,
  last_polled_at       timestamptz,
  tz_hint              text        CHECK (length(tz_hint) BETWEEN 1 AND 64),
  items_total          integer     CHECK (items_total >= 0),
  items_imported       integer     NOT NULL DEFAULT 0 CHECK (items_imported >= 0),
  items_duplicate      integer     NOT NULL DEFAULT 0 CHECK (items_duplicate >= 0),
  items_failed         integer     NOT NULL DEFAULT 0 CHECK (items_failed >= 0),
  items_skipped        integer     NOT NULL DEFAULT 0 CHECK (items_skipped >= 0),
  cancel_requested_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_batches_baby_id_created_at_idx ON public.import_batches (baby_id, created_at DESC);
CREATE INDEX IF NOT EXISTS import_batches_status_active_idx
  ON public.import_batches (status) WHERE status IN ('picking', 'queued', 'running');
CREATE INDEX IF NOT EXISTS import_batches_requested_by_idx ON public.import_batches (requested_by);
-- Backstop for "one import in progress per album" (the insert trigger serialises on the baby
-- row first, so callers normally see its fixed message instead).
CREATE UNIQUE INDEX IF NOT EXISTS import_batches_one_active_per_baby
  ON public.import_batches (baby_id) WHERE status IN ('picking', 'queued', 'running');
COMMENT ON TABLE public.import_batches IS
  'Google Photos Picker import batches (step 10). picking -> queued -> running -> done | failed; picking -> cancelled | expired; queued/running -> cancelled after cancel_requested_at. Kept for history; cascades with the baby.';
COMMENT ON COLUMN public.import_batches.provider_session_id IS
  'Google Picker session id. Written by the API under the requester''s claims, never readable by authenticated or viewer.';
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS import_batches_set_updated_at ON public.import_batches;
CREATE TRIGGER import_batches_set_updated_at BEFORE UPDATE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Every role: live baby; abandoned picking batches past their picker expiry (or 30 minutes,
-- IMPORT_PICKING_TTL_MIN, without one) are expired first so they do not block the album; then
-- one active batch per album and 20 per album per rolling 24 h (IMPORT_BATCHES_PER_BABY_PER_DAY).
-- Locks the baby row (NO KEY UPDATE, as data_exports_rate_limit) so concurrent requests serialise.
CREATE OR REPLACE FUNCTION public.import_batches_one_active() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  recent integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.babies b WHERE b.id = NEW.baby_id AND b.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'cannot import into a trashed album' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM public.babies b WHERE b.id = NEW.baby_id FOR NO KEY UPDATE;
  UPDATE public.import_batches ib
     SET status = 'expired', finished_at = now()
   WHERE ib.baby_id = NEW.baby_id
     AND ib.status = 'picking'
     AND coalesce(ib.picker_expires_at, ib.created_at + interval '30 minutes') < now();
  IF EXISTS (
    SELECT 1 FROM public.import_batches ib
    WHERE ib.baby_id = NEW.baby_id AND ib.status IN ('picking', 'queued', 'running')
  ) THEN
    RAISE EXCEPTION 'an import is already in progress for this album' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO recent
  FROM public.import_batches ib
  WHERE ib.baby_id = NEW.baby_id AND ib.created_at > now() - interval '24 hours';
  IF recent >= 20 THEN
    RAISE EXCEPTION 'import rate limit reached: 20 per album per day' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.import_batches_one_active() FROM PUBLIC;
DROP TRIGGER IF EXISTS import_batches_one_active ON public.import_batches;
CREATE TRIGGER import_batches_one_active BEFORE INSERT ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.import_batches_one_active();

-- User-role (authenticated) updates only; SECURITY INVOKER so current_user is the caller's role.
-- pipeline / service_role / SECURITY DEFINER functions are not constrained here.
--   picking          -> picking | queued | cancelled | expired
--                       (provider_session_id is set once; queued needs it; finished_at only
--                        when leaving to cancelled / expired)
--   queued | running -> same status; only cancel_requested_at may change, NULL -> a time
--   done | failed | cancelled | expired -> nothing
CREATE OR REPLACE FUNCTION public.import_batches_user_transitions() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'picking' THEN
    IF NEW.status NOT IN ('picking', 'queued', 'cancelled', 'expired')
       OR (OLD.provider_session_id IS NOT NULL
           AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id)
       OR (NEW.status = 'queued' AND NEW.provider_session_id IS NULL)
       OR (NEW.status IN ('picking', 'queued') AND NEW.finished_at IS NOT NULL) THEN
      RAISE EXCEPTION 'import batch transition not allowed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('queued', 'running') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id
       OR NEW.poll_interval_sec IS DISTINCT FROM OLD.poll_interval_sec
       OR NEW.picker_expires_at IS DISTINCT FROM OLD.picker_expires_at
       OR NEW.last_polled_at IS DISTINCT FROM OLD.last_polled_at
       OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
       OR (OLD.cancel_requested_at IS NOT NULL
           AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at) THEN
      RAISE EXCEPTION 'import batch transition not allowed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'import batch transition not allowed' USING ERRCODE = 'check_violation';
END
$$;
REVOKE EXECUTE ON FUNCTION public.import_batches_user_transitions() FROM PUBLIC;
DROP TRIGGER IF EXISTS import_batches_user_transitions ON public.import_batches;
CREATE TRIGGER import_batches_user_transitions BEFORE UPDATE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.import_batches_user_transitions();

GRANT ALL ON public.import_batches TO service_role;
GRANT SELECT (id, baby_id, requested_by, kind, status, error, poll_interval_sec, picker_expires_at,
              last_polled_at, tz_hint, items_total, items_imported, items_duplicate, items_failed,
              items_skipped, cancel_requested_at, created_at, started_at, finished_at, updated_at)
  ON public.import_batches TO authenticated;
GRANT INSERT (baby_id, requested_by, kind, tz_hint, provider_session_id) ON public.import_batches TO authenticated;
GRANT UPDATE (status, provider_session_id, poll_interval_sec, picker_expires_at, last_polled_at,
              cancel_requested_at, finished_at, updated_at)
  ON public.import_batches TO authenticated;
GRANT SELECT ON public.import_batches TO pipeline;
GRANT UPDATE (status, error, started_at, finished_at, items_total, items_imported, items_duplicate,
              items_failed, items_skipped, updated_at)
  ON public.import_batches TO pipeline;

-- Contributors may import (D1); their photos land pending (import_book_photo).
DROP POLICY IF EXISTS import_batches_authenticated_select ON public.import_batches;
CREATE POLICY import_batches_authenticated_select ON public.import_batches FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id) OR (requested_by = public.auth_uid() AND public.is_baby_member(baby_id)));
DROP POLICY IF EXISTS import_batches_authenticated_insert ON public.import_batches;
CREATE POLICY import_batches_authenticated_insert ON public.import_batches FOR INSERT TO authenticated
  WITH CHECK (requested_by = public.auth_uid() AND public.is_baby_member(baby_id) AND status = 'picking');
DROP POLICY IF EXISTS import_batches_authenticated_update ON public.import_batches;
CREATE POLICY import_batches_authenticated_update ON public.import_batches FOR UPDATE TO authenticated
  USING (requested_by = public.auth_uid() AND public.is_baby_member(baby_id))
  WITH CHECK (requested_by = public.auth_uid() AND public.is_baby_member(baby_id));
DROP POLICY IF EXISTS import_batches_pipeline_select ON public.import_batches;
CREATE POLICY import_batches_pipeline_select ON public.import_batches FOR SELECT TO pipeline USING (true);
DROP POLICY IF EXISTS import_batches_pipeline_update ON public.import_batches;
CREATE POLICY import_batches_pipeline_update ON public.import_batches FOR UPDATE TO pipeline
  USING (true) WITH CHECK (true);

-- SECURITY INVOKER on purpose (like upload_session_visible): import_items follows exactly the
-- caller's import_batches visibility.
CREATE OR REPLACE FUNCTION public.import_batch_visible(p_batch_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch_id)
$$;
REVOKE EXECUTE ON FUNCTION public.import_batch_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_batch_visible(uuid) TO authenticated, pipeline, service_role;

-------------------------------------------------------------------------------------------------
-- import_items: one per picked Google media item; `id` becomes `photos.id` (like upload_files).
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.import_items (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid        NOT NULL REFERENCES public.import_batches (id) ON DELETE CASCADE,
  baby_id           uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  provider_item_id  text        NOT NULL CHECK (length(provider_item_id) BETWEEN 1 AND 512),
  mime_hint         text        CHECK (mime_hint IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp')),
  width             integer     CHECK (width > 0),
  height            integer     CHECK (height > 0),
  taken_at_hint     timestamptz,
  bytes             bigint      CHECK (bytes IS NULL OR (bytes > 0 AND bytes <= 104857600)),
  sha256            bytea       CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'downloaded', 'booked', 'duplicate', 'failed', 'skipped')),
  error             text        CHECK (error IN ('unsupported_media_type', 'file_too_large', 'download_failed',
                                                 'free_tier_limit', 'storage_error', 'not_member', 'baby_trashed')),
  storage_key       text        NOT NULL GENERATED ALWAYS AS
                                ('babies/' || baby_id::text || '/originals/' || id::text) STORED,
  photo_id          uuid        REFERENCES public.photos (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_items_photo_id_is_id CHECK (photo_id IS NULL OR photo_id = id),
  CONSTRAINT import_items_batch_id_provider_item_id_key UNIQUE (batch_id, provider_item_id)
);
-- (batch_id) lookups use the unique index above.
CREATE INDEX IF NOT EXISTS import_items_status_open_idx
  ON public.import_items (status) WHERE status IN ('pending', 'downloaded');
CREATE INDEX IF NOT EXISTS import_items_baby_id_idx ON public.import_items (baby_id);
CREATE INDEX IF NOT EXISTS import_items_photo_id_idx ON public.import_items (photo_id) WHERE photo_id IS NOT NULL;
COMMENT ON TABLE public.import_items IS
  'One picked Google media item per row (step 10); id becomes photos.id via import_book_photo(). Written by pipeline only. Rows of finished batches are deleted 30 days after their last change.';
COMMENT ON COLUMN public.import_items.provider_item_id IS
  'Google mediaItem id (opaque). Never granted to authenticated or viewer.';
ALTER TABLE public.import_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_items FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS import_items_set_updated_at ON public.import_items;
CREATE TRIGGER import_items_set_updated_at BEFORE UPDATE ON public.import_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- An item belongs to a queued/running batch of the same baby, so its storage key (and the photo
-- it becomes) can never land in another baby's album.
CREATE OR REPLACE FUNCTION public.import_items_batch_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.import_batches b
    WHERE b.id = NEW.batch_id AND b.baby_id = NEW.baby_id AND b.status IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'import item must belong to an active batch of the same album' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.import_items_batch_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS import_items_batch_guard ON public.import_items;
CREATE TRIGGER import_items_batch_guard BEFORE INSERT ON public.import_items
  FOR EACH ROW EXECUTE FUNCTION public.import_items_batch_guard();

GRANT ALL ON public.import_items TO service_role;
GRANT SELECT (id, batch_id, baby_id, status, error, photo_id, created_at) ON public.import_items TO authenticated;
GRANT SELECT, INSERT ON public.import_items TO pipeline;
GRANT UPDATE (bytes, sha256, status, error, photo_id, mime_hint, width, height, taken_at_hint, updated_at)
  ON public.import_items TO pipeline;
GRANT DELETE ON public.import_items TO pipeline;

DROP POLICY IF EXISTS import_items_authenticated_select ON public.import_items;
CREATE POLICY import_items_authenticated_select ON public.import_items FOR SELECT TO authenticated
  USING (public.import_batch_visible(batch_id));
DROP POLICY IF EXISTS import_items_pipeline_select ON public.import_items;
CREATE POLICY import_items_pipeline_select ON public.import_items FOR SELECT TO pipeline USING (true);
DROP POLICY IF EXISTS import_items_pipeline_insert ON public.import_items;
CREATE POLICY import_items_pipeline_insert ON public.import_items FOR INSERT TO pipeline WITH CHECK (true);
DROP POLICY IF EXISTS import_items_pipeline_update ON public.import_items;
CREATE POLICY import_items_pipeline_update ON public.import_items FOR UPDATE TO pipeline
  USING (true) WITH CHECK (true);
-- Retention: 30 days after the last change, for a terminal item or any item of a finished
-- batch. Never a `downloaded` item (its object may still exist; the sweep fails it first).
DROP POLICY IF EXISTS import_items_pipeline_delete ON public.import_items;
CREATE POLICY import_items_pipeline_delete ON public.import_items FOR DELETE TO pipeline
  USING (
    status <> 'downloaded'
    AND updated_at < now() - interval '30 days'
    AND (status IN ('booked', 'duplicate', 'failed', 'skipped')
         OR NOT EXISTS (SELECT 1 FROM public.import_batches b
                        WHERE b.id = batch_id AND b.status IN ('picking', 'queued', 'running')))
  );

-------------------------------------------------------------------------------------------------
-- Worker functions (pipeline only; SECURITY DEFINER, owner rights, pinned search_path).
-------------------------------------------------------------------------------------------------
-- Why a batch cannot run, without revealing anything secret:
--   'ok' | 'not_active' (no such batch, or not queued/running) | 'not_member' (requester gone,
--   profile deleted, or no longer a member) | 'baby_trashed' | 'not_connected' | 'reconnect'.
CREATE OR REPLACE FUNCTION public.import_batch_requester_state(p_batch_id uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_batch record;
  v_reconnect boolean;
BEGIN
  SELECT b.baby_id, b.requested_by INTO v_batch
  FROM public.import_batches b
  WHERE b.id = p_batch_id AND b.status IN ('queued', 'running');
  IF NOT FOUND THEN
    RETURN 'not_active';
  END IF;
  IF v_batch.requested_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.baby_members m
    JOIN public.profiles p ON p.user_id = m.user_id AND p.deleted_at IS NULL
    WHERE m.baby_id = v_batch.baby_id AND m.user_id = v_batch.requested_by
  ) THEN
    RETURN 'not_member';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.babies bb WHERE bb.id = v_batch.baby_id AND bb.deleted_at IS NULL) THEN
    RETURN 'baby_trashed';
  END IF;
  SELECT g.needs_reconnect INTO v_reconnect FROM public.google_accounts g WHERE g.user_id = v_batch.requested_by;
  IF NOT FOUND THEN
    RETURN 'not_connected';
  END IF;
  IF v_reconnect THEN
    RETURN 'reconnect';
  END IF;
  RETURN 'ok';
END
$$;
COMMENT ON FUNCTION public.import_batch_requester_state(uuid) IS
  'ok | not_active | not_member | baby_trashed | not_connected | reconnect for an import batch. pipeline only; lets the worker pick the batch error without reading google_accounts.';

-- The requester's Google refresh token, only for a queued/running batch whose requester is a live
-- member of a live baby with a connection that does not need reconnecting; else NULL. Needs
-- app.data_key in the transaction (runAsPipeline(pool, { dataKey })). Never log the result.
CREATE OR REPLACE FUNCTION public.import_google_refresh_token(p_batch_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT public.decrypt_secret(g.refresh_token_enc)
  FROM public.import_batches b
  JOIN public.baby_members m ON m.baby_id = b.baby_id AND m.user_id = b.requested_by
  JOIN public.profiles p ON p.user_id = b.requested_by AND p.deleted_at IS NULL
  JOIN public.babies bb ON bb.id = b.baby_id AND bb.deleted_at IS NULL
  JOIN public.google_accounts g ON g.user_id = b.requested_by AND NOT g.needs_reconnect
  WHERE b.id = p_batch_id
    AND b.status IN ('queued', 'running')
  LIMIT 1
$$;
COMMENT ON FUNCTION public.import_google_refresh_token(uuid) IS
  'Plaintext Google refresh token of the batch requester, only while the batch is queued/running, the requester is a live member of the live baby and needs_reconnect is false; else NULL. pipeline only; needs app.data_key; never log the result.';

-- Google answered invalid_grant for this batch's requester: flag the connection. Only for an
-- active batch (the worker has no other way to name a user).
CREATE OR REPLACE FUNCTION public.import_mark_reconnect(p_batch_id uuid) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  UPDATE public.google_accounts g
     SET needs_reconnect = true, refresh_failures = g.refresh_failures + 1
   WHERE g.user_id = (SELECT b.requested_by FROM public.import_batches b
                      WHERE b.id = p_batch_id AND b.status IN ('queued', 'running'))
$$;
COMMENT ON FUNCTION public.import_mark_reconnect(uuid) IS
  'Sets needs_reconnect and increments refresh_failures on the Google connection of an active batch''s requester. pipeline only.';

-- Books one downloaded item as a photo (D10). Reads only the item and its batch; never takes an
-- approver, a role or a baby from the caller. Returns:
--   'booked'          photos row inserted (id = item id), item booked
--   'duplicate'       a live photo of the baby has the same SHA-256 (photos_baby_id_sha256_key)
--   'free_tier_limit' photos_free_tier_cap refused the insert
--   'not_member'      requester deleted, profile deleted, or no longer a member of the baby
--   'baby_trashed'    the baby is in the trash
-- On every outcome but 'booked' the item is left 'downloaded' for the worker to mark. Raises
-- (fixed messages) when the item is missing, not 'downloaded' with bytes/sha256/mime_hint set,
-- or its batch is not running.
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

REVOKE EXECUTE ON FUNCTION public.import_batch_requester_state(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.import_google_refresh_token(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.import_mark_reconnect(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.import_book_photo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_batch_requester_state(uuid) TO pipeline;
GRANT EXECUTE ON FUNCTION public.import_google_refresh_token(uuid) TO pipeline;
GRANT EXECUTE ON FUNCTION public.import_mark_reconnect(uuid) TO pipeline;
GRANT EXECUTE ON FUNCTION public.import_book_photo(uuid) TO pipeline;

-- Down Migration

DROP FUNCTION IF EXISTS public.import_book_photo(uuid);
DROP FUNCTION IF EXISTS public.import_mark_reconnect(uuid);
DROP FUNCTION IF EXISTS public.import_google_refresh_token(uuid);
DROP FUNCTION IF EXISTS public.import_batch_requester_state(uuid);

DROP TRIGGER IF EXISTS baby_members_drop_apple_sync ON public.baby_members;
DROP FUNCTION IF EXISTS public.baby_members_drop_apple_sync();

DROP TABLE IF EXISTS public.import_items;
DROP FUNCTION IF EXISTS public.import_items_batch_guard();
DROP FUNCTION IF EXISTS public.import_batch_visible(uuid);
DROP TABLE IF EXISTS public.import_batches;
DROP FUNCTION IF EXISTS public.import_batches_user_transitions();
DROP FUNCTION IF EXISTS public.import_batches_one_active();
DROP TABLE IF EXISTS public.google_accounts;
DROP FUNCTION IF EXISTS public.google_accounts_shape();
DROP TABLE IF EXISTS public.import_sources;
DROP FUNCTION IF EXISTS public.import_sources_insert_guard();
DROP FUNCTION IF EXISTS public.import_sources_shape();

DROP FUNCTION IF EXISTS public.decrypt_secret(bytea);
DROP FUNCTION IF EXISTS public.encrypt_secret(text);
