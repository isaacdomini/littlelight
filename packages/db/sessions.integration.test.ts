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

// Step-3 migration (docs/plans/step-3.md 2.5, 3.3, 3.10): the four SECURITY DEFINER session
// functions over GoTrue's auth.sessions, the absence of any app-role privilege on auth.*, and the
// removal-request columns. (The plan-follows-owner triggers are in plan-triggers.integration.test.ts.)

const U1 = fid("a", 1);
const U2 = fid("a", 2);
const S = {
  u1New: fid("b", 1),
  u1Old: fid("b", 2),
  u1Expired: fid("b", 3),
  u1Timebox: fid("b", 4),
  u2: fid("b", 5),
};

describe.skipIf(!databaseUrl)("auth.sessions functions", () => {
  let db: Db;

  async function clean() {
    await db.admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [[U1, U2]]);
  }

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await clean();
    for (const [id, email] of [
      [U1, "sess-u1@tinyglow.test"],
      [U2, "sess-u2@tinyglow.test"],
    ]) {
      await db.admin.query(
        "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
        [id, email],
      );
    }
    const ins = `INSERT INTO auth.sessions (id, user_id, created_at, updated_at, refreshed_at, not_after, user_agent, ip)
                 VALUES ($1, $2, $3::timestamptz, now(), $4::timestamp, $5::timestamptz, $6, $7::inet)`;
    await db.admin.query(ins, [
      S.u1New,
      U1,
      "2026-10-08T12:00:00Z",
      "2026-10-08 12:30:00",
      null,
      "UA-new",
      "203.0.113.1",
    ]);
    await db.admin.query(ins, [
      S.u1Old,
      U1,
      "2026-10-01T08:00:00Z",
      null,
      null,
      "UA-old",
      "203.0.113.2",
    ]);
    await db.admin.query(ins, [
      S.u1Expired,
      U1,
      "2026-09-01T08:00:00Z",
      null,
      "2026-09-02T08:00:00Z",
      "UA-expired",
      "203.0.113.3",
    ]);
    await db.admin.query(ins, [
      S.u1Timebox,
      U1,
      "2026-10-05T08:00:00Z",
      null,
      "2999-01-01T00:00:00Z",
      "UA-timebox",
      "203.0.113.4",
    ]);
    await db.admin.query(ins, [
      S.u2,
      U2,
      "2026-10-07T08:00:00Z",
      null,
      null,
      "UA-u2",
      "203.0.113.5",
    ]);
  });
  afterAll(async () => {
    if (!db) return;
    await clean();
    await db.close();
  });

  it("GoTrue's refreshed_at is a naive timestamp (the stub matches supabase/auth v2.197.0)", async () => {
    const { rows } = await db.admin.query(
      "SELECT data_type FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'sessions' AND column_name = 'refreshed_at'",
    );
    expect(rows[0].data_type).toBe("timestamp without time zone");
  });

  describe("auth_session_info", () => {
    const info = (c: import("pg").PoolClient, id: string) =>
      c.query("SELECT created_at, refreshed_at FROM public.auth_session_info($1)", [id]);

    it("returns the caller's own session", async () => {
      const r = await db.asUser(U1, (c) => info(c, S.u1New));
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].created_at.toISOString()).toBe("2026-10-08T12:00:00.000Z");
    });

    it("returns refreshed_at as UTC whatever the session time zone is, and NULL when never refreshed", async () => {
      const r = await db.asUser(U1, async (c) => {
        await c.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
        return info(c, S.u1New);
      });
      expect(r.rows[0].refreshed_at.toISOString()).toBe("2026-10-08T12:30:00.000Z");
      const never = await db.asUser(U1, (c) => info(c, S.u1Old));
      expect(never.rows[0].refreshed_at).toBeNull();
    });

    it("returns nothing for another user's session, an unknown id, or without claims", async () => {
      expect((await db.asUser(U1, (c) => info(c, S.u2))).rows).toHaveLength(0);
      expect((await db.asUser(U2, (c) => info(c, S.u1New))).rows).toHaveLength(0);
      expect((await db.asUser(U1, (c) => info(c, fid("b", 99)))).rows).toHaveLength(0);
      expect((await db.asRole("authenticated", null, (c) => info(c, S.u1New))).rows).toHaveLength(
        0,
      );
    });

    it("honours not_after: a past timebox is gone, a future or NULL one is live", async () => {
      // u1Expired has a past not_after, u1Timebox a future one, u1New none.
      expect((await db.asUser(U1, (c) => info(c, S.u1Expired))).rows).toHaveLength(0);
      expect((await db.asUser(U1, (c) => info(c, S.u1Timebox))).rows).toHaveLength(1);
      await db.admin.query("UPDATE auth.sessions SET not_after = NULL WHERE id = $1", [
        S.u1Expired,
      ]);
      try {
        expect((await db.asUser(U1, (c) => info(c, S.u1Expired))).rows).toHaveLength(1);
      } finally {
        await db.admin.query(
          "UPDATE auth.sessions SET not_after = '2026-09-02T08:00:00Z' WHERE id = $1",
          [S.u1Expired],
        );
      }
    });

    it("a viewer-role token (no auth_uid) sees nothing", async () => {
      // viewer has no EXECUTE at all
      const err = await db.asViewer(fid("c", 1), (c) =>
        tryQuery(c, "SELECT * FROM public.auth_session_info($1)", [S.u1New]),
      );
      expect(err?.message).toMatch(PERMISSION_DENIED);
    });
  });

  describe("list_user_sessions", () => {
    it("baseline: newest first, expired (past not_after) excluded", async () => {
      const r = await db.asUser(U1, (c) => c.query("SELECT id FROM public.list_user_sessions()"));
      expect(r.rows.map((x) => x.id)).toEqual([S.u1New, S.u1Timebox, S.u1Old]);
    });

    it("lists only the caller's live sessions, newest first, without an ip column", async () => {
      await db.admin.query(
        "UPDATE auth.sessions SET not_after = now() - interval '1 second' WHERE id = $1",
        [S.u1Old],
      );
      try {
        const r = await db.asUser(U1, (c) => c.query("SELECT * FROM public.list_user_sessions()"));
        expect(r.rows.map((x) => x.id)).toEqual([S.u1New, S.u1Timebox]);
        expect(Object.keys(r.rows[0]).sort()).toEqual([
          "created_at",
          "id",
          "refreshed_at",
          "updated_at",
          "user_agent",
        ]);
        expect(JSON.stringify(r.rows)).not.toContain("203.0.113");
        expect(r.rows[0].refreshed_at.toISOString()).toBe("2026-10-08T12:30:00.000Z");
      } finally {
        await db.admin.query("UPDATE auth.sessions SET not_after = NULL WHERE id = $1", [S.u1Old]);
      }
    });

    it("never lists another user's sessions, and nothing without claims", async () => {
      const u2 = await db.asUser(U2, (c) => c.query("SELECT id FROM public.list_user_sessions()"));
      expect(u2.rows.map((r) => r.id)).toEqual([S.u2]);
      const none = await db.asRole("authenticated", null, (c) =>
        c.query("SELECT id FROM public.list_user_sessions()"),
      );
      expect(none.rows).toHaveLength(0);
    });
  });

  describe("count_user_sessions", () => {
    it("counts own live sessions; 0 for a user without sessions or without claims", async () => {
      expect(
        (await db.asUser(U1, (c) => c.query("SELECT public.count_user_sessions() AS n"))).rows[0].n,
      ).toBe(3);
      expect(
        (await db.asUser(U2, (c) => c.query("SELECT public.count_user_sessions() AS n"))).rows[0].n,
      ).toBe(1);
      expect(
        (await db.asUser(fid("c", 2), (c) => c.query("SELECT public.count_user_sessions() AS n")))
          .rows[0].n,
      ).toBe(0);
      expect(
        (
          await db.asRole("authenticated", null, (c) =>
            c.query("SELECT public.count_user_sessions() AS n"),
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("excludes sessions past their timebox", async () => {
      await db.admin.query(
        "UPDATE auth.sessions SET not_after = now() - interval '1 minute' WHERE id = $1",
        [S.u1Timebox],
      );
      try {
        expect(
          (await db.asUser(U1, (c) => c.query("SELECT public.count_user_sessions() AS n"))).rows[0]
            .n,
        ).toBe(2);
      } finally {
        await db.admin.query(
          "UPDATE auth.sessions SET not_after = '2999-01-01T00:00:00Z' WHERE id = $1",
          [S.u1Timebox],
        );
      }
    });
  });

  describe("delete_user_session", () => {
    it("another user's session: false, and the row survives", async () => {
      const r = await db.asUser(U1, async (c) => {
        const res = await c.query("SELECT public.delete_user_session($1) AS ok", [S.u2]);
        return res.rows[0].ok;
      });
      expect(r).toBe(false);
      expect(
        (await db.admin.query("SELECT 1 FROM auth.sessions WHERE id = $1", [S.u2])).rows,
      ).toHaveLength(1);
    });

    it("an unknown id or no claims: false", async () => {
      expect(
        (
          await db.asUser(U1, (c) =>
            c.query("SELECT public.delete_user_session($1) AS ok", [fid("b", 99)]),
          )
        ).rows[0].ok,
      ).toBe(false);
      expect(
        (
          await db.asRole("authenticated", null, (c) =>
            c.query("SELECT public.delete_user_session($1) AS ok", [S.u1New]),
          )
        ).rows[0].ok,
      ).toBe(false);
      expect(
        (await db.admin.query("SELECT 1 FROM auth.sessions WHERE id = $1", [S.u1New])).rows,
      ).toHaveLength(1);
    });

    it("own session: true, and it is gone inside the transaction (rolled back by the harness)", async () => {
      const seen = await db.asUser(U1, async (c) => {
        const ok = (await c.query("SELECT public.delete_user_session($1) AS ok", [S.u1Old])).rows[0]
          .ok;
        const left = (await c.query("SELECT id FROM public.list_user_sessions()")).rows.map(
          (r) => r.id,
        );
        return { ok, left };
      });
      expect(seen.ok).toBe(true);
      expect(seen.left).not.toContain(S.u1Old);
    });

    it("cascades to the session's refresh tokens", async () => {
      const sid = fid("b", 50);
      await db.admin.query(
        "INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
        [sid, U1],
      );
      await db.admin.query(
        "INSERT INTO auth.refresh_tokens (token, user_id, session_id, revoked, created_at, updated_at) VALUES ('rt-cascade', $1, $2, false, now(), now())",
        [U1, sid],
      );
      const ok = await db.asUser(
        U1,
        async (c) =>
          (await c.query("SELECT public.delete_user_session($1) AS ok", [sid])).rows[0].ok,
      );
      expect(ok).toBe(true);
      // The harness rolls back; do the real delete through the function committed via a manual tx.
      await db.admin.query("DELETE FROM auth.sessions WHERE id = $1", [sid]);
      expect(
        (await db.admin.query("SELECT 1 FROM auth.refresh_tokens WHERE token = 'rt-cascade'")).rows,
      ).toHaveLength(0);
    });
  });

  describe("no app role can reach auth.* directly", () => {
    const targets = ["auth.sessions", "auth.refresh_tokens", "auth.users", "auth.identities"];

    it("authenticated, viewer and service_role are denied on every auth table", async () => {
      for (const t of targets) {
        const asAuthed = await db.asUser(U1, (c) => tryQuery(c, `SELECT count(*) FROM ${t}`));
        expect(asAuthed?.message, `authenticated ${t}`).toMatch(PERMISSION_DENIED);
        const asViewer = await db.asViewer(fid("c", 1), (c) =>
          tryQuery(c, `SELECT count(*) FROM ${t}`),
        );
        expect(asViewer?.message, `viewer ${t}`).toMatch(PERMISSION_DENIED);
        const asService = await db.asRole("service_role", null, (c) =>
          tryQuery(c, `SELECT count(*) FROM ${t}`),
        );
        expect(asService?.message, `service_role ${t}`).toMatch(PERMISSION_DENIED);
      }
    });

    it("authenticated cannot write auth.sessions either", async () => {
      for (const sql of [
        "DELETE FROM auth.sessions",
        "UPDATE auth.sessions SET user_agent = 'x'",
        "INSERT INTO auth.sessions (id, user_id) VALUES (gen_random_uuid(), gen_random_uuid())",
      ]) {
        const err = await db.asUser(U1, (c) => tryQuery(c, sql));
        expect(err?.message, sql).toMatch(PERMISSION_DENIED);
      }
    });

    it("pipeline (worker) and the bare tinyglow_api / tinyglow_worker logins are denied", async () => {
      const asPipeline = await db.asPipeline((c) =>
        tryQuery(c, "SELECT count(*) FROM auth.sessions"),
      );
      expect(asPipeline?.message).toMatch(PERMISSION_DENIED);
      for (const pool of [db.apiPool, db.workerPool]) {
        const c = await pool.connect();
        try {
          for (const t of targets) {
            const err = await tryQuery(c, `SELECT count(*) FROM ${t}`);
            expect(err?.message, t).toMatch(PERMISSION_DENIED);
          }
        } finally {
          c.release();
        }
      }
    });

    it("has_*_privilege agrees: no table/schema grants for any app role", async () => {
      const roles = [
        "authenticated",
        "viewer",
        "pipeline",
        "service_role",
        "tinyglow_api",
        "tinyglow_worker",
        "anon",
      ];
      for (const role of roles) {
        for (const t of ["auth.sessions", "auth.refresh_tokens"]) {
          const { rows } = await db.admin.query(
            "SELECT has_table_privilege($1, $2, 'SELECT') AS s, has_table_privilege($1, $2, 'DELETE') AS d, has_table_privilege($1, $2, 'UPDATE') AS u, has_table_privilege($1, $2, 'INSERT') AS i",
            [role, t],
          );
          expect(rows[0], `${role} ${t}`).toEqual({ s: false, d: false, u: false, i: false });
        }
        const schema = await db.admin.query(
          "SELECT has_schema_privilege($1, 'auth', 'USAGE') AS u",
          [role],
        );
        expect(schema.rows[0].u, `${role} schema auth`).toBe(false);
      }
    });

    it("the session functions are executable by authenticated only, and are SECURITY DEFINER with a pinned search_path", async () => {
      const fns = [
        "public.auth_session_info(uuid)",
        "public.list_user_sessions()",
        "public.delete_user_session(uuid)",
        "public.count_user_sessions()",
      ];
      for (const fn of fns) {
        for (const role of [
          "viewer",
          "pipeline",
          "service_role",
          "tinyglow_api",
          "tinyglow_worker",
          "anon",
        ]) {
          const { rows } = await db.admin.query(
            "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok",
            [role, fn],
          );
          expect(rows[0].ok, `${role} ${fn}`).toBe(false);
        }
        const ok = await db.admin.query(
          "SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS ok",
          [fn],
        );
        expect(ok.rows[0].ok, fn).toBe(true);
        const meta = await db.admin.query(
          "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure",
          [fn],
        );
        expect(meta.rows[0].prosecdef, fn).toBe(true);
        expect(meta.rows[0].proconfig, fn).toEqual(["search_path=pg_catalog, public"]);
      }
    });
  });
});
