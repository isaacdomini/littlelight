import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connect,
  type Db,
  databaseUrl,
  ensureMigrated,
  fid,
  PERMISSION_DENIED,
  tryQuery,
} from "./test/harness";
import { ensureWebauthnTables } from "./test/webauthn";

// Step 13 (docs/plans/step-13.md 2.2, 0.1 decision f; task 13.2 hand check made repeatable):
// GoTrue owns `auth.webauthn_credentials` / `auth.webauthn_challenges`. Deleting the `auth.users`
// row (what account deletion does through GoTrue's admin API) must cascade to both; no app role
// may read them; nothing in `public` depends on them. Against a GoTrue-migrated database the real
// tables are used; against a bare one the stub in test/webauthn.ts stands in (same FKs).

const U1 = fid("c", 1);
const U2 = fid("c", 2);

describe.skipIf(!databaseUrl)("GoTrue passkey tables", () => {
  let db: Db;

  async function clean() {
    await db.admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [[U1, U2]]);
    await db.admin.query(
      "DELETE FROM auth.webauthn_challenges WHERE user_id IS NULL AND session_data->>'test' = 'webauthn-it'",
    );
  }

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await ensureWebauthnTables(db.admin);
    await clean();
    for (const [id, email] of [
      [U1, "webauthn-u1@tinyglow.test"],
      [U2, "webauthn-u2@tinyglow.test"],
    ]) {
      await db.admin.query(
        "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
        [id, email],
      );
    }
  });

  afterAll(async () => {
    await clean();
    await db?.close();
  });

  const counts = async (user: string) => {
    const c = await db.admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM auth.webauthn_credentials WHERE user_id = $1",
      [user],
    );
    const ch = await db.admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM auth.webauthn_challenges WHERE user_id = $1",
      [user],
    );
    return { credentials: Number(c.rows[0]?.n), challenges: Number(ch.rows[0]?.n) };
  };

  it("both tables exist with the documented FKs (ON DELETE CASCADE to auth.users)", async () => {
    const { rows } = await db.admin.query<{ table_name: string; delete_rule: string }>(
      `SELECT tc.table_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_schema = 'auth'
          AND tc.table_name IN ('webauthn_credentials', 'webauthn_challenges')
          AND kcu.column_name = 'user_id'`,
    );
    expect(rows.map((r) => `${r.table_name}:${r.delete_rule}`).sort()).toEqual([
      "webauthn_challenges:CASCADE",
      "webauthn_credentials:CASCADE",
    ]);
  });

  it("deleting the auth.users row removes the user's credentials and challenges (0 / 0); another user's rows and anonymous authentication challenges stay", async () => {
    const insertCredential = (user: string) =>
      db.admin.query(
        `INSERT INTO auth.webauthn_credentials (user_id, credential_id, public_key, attestation_type, sign_count, friendly_name)
         VALUES ($1, $2, $3, 'none', 0, 'Test key')`,
        [user, Buffer.from(randomUUID()), Buffer.from("pk")],
      );
    await insertCredential(U1);
    await insertCredential(U1);
    await insertCredential(U2);
    await db.admin.query(
      `INSERT INTO auth.webauthn_challenges (user_id, challenge_type, session_data, expires_at)
       VALUES ($1, 'registration', '{"challenge":"x"}', now() + interval '5 minutes')`,
      [U1],
    );
    await db.admin.query(
      `INSERT INTO auth.webauthn_challenges (user_id, challenge_type, session_data, expires_at)
       VALUES (NULL, 'authentication', '{"challenge":"y","test":"webauthn-it"}', now() + interval '5 minutes')`,
    );
    expect(await counts(U1)).toEqual({ credentials: 2, challenges: 1 });
    expect(await counts(U2)).toEqual({ credentials: 1, challenges: 0 });

    // What GoTrue's `DELETE /admin/users/{id}` does.
    await db.admin.query("DELETE FROM auth.users WHERE id = $1", [U1]);

    expect(await counts(U1)).toEqual({ credentials: 0, challenges: 0 });
    expect(await counts(U2)).toEqual({ credentials: 1, challenges: 0 });
    const anon = await db.admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM auth.webauthn_challenges WHERE user_id IS NULL AND session_data->>'test' = 'webauthn-it'",
    );
    expect(Number(anon.rows[0]?.n)).toBe(1);
  });

  it("the tinyglow_api login role and every app role get permission denied for schema auth on both tables", async () => {
    // Direct connection as tinyglow_api, no SET ROLE: the pool role itself.
    const direct = await db.apiPool.connect();
    try {
      for (const table of ["auth.webauthn_credentials", "auth.webauthn_challenges"]) {
        const err = await tryQuery(direct, `SELECT count(*) FROM ${table}`);
        expect(err, table).not.toBeNull();
        expect(err?.message, table).toMatch(PERMISSION_DENIED);
        expect(err?.message, table).toMatch(/schema auth/);
      }
    } finally {
      direct.release();
    }
    for (const role of ["authenticated", "viewer", "service_role"]) {
      await db.asRole(role, role === "authenticated" ? { sub: U2, role } : null, async (c) => {
        for (const table of ["auth.webauthn_credentials", "auth.webauthn_challenges"]) {
          const err = await tryQuery(c, `SELECT count(*) FROM ${table}`);
          expect(err, `${role} ${table}`).not.toBeNull();
          expect(err?.message, `${role} ${table}`).toMatch(PERMISSION_DENIED);
          const ins = await tryQuery(
            c,
            `INSERT INTO auth.webauthn_challenges (user_id, challenge_type, session_data, expires_at) VALUES (NULL, 'authentication', '{}', now())`,
          );
          expect(ins?.message, `${role} insert`).toMatch(PERMISSION_DENIED);
        }
      });
    }
    await db.asPipeline(async (c) => {
      const err = await tryQuery(c, "SELECT count(*) FROM auth.webauthn_credentials");
      expect(err?.message).toMatch(PERMISSION_DENIED);
    });
  });

  it("nothing in the public schema references the passkey tables (functions, views, dependencies)", async () => {
    const fns = await db.admin.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosrc ILIKE '%webauthn%'`,
    );
    expect(fns.rows).toEqual([]);
    const views = await db.admin.query<{ viewname: string }>(
      "SELECT viewname FROM pg_views WHERE schemaname = 'public' AND definition ILIKE '%webauthn%'",
    );
    expect(views.rows).toEqual([]);
    const deps = await db.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_depend d
         JOIN pg_class c ON c.oid = d.refobjid
         JOIN pg_namespace cn ON cn.oid = c.relnamespace
         JOIN pg_class dc ON dc.oid = d.objid
         JOIN pg_namespace dn ON dn.oid = dc.relnamespace
        WHERE cn.nspname = 'auth' AND c.relname LIKE 'webauthn_%' AND dn.nspname = 'public'`,
    );
    expect(Number(deps.rows[0]?.n)).toBe(0);
  });
});
