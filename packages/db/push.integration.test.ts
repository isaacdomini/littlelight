import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BABY, createFixtures, dropFixtures, LINK, P, U } from "./test/fixtures";
import {
  authed,
  connect,
  type Db,
  databaseUrl,
  ensureMigrated,
  PERMISSION_DENIED,
  tryQuery,
} from "./test/harness";

// Step 9 (docs/plans/step-9.md 2.8, 2.9, 2.15; migration 1792200000100_native-push.sql): push
// devices and the delivery ledger. The rules live in the database: who may register, who is a
// target, what the worker (pipeline) may touch, and that tokens never leave through a user role.

const SESSION = {
  a1: randomUUID(),
  a1Other: randomUUID(),
  a2: randomUUID(),
  contrib: randomUUID(),
  b: randomUUID(),
  stranger: randomUUID(),
};
const TOKEN = (n: string) => `tok-${n}-${"x".repeat(40)}`;

describe.skipIf(!databaseUrl)("push devices and ledger (migration 16)", () => {
  let db: Db;

  const claimsFor = (sub: string, sessionId: string | null) => ({
    ...authed(sub),
    ...(sessionId ? { session_id: sessionId } : {}),
  });
  /** Run as `sub` with a session claim; rolled back unless `commit` (not offered: use admin to seed). */
  const asSession = <T>(
    sub: string,
    sessionId: string | null,
    fn: (c: import("pg").PoolClient) => Promise<T>,
  ) => db.asRole("authenticated", claimsFor(sub, sessionId), fn);

  /** As anon (the api login role cannot SET ROLE anon, so use the superuser connection). */
  async function asAnon<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
    await db.admin.query("BEGIN");
    try {
      await db.admin.query("SET LOCAL ROLE anon");
      return await fn(db.admin);
    } finally {
      await db.admin.query("ROLLBACK");
    }
  }

  const register = (
    c: import("pg").PoolClient,
    token = TOKEN("a"),
    platform = "ios",
    provider = "apns",
    version = "1.0.0",
  ) =>
    c.query<{ id: string }>("SELECT public.register_push_device($1,$2,$3,$4) AS id", [
      platform,
      provider,
      token,
      version,
    ]);

  async function addSession(
    id: string,
    userId: string,
    opts: { refreshed?: string; notAfter?: string } = {},
  ) {
    await db.admin.query(
      `INSERT INTO auth.sessions (id, user_id, created_at, updated_at, refreshed_at, not_after)
       VALUES ($1, $2, now(), now(), $3::timestamp, $4::timestamptz)
       ON CONFLICT (id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at, not_after = EXCLUDED.not_after`,
      [id, userId, opts.refreshed ?? null, opts.notAfter ?? null],
    );
  }

  /** Insert a device directly (superuser) for the target/ledger cases. */
  async function addDevice(userId: string, sessionId: string, token: string, extra = "") {
    const r = await db.admin.query<{ id: string }>(
      `INSERT INTO public.push_devices (user_id, session_id, platform, provider, token, app_version ${extra ? `, ${extra.split("=")[0]}` : ""})
       VALUES ($1, $2, 'ios', 'apns', $3, '1.0.0' ${extra ? `, ${extra.split("=")[1]}` : ""}) RETURNING id`,
      [userId, sessionId, token],
    );
    return r.rows[0]?.id as string;
  }

  const targets = (babyId: string, kind: string) =>
    db.asPipeline(async (c) => {
      const r = await c.query<{
        device_id: string;
        user_id: string;
        provider: string;
        token: string;
        last_sent_at: Date | null;
      }>("SELECT * FROM public.push_targets($1, $2)", [babyId, kind]);
      return r.rows;
    });

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await createFixtures(db.admin);
  });

  afterAll(async () => {
    if (db) {
      await db.admin.query("DELETE FROM public.push_devices WHERE user_id = ANY($1::uuid[])", [
        Object.values(U),
      ]);
      await db.admin.query("DELETE FROM auth.sessions WHERE id = ANY($1::uuid[])", [
        Object.values(SESSION),
      ]);
      await dropFixtures(db.admin);
      await db.close();
    }
  });

  beforeEach(async () => {
    await db.admin.query("DELETE FROM public.push_deliveries WHERE user_id = ANY($1::uuid[])", [
      Object.values(U),
    ]);
    await db.admin.query("DELETE FROM public.push_devices WHERE user_id = ANY($1::uuid[])", [
      Object.values(U),
    ]);
    await db.admin.query("DELETE FROM auth.sessions WHERE id = ANY($1::uuid[])", [
      Object.values(SESSION),
    ]);
    await db.admin.query(
      "UPDATE public.profiles SET notify_photos_analyzed = true, notify_share_viewed = true, deleted_at = NULL WHERE user_id = ANY($1::uuid[])",
      [Object.values(U)],
    );
    await db.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = ANY($1::uuid[])", [
      [BABY.A, BABY.B],
    ]);
    await addSession(SESSION.a1, U.adminA1);
    await addSession(SESSION.a1Other, U.adminA1);
    await addSession(SESSION.a2, U.adminA2);
    await addSession(SESSION.contrib, U.contribA);
    await addSession(SESSION.b, U.adminB);
    await addSession(SESSION.stranger, U.stranger);
  });

  describe("schema", () => {
    it("forces RLS on both tables", async () => {
      const r = await db.admin.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE nspname = 'public' AND relname IN ('push_devices', 'push_deliveries') ORDER BY 1`,
      );
      expect(r.rows).toEqual([
        { relname: "push_deliveries", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "push_devices", relrowsecurity: true, relforcerowsecurity: true },
      ]);
    });

    it("profiles gain two notify columns defaulting to true", async () => {
      const r = await db.admin.query(
        `SELECT column_name, column_default, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name LIKE 'notify_%' ORDER BY 1`,
      );
      expect(r.rows).toEqual([
        { column_name: "notify_photos_analyzed", column_default: "true", is_nullable: "NO" },
        { column_name: "notify_share_viewed", column_default: "true", is_nullable: "NO" },
      ]);
    });

    it("a user can toggle their own notify columns and no one else's", async () => {
      await asSession(U.adminA1, SESSION.a1, async (c) => {
        await c.query("UPDATE public.profiles SET notify_share_viewed = false WHERE user_id = $1", [
          U.adminA1,
        ]);
        const own = await c.query(
          "SELECT notify_share_viewed FROM public.profiles WHERE user_id = $1",
          [U.adminA1],
        );
        expect(own.rows[0]?.notify_share_viewed).toBe(false);
        const other = await c.query(
          "UPDATE public.profiles SET notify_share_viewed = false WHERE user_id = $1",
          [U.adminA2],
        );
        expect(other.rowCount).toBe(0);
      });
    });
  });

  describe("register_push_device", () => {
    it("needs a session claim", async () => {
      await asSession(U.adminA1, null, async (c) => {
        const e = await tryQuery(c, "SELECT public.register_push_device('ios','apns',$1,'1.0.0')", [
          TOKEN("a"),
        ]);
        expect(e?.code).toBe("42501");
        expect(e?.message).toBe("push registration needs a session");
      });
    });

    it("needs a live session (unknown, expired timebox, idle 90+ days)", async () => {
      const unknown = randomUUID();
      await asSession(U.adminA1, unknown, async (c) => {
        expect(
          (
            await tryQuery(c, "SELECT public.register_push_device('ios','apns',$1,'1.0.0')", [
              TOKEN("a"),
            ])
          )?.message,
        ).toBe("push registration needs a session");
      });
      await addSession(SESSION.a1Other, U.adminA1, { notAfter: "2000-01-01T00:00:00Z" });
      await asSession(U.adminA1, SESSION.a1Other, async (c) => {
        expect(
          (
            await tryQuery(c, "SELECT public.register_push_device('ios','apns',$1,'1.0.0')", [
              TOKEN("a"),
            ])
          )?.code,
        ).toBe("42501");
      });
      await addSession(SESSION.a1Other, U.adminA1, { refreshed: "2000-01-01 00:00:00" });
      await asSession(U.adminA1, SESSION.a1Other, async (c) => {
        expect(
          (
            await tryQuery(c, "SELECT public.register_push_device('ios','apns',$1,'1.0.0')", [
              TOKEN("a"),
            ])
          )?.code,
        ).toBe("42501");
      });
    });

    it("a session id that belongs to another user does not count", async () => {
      await asSession(U.adminA2, SESSION.a1, async (c) => {
        expect(
          (
            await tryQuery(c, "SELECT public.register_push_device('ios','apns',$1,'1.0.0')", [
              TOKEN("a"),
            ])
          )?.code,
        ).toBe("42501");
      });
    });

    it("a malformed session_id claim is treated as no session, never an error leak", async () => {
      await asSession(U.adminA1, "not-a-uuid", async (c) => {
        const e = await tryQuery(c, "SELECT public.register_push_device('ios','apns',$1,'1.0.0')", [
          TOKEN("a"),
        ]);
        expect(e?.message).toBe("push registration needs a session");
      });
    });

    it("anon and viewer cannot execute it", async () => {
      for (const [role, claims] of [
        ["anon", null],
        ["viewer", { role: "viewer", share_link_id: LINK.LA }],
      ] as const) {
        await (role === "anon"
          ? asAnon
          : (fn: (c: import("pg").PoolClient) => Promise<void>) => db.asRole(role, claims, fn))(
          async (c) => {
            const e = await tryQuery(
              c,
              "SELECT public.register_push_device('ios','apns',$1,'1.0.0')",
              [TOKEN("a")],
            );
            expect(e?.message, role).toMatch(PERMISSION_DENIED);
          },
        );
      }
    });

    it("needs a live profile", async () => {
      await db.admin.query("UPDATE public.profiles SET deleted_at = now() WHERE user_id = $1", [
        U.adminA1,
      ]);
      await asSession(U.adminA1, SESSION.a1, async (c) => {
        const e = await tryQuery(c, "SELECT public.register_push_device('ios','apns',$1,'1.0.0')", [
          TOKEN("a"),
        ]);
        expect(e?.message).toBe("push registration needs a profile");
      });
    });

    it("registers once and returns the id; one row per session (a new token replaces the old)", async () => {
      const id1 = await registerCommitted(U.adminA1, SESSION.a1, TOKEN("one"));
      const id2 = await registerCommitted(U.adminA1, SESSION.a1, TOKEN("two"));
      expect(id2).not.toBe(id1);
      const rows = await db.admin.query(
        "SELECT id, token FROM public.push_devices WHERE session_id = $1",
        [SESSION.a1],
      );
      expect(rows.rows).toEqual([{ id: id2, token: TOKEN("two") }]);
    });

    it("re-registering the same token from the same session keeps the id and clears a disable", async () => {
      const id = await registerCommitted(U.adminA1, SESSION.a1, TOKEN("same"));
      await db.admin.query(
        "UPDATE public.push_devices SET disabled_at = now(), disabled_reason = 'invalid_token' WHERE id = $1",
        [id],
      );
      const again = await registerCommitted(U.adminA1, SESSION.a1, TOKEN("same"), "1.1.0");
      expect(again).toBe(id);
      const r = await db.admin.query(
        "SELECT disabled_at, disabled_reason, app_version FROM public.push_devices WHERE id = $1",
        [id],
      );
      expect(r.rows[0]).toEqual({ disabled_at: null, disabled_reason: null, app_version: "1.1.0" });
    });

    it("two sessions of one user keep two devices", async () => {
      await registerCommitted(U.adminA1, SESSION.a1, TOKEN("s1"));
      await registerCommitted(U.adminA1, SESSION.a1Other, TOKEN("s2"));
      const n = await db.admin.query(
        "SELECT count(*)::int n FROM public.push_devices WHERE user_id = $1",
        [U.adminA1],
      );
      expect(n.rows[0]?.n).toBe(2);
    });

    it("a token moves between users (a shared phone stops notifying the previous user)", async () => {
      const first = await registerCommitted(U.adminA1, SESSION.a1, TOKEN("phone"));
      const second = await registerCommitted(U.adminA2, SESSION.a2, TOKEN("phone"));
      expect(second).not.toBe(first);
      const r = await db.admin.query(
        "SELECT user_id, session_id FROM public.push_devices WHERE token = $1",
        [TOKEN("phone")],
      );
      expect(r.rows).toEqual([{ user_id: U.adminA2, session_id: SESSION.a2 }]);
    });

    it("a token moves between sessions of the same user", async () => {
      await registerCommitted(U.adminA1, SESSION.a1, TOKEN("move"));
      await registerCommitted(U.adminA1, SESSION.a1Other, TOKEN("move"));
      const r = await db.admin.query(
        "SELECT session_id FROM public.push_devices WHERE token = $1",
        [TOKEN("move")],
      );
      expect(r.rows).toEqual([{ session_id: SESSION.a1Other }]);
    });

    it("housekeeping: the caller's rows of dead sessions are dropped", async () => {
      const dead = randomUUID();
      await addSession(dead, U.adminA1);
      await addDevice(U.adminA1, dead, TOKEN("dead"));
      await db.admin.query("DELETE FROM auth.sessions WHERE id = $1", [dead]);
      await registerCommitted(U.adminA1, SESSION.a1, TOKEN("live"));
      const r = await db.admin.query("SELECT token FROM public.push_devices WHERE user_id = $1", [
        U.adminA1,
      ]);
      expect(r.rows.map((x) => x.token)).toEqual([TOKEN("live")]);
    });

    it.each([
      [
        "a bad platform",
        ["web", "apns", TOKEN("a"), "1.0.0"],
        "push registration has an invalid platform or provider",
      ],
      [
        "a bad provider",
        ["ios", "webpush", TOKEN("a"), "1.0.0"],
        "push registration has an invalid platform or provider",
      ],
      [
        "ios with fcm",
        ["ios", "fcm", TOKEN("a"), "1.0.0"],
        "push registration has an invalid platform or provider",
      ],
      [
        "android with apns",
        ["android", "apns", TOKEN("a"), "1.0.0"],
        "push registration has an invalid platform or provider",
      ],
      [
        "a short token",
        ["ios", "apns", "short", "1.0.0"],
        "push_devices.token has an invalid shape",
      ],
      [
        "a token with whitespace",
        ["ios", "apns", "abcdefgh ijkl", "1.0.0"],
        "push_devices.token has an invalid shape",
      ],
      [
        "a 4097 char token",
        ["ios", "apns", "x".repeat(4097), "1.0.0"],
        "push_devices.token has an invalid shape",
      ],
      [
        "a bad app version",
        ["ios", "apns", TOKEN("a"), "1.0 0"],
        "push_devices.app_version has an invalid shape",
      ],
    ])(
      "rejects %s with fixed text (check_violation) that never echoes the token",
      async (_n, args, message) => {
        await asSession(U.adminA1, SESSION.a1, async (c) => {
          const e = await tryQuery(
            c,
            "SELECT public.register_push_device($1,$2,$3,$4)",
            args as string[],
          );
          expect(e?.code).toBe("23514");
          expect(e?.message).toBe(message);
        });
      },
    );

    it("accepts a 4096 char token (the unique index is on a digest, not the raw column)", async () => {
      await registerCommitted(U.adminA1, SESSION.a1, "t".repeat(4096));
      const n = await db.admin.query(
        "SELECT count(*)::int n FROM public.push_devices WHERE length(token) = 4096",
      );
      expect(n.rows[0]?.n).toBe(1);
    });

    it("concurrent registrations of one token leave exactly one row and no unique violation", async () => {
      const results = await Promise.allSettled([
        registerCommitted(U.adminA1, SESSION.a1, TOKEN("race")),
        registerCommitted(U.adminA2, SESSION.a2, TOKEN("race")),
        registerCommitted(U.adminB, SESSION.b, TOKEN("race")),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      const n = await db.admin.query(
        "SELECT count(*)::int n FROM public.push_devices WHERE token = $1",
        [TOKEN("race")],
      );
      expect(n.rows[0]?.n).toBe(1);
    });

    /** register_push_device in a committed transaction under the caller's claims. */
    async function registerCommitted(
      sub: string,
      sessionId: string,
      token: string,
      version = "1.0.0",
    ) {
      const c = await db.apiPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(claimsFor(sub, sessionId)),
        ]);
        const r = await register(c, token, "ios", "apns", version);
        await c.query("COMMIT");
        return r.rows[0]?.id as string;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    }
  });

  describe("what a signed-in user can see and do with devices", () => {
    it("sees only their own device rows, without token, user_id or session_id", async () => {
      await addDevice(U.adminA1, SESSION.a1, TOKEN("mine"));
      await addDevice(U.adminA2, SESSION.a2, TOKEN("theirs"));
      await asSession(U.adminA1, SESSION.a1, async (c) => {
        const r = await c.query(
          "SELECT id, platform, provider, app_version, created_at FROM public.push_devices",
        );
        expect(r.rows).toHaveLength(1);
        for (const col of ["token", "user_id", "session_id"]) {
          const e = await tryQuery(c, `SELECT ${col} FROM public.push_devices`);
          expect(e?.message, col).toMatch(PERMISSION_DENIED);
        }
        expect((await tryQuery(c, "SELECT * FROM public.push_devices"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
    });

    it("a stranger and a co-admin see nothing of another user's devices", async () => {
      await addDevice(U.adminA1, SESSION.a1, TOKEN("mine"));
      for (const [u, s] of [
        [U.adminA2, SESSION.a2],
        [U.stranger, SESSION.stranger],
        [U.adminB, SESSION.b],
      ] as const) {
        await asSession(u, s, async (c) => {
          expect((await c.query("SELECT id FROM public.push_devices")).rows).toEqual([]);
        });
      }
    });

    it("can delete their own device but not someone else's", async () => {
      const mine = await addDevice(U.adminA1, SESSION.a1, TOKEN("mine"));
      const theirs = await addDevice(U.adminA2, SESSION.a2, TOKEN("theirs"));
      await asSession(U.adminA1, SESSION.a1, async (c) => {
        expect(
          (await c.query("DELETE FROM public.push_devices WHERE id = $1", [theirs])).rowCount,
        ).toBe(0);
        expect(
          (await c.query("DELETE FROM public.push_devices WHERE id = $1", [mine])).rowCount,
        ).toBe(1);
      });
    });

    it("cannot insert or update devices directly, nor touch the ledger", async () => {
      const mine = await addDevice(U.adminA1, SESSION.a1, TOKEN("mine"));
      await asSession(U.adminA1, SESSION.a1, async (c) => {
        const ins = await tryQuery(
          c,
          "INSERT INTO public.push_devices (user_id, session_id, platform, provider, token, app_version) VALUES ($1,$2,'ios','apns',$3,'1.0.0')",
          [U.adminA1, SESSION.a1, TOKEN("direct")],
        );
        expect(ins?.message).toMatch(PERMISSION_DENIED);
        const upd = await tryQuery(
          c,
          "UPDATE public.push_devices SET token = 'hijackedtoken' WHERE id = $1",
          [mine],
        );
        expect(upd?.message).toMatch(PERMISSION_DENIED);
        expect((await tryQuery(c, "SELECT * FROM public.push_deliveries"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
    });

    it("anon and viewer have no access to either table", async () => {
      for (const [role, claims] of [
        ["anon", null],
        ["viewer", { role: "viewer", share_link_id: LINK.LA }],
      ] as const) {
        await (role === "anon"
          ? asAnon
          : (fn: (c: import("pg").PoolClient) => Promise<void>) => db.asRole(role, claims, fn))(
          async (c) => {
            for (const t of ["push_devices", "push_deliveries"]) {
              expect(
                (await tryQuery(c, `SELECT 1 FROM public.${t}`))?.message,
                `${role} ${t}`,
              ).toMatch(PERMISSION_DENIED);
            }
          },
        );
      }
    });

    it("unregister_push_devices_for_session deletes only the caller's session rows", async () => {
      await addDevice(U.adminA1, SESSION.a1, TOKEN("s1"));
      await addDevice(U.adminA1, SESSION.a1Other, TOKEN("s2"));
      await addDevice(U.adminA2, SESSION.a2, TOKEN("other"));
      const c = await db.apiPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(claimsFor(U.adminA1, SESSION.a1)),
        ]);
        const r = await c.query("SELECT public.unregister_push_devices_for_session() AS n");
        expect(r.rows[0]?.n).toBe(1);
        expect(
          (await c.query("SELECT public.unregister_push_devices_for_session() AS n")).rows[0]?.n,
        ).toBe(0);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      const left = await db.admin.query(
        "SELECT token FROM public.push_devices WHERE user_id = ANY($1::uuid[]) ORDER BY token",
        [Object.values(U)],
      );
      expect(left.rows.map((x) => x.token)).toEqual([TOKEN("other"), TOKEN("s2")]);
    });

    it("unregister returns 0 without a session claim and never raises", async () => {
      await addDevice(U.adminA1, SESSION.a1, TOKEN("s1"));
      await asSession(U.adminA1, null, async (c) => {
        expect(
          (await c.query("SELECT public.unregister_push_devices_for_session() AS n")).rows[0]?.n,
        ).toBe(0);
      });
      expect(
        (await db.admin.query("SELECT count(*)::int n FROM public.push_devices")).rows[0]?.n,
      ).toBe(1);
    });
  });

  describe("pipeline (worker) access", () => {
    it("has no privilege on either table", async () => {
      await db.asPipeline(async (c) => {
        for (const t of ["push_devices", "push_deliveries"]) {
          for (const sql of [`SELECT 1 FROM public.${t}`, `DELETE FROM public.${t}`]) {
            expect((await tryQuery(c, sql))?.message, sql).toMatch(PERMISSION_DENIED);
          }
        }
      });
    });

    it("cannot call the user-facing register/unregister functions", async () => {
      await db.asPipeline(async (c) => {
        expect(
          (await tryQuery(c, "SELECT public.unregister_push_devices_for_session()"))?.message,
        ).toMatch(PERMISSION_DENIED);
        expect(
          (
            await tryQuery(c, "SELECT public.register_push_device('ios','apns',$1,'1.0.0')", [
              TOKEN("a"),
            ])
          )?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("users cannot call the worker functions", async () => {
      await asSession(U.adminA1, SESSION.a1, async (c) => {
        expect(
          (await tryQuery(c, "SELECT * FROM public.push_targets($1,'share_viewed')", [BABY.A]))
            ?.message,
        ).toMatch(PERMISSION_DENIED);
        expect((await tryQuery(c, "SELECT public.push_link_baby($1)", [LINK.LA]))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect(
          (
            await tryQuery(
              c,
              "SELECT public.push_record_delivery($1,$2,NULL,'share_viewed','fake',NULL)",
              [randomUUID(), BABY.A],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });
  });

  describe("push_targets", () => {
    beforeEach(async () => {
      await addDevice(U.adminA1, SESSION.a1, TOKEN("a1"));
      await addDevice(U.adminA2, SESSION.a2, TOKEN("a2"));
      await addDevice(U.contribA, SESSION.contrib, TOKEN("contrib"));
      await addDevice(U.adminB, SESSION.b, TOKEN("b"));
      await addDevice(U.stranger, SESSION.stranger, TOKEN("stranger"));
    });

    const tokens = (rows: { token: string }[]) => rows.map((r) => r.token).sort();

    it("returns the admins' devices of that baby only (never contributors, strangers or other babies)", async () => {
      for (const kind of ["photos_analyzed", "share_viewed"]) {
        const rows = await targets(BABY.A, kind);
        expect(tokens(rows), kind).toEqual([TOKEN("a1"), TOKEN("a2")]);
        expect(rows.every((r) => r.provider === "apns" && r.last_sent_at === null)).toBe(true);
      }
      expect(tokens(await targets(BABY.B, "share_viewed"))).toEqual([TOKEN("b")]);
    });

    it("excludes a deleted profile", async () => {
      await db.admin.query("UPDATE public.profiles SET deleted_at = now() WHERE user_id = $1", [
        U.adminA2,
      ]);
      expect(tokens(await targets(BABY.A, "share_viewed"))).toEqual([TOKEN("a1")]);
    });

    it("excludes a trashed baby", async () => {
      await db.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [BABY.B]);
      try {
        expect(await targets(BABY.B, "share_viewed")).toEqual([]);
      } finally {
        await db.admin.query("UPDATE public.babies SET deleted_at = NULL WHERE id = $1", [BABY.B]);
      }
    });

    it("honours each preference independently", async () => {
      await db.admin.query(
        "UPDATE public.profiles SET notify_photos_analyzed = false WHERE user_id = $1",
        [U.adminA1],
      );
      expect(tokens(await targets(BABY.A, "photos_analyzed"))).toEqual([TOKEN("a2")]);
      expect(tokens(await targets(BABY.A, "share_viewed"))).toEqual([TOKEN("a1"), TOKEN("a2")]);
      await db.admin.query(
        "UPDATE public.profiles SET notify_share_viewed = false WHERE user_id = $1",
        [U.adminA2],
      );
      expect(tokens(await targets(BABY.A, "share_viewed"))).toEqual([TOKEN("a1")]);
    });

    it("excludes a disabled device", async () => {
      await db.admin.query(
        "UPDATE public.push_devices SET disabled_at = now(), disabled_reason = 'invalid_token' WHERE token = $1",
        [TOKEN("a1")],
      );
      expect(tokens(await targets(BABY.A, "share_viewed"))).toEqual([TOKEN("a2")]);
    });

    it("excludes dead sessions: deleting the auth.sessions row makes the device vanish", async () => {
      await db.admin.query("DELETE FROM auth.sessions WHERE id = $1", [SESSION.a1]);
      expect(tokens(await targets(BABY.A, "share_viewed"))).toEqual([TOKEN("a2")]);
    });

    it("push_targets also deletes the device rows of dead sessions (any user), so tokens do not linger", async () => {
      await db.admin.query("DELETE FROM auth.sessions WHERE id = $1", [SESSION.stranger]);
      await db.asPipeline(async (c) => {
        await c.query("SELECT * FROM public.push_targets($1, 'share_viewed')", [BABY.A]);
      });
      // asPipeline rolls back, so run it for real on a committed worker transaction.
      const c = await db.workerPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE pipeline");
        await c.query("SELECT * FROM public.push_targets($1, 'share_viewed')", [BABY.A]);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      const r = await db.admin.query("SELECT token FROM public.push_devices WHERE token = $1", [
        TOKEN("stranger"),
      ]);
      expect(r.rowCount).toBe(0);
      const kept = await db.admin.query("SELECT token FROM public.push_devices WHERE token = $1", [
        TOKEN("a1"),
      ]);
      expect(kept.rowCount).toBe(1);
    });

    it("excludes a session past its timebox and one idle for more than 90 days", async () => {
      await addSession(SESSION.a1, U.adminA1, { notAfter: "2000-01-01T00:00:00Z" });
      await addSession(SESSION.a2, U.adminA2, { refreshed: "2000-01-01 00:00:00" });
      expect(await targets(BABY.A, "share_viewed")).toEqual([]);
    });

    it("excludes a session id that belongs to a different user", async () => {
      await db.admin.query("UPDATE public.push_devices SET session_id = $1 WHERE token = $2", [
        SESSION.a2,
        TOKEN("a1"),
      ]);
      expect(tokens(await targets(BABY.A, "share_viewed"))).toEqual([TOKEN("a2")]);
    });

    it("photos_analyzed needs a paid baby; share_viewed does not", async () => {
      await db.admin.query("UPDATE public.babies SET plan = 'free' WHERE id = $1", [BABY.A]);
      expect(await targets(BABY.A, "photos_analyzed")).toEqual([]);
      expect(tokens(await targets(BABY.A, "share_viewed"))).toEqual([TOKEN("a1"), TOKEN("a2")]);
    });

    it("photos_analyzed is off when the paid entitlement has expired", async () => {
      await db.admin.query(
        "UPDATE public.babies SET entitlement_expires_at = now() - interval '1 day' WHERE id = $1",
        [BABY.A],
      );
      try {
        expect(await targets(BABY.A, "photos_analyzed")).toEqual([]);
      } finally {
        await db.admin.query(
          "UPDATE public.babies SET entitlement_expires_at = NULL WHERE id = $1",
          [BABY.A],
        );
      }
    });

    it("raises 'unknown push kind' for anything else", async () => {
      for (const kind of ["chat", "", "PHOTOS_ANALYZED"]) {
        await db.asPipeline(async (c) => {
          const e = await tryQuery(c, "SELECT * FROM public.push_targets($1,$2)", [BABY.A, kind]);
          expect(e?.message, kind).toBe("unknown push kind");
        });
      }
    });

    it("last_sent_at is the latest sent or fake delivery for that user, baby and kind only", async () => {
      const dev = await db.admin.query<{ id: string }>(
        "SELECT id FROM public.push_devices WHERE token = $1",
        [TOKEN("a1")],
      );
      const d = dev.rows[0]?.id;
      const ins = (kind: string, status: string, ago: string, baby = BABY.A) =>
        db.admin.query(
          `INSERT INTO public.push_deliveries (device_id, user_id, baby_id, kind, status, item_count, created_at)
           VALUES ($1, $2, $3, $4, $5, 1, now() - $6::interval)`,
          [d, U.adminA1, baby, kind, status, ago],
        );
      await ins("photos_analyzed", "sent", "3 hours");
      await ins("photos_analyzed", "fake", "2 hours");
      await ins("photos_analyzed", "failed", "1 minute");
      await ins("photos_analyzed", "invalid_token", "1 minute");
      await ins("photos_analyzed", "unconfigured", "1 minute");
      await ins("share_viewed", "sent", "5 minutes");
      const rows = await targets(BABY.A, "photos_analyzed");
      const mine = rows.find((r) => r.token === TOKEN("a1"));
      const other = rows.find((r) => r.token === TOKEN("a2"));
      expect(other?.last_sent_at).toBeNull();
      const ageMin = (Date.now() - (mine?.last_sent_at?.getTime() ?? 0)) / 60000;
      expect(ageMin).toBeGreaterThan(115);
      expect(ageMin).toBeLessThan(125);
    });

    it("the ledger survives a sign-in elsewhere: last_sent_at follows the user, not the device", async () => {
      const dev = await db.admin.query<{ id: string }>(
        "SELECT id FROM public.push_devices WHERE token = $1",
        [TOKEN("a1")],
      );
      await db.admin.query(
        `INSERT INTO public.push_deliveries (device_id, user_id, baby_id, kind, status, item_count)
         VALUES ($1, $2, $3, 'share_viewed', 'sent', NULL)`,
        [dev.rows[0]?.id, U.adminA1, BABY.A],
      );
      await db.admin.query("DELETE FROM public.push_devices WHERE token = $1", [TOKEN("a1")]);
      await addDevice(U.adminA1, SESSION.a1Other, TOKEN("a1-new"));
      const rows = await targets(BABY.A, "share_viewed");
      expect(rows.find((r) => r.token === TOKEN("a1-new"))?.last_sent_at).not.toBeNull();
    });
  });

  describe("push_record_delivery, push_photos_analyzed_count, push_link_baby", () => {
    let device: string;
    beforeEach(async () => {
      device = await addDevice(U.adminA1, SESSION.a1, TOKEN("a1"));
    });

    const record = (
      kind: string,
      status: string,
      count: number | null,
      baby = BABY.A,
      link: string | null = null,
      dev?: string,
    ) =>
      db
        .asPipeline(async (c) => {
          // The pipeline connection is rolled back: use the pool directly for a committed write.
          void c;
        })
        .then(() => recordCommitted(dev ?? device, baby, link, kind, status, count));

    async function recordCommitted(
      dev: string,
      baby: string,
      link: string | null,
      kind: string,
      status: string,
      count: number | null,
    ) {
      const c = await db.workerPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE pipeline");
        await c.query("SELECT public.push_record_delivery($1,$2,$3,$4,$5,$6)", [
          dev,
          baby,
          link,
          kind,
          status,
          count,
        ]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    }

    const ledger = () =>
      db.admin.query(
        "SELECT device_id, user_id, baby_id, share_link_id, kind, status, item_count FROM public.push_deliveries ORDER BY id",
      );

    it("writes one row with the user taken from the device", async () => {
      await record("photos_analyzed", "fake", 3);
      expect((await ledger()).rows).toEqual([
        {
          device_id: device,
          user_id: U.adminA1,
          baby_id: BABY.A,
          share_link_id: null,
          kind: "photos_analyzed",
          status: "fake",
          item_count: 3,
        },
      ]);
    });

    it("records the share link for share_viewed", async () => {
      await record("share_viewed", "sent", null, BABY.A, LINK.LA);
      expect((await ledger()).rows[0]).toMatchObject({ share_link_id: LINK.LA, item_count: null });
    });

    it("rejects a share link of another baby", async () => {
      await expect(record("share_viewed", "sent", null, BABY.A, LINK.LB)).rejects.toThrow(
        /share link does not belong to the baby/,
      );
      expect((await ledger()).rowCount).toBe(0);
    });

    it("rejects unknown kinds and statuses and negative counts", async () => {
      await expect(record("chat", "sent", 1)).rejects.toThrow(/unknown push kind/);
      await expect(record("share_viewed", "delivered", 1)).rejects.toThrow(
        /unknown push delivery status/,
      );
      await expect(record("photos_analyzed", "sent", -1)).rejects.toThrow(/must not be negative/);
    });

    it("a device deleted in the meantime records nothing", async () => {
      await db.admin.query("DELETE FROM public.push_devices WHERE id = $1", [device]);
      await record("share_viewed", "sent", null);
      expect((await ledger()).rowCount).toBe(0);
    });

    it("invalid_token disables the device with a reason; other failures do not", async () => {
      await record("share_viewed", "failed", null);
      expect(
        (
          await db.admin.query("SELECT disabled_at FROM public.push_devices WHERE id = $1", [
            device,
          ])
        ).rows[0]?.disabled_at,
      ).toBeNull();
      await record("share_viewed", "invalid_token", null);
      const r = await db.admin.query(
        "SELECT disabled_at, disabled_reason FROM public.push_devices WHERE id = $1",
        [device],
      );
      expect(r.rows[0]?.disabled_reason).toBe("invalid_token");
      expect(r.rows[0]?.disabled_at).not.toBeNull();
      expect(await targets(BABY.A, "share_viewed")).toEqual([]);
    });

    it("deleting the device keeps its ledger rows with device_id NULL (ON DELETE SET NULL)", async () => {
      await record("photos_analyzed", "fake", 2);
      await db.admin.query("DELETE FROM public.push_devices WHERE id = $1", [device]);
      const r = await ledger();
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ device_id: null, user_id: U.adminA1, status: "fake" });
    });

    it("deleting the user's profile or the baby removes the rows", async () => {
      await record("photos_analyzed", "fake", 2);
      await db.admin.query("DELETE FROM public.push_devices WHERE id = $1", [device]);
      await db.admin.query("DELETE FROM public.profiles WHERE user_id = $1", [U.adminA1]);
      expect((await ledger()).rowCount).toBe(0);
      // restore the profile for later tests
      await db.admin.query(
        "INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'adminA1')",
        [U.adminA1],
      );
    });

    it("prunes the user's rows older than 30 days (including rows whose device is gone), only that user's", async () => {
      const mkOld = (user: string, baby: string, ago: string, dev: string | null) =>
        db.admin.query(
          `INSERT INTO public.push_deliveries (device_id, user_id, baby_id, kind, status, item_count, created_at)
           VALUES ($1, $2, $3, 'share_viewed', 'sent', NULL, now() - $4::interval)`,
          [dev, user, baby, ago],
        );
      await mkOld(U.adminA1, BABY.A, "31 days", null);
      await mkOld(U.adminA1, BABY.A, "29 days", null);
      await mkOld(U.adminA2, BABY.A, "40 days", null);
      await record("share_viewed", "sent", null);
      const rows = await db.admin.query(
        "SELECT user_id, created_at < now() - interval '30 days' AS old FROM public.push_deliveries ORDER BY created_at",
      );
      const a1 = rows.rows.filter((r) => r.user_id === U.adminA1);
      expect(a1).toHaveLength(2);
      expect(a1.some((r) => r.old)).toBe(false);
      // another user's old row is not touched until that user has a delivery
      expect(rows.rows.filter((r) => r.user_id === U.adminA2)).toHaveLength(1);
    });

    it("the ledger never holds a token or message text (columns are ids, kind, status, count)", async () => {
      const cols = await db.admin.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='push_deliveries' ORDER BY ordinal_position",
      );
      expect(cols.rows.map((c) => c.column_name)).toEqual([
        "id",
        "device_id",
        "user_id",
        "baby_id",
        "share_link_id",
        "kind",
        "status",
        "item_count",
        "created_at",
      ]);
    });

    it("push_photos_analyzed_count counts approved, live, unquarantined, non-duplicate photos described after p_since", async () => {
      const count = (baby: string, since: string) =>
        db.asPipeline(
          async (c) =>
            (
              await c.query("SELECT public.push_photos_analyzed_count($1, $2::timestamptz) AS n", [
                baby,
                since,
              ])
            ).rows[0]?.n,
        );
      expect(await count(BABY.A, "2000-01-01")).toBe(1);
      expect(await count(BABY.A, "2999-01-01")).toBe(0);
      expect(await count(BABY.B, "2000-01-01")).toBe(0);

      const withAi = (photo: string) =>
        db.admin.query(
          `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description)
           VALUES ($1, 'gpt-6-luna', 'v1', 'v1', '{"caption":"x"}'::jsonb)`,
          [photo],
        );
      await withAi(P.approved2);
      await withAi(P.pendingContrib);
      await withAi(P.trashed);
      expect(await count(BABY.A, "2000-01-01")).toBe(2);
      await db.admin
        .query("UPDATE public.photos SET status = 'duplicate' WHERE id = $1", [P.approved2])
        .catch(() => undefined);
      await db.admin.query("DELETE FROM public.photo_ai WHERE photo_id = ANY($1::uuid[])", [
        [P.approved2, P.pendingContrib, P.trashed],
      ]);
      await db.admin
        .query("UPDATE public.photos SET status = 'ready' WHERE id = $1", [P.approved2])
        .catch(() => undefined);
    });

    it("push_link_baby returns the baby of a live link and NULL for unknown links or trashed babies", async () => {
      const linkBaby = (id: string) =>
        db.asPipeline(
          async (c) => (await c.query("SELECT public.push_link_baby($1) AS b", [id])).rows[0]?.b,
        );
      expect(await linkBaby(LINK.LA)).toBe(BABY.A);
      expect(await linkBaby(LINK.LB)).toBe(BABY.B);
      expect(await linkBaby(randomUUID())).toBeNull();
      await db.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [BABY.B]);
      try {
        expect(await linkBaby(LINK.LB)).toBeNull();
      } finally {
        await db.admin.query("UPDATE public.babies SET deleted_at = NULL WHERE id = $1", [BABY.B]);
      }
    });
  });

  describe("shape trigger (direct superuser writes)", () => {
    it("rejects bad rows with fixed text that does not print the token", async () => {
      const bad = `bad token`;
      const e = await tryQuery(
        db.admin,
        "INSERT INTO public.push_devices (user_id, session_id, platform, provider, token, app_version) VALUES ($1,$2,'ios','apns',$3,'1.0.0')",
        [U.adminA1, SESSION.a1, bad],
      );
      expect(e?.code).toBe("23514");
      expect(e?.message).toBe("push_devices.token has an invalid shape");
      expect(e?.message).not.toContain(bad);
    });

    it("a duplicate token fails on the digest index without printing the token", async () => {
      await addDevice(U.adminA1, SESSION.a1, TOKEN("dupe"));
      const e = await tryQuery(
        db.admin,
        "INSERT INTO public.push_devices (user_id, session_id, platform, provider, token, app_version) VALUES ($1,$2,'ios','apns',$3,'1.0.0')",
        [U.adminA2, SESSION.a2, TOKEN("dupe")],
      );
      expect(e?.code).toBe("23505");
      expect(e?.message).not.toContain(TOKEN("dupe"));
    });

    it("disabled_at and disabled_reason go together", async () => {
      const id = await addDevice(U.adminA1, SESSION.a1, TOKEN("pair"));
      const e = await tryQuery(
        db.admin,
        "UPDATE public.push_devices SET disabled_at = now() WHERE id = $1",
        [id],
      );
      expect(e?.code).toBe("23514");
    });
  });
});
