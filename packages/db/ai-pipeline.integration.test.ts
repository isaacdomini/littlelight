import { afterAll, beforeAll, describe, expect, it } from "vitest";
// packages/db has no dependency on @tinyglow/shared: relative import on purpose.
import { aiDescriptionV1Schema } from "../shared/src/ai-description";
import { DEMO, seed } from "./src/index";
import {
  connect,
  type Db,
  databaseUrl,
  ensureMigrated,
  env,
  fid,
  PERMISSION_DENIED,
  tryQuery,
} from "./test/harness";

// Step 6 database rules (docs/plans/step-6.md 2.3, 2.11; packages/db/README.md "AI pipeline"):
// ai_batch_items RLS and grants, ai_eligible_photos matrix, the three paid-tier tripwires,
// override shape, month cost, record_ai_budget_exceeded. A small committed world with ids in a
// private range (`fa...`); everything else runs in rolled-back transactions.

const U = {
  admin: fid("a", 1),
  contrib: fid("a", 2),
  stranger: fid("a", 3),
  adminB: fid("a", 4),
};
const BABY = {
  paid: fid("b", 1),
  paid2: fid("b", 2),
  free: fid("b", 3),
  expired: fid("b", 4),
  deleted: fid("b", 5),
};
const BATCH = fid("c", 1);
const BATCH2 = fid("c", 2);
const LINK = fid("d", 1);

const PH = {
  ok: fid("e", 1),
  noAnalysis: fid("e", 2),
  pending: fid("e", 3),
  trashed: fid("e", 4),
  quarantined: fid("e", 5),
  uploaded: fid("e", 6),
  readyDescribed: fid("e", 7),
  ingestedDescribed: fid("e", 8),
  inflight: fid("e", 9),
  failed1: fid("e", 10),
  failed2: fid("e", 11),
  failed2OtherVersion: fid("e", 12),
  newest: fid("e", 13),
  pendingOfAdmin: fid("e", 14),
  paid2Ok: fid("e", 15),
  freeOk: fid("e", 16),
  expiredOk: fid("e", 17),
  deletedOk: fid("e", 18),
};
const ALL_PHOTOS = Object.values(PH);

describe.skipIf(!databaseUrl)("AI pipeline database rules (step 6)", () => {
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

  async function cleanup() {
    await q("DELETE FROM public.audit_log WHERE baby_id = ANY($1::uuid[])", [Object.values(BABY)]);
    await q("DELETE FROM public.ai_batches WHERE id = ANY($1::uuid[])", [[BATCH, BATCH2]]);
    await q("DELETE FROM public.babies WHERE id = ANY($1::uuid[])", [Object.values(BABY)]);
    await q("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [Object.values(U)]);
  }

  const descJson = JSON.stringify({ caption: "x" });

  async function addPhoto(
    id: string,
    baby: string,
    opts: {
      status?: string;
      approval?: string;
      trashed?: boolean;
      quarantined?: boolean;
      analysis?: boolean;
      by?: string;
      createdAt?: string;
    } = {},
  ) {
    const approval = opts.approval ?? "approved";
    await q(
      `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, sha256, width, height, bytes, mime,
          status, approval, approved_by, approved_at, deleted_at, quarantined_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, decode(md5($1::text) || md5($1::text || 'x'), 'hex'), 100, 100, 100, 'image/jpeg',
          $5, $6, $7::uuid, $8::timestamptz, $9::timestamptz, $10::timestamptz, COALESCE($11::timestamptz, now()))`,
      [
        id,
        baby,
        opts.by ?? U.admin,
        `ai-fx/${id}/original.jpg`,
        opts.status ?? "ingested",
        approval,
        approval === "approved" ? (opts.by ?? U.admin) : null,
        approval === "approved" ? new Date() : null,
        opts.trashed ? new Date() : null,
        opts.quarantined ? new Date() : null,
        opts.createdAt ?? null,
      ],
    );
    const kinds = opts.analysis === false ? ["thumb"] : ["thumb", "display", "analysis"];
    for (const kind of kinds) {
      await q(
        `INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
         VALUES ($1, $2, $3, 10, 10, 10)`,
        [id, kind, `ai-fx/${id}/${kind}.jpg`],
      );
    }
  }

  async function addItem(
    batch: string,
    photo: string,
    baby: string,
    over: {
      attempt?: number;
      state?: string;
      failure?: string | null;
      prompt?: string;
      schema?: string;
      createdAt?: string;
      cost?: number | null;
    } = {},
  ) {
    await q(
      `INSERT INTO public.ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, state, failure_kind, cost_usd, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()))`,
      [
        batch,
        photo,
        baby,
        over.attempt ?? 1,
        over.prompt ?? "v1",
        over.schema ?? "v1",
        over.state ?? "succeeded",
        over.failure ?? null,
        over.cost ?? null,
        over.createdAt ?? null,
      ],
    );
  }

  async function addAi(photo: string, prompt = "v1", schema = "v1") {
    await q(
      `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description)
       VALUES ($1, 'gpt-6-luna', $2, $3, $4::jsonb)`,
      [photo, prompt, schema, descJson],
    );
  }

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await q("ROLLBACK").catch(() => undefined);
    await cleanup();
    await q("BEGIN");
    for (const [k, id] of Object.entries(U)) {
      await q(
        "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
        [id, `ai-fx-${k}@tinyglow.test`],
      );
      await q("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, $2)", [id, k]);
    }
    await q(
      `INSERT INTO public.babies (id, name, birth_date, plan, entitlement_expires_at, deleted_at) VALUES
        ($1, 'Paid', '2025-06-30', 'plus', NULL, NULL),
        ($2, 'Paid2', '2025-06-30', 'plus', NULL, NULL),
        ($3, 'Free', '2025-06-30', 'free', NULL, NULL),
        ($4, 'Expired', '2025-06-30', 'plus', now() - interval '1 day', NULL),
        ($5, 'Deleted', '2025-06-30', 'plus', NULL, now() - interval '1 day')`,
      [BABY.paid, BABY.paid2, BABY.free, BABY.expired, BABY.deleted],
    );
    // One family per parent (step 11): U.admin administers `paid` and `free`, so they share a family.
    await q(
      "UPDATE public.babies SET family_id = (SELECT family_id FROM public.babies WHERE id = $1) WHERE id = $2",
      [BABY.paid, BABY.free],
    );
    await q(
      "DELETE FROM public.families f WHERE NOT EXISTS (SELECT 1 FROM public.babies b WHERE b.family_id = f.id)",
    );
    for (const [b, u, role] of [
      [BABY.paid, U.admin, "admin"],
      [BABY.paid, U.contrib, "contributor"],
      [BABY.paid2, U.adminB, "admin"],
      [BABY.free, U.admin, "admin"],
    ] as const) {
      await q("INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1,$2,$3)", [
        b,
        u,
        role,
      ]);
    }
    await q(
      "INSERT INTO public.ai_batches (id, provider, model) VALUES ($1,'fake','gpt-6-luna'),($2,'fake','gpt-6-luna')",
      [BATCH, BATCH2],
    );
    // Oldest first, one minute apart, so ordering is checkable.
    const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
    await addPhoto(PH.ok, BABY.paid, { createdAt: t(1) });
    await addPhoto(PH.noAnalysis, BABY.paid, { analysis: false, createdAt: t(2) });
    await addPhoto(PH.pending, BABY.paid, {
      approval: "pending",
      by: U.contrib,
      createdAt: t(3),
    });
    await addPhoto(PH.trashed, BABY.paid, { trashed: true, createdAt: t(4) });
    await addPhoto(PH.quarantined, BABY.paid, { quarantined: true, createdAt: t(5) });
    await addPhoto(PH.uploaded, BABY.paid, { status: "uploaded", createdAt: t(6) });
    await addPhoto(PH.readyDescribed, BABY.paid, { status: "ready", createdAt: t(7) });
    await addAi(PH.readyDescribed);
    await addPhoto(PH.ingestedDescribed, BABY.paid, { createdAt: t(8) });
    await addAi(PH.ingestedDescribed);
    await addPhoto(PH.inflight, BABY.paid, { createdAt: t(9) });
    await addItem(BATCH, PH.inflight, BABY.paid, { state: "pending" });
    await addPhoto(PH.failed1, BABY.paid, { createdAt: t(10) });
    await addItem(BATCH, PH.failed1, BABY.paid, { state: "failed", failure: "invalid_output" });
    await addPhoto(PH.failed2, BABY.paid, { createdAt: t(11) });
    await addItem(BATCH, PH.failed2, BABY.paid, {
      state: "failed",
      failure: "invalid_output",
      createdAt: t(100),
    });
    await addItem(BATCH2, PH.failed2, BABY.paid, {
      attempt: 2,
      state: "failed",
      failure: "refusal",
      createdAt: t(101),
    });
    await addPhoto(PH.failed2OtherVersion, BABY.paid, { createdAt: t(12) });
    for (const [b, a] of [
      [BATCH, 1],
      [BATCH2, 2],
    ] as const) {
      await addItem(b, PH.failed2OtherVersion, BABY.paid, {
        attempt: a,
        state: "failed",
        failure: "expired",
        prompt: "v0",
        createdAt: t(100),
      });
    }
    await addPhoto(PH.newest, BABY.paid, { createdAt: t(13) });
    await addPhoto(PH.pendingOfAdmin, BABY.paid, { createdAt: t(14) });
    await addItem(BATCH, PH.pendingOfAdmin, BABY.paid, { state: "succeeded", cost: 0.0001385 });
    // visible to admins, hidden from the contributor (pending, uploaded by the admin)
    await q(
      "UPDATE public.photos SET approval = 'pending', approved_by = NULL, approved_at = NULL WHERE id = $1",
      [PH.pendingOfAdmin],
    );
    await addPhoto(PH.paid2Ok, BABY.paid2, { by: U.adminB, createdAt: t(15) });
    await addPhoto(PH.freeOk, BABY.free, { createdAt: t(16) });
    await addPhoto(PH.expiredOk, BABY.expired, { createdAt: t(17) });
    await addPhoto(PH.deletedOk, BABY.deleted, { createdAt: t(18) });
    await q(
      `INSERT INTO public.share_links (id, baby_id, name, token_hash, passcode_hash, expires_at, created_by)
       VALUES ($1, $2, 'ai-fx', decode(md5('aifx') || md5('aifxx'), 'hex'), 'scrypt$x', now() + interval '1 hour', $3)`,
      [LINK, BABY.paid, U.admin],
    );
    await q("COMMIT");
  });

  afterAll(async () => {
    if (db) {
      await cleanup();
      await db.close();
    }
  });

  // ---------------------------------------------------------------------------------------------
  describe("ai_batch_items RLS and grants", () => {
    const count = async (c: import("pg").PoolClient) =>
      Number(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM public.ai_batch_items WHERE baby_id = ANY($1::uuid[])",
            [Object.values(BABY)],
          )
        ).rows[0].n,
      );

    it("is ENABLEd and FORCEd", async () => {
      const r = await one<{ rls: boolean; force: boolean }>(
        "SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE oid = 'public.ai_batch_items'::regclass",
      );
      expect(r).toEqual({ rls: true, force: true });
    });

    it("a stranger sees 0 rows", async () => {
      await db.asUser(U.stranger, async (c) => {
        expect(await count(c)).toBe(0);
      });
    });

    it("an admin sees the items of its babies' visible photos; a contributor does not see an item of a photo it cannot see", async () => {
      await db.asUser(U.admin, async (c) => {
        const ids = (
          await c.query("SELECT photo_id FROM public.ai_batch_items WHERE baby_id = $1", [
            BABY.paid,
          ])
        ).rows.map((r) => r.photo_id);
        expect(ids).toContain(PH.pendingOfAdmin);
        expect(ids).toContain(PH.inflight);
      });
      await db.asUser(U.contrib, async (c) => {
        const ids = (
          await c.query("SELECT photo_id FROM public.ai_batch_items WHERE baby_id = $1", [
            BABY.paid,
          ])
        ).rows.map((r) => r.photo_id);
        expect(ids).toContain(PH.inflight);
        expect(ids).not.toContain(PH.pendingOfAdmin);
      });
    });

    it("another baby's admin does not see baby A's items", async () => {
      await db.asUser(U.adminB, async (c) => {
        expect(await count(c)).toBe(0);
      });
    });

    it("authenticated cannot INSERT / UPDATE / DELETE, not even an admin", async () => {
      await db.asUser(U.admin, async (c) => {
        expect(
          (
            await tryQuery(
              c,
              "INSERT INTO public.ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version) VALUES ($1,$2,$3,1,'v1','v1')",
              [BATCH, PH.ok, BABY.paid],
            )
          )?.code,
        ).toBe("42501");
        expect((await tryQuery(c, "UPDATE public.ai_batch_items SET state = 'failed'"))?.code).toBe(
          "42501",
        );
        expect((await tryQuery(c, "DELETE FROM public.ai_batch_items"))?.code).toBe("42501");
      });
    });

    it("authenticated cannot read the token columns, only state and cost", async () => {
      await db.asUser(U.admin, async (c) => {
        for (const col of [
          "input_tokens",
          "cached_input_tokens",
          "output_tokens",
          "reasoning_tokens",
          "image_tokens",
        ]) {
          const e = await tryQuery(c, `SELECT ${col} FROM public.ai_batch_items`);
          expect(e?.code, col).toBe("42501");
        }
        expect(
          await tryQuery(
            c,
            "SELECT batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, state, failure_kind, cost_usd, created_at, updated_at FROM public.ai_batch_items",
          ),
        ).toBeNull();
        expect((await tryQuery(c, "SELECT * FROM public.ai_batch_items"))?.code).toBe("42501");
      });
    });

    it("a viewer (share link) is denied", async () => {
      await db.asViewer(LINK, async (c) => {
        const e = await tryQuery(c, "SELECT count(*) FROM public.ai_batch_items");
        expect(e?.code).toBe("42501");
        expect(e?.message).toMatch(PERMISSION_DENIED);
      });
    });

    it("pipeline has full access (read, insert for a paid photo, update)", async () => {
      await db.asPipeline(async (c) => {
        expect(await count(c)).toBeGreaterThan(5);
        await c.query(
          "INSERT INTO public.ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, state) VALUES ($1,$2,$3,1,'v1','v1','pending')",
          [BATCH, PH.ok, BABY.paid],
        );
        const u = await c.query(
          "UPDATE public.ai_batch_items SET state = 'submitted', input_tokens = 5 WHERE batch_id = $1 AND photo_id = $2",
          [BATCH, PH.ok],
        );
        expect(u.rowCount).toBe(1);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("ai_batch_items_guard and constraints", () => {
    const insert = (photo: string, baby: string, extra = "") =>
      `INSERT INTO public.ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version${extra ? ", state, failure_kind" : ""})
       VALUES ('${BATCH}', '${photo}', '${baby}', 1, 'v1', 'v1'${extra})`;

    it.each([
      ["a free-tier baby's photo", PH.freeOk, BABY.free],
      ["an expired entitlement", PH.expiredOk, BABY.expired],
      ["a deleted baby", PH.deletedOk, BABY.deleted],
      ["a trashed photo", PH.trashed, BABY.paid],
      ["a quarantined photo", PH.quarantined, BABY.paid],
      ["a pending-approval photo", PH.pending, BABY.paid],
    ])("refuses an item for %s, even as superuser", async (_n, photo, baby) => {
      await sandbox(async () => {
        expect((await tryQuery(db.admin, insert(photo, baby)))?.code).toBe("23514");
      });
    });

    it("refuses a baby_id that is not the photo's baby, and changing keys later", async () => {
      await sandbox(async () => {
        expect((await tryQuery(db.admin, insert(PH.ok, BABY.paid2)))?.code).toBe("23514");
        await q(insert(PH.ok, BABY.paid));
        expect(
          (
            await tryQuery(
              db.admin,
              `UPDATE public.ai_batch_items SET photo_id = '${PH.freeOk}' WHERE batch_id = '${BATCH}' AND photo_id = '${PH.ok}'`,
            )
          )?.code,
        ).toBe("23514");
      });
    });

    it("accepts a paid, approved, live photo; a later downgrade leaves the ledger alone", async () => {
      await sandbox(async () => {
        await q(insert(PH.ok, BABY.paid));
        await q("UPDATE public.babies SET plan = 'free', plan_owner_user_id = NULL WHERE id = $1", [
          BABY.paid,
        ]);
        expect(
          await tryQuery(
            db.admin,
            `UPDATE public.ai_batch_items SET state = 'submitted' WHERE photo_id = '${PH.ok}'`,
          ),
        ).toBeNull();
      });
    });

    it("a failed item needs a failure_kind; a succeeded one must not have one; dropped may", async () => {
      await sandbox(async () => {
        expect((await tryQuery(db.admin, insert(PH.ok, BABY.paid, ", 'failed', NULL")))?.code).toBe(
          "23514",
        );
        expect(
          (await tryQuery(db.admin, insert(PH.ok, BABY.paid, ", 'succeeded', 'refusal'")))?.code,
        ).toBe("23514");
        expect(
          (await tryQuery(db.admin, insert(PH.ok, BABY.paid, ", 'failed', 'made_up'")))?.code,
        ).toBe("23514");
        expect(
          await tryQuery(db.admin, insert(PH.ok, BABY.paid, ", 'dropped', 'budget'")),
        ).toBeNull();
      });
    });

    it("attempt is 1..9 and cost/tokens non-negative", async () => {
      await sandbox(async () => {
        expect(
          (
            await tryQuery(
              db.admin,
              `INSERT INTO public.ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version) VALUES ('${BATCH}','${PH.ok}','${BABY.paid}',0,'v1','v1')`,
            )
          )?.code,
        ).toBe("23514");
        expect(
          (
            await tryQuery(
              db.admin,
              `INSERT INTO public.ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, cost_usd) VALUES ('${BATCH}','${PH.ok}','${BABY.paid}',1,'v1','v1',-1)`,
            )
          )?.code,
        ).toBe("23514");
      });
    });

    it("items cascade from their batch (ai_batches themselves are not cascaded from babies, so tests delete them)", async () => {
      await sandbox(async () => {
        await q(insert(PH.ok, BABY.paid));
        await q("DELETE FROM public.ai_batches WHERE id = $1", [BATCH]);
        const n = await one<{ n: number }>(
          "SELECT count(*)::int AS n FROM public.ai_batch_items WHERE batch_id = $1",
          [BATCH],
        );
        expect(n.n).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("ai_eligible_photos matrix", () => {
    const eligible = async (
      args: {
        limit?: number | null;
        baby?: string | null;
        reprocess?: boolean;
        max?: number;
        prompt?: string;
        schema?: string;
      } = {},
    ) =>
      db.asPipeline(async (c) => {
        const r = await c.query(
          "SELECT id FROM public.ai_eligible_photos($1, $2, $3, $4, $5, $6) AS t(id)",
          [
            args.limit ?? null,
            args.prompt ?? "v1",
            args.schema ?? "v1",
            args.baby ?? null,
            args.reprocess ?? false,
            args.max ?? 2,
          ],
        );
        return r.rows.map((x) => x.id as string);
      });
    const mine = (ids: string[]) => ids.filter((i) => ALL_PHOTOS.includes(i));

    it("regular mode returns exactly the expected paid, live, analysed, undescribed photos, oldest first", async () => {
      expect(mine(await eligible())).toEqual([
        PH.ok,
        PH.failed1,
        PH.failed2OtherVersion,
        PH.newest,
        PH.paid2Ok,
      ]);
    });

    it("never returns free, expired, deleted, pending, trashed, quarantined, uploaded, no-analysis, described or in-flight photos", async () => {
      const ids = new Set(await eligible());
      for (const p of [
        PH.freeOk,
        PH.expiredOk,
        PH.deletedOk,
        PH.pending,
        PH.trashed,
        PH.quarantined,
        PH.uploaded,
        PH.noAnalysis,
        PH.readyDescribed,
        PH.ingestedDescribed,
        PH.inflight,
        PH.failed2,
        PH.pendingOfAdmin,
      ]) {
        expect(ids.has(p), p).toBe(false);
      }
    });

    it("two failed attempts for the current versions exclude the photo; p_max_attempts raises the bar", async () => {
      expect(mine(await eligible({ max: 3 }))).toContain(PH.failed2);
      expect(mine(await eligible({ max: 1 }))).not.toContain(PH.failed1);
      expect(mine(await eligible({ max: 2 }))).not.toContain(PH.failed2);
    });

    it("failures against other versions do not count (two v0 failures, still eligible)", async () => {
      expect(mine(await eligible())).toContain(PH.failed2OtherVersion);
      // ... but they count when those are the current versions
      expect(mine(await eligible({ prompt: "v0" }))).not.toContain(PH.failed2OtherVersion);
    });

    it("an admin retry request resets the count for older failures", async () => {
      await sandbox(async () => {
        await q(
          "UPDATE public.photos SET ai_retry_requested_at = '2026-01-02T00:00:00Z' WHERE id = $1",
          [PH.failed2],
        );
        const r = await q(
          "SELECT id FROM public.ai_eligible_photos(NULL,'v1','v1',NULL,false,2) AS t(id)",
        );
        expect(r.rows.map((x) => x.id)).toContain(PH.failed2);
        // a failure after the retry request counts again
        await q(
          "UPDATE public.photos SET ai_retry_requested_at = '2025-12-31T00:00:00Z' WHERE id = $1",
          [PH.failed2],
        );
        const r2 = await q(
          "SELECT id FROM public.ai_eligible_photos(NULL,'v1','v1',NULL,false,2) AS t(id)",
        );
        expect(r2.rows.map((x) => x.id)).not.toContain(PH.failed2);
      });
    });

    it("p_baby_id narrows to one baby; a free baby id returns nothing", async () => {
      expect(mine(await eligible({ baby: BABY.paid2 }))).toEqual([PH.paid2Ok]);
      expect(await eligible({ baby: BABY.free })).toEqual([]);
      expect(await eligible({ baby: BABY.expired })).toEqual([]);
      expect(await eligible({ baby: BABY.deleted })).toEqual([]);
    });

    it("p_limit caps and keeps the oldest first", async () => {
      const ids = await eligible({ limit: 2 });
      expect(ids).toHaveLength(2);
      const all = await eligible();
      expect(ids).toEqual(all.slice(0, 2));
      expect(await eligible({ limit: 0 })).toEqual([]);
    });

    it("reprocess mode: described photos with other versions, including status ready; same versions excluded", async () => {
      const re = mine(await eligible({ reprocess: true, prompt: "v2" }));
      expect(re).toEqual([PH.readyDescribed, PH.ingestedDescribed]);
      expect(mine(await eligible({ reprocess: true }))).toEqual([]);
      expect(mine(await eligible({ reprocess: true, schema: "v2" }))).toEqual([
        PH.readyDescribed,
        PH.ingestedDescribed,
      ]);
    });

    it("a ready photo is not eligible in regular mode even without photo_ai", async () => {
      await sandbox(async () => {
        await q("UPDATE public.photos SET status = 'ready' WHERE id = $1", [PH.ok]);
        const r = await q(
          "SELECT id FROM public.ai_eligible_photos(NULL,'v1','v1',NULL,false,2) AS t(id)",
        );
        expect(r.rows.map((x) => x.id)).not.toContain(PH.ok);
      });
    });

    it("an in-flight (submitted) item blocks, a dropped item does not", async () => {
      await sandbox(async () => {
        await addItem(BATCH2, PH.newest, BABY.paid, { state: "submitted" });
        const r = await q(
          "SELECT id FROM public.ai_eligible_photos(NULL,'v1','v1',NULL,false,2) AS t(id)",
        );
        expect(r.rows.map((x) => x.id)).not.toContain(PH.newest);
      });
      await sandbox(async () => {
        await addItem(BATCH2, PH.newest, BABY.paid, { state: "dropped" });
        const r = await q(
          "SELECT id FROM public.ai_eligible_photos(NULL,'v1','v1',NULL,false,2) AS t(id)",
        );
        expect(r.rows.map((x) => x.id)).toContain(PH.newest);
      });
    });

    it("an expiring entitlement drops the baby's photos at once", async () => {
      await sandbox(async () => {
        await q(
          "UPDATE public.babies SET entitlement_expires_at = now() - interval '1 second' WHERE id = $1",
          [BABY.paid2],
        );
        const r = await q(
          "SELECT id FROM public.ai_eligible_photos(NULL,'v1','v1',NULL,false,2) AS t(id)",
        );
        expect(r.rows.map((x) => x.id)).not.toContain(PH.paid2Ok);
      });
    });

    it("is executable by pipeline and service_role only", async () => {
      await db.asUser(U.admin, async (c) => {
        expect(
          (
            await tryQuery(
              c,
              "SELECT * FROM public.ai_eligible_photos(NULL,'v1','v1',NULL,false,2)",
            )
          )?.code,
        ).toBe("42501");
      });
      await db.asViewer(LINK, async (c) => {
        expect(
          (
            await tryQuery(
              c,
              "SELECT * FROM public.ai_eligible_photos(NULL,'v1','v1',NULL,false,2)",
            )
          )?.code,
        ).toBe("42501");
      });
      await db.asRole("service_role", null, async (c) => {
        expect(
          (await c.query("SELECT * FROM public.ai_eligible_photos(1,'v1','v1',NULL,false,2)")).rows
            .length,
        ).toBeLessThanOrEqual(1);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("paid-tier tripwires", () => {
    it("photos_status_guard rejects queued/analyzing for a free baby even as pipeline", async () => {
      await db.asPipeline(async (c) => {
        for (const status of ["queued", "analyzing"]) {
          const e = await tryQuery(c, "UPDATE public.photos SET status = $2 WHERE id = $1", [
            PH.freeOk,
            status,
          ]);
          expect(e?.code, status).toBe("23514");
        }
      });
    });
    it("rejects queued for expired entitlement, deleted baby, pending, trashed", async () => {
      await db.asPipeline(async (c) => {
        for (const p of [PH.expiredOk, PH.deletedOk, PH.pending, PH.trashed]) {
          expect(
            (await tryQuery(c, "UPDATE public.photos SET status = 'queued' WHERE id = $1", [p]))
              ?.code,
            p,
          ).toBe("23514");
        }
      });
    });
    it("allows queued for a paid, approved, live photo", async () => {
      await db.asPipeline(async (c) => {
        const r = await c.query("UPDATE public.photos SET status = 'queued' WHERE id = $1", [
          PH.ok,
        ]);
        expect(r.rowCount).toBe(1);
      });
    });

    it("photo_ai INSERT for a free baby is rejected (tripwire), even as superuser", async () => {
      await sandbox(async () => {
        const e = await tryQuery(
          db.admin,
          "INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description) VALUES ($1,'m','v1','v1','{}'::jsonb)",
          [PH.freeOk],
        );
        expect(e?.code).toBe("23514");
        expect(
          (
            await tryQuery(
              db.admin,
              "INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description) VALUES ($1,'m','v1','v1','{}'::jsonb)",
              [PH.expiredOk],
            )
          )?.code,
        ).toBe("23514");
      });
      await db.asPipeline(async (c) => {
        const e = await tryQuery(
          c,
          "INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description) VALUES ($1,'m','v1','v1','{}'::jsonb)",
          [PH.freeOk],
        );
        expect(e?.code).toBe("23514");
      });
    });

    it("photo_ai with {bath} sets is_sensitive and withdraws rule shares but keeps user shares", async () => {
      await sandbox(async () => {
        const L2 = fid("d", 2);
        await q(
          `INSERT INTO public.share_links (id, baby_id, name, token_hash, passcode_hash, expires_at, created_by)
           VALUES ($1, $2, 'ai-fx2', decode(md5('aifx2') || md5('aifx2x'), 'hex'), 'scrypt$x', now() + interval '1 hour', $3)`,
          [L2, BABY.paid, U.admin],
        );
        // Step 8: a rule row needs an analysed photo, so analyse first (no flags), share, then flag.
        await q(
          "INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description) VALUES ($1,'m','v1','v1','{}'::jsonb)",
          [PH.ok],
        );
        await q(
          "INSERT INTO public.shared_photos (share_link_id, photo_id, added_by) VALUES ($1,$2,'rule')",
          [LINK, PH.ok],
        );
        await q(
          "INSERT INTO public.shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ($1,$2,'user',$3)",
          [L2, PH.ok, U.admin],
        );
        await q("UPDATE public.photo_ai SET sensitive_flags = '{bath}' WHERE photo_id = $1", [
          PH.ok,
        ]);
        const p = await one<{ is_sensitive: boolean }>(
          "SELECT is_sensitive FROM public.photos WHERE id = $1",
          [PH.ok],
        );
        expect(p.is_sensitive).toBe(true);
        const shares = (
          await q("SELECT added_by FROM public.shared_photos WHERE photo_id = $1", [PH.ok])
        ).rows.map((r) => r.added_by);
        expect(shares).toEqual(["user"]);
      });
    });

    it("a rule share for an already sensitive photo is refused", async () => {
      await sandbox(async () => {
        await q("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [PH.ok]);
        expect(
          (
            await tryQuery(
              db.admin,
              "INSERT INTO public.shared_photos (share_link_id, photo_id, added_by) VALUES ($1,$2,'rule')",
              [LINK, PH.ok],
            )
          )?.code,
        ).toBe("23514");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("photo_ai_overrides_shape", () => {
    const ins = (field: string, value: unknown) =>
      tryQuery(
        db.admin,
        "INSERT INTO public.photo_ai_overrides (photo_id, field_path, value, edited_by) VALUES ($1,$2,$3::jsonb,$4)",
        [PH.ok, field, JSON.stringify(value), U.admin],
      );

    it.each([
      ["a field outside the overridable set (objects)", "objects", ["x"]],
      ["an empty field path", "", "x"],
      ["a non-string caption", "caption", 42],
      ["a null caption", "caption", null],
      ["an empty caption", "caption", ""],
      ["a 201 char caption", "caption", "x".repeat(201)],
      ["an array caption", "caption", ["x"]],
      ["a 1201 char description", "detailed_description", "x".repeat(1201)],
      ["a string for search_tags", "search_tags", "park"],
      ["an empty tag array", "search_tags", []],
      ["21 tags", "search_tags", Array.from({ length: 21 }, (_, i) => `t${i}`)],
      ["a non-string tag", "search_tags", ["ok", 5]],
      ["an empty tag", "search_tags", ["ok", ""]],
      ["a 61 char tag", "search_tags", ["x".repeat(61)]],
    ])("rejects %s", async (_n, field, value) => {
      await sandbox(async () => {
        const e = await ins(field, value);
        expect(e?.code).toBe("23514");
        // fixed message: never echoes the parent's text
        expect(e?.message).not.toContain("xxxxxxxx");
      });
    });

    it("accepts valid values at the bounds", async () => {
      await sandbox(async () => {
        expect(await ins("caption", "x".repeat(200))).toBeNull();
        expect(await ins("detailed_description", "x".repeat(1200))).toBeNull();
        expect(
          await ins(
            "search_tags",
            Array.from({ length: 20 }, () => "y".repeat(60)),
          ),
        ).toBeNull();
      });
    });

    it("also guards UPDATE of the value", async () => {
      await sandbox(async () => {
        expect(await ins("caption", "ok")).toBeNull();
        expect(
          (
            await tryQuery(
              db.admin,
              "UPDATE public.photo_ai_overrides SET value = '5'::jsonb WHERE photo_id = $1 AND field_path = 'caption'",
              [PH.ok],
            )
          )?.code,
        ).toBe("23514");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("ai_baby_month_cost_usd", () => {
    it("sums only that baby and that UTC month, with exact boundaries", async () => {
      await sandbox(async () => {
        const X = [30, 31, 32, 33, 34].map((n) => fid("e", n));
        for (const [i, x] of X.entries()) {
          await addPhoto(x, i === 4 ? BABY.paid2 : BABY.paid, { by: i === 4 ? U.adminB : U.admin });
        }
        const mk = async (
          photo: string,
          baby: string,
          createdAt: string,
          cost: number,
          batch = BATCH,
        ) => addItem(batch, photo, baby, { createdAt, cost });
        // Baby paid, Aug: first and last instants; Sep (other month); Jul 31 23:59:59.999
        await mk(X[0], BABY.paid, "2026-08-01T00:00:00Z", 0.1);
        await mk(X[1], BABY.paid, "2026-08-31T23:59:59.999Z", 0.2);
        await mk(X[2], BABY.paid, "2026-09-01T00:00:00Z", 0.4);
        await mk(X[3], BABY.paid, "2026-07-31T23:59:59.999Z", 0.8);
        // a different baby in August
        await mk(X[4], BABY.paid2, "2026-08-15T00:00:00Z", 1.6);
        const cost = async (baby: string, month: string) =>
          Number(
            (
              await one<{ c: string }>("SELECT public.ai_baby_month_cost_usd($1, $2::date) AS c", [
                baby,
                month,
              ])
            ).c,
          );
        expect(await cost(BABY.paid, "2026-08-01")).toBeCloseTo(0.3, 8);
        expect(await cost(BABY.paid, "2026-08-31")).toBeCloseTo(0.3, 8);
        expect(await cost(BABY.paid, "2026-09-15")).toBeCloseTo(0.4, 8);
        expect(await cost(BABY.paid, "2026-07-10")).toBeCloseTo(0.8, 8);
        expect(await cost(BABY.paid2, "2026-08-01")).toBeCloseTo(1.6, 8);
        expect(await cost(BABY.paid, "2026-01-01")).toBe(0);
        expect(await cost(BABY.free, "2026-08-01")).toBe(0);
      });
    });

    it("a stranger gets 0 through RLS, a member gets the real sum", async () => {
      // committed item: PH.pendingOfAdmin has cost 0.0001385 created now
      const month = `${new Date().toISOString().slice(0, 7)}-01`;
      await db.asUser(U.stranger, async (c) => {
        const r = await c.query("SELECT public.ai_baby_month_cost_usd($1, $2::date) AS c", [
          BABY.paid,
          month,
        ]);
        expect(Number(r.rows[0].c)).toBe(0);
      });
      await db.asUser(U.admin, async (c) => {
        const r = await c.query("SELECT public.ai_baby_month_cost_usd($1, $2::date) AS c", [
          BABY.paid,
          month,
        ]);
        expect(Number(r.rows[0].c)).toBeGreaterThanOrEqual(0.0001385);
      });
      await db.asViewer(LINK, async (c) => {
        expect(
          (await tryQuery(c, "SELECT public.ai_baby_month_cost_usd($1, now()::date)", [BABY.paid]))
            ?.code,
        ).toBe("42501");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("record_ai_budget_exceeded", () => {
    const MONTH = "2026-10";
    const auditRows = async (baby: string, month = MONTH) =>
      Number(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int AS n FROM public.audit_log WHERE baby_id = $1 AND event = 'ai.budget_exceeded' AND metadata->>'month' = $2",
            [baby, month],
          )
        ).n,
      );
    const wipe = () =>
      q(
        "DELETE FROM public.audit_log WHERE baby_id = ANY($1::uuid[]) AND event = 'ai.budget_exceeded'",
        [Object.values(BABY)],
      );

    afterAll(wipe);

    it("two calls in one pipeline transaction return [true, false] and leave exactly one audit row", async () => {
      await wipe();
      const c = await db.workerPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE pipeline");
        const a = await c.query(
          "SELECT public.record_ai_budget_exceeded($1::uuid, $2::text) AS inserted",
          [BABY.paid, MONTH],
        );
        const b = await c.query(
          "SELECT public.record_ai_budget_exceeded($1::uuid, $2::text) AS inserted",
          [BABY.paid, MONTH],
        );
        expect([a.rows[0].inserted, b.rows[0].inserted]).toEqual([true, false]);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      expect(await auditRows(BABY.paid)).toBe(1);
      const row = await one<{ event: string; actor_user_id: string | null; metadata: unknown }>(
        "SELECT event, actor_user_id, metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'ai.budget_exceeded'",
        [BABY.paid],
      );
      expect(row).toEqual({
        event: "ai.budget_exceeded",
        actor_user_id: null,
        metadata: { month: MONTH },
      });
    });

    it("a service_role call afterwards returns false and adds nothing; another month or baby inserts", async () => {
      await db.asRole("service_role", null, async (c) => {
        const r = await c.query(
          "SELECT public.record_ai_budget_exceeded($1::uuid, $2::text) AS inserted",
          [BABY.paid, MONTH],
        );
        expect(r.rows[0].inserted).toBe(false);
      });
      expect(await auditRows(BABY.paid)).toBe(1);
      await sandbox(async () => {
        expect(
          (
            await one<{ r: boolean }>(
              "SELECT public.record_ai_budget_exceeded($1::uuid, '2026-11') AS r",
              [BABY.paid],
            )
          ).r,
        ).toBe(true);
        expect(
          (
            await one<{ r: boolean }>(
              "SELECT public.record_ai_budget_exceeded($1::uuid, $2::text) AS r",
              [BABY.paid2, MONTH],
            )
          ).r,
        ).toBe(true);
      });
    });

    it("authenticated and viewer cannot execute it", async () => {
      await db.asUser(U.admin, async (c) => {
        expect(
          (
            await tryQuery(c, "SELECT public.record_ai_budget_exceeded($1::uuid, $2::text)", [
              BABY.paid,
              "2026-12",
            ])
          )?.code,
        ).toBe("42501");
      });
      await db.asViewer(LINK, async (c) => {
        expect(
          (
            await tryQuery(c, "SELECT public.record_ai_budget_exceeded($1::uuid, $2::text)", [
              BABY.paid,
              "2026-12",
            ])
          )?.code,
        ).toBe("42501");
      });
      expect(await auditRows(BABY.paid, "2026-12")).toBe(0);
    });

    it("the pipeline still has no SELECT on audit_log (the function is the only path)", async () => {
      await db.asPipeline(async (c) => {
        expect((await tryQuery(c, "SELECT count(*) FROM public.audit_log"))?.code).toBe("42501");
      });
    });

    it("rejects a malformed month or null args with check_violation", async () => {
      await db.asPipeline(async (c) => {
        for (const m of ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "", "'; DROP"]) {
          expect(
            (
              await tryQuery(c, "SELECT public.record_ai_budget_exceeded($1::uuid, $2::text)", [
                BABY.paid,
                m,
              ])
            )?.code,
            m,
          ).toBe("23514");
        }
        expect(
          (await tryQuery(c, "SELECT public.record_ai_budget_exceeded(NULL::uuid, '2026-10')"))
            ?.code,
        ).toBe("23514");
        expect(
          (
            await tryQuery(c, "SELECT public.record_ai_budget_exceeded($1::uuid, NULL)", [
              BABY.paid,
            ])
          )?.code,
        ).toBe("23514");
      });
    });

    it("concurrent callers insert exactly one row", async () => {
      await wipe();
      const run = async () => {
        const c = await db.workerPool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SET LOCAL ROLE pipeline");
          const r = await c.query(
            "SELECT public.record_ai_budget_exceeded($1::uuid, '2026-09') AS inserted",
            [BABY.paid],
          );
          await new Promise((res) => setTimeout(res, 50));
          await c.query("COMMIT");
          return r.rows[0].inserted as boolean;
        } finally {
          c.release();
        }
      };
      const results = await Promise.all([run(), run()]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await auditRows(BABY.paid, "2026-09")).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("seed", () => {
    it("the seeded bath photo_ai validates with the shared schema and has a succeeded item and a completed batch", async () => {
      await seed({ env, databaseUrl, log: () => undefined });
      const row = await one<{ description: unknown; sensitive_flags: string[]; batch_id: string }>(
        "SELECT description, sensitive_flags, batch_id FROM public.photo_ai WHERE photo_id = $1",
        [`00000000-0000-4000-8000-000000000304`],
      );
      const parsed = aiDescriptionV1Schema.safeParse(row.description);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(row.sensitive_flags).toEqual(["bath"]);
      expect(row.batch_id).toBe(DEMO.aiBatch);
      const batch = await one<{ status: string; files_deleted_at: Date | null; cost_usd: string }>(
        "SELECT status, files_deleted_at, cost_usd FROM public.ai_batches WHERE id = $1",
        [DEMO.aiBatch],
      );
      expect(batch.status).toBe("completed");
      expect(batch.files_deleted_at).not.toBeNull();
      expect(Number(batch.cost_usd)).toBeGreaterThan(0);
      const item = await one<{ state: string; baby_id: string }>(
        "SELECT state, baby_id FROM public.ai_batch_items WHERE batch_id = $1",
        [DEMO.aiBatch],
      );
      expect(item).toEqual({ state: "succeeded", baby_id: DEMO.baby });
      const p = await one<{ status: string; is_sensitive: boolean }>(
        "SELECT status, is_sensitive FROM public.photos WHERE id = $1",
        ["00000000-0000-4000-8000-000000000304"],
      );
      expect(p).toEqual({ status: "ready", is_sensitive: true });
    });
  });
});
