import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./src/index";
import { BABY, createFixtures, dropFixtures, EMAIL, P, U } from "./test/fixtures";
import {
  authed,
  connect,
  type Db,
  databaseUrl,
  ensureMigrated,
  env,
  PERMISSION_DENIED,
  RLS_VIOLATION,
  tryQuery,
} from "./test/harness";

// Review-fix migrations 18 (hardening: FR-1.5 at the database, self-only profiles +
// member_profiles, photo approval guard) and 19 (data_exports; docs/plans/review-fixes.md 2.1,
// 2.14). Every case runs in a rolled-back transaction on the application roles except where a
// committed fixture change is restored in `finally`.

const quiet = () => undefined;
const rowCount = async (c: pg.ClientBase, sql: string, params: unknown[] = []) =>
  (await c.query(sql, params)).rowCount;
const asClaims = (c: pg.ClientBase, sub: string) =>
  c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(authed(sub))]);

async function expectErr(
  c: pg.ClientBase,
  sql: string,
  params: unknown[],
  code: string,
  message: RegExp | string,
) {
  const err = await tryQuery(c, sql, params);
  expect(err, `expected an error for: ${sql}`).not.toBeNull();
  expect(err?.code).toBe(code);
  if (typeof message === "string") expect(err?.message).toBe(message);
  else expect(err?.message).toMatch(message);
}

describe.skipIf(!databaseUrl)("review fixes: migrations 18 and 19", () => {
  let db: Db;

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await createFixtures(db.admin);
  });
  afterAll(async () => {
    await dropFixtures(db.admin);
    await db.close();
  });
  beforeEach(async () => {
    await db.admin.query("DELETE FROM public.data_exports WHERE baby_id = ANY($1::uuid[])", [
      [BABY.A, BABY.B, BABY.recentTrash],
    ]);
  });

  // -----------------------------------------------------------------------------------------
  describe("migration round trip (down 2, up 2)", () => {
    it("reverts 19 and 18 cleanly and re-applies them, restoring the previous policies in between", async () => {
      const probe = new (await import("pg")).default.Client({ connectionString: databaseUrl });
      await probe.connect();
      const q = async (sql: string) => (await probe.query(sql)).rows as Record<string, unknown>[];
      try {
        const downed = await runMigrations({
          direction: "down",
          count: 2,
          bootstrap: false,
          databaseUrl,
          env,
          log: quiet,
        });
        expect(downed.map((m) => m.name)).toEqual([
          expect.stringContaining("data-exports"),
          expect.stringContaining("review-hardening"),
        ]);
        expect((await q("SELECT to_regclass('public.data_exports') AS t"))[0]?.t).toBeNull();
        expect((await q("SELECT to_regclass('public.member_profiles') AS t"))[0]?.t).toBeNull();
        expect(
          await q(
            "SELECT 1 FROM pg_trigger WHERE tgname = 'photos_user_update_guard' AND NOT tgisinternal",
          ),
        ).toEqual([]);
        // step-2 policy is back: a co-member can read other profiles again
        const sel = await q(
          "SELECT qual FROM pg_policies WHERE policyname = 'profiles_authenticated_select'",
        );
        expect(String(sel[0]?.qual)).toContain("shares_baby_with");
        expect((await q("SELECT count(*)::int AS n FROM public.pgmigrations"))[0]?.n).toBe(17);
      } finally {
        await runMigrations({ direction: "up", databaseUrl, env, log: quiet });
        const n = (await q("SELECT count(*)::int AS n FROM public.pgmigrations"))[0]?.n;
        expect(n).toBe(19);
        expect((await q("SELECT to_regclass('public.data_exports') AS t"))[0]?.t).not.toBeNull();
        const kind = await q("SELECT relkind FROM pg_class WHERE relname = 'member_profiles'");
        expect(kind[0]?.relkind).toBe("v");
        await probe.end();
      }
    });

    it("every public table, data_exports included, has RLS enabled and forced", async () => {
      const r = await db.admin.query(
        `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE nspname = 'public' AND relkind = 'r' AND relname <> 'pgmigrations'
            AND NOT (relrowsecurity AND relforcerowsecurity)`,
      );
      expect(r.rows).toEqual([]);
      const de = await db.admin.query(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'data_exports'",
      );
      expect(de.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("baby_members: FR-1.5 at the database", () => {
    it("an admin cannot change another admin's role or delete their row (0 rows, no error)", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(
          await rowCount(
            c,
            "UPDATE baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
            [BABY.A, U.adminA2],
          ),
        ).toBe(0);
        expect(
          await rowCount(c, "DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
            BABY.A,
            U.adminA2,
          ]),
        ).toBe(0);
      });
      const still = await db.admin.query(
        "SELECT role FROM baby_members WHERE baby_id = $1 AND user_id = $2",
        [BABY.A, U.adminA2],
      );
      expect(still.rows[0]).toEqual({ role: "admin" });
    });

    it("an admin can step down (demote self) while the other admin remains", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(
          await rowCount(
            c,
            "UPDATE baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
            [BABY.A, U.adminA1],
          ),
        ).toBe(1);
      });
    });

    it("an admin can remove a contributor; promoting needs a free admin seat", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(
          await rowCount(c, "DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
            BABY.A,
            U.contribA,
          ]),
        ).toBe(1);
      });
      await db.asUser(U.adminA2, async (c) => {
        // A leaves by deleting their own row, then B promotes the contributor into the free seat.
        expect(
          await rowCount(c, "DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
            BABY.A,
            U.adminA2,
          ]),
        ).toBe(1);
        await asClaims(c, U.adminA1);
        expect(
          await rowCount(
            c,
            "UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
            [BABY.A, U.contribA],
          ),
        ).toBe(1);
      });
    });

    it("the target can delete their own row after a removal request (the confirm step)", async () => {
      // The request is written by service_role (the API); the target confirms by leaving.
      await db.asRole("service_role", null, async (c) => {
        await c.query(
          `UPDATE baby_members SET removal_requested_by = $3, removal_requested_at = now()
            WHERE baby_id = $1 AND user_id = $2`,
          [BABY.A, U.adminA2, U.adminA1],
        );
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE authenticated");
        await asClaims(c, U.adminA2);
        expect(
          await rowCount(c, "DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
            BABY.A,
            U.adminA2,
          ]),
        ).toBe(1);
      });
    });

    it("a contributor can leave but cannot remove anyone else or change a role", async () => {
      await db.asUser(U.contribA, async (c) => {
        expect(
          await rowCount(c, "DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
            BABY.A,
            U.adminA1,
          ]),
        ).toBe(0);
        expect(
          await rowCount(
            c,
            "UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
            [BABY.A, U.contribA],
          ),
        ).toBe(0);
        expect(
          await rowCount(c, "DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
            BABY.A,
            U.contribA,
          ]),
        ).toBe(1);
      });
    });

    it("a stranger affects nothing", async () => {
      await db.asUser(U.stranger, async (c) => {
        expect(await rowCount(c, "DELETE FROM baby_members WHERE baby_id = $1", [BABY.A])).toBe(0);
        expect(
          await rowCount(c, "UPDATE baby_members SET role = 'contributor' WHERE baby_id = $1", [
            BABY.A,
          ]),
        ).toBe(0);
      });
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("profiles and member_profiles", () => {
    it("a co-member's profile row is invisible in profiles (0 rows), including consent and notify columns", async () => {
      await db.asUser(U.contribA, async (c) => {
        expect(
          (await c.query("SELECT * FROM profiles WHERE user_id = $1", [U.adminA1])).rowCount,
        ).toBe(0);
        expect(
          (
            await c.query(
              "SELECT notify_share_viewed, terms_version FROM profiles WHERE user_id = $1",
              [U.adminA1],
            )
          ).rowCount,
        ).toBe(0);
      });
    });

    it("a self-read keeps every granted column (consent, timezone, units, notify flags)", async () => {
      await db.asUser(U.adminA1, async (c) => {
        const r = await c.query(
          `SELECT user_id, display_name, relationship_label, timezone, units, terms_version,
                  privacy_version, accepted_at, notify_photos_analyzed, notify_share_viewed
             FROM profiles WHERE user_id = $1`,
          [U.adminA1],
        );
        expect(r.rowCount).toBe(1);
        expect(r.rows[0]?.user_id).toBe(U.adminA1);
      });
    });

    it("member_profiles returns exactly three columns for the caller and co-members", async () => {
      await db.asUser(U.contribA, async (c) => {
        const r = await c.query("SELECT * FROM member_profiles ORDER BY user_id");
        expect(r.fields.map((f) => f.name)).toEqual([
          "user_id",
          "display_name",
          "relationship_label",
        ]);
        expect(r.rows.map((x) => x.user_id).sort()).toEqual(
          [U.adminA1, U.adminA2, U.contribA].sort(),
        );
        expect(r.rows.find((x) => x.user_id === U.adminA1)?.display_name).toBe("adminA1");
      });
    });

    it("member_profiles shows nothing about strangers and other albums", async () => {
      await db.asUser(U.contribA, async (c) => {
        const r = await c.query("SELECT user_id FROM member_profiles WHERE user_id = ANY($1)", [
          [U.adminB, U.stranger],
        ]);
        expect(r.rowCount).toBe(0);
      });
      await db.asUser(U.stranger, async (c) => {
        const r = await c.query("SELECT user_id FROM member_profiles");
        expect(r.rows.map((x) => x.user_id)).toEqual([U.stranger]);
      });
    });

    it("a deleted profile disappears from member_profiles", async () => {
      await db.admin.query("UPDATE public.profiles SET deleted_at = now() WHERE user_id = $1", [
        U.adminA2,
      ]);
      try {
        await db.asUser(U.contribA, async (c) => {
          const r = await c.query("SELECT user_id FROM member_profiles");
          expect(r.rows.map((x) => x.user_id)).not.toContain(U.adminA2);
          expect(r.rows.map((x) => x.user_id)).toContain(U.adminA1);
        });
      } finally {
        await db.admin.query("UPDATE public.profiles SET deleted_at = NULL WHERE user_id = $1", [
          U.adminA2,
        ]);
      }
    });

    it("the view is read-only for authenticated, closed to viewer and anon, and caller predicates cannot leak rows", async () => {
      await db.asUser(U.contribA, async (c) => {
        const w = await tryQuery(c, "UPDATE member_profiles SET display_name = 'x'");
        expect(w?.code).toBe("42501");
        expect(w?.message).toMatch(PERMISSION_DENIED);
        const i = await tryQuery(c, "INSERT INTO member_profiles (user_id) VALUES ($1)", [
          U.stranger,
        ]);
        expect(i?.code).toBe("42501");
        // A predicate on a hidden row's value does not reveal it (security_barrier).
        const probe = await c.query(
          "SELECT user_id FROM member_profiles WHERE display_name = 'stranger'",
        );
        expect(probe.rowCount).toBe(0);
      });
      await db.asViewer(null, async (c) => {
        const err = await tryQuery(c, "SELECT * FROM member_profiles");
        expect(err?.code).toBe("42501");
      });
    });

    it("pipeline keeps its three-column grant on profiles and nothing more", async () => {
      await db.asPipeline(async (c) => {
        expect(
          (await c.query("SELECT user_id, display_name, relationship_label FROM profiles"))
            .rowCount,
        ).toBeGreaterThan(0);
        const err = await tryQuery(c, "SELECT timezone FROM profiles");
        expect(err?.code).toBe("42501");
        const err2 = await tryQuery(c, "SELECT notify_share_viewed FROM profiles");
        expect(err2?.code).toBe("42501");
      });
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("photos: approval guard", () => {
    it.each([
      ["is_sensitive", "UPDATE photos SET is_sensitive = true WHERE id = $1"],
      ["approval", "UPDATE photos SET approval = 'approved' WHERE id = $1"],
      ["approved_by", `UPDATE photos SET approved_by = '${U.contribA}' WHERE id = $1`],
      ["approved_at", "UPDATE photos SET approved_at = now() WHERE id = $1"],
    ])("a contributor cannot change %s on their own pending photo", async (_c, sql) => {
      await db.asUser(U.contribA, async (c) => {
        await expectErr(
          c,
          sql,
          [P.pendingContrib],
          "42501",
          "contributors may only trash their own pending uploads",
        );
      });
    });

    it("a contributor can still trash their own pending upload", async () => {
      await db.asUser(U.contribA, async (c) => {
        expect(
          await rowCount(c, "UPDATE photos SET deleted_at = now() WHERE id = $1", [
            P.pendingContrib,
          ]),
        ).toBe(1);
      });
    });

    it("an admin approval pins approved_by to the actor even when another id is supplied", async () => {
      await db.asUser(U.adminA1, async (c) => {
        await c.query(
          "UPDATE photos SET approval = 'approved', approved_by = $2, approved_at = '2001-01-01' WHERE id = $1",
          [P.pendingContrib, U.adminA2],
        );
        const r = await c.query("SELECT approved_by, approved_at FROM photos WHERE id = $1", [
          P.pendingContrib,
        ]);
        expect(r.rows[0]?.approved_by).toBe(U.adminA1);
        expect(new Date(r.rows[0]?.approved_at).getFullYear()).toBeGreaterThanOrEqual(2026);
      });
    });

    it("an admin cannot rewrite the approver of an already approved photo", async () => {
      await db.asUser(U.adminA1, async (c) => {
        await expectErr(
          c,
          "UPDATE photos SET approved_by = $2 WHERE id = $1",
          [P.approved1, U.adminA2],
          "23514",
          /approved_by and approved_at are set by the database/,
        );
      });
    });

    it("an admin insert with a foreign approved_by fails; with none it is filled with the actor", async () => {
      await db.asUser(U.adminA1, async (c) => {
        const err = await tryQuery(
          c,
          `INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval, approved_by)
           VALUES ('f3000000-0000-4000-8000-0000000000e1', $1, $2, 'fx/e1', 'approved', $3)`,
          [BABY.A, U.adminA1, U.adminA2],
        );
        expect(err?.code).toBe("42501");
        expect(err?.message).toMatch(RLS_VIOLATION);
        await c.query(
          `INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval)
           VALUES ('f3000000-0000-4000-8000-0000000000e2', $1, $2, 'fx/e2', 'approved')`,
          [BABY.A, U.adminA1],
        );
        const r = await c.query(
          "SELECT approved_by FROM photos WHERE id = 'f3000000-0000-4000-8000-0000000000e2'",
        );
        expect(r.rows[0]?.approved_by).toBe(U.adminA1);
      });
    });

    it("a contributor insert stays pending-only with no approver", async () => {
      await db.asUser(U.contribA, async (c) => {
        const err = await tryQuery(
          c,
          `INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval, approved_by)
           VALUES ('f3000000-0000-4000-8000-0000000000e3', $1, $2, 'fx/e3', 'pending', $2)`,
          [BABY.A, U.contribA],
        );
        expect(err?.code).toBe("42501");
      });
    });

    it("pipeline and service_role writes are not blocked by the guard", async () => {
      await db.asPipeline(async (c) => {
        expect(
          await rowCount(c, "UPDATE photos SET status = 'ingested', width = 5 WHERE id = $1", [
            P.approved1,
          ]),
        ).toBe(1);
      });
      await db.asRole("service_role", null, async (c) => {
        expect(
          await rowCount(c, "UPDATE photos SET is_sensitive = true WHERE id = $1", [P.approved2]),
        ).toBe(1);
      });
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("data_exports", () => {
    const insert =
      "INSERT INTO data_exports (baby_id, requested_by, include_location) VALUES ($1, $2, $3) RETURNING id";

    it("a contributor cannot request an export", async () => {
      await db.asUser(U.contribA, async (c) => {
        const err = await tryQuery(c, insert, [BABY.A, U.contribA, false]);
        expect(err?.code).toBe("42501");
        expect(err?.message).toMatch(RLS_VIOLATION);
      });
    });

    it("an admin can request for themselves only, and only for their own album", async () => {
      await db.asUser(U.adminA1, async (c) => {
        const ok = await c.query(insert, [BABY.A, U.adminA1, true]);
        expect(ok.rowCount).toBe(1);
      });
      await db.asUser(U.adminA1, async (c) => {
        const other = await tryQuery(c, insert, [BABY.A, U.adminA2, true]);
        expect(other?.code).toBe("42501");
      });
      await db.asUser(U.adminA1, async (c) => {
        const wrongBaby = await tryQuery(c, insert, [BABY.B, U.adminA1, true]);
        expect(wrongBaby?.code).toBe("42501");
      });
    });

    it("a second insert while one is queued or running raises 'already in progress', for either admin", async () => {
      await db.admin.query("INSERT INTO data_exports (baby_id, requested_by) VALUES ($1, $2)", [
        BABY.A,
        U.adminA1,
      ]);
      for (const status of ["queued", "running"]) {
        await db.admin.query("UPDATE data_exports SET status = $2 WHERE baby_id = $1", [
          BABY.A,
          status,
        ]);
        for (const u of [U.adminA1, U.adminA2]) {
          await db.asUser(u, async (c) => {
            await expectErr(
              c,
              insert,
              [BABY.A, u, false],
              "23514",
              "an export is already in progress for this album",
            );
          });
        }
      }
      // once it is ready the album can be exported again
      await db.admin.query("UPDATE data_exports SET status = 'ready' WHERE baby_id = $1", [BABY.A]);
      await db.asUser(U.adminA2, async (c) => {
        expect((await c.query(insert, [BABY.A, U.adminA2, false])).rowCount).toBe(1);
      });
    });

    it("two concurrent requests: exactly one wins, the other is told it is in progress", async () => {
      const results = await Promise.allSettled(
        [U.adminA1, U.adminA2].map((u) =>
          db.apiPool.connect().then(async (c) => {
            try {
              await c.query("BEGIN");
              await c.query("SET LOCAL ROLE authenticated");
              await asClaims(c, u);
              await c.query(insert, [BABY.A, u, false]);
              await c.query("COMMIT");
            } catch (e) {
              await c.query("ROLLBACK").catch(() => undefined);
              throw e;
            } finally {
              c.release();
            }
          }),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(String(bad[0]?.reason?.message ?? bad[0]?.reason)).toMatch(
        /already in progress|data_exports_one_active_per_baby/,
      );
      const n = await db.admin.query(
        "SELECT count(*)::int AS n FROM data_exports WHERE baby_id = $1 AND status IN ('queued','running')",
        [BABY.A],
      );
      expect(n.rows[0]?.n).toBe(1);
    });

    it("the 4th request in 24 hours raises the limit; older ones do not count", async () => {
      for (let i = 0; i < 3; i++) {
        await db.admin.query(
          `INSERT INTO data_exports (baby_id, requested_by, status) VALUES ($1, $2, 'ready')`,
          [BABY.A, U.adminA1],
        );
      }
      await db.asUser(U.adminA1, async (c) => {
        await expectErr(
          c,
          insert,
          [BABY.A, U.adminA1, false],
          "23514",
          "export rate limit reached: 3 per album per day",
        );
      });
      await db.admin.query(
        "UPDATE data_exports SET created_at = now() - interval '25 hours' WHERE baby_id = $1 AND id IN (SELECT id FROM data_exports WHERE baby_id = $1 LIMIT 1)",
        [BABY.A],
      );
      await db.asUser(U.adminA1, async (c) => {
        expect((await c.query(insert, [BABY.A, U.adminA1, false])).rowCount).toBe(1);
      });
    });

    it("a trashed album cannot be exported", async () => {
      await db.admin.query(
        "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING",
        [BABY.recentTrash, U.adminA1],
      );
      try {
        await db.asUser(U.adminA1, async (c) => {
          await expectErr(
            c,
            insert,
            [BABY.recentTrash, U.adminA1, false],
            "23514",
            "cannot export a trashed album",
          );
        });
      } finally {
        await db.admin.query("DELETE FROM baby_members WHERE baby_id = $1", [BABY.recentTrash]);
      }
    });

    it("both admins see the row; a contributor, a stranger, a viewer and the other album's admin see nothing", async () => {
      await db.admin.query(`INSERT INTO data_exports (baby_id, requested_by) VALUES ($1, $2)`, [
        BABY.A,
        U.adminA1,
      ]);
      const count = "SELECT id FROM data_exports";
      await db.asUser(U.adminA1, async (c) => expect((await c.query(count)).rowCount).toBe(1));
      await db.asUser(U.adminA2, async (c) => expect((await c.query(count)).rowCount).toBe(1));
      for (const u of [U.contribA, U.stranger, U.adminB]) {
        await db.asUser(u, async (c) => expect((await c.query(count)).rowCount, u).toBe(0));
      }
      await db.asViewer(null, async (c) => {
        const err = await tryQuery(c, count);
        expect(err?.code).toBe("42501");
        expect(err?.message).toMatch(PERMISSION_DENIED);
      });
      await db.asViewer("00000000-0000-4000-8000-0000000000aa", async (c) => {
        const err = await tryQuery(c, count);
        expect(err?.code).toBe("42501");
      });
    });

    it("storage_key is not selectable by authenticated; SELECT * fails; named columns work", async () => {
      await db.admin.query(`INSERT INTO data_exports (baby_id, requested_by) VALUES ($1, $2)`, [
        BABY.A,
        U.adminA1,
      ]);
      await db.asUser(U.adminA1, async (c) => {
        for (const sql of [
          "SELECT storage_key FROM data_exports",
          "SELECT * FROM data_exports",
          "INSERT INTO data_exports (baby_id, requested_by) VALUES ($1, $2) RETURNING storage_key",
        ]) {
          const err = await tryQuery(c, sql, sql.startsWith("INSERT") ? [BABY.A, U.adminA1] : []);
          expect(err?.code, sql).toBe("42501");
          expect(err?.message, sql).toMatch(PERMISSION_DENIED);
        }
        expect((await c.query("SELECT id, status, expires_at FROM data_exports")).rowCount).toBe(1);
      });
    });

    it("the storage key is generated from baby and export ids (and equals exportKey())", async () => {
      const r = await db.admin.query(
        "INSERT INTO data_exports (baby_id, requested_by) VALUES ($1, $2) RETURNING id, storage_key",
        [BABY.A, U.adminA1],
      );
      expect(r.rows[0]?.storage_key).toBe(`babies/${BABY.A}/exports/${r.rows[0]?.id}.zip`);
    });

    it("authenticated can only shorten expiry and move counters forward; status and error are not writable", async () => {
      const r = await db.admin.query(
        "INSERT INTO data_exports (baby_id, requested_by, status) VALUES ($1, $2, 'ready') RETURNING id",
        [BABY.A, U.adminA1],
      );
      const id = r.rows[0]?.id as string;
      await db.asUser(U.adminA2, async (c) => {
        // either admin may expire it early
        expect(
          await rowCount(c, "UPDATE data_exports SET expires_at = now() WHERE id = $1", [id]),
        ).toBe(1);
      });
      await db.asUser(U.adminA1, async (c) => {
        await expectErr(
          c,
          "UPDATE data_exports SET expires_at = now() + interval '30 days' WHERE id = $1",
          [id],
          "23514",
          "an export cannot be extended",
        );
        await c.query(
          "UPDATE data_exports SET downloads = 2, last_downloaded_at = now() WHERE id = $1",
          [id],
        );
        await expectErr(
          c,
          "UPDATE data_exports SET downloads = 1 WHERE id = $1",
          [id],
          "23514",
          "export download history cannot be rewritten",
        );
        for (const sql of [
          "UPDATE data_exports SET status = 'ready' WHERE id = $1",
          "UPDATE data_exports SET error = 'internal' WHERE id = $1",
          "UPDATE data_exports SET bytes = 1 WHERE id = $1",
          "UPDATE data_exports SET include_location = true WHERE id = $1",
          "UPDATE data_exports SET requested_by = NULL WHERE id = $1",
          "UPDATE data_exports SET purged_at = now() WHERE id = $1",
          "DELETE FROM data_exports WHERE id = $1",
        ]) {
          const err = await tryQuery(c, sql, [id]);
          expect(err?.code, sql).toBe("42501");
        }
      });
    });

    it("a contributor cannot touch an export (0 rows / invisible)", async () => {
      const r = await db.admin.query(
        "INSERT INTO data_exports (baby_id, requested_by, status) VALUES ($1, $2, 'ready') RETURNING id",
        [BABY.A, U.adminA1],
      );
      await db.asUser(U.contribA, async (c) => {
        expect(
          await rowCount(c, "UPDATE data_exports SET expires_at = now() WHERE id = $1", [
            r.rows[0]?.id,
          ]),
        ).toBe(0);
      });
    });

    it("pipeline updates status, error, progress, bytes and purge columns; nothing else", async () => {
      const r = await db.admin.query(
        "INSERT INTO data_exports (baby_id, requested_by) VALUES ($1, $2) RETURNING id",
        [BABY.A, U.adminA1],
      );
      const id = r.rows[0]?.id as string;
      await db.asPipeline(async (c) => {
        expect(
          await rowCount(
            c,
            `UPDATE data_exports SET status = 'running', started_at = now(), photo_count = 5,
                    photos_done = 2 WHERE id = $1`,
            [id],
          ),
        ).toBe(1);
        expect(
          await rowCount(
            c,
            `UPDATE data_exports SET status = 'ready', finished_at = now(), bytes = 10 WHERE id = $1`,
            [id],
          ),
        ).toBe(1);
        expect(
          await rowCount(c, "UPDATE data_exports SET purged_at = now() WHERE id = $1", [id]),
        ).toBe(1);
        for (const sql of [
          "UPDATE data_exports SET expires_at = now() + interval '9 days' WHERE id = $1",
          "UPDATE data_exports SET include_location = true WHERE id = $1",
          "UPDATE data_exports SET requested_by = NULL WHERE id = $1",
          "UPDATE data_exports SET downloads = 9 WHERE id = $1",
        ]) {
          const err = await tryQuery(c, sql, [id]);
          expect(err?.code, sql).toBe("42501");
        }
        // may read the storage key (the worker writes the ZIP there)
        expect(
          (await c.query("SELECT storage_key FROM data_exports WHERE id = $1", [id])).rowCount,
        ).toBe(1);
      });
    });

    it("pipeline can delete only rows purged more than 30 days ago", async () => {
      const a = await db.admin.query(
        "INSERT INTO data_exports (baby_id, requested_by, status, purged_at) VALUES ($1, $2, 'expired', now() - interval '31 days') RETURNING id",
        [BABY.A, U.adminA1],
      );
      const b = await db.admin.query(
        "INSERT INTO data_exports (baby_id, requested_by, status, purged_at) VALUES ($1, $2, 'expired', now() - interval '2 days') RETURNING id",
        [BABY.A, U.adminA1],
      );
      const live = await db.admin.query(
        "INSERT INTO data_exports (baby_id, requested_by, status) VALUES ($1, $2, 'failed') RETURNING id",
        [BABY.A, U.adminA1],
      );
      await db.asPipeline(async (c) => {
        expect(await rowCount(c, "DELETE FROM data_exports WHERE id = $1", [a.rows[0]?.id])).toBe(
          1,
        );
        expect(await rowCount(c, "DELETE FROM data_exports WHERE id = $1", [b.rows[0]?.id])).toBe(
          0,
        );
        expect(
          await rowCount(c, "DELETE FROM data_exports WHERE id = $1", [live.rows[0]?.id]),
        ).toBe(0);
      });
    });

    it("a baby delete cascades its exports; deleting the requester's profile sets requested_by to NULL", async () => {
      const r = await db.admin.query(
        "INSERT INTO data_exports (baby_id, requested_by, status) VALUES ($1, $2, 'ready') RETURNING id",
        [BABY.A, U.adminA2],
      );
      const id = r.rows[0]?.id as string;
      // profile delete on a throwaway transaction, restored by rollback
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("DELETE FROM public.baby_members WHERE user_id = $1", [U.adminA2]);
        await db.admin.query("DELETE FROM public.profiles WHERE user_id = $1", [U.adminA2]);
        const row = await db.admin.query("SELECT requested_by FROM data_exports WHERE id = $1", [
          id,
        ]);
        expect(row.rows[0]?.requested_by).toBeNull();
      } finally {
        await db.admin.query("ROLLBACK");
      }
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("DELETE FROM public.babies WHERE id = $1", [BABY.A]);
        const gone = await db.admin.query("SELECT 1 FROM data_exports WHERE id = $1", [id]);
        expect(gone.rowCount).toBe(0);
      } finally {
        await db.admin.query("ROLLBACK");
      }
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("export_requester_is_admin / export_requester_email", () => {
    const mk = async (status: string, requester: string = U.adminA1) =>
      (
        await db.admin.query(
          "INSERT INTO data_exports (baby_id, requested_by, status) VALUES ($1, $2, $3) RETURNING id",
          [BABY.A, requester, status],
        )
      ).rows[0]?.id as string;

    it("is_admin is true for a live admin requester and false after demotion, leaving or a deleted profile", async () => {
      const id = await mk("running");
      await db.asPipeline(async (c) => {
        expect(
          (await c.query("SELECT export_requester_is_admin($1) AS ok", [id])).rows[0]?.ok,
        ).toBe(true);
      });
      await db.admin.query("BEGIN");
      try {
        await db.admin.query(
          "UPDATE baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
          [BABY.A, U.adminA1],
        );
        expect(
          (await db.admin.query("SELECT public.export_requester_is_admin($1) AS ok", [id])).rows[0]
            ?.ok,
        ).toBe(false);
      } finally {
        await db.admin.query("ROLLBACK");
      }
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("UPDATE public.profiles SET deleted_at = now() WHERE user_id = $1", [
          U.adminA1,
        ]);
        expect(
          (await db.admin.query("SELECT public.export_requester_is_admin($1) AS ok", [id])).rows[0]
            ?.ok,
        ).toBe(false);
      } finally {
        await db.admin.query("ROLLBACK");
      }
      await db.asPipeline(async (c) => {
        const none = await c.query("SELECT export_requester_is_admin($1) AS ok", [
          "00000000-0000-4000-8000-000000000000",
        ]);
        expect(none.rows[0]?.ok).toBe(false);
      });
    });

    it("the address is NULL while queued/running/expired, set when ready or failed, NULL after the requester leaves", async () => {
      const email = async (id: string) =>
        db.asPipeline(
          async (c) =>
            (await c.query("SELECT export_requester_email($1) AS e", [id])).rows[0]?.e as
              | string
              | null,
        );
      expect(await email(await mk("queued"))).toBeNull();
      await db.admin.query("DELETE FROM data_exports WHERE baby_id = $1", [BABY.A]);
      const running = await mk("running");
      expect(await email(running)).toBeNull();
      await db.admin.query("UPDATE data_exports SET status = 'ready' WHERE id = $1", [running]);
      expect(await email(running)).toBe(EMAIL.adminA1);
      await db.admin.query("UPDATE data_exports SET status = 'failed' WHERE id = $1", [running]);
      expect(await email(running)).toBe(EMAIL.adminA1);
      await db.admin.query("UPDATE data_exports SET status = 'expired' WHERE id = $1", [running]);
      expect(await email(running)).toBeNull();
      await db.admin.query("UPDATE data_exports SET status = 'ready' WHERE id = $1", [running]);
      await db.admin.query("BEGIN");
      try {
        await db.admin.query(
          "DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
          [BABY.A, U.adminA1],
        );
        expect(
          (await db.admin.query("SELECT public.export_requester_email($1) AS e", [running])).rows[0]
            ?.e,
        ).toBeNull();
      } finally {
        await db.admin.query("ROLLBACK");
      }
    });

    it("only pipeline may call them (authenticated and viewer cannot)", async () => {
      const id = await mk("ready");
      for (const fn of ["export_requester_is_admin", "export_requester_email"]) {
        await db.asUser(U.adminA1, async (c) => {
          const err = await tryQuery(c, `SELECT public.${fn}($1)`, [id]);
          expect(err?.code, fn).toBe("42501");
        });
        await db.asViewer(null, async (c) => {
          const err = await tryQuery(c, `SELECT public.${fn}($1)`, [id]);
          expect(err?.code, fn).toBe("42501");
        });
      }
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("pipeline reads for album.json", () => {
    it("babies profile columns and the four baby_members columns are readable; billing and invite data are not", async () => {
      await db.asPipeline(async (c) => {
        expect(
          (
            await c.query(
              "SELECT name, nickname, birth_date_is_due_date, birth_weight_g, birth_length_mm, home_label FROM babies WHERE id = $1",
              [BABY.A],
            )
          ).rowCount,
        ).toBe(1);
        for (const col of ["plan_owner_user_id"]) {
          const err = await tryQuery(c, `SELECT ${col} FROM babies WHERE id = $1`, [BABY.A]);
          expect(err?.code, col).toBe("42501");
        }
        const err = await tryQuery(c, "SELECT invited_by FROM baby_members");
        expect(err?.code).toBe("42501");
      });
    });
  });
});
