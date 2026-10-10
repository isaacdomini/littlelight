import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  A_LINKS,
  A_PHOTOS,
  AI_BATCH,
  BABY,
  createFixtures,
  dropFixtures,
  EMAIL,
  INVITE_A,
  INVITE_B,
  LINK,
  MEASUREMENT_A,
  P,
  THREAD_A,
  U,
} from "./test/fixtures";
import {
  authed,
  connect,
  DATA_KEY,
  type Db,
  databaseUrl,
  ensureMigrated,
  PERMISSION_DENIED,
  RLS_VIOLATION,
  tryQuery,
} from "./test/harness";

// RLS / grant matrix (docs/plans/step-2.md 2.6 and 2.8). Every actor x table x verb cell the plan
// names is asserted. Each case runs in its own transaction that is rolled back, on a connection
// made as tinyglow_api (authenticated / viewer / service_role) or tinyglow_worker (pipeline),
// exactly like the API/worker do it. Fixtures are committed once per file and removed afterwards.
//
// Expectations vocabulary: "rows" = rows returned, "0 rows" = RLS filtered, "RLS violation" =
// 42501 "new row violates row-level security policy", "denied" = 42501 "permission denied".

const A_PHOTO_LIST = A_PHOTOS.map((p) => `'${p}'`).join(",");
const A_LINK_LIST = A_LINKS.map((l) => `'${l}'`).join(",");

/** `count(*)` of the rows that belong to baby A, per baby-scoped table. */
const A_ROWS: Record<string, string> = {
  babies: `id = '${BABY.A}'`,
  baby_members: `baby_id = '${BABY.A}'`,
  invites: `baby_id = '${BABY.A}'`,
  photos: `baby_id = '${BABY.A}'`,
  photo_derivatives: `photo_id IN (${A_PHOTO_LIST})`,
  photo_exif: `photo_id IN (${A_PHOTO_LIST})`,
  photo_details: `photo_id IN (${A_PHOTO_LIST})`,
  measurements: `baby_id = '${BABY.A}'`,
  photo_ai: `photo_id IN (${A_PHOTO_LIST})`,
  photo_ai_overrides: `photo_id IN (${A_PHOTO_LIST})`,
  photo_search: `baby_id = '${BABY.A}'`,
  share_links: `baby_id = '${BABY.A}'`,
  share_rules: `share_link_id IN (${A_LINK_LIST})`,
  shared_photos: `share_link_id IN (${A_LINK_LIST})`,
  viewer_sessions: `share_link_id IN (${A_LINK_LIST})`,
  chat_threads: `baby_id = '${BABY.A}'`,
  chat_messages: `baby_id = '${BABY.A}'`,
  audit_log: `baby_id = '${BABY.A}'`,
};
/** Same for baby B (positive controls: adminB must see these, so "0 rows of A" is not vacuous). */
const B_ROWS: Record<string, string> = {
  babies: `id = '${BABY.B}'`,
  baby_members: `baby_id = '${BABY.B}'`,
  invites: `baby_id = '${BABY.B}'`,
  photos: `baby_id = '${BABY.B}'`,
  measurements: `baby_id = '${BABY.B}'`,
  photo_search: `baby_id = '${BABY.B}'`,
  share_links: `baby_id = '${BABY.B}'`,
  chat_threads: `baby_id = '${BABY.B}'`,
  chat_messages: `baby_id = '${BABY.B}'`,
  audit_log: `baby_id = '${BABY.B}'`,
};

const ALL_APP_TABLES = [
  "profiles",
  "babies",
  "baby_members",
  "invites",
  "milestones",
  "photos",
  "photo_derivatives",
  "photo_exif",
  "photo_details",
  "measurements",
  "ai_batches",
  "photo_ai",
  "photo_ai_overrides",
  "photo_search",
  "share_links",
  "share_rules",
  "shared_photos",
  "viewer_sessions",
  "chat_threads",
  "chat_messages",
  "audit_log",
  "worker_heartbeats",
];

async function count(c: pg.ClientBase, table: string, where = "true"): Promise<number> {
  const r = await c.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`);
  return (r.rows[0] as { n: number }).n;
}
async function ids(c: pg.ClientBase, sql: string): Promise<string[]> {
  const r = await c.query(sql);
  return r.rows.map((x) => (x as { id: string }).id).sort();
}
async function expectDenied(c: pg.ClientBase, sql: string, params: unknown[] = []) {
  const err = await tryQuery(c, sql, params);
  expect(err, `expected "permission denied" for: ${sql}`).not.toBeNull();
  expect(err?.code).toBe("42501");
  expect(err?.message).toMatch(PERMISSION_DENIED);
}
async function expectRlsViolation(c: pg.ClientBase, sql: string, params: unknown[] = []) {
  const err = await tryQuery(c, sql, params);
  expect(err, `expected an RLS violation for: ${sql}`).not.toBeNull();
  expect(err?.code).toBe("42501");
  expect(err?.message).toMatch(RLS_VIOLATION);
}
async function expectContributorGuard(c: pg.ClientBase, sql: string, params: unknown[] = []) {
  const err = await tryQuery(c, sql, params);
  expect(err, `expected the contributor guard for: ${sql}`).not.toBeNull();
  expect(err?.code).toBe("42501");
  expect(err?.message).toBe("contributors may only trash their own pending uploads");
}
async function expectCheckViolation(
  c: pg.ClientBase,
  sql: string,
  message: RegExp,
  params: unknown[] = [],
) {
  const err = await tryQuery(c, sql, params);
  expect(err, `expected a trigger error for: ${sql}`).not.toBeNull();
  expect(err?.code).toBe("23514");
  expect(err?.message).toMatch(message);
}
const rowCount = async (c: pg.ClientBase, sql: string, params: unknown[] = []) =>
  (await c.query(sql, params)).rowCount;

const insertPhoto = (
  c: pg.ClientBase,
  o: { id: string; baby: string; by: string; approval: string; key?: string },
) =>
  c.query(
    `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, approval)
     VALUES ($1, $2, $3, $4, $5)`,
    [o.id, o.baby, o.by, o.key ?? `fx/new/${o.id}`, o.approval],
  );
const NEW_PHOTO = "f3000000-0000-4000-8000-0000000000aa";

describe.skipIf(!databaseUrl)("RLS matrix", () => {
  let db: Db;

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
  describe("another baby's rows are invisible (adminB / stranger vs baby A)", () => {
    it("adminB sees 0 rows of baby A in every baby-scoped table, but sees baby B", async () => {
      await db.asUser(U.adminB, async (c) => {
        for (const [table, where] of Object.entries(A_ROWS)) {
          expect(await count(c, table, where), `${table}: baby A rows leaked`).toBe(0);
        }
        for (const [table, where] of Object.entries(B_ROWS)) {
          expect(await count(c, table, where), `${table}: baby B control`).toBeGreaterThan(0);
        }
      });
    });

    it("adminB cannot read A's data through helpers either (profiles of A members)", async () => {
      await db.asUser(U.adminB, async (c) => {
        expect(await count(c, "profiles", `user_id = '${U.adminA1}'`)).toBe(0);
        expect(await count(c, "profiles", `user_id = '${U.adminB}'`)).toBe(1);
      });
    });

    it("adminB cannot update, soft-delete or delete A's rows (0 rows)", async () => {
      await db.asUser(U.adminB, async (c) => {
        expect(
          await rowCount(c, "UPDATE photos SET deleted_at = now() WHERE baby_id = $1", [BABY.A]),
        ).toBe(0);
        expect(
          await rowCount(c, "UPDATE photos SET is_sensitive = true WHERE id = $1", [P.approved1]),
        ).toBe(0);
        expect(await rowCount(c, "UPDATE babies SET name = 'pwned' WHERE id = $1", [BABY.A])).toBe(
          0,
        );
        expect(
          await rowCount(c, "UPDATE baby_members SET role = 'admin' WHERE baby_id = $1", [BABY.A]),
        ).toBe(0);
        expect(await rowCount(c, "DELETE FROM baby_members WHERE baby_id = $1", [BABY.A])).toBe(0);
        expect(await rowCount(c, "DELETE FROM invites WHERE baby_id = $1", [BABY.A])).toBe(0);
        expect(await rowCount(c, "DELETE FROM share_links WHERE baby_id = $1", [BABY.A])).toBe(0);
        expect(await rowCount(c, "DELETE FROM measurements WHERE baby_id = $1", [BABY.A])).toBe(0);
        expect(await rowCount(c, "DELETE FROM chat_threads WHERE baby_id = $1", [BABY.A])).toBe(0);
        expect(
          await rowCount(c, "DELETE FROM shared_photos WHERE share_link_id = $1", [LINK.LA]),
        ).toBe(0);
        expect(
          await rowCount(c, "DELETE FROM photo_details WHERE photo_id = $1", [P.approved1]),
        ).toBe(0);
      });
      // Nothing changed for real.
      expect(
        await count(
          db.admin,
          "photos",
          `baby_id = '${BABY.A}' AND is_sensitive AND id = '${P.approved1}'`,
        ),
      ).toBe(0);
    });

    it("adminB cannot insert into A (RLS violation)", async () => {
      await db.asUser(U.adminB, async (c) => {
        await expectRlsViolation(
          c,
          "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'contributor')",
          [BABY.A, U.adminB],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ($1, $2, 'user', $3)",
          [LINK.LA, P.contribApproved, U.adminB],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, $3, 'fx/x', 'approved')",
          [NEW_PHOTO, BABY.A, U.adminB],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'x@y.co', 'contributor', decode(repeat('ab', 32), 'hex'), $2)",
          [BABY.A, U.adminB],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO share_links (baby_id, name, token_hash, created_by) VALUES ($1, 'x', decode(repeat('cd', 32), 'hex'), $2)",
          [BABY.A, U.adminB],
        );
        await expectRlsViolation(c, "INSERT INTO chat_threads (baby_id, user_id) VALUES ($1, $2)", [
          BABY.A,
          U.adminB,
        ]);
        await expectRlsViolation(
          c,
          "INSERT INTO measurements (baby_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by) VALUES ($1, 'weight', 1, 1, 'g', now(), $2)",
          [BABY.A, U.adminB],
        );
      });
    });

    it("stranger (no memberships) sees 0 rows everywhere, only their own profile", async () => {
      await db.asUser(U.stranger, async (c) => {
        for (const [table, where] of Object.entries(A_ROWS)) {
          if (table === "profiles") continue;
          expect(await count(c, table, where), table).toBe(0);
        }
        for (const [table, where] of Object.entries(B_ROWS)) {
          expect(await count(c, table, where), `${table} (B)`).toBe(0);
        }
        // Whole-table counts: nothing but own profile and global milestone presets.
        for (const t of [
          "babies",
          "baby_members",
          "invites",
          "photos",
          "photo_derivatives",
          "photo_details",
          "measurements",
          "photo_ai",
          "photo_ai_overrides",
          "photo_search",
          "share_links",
          "share_rules",
          "shared_photos",
          "viewer_sessions",
          "chat_threads",
          "chat_messages",
          "audit_log",
        ]) {
          expect(await count(c, t), `${t}: stranger sees rows`).toBe(0);
        }
        expect(await count(c, "profiles")).toBe(1);
        expect(await count(c, "milestones", "baby_id IS NOT NULL")).toBe(0);
        expect(await count(c, "photo_exif")).toBe(0);
      });
    });

    it("stranger can create their own baby and becomes its admin (trigger), seeing only it", async () => {
      await db.asUser(U.stranger, async (c) => {
        const baby = "f2000000-0000-4000-8000-0000000000bb";
        const r = await c.query(
          "INSERT INTO babies (id, name, birth_date, created_by) VALUES ($1, 'Mine', '2026-01-01', $2) RETURNING id",
          [baby, U.stranger],
        );
        expect(r.rows[0]?.id).toBe(baby);
        const m = await c.query("SELECT user_id, role FROM baby_members WHERE baby_id = $1", [
          baby,
        ]);
        expect(m.rows).toEqual([{ user_id: U.stranger, role: "admin" }]);
        expect(await count(c, "babies")).toBe(1);
        // A free baby: AI-gated tables stay closed.
        expect(await count(c, "photo_search")).toBe(0);
      });
    });

    it("stranger cannot create a baby on someone else's behalf", async () => {
      await db.asUser(U.stranger, async (c) => {
        await expectRlsViolation(
          c,
          "INSERT INTO babies (name, birth_date, created_by) VALUES ('X', '2026-01-01', $1)",
          [U.adminA1],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO babies (name, birth_date) VALUES ('X', '2026-01-01')",
        );
      });
    });

    it("stranger cannot self-join: no invite, wrong role, wrong email, revoked, expired, accepted", async () => {
      await db.asUser(
        U.stranger,
        async (c) => {
          const join = (role: string) =>
            tryQuery(c, "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, $3)", [
              BABY.A,
              U.stranger,
              role,
            ]);
          expect((await join("contributor"))?.message, "no invite, contributor").toMatch(
            RLS_VIOLATION,
          );
          // Baby B has a single admin, so the two-admin trigger is not what stops this one.
          const asAdminOfB = await tryQuery(
            c,
            "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
            [BABY.B, U.stranger],
          );
          expect(asAdminOfB?.message, "no invite, admin of B").toMatch(RLS_VIOLATION);
          // service_role (API code path) creates invites; test each way an invite can be unusable.
          const mk = async (
            extra: string,
            role = "contributor",
            email: string = EMAIL.stranger,
          ) => {
            await c.query("RESET ROLE");
            await c.query("SET LOCAL ROLE service_role");
            // At most one live invite per (baby, email): clear the previous attempt first.
            await c.query(
              "DELETE FROM invites WHERE baby_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL",
              [BABY.A, email],
            );
            await c.query(
              `INSERT INTO invites (baby_id, email, role, token_hash, invited_by ${extra ? `, ${extra.split("=")[0]}` : ""})
               VALUES ($1, $2, $3, gen_random_bytes(32), $4 ${extra ? `, ${extra.split("=")[1]}` : ""})`,
              [BABY.A, email, role, U.adminA1],
            );
            await c.query("RESET ROLE");
            await c.query("SET LOCAL ROLE authenticated");
          };
          // Wrong email.
          await mk("", "contributor", "someone-else@tinyglow.test");
          expect((await join("contributor"))?.message).toMatch(RLS_VIOLATION);
          // Revoked / expired / accepted.
          await mk("revoked_at=now()");
          expect((await join("contributor"))?.message).toMatch(RLS_VIOLATION);
          await mk("accepted_at=now()");
          expect((await join("contributor"))?.message).toMatch(RLS_VIOLATION);
          await mk("expires_at=now() - interval '1 minute'");
          expect((await join("contributor"))?.message).toMatch(RLS_VIOLATION);
          // A live invite for contributor does not allow joining as admin.
          await mk("");
          // (Baby A already has two admins, so the trigger or the policy rejects it: either way no.)
          expect((await join("admin"))?.message).toMatch(/row-level security|two admins/);
          // ...but joining as the invited role works.
          expect(await join("contributor")).toBeNull();
        },
        EMAIL.stranger,
      );
    });

    it("baby B's creator-visibility window closes once members exist (baby_has_members)", async () => {
      // The stranger cannot see a baby that has members just because created_by matches.
      await db.asRole("service_role", null, async (c) => {
        await c.query("UPDATE babies SET created_by = $1 WHERE id = $2", [U.stranger, BABY.B]);
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.stranger, role: "authenticated" }),
        ]);
        expect(await count(c, "babies", `id = '${BABY.B}'`)).toBe(0);
      });
    });

    it("adminA1 cannot touch baby B (write attempts are 0 rows / RLS violations)", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(await count(c, "photos", `baby_id = '${BABY.B}'`)).toBe(0);
        expect(
          await rowCount(c, "UPDATE photos SET deleted_at = now() WHERE id = $1", [P.b1]),
        ).toBe(0);
        await expectRlsViolation(
          c,
          "INSERT INTO share_links (baby_id, name, token_hash, created_by) VALUES ($1, 'x', decode(repeat('ef', 32), 'hex'), $2)",
          [BABY.B, U.adminA1],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ($1, $2, 'user', $3)",
          [LINK.LB, P.b1, U.adminA1],
        );
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("adminA1 (admin)", () => {
    it("sees every A photo including trashed and pending, and nothing of B", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(await ids(c, "SELECT id FROM photos")).toEqual([...A_PHOTOS].sort());
        expect(await count(c, "photos", "deleted_at IS NOT NULL")).toBe(3);
        expect(await count(c, "photos", "approval = 'pending'")).toBe(2);
        expect(await count(c, "baby_members")).toBe(3);
        expect(await count(c, "invites")).toBe(1);
        expect(await count(c, "share_links")).toBe(3);
        expect(await count(c, "photo_search")).toBe(1);
        expect(await count(c, "measurements")).toBe(1);
      });
    });

    it("sees photo_exif without GPS columns: gps_* are permission denied, place_label works", async () => {
      await db.asUser(U.adminA1, async (c) => {
        const r = await c.query(
          "SELECT place_label, camera_make FROM photo_exif WHERE photo_id = $1",
          [P.approved1],
        );
        expect(r.rows).toEqual([{ place_label: "Home", camera_make: "Acme" }]);
        await expectDenied(c, "SELECT gps_lat_enc FROM photo_exif");
        await expectDenied(c, "SELECT gps_lng_enc FROM photo_exif");
        await expectDenied(c, "SELECT * FROM photo_exif");
        await expectDenied(c, "SELECT decrypt_coord(gps_lat_enc) FROM photo_exif");
      });
    });

    it("decrypt_coord / pgp_sym_decrypt are not callable by users", async () => {
      await db.asUser(U.adminA1, async (c) => {
        await expectDenied(c, "SELECT public.decrypt_coord('\\x00'::bytea)");
        await expectDenied(c, "SELECT public.pgp_sym_decrypt('\\x00'::bytea, 'k')");
      });
    });

    it("sees share_links without token_hash / passcode_hash", async () => {
      await db.asUser(U.adminA1, async (c) => {
        const r = await c.query(
          "SELECT id, name, expires_at, revoked_at FROM share_links ORDER BY name",
        );
        expect(r.rows.map((x) => x.name)).toEqual(["LA", "LA-expired", "LA-revoked"]);
        await expectDenied(c, "SELECT token_hash FROM share_links");
        await expectDenied(c, "SELECT passcode_hash FROM share_links");
        await expectDenied(c, "SELECT * FROM share_links");
        await expectDenied(c, "SELECT token_hash FROM invites");
        await expectDenied(c, "SELECT * FROM invites");
      });
    });

    it("can soft-delete any A photo (1 row) but not hard-delete (permission denied)", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(
          await rowCount(c, "UPDATE photos SET deleted_at = now() WHERE id = $1", [P.approved2]),
        ).toBe(1);
        expect(
          await rowCount(c, "UPDATE photos SET deleted_at = now() WHERE id = $1", [P.pendingOther]),
        ).toBe(1);
        await expectDenied(c, "DELETE FROM photos");
        await expectDenied(c, "DELETE FROM photos WHERE id = $1", [P.approved2]);
        await expectDenied(c, "TRUNCATE photos");
      });
    });

    it("can approve a contributor's pending photo", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(
          await rowCount(
            c,
            "UPDATE photos SET approval = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
            [P.pendingContrib, U.adminA1],
          ),
        ).toBe(1);
      });
    });

    it("cannot change billing columns or pipeline-owned photo columns (permission denied)", async () => {
      await db.asUser(U.adminA1, async (c) => {
        await expectDenied(c, "UPDATE babies SET plan = 'plus' WHERE id = $1", [BABY.A]);
        await expectDenied(c, "UPDATE babies SET entitlement_expires_at = now() WHERE id = $1", [
          BABY.A,
        ]);
        await expectDenied(c, "UPDATE babies SET plan_owner_user_id = $2 WHERE id = $1", [
          BABY.A,
          U.adminA1,
        ]);
        await expectDenied(c, "UPDATE photos SET status = 'queued' WHERE id = $1", [P.approved1]);
        await expectDenied(c, "UPDATE photos SET storage_key_original = 'x' WHERE id = $1", [
          P.approved1,
        ]);
        await expectDenied(c, "UPDATE photos SET baby_id = $2 WHERE id = $1", [
          P.approved1,
          BABY.B,
        ]);
        await expectDenied(c, "UPDATE share_links SET view_count = 99 WHERE id = $1", [LINK.LA]);
        // Normal edits work.
        expect(
          await rowCount(c, "UPDATE babies SET nickname = 'Mimi' WHERE id = $1", [BABY.A]),
        ).toBe(1);
      });
    });

    it("cannot add a third admin (trigger), even by promoting a contributor", async () => {
      await db.asUser(U.adminA1, async (c) => {
        await expectCheckViolation(
          c,
          "UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
          /two admins/,
          [BABY.A, U.contribA],
        );
        await expectCheckViolation(
          c,
          "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
          /two admins/,
          [BABY.A, U.stranger],
        );
      });
    });

    it("cannot remove the last admin (self-removal after the co-admin left, or demotion)", async () => {
      // FR-1.5 (migration 18): an admin cannot delete the other admin's row; the co-admin leaves
      // by deleting their own. Then the remaining admin is the last one.
      await db.asUser(U.adminA2, async (c) => {
        expect(
          await rowCount(c, "DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
            BABY.A,
            U.adminA2,
          ]),
        ).toBe(1);
        // Same transaction, now acting as the remaining admin.
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(authed(U.adminA1)),
        ]);
        await expectCheckViolation(
          c,
          "DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2",
          /at least one admin/,
          [BABY.A, U.adminA1],
        );
        await expectCheckViolation(
          c,
          "UPDATE baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
          /at least one admin/,
          [BABY.A, U.adminA1],
        );
      });
    });

    it("can create share links and share rows for A (with hashes insertable, not readable)", async () => {
      await db.asUser(U.adminA1, async (c) => {
        await c.query(
          "INSERT INTO share_links (baby_id, name, token_hash, passcode_hash, created_by) VALUES ($1, 'new', decode(repeat('11', 32), 'hex'), 'scrypt$x', $2)",
          [BABY.A, U.adminA1],
        );
        await c.query(
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ($1, $2, 'user', $3)",
          [LINK.LA, P.contribApproved, U.adminA1],
        );
        // added_by must be 'user' with their own id for a user-role insert (a BEFORE trigger runs
        // ahead of the WITH CHECK, so use a photo the gate trigger accepts to reach the policy;
        // since step 8 that means an analysed photo, which only service_role can create here).
        await c.query("SET LOCAL ROLE service_role");
        await c.query(
          `INSERT INTO photo_ai (photo_id, model, prompt_version, schema_version, description)
           VALUES ($1, 'gpt-6-luna', 'v1', 'v1', '{"caption":"x"}'::jsonb)`,
          [P.approved2],
        );
        await c.query("SET LOCAL ROLE authenticated");
        await expectRlsViolation(
          c,
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'rule')",
          [LINK.LA, P.approved2],
        );
        // A user cannot smuggle a sensitive photo in as a "rule" share either.
        await expectCheckViolation(
          c,
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'rule')",
          /never auto-shared/,
          [LINK.LA, P.sensitive],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ($1, $2, 'user', $3)",
          [LINK.LA, P.contribApproved, U.adminA2],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO share_links (baby_id, name, token_hash, created_by) VALUES ($1, 'spoof', decode(repeat('22', 32), 'hex'), $2)",
          [BABY.A, U.adminA2],
        );
      });
    });

    it("chat is per-user: adminA1 sees own thread, not adminA2's; messages likewise", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(await ids(c, "SELECT id FROM chat_threads")).toEqual([THREAD_A]);
        expect(await count(c, "chat_messages")).toBe(1);
      });
      await db.asUser(U.adminA2, async (c) => {
        expect(await count(c, "chat_threads")).toBe(0);
        expect(await count(c, "chat_messages")).toBe(0);
        // Another admin cannot write into someone else's thread.
        await expectRlsViolation(
          c,
          "INSERT INTO chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'user', 'hi')",
          [THREAD_A, BABY.A, U.adminA1],
        );
      });
    });

    it("cannot read or alter the audit log of a baby it is not admin of; audit_log is append-only", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(await count(c, "audit_log", `baby_id = '${BABY.B}'`)).toBe(0);
        expect(await count(c, "audit_log", `baby_id = '${BABY.A}'`)).toBe(1);
        await expectDenied(c, "UPDATE audit_log SET event = 'tampered'");
        await expectDenied(c, "DELETE FROM audit_log");
        await expectDenied(c, "TRUNCATE audit_log");
      });
    });

    it("audit_log inserts must name the caller and a baby they belong to", async () => {
      await db.asUser(U.adminA1, async (c) => {
        await c.query(
          "INSERT INTO audit_log (baby_id, actor_user_id, event) VALUES ($1, $2, 'x.ok')",
          [BABY.A, U.adminA1],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO audit_log (baby_id, actor_user_id, event) VALUES ($1, $2, 'x')",
          [BABY.A, U.adminA2],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO audit_log (baby_id, actor_user_id, event) VALUES ($1, $2, 'x')",
          [BABY.B, U.adminA1],
        );
        await expectRlsViolation(c, "INSERT INTO audit_log (baby_id, event) VALUES ($1, 'x')", [
          BABY.A,
        ]);
      });
    });

    it("measurements: admin can insert as self, not as someone else", async () => {
      await db.asUser(U.adminA1, async (c) => {
        await c.query(
          "INSERT INTO measurements (baby_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by) VALUES ($1, 'height', 600, 60, 'cm', now(), $2)",
          [BABY.A, U.adminA1],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO measurements (baby_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by) VALUES ($1, 'height', 600, 60, 'cm', now(), $2)",
          [BABY.A, U.adminA2],
        );
        expect(await rowCount(c, "DELETE FROM measurements WHERE id = $1", [MEASUREMENT_A])).toBe(
          1,
        );
      });
    });

    it("photo_search and chat require the paid tier: a free baby's admin gets nothing", async () => {
      await db.asRole("service_role", null, async (c) => {
        await c.query("UPDATE babies SET plan = 'free' WHERE id = $1", [BABY.A]);
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.adminA1, role: "authenticated" }),
        ]);
        expect(await count(c, "photo_search")).toBe(0);
        // Existing threads stay readable (SELECT is admin + own); new chat needs the paid tier.
        expect(await count(c, "chat_threads")).toBe(1);
        await expectRlsViolation(c, "INSERT INTO chat_threads (baby_id, user_id) VALUES ($1, $2)", [
          BABY.A,
          U.adminA1,
        ]);
      });
      // An expired entitlement is free tier too.
      await db.asRole("service_role", null, async (c) => {
        await c.query(
          "UPDATE babies SET entitlement_expires_at = now() - interval '1 day' WHERE id = $1",
          [BABY.A],
        );
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.adminA1, role: "authenticated" }),
        ]);
        expect(await count(c, "photo_search")).toBe(0);
      });
    });

    it("a soft-deleted baby is visible to its admin only", async () => {
      await db.asRole("service_role", null, async (c) => {
        await c.query("UPDATE babies SET deleted_at = now() WHERE id = $1", [BABY.A]);
        for (const [uid, expected] of [
          [U.adminA1, 1],
          [U.contribA, 0],
        ] as const) {
          await c.query("RESET ROLE");
          await c.query("SET LOCAL ROLE authenticated");
          await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
            JSON.stringify({ sub: uid, role: "authenticated" }),
          ]);
          expect(await count(c, "babies", `id = '${BABY.A}'`)).toBe(expected);
          await c.query("RESET ROLE");
          await c.query("SET LOCAL ROLE service_role");
        }
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("contributor cannot delete (contribA)", () => {
    it("sees own uploads plus approved, live photos; not others' pending or trashed", async () => {
      await db.asUser(U.contribA, async (c) => {
        expect(await ids(c, "SELECT id FROM photos")).toEqual(
          [P.approved1, P.approved2, P.sensitive, P.contribApproved, P.pendingContrib].sort(),
        );
        expect(await count(c, "photos", `id = '${P.pendingOther}'`)).toBe(0);
        expect(await count(c, "photos", "deleted_at IS NOT NULL")).toBe(0);
        expect(await count(c, "babies", `id = '${BABY.A}'`)).toBe(1);
        expect(await count(c, "babies", `id = '${BABY.B}'`)).toBe(0);
        expect(await count(c, "baby_members")).toBe(3);
        expect(await count(c, "measurements")).toBe(1);
      });
    });

    it("sees 0 rows of invites, share_links, shared_photos, share_rules, chat_*, photo_search, viewer_sessions, audit_log", async () => {
      await db.asUser(U.contribA, async (c) => {
        for (const t of [
          "invites",
          "share_links",
          "share_rules",
          "shared_photos",
          "viewer_sessions",
          "chat_threads",
          "chat_messages",
          "photo_search",
          "audit_log",
        ]) {
          expect(await count(c, t), t).toBe(0);
        }
      });
    });

    it("contributor cannot delete: DELETE FROM photos is permission denied", async () => {
      await db.asUser(U.contribA, async (c) => {
        await expectDenied(c, "DELETE FROM photos");
        await expectDenied(c, "DELETE FROM photos WHERE id = $1", [P.pendingContrib]);
        await expectDenied(c, "DELETE FROM photo_derivatives");
        await expectDenied(c, "DELETE FROM babies");
        await expectDenied(c, "DELETE FROM profiles");
        await expectDenied(c, "DELETE FROM photo_exif");
        await expectDenied(c, "DELETE FROM audit_log");
      });
    });

    it("contributor cannot delete via RLS-filtered tables either (0 rows)", async () => {
      await db.asUser(U.contribA, async (c) => {
        expect(await rowCount(c, "DELETE FROM shared_photos")).toBe(0);
        expect(await rowCount(c, "DELETE FROM invites")).toBe(0);
        expect(await rowCount(c, "DELETE FROM share_links")).toBe(0);
        expect(await rowCount(c, "DELETE FROM measurements")).toBe(0);
        expect(await rowCount(c, "DELETE FROM photo_details")).toBe(0);
        expect(await rowCount(c, "DELETE FROM photo_ai_overrides")).toBe(0);
        expect(await rowCount(c, "DELETE FROM milestones")).toBe(0);
        expect(await rowCount(c, "DELETE FROM chat_threads")).toBe(0);
        expect(
          await rowCount(c, "DELETE FROM baby_members WHERE user_id <> $1", [U.contribA]),
        ).toBe(0);
      });
    });

    it("can upload only as pending, as themselves, into their own baby", async () => {
      await db.asUser(U.contribA, async (c) => {
        await expectRlsViolation(
          c,
          "INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, $3, 'fx/a1', 'approved')",
          [NEW_PHOTO, BABY.A, U.contribA],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, $3, 'fx/a2', 'rejected')",
          [NEW_PHOTO, BABY.A, U.contribA],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, $3, 'fx/a3', 'pending')",
          [NEW_PHOTO, BABY.A, U.adminA1],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, $3, 'fx/a4', 'pending')",
          [NEW_PHOTO, BABY.B, U.contribA],
        );
        await insertPhoto(c, { id: NEW_PHOTO, baby: BABY.A, by: U.contribA, approval: "pending" });
        // Default approval is 'approved' in the schema; the policy must still stop it.
        await expectRlsViolation(
          c,
          "INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original) VALUES ($1, $2, $3, 'fx/a5')",
          ["f3000000-0000-4000-8000-0000000000ab", BABY.A, U.contribA],
        );
      });
    });

    it("an unapproved upload is invisible to other contributors/viewers, visible to admins and the uploader", async () => {
      // pendingContrib: visible to contribA and admins (checked above); not to a viewer.
      await db.asUser(U.adminA1, async (c) => {
        expect(await count(c, "photos", `id = '${P.pendingContrib}'`)).toBe(1);
      });
      await db.asViewer(LINK.LA, async (c) => {
        expect(await count(c, "photos", `id = '${P.pendingContrib}'`)).toBe(0);
      });
    });

    it("cannot self-approve; may soft-delete own pending; cannot touch approved photos", async () => {
      await db.asUser(U.contribA, async (c) => {
        // Migration 18 (D13): the approval columns are guarded by a trigger, which answers a
        // contributor with 42501 and its fixed message before the WITH CHECK is evaluated.
        await expectContributorGuard(
          c,
          "UPDATE photos SET approval = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
          [P.pendingContrib, U.contribA],
        );
        await expectDenied(
          c,
          "UPDATE photos SET approval = 'approved', status = 'queued' WHERE id = $1",
          [P.pendingContrib],
        );
        expect(
          await rowCount(c, "UPDATE photos SET deleted_at = now() WHERE id = $1", [
            P.pendingContrib,
          ]),
        ).toBe(1);
        // Anyone's approved photo, including their own once approved: 0 rows.
        expect(
          await rowCount(c, "UPDATE photos SET deleted_at = now() WHERE id = $1", [P.approved1]),
        ).toBe(0);
        expect(
          await rowCount(c, "UPDATE photos SET deleted_at = now() WHERE id = $1", [
            P.contribApproved,
          ]),
        ).toBe(0);
        expect(
          await rowCount(c, "UPDATE photos SET is_sensitive = true WHERE id = $1", [P.approved2]),
        ).toBe(0);
        // Someone else's pending photo is invisible, so 0 rows.
        expect(
          await rowCount(c, "UPDATE photos SET deleted_at = now() WHERE id = $1", [P.pendingOther]),
        ).toBe(0);
      });
    });

    it("cannot write measurements, share links, chat, invites, or members; cannot edit the baby", async () => {
      await db.asUser(U.contribA, async (c) => {
        await expectRlsViolation(
          c,
          "INSERT INTO measurements (baby_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by) VALUES ($1, 'weight', 1, 1, 'g', now(), $2)",
          [BABY.A, U.contribA],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO share_links (baby_id, name, token_hash, created_by) VALUES ($1, 'x', decode(repeat('33', 32), 'hex'), $2)",
          [BABY.A, U.contribA],
        );
        await expectRlsViolation(c, "INSERT INTO chat_threads (baby_id, user_id) VALUES ($1, $2)", [
          BABY.A,
          U.contribA,
        ]);
        await expectRlsViolation(
          c,
          "INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'z@y.co', 'contributor', decode(repeat('44', 32), 'hex'), $2)",
          [BABY.A, U.contribA],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'contributor')",
          [BABY.A, U.stranger],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-m', 'custom', $2)",
          [BABY.A, U.contribA],
        );
        expect(await rowCount(c, "UPDATE babies SET name = 'x' WHERE id = $1", [BABY.A])).toBe(0);
        expect(
          await rowCount(c, "UPDATE baby_members SET role = 'admin' WHERE user_id = $1", [
            U.contribA,
          ]),
        ).toBe(0);
        // Also not photo_details on approved photos / overrides.
        expect(
          await rowCount(c, "UPDATE photo_details SET note = 'x' WHERE photo_id = $1", [
            P.approved1,
          ]),
        ).toBe(0);
        await expectRlsViolation(
          c,
          "INSERT INTO photo_details (photo_id, edited_by) VALUES ($1, $2)",
          [P.approved2, U.contribA],
        );
      });
    });

    it("may leave the baby (own membership) but not remove others", async () => {
      await db.asUser(U.contribA, async (c) => {
        expect(await rowCount(c, "DELETE FROM baby_members WHERE user_id = $1", [U.contribA])).toBe(
          1,
        );
      });
    });

    it("may write details/overrides only on their own pending upload", async () => {
      await db.asUser(U.contribA, async (c) => {
        await c.query(
          "INSERT INTO photo_details (photo_id, note, edited_by) VALUES ($1, 'mine', $2)",
          [P.pendingContrib, U.contribA],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO photo_details (photo_id, note, edited_by) VALUES ($1, 'x', $2)",
          [P.contribApproved, U.contribA],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO photo_details (photo_id, note, edited_by) VALUES ($1, 'x', $2)",
          [P.pendingOther, U.contribA],
        );
      });
    });

    it("cannot see GPS columns, tokens or passcodes either", async () => {
      await db.asUser(U.contribA, async (c) => {
        await expectDenied(c, "SELECT gps_lat_enc FROM photo_exif");
        await expectDenied(c, "SELECT token_hash FROM share_links");
        await expectDenied(c, "SELECT passcode_hash FROM share_links");
        await expectDenied(c, "SELECT token_hash FROM invites");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("viewer sees only shared_photos (share-link viewer, no account)", () => {
    it("viewer sees only shared_photos: exactly the active link's two rows", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const r = await c.query(
          "SELECT share_link_id, photo_id FROM shared_photos ORDER BY photo_id",
        );
        expect(r.rows).toEqual([
          { share_link_id: LINK.LA, photo_id: P.approved1 },
          { share_link_id: LINK.LA, photo_id: P.approved2 },
        ]);
        expect(await ids(c, "SELECT id FROM photos")).toEqual([P.approved1, P.approved2].sort());
      });
    });

    it("photos: allow-listed columns only; originals, hashes, bytes and SELECT * are denied", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const r = await c.query(
          "SELECT id, baby_id, taken_at, taken_at_estimated, age_days, width, height, mime, created_at FROM photos",
        );
        expect(r.rowCount).toBe(2);
        await expectDenied(c, "SELECT * FROM photos");
        // is_sensitive is granted so the share grid can blur manually shared sensitive photos.
        expect((await c.query("SELECT is_sensitive FROM photos")).rowCount).toBe(2);
        for (const col of [
          "storage_key_original",
          "sha256",
          "phash",
          "bytes",
          "uploaded_by",
          "approval",
          "status",
          "deleted_at",
        ]) {
          await expectDenied(c, `SELECT ${col} FROM photos`);
        }
      });
    });

    it("derivatives: thumb/display of shared photos only, never analysis or unshared photos", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const r = await c.query(
          "SELECT photo_id, kind FROM photo_derivatives ORDER BY photo_id, kind",
        );
        expect(r.rows).toEqual([
          { photo_id: P.approved1, kind: "display" },
          { photo_id: P.approved1, kind: "thumb" },
          { photo_id: P.approved2, kind: "thumb" },
        ]);
      });
    });

    it("babies: only the link's baby, only id/name/nickname/birth_date", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const r = await c.query("SELECT id, name, nickname, birth_date FROM babies");
        expect(r.rows.map((x) => x.id)).toEqual([BABY.A]);
        await expectDenied(c, "SELECT * FROM babies");
        for (const col of [
          "plan",
          "home_lat_enc",
          "home_lng_enc",
          "home_label",
          "created_by",
          "deleted_at",
          "plan_owner_user_id",
          "entitlement_expires_at",
        ]) {
          await expectDenied(c, `SELECT ${col} FROM babies`);
        }
      });
    });

    it("photo_details: milestone only, never the parent's note or people", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const r = await c.query("SELECT photo_id, milestone_id FROM photo_details");
        expect(r.rows).toHaveLength(1);
        await expectDenied(c, "SELECT note FROM photo_details");
        await expectDenied(c, "SELECT people FROM photo_details");
        await expectDenied(c, "SELECT * FROM photo_details");
      });
    });

    it("share_links: own active link only, without hashes", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const r = await c.query(
          "SELECT id, baby_id, name, expires_at, revoked_at, allow_download FROM share_links",
        );
        expect(r.rows.map((x) => x.id)).toEqual([LINK.LA]);
        await expectDenied(c, "SELECT token_hash FROM share_links");
        await expectDenied(c, "SELECT passcode_hash FROM share_links");
        await expectDenied(c, "SELECT created_by FROM share_links");
      });
    });

    it("milestones: global presets only (no custom milestones of other babies)", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const r = await c.query("SELECT id, baby_id, name, category FROM milestones");
        expect(r.rowCount).toBeGreaterThanOrEqual(12);
        expect(r.rows.every((x) => x.baby_id === null)).toBe(true);
      });
    });

    it("every other table is permission denied for the viewer role", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        for (const t of [
          "photo_exif",
          "photo_ai",
          "photo_ai_overrides",
          "photo_search",
          "invites",
          "baby_members",
          "measurements",
          "chat_threads",
          "chat_messages",
          "audit_log",
          "viewer_sessions",
          "profiles",
          "ai_batches",
          "share_rules",
          "worker_heartbeats",
        ]) {
          await expectDenied(c, `SELECT count(*) FROM public.${t}`);
        }
      });
    });

    it("viewer has no write grants anywhere", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        await expectDenied(
          c,
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'user')",
          [LINK.LA, P.contribApproved],
        );
        await expectDenied(c, "UPDATE shared_photos SET added_by = 'rule'");
        await expectDenied(c, "DELETE FROM shared_photos");
        await expectDenied(c, "UPDATE photos SET deleted_at = now()");
        await expectDenied(c, "DELETE FROM photos");
        await expectDenied(
          c,
          "UPDATE share_links SET revoked_at = NULL, expires_at = now() + interval '100 years'",
        );
        await expectDenied(c, "INSERT INTO audit_log (event) VALUES ('x')");
        await expectDenied(
          c,
          "INSERT INTO viewer_sessions (share_link_id, expires_at) VALUES ($1, now())",
          [LINK.LA],
        );
        await expectDenied(c, "INSERT INTO chat_threads (baby_id, user_id) VALUES ($1, $2)", [
          BABY.A,
          U.adminA1,
        ]);
      });
    });

    it("the viewer role's grants in the catalog are exactly the allow-list, SELECT only", async () => {
      const t = await db.admin.query(
        `SELECT DISTINCT table_name, privilege_type FROM (
           SELECT table_name, privilege_type FROM information_schema.table_privileges
            WHERE grantee = 'viewer' AND table_schema = 'public'
           UNION
           SELECT table_name, privilege_type FROM information_schema.column_privileges
            WHERE grantee = 'viewer' AND table_schema = 'public') x
         ORDER BY 1, 2`,
      );
      expect(t.rows).toEqual(
        [
          "babies",
          "milestones",
          "photo_derivatives",
          "photo_details",
          "photos",
          "share_links",
          "shared_photos",
        ].map((table_name) => ({ table_name, privilege_type: "SELECT" })),
      );
    });

    it("expired link: the viewer sees nothing", async () => {
      await expectViewerSeesNothing(LINK.LAexpired);
    });

    it("revoked link: the viewer sees nothing", async () => {
      await expectViewerSeesNothing(LINK.LArevoked);
    });

    it("a link that expires mid-session stops working immediately", async () => {
      await db.asRole("service_role", null, async (c) => {
        await c.query(
          "UPDATE share_links SET expires_at = now() - interval '1 second' WHERE id = $1",
          [LINK.LA],
        );
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE viewer");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ role: "viewer", share_link_id: LINK.LA }),
        ]);
        expect(await count(c, "shared_photos")).toBe(0);
        expect(await count(c, "photos")).toBe(0);
        expect(await count(c, "babies")).toBe(0);
      });
    });

    it("revoking the link stops access immediately", async () => {
      await db.asRole("service_role", null, async (c) => {
        await c.query("UPDATE share_links SET revoked_at = now() WHERE id = $1", [LINK.LA]);
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE viewer");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ role: "viewer", share_link_id: LINK.LA }),
        ]);
        expect(await count(c, "shared_photos")).toBe(0);
        expect(await count(c, "photo_derivatives")).toBe(0);
      });
    });

    it("another baby's link (LB) cannot see baby A; sees only its own", async () => {
      await db.asViewer(LINK.LB, async (c) => {
        expect(await count(c, "shared_photos", `share_link_id IN (${A_LINK_LIST})`)).toBe(0);
        expect(await count(c, "photos", `baby_id = '${BABY.A}'`)).toBe(0);
        expect(await count(c, "babies", `id = '${BABY.A}'`)).toBe(0);
        expect(await ids(c, "SELECT id FROM photos")).toEqual([P.b1]);
        expect(await ids(c, "SELECT id FROM share_links")).toEqual([LINK.LB]);
      });
    });

    it("unshared, pending, sensitive-unshared and trashed photos never reach the viewer", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        for (const p of [
          P.pendingContrib,
          P.pendingOther,
          P.sensitive,
          P.trashed,
          P.contribApproved,
          P.b1,
        ]) {
          expect(await count(c, "photos", `id = '${p}'`), p).toBe(0);
        }
      });
    });

    it("a shared photo that is later trashed or un-approved disappears for the viewer", async () => {
      await db.asRole("service_role", null, async (c) => {
        await c.query("UPDATE photos SET deleted_at = now() WHERE id = $1", [P.approved1]);
        await c.query("UPDATE photos SET approval = 'rejected' WHERE id = $1", [P.approved2]);
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE viewer");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ role: "viewer", share_link_id: LINK.LA }),
        ]);
        expect(await count(c, "photos")).toBe(0);
        expect(await count(c, "photo_derivatives")).toBe(0);
        expect(await count(c, "photo_details")).toBe(0);
      });
    });

    it("a soft-deleted baby takes its share links offline", async () => {
      await db.asRole("service_role", null, async (c) => {
        await c.query("UPDATE babies SET deleted_at = now() WHERE id = $1", [BABY.A]);
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE viewer");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ role: "viewer", share_link_id: LINK.LA }),
        ]);
        expect(await count(c, "shared_photos")).toBe(0);
        expect(await count(c, "babies")).toBe(0);
        expect(await count(c, "share_links")).toBe(0);
      });
    });

    it("viewer with no claims, empty claims, a bogus link id, or user-shaped claims sees nothing", async () => {
      const attempts: (Record<string, unknown> | null | string)[] = [
        null,
        {},
        "",
        { role: "viewer" },
        { role: "viewer", share_link_id: "f4000000-0000-4000-8000-0000000000ff" },
        // authenticated claims on a viewer role: share_link_id is only honoured when role = viewer
        { role: "authenticated", sub: U.adminA1, share_link_id: LINK.LA },
        { role: "service_role", share_link_id: LINK.LA },
      ];
      for (const claims of attempts) {
        await db.asRole("viewer", null, async (c) => {
          if (claims !== null) {
            await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
              typeof claims === "string" ? claims : JSON.stringify(claims),
            ]);
          }
          expect(await count(c, "shared_photos"), JSON.stringify(claims)).toBe(0);
          expect(await count(c, "photos")).toBe(0);
          expect(await count(c, "babies")).toBe(0);
          expect(await count(c, "share_links")).toBe(0);
          expect(await count(c, "photo_derivatives")).toBe(0);
        });
      }
    });

    it("a viewer token carrying a sub does not become a member (auth_uid is NULL for viewers)", async () => {
      await db.asRole(
        "viewer",
        { role: "viewer", share_link_id: LINK.LA, sub: U.adminA1 },
        async (c) => {
          const r = await c.query(
            "SELECT public.auth_uid() AS uid, public.auth_share_link_id() AS link",
          );
          expect(r.rows[0]).toEqual({ uid: null, link: LINK.LA });
          await expectDenied(c, "SELECT count(*) FROM baby_members");
          await expectDenied(c, "SELECT count(*) FROM chat_messages");
          expect(await count(c, "photos")).toBe(2);
        },
      );
    });

    async function expectViewerSeesNothing(link: string) {
      await db.asViewer(link, async (c) => {
        expect(await count(c, "shared_photos"), "shared_photos").toBe(0);
        expect(await count(c, "photos"), "photos").toBe(0);
        expect(await count(c, "babies"), "babies").toBe(0);
        expect(await count(c, "photo_derivatives"), "photo_derivatives").toBe(0);
        expect(await count(c, "photo_details"), "photo_details").toBe(0);
        expect(await count(c, "share_links"), "share_links").toBe(0);
      });
    }
  });

  // ---------------------------------------------------------------------------------------------
  describe("pipeline (tinyglow_worker -> SET ROLE pipeline)", () => {
    it("reads the photo pipeline tables across babies", async () => {
      await db.asPipeline(async (c) => {
        expect(await count(c, "photos", `baby_id IN ('${BABY.A}','${BABY.B}')`)).toBe(
          A_PHOTOS.length + 1,
        );
        expect(await count(c, "photo_exif", `photo_id IN ('${P.approved1}','${P.b1}')`)).toBe(2);
        expect(await count(c, "photo_ai")).toBeGreaterThanOrEqual(1);
        expect(await count(c, "photo_search", `baby_id IN ('${BABY.A}','${BABY.B}')`)).toBe(2);
        expect(await count(c, "ai_batches", `id = '${AI_BATCH}'`)).toBe(1);
        expect(await count(c, "photo_derivatives", `photo_id = '${P.approved1}'`)).toBe(3);
        expect(await count(c, "babies", `id IN ('${BABY.A}','${BABY.B}')`)).toBe(2);
      });
    });

    it("reads encrypted GPS, and only decrypts it with the transaction key", async () => {
      await db.asPipeline(async (c) => {
        const raw = await c.query(
          "SELECT gps_lat_enc, gps_lat_enc::text AS t FROM photo_exif WHERE photo_id = $1",
          [P.approved1],
        );
        expect(Buffer.isBuffer(raw.rows[0]?.gps_lat_enc)).toBe(true);
        expect(raw.rows[0]?.t).not.toContain("47.6062");
        await expect(
          c
            .query("SAVEPOINT s")
            .then(() =>
              c.query("SELECT decrypt_coord(gps_lat_enc) FROM photo_exif WHERE photo_id = $1", [
                P.approved1,
              ]),
            ),
        ).rejects.toThrow(/data key not set/);
        await c.query("ROLLBACK TO SAVEPOINT s");
        await c.query("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
        const r = await c.query(
          "SELECT decrypt_coord(gps_lat_enc) AS lat, decrypt_coord(gps_lng_enc) AS lng FROM photo_exif WHERE photo_id = $1",
          [P.approved1],
        );
        expect(r.rows[0]).toEqual({ lat: 47.6062, lng: -122.3321 });
        // A wrong key must not decrypt.
        await c.query(
          "SELECT set_config('app.data_key', 'wrong-key-wrong-key-wrong-key-wrong', true)",
        );
        const bad = await tryQuery(
          c,
          "SELECT decrypt_coord(gps_lat_enc) FROM photo_exif WHERE photo_id = $1",
          [P.approved1],
        );
        expect(bad).not.toBeNull();
      });
    });

    it("sees share_links without hashes; invites, chat, members, sessions, audit are denied", async () => {
      await db.asPipeline(async (c) => {
        const r = await c.query("SELECT id, baby_id, expires_at, revoked_at FROM share_links");
        expect(r.rowCount).toBeGreaterThanOrEqual(4);
        await expectDenied(c, "SELECT token_hash FROM share_links");
        await expectDenied(c, "SELECT passcode_hash FROM share_links");
        await expectDenied(c, "SELECT * FROM share_links");
        for (const t of [
          "invites",
          "chat_threads",
          "chat_messages",
          "viewer_sessions",
          "audit_log",
          "worker_heartbeats",
        ]) {
          await expectDenied(c, `SELECT count(*) FROM public.${t}`);
        }
        // Migration 19 (export members list): baby_members is readable by pipeline for four
        // columns only; who invited whom and removal requests stay out of reach.
        expect(
          (await c.query("SELECT baby_id, user_id, role, joined_at FROM baby_members")).rowCount,
        ).toBeGreaterThan(0);
        await expectDenied(c, "SELECT invited_by FROM baby_members");
        await expectDenied(c, "SELECT removal_requested_by FROM baby_members");
        await expectDenied(c, "SELECT removal_requested_at FROM baby_members");
        await expectDenied(c, "SELECT * FROM baby_members");
        await expectDenied(c, "UPDATE baby_members SET role = 'admin'");
        await expectDenied(c, "DELETE FROM baby_members");
        const p = await c.query(
          "SELECT user_id, display_name, relationship_label FROM profiles LIMIT 1",
        );
        expect(p.rowCount).toBe(1);
        await expectDenied(c, "SELECT timezone FROM profiles");
        // Plan 2.6: pipeline may read photo_details (notes feed the search document).
        expect(await count(c, "photo_details", `photo_id = '${P.approved1}'`)).toBe(1);
      });
    });

    it("can update status and pipeline metadata, but not approval, storage key, ownership or deleted_at", async () => {
      await db.asPipeline(async (c) => {
        expect(
          await rowCount(c, "UPDATE photos SET status = 'ingested', width = 200 WHERE id = $1", [
            P.approved1,
          ]),
        ).toBe(1);
        await expectDenied(c, "UPDATE photos SET approval = 'approved' WHERE id = $1", [
          P.pendingContrib,
        ]);
        await expectDenied(c, "UPDATE photos SET storage_key_original = 'x' WHERE id = $1", [
          P.approved1,
        ]);
        await expectDenied(c, "UPDATE photos SET baby_id = $2 WHERE id = $1", [
          P.approved1,
          BABY.B,
        ]);
        await expectDenied(c, "UPDATE photos SET uploaded_by = NULL WHERE id = $1", [P.approved1]);
        await expectDenied(c, "UPDATE photos SET deleted_at = NULL WHERE id = $1", [P.trashed]);
        await expectDenied(c, "UPDATE babies SET plan = 'plus' WHERE id = $1", [BABY.A]);
        await expectDenied(c, "UPDATE share_links SET revoked_at = NULL");
        await expectDenied(
          c,
          "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'x')",
          [BABY.A],
        );
      });
    });

    it("hard-deletes only photos trashed more than 30 days ago", async () => {
      await db.asPipeline(async (c) => {
        expect(await rowCount(c, "DELETE FROM photos WHERE id = $1", [P.trashedOld])).toBe(1);
        expect(await rowCount(c, "DELETE FROM photos WHERE id = $1", [P.trashedRecent])).toBe(0);
        expect(await rowCount(c, "DELETE FROM photos WHERE id = $1", [P.trashed])).toBe(0);
        expect(await rowCount(c, "DELETE FROM photos WHERE id = $1", [P.approved1])).toBe(0);
        expect(await rowCount(c, "DELETE FROM photos WHERE id = $1", [P.pendingContrib])).toBe(0);
      });
    });

    it("hard-deletes only babies soft-deleted more than 30 days ago", async () => {
      await db.asPipeline(async (c) => {
        expect(await rowCount(c, "DELETE FROM babies WHERE id = $1", [BABY.oldTrash])).toBe(1);
        expect(await rowCount(c, "DELETE FROM babies WHERE id = $1", [BABY.recentTrash])).toBe(0);
        expect(await rowCount(c, "DELETE FROM babies WHERE id = $1", [BABY.A])).toBe(0);
      });
    });

    it("rule-sharing: non-sensitive approved photo ok; sensitive/pending/trashed/cross-baby fail; user-type is an RLS violation", async () => {
      await db.asPipeline(async (c) => {
        const ins = (link: string, photo: string, by = "rule") =>
          `INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ('${link}', '${photo}', '${by}')`;
        // Step 8: a rule row needs an analysed photo (the pipeline may write photo_ai).
        await expectCheckViolation(c, ins(LINK.LA, P.contribApproved), /only analysed photos/);
        await c.query(
          `INSERT INTO photo_ai (photo_id, model, prompt_version, schema_version, description)
           VALUES ($1, 'gpt-6-luna', 'v1', 'v1', '{"caption":"x"}'::jsonb)`,
          [P.contribApproved],
        );
        expect(await tryQuery(c, ins(LINK.LA, P.contribApproved))).toBeNull();
        await expectCheckViolation(c, ins(LINK.LA, P.sensitive), /never auto-shared/);
        await expectCheckViolation(c, ins(LINK.LA, P.pendingOther), /approved, non-deleted/);
        await expectCheckViolation(c, ins(LINK.LA, P.trashed), /approved, non-deleted/);
        await expectCheckViolation(c, ins(LINK.LA, P.b1), /does not belong/);
        await expectRlsViolation(c, ins(LINK.LA, P.contribApproved, "user"));
        // added_by_user_id is not even grantable to the pipeline.
        await expectDenied(
          c,
          `INSERT INTO shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ('${LINK.LA}', '${P.approved2}', 'rule', '${U.adminA1}')`,
        );
        // Cannot modify shares; may remove only its own `rule` rows (step 8 rule sync), never a
        // hand-picked `user` row.
        await expectDenied(c, "UPDATE shared_photos SET added_by = 'user'");
        expect(await rowCount(c, "DELETE FROM shared_photos WHERE added_by = 'user'")).toBe(0);
        expect(
          await rowCount(c, "DELETE FROM shared_photos WHERE added_by = 'rule'"),
        ).toBeGreaterThan(0);
      });
    });

    it("writes audit_log only without an actor", async () => {
      await db.asPipeline(async (c) => {
        await c.query("INSERT INTO audit_log (baby_id, event) VALUES ($1, 'pipeline.test')", [
          BABY.A,
        ]);
        await expectDenied(
          c,
          "INSERT INTO audit_log (baby_id, actor_user_id, event) VALUES ($1, $2, 'x')",
          [BABY.A, U.adminA1],
        );
        await expectDenied(c, "UPDATE audit_log SET event = 'x'");
        await expectDenied(c, "DELETE FROM audit_log");
      });
    });

    it("cannot assume any other role (service_role, authenticated, viewer, postgres)", async () => {
      const c = await db.workerPool.connect();
      try {
        for (const role of [
          "service_role",
          "authenticated",
          "viewer",
          "supabase_auth_admin",
          "postgres",
        ]) {
          await c.query("BEGIN");
          const err = await tryQuery(c, `SET LOCAL ROLE ${role}`);
          expect(err, `tinyglow_worker SET ROLE ${role}`).not.toBeNull();
          expect(err?.code).toBe("42501");
          await c.query("ROLLBACK");
        }
      } finally {
        c.release();
      }
    });

    it("inside pipeline, SET ROLE service_role stays impossible", async () => {
      await db.asPipeline(async (c) => {
        const err = await tryQuery(c, "SET LOCAL ROLE service_role");
        expect(err?.code).toBe("42501");
        const err2 = await tryQuery(c, "SET LOCAL ROLE authenticated");
        expect(err2?.code).toBe("42501");
      });
    });

    it("worker connection has no direct privileges on app tables (without SET ROLE)", async () => {
      const c = await db.workerPool.connect();
      try {
        await expect(c.query("SELECT 1 AS one")).resolves.toBeTruthy();
        for (const t of ALL_APP_TABLES.filter((x) => x !== "worker_heartbeats")) {
          await expectDeniedSimple(c, `SELECT count(*) FROM public.${t}`);
        }
        // Its own heartbeat table works directly.
        await expect(
          c.query("SELECT count(*) FROM public.worker_heartbeats"),
        ).resolves.toBeTruthy();
      } finally {
        c.release();
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("tinyglow_api without SET ROLE; anon; service_role", () => {
    it("SELECT 1 works, every app table is permission denied, SET ROLE pipeline fails", async () => {
      const c = await db.apiPool.connect();
      try {
        await expect(c.query("SELECT 1 AS one")).resolves.toBeTruthy();
        for (const t of ALL_APP_TABLES) {
          await expectDeniedSimple(c, `SELECT count(*) FROM public.${t}`);
        }
        await expectDeniedSimple(c, "SELECT * FROM photos");
        await expectDeniedSimple(c, "SELECT count(*) FROM public.pgmigrations");
        await expectDeniedSimple(c, "SELECT count(*) FROM auth.users");
        await expectDeniedSimple(c, "INSERT INTO public.audit_log (event) VALUES ('x')");
        for (const role of [
          "pipeline",
          "postgres",
          "supabase_auth_admin",
          "anon",
          "tinyglow_worker",
        ]) {
          await c.query("BEGIN");
          const err = await tryQuery(c, `SET LOCAL ROLE ${role}`);
          expect(err, `tinyglow_api SET ROLE ${role}`).not.toBeNull();
          expect(err?.code).toBe("42501");
          await c.query("ROLLBACK");
        }
        // The roles it may assume.
        for (const role of ["authenticated", "viewer", "service_role"]) {
          await c.query("BEGIN");
          expect(await tryQuery(c, `SET LOCAL ROLE ${role}`)).toBeNull();
          await c.query("ROLLBACK");
        }
      } finally {
        c.release();
      }
    });

    it("no claims at all as authenticated: sees nothing (auth_uid() is NULL)", async () => {
      await db.asRole("authenticated", null, async (c) => {
        for (const t of [
          "babies",
          "baby_members",
          "photos",
          "profiles",
          "share_links",
          "audit_log",
        ]) {
          expect(await count(c, t), t).toBe(0);
        }
        // Global milestone presets are readable by any signed-in role, but not with no identity? They are.
        await expectRlsViolation(
          c,
          "INSERT INTO babies (name, birth_date) VALUES ('x', '2026-01-01')",
        );
      });
    });

    it("claims with role=viewer under SET ROLE authenticated give no identity", async () => {
      await db.asRole(
        "authenticated",
        { role: "viewer", share_link_id: LINK.LA, sub: U.adminA1 },
        async (c) => {
          expect(await count(c, "babies")).toBe(0);
          expect(await count(c, "photos")).toBe(0);
          expect(await count(c, "shared_photos")).toBe(0);
        },
      );
    });

    it("anon has no privileges on any app table", async () => {
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("SET LOCAL ROLE anon");
        for (const t of ALL_APP_TABLES) {
          await expectDenied(db.admin, `SELECT count(*) FROM public.${t}`);
        }
        await expectDenied(db.admin, "INSERT INTO public.audit_log (event) VALUES ('x')");
      } finally {
        await db.admin.query("ROLLBACK");
      }
    });

    it("service_role bypasses RLS (all rows, hashes readable) but audit_log stays append-only", async () => {
      await db.asRole("service_role", null, async (c) => {
        expect(await count(c, "photos", `baby_id IN ('${BABY.A}','${BABY.B}')`)).toBe(
          A_PHOTOS.length + 1,
        );
        const r = await c.query("SELECT token_hash FROM share_links WHERE id = $1", [LINK.LA]);
        expect(r.rows[0]?.token_hash).toHaveLength(32);
        await c.query("INSERT INTO audit_log (baby_id, event) VALUES ($1, 'service.test')", [
          BABY.A,
        ]);
        await expectDenied(c, "UPDATE audit_log SET event = 'tampered'");
        await expectDenied(c, "DELETE FROM audit_log");
        await expectDenied(c, "TRUNCATE audit_log");
      });
    });

    it("service_role is NOT granted to the worker (cannot be reached from tinyglow_worker)", async () => {
      const r = await db.admin.query(
        `SELECT pg_has_role('tinyglow_worker', 'service_role', 'USAGE') AS usage,
                pg_has_role('tinyglow_worker', 'service_role', 'MEMBER') AS member,
                pg_has_role('tinyglow_api', 'pipeline', 'MEMBER') AS api_pipeline`,
      );
      expect(r.rows[0]).toEqual({ usage: false, member: false, api_pipeline: false });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("profiles", () => {
    it("a user sees themselves and co-members, not strangers; can edit only own row", async () => {
      await db.asUser(U.contribA, async (c) => {
        // Migration 18 (D12): profiles is self-only; co-members come through member_profiles.
        const seen = await ids(c, "SELECT user_id AS id FROM profiles");
        expect(seen).toEqual([U.contribA]);
        const members = await ids(c, "SELECT user_id AS id FROM member_profiles");
        expect(members).toEqual([U.adminA1, U.adminA2, U.contribA].sort());
        expect(
          await rowCount(c, "UPDATE profiles SET display_name = 'me' WHERE user_id = $1", [
            U.contribA,
          ]),
        ).toBe(1);
        expect(
          await rowCount(c, "UPDATE profiles SET display_name = 'x' WHERE user_id = $1", [
            U.adminA1,
          ]),
        ).toBe(0);
        await expectDenied(c, "UPDATE profiles SET user_id = $2 WHERE user_id = $1", [
          U.contribA,
          U.stranger,
        ]);
        await expectDenied(c, "DELETE FROM profiles WHERE user_id = $1", [U.contribA]);
        await expectRlsViolation(c, "INSERT INTO profiles (user_id) VALUES ($1)", [U.stranger]);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("milestones", () => {
    it("admin creates custom milestones for own baby only; presets are immutable to users", async () => {
      await db.asUser(U.adminA1, async (c) => {
        await c.query(
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-first-swim', 'custom', $2)",
          [BABY.A, U.adminA1],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES ($1, 'fx-x', 'custom', $2)",
          [BABY.B, U.adminA1],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO milestones (baby_id, name, category, created_by) VALUES (NULL, 'fx-global', 'custom', $1)",
          [U.adminA1],
        );
        expect(
          await rowCount(c, "UPDATE milestones SET name = 'fx-hack' WHERE baby_id IS NULL"),
        ).toBe(0);
        expect(await rowCount(c, "DELETE FROM milestones WHERE baby_id IS NULL")).toBe(0);
      });
    });

    it("presets are visible to every signed-in user; another baby's custom milestones are not", async () => {
      await db.asRole("service_role", null, async (c) => {
        await c.query(
          "INSERT INTO milestones (baby_id, name, category) VALUES ($1, 'fx-b-custom', 'custom')",
          [BABY.B],
        );
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: U.adminA1, role: "authenticated" }),
        ]);
        expect(await count(c, "milestones", "baby_id IS NULL")).toBeGreaterThanOrEqual(12);
        expect(await count(c, "milestones", "name = 'fx-b-custom'")).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("invites", () => {
    it("admin reads invites without token_hash; invitee sees only invites addressed to them", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect(await ids(c, "SELECT id FROM invites")).toEqual([INVITE_A]);
        await expectRlsViolation(
          c,
          "INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'q@y.co', 'contributor', decode(repeat('55', 32), 'hex'), $2)",
          [BABY.B, U.adminA1],
        );
        await expectRlsViolation(
          c,
          "INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'q@y.co', 'contributor', decode(repeat('56', 32), 'hex'), $2)",
          [BABY.A, U.adminA2],
        );
        expect(
          await rowCount(c, "UPDATE invites SET revoked_at = now() WHERE id = $1", [INVITE_A]),
        ).toBe(1);
        expect(
          await rowCount(c, "UPDATE invites SET revoked_at = now() WHERE id = $1", [INVITE_B]),
        ).toBe(0);
      });
      await db.asUser(
        U.stranger,
        async (c) => {
          expect(await count(c, "invites")).toBe(0);
        },
        EMAIL.stranger,
      );
      await db.asUser(
        U.stranger,
        async (c) => {
          expect(await ids(c, "SELECT id FROM invites")).toEqual([INVITE_A]);
          // Invites UPDATE is admin-only: the invitee cannot mark it accepted themselves.
          expect(
            await rowCount(c, "UPDATE invites SET accepted_at = now() WHERE id = $1", [INVITE_A]),
          ).toBe(0);
          expect(await rowCount(c, "DELETE FROM invites WHERE id = $1", [INVITE_A])).toBe(0);
        },
        "FX-INVITEE-A@tinyglow.test",
      );
    });
  });
});

async function expectDeniedSimple(c: pg.ClientBase, sql: string) {
  await c.query("BEGIN");
  const err = await tryQuery(c, sql);
  await c.query("ROLLBACK");
  expect(err, sql).not.toBeNull();
  expect(err?.code, sql).toBe("42501");
  expect(err?.message, sql).toMatch(PERMISSION_DENIED);
}
