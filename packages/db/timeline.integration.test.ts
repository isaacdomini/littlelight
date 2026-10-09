import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// packages/db has no dependency on @littlelight/shared: relative imports on purpose.
import { ageGroupKey } from "../shared/src/age";
import { MAX_CUSTOM_MILESTONES_PER_BABY } from "../shared/src/constants";
import {
  BABY,
  createFixtures,
  dropFixtures,
  LINK,
  MILESTONE_FIRST_SMILE,
  P,
  U,
} from "./test/fixtures";
import {
  connect,
  type Db,
  databaseUrl,
  ensureMigrated,
  PERMISSION_DENIED,
  RLS_VIOLATION,
  tryQuery,
} from "./test/harness";

// Step 5 database rules (docs/plans/step-5.md 2.3, 2.10; packages/db/README.md "Timeline and
// details"): sort_at + the keyset index under RLS, age_group parity with the TS function, the
// once-per-statement membership helpers, the milestone cap/name rules, the measurement photo
// rule and the shape triggers that replaced the parent-text CHECKs.

type Row = Record<string, unknown>;

describe.skipIf(!databaseUrl)("timeline and details (step 5)", () => {
  let db: Db;
  const a = () => db.admin;
  const q = (sql: string, params: unknown[] = []) => a().query(sql, params);
  const err = (sql: string, params: unknown[] = []) => tryQuery(a(), sql, params);

  async function sandbox<T>(fn: () => Promise<T>): Promise<T> {
    await a().query("BEGIN");
    try {
      return await fn();
    } finally {
      await a().query("ROLLBACK");
    }
  }

  /** SQLSTATE, message and DETAIL of a failing statement (null when it succeeds). */
  async function fail(c: pg.ClientBase, sql: string, params: unknown[] = []) {
    await c.query("SAVEPOINT f");
    try {
      await c.query(sql, params);
      await c.query("RELEASE SAVEPOINT f");
      return null;
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT f");
      const x = e as { code?: string; message: string; detail?: string; constraint?: string };
      return { code: x.code, message: x.message, detail: x.detail, constraint: x.constraint };
    }
  }

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await createFixtures(db.admin);
  });
  afterAll(async () => {
    if (!db) return;
    await dropFixtures(db.admin);
    await db.close();
  });

  // ---------------------------------------------------------------------------------------------
  describe("age_group() equals the shared ageGroupKey()", () => {
    it("matches for -10..2000 and NULL", async () => {
      const r = await q(
        "SELECT d, public.age_group(d) AS k FROM generate_series(-10, 2000) AS d ORDER BY d",
      );
      expect(r.rows).toHaveLength(2011);
      const wrong = (r.rows as { d: number; k: string }[]).filter((x) => x.k !== ageGroupKey(x.d));
      expect(wrong).toEqual([]);
      const n = await q("SELECT public.age_group(NULL) AS k");
      expect((n.rows[0] as Row).k).toBe(ageGroupKey(null));
      expect((n.rows[0] as Row).k).toBe("unknown");
    });

    it("is IMMUTABLE and executable by the app roles, not PUBLIC", async () => {
      const r = await q(
        `SELECT provolatile, prosecdef, has_function_privilege('authenticated', oid, 'EXECUTE') AS auth,
                has_function_privilege('viewer', oid, 'EXECUTE') AS viewer,
                has_function_privilege('pipeline', oid, 'EXECUTE') AS pipeline,
                has_function_privilege('anon', oid, 'EXECUTE') AS anon
           FROM pg_proc WHERE proname = 'age_group'`,
      );
      expect(r.rows).toEqual([
        {
          provolatile: "i",
          prosecdef: false,
          auth: true,
          viewer: true,
          pipeline: true,
          anon: false,
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("timeline keyset page uses photos_baby_id_sort_idx under RLS", () => {
    const DEEP_BABY = "f2000000-0000-4000-8000-0000000000d1";
    const ROWS = 4000;

    interface PlanNode {
      "Node Type": string;
      "Relation Name"?: string;
      "Index Name"?: string;
      "Index Cond"?: string;
      Filter?: string;
      Plans?: PlanNode[];
    }
    const walk = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
      out.push(n);
      for (const c of n.Plans ?? []) walk(c, out);
      return out;
    };

    async function seed() {
      await q(
        "INSERT INTO babies (id, name, birth_date, plan) VALUES ($1, 'Deep', '2025-06-30', 'plus')",
        [DEEP_BABY],
      );
      await q("INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')", [
        DEEP_BABY,
        U.adminA1,
      ]);
      await q(
        `INSERT INTO photos (baby_id, uploaded_by, storage_key_original, status, approval, taken_at, age_days)
         SELECT $1::uuid, $2::uuid, 'deep/' || g, 'ingested', 'approved',
                '2026-01-01T00:00:00Z'::timestamptz - g * interval '7 minutes', g / 10
           FROM generate_series(1, $3::int) g`,
        [DEEP_BABY, U.adminA1, ROWS],
      );
      await q("ANALYZE photos");
    }

    async function explain(sql: string): Promise<PlanNode[]> {
      await q("SET LOCAL ROLE authenticated");
      await q("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: U.adminA1, role: "authenticated", aud: "authenticated" }),
      ]);
      const r = await q(`EXPLAIN (FORMAT JSON) ${sql}`);
      await q("RESET ROLE");
      return walk(((r.rows[0] as Row)["QUERY PLAN"] as { Plan: PlanNode }[])[0]?.Plan as PlanNode);
    }

    const pageSql = (cursor: { at: string; id: string }, dir: "older" | "newer") =>
      `SELECT p.id FROM public.photos p
        WHERE p.baby_id = '${DEEP_BABY}' AND p.deleted_at IS NULL AND p.approval <> 'rejected'
          AND p.status NOT IN ('failed', 'duplicate')
          AND (p.sort_at, p.id) ${dir === "older" ? "<" : ">"} ('${cursor.at}'::timestamptz, '${cursor.id}'::uuid)
        ORDER BY p.sort_at ${dir === "older" ? "DESC" : "ASC"}, p.id ${dir === "older" ? "DESC" : "ASC"}
        LIMIT 201`;

    for (const dir of ["older", "newer"] as const) {
      it(`a deep ${dir} page is an index range scan with the ROW bound in Index Cond, not Filter`, async () => {
        await sandbox(async () => {
          await seed();
          const mid = (
            await q(
              `SELECT to_char(sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, id
                 FROM photos WHERE baby_id = $1 ORDER BY sort_at DESC, id DESC OFFSET 3000 LIMIT 1`,
              [DEEP_BABY],
            )
          ).rows[0] as { at: string; id: string };
          const nodes = await explain(pageSql(mid, dir));
          const scans = nodes.filter((n) => n["Relation Name"] === "photos");
          expect(scans.length).toBeGreaterThan(0);
          for (const s of scans) {
            expect(s["Node Type"], JSON.stringify(s)).not.toBe("Seq Scan");
            expect(s["Index Name"]).toBe("photos_baby_id_sort_idx");
            // The keyset bound is a btree row comparison on plain columns: an index condition.
            expect(s["Index Cond"]).toMatch(/sort_at/);
            expect(s["Index Cond"]).toMatch(/ROW\(.*sort_at.*id.*\)|\(sort_at, id\)/);
            expect(s["Index Cond"]).toMatch(dir === "older" ? /</ : />/);
            // ...and not left to a post-RLS filter.
            expect(s.Filter ?? "").not.toMatch(/sort_at/);
          }
        });
      });
    }

    it("returns exactly the rows after the cursor (the plan is not just shaped right)", async () => {
      await sandbox(async () => {
        await seed();
        const rows = (
          await q(
            `SELECT id, to_char(sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
               FROM photos WHERE baby_id = $1 ORDER BY sort_at DESC, id DESC`,
            [DEEP_BABY],
          )
        ).rows as { id: string; at: string }[];
        const cut = rows[3000] as { id: string; at: string };
        await q("SET LOCAL ROLE authenticated");
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.adminA1, role: "authenticated", aud: "authenticated" }),
        ]);
        const older = await q(pageSql(cut, "older"));
        const newer = await q(pageSql(cut, "newer"));
        await q("RESET ROLE");
        expect(older.rows.map((r) => (r as Row).id)).toEqual(
          rows.slice(3001, 3001 + 201).map((r) => r.id),
        );
        expect(newer.rows.map((r) => (r as Row).id)).toEqual(
          rows
            .slice(3000 - 201, 3000)
            .reverse()
            .map((r) => r.id),
        );
      });
    });
  });

  describe("indexes", () => {
    it("the step-2 indexes are gone; the step-5 ones exist", async () => {
      const r = await q(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
          AND indexname IN ('photos_baby_id_taken_at_idx', 'photo_details_milestone_id_idx',
                            'photos_baby_id_sort_idx', 'photos_baby_id_age_days_idx',
                            'photo_details_milestone_id_photo_id_idx', 'measurements_photo_id_idx')
          ORDER BY 1`,
      );
      expect(r.rows.map((x) => (x as Row).indexname)).toEqual([
        "measurements_photo_id_idx",
        "photo_details_milestone_id_photo_id_idx",
        "photos_baby_id_age_days_idx",
        "photos_baby_id_sort_idx",
      ]);
    });

    it("sort_at is a stored generated COALESCE(taken_at, created_at)", async () => {
      const col = (
        await q(
          `SELECT is_generated, generation_expression, is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'photos' AND column_name = 'sort_at'`,
        )
      ).rows[0] as Row;
      expect(col.is_generated).toBe("ALWAYS");
      expect(col.is_nullable).toBe("NO");
      expect(String(col.generation_expression)).toMatch(/COALESCE\(taken_at, created_at\)/i);
      const r = await q(
        "SELECT count(*)::int n FROM photos WHERE sort_at IS DISTINCT FROM COALESCE(taken_at, created_at)",
      );
      expect((r.rows[0] as Row).n).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("member_baby_ids() / admin_baby_ids()", () => {
    it("return nothing without claims, and the caller's babies with them", async () => {
      await db.asRole("authenticated", null, async (c) => {
        expect((await c.query("SELECT * FROM public.member_baby_ids()")).rowCount).toBe(0);
        expect((await c.query("SELECT * FROM public.admin_baby_ids()")).rowCount).toBe(0);
      });
      await db.asUser(U.contribA, async (c) => {
        const m = await c.query("SELECT member_baby_ids AS id FROM public.member_baby_ids()");
        const ad = await c.query("SELECT admin_baby_ids AS id FROM public.admin_baby_ids()");
        expect(m.rows.map((r) => (r as Row).id)).toEqual([BABY.A]);
        expect(ad.rowCount).toBe(0);
      });
      await db.asUser(U.adminA1, async (c) => {
        const ad = await c.query("SELECT admin_baby_ids AS id FROM public.admin_baby_ids()");
        expect(ad.rows.map((r) => (r as Row).id)).toEqual([BABY.A]);
      });
      await db.asUser(U.stranger, async (c) => {
        expect((await c.query("SELECT * FROM public.member_baby_ids()")).rowCount).toBe(0);
      });
    });

    it("a viewer-role claim yields nothing (no auth_uid)", async () => {
      await db.asRole("authenticated", { role: "viewer", share_link_id: LINK.LA }, async (c) => {
        expect((await c.query("SELECT * FROM public.member_baby_ids()")).rowCount).toBe(0);
      });
    });

    it("are not executable by viewer, pipeline, anon or PUBLIC", async () => {
      const r = await q(
        `SELECT p.proname,
                has_function_privilege('viewer', p.oid, 'EXECUTE') AS viewer,
                has_function_privilege('pipeline', p.oid, 'EXECUTE') AS pipeline,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
           FROM pg_proc p WHERE p.proname IN ('member_baby_ids', 'admin_baby_ids') ORDER BY 1`,
      );
      expect(r.rows).toEqual([
        {
          proname: "admin_baby_ids",
          viewer: false,
          pipeline: false,
          anon: false,
          authenticated: true,
        },
        {
          proname: "member_baby_ids",
          viewer: false,
          pipeline: false,
          anon: false,
          authenticated: true,
        },
      ]);
      await db.asViewer(LINK.LA, async (c) => {
        const e = await tryQuery(c, "SELECT * FROM public.member_baby_ids()");
        expect(e?.code).toBe("42501");
        expect(e?.message).toMatch(PERMISSION_DENIED);
      });
      await db.asPipeline(async (c) => {
        const e = await tryQuery(c, "SELECT * FROM public.admin_baby_ids()");
        expect(e?.code).toBe("42501");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("photos SELECT semantics are unchanged by the once-per-statement policy", () => {
    const ids = async (c: pg.ClientBase, baby: string) =>
      ((await c.query("SELECT id FROM photos WHERE baby_id = $1", [baby])).rows as Row[])
        .map((r) => r.id as string)
        .sort();

    it("an admin sees every non-quarantined photo of the baby: pending and trashed included", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(await ids(c, BABY.A)).toEqual(
          [
            P.approved1,
            P.approved2,
            P.pendingContrib,
            P.pendingOther,
            P.sensitive,
            P.trashed,
            P.contribApproved,
            P.trashedOld,
            P.trashedRecent,
          ].sort(),
        );
        expect(await ids(c, BABY.B)).toEqual([]);
      });
    });

    it("a contributor sees the approved live album plus their own uploads, nothing trashed or foreign-pending", async () => {
      await db.asUser(U.contribA, async (c) => {
        expect(await ids(c, BABY.A)).toEqual(
          [P.approved1, P.approved2, P.sensitive, P.contribApproved, P.pendingContrib].sort(),
        );
      });
    });

    it("a contributor sees their own trashed upload; a stranger sees nothing", async () => {
      await sandbox(async () => {
        await q("UPDATE photos SET deleted_at = now() WHERE id = $1", [P.pendingContrib]);
        await q("SET LOCAL ROLE authenticated");
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.contribA, role: "authenticated" }),
        ]);
        expect(await ids(a(), BABY.A)).toContain(P.pendingContrib);
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.stranger, role: "authenticated" }),
        ]);
        expect(await ids(a(), BABY.A)).toEqual([]);
        await q("RESET ROLE");
      });
      await db.asUser(U.stranger, async (c) => {
        expect((await c.query("SELECT 1 FROM photos")).rowCount).toBe(0);
      });
    });

    it("a quarantined photo exists for nobody, admins included", async () => {
      await sandbox(async () => {
        await q("UPDATE photos SET quarantined_at = now() WHERE id = $1", [P.approved2]);
        await q("SET LOCAL ROLE authenticated");
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.adminA1, role: "authenticated" }),
        ]);
        expect(await ids(a(), BABY.A)).not.toContain(P.approved2);
        await q("RESET ROLE");
      });
    });

    it("no claims at all: zero rows", async () => {
      await db.asRole("authenticated", null, async (c) => {
        expect((await c.query("SELECT 1 FROM photos")).rowCount).toBe(0);
      });
    });

    it("a viewer reads sort_at of shared photos, but still not originals", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const r = await c.query("SELECT id, sort_at FROM photos ORDER BY id");
        expect(r.rowCount).toBe(2);
        for (const row of r.rows as Row[]) expect(row.sort_at).toBeInstanceOf(Date);
        for (const col of ["storage_key_original", "sha256", "bytes"]) {
          const e = await tryQuery(c, `SELECT ${col} FROM photos`);
          expect(e?.code, col).toBe("42501");
        }
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("milestones", () => {
    it("a contributor cannot insert, update or delete a custom milestone", async () => {
      await sandbox(async () => {
        const id = (
          await q(
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-own', 'custom', $2) RETURNING id",
            [BABY.A, U.adminA1],
          )
        ).rows[0] as { id: string };
        await q("SET LOCAL ROLE authenticated");
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.contribA, role: "authenticated" }),
        ]);
        const ins = await err(
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-c', 'custom', $2)",
          [BABY.A, U.contribA],
        );
        expect(ins?.code).toBe("42501");
        expect(ins?.message).toMatch(RLS_VIOLATION);
        expect(
          (await q("UPDATE milestones SET name = 'fx-x' WHERE id = $1", [id.id])).rowCount,
        ).toBe(0);
        expect((await q("DELETE FROM milestones WHERE id = $1", [id.id])).rowCount).toBe(0);
        await q("RESET ROLE");
      });
    });

    it("presets are immutable for every user role (admins: 0 rows)", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(
          (
            await c.query("UPDATE milestones SET name = 'fx-hijack' WHERE id = $1", [
              MILESTONE_FIRST_SMILE,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (await c.query("DELETE FROM milestones WHERE id = $1", [MILESTONE_FIRST_SMILE])).rowCount,
        ).toBe(0);
        expect((await c.query("DELETE FROM milestones WHERE baby_id IS NULL")).rowCount).toBe(0);
        const created = await tryQuery(
          c,
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES (NULL, 'fx-preset', 'custom', $1)",
          [U.adminA1],
        );
        expect(created?.code).toBe("42501");
      });
      const r = await q("SELECT name FROM milestones WHERE id = $1", [MILESTONE_FIRST_SMILE]);
      expect((r.rows[0] as Row).name).toBe("First smile");
    });

    it("a custom milestone cannot be turned into a preset (no UPDATE on baby_id)", async () => {
      await sandbox(async () => {
        const id = (
          await q(
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-promote', 'custom', $2) RETURNING id",
            [BABY.A, U.adminA1],
          )
        ).rows[0] as { id: string };
        await q("SET LOCAL ROLE authenticated");
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.adminA1, role: "authenticated" }),
        ]);
        const e = await err("UPDATE milestones SET baby_id = NULL WHERE id = $1", [id.id]);
        expect(e?.code).toBe("42501");
        await q("RESET ROLE");
      });
    });

    it("an admin of baby A cannot see baby B's custom milestone, and vice versa", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-b-only', 'custom', $2)",
          [BABY.B, U.adminB],
        );
        await q("SET LOCAL ROLE authenticated");
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.adminA1, role: "authenticated" }),
        ]);
        expect((await q("SELECT 1 FROM milestones WHERE name = 'fx-b-only'")).rowCount).toBe(0);
        expect((await q("DELETE FROM milestones WHERE name = 'fx-b-only'")).rowCount).toBe(0);
        await q("RESET ROLE");
      });
    });

    it("the 201st custom milestone of a baby is rejected (23514 milestone limit reached)", async () => {
      expect(MAX_CUSTOM_MILESTONES_PER_BABY).toBe(200);
      await sandbox(async () => {
        await q(
          `INSERT INTO milestones (baby_id, name, category, created_by)
           SELECT $1, 'fx-cap-' || g, 'custom', $2 FROM generate_series(1, 200) g`,
          [BABY.A, U.adminA1],
        );
        const e = await fail(
          a(),
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-cap-201', 'custom', $2)",
          [BABY.A, U.adminA1],
        );
        expect(e?.code).toBe("23514");
        expect(e?.message).toBe("milestone limit reached");
        // Another baby is unaffected.
        expect(
          await fail(
            a(),
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-cap-b', 'custom', $2)",
            [BABY.B, U.adminB],
          ),
        ).toBeNull();
      });
    });

    it.each(["First smile", "first smile", "FIRST SMILE", "fIrSt SmIlE"])(
      "inserting the preset name %j is a unique violation on milestones_baby_id_lower_name_key",
      async (name) => {
        await sandbox(async () => {
          const e = await fail(
            a(),
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, $2, 'custom', $3)",
            [BABY.A, name, U.adminA1],
          );
          expect(e?.code).toBe("23505");
          expect(e?.constraint).toBe("milestones_baby_id_lower_name_key");
          expect(e?.detail ?? "").not.toMatch(/first smile/i);
        });
      },
    );

    it("renaming a custom milestone to a preset's name (any case) is rejected the same way", async () => {
      await sandbox(async () => {
        const id = (
          await q(
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-rename', 'custom', $2) RETURNING id",
            [BABY.A, U.adminA1],
          )
        ).rows[0] as { id: string };
        const e = await fail(a(), "UPDATE milestones SET name = 'first STEPS' WHERE id = $1", [
          id.id,
        ]);
        expect(e?.code).toBe("23505");
        expect(e?.constraint).toBe("milestones_baby_id_lower_name_key");
        expect(
          await fail(a(), "UPDATE milestones SET name = 'fx-renamed' WHERE id = $1", [id.id]),
        ).toBeNull();
      });
    });

    it("a duplicate custom name in one baby (any case) is the same unique violation; other babies may reuse it", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-dup', 'custom', $2)",
          [BABY.A, U.adminA1],
        );
        const e = await fail(
          a(),
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'FX-DUP', 'custom', $2)",
          [BABY.A, U.adminA1],
        );
        expect(e?.constraint).toBe("milestones_baby_id_lower_name_key");
        expect(
          await fail(
            a(),
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-dup', 'custom', $2)",
            [BABY.B, U.adminB],
          ),
        ).toBeNull();
      });
    });

    it("names are 1..80 characters (shape trigger, 23514, no detail)", async () => {
      await sandbox(async () => {
        for (const name of ["", "x".repeat(81)]) {
          const e = await fail(
            a(),
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, $2, 'custom', $3)",
            [BABY.A, name, U.adminA1],
          );
          expect(e?.code).toBe("23514");
          expect(e?.detail).toBeUndefined();
        }
        expect(
          await fail(
            a(),
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, $2, 'custom', $3)",
            [BABY.A, `fx-${"y".repeat(77)}`, U.adminA1],
          ),
        ).toBeNull();
      });
    });

    it("updated_at bumps on an UPDATE in a later transaction", async () => {
      let id: string | undefined;
      try {
        id = (
          await q(
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-upd', 'custom', $2) RETURNING id",
            [BABY.A, U.adminA1],
          )
        ).rows[0].id as string;
        const t0 = (await q("SELECT updated_at FROM milestones WHERE id = $1", [id]))
          .rows[0] as Row;
        await new Promise((r) => setTimeout(r, 20));
        await q("UPDATE milestones SET category = 'event' WHERE id = $1", [id]);
        const t1 = (await q("SELECT updated_at, created_at FROM milestones WHERE id = $1", [id]))
          .rows[0] as Row;
        expect((t1.updated_at as Date).getTime()).toBeGreaterThan(
          (t0.updated_at as Date).getTime(),
        );
        expect(t1.created_at).toEqual(t0.updated_at);
      } finally {
        if (id) await q("DELETE FROM milestones WHERE id = $1", [id]);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("measurements", () => {
    const ins = (photo: string | null, metric: number | string = 3400, extra = "") =>
      q(
        `INSERT INTO measurements (baby_id, photo_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by${extra ? ", note" : ""})
         VALUES ($1, $2, 'weight', $3, 3400, 'g', now(), $4${extra ? ", $5" : ""})`,
        [BABY.A, photo, metric, U.adminA1, ...(extra ? [extra] : [])],
      );
    const failIns = (photo: string | null, metric: number | string = 3400) =>
      fail(
        a(),
        `INSERT INTO measurements (baby_id, photo_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
         VALUES ($1, $2, 'weight', $3, 3400, 'g', now(), $4)`,
        [BABY.A, photo, metric, U.adminA1],
      );

    it("accepts no photo, or a live photo of the same baby", async () => {
      await sandbox(async () => {
        await ins(null);
        await ins(P.approved1);
        await ins(P.pendingContrib);
      });
    });

    it("rejects another baby's photo, a trashed photo and a quarantined photo (23514, no detail)", async () => {
      await sandbox(async () => {
        await q("UPDATE photos SET quarantined_at = now() WHERE id = $1", [P.approved2]);
        for (const photo of [P.b1, P.trashed, P.approved2]) {
          const e = await failIns(photo);
          expect(e?.code, photo).toBe("23514");
          expect(e?.message).toBe("measurement photo must belong to the same baby");
          expect(e?.detail).toBeUndefined();
        }
      });
    });

    it("re-pointing an existing measurement to a foreign photo is rejected too", async () => {
      await sandbox(async () => {
        await ins(P.approved1);
        const e = await fail(
          a(),
          "UPDATE measurements SET photo_id = $1 WHERE baby_id = $2 AND photo_id = $3",
          [P.b1, BABY.A, P.approved1],
        );
        expect(e?.code).toBe("23514");
      });
    });

    it.each([200001, 9999999, 0, -1, -0.001])(
      "value_metric %s is rejected (23514, no detail)",
      async (v) => {
        await sandbox(async () => {
          const e = await failIns(null, v);
          expect(e?.code).toBe("23514");
          expect(e?.detail).toBeUndefined();
        });
      },
    );

    it("value_metric 200000 passes, value_entered <= 0 is rejected", async () => {
      await sandbox(async () => {
        expect(await failIns(null, 200000)).toBeNull();
        const e = await fail(
          a(),
          `INSERT INTO measurements (baby_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
           VALUES ($1, 'weight', 3400, 0, 'g', now(), $2)`,
          [BABY.A, U.adminA1],
        );
        expect(e?.code).toBe("23514");
        expect(e?.detail).toBeUndefined();
      });
    });

    it("a viewer has no access, and contributors cannot write", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const e = await tryQuery(c, "SELECT * FROM measurements");
        expect(e?.code).toBe("42501");
      });
      await db.asUser(U.contribA, async (c) => {
        const e = await tryQuery(
          c,
          `INSERT INTO measurements (baby_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
           VALUES ($1, 'weight', 3400, 3400, 'g', now(), $2)`,
          [BABY.A, U.contribA],
        );
        expect(e?.code).toBe("42501");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("milestone same-baby rule", () => {
    let foreign: string;
    const makeForeign = async () => {
      foreign = (
        await q(
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-foreign', 'custom', $2) RETURNING id",
          [BABY.B, U.adminB],
        )
      ).rows[0].id as string;
    };

    it("photo_details accepts a preset and the baby's own milestone, rejects another baby's (23514)", async () => {
      await sandbox(async () => {
        await makeForeign();
        const own = (
          await q(
            "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-own', 'custom', $2) RETURNING id",
            [BABY.A, U.adminA1],
          )
        ).rows[0].id as string;
        expect(
          await fail(a(), "INSERT INTO photo_details (photo_id, milestone_id) VALUES ($1, $2)", [
            P.approved2,
            MILESTONE_FIRST_SMILE,
          ]),
        ).toBeNull();
        expect(
          await fail(a(), "UPDATE photo_details SET milestone_id = $2 WHERE photo_id = $1", [
            P.approved2,
            own,
          ]),
        ).toBeNull();
        const e = await fail(
          a(),
          "UPDATE photo_details SET milestone_id = $2 WHERE photo_id = $1",
          [P.approved2, foreign],
        );
        expect(e?.code).toBe("23514");
        expect(e?.message).toBe("photo_details.milestone_id must belong to the same baby");
        expect(e?.detail).toBeUndefined();
        const e2 = await fail(
          a(),
          "INSERT INTO photo_details (photo_id, milestone_id) VALUES ($1, $2)",
          [P.pendingOther, foreign],
        );
        expect(e2?.code).toBe("23514");
      });
    });

    it("upload_sessions rejects another baby's milestone (23514), accepts a preset", async () => {
      await sandbox(async () => {
        await makeForeign();
        const insert = (m: string) =>
          fail(
            a(),
            "INSERT INTO upload_sessions (baby_id, created_by, milestone_id) VALUES ($1, $2, $3)",
            [BABY.A, U.adminA1, m],
          );
        expect(await insert(MILESTONE_FIRST_SMILE)).toBeNull();
        const e = await insert(foreign);
        expect(e?.code).toBe("23514");
        expect(e?.message).toBe("upload_sessions.milestone_id must belong to the same baby");
        expect(e?.detail).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("shape triggers raise 23514 without a DETAIL that could carry the value", () => {
    const SECRET = "secret-parent-text";
    const long = (n: number) => `${SECRET}${"x".repeat(n)}`;
    const cases: Array<[string, string, unknown[]]> = [
      [
        "photo_details.note 2001",
        "INSERT INTO photo_details (photo_id, note) VALUES ($1, $2)",
        [P.approved2, long(2001)],
      ],
      [
        "photo_details.people 21",
        "INSERT INTO photo_details (photo_id, people) VALUES ($1, ARRAY(SELECT $2 || g FROM generate_series(1, 21) g))",
        [P.approved2, SECRET],
      ],
      [
        "photo_details.location_label 121",
        "INSERT INTO photo_details (photo_id, location_label) VALUES ($1, $2)",
        [P.approved2, long(121)],
      ],
      [
        "measurements.note 2001",
        "INSERT INTO measurements (baby_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by, note) VALUES ($3, 'weight', 3400, 3400, 'g', now(), $1, $2)",
        [U.adminA1, long(2001), BABY.A],
      ],
      [
        "upload_sessions.note 2001",
        "INSERT INTO upload_sessions (baby_id, created_by, note) VALUES ($1, $2, $3)",
        [BABY.A, U.adminA1, long(2001)],
      ],
      [
        "upload_sessions.people 21",
        "INSERT INTO upload_sessions (baby_id, created_by, people) VALUES ($1, $2, ARRAY(SELECT $3 || g FROM generate_series(1, 21) g))",
        [BABY.A, U.adminA1, SECRET],
      ],
      [
        "upload_sessions.location_label 121",
        "INSERT INTO upload_sessions (baby_id, created_by, location_label) VALUES ($1, $2, $3)",
        [BABY.A, U.adminA1, long(121)],
      ],
      [
        "babies.name 81",
        "INSERT INTO babies (name, birth_date) VALUES ($1, '2026-01-01')",
        [long(81)],
      ],
      ["babies.name empty", "INSERT INTO babies (name, birth_date) VALUES ('', '2026-01-01')", []],
      [
        "babies.birth_weight_g 0",
        "INSERT INTO babies (name, birth_date, birth_weight_g) VALUES ('x', '2026-01-01', 0)",
        [],
      ],
      [
        "babies.birth_length_mm -5",
        "INSERT INTO babies (name, birth_date, birth_length_mm) VALUES ('x', '2026-01-01', -5)",
        [],
      ],
      [
        "share_links.name 81",
        "INSERT INTO share_links (baby_id, name, token_hash, created_by) VALUES ($1, $2, decode(repeat('55', 32), 'hex'), $3)",
        [BABY.A, long(81), U.adminA1],
      ],
      [
        "milestones.name 81",
        "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, $2, 'custom', $3)",
        [BABY.A, long(81), U.adminA1],
      ],
      [
        "chat_threads.title 201",
        "INSERT INTO chat_threads (baby_id, user_id, title) VALUES ($1, $2, $3)",
        [BABY.A, U.adminA1, long(201)],
      ],
      [
        "invites.email upper-case",
        "INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'Secret@Example.COM', 'contributor', decode(repeat('66', 32), 'hex'), $2)",
        [BABY.A, U.adminA1],
      ],
      [
        "photo_ai_overrides.field_path 201",
        "INSERT INTO photo_ai_overrides (photo_id, field_path, value, edited_by) VALUES ($1, $2, '\"v\"'::jsonb, $3)",
        [P.approved2, long(201), U.adminA1],
      ],
    ];

    it.each(cases)("%s -> 23514, message and detail name no value", async (_name, sql, params) => {
      await sandbox(async () => {
        const e = await fail(a(), sql, params);
        expect(e, "expected the shape trigger to fire").not.toBeNull();
        expect(e?.code).toBe("23514");
        expect(e?.detail).toBeUndefined();
        expect(e?.message).not.toContain(SECRET);
        expect(e?.message).not.toMatch(/Failing row contains/i);
        expect(e?.message).not.toMatch(/example\.com/i);
      });
    });

    const boundary: Array<[string, string, unknown[]]> = [
      [
        "photo_details.note 2000",
        "INSERT INTO photo_details (photo_id, note) VALUES ($1, repeat('n', 2000))",
        [P.approved2],
      ],
      [
        "photo_details.people 20",
        "INSERT INTO photo_details (photo_id, people) VALUES ($1, ARRAY(SELECT 'p' || g FROM generate_series(1, 20) g))",
        [P.approved2],
      ],
      [
        "photo_details.location_label 120",
        "INSERT INTO photo_details (photo_id, location_label) VALUES ($1, repeat('l', 120))",
        [P.approved2],
      ],
      [
        "babies.name 80",
        "INSERT INTO babies (name, birth_date) VALUES (repeat('b', 80), '2026-01-01')",
        [],
      ],
      [
        "chat_threads.title 200",
        "INSERT INTO chat_threads (baby_id, user_id, title) VALUES ($1, $2, repeat('t', 200))",
        [BABY.A, U.adminA1],
      ],
      [
        "invites.email lower-case",
        "INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'ok@example.com', 'contributor', decode(repeat('77', 32), 'hex'), $2)",
        [BABY.A, U.adminA1],
      ],
    ];
    it.each(boundary)("the limit itself is accepted: %s", async (_name, sql, params) => {
      await sandbox(async () => {
        // One thread per (baby, user) since step 7: free the pair the fixture already uses.
        await a().query("DELETE FROM chat_threads WHERE baby_id = $1 AND user_id = $2", [
          BABY.A,
          U.adminA1,
        ]);
        expect(await fail(a(), sql, params)).toBeNull();
      });
    });

    it("the triggers also fire on UPDATE", async () => {
      await sandbox(async () => {
        const e = await fail(
          a(),
          "UPDATE photo_details SET note = repeat('z', 2001) WHERE photo_id = $1",
          [P.approved1],
        );
        expect(e?.code).toBe("23514");
        const e2 = await fail(a(), "UPDATE invites SET email = upper(email) WHERE baby_id = $1", [
          BABY.A,
        ]);
        expect(e2?.code).toBe("23514");
        const e3 = await fail(a(), "UPDATE babies SET name = repeat('n', 81) WHERE id = $1", [
          BABY.A,
        ]);
        expect(e3?.code).toBe("23514");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("catalog", () => {
    it("no CHECK that is not an IN-list remains on the nine converted tables (hash lengths aside)", async () => {
      const r = await q(
        `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE contype = 'c' AND connamespace = 'public'::regnamespace
            AND conrelid::regclass::text = ANY($1)
          ORDER BY 1, 2`,
        [
          [
            "photo_details",
            "measurements",
            "milestones",
            "babies",
            "upload_sessions",
            "share_links",
            "chat_threads",
            "invites",
            "photo_ai_overrides",
          ],
        ],
      );
      const rest = (r.rows as { tbl: string; conname: string; def: string }[]).filter(
        (c) => !/= ANY \(ARRAY\[/.test(c.def),
      );
      // The only non-enum CHECKs left constrain a server-generated hash's byte length: the
      // failing-row DETAIL would show a hash, never parent text.
      expect(rest.map((c) => c.conname)).toEqual([
        "invites_token_hash_check",
        "share_links_token_hash_check",
      ]);
      for (const c of rest) expect(c.def).toMatch(/octet_length\(token_hash\)/);
    });

    it("each converted table has its shape trigger", async () => {
      const r = await q(
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1) ORDER BY 1`,
        [
          [
            "photo_details_shape",
            "measurements_shape",
            "measurements_photo_same_baby",
            "milestones_name_guard",
            "milestones_cap",
            "babies_shape",
            "upload_sessions_shape",
            "share_links_shape",
            "chat_threads_shape",
            "invites_shape",
            "photo_ai_overrides_shape",
          ],
        ],
      );
      expect(r.rowCount).toBe(11);
    });

    it("shape and guard functions are not executable by any app role or PUBLIC", async () => {
      const r = await q(
        `SELECT p.proname, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') AS can
           FROM pg_proc p CROSS JOIN unnest(ARRAY['anon','authenticated','viewer','pipeline','littlelight_api','littlelight_worker']) AS r(role)
          WHERE p.proname ~ '_shape$|^milestones_(cap|name_guard)$|^measurements_photo_same_baby$'
            AND p.pronamespace = 'public'::regnamespace`,
      );
      expect(r.rowCount).toBeGreaterThanOrEqual(11 * 6);
      expect((r.rows as Row[]).filter((x) => x.can)).toEqual([]);
    });

    it("every table is still ENABLE + FORCE row level security", async () => {
      const r = await q(
        `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE nspname = 'public' AND relkind = 'r' AND relname <> 'pgmigrations'
            AND NOT (relrowsecurity AND relforcerowsecurity)`,
      );
      expect(r.rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("photo_details edits (RLS)", () => {
    it("a contributor edits details of their own pending photo, not an approved or the admin's", async () => {
      await sandbox(async () => {
        await q("SET LOCAL ROLE authenticated");
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.contribA, role: "authenticated" }),
        ]);
        expect(
          await fail(
            a(),
            "INSERT INTO photo_details (photo_id, note, edited_by) VALUES ($1, 'mine', $2)",
            [P.pendingContrib, U.contribA],
          ),
        ).toBeNull();
        const approved = await fail(
          a(),
          "INSERT INTO photo_details (photo_id, note, edited_by) VALUES ($1, 'x', $2)",
          [P.contribApproved, U.contribA],
        );
        expect(approved?.code).toBe("42501");
        const adminsPending = await fail(
          a(),
          "INSERT INTO photo_details (photo_id, note, edited_by) VALUES ($1, 'x', $2)",
          [P.pendingOther, U.contribA],
        );
        expect(adminsPending?.code).toBe("42501");
        await q("RESET ROLE");
      });
    });

    it("an admin cannot edit the details of a trashed photo (photo_editable)", async () => {
      await sandbox(async () => {
        await q("SET LOCAL ROLE authenticated");
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.adminA1, role: "authenticated" }),
        ]);
        const e = await fail(
          a(),
          "INSERT INTO photo_details (photo_id, note, edited_by) VALUES ($1, 'x', $2)",
          [P.trashed, U.adminA1],
        );
        expect(e?.code).toBe("42501");
        expect(
          await fail(
            a(),
            "INSERT INTO photo_details (photo_id, note, edited_by) VALUES ($1, 'x', $2)",
            [P.approved2, U.adminA1],
          ),
        ).toBeNull();
        await q("RESET ROLE");
      });
    });

    it("a viewer cannot read photo_details, measurements or overrides", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        for (const t of ["photo_details", "measurements", "photo_ai_overrides"]) {
          const e = await tryQuery(c, `SELECT * FROM ${t}`);
          expect(e?.code, t).toBe("42501");
        }
      });
    });
  });
});
