-- Up Migration

-- Step 2 (docs/plans/step-2.md 2.1-2.3, 2.7): guards, schema-level grants and the helper functions
-- every later migration's policies and triggers build on. Roles are created by the bootstrap
-- (src/bootstrap.ts), never by migrations; auth.users is created by GoTrue, which must have
-- started before this runs (Compose: db -> db-init -> auth -> migrate).

DO $guard$
DECLARE
  required_role text;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'auth.users is missing: start the auth (GoTrue) service before running migrations';
  END IF;
  FOREACH required_role IN ARRAY ARRAY[
    'tinyglow_api', 'tinyglow_worker', 'authenticated', 'viewer', 'pipeline', 'service_role', 'anon'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = required_role) THEN
      RAISE EXCEPTION 'role % is missing: run pnpm db:bootstrap before migrating', required_role;
    END IF;
  END LOOP;
END
$guard$;

-- Schema-level: nothing is reachable through PUBLIC; each app role gets USAGE only. `anon` gets
-- nothing (it exists only because GoTrue mints the claim). Tables the superuser creates from now
-- on are fully granted to service_role (API-internal, BYPASSRLS); every other role is granted per
-- table and per column in the migration that creates the table.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tinyglow_api, tinyglow_worker, authenticated, viewer, pipeline, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

-- pgcrypto symmetric decrypt is callable by PUBLIC by default; keep the plaintext path to the
-- two roles that may legitimately see coordinates (2.7). Encrypt stays PUBLIC (useless without key).
REVOKE EXECUTE ON FUNCTION public.pgp_sym_decrypt(bytea, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pgp_sym_decrypt(bytea, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pgp_sym_decrypt(bytea, text) TO pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.pgp_sym_decrypt(bytea, text, text) TO pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text) TO pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text, text) TO pipeline, service_role;

-------------------------------------------------------------------------------------------------
-- Per-transaction identity (2.3). The API verifies the GoTrue JWT and runs, on one client:
--   BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', $1, true); ...
-- These helpers read that setting. They are SECURITY INVOKER and cheap; the SECURITY DEFINER
-- membership helpers (is_baby_member, ...) are created with the tables they read.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_claims() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
COMMENT ON FUNCTION public.auth_claims() IS
  'JWT claims of the current transaction (request.jwt.claims GUC), or NULL when none were set.';

CREATE OR REPLACE FUNCTION public.auth_role() RETURNS text
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT public.auth_claims() ->> 'role'
$$;

CREATE OR REPLACE FUNCTION public.auth_uid() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN public.auth_role() = 'authenticated'
              THEN (public.auth_claims() ->> 'sub')::uuid END
$$;
COMMENT ON FUNCTION public.auth_uid() IS
  'auth.users.id of the signed-in user; NULL unless the claims carry role=authenticated.';

CREATE OR REPLACE FUNCTION public.auth_email() RETURNS text
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN public.auth_role() = 'authenticated'
              THEN lower(public.auth_claims() ->> 'email') END
$$;

CREATE OR REPLACE FUNCTION public.auth_share_link_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN public.auth_role() = 'viewer'
              THEN (public.auth_claims() ->> 'share_link_id')::uuid END
$$;
COMMENT ON FUNCTION public.auth_share_link_id() IS
  'share_links.id from a viewer session JWT; NULL unless the claims carry role=viewer.';

-------------------------------------------------------------------------------------------------
-- GPS never exists in plaintext (PRD "Location privacy"). photo_exif.raw_json carries a CHECK on
-- this function so a worker bug cannot smuggle coordinates in as JSON. Recursive: every object at
-- any depth (inside arrays too) is inspected; keys match by substring (gps, latitude, longitude),
-- word-start "geo" (GeoTag, geo_location; not ImageOrientation) or exactly lat / lng / lon.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jsonb_has_gps_keys(doc jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_path_exists(
    doc,
    '$.** ? (@.type() == "object").keyvalue()
       ? (@.key like_regex "gps|latitude|longitude|(^|[^a-z])geo|^(lat|lng|lon)$" flag "i")'
  )
$$;
COMMENT ON FUNCTION public.jsonb_has_gps_keys(jsonb) IS
  'True when any key at any depth looks like a coordinate (contains gps/latitude/longitude, starts a word with geo, or is exactly lat/lng/lon).';

-------------------------------------------------------------------------------------------------
-- Encryption at rest for coordinates (2.7): pgcrypto with the key supplied per transaction as a
-- bind parameter: SELECT set_config('app.data_key', $1, true). The key is never part of
-- statement text and never stored. Only pipeline and service_role transactions ever set the key,
-- so only they can encrypt or decrypt: a user-role (authenticated) transaction never carries it
-- and cannot call either function. Home coordinates are written by the API under service_role.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.encrypt_coord(coord double precision) RETURNS bytea
  LANGUAGE plpgsql VOLATILE STRICT
  SET search_path = pg_catalog, public
AS $$
DECLARE
  data_key text := current_setting('app.data_key', true);
BEGIN
  IF coalesce(data_key, '') = '' THEN
    RAISE EXCEPTION 'data key not set for this transaction' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN public.pgp_sym_encrypt(coord::text, data_key);
END
$$;

CREATE OR REPLACE FUNCTION public.decrypt_coord(enc bytea) RETURNS double precision
  LANGUAGE plpgsql STABLE STRICT
  SET search_path = pg_catalog, public
AS $$
DECLARE
  data_key text := current_setting('app.data_key', true);
BEGIN
  IF coalesce(data_key, '') = '' THEN
    RAISE EXCEPTION 'data key not set for this transaction' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN public.pgp_sym_decrypt(enc, data_key)::double precision;
END
$$;

-- Generic updated_at maintenance; attached per table.
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- EXECUTE grants: exactly the roles whose policies/statements call each helper.
REVOKE EXECUTE ON FUNCTION public.auth_claims() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_role() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_uid() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_email() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_share_link_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.jsonb_has_gps_keys(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.encrypt_coord(double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_coord(bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.auth_claims() TO authenticated, viewer, service_role;
GRANT EXECUTE ON FUNCTION public.auth_role() TO authenticated, viewer, service_role;
GRANT EXECUTE ON FUNCTION public.auth_uid() TO authenticated, viewer, service_role;
GRANT EXECUTE ON FUNCTION public.auth_email() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_share_link_id() TO viewer, service_role;
GRANT EXECUTE ON FUNCTION public.jsonb_has_gps_keys(jsonb) TO pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_coord(double precision) TO pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_coord(bytea) TO pipeline, service_role;

-- Down Migration

DROP FUNCTION IF EXISTS public.set_updated_at();
DROP FUNCTION IF EXISTS public.decrypt_coord(bytea);
DROP FUNCTION IF EXISTS public.encrypt_coord(double precision);
DROP FUNCTION IF EXISTS public.jsonb_has_gps_keys(jsonb);
DROP FUNCTION IF EXISTS public.auth_share_link_id();
DROP FUNCTION IF EXISTS public.auth_email();
DROP FUNCTION IF EXISTS public.auth_uid();
DROP FUNCTION IF EXISTS public.auth_role();
DROP FUNCTION IF EXISTS public.auth_claims();

GRANT EXECUTE ON FUNCTION public.pgp_sym_decrypt(bytea, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.pgp_sym_decrypt(bytea, text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text, text) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pgp_sym_decrypt(bytea, text) FROM pipeline, service_role;
REVOKE EXECUTE ON FUNCTION public.pgp_sym_decrypt(bytea, text, text) FROM pipeline, service_role;
REVOKE EXECUTE ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text) FROM pipeline, service_role;
REVOKE EXECUTE ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text, text) FROM pipeline, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM service_role;
REVOKE USAGE ON SCHEMA public FROM tinyglow_api, tinyglow_worker, authenticated, viewer, pipeline, service_role;
-- Restore the Postgres 15+ default (USAGE for everyone, no CREATE).
GRANT USAGE ON SCHEMA public TO PUBLIC;
