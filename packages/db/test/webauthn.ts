import type pg from "pg";

/**
 * GoTrue's passkey tables (`supabase/auth:v2.197.0`, migration `20260302000000_add_passkeys`),
 * as the dev and production stacks get them from the `auth` container (docs/plans/step-13.md 0.1,
 * 2.2; packages/db/README.md "GoTrue passkey tables (step 13)"). Test-only: created when a test
 * database has no GoTrue (CI's bare pgvector, local throwaway containers) so the cascade and grant
 * checks can run. Same column names, types and `ON DELETE CASCADE` foreign keys; no app-role
 * grants (GoTrue grants only to `supabase_auth_admin`, the owner). No-op when GoTrue already ran.
 */
export const WEBAUTHN_TABLES_STUB_SQL = `
CREATE TABLE IF NOT EXISTS auth.webauthn_credentials (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  credential_id      bytea NOT NULL UNIQUE,
  public_key         bytea NOT NULL,
  attestation_type   text,
  aaguid             uuid,
  sign_count         bigint NOT NULL DEFAULT 0,
  transports         jsonb,
  backup_eligible    boolean NOT NULL DEFAULT false,
  backed_up          boolean NOT NULL DEFAULT false,
  friendly_name      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_user_id_idx ON auth.webauthn_credentials (user_id);
CREATE TABLE IF NOT EXISTS auth.webauthn_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  challenge_type  text NOT NULL CHECK (challenge_type IN ('signup', 'registration', 'authentication')),
  session_data    jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_user_id_idx ON auth.webauthn_challenges (user_id);
`;

/** Create the two tables when absent. Returns true when the stub was created (no GoTrue here). */
export async function ensureWebauthnTables(client: pg.Client | pg.PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('auth.webauthn_credentials') IS NOT NULL AS present",
  );
  if (rows[0]?.present) return false;
  await client.query(WEBAUTHN_TABLES_STUB_SQL);
  return true;
}
