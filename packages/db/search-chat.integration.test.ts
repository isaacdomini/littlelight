import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authed,
  connect,
  type Db,
  databaseUrl,
  ensureMigrated,
  fid,
  PERMISSION_DENIED,
  RLS_VIOLATION,
  tryQuery,
} from "./test/harness";

// Step 7 database rules (docs/plans/step-7.md 2.3, 2.12; packages/db/README.md "Search and chat
// (step 7)"): the photo_search policy matrix and write guard, the cleanup and stale-marking
// triggers, search_stale_photos / photo_search_orphans, the candidate functions, ai_spend, the
// month cost function, the chat tables and the 24 h turn ledger. A small committed world with ids
// in a private range (`ff...`); almost everything else runs in rolled-back transactions.

const U = {
  admin: fid("f", 1),
  admin2: fid("f", 2),
  contrib: fid("f", 3),
  stranger: fid("f", 4),
  adminFree: fid("f", 5),
  adminExpired: fid("f", 6),
};
const BABY = {
  paid: fid("f", 11),
  paid2: fid("f", 12),
  free: fid("f", 13),
  expired: fid("f", 14),
};
const MS = fid("f", 21);
const MS_OTHER = fid("f", 22);
const LINK = fid("f", 31);

const PH = {
  a: fid("f", 101),
  b: fid("f", 102),
  c: fid("f", 103),
  paid2: fid("f", 104),
  free: fid("f", 105),
  expired: fid("f", 106),
};

const GUARD = /search rows can only be stored for approved live photos of a paid-tier baby/;
const SPEND_GUARD = /AI spend can only be recorded for a paid-tier baby/;
const TURN_MSG = /needs a turn reserved with chat_reserve_turn/;

const vec = "(SELECT array_agg(0.1::float4) FROM generate_series(1, 1024))::vector";

describe.skipIf(!databaseUrl)("search and chat database rules (step 7)", () => {
  let db: Db;
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q(sql, params)).rows[0] as T;

  async function sandbox<T>(fn: () => Promise<T>): Promise<T> {
    await q("BEGIN");
    try {
      return await fn();
    } finally {
      await q("ROLLBACK");
    }
  }

  /** Commits `fn` as `authenticated` with the user's claims (the turn ledger needs real commits). */
  async function commitAs<T>(uid: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await db.apiPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(authed(uid)),
      ]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async function cleanup() {
    const babies = Object.values(BABY);
    await q("DELETE FROM public.chat_turns WHERE user_id = ANY($1::uuid[])", [Object.values(U)]);
    await q("DELETE FROM public.audit_log WHERE baby_id = ANY($1::uuid[])", [babies]);
    await q("DELETE FROM public.ai_spend WHERE baby_id = ANY($1::uuid[])", [babies]);
    await q("DELETE FROM public.babies WHERE id = ANY($1::uuid[])", [babies]);
    await q("DELETE FROM public.milestones WHERE id = ANY($1::uuid[])", [[MS, MS_OTHER]]);
    await q("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [Object.values(U)]);
  }

  async function addPhoto(
    id: string,
    baby: string,
    o: {
      status?: string;
      approval?: "approved" | "pending";
      trashed?: boolean;
      quarantined?: boolean;
      createdAt?: string;
    } = {},
  ) {
    const approval = o.approval ?? "approved";
    await q(
      `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, sha256, width, height, bytes, mime,
          status, approval, approved_by, approved_at, deleted_at, quarantined_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, decode(md5($1::text) || md5($1::text || 'x'), 'hex'), 100, 100, 100, 'image/jpeg',
          $5, $6, $7::uuid, $8::timestamptz, $9::timestamptz, $10::timestamptz, COALESCE($11::timestamptz, now()))`,
      [
        id,
        baby,
        U.admin,
        `sc-fx/${id}/original.jpg`,
        o.status ?? "ingested",
        approval,
        approval === "approved" ? U.admin : null,
        approval === "approved" ? new Date() : null,
        o.trashed ? new Date() : null,
        o.quarantined ? new Date() : null,
        o.createdAt ?? null,
      ],
    );
  }

  /** A search row (superuser); the guard applies to the superuser too. */
  async function addSearch(
    photo: string,
    baby: string,
    o: {
      text?: string;
      tags?: string[];
      people?: string[];
      place?: string | null;
      takenAt?: string | null;
      ageDays?: number | null;
      milestones?: string[];
      hash?: string | null;
      model?: string | null;
      version?: string | null;
      vector?: boolean;
      updatedAt?: string;
    } = {},
  ) {
    await q(
      `INSERT INTO public.photo_search
         (photo_id, baby_id, search_text, tags, people, place, taken_at, age_days, milestone_ids,
          content_hash, embed_model, doc_version, embedding, updated_at)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7::timestamptz, $8, $9::uuid[], $10, $11, $12,
               ${o.vector === false ? "NULL" : vec}, COALESCE($13::timestamptz, now()))`,
      [
        photo,
        baby,
        o.text ?? "baby splashing in the bath",
        o.tags ?? [],
        o.people ?? [],
        o.place === undefined ? null : o.place,
        o.takenAt === undefined ? "2026-01-02T03:04:05Z" : o.takenAt,
        o.ageDays === undefined ? 100 : o.ageDays,
        o.milestones ?? [],
        o.hash === undefined ? "hash-1" : o.hash,
        o.model === undefined ? "fake/1024" : o.model,
        o.version === undefined ? "v1" : o.version,
        o.updatedAt ?? null,
      ],
    );
  }

  const searchRow = (photo: string) =>
    one<{ content_hash: string | null; updated_at: Date } | undefined>(
      "SELECT content_hash, updated_at FROM public.photo_search WHERE photo_id = $1",
      [photo],
    );
  const hasRow = async (photo: string) => (await searchRow(photo)) !== undefined;

  const stale = (c: pg.ClientBase, babyId: string | null = null, limit: number | null = null) =>
    c.query<{ photo_id: string; baby_id: string; reason: string }>(
      "SELECT * FROM public.search_stale_photos($1, 'fake/1024', 'v1', $2)",
      [limit, babyId],
    );
  /** Runs `fn` as `pipeline` on the sandbox connection, so it sees the uncommitted rows. */
  async function pipelineHere<T>(fn: (c: pg.ClientBase) => Promise<T>): Promise<T> {
    await q("SET LOCAL ROLE pipeline");
    try {
      return await fn(db.admin);
    } finally {
      await q("RESET ROLE");
    }
  }
  const staleMine = async (babyId: string = BABY.paid) =>
    Object.fromEntries(
      (await pipelineHere((c) => stale(c, babyId))).rows.map((r) => [r.photo_id, r.reason]),
    );

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await q("ROLLBACK").catch(() => undefined);
    await cleanup();
    await q("BEGIN");
    for (const [k, id] of Object.entries(U)) {
      await q(
        "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
        [id, `sc-fx-${k}@tinyglow.test`],
      );
      await q("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, $2)", [id, k]);
    }
    await q(
      `INSERT INTO public.babies (id, name, birth_date, plan, entitlement_expires_at) VALUES
        ($1, 'Paid', '2025-06-30', 'plus', NULL),
        ($2, 'Paid2', '2025-06-30', 'plus', NULL),
        ($3, 'Free', '2025-06-30', 'free', NULL),
        ($4, 'Expired', '2025-06-30', 'plus', now() + interval '1 day')`,
      [BABY.paid, BABY.paid2, BABY.free, BABY.expired],
    );
    for (const [b, u, role] of [
      [BABY.paid, U.admin, "admin"],
      [BABY.paid, U.admin2, "admin"],
      [BABY.paid, U.contrib, "contributor"],
      [BABY.paid2, U.stranger, "admin"],
      [BABY.free, U.adminFree, "admin"],
      [BABY.expired, U.adminExpired, "admin"],
    ] as const) {
      await q("INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1,$2,$3)", [
        b,
        u,
        role,
      ]);
    }
    await q(
      `INSERT INTO public.milestones (id, baby_id, name, category, created_by) VALUES
        ($1, $3, 'sc-fx first steps', 'custom', $4), ($2, $3, 'sc-fx other', 'custom', $4)`,
      [MS, MS_OTHER, BABY.paid, U.admin],
    );
    await addPhoto(PH.a, BABY.paid);
    await addPhoto(PH.b, BABY.paid);
    await addPhoto(PH.c, BABY.paid);
    await addPhoto(PH.paid2, BABY.paid2);
    await addPhoto(PH.expired, BABY.expired);
    // The free baby's photo is added while the baby is free: no search row is possible for it.
    await addPhoto(PH.free, BABY.free);
    await addSearch(PH.a, BABY.paid, {
      text: "baby splashing in the bath with a yellow duck",
      tags: ["bath", "duck"],
      people: ["Dad"],
      place: "home",
      takenAt: "2026-01-02T03:04:05Z",
      ageDays: 100,
      milestones: [MS],
    });
    await addSearch(PH.b, BABY.paid, {
      text: "walking in the park with Grandma",
      tags: ["park"],
      people: ["Grandma"],
      place: "riverside park",
      takenAt: "2026-02-02T03:04:05Z",
      ageDays: 140,
    });
    await addSearch(PH.paid2, BABY.paid2);
    await addSearch(PH.expired, BABY.expired);
    // The entitlement of this baby lapses only now that its row exists.
    await q(
      "UPDATE public.babies SET entitlement_expires_at = now() - interval '1 hour' WHERE id = $1",
      [BABY.expired],
    );
    await q("COMMIT");
  });

  afterAll(async () => {
    if (!db) return;
    await q("ROLLBACK").catch(() => undefined);
    await cleanup();
    await db.close();
  });

  // ---------------------------------------------------------------------------------------------
  describe("photo_search policy matrix", () => {
    const count = (c: pg.ClientBase, where = "true") =>
      c
        .query<{ n: number }>(`SELECT count(*)::int AS n FROM public.photo_search WHERE ${where}`)
        .then((r) => r.rows[0]?.n);
    const mine = `photo_id = ANY('{${Object.values(PH).join(",")}}'::uuid[])`;

    it("admins of the paid baby see its rows (and only its rows)", async () => {
      for (const u of [U.admin, U.admin2]) {
        await db.asUser(u, async (c) => {
          expect(await count(c, mine)).toBe(2);
          const ids = await c.query(`SELECT baby_id FROM public.photo_search WHERE ${mine}`);
          expect(new Set(ids.rows.map((r) => r.baby_id))).toEqual(new Set([BABY.paid]));
        });
      }
    });

    it("a stranger (admin of another paid baby) sees only their own baby's rows", async () => {
      await db.asUser(U.stranger, async (c) => {
        const r = await c.query(`SELECT photo_id FROM public.photo_search WHERE ${mine}`);
        expect(r.rows.map((x) => x.photo_id)).toEqual([PH.paid2]);
      });
    });

    it("a contributor of the baby sees 0 rows", async () => {
      await db.asUser(U.contrib, async (c) => {
        expect(await count(c, mine)).toBe(0);
      });
    });

    it("a user with no membership at all sees 0 rows", async () => {
      await db.asUser(fid("f", 99), async (c) => {
        expect(await count(c, mine)).toBe(0);
      });
    });

    it("an admin of a free baby sees 0 rows; so does an admin whose entitlement expired", async () => {
      await db.asUser(U.adminFree, async (c) => expect(await count(c, mine)).toBe(0));
      await db.asUser(U.adminExpired, async (c) => {
        expect(await count(c, mine)).toBe(0);
      });
      // ...while the row still exists (hidden, restored on re-upgrade)
      expect(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int AS n FROM public.photo_search WHERE photo_id = $1",
            [PH.expired],
          )
        ).n,
      ).toBe(1);
    });

    it("an upgrade shows the rows again", async () => {
      await sandbox(async () => {
        await q(
          "UPDATE public.babies SET entitlement_expires_at = now() + interval '1 day' WHERE id = $1",
          [BABY.expired],
        );
        await db.admin.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(authed(U.adminExpired)),
        ]);
        await db.admin.query("SET LOCAL ROLE authenticated");
        expect(await count(db.admin, `photo_id = '${PH.expired}'`)).toBe(1);
        await db.admin.query("RESET ROLE");
      });
    });

    it("the viewer role has no grant on photo_search", async () => {
      await db.asViewer(LINK, async (c) => {
        expect((await tryQuery(c, "SELECT 1 FROM public.photo_search"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
    });

    it("authenticated cannot write photo_search at all", async () => {
      await db.asUser(U.admin, async (c) => {
        expect(
          (
            await tryQuery(
              c,
              "INSERT INTO public.photo_search (photo_id, baby_id, search_text) VALUES ($1, $2, 'x')",
              [PH.c, BABY.paid],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
        expect(
          (await tryQuery(c, "UPDATE public.photo_search SET search_text = 'x'"))?.message,
        ).toMatch(PERMISSION_DENIED);
        expect((await tryQuery(c, "DELETE FROM public.photo_search"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
    });

    it("search_baby_ids(): admins of paid babies only; empty without claims", async () => {
      const ids = (c: pg.ClientBase) =>
        c.query("SELECT public.search_baby_ids() AS id").then((r) => r.rows.map((x) => x.id));
      await db.asUser(U.admin, async (c) => expect(await ids(c)).toContain(BABY.paid));
      await db.asUser(U.contrib, async (c) => expect(await ids(c)).toEqual([]));
      await db.asUser(U.adminFree, async (c) => expect(await ids(c)).toEqual([]));
      await db.asUser(U.adminExpired, async (c) => expect(await ids(c)).toEqual([]));
      await db.asRole("authenticated", null, async (c) => expect(await ids(c)).toEqual([]));
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("photo_search_guard", () => {
    const insert = (photo: string, baby: string) =>
      "INSERT INTO public.photo_search (photo_id, baby_id, search_text) VALUES ('" +
      photo +
      "', '" +
      baby +
      "', 'x')";

    for (const [label, mk] of [
      ["a free baby", (id: string) => addPhoto(id, BABY.free)],
      ["a pending photo", (id: string) => addPhoto(id, BABY.paid, { approval: "pending" })],
      ["a trashed photo", (id: string) => addPhoto(id, BABY.paid, { trashed: true })],
      ["a quarantined photo", (id: string) => addPhoto(id, BABY.paid, { quarantined: true })],
      ["a failed photo", (id: string) => addPhoto(id, BABY.paid, { status: "failed" })],
      ["a duplicate marker", (id: string) => addPhoto(id, BABY.paid, { status: "duplicate" })],
    ] as const) {
      it(`refuses ${label}: as the superuser and as pipeline`, async () => {
        const id = fid("f", 900);
        await sandbox(async () => {
          await mk(id);
          const baby = (
            await one<{ baby_id: string }>("SELECT baby_id FROM public.photos WHERE id = $1", [id])
          ).baby_id;
          const e = await tryQuery(db.admin, insert(id, baby));
          expect(e?.code).toBe("23514");
          expect(e?.message).toMatch(GUARD);
          // fixed message: nothing from the row is echoed
          expect(e?.message).not.toContain(id);
          await q("SET LOCAL ROLE pipeline");
          const e2 = await tryQuery(db.admin, insert(id, baby));
          expect(e2?.code).toBe("23514");
          expect(e2?.message).toMatch(GUARD);
          await q("RESET ROLE");
        });
      });
    }

    it("refuses a baby_id that is not the photo's own, and an unknown photo", async () => {
      await sandbox(async () => {
        const e = await tryQuery(db.admin, insert(PH.c, BABY.paid2));
        expect(e?.message).toMatch(GUARD);
        const e2 = await tryQuery(db.admin, insert(fid("f", 998), BABY.paid));
        expect(e2?.code === "23514" || e2?.code === "23503").toBe(true);
      });
    });

    it("accepts an approved live photo of a paid baby, as the superuser and as pipeline", async () => {
      await sandbox(async () => {
        expect(await tryQuery(db.admin, insert(PH.c, BABY.paid))).toBeNull();
      });
      await sandbox(async () => {
        await q("SET LOCAL ROLE pipeline");
        expect(await tryQuery(db.admin, insert(PH.c, BABY.paid))).toBeNull();
        await q("RESET ROLE");
      });
    });

    it("content writes for a downgraded baby are refused, bookkeeping writes pass", async () => {
      await sandbox(async () => {
        await q("UPDATE public.babies SET plan = 'free' WHERE id = $1", [BABY.paid]);
        const e = await tryQuery(
          db.admin,
          `UPDATE public.photo_search SET search_text = 'new' WHERE photo_id = '${PH.a}'`,
        );
        expect(e?.message).toMatch(GUARD);
        const e2 = await tryQuery(
          db.admin,
          `UPDATE public.photo_search SET embedding = ${vec} WHERE photo_id = '${PH.a}'`,
        );
        expect(e2?.message).toMatch(GUARD);
        expect(
          await tryQuery(
            db.admin,
            `UPDATE public.photo_search SET content_hash = NULL WHERE photo_id = '${PH.a}'`,
          ),
        ).toBeNull();
      });
    });

    it("a downgrade keeps the rows", async () => {
      await sandbox(async () => {
        await q("UPDATE public.babies SET plan = 'free' WHERE id = $1", [BABY.paid]);
        expect(await hasRow(PH.a)).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("photos_search_cleanup", () => {
    const cases: [string, string][] = [
      ["trash", "UPDATE public.photos SET deleted_at = now() WHERE id = $1"],
      [
        "un-approve",
        "UPDATE public.photos SET approval = 'pending', approved_by = NULL, approved_at = NULL WHERE id = $1",
      ],
      ["quarantine", "UPDATE public.photos SET quarantined_at = now() WHERE id = $1"],
      ["fail", "UPDATE public.photos SET status = 'failed' WHERE id = $1"],
      ["mark duplicate", "UPDATE public.photos SET status = 'duplicate' WHERE id = $1"],
    ];
    it.each(cases)("%s deletes the photo's search row immediately", async (_n, sql) => {
      await sandbox(async () => {
        expect(await hasRow(PH.a)).toBe(true);
        await q(sql, [PH.a]);
        expect(await hasRow(PH.a)).toBe(false);
        // the neighbour is untouched
        expect(await hasRow(PH.b)).toBe(true);
      });
    });

    it("an unrelated photo update keeps the row; restoring from trash makes the photo 'missing'", async () => {
      await sandbox(async () => {
        await q("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [PH.a]);
        expect(await hasRow(PH.a)).toBe(true);
        await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [PH.a]);
        await q("UPDATE public.photos SET deleted_at = NULL WHERE id = $1", [PH.a]);
        expect(await hasRow(PH.a)).toBe(false);
        const rows = await q(
          "SELECT * FROM public.search_stale_photos(NULL, 'fake/1024', 'v1', $1)",
          [BABY.paid],
        );
        expect(rows.rows.find((r) => r.photo_id === PH.a)?.reason).toBe("missing");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("stale marking when a source row goes away", () => {
    it("deleting photo_details clears content_hash", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO public.photo_details (photo_id, note, edited_by) VALUES ($1, 'n', $2)",
          [PH.a, U.admin],
        );
        await q("UPDATE public.photo_search SET content_hash = 'h' WHERE photo_id = $1", [PH.a]);
        await q("DELETE FROM public.photo_details WHERE photo_id = $1", [PH.a]);
        expect((await searchRow(PH.a))?.content_hash).toBeNull();
        expect((await searchRow(PH.b))?.content_hash).toBe("hash-1");
      });
    });

    it("deleting a photo_ai row clears content_hash", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description) VALUES ($1, 'm', 'v1', 'v1', '{\"caption\":\"x\"}')",
          [PH.a],
        );
        await q("DELETE FROM public.photo_ai WHERE photo_id = $1", [PH.a]);
        expect((await searchRow(PH.a))?.content_hash).toBeNull();
      });
    });

    it("deleting an override clears content_hash", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO public.photo_ai_overrides (photo_id, field_path, value, edited_by) VALUES ($1, 'caption', '\"c\"', $2)",
          [PH.a, U.admin],
        );
        await q("DELETE FROM public.photo_ai_overrides WHERE photo_id = $1", [PH.a]);
        expect((await searchRow(PH.a))?.content_hash).toBeNull();
      });
    });

    it("deleting a linked measurement clears content_hash; moving it clears the old photo's", async () => {
      await sandbox(async () => {
        const m = fid("f", 700);
        await q(
          `INSERT INTO public.measurements (id, baby_id, photo_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
           VALUES ($1, $2, $3, 'weight', 3400, 3400, 'g', now(), $4)`,
          [m, BABY.paid, PH.a, U.admin],
        );
        await q("UPDATE public.measurements SET photo_id = $2 WHERE id = $1", [m, PH.b]);
        expect((await searchRow(PH.a))?.content_hash).toBeNull();
        expect((await searchRow(PH.b))?.content_hash).toBe("hash-1");
        await q("DELETE FROM public.measurements WHERE id = $1", [m]);
        expect((await searchRow(PH.b))?.content_hash).toBeNull();
      });
    });

    it("an unlinked measurement delete touches nothing", async () => {
      await sandbox(async () => {
        const m = fid("f", 701);
        await q(
          `INSERT INTO public.measurements (id, baby_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
           VALUES ($1, $2, 'weight', 3400, 3400, 'g', now(), $3)`,
          [m, BABY.paid, U.admin],
        );
        await q("DELETE FROM public.measurements WHERE id = $1", [m]);
        expect((await searchRow(PH.a))?.content_hash).toBe("hash-1");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("search_stale_photos", () => {
    it("lists missing photos and nothing for free, pending, trashed, quarantined or uploaded ones", async () => {
      await sandbox(async () => {
        await addPhoto(fid("f", 910), BABY.paid, { approval: "pending" });
        await addPhoto(fid("f", 911), BABY.paid, { trashed: true });
        await addPhoto(fid("f", 912), BABY.paid, { quarantined: true });
        await addPhoto(fid("f", 913), BABY.paid, { status: "uploaded" });
        await addPhoto(fid("f", 914), BABY.paid, { status: "failed" });
        await addPhoto(fid("f", 915), BABY.paid, { status: "duplicate" });
        const r = await q(
          "SELECT * FROM public.search_stale_photos(NULL, 'fake/1024', 'v1', NULL)",
        );
        const byId = Object.fromEntries(r.rows.map((x) => [x.photo_id, x.reason]));
        expect(byId[PH.c]).toBe("missing");
        for (const n of [910, 911, 912, 913, 914, 915]) expect(byId[fid("f", n)]).toBeUndefined();
        expect(byId[PH.free]).toBeUndefined();
        expect(byId[PH.expired]).toBeUndefined();
        // nothing else is stale: the rows were written fresh
        expect(byId[PH.a]).toBeUndefined();
        expect(byId[PH.b]).toBeUndefined();
      });
    });

    it("the reasons: unembedded, version (model and doc version), stale", async () => {
      await sandbox(async () => {
        await q("UPDATE public.photo_search SET embedding = NULL WHERE photo_id = $1", [PH.a]);
        await addSearch(PH.c, BABY.paid, { model: "text-embedding-3-small/1024" });
        expect(await staleMine()).toEqual({ [PH.a]: "unembedded", [PH.c]: "version" });
        await q(
          "UPDATE public.photo_search SET embed_model = 'fake/1024', doc_version = 'v0' WHERE photo_id = $1",
          [PH.c],
        );
        expect((await staleMine())[PH.c]).toBe("version");
        await q("UPDATE public.photo_search SET doc_version = 'v1' WHERE photo_id = $1", [PH.c]);
        expect((await staleMine())[PH.c]).toBeUndefined();
      });
    });

    // now() is fixed inside a transaction, so the "newer source" cases commit step by step and
    // clean up after themselves.
    const staleCommitted = async () =>
      Object.fromEntries(
        (await db.asPipeline((c) => stale(c, BABY.paid))).rows.map((r) => [r.photo_id, r.reason]),
      );
    const touch = (...photos: string[]) =>
      q("UPDATE public.photo_search SET updated_at = now() WHERE photo_id = ANY($1::uuid[])", [
        photos,
      ]);
    async function restoreWorld() {
      await q("DELETE FROM public.photo_details WHERE photo_id = ANY($1::uuid[])", [[PH.a, PH.b]]);
      await q("DELETE FROM public.photo_ai WHERE photo_id = ANY($1::uuid[])", [[PH.a, PH.b]]);
      await q("DELETE FROM public.photo_ai_overrides WHERE photo_id = ANY($1::uuid[])", [
        [PH.a, PH.b],
      ]);
      await q("DELETE FROM public.measurements WHERE baby_id = $1", [BABY.paid]);
      await q("DELETE FROM public.photo_search WHERE photo_id = $1", [PH.c]);
      await q("UPDATE public.milestones SET name = 'sc-fx first steps' WHERE id = $1", [MS]);
      await q("UPDATE public.photo_search SET content_hash = 'hash-1' WHERE baby_id = $1", [
        BABY.paid,
      ]);
      await touch(PH.a, PH.b);
    }

    it("becomes stale after a photo_details update, an override, a linked measurement and a milestone rename; not after a touch", async () => {
      try {
        await addSearch(PH.c, BABY.paid);
        await touch(PH.a, PH.b, PH.c);
        expect(await staleCommitted()).toEqual({});

        await q(
          "INSERT INTO public.photo_details (photo_id, note, milestone_id, edited_by) VALUES ($1, 'n', $2, $3)",
          [PH.a, MS, U.admin],
        );
        expect(await staleCommitted()).toEqual({ [PH.a]: "stale" });
        // a touch (the indexer rewrote the row) clears it
        await touch(PH.a);
        expect(await staleCommitted()).toEqual({});

        await q(
          "INSERT INTO public.photo_ai_overrides (photo_id, field_path, value, edited_by) VALUES ($1, 'caption', '\"c\"', $2)",
          [PH.b, U.admin],
        );
        expect(await staleCommitted()).toEqual({ [PH.b]: "stale" });
        await touch(PH.b);
        expect(await staleCommitted()).toEqual({});

        await q(
          `INSERT INTO public.measurements (baby_id, photo_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
           VALUES ($1, $2, 'weight', 3400, 3400, 'g', now(), $3)`,
          [BABY.paid, PH.b, U.admin],
        );
        expect(await staleCommitted()).toEqual({ [PH.b]: "stale" });
        await touch(PH.b);
        expect(await staleCommitted()).toEqual({});

        // renaming the tagged milestone makes photo A stale again
        await q("UPDATE public.milestones SET name = 'sc-fx renamed' WHERE id = $1", [MS]);
        expect(await staleCommitted()).toEqual({ [PH.a]: "stale" });
        await touch(PH.a);
        expect(await staleCommitted()).toEqual({});

        // an edit of the photo row itself (e.g. the sensitive flag) counts too
        await q("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [PH.b]);
        expect(await staleCommitted()).toEqual({ [PH.b]: "stale" });
        await q("UPDATE public.photos SET is_sensitive = false WHERE id = $1", [PH.b]);
      } finally {
        await restoreWorld();
      }
    });

    it("a new photo_ai row makes the photo stale; a deleted source (hash cleared) is stale", async () => {
      try {
        await addSearch(PH.c, BABY.paid);
        await touch(PH.a, PH.b, PH.c);
        expect(await staleCommitted()).toEqual({});
        await q(
          "INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description) VALUES ($1, 'm', 'v1', 'v1', '{\"caption\":\"x\"}')",
          [PH.a],
        );
        expect(await staleCommitted()).toEqual({ [PH.a]: "stale" });
        await touch(PH.a);
        // deleting the AI row (an admin discards a description) clears the hash
        await q("DELETE FROM public.photo_ai WHERE photo_id = $1", [PH.a]);
        expect(await staleCommitted()).toEqual({ [PH.a]: "stale" });
        await touch(PH.a);
        expect(await staleCommitted()).toEqual({ [PH.a]: "stale" });
        await q("UPDATE public.photo_search SET content_hash = 'hash-1' WHERE photo_id = $1", [
          PH.a,
        ]);
        expect(await staleCommitted()).toEqual({});
      } finally {
        await restoreWorld();
      }
    });

    it("orders oldest first, honours p_limit and p_baby_id", async () => {
      await sandbox(async () => {
        await addPhoto(fid("f", 920), BABY.paid, { createdAt: "2020-01-01T00:00:00Z" });
        await addPhoto(fid("f", 921), BABY.paid, { createdAt: "2020-01-02T00:00:00Z" });
        const r = await pipelineHere((c) => stale(c, null, 2));
        expect(r.rows.map((x) => x.photo_id)).toEqual([fid("f", 920), fid("f", 921)]);
        const none = await pipelineHere((c) => stale(c, BABY.paid2));
        expect(none.rows).toEqual([]);
      });
    });

    it("is executable by pipeline only: authenticated and viewer are refused", async () => {
      await db.asUser(U.admin, async (c) => {
        expect(
          (await tryQuery(c, "SELECT * FROM public.search_stale_photos(NULL, 'x', 'y', NULL)"))
            ?.message,
        ).toMatch(PERMISSION_DENIED);
      });
      await db.asViewer(LINK, async (c) => {
        expect(
          (await tryQuery(c, "SELECT * FROM public.search_stale_photos(NULL, 'x', 'y', NULL)"))
            ?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("never selects a GPS column", async () => {
      const def = await one<{ src: string }>(
        "SELECT pg_get_functiondef('public.search_stale_photos(integer,text,text,uuid)'::regprocedure) AS src",
      );
      expect(def.src).not.toMatch(/gps_|latitude|longitude|raw_json/);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("photo_search_orphans", () => {
    it("lists rows whose photo can no longer be indexed (safety net behind the trigger)", async () => {
      await sandbox(async () => {
        await q("ALTER TABLE public.photos DISABLE TRIGGER photos_search_cleanup");
        await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [PH.a]);
        await q("UPDATE public.photos SET quarantined_at = now() WHERE id = $1", [PH.b]);
        const r = await pipelineHere((c) =>
          c.query("SELECT public.photo_search_orphans(100) AS id"),
        );
        const ids = r.rows.map((x) => x.id);
        expect(ids).toContain(PH.a);
        expect(ids).toContain(PH.b);
        expect(ids).not.toContain(PH.paid2);
        const limited = await pipelineHere((c) =>
          c.query("SELECT public.photo_search_orphans(1) AS id"),
        );
        expect(limited.rows).toHaveLength(1);
        await q("ALTER TABLE public.photos ENABLE TRIGGER photos_search_cleanup");
      });
    });

    it("keeps the rows of a downgraded baby (they are hidden, not orphans)", async () => {
      await sandbox(async () => {
        await q("UPDATE public.babies SET plan = 'free' WHERE id = $1", [BABY.paid]);
        const r = await pipelineHere((c) =>
          c.query("SELECT public.photo_search_orphans(100) AS id"),
        );
        expect(r.rows.map((x) => x.id)).not.toContain(PH.a);
      });
    });

    it("is executable by pipeline only", async () => {
      await db.asUser(U.admin, async (c) => {
        expect((await tryQuery(c, "SELECT public.photo_search_orphans(1)"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("candidate functions", () => {
    const text = (
      c: pg.ClientBase,
      baby: string,
      tsq: string,
      extra: Partial<Record<string, unknown>> = {},
    ) =>
      c
        .query<{ photo_id: string; rank: number }>(
          `SELECT * FROM public.photo_search_text_candidates($1::uuid, to_tsquery('english', $2::text), 50,
             $3::timestamptz, $4::timestamptz, $5::int, $6::int, $7::uuid[], $8::text[], $9::text[], $10::text)`,
          [
            baby,
            tsq,
            extra.from ?? null,
            extra.to ?? null,
            extra.ageFrom ?? null,
            extra.ageTo ?? null,
            extra.milestones ?? null,
            extra.people ?? null,
            extra.tags ?? null,
            extra.place ?? null,
          ],
        )
        .then((r) => r.rows.map((x) => x.photo_id));
    const term = (
      c: pg.ClientBase,
      baby: string,
      terms: string[],
      extra: Partial<Record<string, unknown>> = {},
    ) =>
      c
        .query<{ photo_id: string; hits: number }>(
          `SELECT * FROM public.photo_search_term_candidates($1::uuid, $2::text[], 50,
             $3::timestamptz, $4::timestamptz, $5::int, $6::int, $7::uuid[], $8::text[], $9::text[], $10::text)`,
          [
            baby,
            terms,
            extra.from ?? null,
            extra.to ?? null,
            extra.ageFrom ?? null,
            extra.ageTo ?? null,
            extra.milestones ?? null,
            extra.people ?? null,
            extra.tags ?? null,
            extra.place ?? null,
          ],
        )
        .then((r) => r.rows.map((x) => x.photo_id));

    it("an admin of the paid baby gets matches, best first", async () => {
      await db.asUser(U.admin, async (c) => {
        expect(await text(c, BABY.paid, "bath | park")).toEqual(
          expect.arrayContaining([PH.a, PH.b]),
        );
        expect(await text(c, BABY.paid, "bath")).toEqual([PH.a]);
        expect(await term(c, BABY.paid, ["duck", "grandma"])).toEqual(
          expect.arrayContaining([PH.a, PH.b]),
        );
        // 'Dad' is a people hit worth 2, a tag hit 1
        const hits = await c.query(
          "SELECT * FROM public.photo_search_term_candidates($1, ARRAY['dad','bath'], 10)",
          [BABY.paid],
        );
        expect(hits.rows[0]).toMatchObject({ photo_id: PH.a, hits: 3 });
      });
    });

    it("is empty for a stranger, a contributor, a free admin, an expired admin and for another baby's id", async () => {
      for (const u of [U.stranger, U.contrib, U.adminFree, U.adminExpired]) {
        await db.asUser(u, async (c) => {
          expect(await text(c, BABY.paid, "bath | park"), `text ${u}`).toEqual([]);
          expect(await term(c, BABY.paid, ["duck", "park"]), `term ${u}`).toEqual([]);
        });
      }
      await db.asUser(U.admin, async (c) => {
        expect(await text(c, BABY.paid2, "baby")).toEqual([]);
        expect(await text(c, BABY.free, "baby")).toEqual([]);
        expect(await term(c, BABY.paid2, ["baby"])).toEqual([]);
      });
      await db.asRole("authenticated", null, async (c) => {
        expect(await text(c, BABY.paid, "bath")).toEqual([]);
      });
    });

    it("returns only ids and scores (no search_text column)", async () => {
      await db.asUser(U.admin, async (c) => {
        const r = await c.query(
          "SELECT * FROM public.photo_search_text_candidates($1, 'bath'::tsquery, 5)",
          [BABY.paid],
        );
        expect(Object.keys(r.rows[0] ?? {}).sort()).toEqual(["photo_id", "rank"]);
        const t = await c.query(
          "SELECT * FROM public.photo_search_term_candidates($1, ARRAY['bath'], 5)",
          [BABY.paid],
        );
        expect(Object.keys(t.rows[0] ?? {}).sort()).toEqual(["hits", "photo_id"]);
      });
    });

    it("filters apply: dates, ages, milestones, people, tags, place", async () => {
      await db.asUser(U.admin, async (c) => {
        const both = "baby | walking | splashing";
        expect(await text(c, BABY.paid, both, { from: "2026-02-01T00:00:00Z" })).toEqual([PH.b]);
        expect(await text(c, BABY.paid, both, { to: "2026-02-01T00:00:00Z" })).toEqual([PH.a]);
        expect(await text(c, BABY.paid, both, { ageFrom: 120 })).toEqual([PH.b]);
        expect(await text(c, BABY.paid, both, { ageTo: 120 })).toEqual([PH.a]);
        expect(await text(c, BABY.paid, both, { milestones: [MS] })).toEqual([PH.a]);
        expect(await text(c, BABY.paid, both, { milestones: [MS_OTHER] })).toEqual([]);
        expect(await text(c, BABY.paid, both, { people: ["GRANDMA"] })).toEqual([PH.b]);
        expect(await text(c, BABY.paid, both, { tags: ["duck"] })).toEqual([PH.a]);
        expect(await text(c, BABY.paid, both, { place: "Riverside Park" })).toEqual([PH.b]);
        expect(await text(c, BABY.paid, both, { place: "nowhere" })).toEqual([]);

        const terms = ["bath", "park", "dad", "grandma"];
        expect(await term(c, BABY.paid, terms, { from: "2026-02-01T00:00:00Z" })).toEqual([PH.b]);
        expect(await term(c, BABY.paid, terms, { people: ["dad"] })).toEqual([PH.a]);
        expect(await term(c, BABY.paid, terms, { milestones: [MS] })).toEqual([PH.a]);
        expect(await term(c, BABY.paid, terms, { place: "home" })).toEqual([PH.a]);
        expect(await term(c, BABY.paid, terms, { ageFrom: 130, ageTo: 150 })).toEqual([PH.b]);
      });
    });

    it("never returns a trashed or quarantined photo even if its row survives (trigger off)", async () => {
      await sandbox(async () => {
        await q("ALTER TABLE public.photos DISABLE TRIGGER photos_search_cleanup");
        await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [PH.a]);
        await q("UPDATE public.photos SET quarantined_at = now() WHERE id = $1", [PH.b]);
        // run as the user in this transaction
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(authed(U.admin)),
        ]);
        await q("SET LOCAL ROLE authenticated");
        expect(await text(db.admin, BABY.paid, "baby | walking | splashing")).toEqual([]);
        expect(await term(db.admin, BABY.paid, ["bath", "park", "duck"])).toEqual([]);
        await q("RESET ROLE");
        await q("ALTER TABLE public.photos ENABLE TRIGGER photos_search_cleanup");
      });
    });

    it("the viewer role and pipeline cannot call them", async () => {
      await db.asViewer(LINK, async (c) => {
        expect(
          (
            await tryQuery(
              c,
              "SELECT * FROM public.photo_search_text_candidates($1, 'a'::tsquery, 1)",
              [BABY.paid],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
      });
      await db.asPipeline(async (c) => {
        expect(
          (
            await tryQuery(
              c,
              "SELECT * FROM public.photo_search_term_candidates($1, ARRAY['a'], 1)",
              [BABY.paid],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("the GIN indexes serve the legs (superuser, seq scans off, 3000 rows)", async () => {
      await sandbox(async () => {
        // enough rows for the planner to care; the guard needs real photos, so reuse paid2's photo ids via a bulk photo insert
        await q(
          `INSERT INTO public.photos (id, baby_id, storage_key_original, status, approval)
           SELECT ('ff100000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $1, 'sc-bulk/' || g, 'ingested', 'approved'
             FROM generate_series(1, 3000) g`,
          [BABY.paid],
        );
        await q(
          `INSERT INTO public.photo_search (photo_id, baby_id, search_text, tags, people)
           SELECT id, baby_id, 'word' || (row_number() OVER ())::text || ' filler', ARRAY['t' || (row_number() OVER ())::text],
                  ARRAY['p' || (row_number() OVER ())::text]
             FROM public.photos WHERE storage_key_original LIKE 'sc-bulk/%'`,
        );
        await q("ANALYZE public.photo_search");
        await q("SET LOCAL enable_seqscan = off");
        const plan = async (sql: string) =>
          (await q(`EXPLAIN ${sql}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
        expect(
          await plan(
            "SELECT 1 FROM public.photo_search s WHERE s.tsv @@ to_tsquery('english', 'word77')",
          ),
        ).toMatch(/photo_search_tsv_idx/);
        expect(
          await plan("SELECT 1 FROM public.photo_search s WHERE s.tags && ARRAY['t77']"),
        ).toMatch(/photo_search_tags_idx/);
        expect(
          await plan(
            "SELECT 1 FROM public.photo_search s WHERE public.lower_text_array(s.people) && ARRAY['p77']",
          ),
        ).toMatch(/photo_search_people_lower_idx/);
        // and the functions return the right thing at this size
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(authed(U.admin)),
        ]);
        await q("SET LOCAL ROLE authenticated");
        expect((await text(db.admin, BABY.paid, "word77")).length).toBe(1);
        expect((await term(db.admin, BABY.paid, ["t77", "p88"])).length).toBe(2);
        await q("RESET ROLE");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("ai_spend", () => {
    const ins = (
      c: pg.ClientBase,
      o: {
        baby?: string;
        user?: string | null;
        kind?: string;
        ref?: string | null;
        cost?: number;
      } = {},
    ) =>
      tryQuery(
        c,
        `INSERT INTO public.ai_spend (baby_id, user_id, kind, ref_id, model, cost_usd)
         VALUES ($1, $2, $3, $4, 'gpt-6-luna', $5)`,
        [
          o.baby ?? BABY.paid,
          o.user === undefined ? null : o.user,
          o.kind ?? "embed",
          o.ref ?? null,
          o.cost ?? 0.001,
        ],
      );

    it("an admin inserts own chat and rerank rows for a paid baby they administer", async () => {
      await db.asUser(U.admin, async (c) => {
        expect(await ins(c, { user: U.admin, kind: "chat" })).toBeNull();
        expect(await ins(c, { user: U.admin, kind: "rerank" })).toBeNull();
      });
    });

    it("an admin cannot insert embed rows, rows for someone else, other babies or negative costs", async () => {
      await db.asUser(U.admin, async (c) => {
        expect((await ins(c, { user: U.admin, kind: "embed" }))?.message).toMatch(RLS_VIOLATION);
        expect((await ins(c, { user: null, kind: "chat" }))?.message).toMatch(RLS_VIOLATION);
        expect((await ins(c, { user: U.admin2, kind: "chat" }))?.message).toMatch(RLS_VIOLATION);
        expect((await ins(c, { baby: BABY.paid2, user: U.admin, kind: "chat" }))?.message).toMatch(
          RLS_VIOLATION,
        );
        const neg = await ins(c, { user: U.admin, kind: "chat", cost: -1 });
        expect(neg?.code).toBe("23514");
      });
    });

    it("a contributor, a stranger and the viewer cannot insert", async () => {
      await db.asUser(U.contrib, async (c) => {
        expect((await ins(c, { user: U.contrib, kind: "chat" }))?.message).toMatch(RLS_VIOLATION);
      });
      await db.asUser(U.stranger, async (c) => {
        expect((await ins(c, { user: U.stranger, kind: "chat" }))?.message).toMatch(RLS_VIOLATION);
      });
      await db.asViewer(LINK, async (c) => {
        expect((await ins(c, { user: null, kind: "embed" }))?.message).toMatch(PERMISSION_DENIED);
      });
    });

    it("pipeline inserts embed rows only (no user, no ref); not chat; can read; cannot update or delete", async () => {
      await db.asPipeline(async (c) => {
        expect(await ins(c, { kind: "embed" })).toBeNull();
        expect((await ins(c, { kind: "chat", user: null }))?.message).toMatch(RLS_VIOLATION);
        expect((await ins(c, { kind: "embed", user: U.admin }))?.message).toMatch(RLS_VIOLATION);
        expect((await ins(c, { kind: "embed", ref: fid("f", 1) }))?.message).toMatch(RLS_VIOLATION);
        expect((await tryQuery(c, "UPDATE public.ai_spend SET cost_usd = 0"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await tryQuery(c, "DELETE FROM public.ai_spend"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect(
          (await c.query("SELECT count(*)::int AS n FROM public.ai_spend")).rows[0].n,
        ).toBeGreaterThanOrEqual(1);
      });
    });

    it("authenticated can neither update, delete nor backdate", async () => {
      await db.asUser(U.admin, async (c) => {
        await ins(c, { user: U.admin, kind: "chat" });
        expect((await tryQuery(c, "UPDATE public.ai_spend SET cost_usd = 0"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await tryQuery(c, "DELETE FROM public.ai_spend"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect(
          (
            await tryQuery(
              c,
              "INSERT INTO public.ai_spend (baby_id, user_id, kind, model, cost_usd, created_at) VALUES ($1, $2, 'chat', 'm', 1, now() - interval '40 days')",
              [BABY.paid, U.admin],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("reads: admins of the baby see its rows; a stranger and a contributor see 0", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd) VALUES ($1, 'embed', 'fake', 0.5)",
          [BABY.paid],
        );
        await q(
          "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd) VALUES ($1, 'embed', 'fake', 0.5)",
          [BABY.paid2],
        );
        const n = (u: string) =>
          db.asUser(
            u,
            async (c) =>
              (await c.query("SELECT count(*)::int AS n FROM public.ai_spend WHERE model = 'fake'"))
                .rows[0].n,
          );
        // asUser rolls back its own transaction; the outer sandbox rolls back the rows, so read
        // inside the same transaction instead
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(authed(U.admin)),
        ]);
        await q("SET LOCAL ROLE authenticated");
        expect(
          (await q("SELECT count(*)::int AS n FROM public.ai_spend WHERE model = 'fake'")).rows[0]
            .n,
        ).toBe(1);
        await q("RESET ROLE");
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(authed(U.contrib)),
        ]);
        await q("SET LOCAL ROLE authenticated");
        expect(
          (await q("SELECT count(*)::int AS n FROM public.ai_spend WHERE model = 'fake'")).rows[0]
            .n,
        ).toBe(0);
        await q("RESET ROLE");
        void n;
      });
    });

    it("the guard refuses a row for a free baby from every role, including the superuser", async () => {
      await sandbox(async () => {
        const e = await ins(db.admin, { baby: BABY.free, kind: "embed" });
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(SPEND_GUARD);
        const e2 = await ins(db.admin, { baby: BABY.expired, kind: "embed" });
        expect(e2?.message).toMatch(SPEND_GUARD);
      });
      await db.asPipeline(async (c) => {
        expect((await ins(c, { baby: BABY.free, kind: "embed" }))?.message).toMatch(SPEND_GUARD);
      });
    });

    it("kind and model are constrained", async () => {
      await sandbox(async () => {
        expect(
          (
            await tryQuery(
              db.admin,
              "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd) VALUES ($1, 'other', 'm', 0)",
              [BABY.paid],
            )
          )?.code,
        ).toBe("23514");
        expect(
          (
            await tryQuery(
              db.admin,
              "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd) VALUES ($1, 'embed', '', 0)",
              [BABY.paid],
            )
          )?.code,
        ).toBe("23514");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("ai_baby_month_cost_usd = items + spend", () => {
    it("sums vision items and non-batch spend of the UTC month, and nothing of other months or babies", async () => {
      await sandbox(async () => {
        const batch = fid("f", 800);
        await q("INSERT INTO public.ai_batches (id, provider, model) VALUES ($1, 'fake', 'm')", [
          batch,
        ]);
        await q(
          `INSERT INTO public.ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, state, cost_usd)
           VALUES ($1, $2, $3, 1, 'v1', 'v1', 'succeeded', 0.25)`,
          [batch, PH.a, BABY.paid],
        );
        await q(
          "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd) VALUES ($1, 'embed', 'fake', 0.125)",
          [BABY.paid],
        );
        await q(
          "INSERT INTO public.ai_spend (baby_id, user_id, kind, model, cost_usd) VALUES ($1, $2, 'chat', 'm', 0.0625)",
          [BABY.paid, U.admin],
        );
        await q(
          "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd, created_at) VALUES ($1, 'embed', 'fake', 100, now() - interval '70 days')",
          [BABY.paid],
        );
        await q(
          "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd) VALUES ($1, 'embed', 'fake', 100)",
          [BABY.paid2],
        );
        const cost = async (baby: string) =>
          Number(
            (
              await one<{ c: string }>(
                "SELECT public.ai_baby_month_cost_usd($1, now()::date) AS c",
                [baby],
              )
            ).c,
          );
        expect(await cost(BABY.paid)).toBeCloseTo(0.4375, 8);
        expect(await cost(BABY.free)).toBe(0);
        expect(await cost(BABY.paid2)).toBe(100);
      });
    });

    it("an admin sees their baby's total through RLS; a stranger sees 0", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd) VALUES ($1, 'embed', 'fake', 0.5)",
          [BABY.paid],
        );
        const read = async (u: string) => {
          await q("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(authed(u))]);
          await q("SET LOCAL ROLE authenticated");
          const r = Number(
            (
              await one<{ c: string }>(
                "SELECT public.ai_baby_month_cost_usd($1, now()::date) AS c",
                [BABY.paid],
              )
            ).c,
          );
          await q("RESET ROLE");
          return r;
        };
        expect(await read(U.admin)).toBe(0.5);
        expect(await read(U.stranger)).toBe(0);
        expect(await read(U.contrib)).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("chat tables", () => {
    const thread = (id: string, baby = BABY.paid, user = U.admin) =>
      q("INSERT INTO public.chat_threads (id, baby_id, user_id) VALUES ($1, $2, $3)", [
        id,
        baby,
        user,
      ]);
    const msg = (
      c: pg.ClientBase,
      o: {
        thread: string;
        baby?: string;
        user?: string;
        role?: string;
        content?: string;
        photos?: string[];
        meas?: string[];
        tools?: string[];
        cost?: number | null;
        status?: string;
      },
    ) =>
      tryQuery(
        c,
        `INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content, cited_photo_ids, cited_measurement_ids, tools_used, cost_usd, status)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[], $8::text[], $9, $10)`,
        [
          o.thread,
          o.baby ?? BABY.paid,
          o.user ?? U.admin,
          o.role ?? "assistant",
          o.content ?? "answer",
          o.photos ?? [],
          o.meas ?? [],
          o.tools ?? [],
          o.cost === undefined ? null : o.cost,
          o.status ?? "complete",
        ],
      );
    const ids = (n: number) => Array.from({ length: n }, (_, i) => fid("f", 5000 + i));

    it("one thread per user per baby", async () => {
      await sandbox(async () => {
        await thread(fid("f", 600));
        const dup = await tryQuery(
          db.admin,
          "INSERT INTO public.chat_threads (baby_id, user_id) VALUES ($1, $2)",
          [BABY.paid, U.admin],
        );
        expect(dup?.code).toBe("23505");
        // another user, or another baby, is fine
        expect(
          await tryQuery(
            db.admin,
            "INSERT INTO public.chat_threads (baby_id, user_id) VALUES ($1, $2)",
            [BABY.paid, U.admin2],
          ),
        ).toBeNull();
      });
    });

    it("chat_messages_shape: content 1..8000, 50 ids, closed tool names, 16 tools, cost >= 0, status set", async () => {
      await sandbox(async () => {
        const t = fid("f", 601);
        await thread(t);
        const ok = (o: Parameters<typeof msg>[1]) => msg(db.admin, { thread: t, ...o });
        expect(await ok({ content: "x" })).toBeNull();
        expect(await ok({ content: "x".repeat(8000) })).toBeNull();
        expect((await ok({ content: "" }))?.code).toBe("23514");
        expect((await ok({ content: "x".repeat(8001) }))?.code).toBe("23514");
        expect(await ok({ photos: ids(50), meas: ids(50) })).toBeNull();
        expect((await ok({ photos: ids(51) }))?.code).toBe("23514");
        expect((await ok({ meas: ids(51) }))?.code).toBe("23514");
        expect(
          await ok({ tools: ["search_photos", "get_measurements", "get_milestones", "get_photo"] }),
        ).toBeNull();
        expect((await ok({ tools: ["delete_everything"] }))?.code).toBe("23514");
        expect((await ok({ tools: Array(17).fill("get_photo") }))?.code).toBe("23514");
        expect((await ok({ cost: -0.01 }))?.code).toBe("23514");
        expect(await ok({ cost: 0 })).toBeNull();
        expect((await ok({ status: "weird" }))?.code).toBe("23514");
        expect(await ok({ status: "error" })).toBeNull();
        // errors never echo the content
        const e = await ok({ content: "SECRET-QUESTION".repeat(1000) });
        expect(e?.message).not.toContain("SECRET-QUESTION");
      });
    });

    it("an admin of a paid baby writes and reads their own thread and assistant messages", async () => {
      await db.asUser(U.admin, async (c) => {
        const t = await c.query(
          "INSERT INTO public.chat_threads (baby_id, user_id) VALUES ($1, $2) RETURNING id",
          [BABY.paid, U.admin],
        );
        const tid = t.rows[0].id;
        expect(await msg(c, { thread: tid })).toBeNull();
        const rows = await c.query(
          "SELECT count(*)::int AS n FROM public.chat_messages WHERE thread_id = $1",
          [tid],
        );
        expect(rows.rows[0].n).toBe(1);
      });
    });

    it("another admin of the same baby cannot read or write the first admin's thread", async () => {
      await sandbox(async () => {
        const t = fid("f", 602);
        await thread(t);
        await msg(db.admin, { thread: t });
        await q("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(authed(U.admin2)),
        ]);
        await q("SET LOCAL ROLE authenticated");
        expect((await q("SELECT count(*)::int AS n FROM public.chat_messages")).rows[0].n).toBe(0);
        expect(
          (await q("SELECT count(*)::int AS n FROM public.chat_threads WHERE id = $1", [t])).rows[0]
            .n,
        ).toBe(0);
        await q("RESET ROLE");
      });
    });

    it("contributor, stranger, free admin and the viewer are denied; pipeline has no chat grant", async () => {
      await db.asUser(U.contrib, async (c) => {
        expect(
          (
            await tryQuery(
              c,
              "INSERT INTO public.chat_threads (baby_id, user_id) VALUES ($1, $2)",
              [BABY.paid, U.contrib],
            )
          )?.message,
        ).toMatch(RLS_VIOLATION);
      });
      await db.asUser(U.stranger, async (c) => {
        expect(
          (
            await tryQuery(
              c,
              "INSERT INTO public.chat_threads (baby_id, user_id) VALUES ($1, $2)",
              [BABY.paid, U.stranger],
            )
          )?.message,
        ).toMatch(RLS_VIOLATION);
      });
      await db.asUser(U.adminFree, async (c) => {
        expect(
          (
            await tryQuery(
              c,
              "INSERT INTO public.chat_threads (baby_id, user_id) VALUES ($1, $2)",
              [BABY.free, U.adminFree],
            )
          )?.message,
        ).toMatch(RLS_VIOLATION);
      });
      await db.asViewer(LINK, async (c) => {
        for (const t of ["chat_threads", "chat_messages", "chat_turns"]) {
          expect((await tryQuery(c, `SELECT 1 FROM public.${t}`))?.message, t).toMatch(
            PERMISSION_DENIED,
          );
        }
      });
      await db.asPipeline(async (c) => {
        for (const t of ["chat_threads", "chat_messages", "chat_turns"]) {
          expect((await tryQuery(c, `SELECT 1 FROM public.${t}`))?.message, t).toMatch(
            PERMISSION_DENIED,
          );
        }
        expect((await tryQuery(c, "SELECT * FROM public.chat_reserve_turn(5)"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await tryQuery(c, "SELECT public.chat_user_turns_24h()"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
    });

    it("chat_turns is deny-all for authenticated (no grant, no policy)", async () => {
      await db.asUser(U.admin, async (c) => {
        expect((await tryQuery(c, "SELECT 1 FROM public.chat_turns"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect(
          (
            await tryQuery(
              c,
              "INSERT INTO public.chat_turns (user_id, reserved_xid) VALUES ($1, pg_current_xact_id())",
              [U.admin],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("the viewer cannot call the new functions", async () => {
      await db.asViewer(LINK, async (c) => {
        for (const f of [
          "public.search_baby_ids()",
          "public.chat_user_turns_24h()",
          "public.chat_reserve_turn(5)",
          "public.lower_text_array(ARRAY['A'])",
        ]) {
          expect((await tryQuery(c, `SELECT * FROM ${f}`))?.message, f).toMatch(PERMISSION_DENIED);
        }
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("the 24 h turn ledger", () => {
    const reserve = (c: pg.ClientBase, limit = 100) =>
      c
        .query<{ turns: number; oldest_at: Date | null; allowed: boolean }>(
          "SELECT * FROM public.chat_reserve_turn($1)",
          [limit],
        )
        .then((r) => r.rows[0] as { turns: number; oldest_at: Date | null; allowed: boolean });
    const userMsg = (c: pg.ClientBase, thread: string, baby = BABY.paid, user = U.admin) =>
      c.query(
        "INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'user', 'q')",
        [thread, baby, user],
      );
    const used = (uid: string) =>
      db.asUser(
        uid,
        async (c) =>
          (await c.query("SELECT public.chat_user_turns_24h() AS n")).rows[0].n as number,
      );
    const seedTurns = (uid: string, n: number, ago = "1 hour", claimed = true) =>
      q(
        `INSERT INTO public.chat_turns (user_id, reserved_xid, claimed_at, created_at)
         SELECT $1, pg_current_xact_id(), ${claimed ? "now()" : "NULL"}, now() - $3::interval FROM generate_series(1, $2)`,
        [uid, n, ago],
      );
    const threadFor = async (uid = U.admin, baby = BABY.paid) => {
      const id = fid("f", 650 + (uid === U.admin ? 0 : 1) + (baby === BABY.paid ? 0 : 2));
      await q(
        "INSERT INTO public.chat_threads (id, baby_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [id, baby, uid],
      );
      return id;
    };

    async function reset() {
      await q("DELETE FROM public.chat_turns WHERE user_id = ANY($1::uuid[])", [Object.values(U)]);
      await q("DELETE FROM public.chat_threads WHERE baby_id = ANY($1::uuid[])", [
        Object.values(BABY),
      ]);
    }
    beforeAll(reset);
    afterAll(reset);

    it("a user message without a reservation is refused for authenticated; with one it is allowed and counted", async () => {
      await reset();
      const t = await threadFor();
      await db.asUser(U.admin, async (c) => {
        const e = await tryQuery(
          c,
          "INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'user', 'q')",
          [t, BABY.paid, U.admin],
        );
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(TURN_MSG);
      });
      expect(await used(U.admin)).toBe(0);
      await commitAs(U.admin, async (c) => {
        expect(await reserve(c)).toMatchObject({ turns: 0, allowed: true });
        await userMsg(c, t);
      });
      expect(await used(U.admin)).toBe(1);
    });

    it("assistant messages need no reservation and are not counted", async () => {
      await reset();
      const t = await threadFor();
      await commitAs(U.admin, async (c) => {
        await c.query(
          "INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'assistant', 'a')",
          [t, BABY.paid, U.admin],
        );
      });
      expect(await used(U.admin)).toBe(0);
    });

    it("the 101st turn is refused: 100 claimed turns => allowed false, with the oldest turn time", async () => {
      await reset();
      await seedTurns(U.admin, 99, "2 hours");
      await commitAs(U.admin, async (c) => {
        expect(await reserve(c, 100)).toMatchObject({ turns: 99, allowed: true });
      });
      await seedTurns(U.admin, 1, "3 hours");
      await commitAs(U.admin, async (c) => {
        const r = await reserve(c, 100);
        expect(r.turns).toBe(100);
        expect(r.allowed).toBe(false);
        const age = Date.now() - (r.oldest_at as Date).getTime();
        expect(age).toBeGreaterThan(2.9 * 3600_000);
        expect(age).toBeLessThan(3.1 * 3600_000);
        // a refused reservation leaves nothing behind
        const t = await threadFor();
        expect(
          (
            await tryQuery(
              c,
              "INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'user', 'q')",
              [t, BABY.paid, U.admin],
            )
          )?.message,
        ).toMatch(TURN_MSG);
      });
      expect(await used(U.admin)).toBe(100);
    });

    it("turns older than 24 hours are not counted and are pruned by the next reservation", async () => {
      await reset();
      await seedTurns(U.admin, 5, "25 hours");
      await seedTurns(U.admin, 2, "23 hours");
      expect(await used(U.admin)).toBe(2);
      await commitAs(U.admin, async (c) => {
        expect((await reserve(c)).turns).toBe(2);
      });
      expect(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int AS n FROM public.chat_turns WHERE user_id = $1 AND created_at < now() - interval '24 hours'",
            [U.admin],
          )
        ).n,
      ).toBe(0);
    });

    it("an unclaimed reservation is not counted (a refused or failed turn costs nothing)", async () => {
      await reset();
      await seedTurns(U.admin, 99);
      await commitAs(U.admin, async (c) => {
        expect(await reserve(c)).toMatchObject({ turns: 99, allowed: true });
        // commit without inserting a message
      });
      expect(await used(U.admin)).toBe(99);
      await commitAs(U.admin, async (c) => {
        expect(await reserve(c)).toMatchObject({ turns: 99, allowed: true });
      });
    });

    it("clearing the history does not reset the limit", async () => {
      await reset();
      const t = await threadFor();
      for (let i = 0; i < 3; i++) {
        await commitAs(U.admin, async (c) => {
          await reserve(c);
          await userMsg(c, t);
        });
      }
      expect(await used(U.admin)).toBe(3);
      await commitAs(U.admin, async (c) => {
        await c.query("DELETE FROM public.chat_threads WHERE id = $1", [t]);
      });
      expect(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int AS n FROM public.chat_messages WHERE user_id = $1",
            [U.admin],
          )
        ).n,
      ).toBe(0);
      expect(await used(U.admin)).toBe(3);
    });

    it("counts across babies and keeps counting after the membership is removed", async () => {
      await reset();
      // a second baby the admin administers
      const t1 = await threadFor();
      const extra = fid("f", 15);
      await q(
        "INSERT INTO public.babies (id, name, birth_date, plan) VALUES ($1, 'Extra', '2025-06-30', 'plus')",
        [extra],
      );
      await q("INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')", [
        extra,
        U.admin,
      ]);
      await q("INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')", [
        extra,
        U.admin2,
      ]);
      try {
        const t2 = await threadFor(U.admin, extra);
        await commitAs(U.admin, async (c) => {
          await reserve(c);
          await userMsg(c, t1);
        });
        await commitAs(U.admin, async (c) => {
          await reserve(c);
          await userMsg(c, t2, extra);
        });
        expect(await used(U.admin)).toBe(2);
        await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [
          extra,
          U.admin,
        ]);
        expect(await used(U.admin)).toBe(2);
      } finally {
        await q("DELETE FROM public.babies WHERE id = $1", [extra]);
      }
      // the other user's counter is separate
      expect(await used(U.admin2)).toBe(0);
    });

    it("chat_user_turns_24h is 0 without authenticated claims", async () => {
      await db.asRole("authenticated", null, async (c) => {
        expect((await c.query("SELECT public.chat_user_turns_24h() AS n")).rows[0].n).toBe(0);
      });
    });

    it("chat_reserve_turn needs claims and a positive limit", async () => {
      await db.asRole("authenticated", null, async (c) => {
        expect((await tryQuery(c, "SELECT * FROM public.chat_reserve_turn(5)"))?.code).toBe(
          "42501",
        );
      });
      await db.asUser(U.admin, async (c) => {
        expect((await tryQuery(c, "SELECT * FROM public.chat_reserve_turn(0)"))?.code).toBe(
          "23514",
        );
        expect((await tryQuery(c, "SELECT * FROM public.chat_reserve_turn(NULL)"))?.code).toBe(
          "23514",
        );
      });
    });

    it("two concurrent turns at 99: exactly one is allowed", async () => {
      await reset();
      await seedTurns(U.admin, 99);
      const t = await threadFor();
      const open = async () => {
        const c = await db.apiPool.connect();
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(authed(U.admin)),
        ]);
        return c;
      };
      const c1 = await open();
      const c2 = await open();
      try {
        const first = await reserve(c1);
        expect(first.allowed).toBe(true);
        let secondDone = false;
        const second = reserve(c2).then((r) => {
          secondDone = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 300));
        // the second turn waits on the per-user advisory lock until the first transaction ends
        expect(secondDone).toBe(false);
        await userMsg(c1, t);
        await c1.query("COMMIT");
        const r2 = await second;
        expect(r2.turns).toBe(100);
        expect(r2.allowed).toBe(false);
      } finally {
        await c1.query("ROLLBACK").catch(() => undefined);
        await c2.query("ROLLBACK").catch(() => undefined);
        c1.release();
        c2.release();
      }
      expect(await used(U.admin)).toBe(100);
    });

    it("service_role and the superuser insert uncounted-by-reservation messages that are still counted", async () => {
      await reset();
      const t = await threadFor();
      await q(
        "INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'user', 'fixture')",
        [t, BABY.paid, U.admin],
      );
      expect(await used(U.admin)).toBe(1);
    });
  });
});
