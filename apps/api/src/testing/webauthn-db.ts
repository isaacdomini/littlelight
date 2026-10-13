import type pg from "pg";

// GoTrue's passkey tables for the API integration tests (docs/plans/step-13.md 2.2; the same
// stub as packages/db/test/webauthn.ts, kept in this package so the api's tsconfig stays inside
// `src/`). Created only when the test database has no GoTrue; a GoTrue-migrated database already
// has the real tables and this is a no-op. Columns, types and `ON DELETE CASCADE` FKs match
// `supabase/auth:v2.197.0` migration `20260302000000_add_passkeys`; no app-role grants.

const SQL = `
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
CREATE TABLE IF NOT EXISTS auth.webauthn_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  challenge_type  text NOT NULL CHECK (challenge_type IN ('signup', 'registration', 'authentication')),
  session_data    jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
`;

export async function ensureWebauthnTables(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('auth.webauthn_credentials') IS NOT NULL AS present",
  );
  if (!rows[0]?.present) await client.query(SQL);
}

/** Insert one credential and one registration challenge for `userId` (superuser client). */
export async function seedPasskeyRows(client: pg.Client, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO auth.webauthn_credentials (user_id, credential_id, public_key, attestation_type, sign_count, friendly_name)
     VALUES ($1, $2, $3, 'none', 0, 'Test key')`,
    [userId, Buffer.from(`${userId}:${Date.now()}:${Math.random()}`), Buffer.from("pk")],
  );
  await client.query(
    `INSERT INTO auth.webauthn_challenges (user_id, challenge_type, session_data, expires_at)
     VALUES ($1, 'registration', '{"challenge":"x"}', now() + interval '5 minutes')`,
    [userId],
  );
}

export async function passkeyRowCounts(
  client: pg.Client,
  userId: string,
): Promise<{ credentials: number; challenges: number }> {
  const c = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM auth.webauthn_credentials WHERE user_id = $1",
    [userId],
  );
  const ch = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM auth.webauthn_challenges WHERE user_id = $1",
    [userId],
  );
  return { credentials: Number(c.rows[0]?.n), challenges: Number(ch.rows[0]?.n) };
}
