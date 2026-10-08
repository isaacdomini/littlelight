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

// "The plan follows the paying admin" (docs/plans/step-3.md D5, 3.3, 3.10) and the removal-request
// columns (D4). Superuser transactions that always roll back: the triggers fire for every role.

const OWNER = fid("d", 1);
const OTHER = fid("d", 2);
const CONTRIB = fid("d", 3);
const BABY = fid("e", 1);

describe.skipIf(!databaseUrl)("plan follows the paying admin", () => {
  let db: Db;
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

  async function sandbox<T>(fn: () => Promise<T>): Promise<T> {
    await q("BEGIN");
    try {
      return await fn();
    } finally {
      await q("ROLLBACK");
    }
  }

  /** Plus baby owned by OWNER (admin) with a second admin OTHER and a contributor. */
  async function world(opts: { plan?: "plus" | "free"; owner?: string | null } = {}) {
    for (const [id, email] of [
      [OWNER, "plan-owner@littlelight.test"],
      [OTHER, "plan-other@littlelight.test"],
      [CONTRIB, "plan-contrib@littlelight.test"],
    ]) {
      await q(
        "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
        [id, email],
      );
      await q("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, $2)", [id, email]);
    }
    await q(
      "INSERT INTO public.babies (id, name, birth_date, plan, plan_owner_user_id, entitlement_expires_at) VALUES ($1, 'Plan', '2026-01-01', $2, $3, CASE WHEN $2 = 'plus' THEN now() + interval '30 days' END)",
      [BABY, opts.plan ?? "plus", opts.owner === undefined ? OWNER : opts.owner],
    );
    for (const [u, role] of [
      [OWNER, "admin"],
      [OTHER, "admin"],
      [CONTRIB, "contributor"],
    ]) {
      await q("INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, $3)", [
        BABY,
        u,
        role,
      ]);
    }
  }
  const baby = async () =>
    (
      await q(
        "SELECT plan, plan_owner_user_id AS owner, entitlement_expires_at AS expires FROM public.babies WHERE id = $1",
        [BABY],
      )
    ).rows[0];
  const FREE = { plan: "free", owner: null, expires: null };

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
  });
  afterAll(async () => {
    await db?.close();
  });

  it("the owner's membership deleted -> free, owner and entitlement cleared", async () => {
    await sandbox(async () => {
      await world();
      expect((await baby()).plan).toBe("plus");
      await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [BABY, OWNER]);
      expect(await baby()).toEqual(FREE);
    });
  });

  it("the owner's auth.users row deleted (account deletion cascade) -> free", async () => {
    await sandbox(async () => {
      await world();
      await q("DELETE FROM auth.users WHERE id = $1", [OWNER]);
      expect(await baby()).toEqual(FREE);
      // The other admin keeps the album and its members.
      const members = await q(
        "SELECT user_id FROM public.baby_members WHERE baby_id = $1 ORDER BY user_id",
        [BABY],
      );
      expect(members.rows.map((r) => r.user_id)).toEqual([OTHER, CONTRIB]);
    });
  });

  it("owner demotion admin -> contributor (UPDATE OF role) -> free", async () => {
    await sandbox(async () => {
      await world();
      await q(
        "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
        [BABY, OWNER],
      );
      expect(await baby()).toEqual(FREE);
    });
  });

  it("the same demotion through the authenticated role (SECURITY DEFINER reaches babies)", async () => {
    await sandbox(async () => {
      await world();
      await q("COMMIT");
      await q("BEGIN");
      await q("SET LOCAL ROLE authenticated");
      await q("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: OWNER, role: "authenticated", aud: "authenticated" }),
      ]);
      await q(
        "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
        [BABY, OWNER],
      );
      await q("RESET ROLE");
      expect(await baby()).toEqual(FREE);
      // Committed above to get a clean authenticated tx: undo by hand.
      await q("COMMIT");
      await q("DELETE FROM public.babies WHERE id = $1", [BABY]);
      await q("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [[OWNER, OTHER, CONTRIB]]);
      await q("BEGIN");
    });
  });

  it("a non-owner admin or contributor leaving leaves the plan alone", async () => {
    await sandbox(async () => {
      await world();
      await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [BABY, OTHER]);
      await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [
        BABY,
        CONTRIB,
      ]);
      const b = await baby();
      expect(b.plan).toBe("plus");
      expect(b.owner).toBe(OWNER);
      expect(b.expires).not.toBeNull();
    });
  });

  it("a non-owner admin demoted leaves the plan alone; promotion and no-op role writes too", async () => {
    await sandbox(async () => {
      await world();
      await q(
        "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
        [BABY, OTHER],
      );
      await q("UPDATE public.baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2", [
        BABY,
        OTHER,
      ]);
      await q("UPDATE public.baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2", [
        BABY,
        OWNER,
      ]);
      const b = await baby();
      expect(b).toMatchObject({ plan: "plus", owner: OWNER });
    });
  });

  it("owner reassignment keeps plus (owner -> other admin)", async () => {
    await sandbox(async () => {
      await world();
      await q("UPDATE public.babies SET plan_owner_user_id = $2 WHERE id = $1", [BABY, OTHER]);
      const b = await baby();
      expect(b).toMatchObject({ plan: "plus", owner: OTHER });
      expect(b.expires).not.toBeNull();
    });
  });

  it("clearing the owner directly (billing) also reverts to free", async () => {
    await sandbox(async () => {
      await world();
      await q("UPDATE public.babies SET plan_owner_user_id = NULL WHERE id = $1", [BABY]);
      expect(await baby()).toEqual(FREE);
    });
  });

  it("a plus plan that never had an owner (manual grant) is untouched by member changes", async () => {
    await sandbox(async () => {
      await world({ owner: null });
      await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [BABY, OWNER]);
      await q(
        "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
        [BABY, CONTRIB],
      );
      await q("UPDATE public.babies SET name = 'Renamed' WHERE id = $1", [BABY]);
      expect(await baby()).toMatchObject({ plan: "plus", owner: null });
    });
  });

  it("a free baby stays free when its (non-)owner changes", async () => {
    await sandbox(async () => {
      await world({ plan: "free", owner: OWNER });
      await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [BABY, OWNER]);
      expect(await baby()).toMatchObject({ plan: "free", owner: null });
    });
  });

  it("after the revert, paid-only gating is off (baby_ai_enabled is false)", async () => {
    await sandbox(async () => {
      await world();
      expect((await q("SELECT public.baby_ai_enabled($1) AS on", [BABY])).rows[0].on).toBe(true);
      await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [BABY, OWNER]);
      expect((await q("SELECT public.baby_ai_enabled($1) AS on", [BABY])).rows[0].on).toBe(false);
    });
  });
});

describe.skipIf(!databaseUrl)("co-admin removal request columns", () => {
  let db: Db;
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
  const RBABY = fid("e", 2);
  const REQUESTER = fid("d", 11);
  const TARGET = fid("d", 12);

  async function clean() {
    await q("DELETE FROM public.babies WHERE id = $1", [RBABY]);
    await q("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [[REQUESTER, TARGET]]);
  }

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await clean();
    for (const [id, email] of [
      [REQUESTER, "rm-requester@littlelight.test"],
      [TARGET, "rm-target@littlelight.test"],
    ]) {
      await q(
        "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
        [id, email],
      );
      await q("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, $2)", [id, email]);
    }
    await q(
      "INSERT INTO public.babies (id, name, birth_date) VALUES ($1, 'Removal', '2026-01-01')",
      [RBABY],
    );
    await q(
      "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')",
      [RBABY, REQUESTER, TARGET],
    );
  });
  afterAll(async () => {
    if (!db) return;
    await clean();
    await db.close();
  });

  it("authenticated admins cannot write the removal columns (not on themselves, not on the other admin)", async () => {
    for (const [actor, target] of [
      [REQUESTER, TARGET],
      [TARGET, TARGET],
      [REQUESTER, REQUESTER],
    ]) {
      const err = await db.asUser(actor, (c) =>
        tryQuery(
          c,
          "UPDATE public.baby_members SET removal_requested_by = $3, removal_requested_at = now() WHERE baby_id = $1 AND user_id = $2",
          [RBABY, target, REQUESTER],
        ),
      );
      expect(err?.message).toMatch(PERMISSION_DENIED);
      const clear = await db.asUser(actor, (c) =>
        tryQuery(
          c,
          "UPDATE public.baby_members SET removal_requested_at = NULL WHERE baby_id = $1",
          [RBABY],
        ),
      );
      expect(clear?.message).toMatch(PERMISSION_DENIED);
    }
  });

  it("authenticated keeps its UPDATE (role) grant: only role is writable", async () => {
    const ok = await db.asUser(REQUESTER, (c) =>
      tryQuery(
        c,
        "UPDATE public.baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
        [RBABY, REQUESTER],
      ),
    );
    expect(ok).toBeNull();
    const joined = await db.asUser(REQUESTER, (c) =>
      tryQuery(c, "UPDATE public.baby_members SET joined_at = now() WHERE baby_id = $1", [RBABY]),
    );
    expect(joined?.message).toMatch(PERMISSION_DENIED);
  });

  it("members can read a pending request, viewer and pipeline cannot touch the table", async () => {
    await q(
      "UPDATE public.baby_members SET removal_requested_by = $2, removal_requested_at = now() WHERE baby_id = $1 AND user_id = $3",
      [RBABY, REQUESTER, TARGET],
    );
    const seen = await db.asUser(TARGET, (c) =>
      c.query(
        "SELECT removal_requested_by AS by FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [RBABY, TARGET],
      ),
    );
    expect(seen.rows[0].by).toBe(REQUESTER);
    const viewer = await db.asViewer(fid("c", 1), (c) =>
      tryQuery(c, "SELECT removal_requested_by FROM public.baby_members"),
    );
    expect(viewer?.message).toMatch(PERMISSION_DENIED);
    const pipeline = await db.asPipeline((c) =>
      tryQuery(c, "SELECT removal_requested_by FROM public.baby_members"),
    );
    expect(pipeline?.message).toMatch(PERMISSION_DENIED);
  });

  it("service_role can set and clear them", async () => {
    const out = await db.asRole("service_role", null, async (c) => {
      await c.query(
        "UPDATE public.baby_members SET removal_requested_by = $2, removal_requested_at = now() WHERE baby_id = $1 AND user_id = $3",
        [RBABY, REQUESTER, TARGET],
      );
      const set = (
        await c.query(
          "SELECT removal_requested_by AS by FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
          [RBABY, TARGET],
        )
      ).rows[0].by;
      await c.query(
        "UPDATE public.baby_members SET removal_requested_by = NULL, removal_requested_at = NULL WHERE baby_id = $1 AND user_id = $2",
        [RBABY, TARGET],
      );
      const cleared = (
        await c.query(
          "SELECT removal_requested_at AS at FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
          [RBABY, TARGET],
        )
      ).rows[0].at;
      return { set, cleared };
    });
    expect(out).toEqual({ set: REQUESTER, cleared: null });
  });

  it("deleting the requester's account nulls removal_requested_by and keeps the request time", async () => {
    await q(
      "UPDATE public.baby_members SET removal_requested_by = $2, removal_requested_at = now() WHERE baby_id = $1 AND user_id = $3",
      [RBABY, REQUESTER, TARGET],
    );
    await q("DELETE FROM auth.users WHERE id = $1", [REQUESTER]);
    const row = (
      await q(
        "SELECT removal_requested_by AS by, removal_requested_at AS at FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [RBABY, TARGET],
      )
    ).rows[0];
    expect(row.by).toBeNull();
    expect(row.at).toBeInstanceOf(Date);
  });
});
