/**
 * Test/CI-only helpers (docs/plans/step-2.md 2.1 and 2.10). Nothing here runs in the dev or
 * production stacks: there, GoTrue creates `auth.users` itself and every service receives its own
 * `DATABASE_URL`.
 */

import type pg from "pg";

/**
 * Column list of `auth.users` the seed inserts (docs/plans/step-2.md 2.9). The stub below has
 * exactly these columns so the seed works against a bare pgvector in CI. GoTrue's real table has
 * many more; the seed never touches them.
 */
export const AUTH_USERS_STUB_SQL = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  instance_id                  uuid,
  id                           uuid PRIMARY KEY,
  aud                          varchar(255),
  role                         varchar(255),
  email                        varchar(255),
  encrypted_password           varchar(255),
  email_confirmed_at           timestamptz,
  confirmation_token           varchar(255),
  recovery_token               varchar(255),
  email_change                 varchar(255),
  email_change_token_new       varchar(255),
  email_change_token_current   varchar(255) DEFAULT '',
  phone_change                 text DEFAULT '',
  phone_change_token           varchar(255) DEFAULT '',
  reauthentication_token       varchar(255) DEFAULT '',
  raw_app_meta_data            jsonb,
  raw_user_meta_data           jsonb,
  is_sso_user                  boolean NOT NULL DEFAULT false,
  is_anonymous                 boolean NOT NULL DEFAULT false,
  created_at                   timestamptz,
  updated_at                   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_partial_key ON auth.users (email) WHERE is_sso_user = false;
CREATE TABLE IF NOT EXISTS auth.identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider_id      text NOT NULL,
  provider         text NOT NULL,
  identity_data    jsonb NOT NULL,
  last_sign_in_at  timestamptz,
  created_at       timestamptz,
  updated_at       timestamptz,
  CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider)
);
-- auth.sessions / auth.refresh_tokens as supabase/auth v2.197.0 creates them (same column names
-- and types; verified against \`auth migrate\` of that image in docs/plans/step-3.md 3.3S), minus
-- the FK to auth.oauth_clients. The step-3 session functions read auth.sessions and API
-- integration tests insert rows here. Note refreshed_at is timestamp WITHOUT time zone and ip is
-- inet, exactly like GoTrue.
DO $stub$ BEGIN
  CREATE TYPE auth.aal_level AS ENUM ('aal1', 'aal2', 'aal3');
EXCEPTION WHEN duplicate_object THEN NULL;
END $stub$;
CREATE TABLE IF NOT EXISTS auth.sessions (
  id                      uuid PRIMARY KEY,
  user_id                 uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at              timestamptz,
  updated_at              timestamptz,
  factor_id               uuid,
  aal                     auth.aal_level,
  not_after               timestamptz,
  refreshed_at            timestamp without time zone,
  user_agent              text,
  ip                      inet,
  tag                     text,
  oauth_client_id         uuid,
  refresh_token_hmac_key  text,
  refresh_token_counter   bigint,
  scopes                  text,
  CONSTRAINT sessions_scopes_length CHECK (char_length(scopes) <= 4096)
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON auth.sessions (user_id);
CREATE INDEX IF NOT EXISTS user_id_created_at_idx ON auth.sessions (user_id, created_at);
CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  instance_id  uuid,
  id           bigserial PRIMARY KEY,
  token        varchar(255),
  user_id      varchar(255),
  revoked      boolean,
  created_at   timestamptz,
  updated_at   timestamptz,
  parent       varchar(255),
  session_id   uuid REFERENCES auth.sessions (id) ON DELETE CASCADE,
  CONSTRAINT refresh_tokens_token_unique UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS refresh_tokens_session_id_revoked_idx ON auth.refresh_tokens (session_id, revoked);
`;

/**
 * Create a minimal `auth.users` / `auth.identities` when GoTrue has not run (CI's bare pgvector
 * service; local throwaway containers). No-op when `auth.users` already exists, so it is safe to
 * call before every migration run. Needs a superuser client (the stub is owned by the caller).
 */
export async function ensureAuthSchemaStub(client: pg.Client | pg.PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('auth.users') IS NOT NULL AS present",
  );
  if (rows[0]?.present) return false;
  await client.query(AUTH_USERS_STUB_SQL);
  return true;
}

/**
 * Rewrite the user and password of a `postgres://` URL so tests can connect as an app role
 * (`tinyglow_api`, `tinyglow_worker`) while fixtures still use the superuser URL.
 * The returned string contains the password: never log it.
 */
export function appRoleUrl(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}
