import { afterAll, beforeAll, describe, expect, it } from "vitest";
// packages/db has no dependency on @tinyglow/shared: relative import on purpose.
import {
  FREE_TIER_PHOTO_LIMIT,
  INVITES_PER_BABY_PER_DAY,
  MAX_ADMINS_PER_BABY,
} from "../shared/src/constants";
import {
  A_PHOTOS,
  BABY,
  createFixtures,
  dropFixtures,
  LINK,
  P,
  THREAD_A,
  U,
} from "./test/fixtures";
import { connect, DATA_KEY, type Db, databaseUrl, ensureMigrated, tryQuery } from "./test/harness";

// SQL-enforced product rules (docs/plans/step-2.md 2.4 triggers, D5). Run as the superuser inside
// transactions that are rolled back: the SECURITY DEFINER triggers fire for every role, so the
// rules hold no matter who writes. (Role-specific behaviour lives in rls.integration.test.ts.)

describe.skipIf(!databaseUrl)("triggers and constraints", () => {
  let db: Db;
  const a = () => db.admin;

  /** Run `fn` in a transaction on the superuser connection and always roll back. */
  async function sandbox<T>(fn: () => Promise<T>): Promise<T> {
    await a().query("BEGIN");
    try {
      return await fn();
    } finally {
      await a().query("ROLLBACK");
    }
  }
  const q = (sql: string, params: unknown[] = []) => a().query(sql, params);
  const err = (sql: string, params: unknown[] = []) => tryQuery(a(), sql, params);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q(sql, params)).rows[0] as T;

  const newBaby = async (id: string, plan: "free" | "plus") =>
    q("INSERT INTO babies (id, name, birth_date, plan) VALUES ($1, 'T', '2026-01-01', $2)", [
      id,
      plan,
    ]);
  const FREE = "f2000000-0000-4000-8000-0000000000f1";
  const PLUS = "f2000000-0000-4000-8000-0000000000f2";
  let nextKey = 0;
  const addPhoto = (baby: string) =>
    q("INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, $2) RETURNING id", [
      baby,
      `trg/${++nextKey}/${Math.random()}`,
    ]);

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

  it("constants in @tinyglow/shared match the trigger thresholds", () => {
    expect(MAX_ADMINS_PER_BABY).toBe(2);
    expect(INVITES_PER_BABY_PER_DAY).toBe(20);
    expect(FREE_TIER_PHOTO_LIMIT).toBe(1000);
  });

  // ---------------------------------------------------------------------------------------------
  describe("baby_members: max two admins and last admin", () => {
    it("rejects a third admin on insert and on promotion", async () => {
      await sandbox(async () => {
        expect(
          (
            await err(
              "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
              [BABY.A, U.stranger],
            )
          )?.message,
        ).toMatch(/two admins/);
        expect(
          (
            await err(
              "UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
              [BABY.A, U.contribA],
            )
          )?.message,
        ).toMatch(/two admins/);
        expect(
          (
            await err(
              "UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
              [BABY.A, U.contribA],
            )
          )?.code,
        ).toBe("23514");
      });
    });

    it("allows adding a contributor, and a third admin after one admin was demoted", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'contributor')",
          [BABY.A, U.stranger],
        );
        await q(
          "UPDATE baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
          [BABY.A, U.adminA2],
        );
        await q("UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2", [
          BABY.A,
          U.stranger,
        ]);
        expect(
          (
            await one<{ n: number }>(
              "SELECT count(*)::int n FROM baby_members WHERE baby_id = $1 AND role = 'admin'",
              [BABY.A],
            )
          ).n,
        ).toBe(2);
      });
    });

    it("an upsert / no-op role update on an existing admin is not counted against itself", async () => {
      await sandbox(async () => {
        expect(
          await err("UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2", [
            BABY.A,
            U.adminA1,
          ]),
        ).toBeNull();
        expect(
          await err(
            "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT (baby_id, user_id) DO UPDATE SET role = EXCLUDED.role",
            [BABY.A, U.adminA1],
          ),
        ).toBeNull();
      });
    });

    it("two admins is allowed per baby independently (baby B has its own count)", async () => {
      await sandbox(async () => {
        expect(
          await err("INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')", [
            BABY.B,
            U.stranger,
          ]),
        ).toBeNull();
      });
    });

    it("the last admin cannot be deleted or demoted while the baby is live", async () => {
      await sandbox(async () => {
        await q("DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
          BABY.A,
          U.adminA2,
        ]);
        expect(
          (
            await err("DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
              BABY.A,
              U.adminA1,
            ])
          )?.message,
        ).toMatch(/at least one admin/);
        expect(
          (
            await err(
              "UPDATE baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
              [BABY.A, U.adminA1],
            )
          )?.message,
        ).toMatch(/at least one admin/);
      });
      await sandbox(async () => {
        expect(
          (
            await err("DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
              BABY.B,
              U.adminB,
            ])
          )?.code,
        ).toBe("23514");
      });
    });

    it("account deletion (profile cascade) cannot orphan a live baby's last admin", async () => {
      await sandbox(async () => {
        expect((await err("DELETE FROM profiles WHERE user_id = $1", [U.adminB]))?.message).toMatch(
          /at least one admin/,
        );
      });
    });

    it("a soft-deleted baby may lose its last admin, and deleting the baby cascades its members", async () => {
      await sandbox(async () => {
        await q("UPDATE babies SET deleted_at = now() WHERE id = $1", [BABY.B]);
        expect(
          await err("DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
            BABY.B,
            U.adminB,
          ]),
        ).toBeNull();
      });
      await sandbox(async () => {
        expect(await err("DELETE FROM babies WHERE id = $1", [BABY.B])).toBeNull();
        expect(
          (
            await one<{ n: number }>(
              "SELECT count(*)::int n FROM baby_members WHERE baby_id = $1",
              [BABY.B],
            )
          ).n,
        ).toBe(0);
      });
    });

    it("concurrent promotions cannot produce three admins (row lock on the baby)", async () => {
      const baby = "f2000000-0000-4000-8000-0000000000c1";
      const users = [1, 2, 3, 4].map((n) => `f1000000-0000-4000-8000-0000000000c${n}`);
      const cleanup = async () => {
        await a().query("DELETE FROM babies WHERE id = $1", [baby]);
        await a().query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [users]);
      };
      await cleanup();
      try {
        for (const [i, u] of users.entries()) {
          await a().query(
            "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
            [u, `fx-conc-${i}@tinyglow.test`],
          );
          await a().query("INSERT INTO profiles (user_id) VALUES ($1)", [u]);
        }
        await a().query(
          "INSERT INTO babies (id, name, birth_date) VALUES ($1, 'C', '2026-01-01')",
          [baby],
        );
        await a().query(
          "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'contributor'), ($1, $4, 'contributor'), ($1, $5, 'contributor')",
          [baby, ...users],
        );
        const pg = (await import("pg")).default;
        const c1 = new pg.Client({ connectionString: databaseUrl });
        const c2 = new pg.Client({ connectionString: databaseUrl });
        await Promise.all([c1.connect(), c2.connect()]);
        try {
          await Promise.all([c1.query("BEGIN"), c2.query("BEGIN")]);
          const results = await Promise.allSettled([
            c1
              .query("UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2", [
                baby,
                users[1],
              ])
              .then(() => c1.query("COMMIT")),
            c2
              .query("UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2", [
                baby,
                users[2],
              ])
              .then(() => c2.query("COMMIT")),
          ]);
          await c1.query("ROLLBACK").catch(() => undefined);
          await c2.query("ROLLBACK").catch(() => undefined);
          // Two admins max in total: baby had 1, so exactly one concurrent promotion may win.
          // (If both pass with 2 + ... the second would see 2 existing admins and fail.)
          const admins = (
            await one<{ n: number }>(
              "SELECT count(*)::int n FROM baby_members WHERE baby_id = $1 AND role = 'admin'",
              [baby],
            )
          ).n;
          expect(admins).toBeLessThanOrEqual(MAX_ADMINS_PER_BABY);
          expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
          // Now a third, sequentially, must fail.
          const third = await tryQuery(
            a(),
            "UPDATE baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
            [baby, users[3]],
          );
          expect(third?.message).toMatch(/two admins/);
        } finally {
          await c1.end();
          await c2.end();
        }
      } finally {
        await cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("invites_rate_limit", () => {
    const invite = (i: number, ago = "0 seconds") =>
      q(
        `INSERT INTO invites (baby_id, email, role, token_hash, invited_by, created_at)
         VALUES ($1, $2, 'contributor', gen_random_bytes(32), $3, now() - interval '${ago}')`,
        [BABY.A, `fx-rl-${i}@tinyglow.test`, U.adminA1],
      );

    it("allows 20 invites per baby per 24h and rejects the 21st (fixture already holds one)", async () => {
      await sandbox(async () => {
        // The fixture baby A already has 1 invite created just now: 19 more fit.
        for (let i = 0; i < INVITES_PER_BABY_PER_DAY - 1; i++) await invite(i);
        const e = await err(
          `INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'fx-rl-over@tinyglow.test', 'contributor', gen_random_bytes(32), $2)`,
          [BABY.A, U.adminA1],
        );
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/rate limit/);
      });
    });

    it("is per baby: baby B is unaffected", async () => {
      await sandbox(async () => {
        for (let i = 0; i < INVITES_PER_BABY_PER_DAY - 1; i++) await invite(i);
        expect(
          await err(
            `INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'fx-rl-b@tinyglow.test', 'contributor', gen_random_bytes(32), $2)`,
            [BABY.B, U.adminB],
          ),
        ).toBeNull();
      });
    });

    it("invites older than 24 hours do not count", async () => {
      await sandbox(async () => {
        for (let i = 0; i < 30; i++) await invite(i, "25 hours");
        expect(
          await err(
            `INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'fx-rl-ok@tinyglow.test', 'contributor', gen_random_bytes(32), $2)`,
            [BABY.A, U.adminA1],
          ),
        ).toBeNull();
      });
    });

    it("also applies through the authenticated role (no way around it)", async () => {
      await sandbox(async () => {
        for (let i = 0; i < INVITES_PER_BABY_PER_DAY - 1; i++) await invite(i);
      });
      // (rollback above: exercise the same limit as an admin in one transaction)
      await db.asUser(U.adminA1, async (c) => {
        for (let i = 0; i < INVITES_PER_BABY_PER_DAY - 1; i++) {
          await c.query(
            "INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, $2, 'contributor', decode(md5($3) || md5($3 || 'x'), 'hex'), $4)",
            [BABY.A, `fx-rl-u${i}@tinyglow.test`, `t${i}`, U.adminA1],
          );
        }
        const e = await tryQuery(
          c,
          "INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, 'fx-rl-uover@tinyglow.test', 'contributor', decode(md5('o') || md5('ox'), 'hex'), $2)",
          [BABY.A, U.adminA1],
        );
        expect(e?.message).toMatch(/rate limit/);
      });
    });

    it("invite constraints: lowercase email, 32-byte hash, role, one live invite per email", async () => {
      await sandbox(async () => {
        const ins = (email: string, role: string, hashExpr: string) =>
          err(
            `INSERT INTO invites (baby_id, email, role, token_hash, invited_by) VALUES ($1, '${email}', '${role}', ${hashExpr}, $2)`,
            [BABY.B, U.adminB],
          );
        expect((await ins("Upper@Case.com", "contributor", "gen_random_bytes(32)"))?.code).toBe(
          "23514",
        );
        expect((await ins("ok1@x.co", "contributor", "gen_random_bytes(16)"))?.code).toBe("23514");
        expect((await ins("ok2@x.co", "viewer", "gen_random_bytes(32)"))?.code).toBe("23514");
        expect(await ins("ok3@x.co", "contributor", "gen_random_bytes(32)")).toBeNull();
        expect((await ins("ok3@x.co", "contributor", "gen_random_bytes(32)"))?.code).toBe("23505");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("free-tier photo cap", () => {
    it("a free baby holds 1000 photos; the 1001st fails; a plus baby is uncapped", async () => {
      await sandbox(async () => {
        await newBaby(FREE, "free");
        await newBaby(PLUS, "plus");
        await q(
          "INSERT INTO photos (baby_id, storage_key_original) SELECT $1, 'cap/free/' || g FROM generate_series(1, $2) g",
          [FREE, FREE_TIER_PHOTO_LIMIT],
        );
        const e = await err(
          "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'cap/free/over')",
          [FREE],
        );
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/free tier photo limit/);
        await q(
          "INSERT INTO photos (baby_id, storage_key_original) SELECT $1, 'cap/plus/' || g FROM generate_series(1, $2) g",
          [PLUS, FREE_TIER_PHOTO_LIMIT],
        );
        expect(
          await err(
            "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'cap/plus/over')",
            [PLUS],
          ),
        ).toBeNull();
      });
    });

    it("trashed photos do not count toward the cap; upgrading lifts it", async () => {
      await sandbox(async () => {
        await newBaby(FREE, "free");
        await q(
          "INSERT INTO photos (baby_id, storage_key_original) SELECT $1, 'cap/f/' || g FROM generate_series(1, $2) g",
          [FREE, FREE_TIER_PHOTO_LIMIT],
        );
        await q(
          "UPDATE photos SET deleted_at = now() WHERE baby_id = $1 AND storage_key_original = 'cap/f/1'",
          [FREE],
        );
        expect(
          await err(
            "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'cap/f/again')",
            [FREE],
          ),
        ).toBeNull();
        expect(
          (
            await err(
              "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'cap/f/over2')",
              [FREE],
            )
          )?.code,
        ).toBe("23514");
        await q("UPDATE babies SET plan = 'plus' WHERE id = $1", [FREE]);
        expect(
          await err(
            "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'cap/f/over3')",
            [FREE],
          ),
        ).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("AI gates: free-tier photos never reach the AI queue or store AI results", () => {
    it("a free baby's photo cannot move to queued or analyzing; non-AI statuses are fine", async () => {
      await sandbox(async () => {
        await newBaby(FREE, "free");
        const { id } = (await addPhoto(FREE)).rows[0] as { id: string };
        for (const status of ["queued", "analyzing"]) {
          const e = await err("UPDATE photos SET status = $2 WHERE id = $1", [id, status]);
          expect(e?.code, status).toBe("23514");
          expect(e?.message).toMatch(/AI queue/);
        }
        expect(await err("UPDATE photos SET status = 'ingested' WHERE id = $1", [id])).toBeNull();
        expect(await err("UPDATE photos SET status = 'ready' WHERE id = $1", [id])).toBeNull();
        expect(
          (await one<{ status: string }>("SELECT status FROM photos WHERE id = $1", [id])).status,
        ).toBe("ready");
      });
    });

    it("also fails when entitlement expired (plus plan, lapsed)", async () => {
      await sandbox(async () => {
        await q(
          "UPDATE babies SET entitlement_expires_at = now() - interval '1 day' WHERE id = $1",
          [BABY.A],
        );
        const e = await err("UPDATE photos SET status = 'queued' WHERE id = $1", [P.approved2]);
        expect(e?.code).toBe("23514");
      });
    });

    it("a paid baby's approved photo can be queued and analyzed; pending, rejected and trashed cannot", async () => {
      await sandbox(async () => {
        expect(
          await err("UPDATE photos SET status = 'queued' WHERE id = $1", [P.approved2]),
        ).toBeNull();
        expect(
          await err("UPDATE photos SET status = 'analyzing' WHERE id = $1", [P.approved2]),
        ).toBeNull();
        expect(
          (await err("UPDATE photos SET status = 'queued' WHERE id = $1", [P.pendingContrib]))
            ?.code,
        ).toBe("23514");
        expect(
          (await err("UPDATE photos SET status = 'queued' WHERE id = $1", [P.trashed]))?.code,
        ).toBe("23514");
        await q("UPDATE photos SET approval = 'rejected' WHERE id = $1", [P.pendingOther]);
        expect(
          (await err("UPDATE photos SET status = 'queued' WHERE id = $1", [P.pendingOther]))?.code,
        ).toBe("23514");
      });
    });

    it("the pipeline role is bound by the same guard", async () => {
      await sandbox(async () => {
        await q("UPDATE babies SET plan = 'free' WHERE id = $1", [BABY.A]);
        await q("SET LOCAL ROLE pipeline");
        const e = await tryQuery(a(), "UPDATE photos SET status = 'queued' WHERE id = $1", [
          P.approved2,
        ]);
        await q("RESET ROLE");
        expect(e?.code).toBe("23514");
      });
      // Positive control: the same statement succeeds for the paid baby.
      await db.asPipeline(async (c) => {
        expect(
          await tryQuery(c, "UPDATE photos SET status = 'queued' WHERE id = $1", [P.approved2]),
        ).toBeNull();
      });
    });

    const aiRow = (photo: string, flags = "'{}'") =>
      q(
        `INSERT INTO photo_ai (photo_id, model, prompt_version, schema_version, description, sensitive_flags)
         VALUES ($1, 'm', 'v', 'v', '{"caption":"c"}'::jsonb, ${flags})
         ON CONFLICT (photo_id) DO UPDATE SET sensitive_flags = EXCLUDED.sensitive_flags`,
        [photo],
      );

    it("photo_ai insert/update is refused for free-tier or lapsed babies (defence in depth)", async () => {
      await sandbox(async () => {
        await newBaby(FREE, "free");
        const { id } = (await addPhoto(FREE)).rows[0] as { id: string };
        const e = await err(
          `INSERT INTO photo_ai (photo_id, model, prompt_version, schema_version, description) VALUES ($1, 'm', 'v', 'v', '{}'::jsonb)`,
          [id],
        );
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/paid-tier/);
      });
      await sandbox(async () => {
        // Downgrade after the row exists: updating is refused too.
        await q("UPDATE babies SET plan = 'free' WHERE id = $1", [BABY.A]);
        expect(
          (await err("UPDATE photo_ai SET model = 'other' WHERE photo_id = $1", [P.approved1]))
            ?.code,
        ).toBe("23514");
      });
      await sandbox(async () => {
        await q(
          "UPDATE babies SET entitlement_expires_at = now() - interval '1 second' WHERE id = $1",
          [BABY.A],
        );
        expect(
          (await err("UPDATE photo_ai SET model = 'other' WHERE photo_id = $1", [P.approved1]))
            ?.code,
        ).toBe("23514");
      });
    });

    it("photo_ai is accepted for a paid baby", async () => {
      await sandbox(async () => {
        expect(await aiRow(P.approved2)).toBeTruthy();
      });
    });

    // Migration 17: the only exempt UPDATE is "batch_id -> NULL, nothing else changed" (what the
    // ai_batches ON DELETE SET NULL FK action issues).
    describe("tripwire: detaching a row from a deleted batch", () => {
      const mkBatch = async () =>
        (await q("INSERT INTO ai_batches (provider, model) VALUES ('fake', 'm') RETURNING id"))
          .rows[0].id as string;
      const attach = async (photo: string, batch: string) => {
        await aiRow(photo);
        await q("UPDATE photo_ai SET batch_id = $2 WHERE photo_id = $1", [photo, batch]);
      };
      const batchOf = async (photo: string) =>
        (
          await one<{ batch_id: string | null }>(
            "SELECT batch_id FROM photo_ai WHERE photo_id = $1",
            [photo],
          )
        ).batch_id;

      it("deleting a batch works after the baby is trashed; batch_id becomes NULL", async () => {
        await sandbox(async () => {
          const batch = await mkBatch();
          await attach(P.approved2, batch);
          await q("UPDATE babies SET deleted_at = now() WHERE id = $1", [BABY.A]);
          expect(await err("DELETE FROM ai_batches WHERE id = $1", [batch])).toBeNull();
          expect(await batchOf(P.approved2)).toBeNull();
        });
      });

      it("a mixed batch (paid + trashed baby) can be deleted", async () => {
        await sandbox(async () => {
          await newBaby(PLUS, "plus");
          const other = (await addPhoto(PLUS)).rows[0].id as string;
          const batch = await mkBatch();
          await attach(P.approved2, batch);
          await attach(other, batch);
          await q("UPDATE babies SET deleted_at = now() WHERE id = $1", [BABY.A]);
          expect(await err("DELETE FROM ai_batches WHERE id = $1", [batch])).toBeNull();
          expect(await batchOf(P.approved2)).toBeNull();
          expect(await batchOf(other)).toBeNull();
        });
      });

      it("deleting a batch works after a downgrade to free", async () => {
        await sandbox(async () => {
          const batch = await mkBatch();
          await attach(P.approved2, batch);
          await q("UPDATE babies SET plan = 'free' WHERE id = $1", [BABY.A]);
          expect(await err("DELETE FROM ai_batches WHERE id = $1", [batch])).toBeNull();
          expect(await batchOf(P.approved2)).toBeNull();
        });
      });

      it("deleting a batch works after the entitlement expired", async () => {
        await sandbox(async () => {
          const batch = await mkBatch();
          await attach(P.approved2, batch);
          await q(
            "UPDATE babies SET entitlement_expires_at = now() - interval '1 day' WHERE id = $1",
            [BABY.A],
          );
          expect(await err("DELETE FROM ai_batches WHERE id = $1", [batch])).toBeNull();
          expect(await batchOf(P.approved2)).toBeNull();
        });
      });

      it("still refused: batch_id NULL plus any content change, re-pointing, or an upsert for a free baby", async () => {
        const changes = [
          'description = \'{"caption":"changed"}\'::jsonb',
          "sensitive_flags = ARRAY['bath']",
          "prompt_version = 'other'",
        ];
        for (const change of changes) {
          await sandbox(async () => {
            const batch = await mkBatch();
            await attach(P.approved2, batch);
            await q("UPDATE babies SET plan = 'free' WHERE id = $1", [BABY.A]);
            const e = await err(
              `UPDATE photo_ai SET batch_id = NULL, ${change} WHERE photo_id = $1`,
              [P.approved2],
            );
            expect(e?.code, change).toBe("23514");
            expect(e?.message, change).toMatch(/paid-tier/);
          });
        }
        await sandbox(async () => {
          const b1 = await mkBatch();
          const b2 = await mkBatch();
          await attach(P.approved2, b1);
          await q("UPDATE babies SET plan = 'free' WHERE id = $1", [BABY.A]);
          const e = await err("UPDATE photo_ai SET batch_id = $2 WHERE photo_id = $1", [
            P.approved2,
            b2,
          ]);
          expect(e?.code).toBe("23514");
          expect(e?.message).toMatch(/paid-tier/);
        });
        await sandbox(async () => {
          await newBaby(FREE, "free");
          const { id } = (await addPhoto(FREE)).rows[0] as { id: string };
          const e = await err(
            `INSERT INTO photo_ai (photo_id, model, prompt_version, schema_version, description)
             VALUES ($1, 'm', 'v', 'v', '{"caption":"c"}'::jsonb)
             ON CONFLICT (photo_id) DO UPDATE SET batch_id = NULL`,
            [id],
          );
          expect(e?.code).toBe("23514");
          expect(e?.message).toMatch(/paid-tier/);
        });
      });
    });

    it("sensitive flags raise photos.is_sensitive and never lower it", async () => {
      await sandbox(async () => {
        expect(
          (
            await one<{ s: boolean }>("SELECT is_sensitive s FROM photos WHERE id = $1", [
              P.approved2,
            ])
          ).s,
        ).toBe(false);
        await aiRow(P.approved2, "'{}'");
        expect(
          (
            await one<{ s: boolean }>("SELECT is_sensitive s FROM photos WHERE id = $1", [
              P.approved2,
            ])
          ).s,
        ).toBe(false);
        await aiRow(P.approved2, "'{bath}'");
        expect(
          (
            await one<{ s: boolean }>("SELECT is_sensitive s FROM photos WHERE id = $1", [
              P.approved2,
            ])
          ).s,
        ).toBe(true);
        // Clearing the flags does not clear the photo; an admin must do it explicitly.
        await aiRow(P.approved2, "'{}'");
        expect(
          (
            await one<{ s: boolean }>("SELECT is_sensitive s FROM photos WHERE id = $1", [
              P.approved2,
            ])
          ).s,
        ).toBe(true);
        await q("UPDATE photos SET is_sensitive = false WHERE id = $1", [P.approved2]);
        expect(
          (
            await one<{ s: boolean }>("SELECT is_sensitive s FROM photos WHERE id = $1", [
              P.approved2,
            ])
          ).s,
        ).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("shared_photos gate: sensitive photos are never rule-shared", () => {
    const share = (link: string, photo: string, by: string) =>
      `INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ('${link}', '${photo}', '${by}')`;

    it("rule + sensitive fails; user + sensitive (an explicit parent choice) is allowed", async () => {
      await sandbox(async () => {
        const e = await err(share(LINK.LA, P.sensitive, "rule"));
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/never auto-shared/);
        expect(await err(share(LINK.LA, P.sensitive, "user"))).toBeNull();
      });
    });

    it("a photo that becomes sensitive later cannot be switched to a rule share", async () => {
      await sandbox(async () => {
        await q(
          "UPDATE shared_photos SET added_by = 'user' WHERE share_link_id = $1 AND photo_id = $2",
          [LINK.LA, P.approved1],
        );
        await q("UPDATE photos SET is_sensitive = true WHERE id = $1", [P.approved1]);
        const e = await err(
          "UPDATE shared_photos SET added_by = 'rule' WHERE share_link_id = $1 AND photo_id = $2",
          [LINK.LA, P.approved1],
        );
        expect(e?.message).toMatch(/never auto-shared/);
      });
    });

    it("pending, rejected and trashed photos cannot be shared, by rule or by user", async () => {
      await sandbox(async () => {
        for (const by of ["rule", "user"]) {
          for (const p of [P.pendingContrib, P.pendingOther, P.trashed]) {
            const e = await err(share(LINK.LA, p, by));
            expect(e?.code, `${by} ${p}`).toBe("23514");
            expect(e?.message).toMatch(/approved, non-deleted/);
          }
        }
        await q("UPDATE photos SET approval = 'rejected' WHERE id = $1", [P.contribApproved]);
        expect((await err(share(LINK.LA, P.contribApproved, "user")))?.code).toBe("23514");
      });
    });

    it("a photo of another baby cannot be shared on this link", async () => {
      await sandbox(async () => {
        const e = await err(share(LINK.LA, P.b1, "user"));
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/does not belong/);
        expect((await err(share(LINK.LB, P.approved1, "rule")))?.message).toMatch(
          /does not belong/,
        );
      });
    });

    it("an approved, live, non-sensitive photo of the same baby is accepted either way", async () => {
      await sandbox(async () => {
        // A rule row needs an analysed photo (step 8); a user row does not.
        expect((await err(share(LINK.LA, P.contribApproved, "rule")))?.message).toMatch(
          /only analysed photos/,
        );
        await q(
          `INSERT INTO photo_ai (photo_id, model, prompt_version, schema_version, description)
           VALUES ($1, 'gpt-6-luna', 'v1', 'v1', '{"caption":"x"}'::jsonb)`,
          [P.contribApproved],
        );
        expect(await err(share(LINK.LA, P.contribApproved, "rule"))).toBeNull();
        expect(await err(share(LINK.LAexpired, P.contribApproved, "user"))).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("GPS never exists in plaintext", () => {
    it("photo_exif.raw_json rejects GPS-looking top-level keys, accepts ordinary EXIF", async () => {
      await sandbox(async () => {
        const put = (json: string) =>
          err(`UPDATE photo_exif SET raw_json = '${json}'::jsonb WHERE photo_id = $1`, [
            P.approved1,
          ]);
        for (const bad of [
          '{"GPSLatitude": 1}',
          '{"gpsLongitude": "x"}',
          '{"GPS": {}}',
          '{"latitude": 47.6}',
          '{"Longitude": -122.3}',
          '{"lat": 1}',
          '{"lng": 1}',
          '{"lon": 1}',
          '{"Make":"x","GPSAltitude":3}',
        ]) {
          const e = await put(bad);
          expect(e?.code, bad).toBe("23514");
        }
        for (const ok of ["{}", '{"Make":"Acme","Model":"X","ISO":100}', '{"Orientation":1}']) {
          expect(await put(ok), ok).toBeNull();
        }
      });
    });

    it("jsonb_has_gps_keys classifies keys", async () => {
      const r = await one<{ a: boolean; b: boolean; c: boolean; d: boolean }>(
        `SELECT jsonb_has_gps_keys('{"GPSLatitude":1}') a, jsonb_has_gps_keys('{"Make":1}') b,
                jsonb_has_gps_keys('{}') c, jsonb_has_gps_keys('[1]') d`,
      );
      expect(r).toEqual({ a: true, b: false, c: false, d: false });
    });

    it("the GPS columns are bytea ciphertext; there is no plaintext coordinate column", async () => {
      const cols = await q(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND (column_name ~* '(^|_)(lat|lng|lon|latitude|longitude|gps)(_|$)')
          ORDER BY 1, 2`,
      );
      for (const c of cols.rows) {
        expect(c.column_name, `${c.table_name}.${c.column_name}`).toMatch(/_enc$/);
        expect(c.data_type).toBe("bytea");
      }
      expect(cols.rows.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
        "babies.home_lat_enc",
        "babies.home_lng_enc",
        "photo_exif.gps_lat_enc",
        "photo_exif.gps_lng_enc",
      ]);
    });

    it("encrypt_coord / decrypt_coord round-trip; ciphertext is not the plaintext and is randomized", async () => {
      await sandbox(async () => {
        await q("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
        const r = await one<{ enc: Buffer; enc2: Buffer; dec: number; neg: number }>(
          `SELECT e AS enc, encrypt_coord(47.6062) AS enc2, decrypt_coord(e) AS dec,
                  decrypt_coord(encrypt_coord(-122.3321)) AS neg
           FROM (SELECT encrypt_coord(47.6062) AS e) s`,
        );
        expect(r.dec).toBe(47.6062);
        expect(r.neg).toBe(-122.3321);
        expect(r.enc.toString("latin1")).not.toContain("47.6062");
        expect(r.enc.equals(r.enc2)).toBe(false);
        // NULL in, NULL out (STRICT): a missing coordinate stays missing.
        expect((await one<{ v: null }>("SELECT encrypt_coord(NULL) AS v")).v).toBeNull();
      });
    });

    it("fails closed without a key, with an empty key, and with the wrong key", async () => {
      await sandbox(async () => {
        const noKey = await err("SELECT encrypt_coord(1.5)");
        expect(noKey?.message).toMatch(/data key not set/);
        expect((await err("SELECT decrypt_coord('\\x00'::bytea)"))?.message).toMatch(
          /data key not set/,
        );
        await q("SELECT set_config('app.data_key', '', true)");
        expect((await err("SELECT encrypt_coord(1.5)"))?.message).toMatch(/data key not set/);
      });
      await sandbox(async () => {
        await q("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
        const { e } = await one<{ e: Buffer }>("SELECT encrypt_coord(1.5) e");
        await q("SELECT set_config('app.data_key', $1, true)", [
          "a-completely-different-key-0123456789",
        ]);
        const bad = await err("SELECT decrypt_coord($1::bytea)", [e]);
        expect(bad).not.toBeNull();
        // The error must not echo the key.
        expect(bad?.message).not.toContain("a-completely-different-key");
        expect(bad?.message).not.toContain(DATA_KEY);
      });
    });

    it("the key is transaction-local: it is gone after COMMIT/ROLLBACK", async () => {
      await sandbox(async () => {
        await q("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
      });
      expect((await err("SELECT encrypt_coord(1.5)"))?.message).toMatch(/data key not set/);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("other guards", () => {
    it("set_updated_at advances updated_at on every table that has one, even if the caller sets it", async () => {
      await sandbox(async () => {
        const cases: [string, string, unknown[], string][] = [
          ["profiles", "display_name = 'x'", [U.adminA1], "user_id = $1"],
          ["babies", "nickname = 'x'", [BABY.A], "id = $1"],
          ["photos", "is_sensitive = true", [P.approved1], "id = $1"],
          ["photo_details", "note = 'x'", [P.approved1], "photo_id = $1"],
          ["share_links", "name = 'x'", [LINK.LA], "id = $1"],
          ["share_rules", "mode = 'all'", [LINK.LA], "share_link_id = $1"],
          ["chat_threads", "title = 'x'", [THREAD_A], "id = $1"],
          ["photo_ai", "model = 'x'", [P.approved1], "photo_id = $1"],
          ["photo_exif", "camera_make = 'x'", [P.approved1], "photo_id = $1"],
        ];
        for (const [table, set, params, where] of cases) {
          await q(`UPDATE ${table} SET updated_at = '2000-01-01' WHERE ${where}`, params);
          await q(`UPDATE ${table} SET ${set}, updated_at = '2000-01-01' WHERE ${where}`, params);
          const r = await one<{ fresh: boolean }>(
            `SELECT updated_at > now() - interval '1 minute' AS fresh FROM ${table} WHERE ${where}`,
            params,
          );
          expect(r.fresh, table).toBe(true);
        }
      });
    });

    it("worker_heartbeats has an updated_at column that defaults to now()", async () => {
      const r = await one<{ is_nullable: string; column_default: string }>(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'worker_heartbeats' AND column_name = 'updated_at'`,
      );
      expect(r.is_nullable).toBe("NO");
      expect(r.column_default).toMatch(/now\(\)/);
    });

    it("the avatar must be an approved, live photo of the same baby", async () => {
      await sandbox(async () => {
        const set = (photo: string) =>
          err("UPDATE babies SET avatar_photo_id = $2 WHERE id = $1", [BABY.A, photo]);
        for (const bad of [P.pendingContrib, P.trashed, P.b1]) {
          expect((await set(bad))?.code, bad).toBe("23514");
        }
        expect(await set(P.approved1)).toBeNull();
        // Hard-deleting the avatar photo clears the reference instead of failing.
        await q("DELETE FROM photos WHERE id = $1", [P.approved1]);
        expect(
          (
            await one<{ a: string | null }>("SELECT avatar_photo_id a FROM babies WHERE id = $1", [
              BABY.A,
            ])
          ).a,
        ).toBeNull();
      });
    });

    it("a chat message must match its thread's baby and user", async () => {
      await sandbox(async () => {
        const msg = (baby: string, user: string) =>
          err(
            "INSERT INTO chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'user', 'x')",
            [THREAD_A, baby, user],
          );
        expect((await msg(BABY.B, U.adminA1))?.code).toBe("23514");
        expect((await msg(BABY.A, U.adminA2))?.code).toBe("23514");
        expect(await msg(BABY.A, U.adminA1)).toBeNull();
      });
    });

    it("creating a baby with created_by adds that user as its admin; without it no member is added", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO babies (id, name, birth_date, created_by) VALUES ($1, 'N', '2026-01-01', $2)",
          [FREE, U.stranger],
        );
        const r = await q("SELECT user_id, role FROM baby_members WHERE baby_id = $1", [FREE]);
        expect(r.rows).toEqual([{ user_id: U.stranger, role: "admin" }]);
        await q("INSERT INTO babies (id, name, birth_date) VALUES ($1, 'N', '2026-01-01')", [PLUS]);
        expect(
          (
            await one<{ n: number }>(
              "SELECT count(*)::int n FROM baby_members WHERE baby_id = $1",
              [PLUS],
            )
          ).n,
        ).toBe(0);
      });
    });

    it("column constraints reject malformed data", async () => {
      await sandbox(async () => {
        const bad = async (sql: string, params: unknown[] = []) =>
          expect((await err(sql, params))?.code, sql).toBe("23514");
        await bad("INSERT INTO babies (name, birth_date) VALUES ('', '2026-01-01')");
        await bad(
          `INSERT INTO babies (name, birth_date) VALUES ('${"x".repeat(81)}', '2026-01-01')`,
        );
        await bad(
          "INSERT INTO babies (name, birth_date, plan) VALUES ('x', '2026-01-01', 'enterprise')",
        );
        await bad(
          "INSERT INTO photos (baby_id, storage_key_original, mime) VALUES ($1, 'k1', 'application/pdf')",
          [BABY.A],
        );
        await bad(
          "INSERT INTO photos (baby_id, storage_key_original, status) VALUES ($1, 'k2', 'weird')",
          [BABY.A],
        );
        await bad(
          "INSERT INTO photos (baby_id, storage_key_original, approval) VALUES ($1, 'k3', 'maybe')",
          [BABY.A],
        );
        await bad(
          "INSERT INTO photos (baby_id, storage_key_original, sha256) VALUES ($1, 'k4', '\\x01'::bytea)",
          [BABY.A],
        );
        await bad(
          "INSERT INTO measurements (baby_id, kind, value_metric, value_entered, unit_entered, measured_at) VALUES ($1, 'weight', 0, 0, 'g', now())",
          [BABY.A],
        );
        await bad(
          "INSERT INTO measurements (baby_id, kind, value_metric, value_entered, unit_entered, measured_at) VALUES ($1, 'bmi', 1, 1, 'g', now())",
          [BABY.A],
        );
        await bad(
          "INSERT INTO share_links (baby_id, name, token_hash) VALUES ($1, 'x', '\\x0102'::bytea)",
          [BABY.A],
        );
        await bad(
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'robot')",
          [LINK.LA, P.approved1],
        );
        await bad(
          "INSERT INTO chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'god', 'x')",
          [THREAD_A, BABY.A, U.adminA1],
        );
        await bad(
          "INSERT INTO photo_derivatives (photo_id, kind, storage_key, width, height, bytes) VALUES ($1, 'original', 'k', 1, 1, 1)",
          [P.approved2],
        );
      });
    });

    it("duplicate content in one baby is rejected; the same bytes in another baby are fine", async () => {
      await sandbox(async () => {
        const sha = "decode(md5('dup') || md5('dupx'), 'hex')";
        await q(
          `INSERT INTO photos (baby_id, storage_key_original, sha256) VALUES ($1, 'dup1', ${sha})`,
          [BABY.A],
        );
        expect(
          (
            await err(
              `INSERT INTO photos (baby_id, storage_key_original, sha256) VALUES ($1, 'dup2', ${sha})`,
              [BABY.A],
            )
          )?.code,
        ).toBe("23505");
        expect(
          await err(
            `INSERT INTO photos (baby_id, storage_key_original, sha256) VALUES ($1, 'dup3', ${sha})`,
            [BABY.B],
          ),
        ).toBeNull();
        // storage keys are globally unique
        expect(
          (
            await err("INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'dup1')", [
              BABY.B,
            ])
          )?.code,
        ).toBe("23505");
      });
    });

    it("fixture sanity: every A photo exists", async () => {
      expect(
        (
          await one<{ n: number }>("SELECT count(*)::int n FROM photos WHERE baby_id = $1", [
            BABY.A,
          ])
        ).n,
      ).toBe(A_PHOTOS.length);
    });
  });
});
