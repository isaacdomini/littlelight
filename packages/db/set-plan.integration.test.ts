import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SetPlanArgs, setPlan } from "./src/index";
import { connect, type Db, databaseUrl, ensureMigrated, env, fid } from "./test/harness";

// `pnpm db:plan` against a real database (docs/plans/step-6.md 2.3.8, D7). The tool commits, so
// this file owns a tiny committed world (ids `fc...`) and removes it afterwards.

const OWNER = fid("c", 1);
const NOT_ADMIN = fid("c", 2);
const BABY = fid("c", 3);
const GHOST = fid("c", 4);
const TRASHED = fid("c", 5);

describe.skipIf(!databaseUrl)("db:plan (setPlan)", () => {
  let db: Db;
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const args = (over: Partial<SetPlanArgs> = {}): SetPlanArgs => ({
    babyId: BABY,
    plan: "plus",
    ownerUserId: null,
    expiresAt: null,
    allowProduction: false,
    ...over,
  });
  const run = (a: SetPlanArgs, e: NodeJS.ProcessEnv = env) =>
    setPlan(a, { env: e, databaseUrl: databaseUrl as string, log });
  const baby = async () =>
    (
      await q(
        "SELECT plan, plan_owner_user_id AS owner, entitlement_expires_at AS expires FROM public.babies WHERE id = $1",
        [BABY],
      )
    ).rows[0];
  const audits = async () =>
    (
      await q(
        "SELECT actor_user_id, metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'baby.plan_changed' ORDER BY id",
        [BABY],
      )
    ).rows;

  async function cleanup() {
    await q("DELETE FROM public.audit_log WHERE baby_id = ANY($1::uuid[])", [[BABY, TRASHED]]);
    await q("DELETE FROM public.babies WHERE id = ANY($1::uuid[])", [[BABY, TRASHED]]);
    await q("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [[OWNER, NOT_ADMIN]]);
  }

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await cleanup();
    for (const [id, n] of [
      [OWNER, "owner"],
      [NOT_ADMIN, "contrib"],
    ]) {
      await q(
        "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1,'authenticated','authenticated',$2,now(),now())",
        [id, `plan-${n}@littlelight.test`],
      );
      await q("INSERT INTO public.profiles (user_id, display_name) VALUES ($1,$2)", [id, n]);
    }
    await q(
      "INSERT INTO public.babies (id, name, birth_date, plan) VALUES ($1,'Plan fx','2026-01-01','free')",
      [BABY],
    );
    await q(
      "INSERT INTO public.babies (id, name, birth_date, plan, deleted_at) VALUES ($1,'Trashed','2026-01-01','free', now())",
      [TRASHED],
    );
    await q(
      "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1,$2,'admin'),($1,$3,'contributor')",
      [BABY, OWNER, NOT_ADMIN],
    );
  });
  afterAll(async () => {
    if (db) {
      await cleanup();
      await db.close();
    }
  });

  it("flips free -> plus with a manual grant (no owner) and writes one audit row without a name", async () => {
    const r = await run(args());
    expect(r).toMatchObject({
      babyId: BABY,
      previousPlan: "free",
      plan: "plus",
      ownerUserId: null,
    });
    expect(await baby()).toEqual({ plan: "plus", owner: null, expires: null });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual({ actor_user_id: null, metadata: { plan: "plus" } });
    const out = lines.join("\n");
    expect(out).toContain(BABY);
    expect(out).not.toContain("Plan fx"); // never the baby's name
    expect(out).toContain("ai.backfill");
  });

  it("a manual plus survives babies_plan_follows_owner on a later no-owner call and a member change", async () => {
    await run(args());
    expect((await baby()).plan).toBe("plus");
    await q(
      "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING",
      [BABY, NOT_ADMIN],
    );
    await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [
      BABY,
      NOT_ADMIN,
    ]);
    await q(
      "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1,$2,'contributor')",
      [BABY, NOT_ADMIN],
    );
    expect((await baby()).plan).toBe("plus");
  });

  it("flips plus -> free (clears owner and expiry) and audits again", async () => {
    await run(args({ ownerUserId: OWNER, expiresAt: new Date("2030-01-01T00:00:00Z") }));
    expect(await baby()).toMatchObject({ plan: "plus", owner: OWNER });
    const r = await run(args({ plan: "free" }));
    expect(r.previousPlan).toBe("plus");
    expect(await baby()).toEqual({ plan: "free", owner: null, expires: null });
    const a = await audits();
    expect(a.at(-1)).toEqual({ actor_user_id: null, metadata: { plan: "free" } });
    expect(lines.join("\n")).toContain("AI, search and chat are off");
  });

  it("with --owner records the owner and the target in the audit metadata", async () => {
    await run(args({ ownerUserId: OWNER, expiresAt: new Date("2030-01-01T00:00:00Z") }));
    expect(await baby()).toMatchObject({ plan: "plus", owner: OWNER });
    expect((await audits()).at(-1)?.metadata).toEqual({ plan: "plus", target_user_id: OWNER });
    await run(args({ plan: "free" }));
  });

  it("the owner must be an admin of the baby: a contributor or a stranger is refused and nothing changes", async () => {
    await run(args({ plan: "free" }));
    const before = (await audits()).length;
    await expect(run(args({ ownerUserId: NOT_ADMIN }))).rejects.toThrow(/not an admin/);
    await expect(run(args({ ownerUserId: GHOST }))).rejects.toThrow(/not an admin/);
    expect(await baby()).toMatchObject({ plan: "free" });
    expect((await audits()).length).toBe(before);
  });

  it("refuses an unknown baby and a trashed baby", async () => {
    await expect(run(args({ babyId: GHOST }))).rejects.toThrow(/does not exist/);
    await expect(run(args({ babyId: TRASHED }))).rejects.toThrow(/does not exist/);
    const n = await q(
      "SELECT count(*)::int AS n FROM public.audit_log WHERE baby_id = $1 AND event = 'baby.plan_changed'",
      [TRASHED],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("refuses in production without the flag, and applies it with the flag", async () => {
    await run(args({ plan: "free" }));
    await expect(run(args(), { ...env, NODE_ENV: "production" })).rejects.toThrow(/refusing/);
    expect((await baby()).plan).toBe("free");
    await run(args({ allowProduction: true }), { ...env, NODE_ENV: "production" });
    expect((await baby()).plan).toBe("plus");
  });

  it("an error never contains the database password", async () => {
    const bad = (databaseUrl as string).replace(/\/\/([^:]+):([^@]+)@/, "//$1:s3cretpw@");
    const err = await setPlan(args(), { env, databaseUrl: bad, log }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("s3cretpw");
  });
});
