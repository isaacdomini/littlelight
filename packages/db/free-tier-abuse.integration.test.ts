import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// packages/db has no dependency on @tinyglow/shared: relative imports on purpose.
import { CANONICAL_EMAIL_FIXTURES } from "../shared/src/auth";
import {
  FREE_TIER_PHOTO_LIMIT,
  PENDING_PHOTOS_PER_GUEST_PER_FAMILY,
} from "../shared/src/constants";
import { runMigrations } from "./src/index";
import {
  connect,
  type Db,
  databaseUrl,
  ensureMigrated,
  env,
  PERMISSION_DENIED,
  tryQuery,
} from "./test/harness";

// Migration 21, free-tier abuse safeguards, family model (docs/plans/step-11.md 2.2 A-G, task
// 11.8b; PRD FR-5.8 "The free tier (up to 1,000 photos)", "Roles and permissions", FR-2.7,
// "Invites", "Account deletion and recovery"). Everything here uses its own users and albums
// (committed through the superuser connection, removed in afterAll) so the concurrency cases can
// use several real connections. The email addresses are fake `@tinyglow.test` ones.

const quiet = () => undefined;
const CAP_RE = /free tier photo limit reached/;
const PENDING_RE = /pending photo limit reached/;
const INBOX_RE = /another account for this inbox already has a family/;
const ONE_FAMILY_RE = /user is already a parent in another family/;

describe.skipIf(!databaseUrl)("free-tier abuse safeguards (migration 21, family model)", () => {
  let db: Db;
  const extra: pg.Client[] = [];
  const users: string[] = [];
  const babies: string[] = [];
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
  const scalar = async <T = unknown>(sql: string, params: unknown[] = []): Promise<T> =>
    (await q(sql, params)).rows[0]?.v as T;

  async function client(): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: databaseUrl });
    await c.connect();
    extra.push(c);
    return c;
  }

  let emailSeq = 0;
  const uniq = () =>
    `${Date.now().toString(36)}${(emailSeq++).toString(36)}${randomUUID().slice(0, 6)}`;

  /** auth.users + profile; the profile trigger fills email_canonical. `null` email = no email. */
  async function mkUser(email?: string | null): Promise<string> {
    const id = randomUUID();
    const addr = email === undefined ? `fam-${uniq()}@tinyglow.test` : email;
    await q(
      `INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
       VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())`,
      [id, addr],
    );
    await q("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'fam')", [id]);
    users.push(id);
    return id;
  }

  /** An album via the superuser connection. `creator` => the creator-admin row comes by trigger. */
  async function mkBaby(
    creator: string | null,
    o: { plan?: "free" | "plus"; trashed?: boolean; family?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO public.babies (id, name, birth_date, plan, created_by, deleted_at, family_id)
       VALUES ($1, 'Fam baby', '2025-06-30', $2, $3, ${o.trashed ? "now()" : "NULL"}, $4)`,
      [id, o.plan ?? "free", creator, o.family ?? null],
    );
    babies.push(id);
    return id;
  }

  const familyOf = (baby: string) =>
    scalar<string>("SELECT family_id AS v FROM public.babies WHERE id = $1", [baby]);
  const familyExists = async (family: string) =>
    (await scalar<number>("SELECT count(*)::int AS v FROM public.families WHERE id = $1", [
      family,
    ])) === 1;
  const addMember = (baby: string, user: string, role: "admin" | "contributor") =>
    q("INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, $3)", [
      baby,
      user,
      role,
    ]);

  async function addPhotos(
    baby: string,
    by: string,
    n: number,
    o: { approval?: "approved" | "pending" | "rejected"; trashed?: boolean; status?: string } = {},
  ) {
    const approval = o.approval ?? "approved";
    await q(
      `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, bytes, approval, approved_by, approved_at, status, deleted_at)
       SELECT $1::uuid, $2::uuid, 'fam/' || gen_random_uuid()::text, 10, $3,
              CASE WHEN $3 = 'approved' THEN $2::uuid END, CASE WHEN $3 = 'approved' THEN now() END,
              $4, ${o.trashed ? "now()" : "NULL"}
         FROM generate_series(1, $5)`,
      [baby, by, approval, o.status ?? "ready", n],
    );
  }
  const onePhoto = async (
    baby: string,
    by: string,
    approval: "approved" | "pending" | "rejected" = "approved",
  ) => {
    const id = randomUUID();
    await q(
      `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, approved_by, approved_at, status)
       VALUES ($1, $2, $3, $4, 10, $5, CASE WHEN $5 = 'approved' THEN $3::uuid END, CASE WHEN $5 = 'approved' THEN now() END, 'ready')`,
      [id, baby, by, `fam/${id}`, approval],
    );
    return id;
  };

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
  });
  afterAll(async () => {
    for (const c of extra) await c.end().catch(() => undefined);
    if (db) {
      await q("RESET app.pending_photo_limit").catch(() => undefined);
      await q("DELETE FROM public.family_starts WHERE user_id = ANY($1::uuid[])", [users]).catch(
        () => undefined,
      );
      // Albums first (photos and memberships cascade; babies_release_family drops the families),
      // then the accounts (profiles cascade).
      await q(
        "DELETE FROM public.babies WHERE id = ANY($1::uuid[]) OR created_by = ANY($2::uuid[])",
        [babies, users],
      ).catch(() => undefined);
      await q("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [users]).catch(() => undefined);
      await db.close();
    }
  });

  // -----------------------------------------------------------------------------------------
  describe("babies_set_family", () => {
    it("starts a family for a creator who is a parent nowhere, with a creator-admin row", async () => {
      const u = await mkUser();
      const b = await mkBaby(u);
      const f = await familyOf(b);
      expect(f).toBeTruthy();
      expect(await scalar("SELECT created_by AS v FROM public.families WHERE id = $1", [f])).toBe(
        u,
      );
      const m = await q("SELECT user_id, role FROM public.baby_members WHERE baby_id = $1", [b]);
      expect(m.rows).toEqual([{ user_id: u, role: "admin" }]);
    });

    it("reuses the creator's family for later albums (free or Plus)", async () => {
      const u = await mkUser();
      const b1 = await mkBaby(u);
      const b2 = await mkBaby(u, { plan: "plus" });
      expect(await familyOf(b2)).toBe(await familyOf(b1));
      expect(
        await scalar("SELECT count(*)::int AS v FROM public.families WHERE created_by = $1", [u]),
      ).toBe(1);
    });

    it("a parent of only trashed albums still reuses that family (no trash-cycling)", async () => {
      const u = await mkUser();
      const b1 = await mkBaby(u);
      await q("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [b1]);
      const b2 = await mkBaby(u);
      expect(await familyOf(b2)).toBe(await familyOf(b1));
    });

    it("gives each creator-less album a family of its own; an explicit family is kept", async () => {
      const a = await mkBaby(null);
      const b = await mkBaby(null);
      expect(await familyOf(a)).not.toBe(await familyOf(b));
      const c = await mkBaby(null, { family: await familyOf(a) });
      expect(await familyOf(c)).toBe(await familyOf(a));
    });

    it("an upsert of an existing album keeps its family and creates no orphan family", async () => {
      const u = await mkUser();
      const b = await mkBaby(u);
      const f = await familyOf(b);
      const before = await scalar<number>("SELECT count(*)::int AS v FROM public.families");
      await q(
        `INSERT INTO public.babies (id, name, birth_date, plan, created_by)
         VALUES ($1, 'Renamed', '2025-06-30', 'free', $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [b, u],
      );
      expect(await familyOf(b)).toBe(f);
      expect(await scalar("SELECT name AS v FROM public.babies WHERE id = $1", [b])).toBe(
        "Renamed",
      );
      expect(await scalar<number>("SELECT count(*)::int AS v FROM public.families")).toBe(before);
    });

    it("a multi-row INSERT by one creator makes one family and a creator-admin row for each album", async () => {
      const u = await mkUser();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      babies.push(...ids);
      await q(
        `INSERT INTO public.babies (id, name, birth_date, plan, created_by) VALUES
           ($1, 'T1', '2025-06-30', 'free', $4), ($2, 'T2', '2025-06-30', 'free', $4), ($3, 'T3', '2025-06-30', 'free', $4)`,
        [...ids, u],
      );
      const fams = await q(
        "SELECT DISTINCT family_id FROM public.babies WHERE id = ANY($1::uuid[])",
        [ids],
      );
      expect(fams.rows).toHaveLength(1);
      const members = await q(
        "SELECT baby_id FROM public.baby_members WHERE user_id = $1 AND role = 'admin' AND baby_id = ANY($2::uuid[])",
        [u, ids],
      );
      expect(members.rows).toHaveLength(3);
    });

    it("an account with no email starting two albums at once gets exactly one family", async () => {
      const u = await mkUser(null);
      expect(
        await scalar("SELECT email_canonical AS v FROM public.profiles WHERE user_id = $1", [u]),
      ).toBeNull();
      const [c1, c2] = [await client(), await client()];
      const ids = [randomUUID(), randomUUID()];
      babies.push(...ids);
      const ins = (c: pg.Client, id: string) =>
        c.query(
          "INSERT INTO public.babies (id, name, birth_date, created_by) VALUES ($1, 'Twin', '2025-06-30', $2)",
          [id, u],
        );
      await Promise.all([ins(c1, ids[0] as string), ins(c2, ids[1] as string)]);
      expect(await familyOf(ids[0] as string)).toBe(await familyOf(ids[1] as string));
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS v FROM public.families WHERE created_by = $1",
          [u],
        ),
      ).toBe(1);
    });

    it("a user role cannot write babies.family_id or the families table", async () => {
      const u = await mkUser();
      const b = await mkBaby(u);
      await db.asUser(u, async (c) => {
        const fam = await tryQuery(
          c,
          "INSERT INTO public.babies (name, birth_date, created_by, family_id) VALUES ('x', '2025-06-30', $1, $2)",
          [u, await familyOf(b)],
        );
        expect(fam?.message).toMatch(PERMISSION_DENIED);
        expect(
          (
            await tryQuery(c, "UPDATE public.babies SET family_id = $2 WHERE id = $1", [
              b,
              randomUUID(),
            ])
          )?.message,
        ).toMatch(PERMISSION_DENIED);
        expect((await tryQuery(c, "INSERT INTO public.families DEFAULT VALUES"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await tryQuery(c, "DELETE FROM public.families"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
    });

    it("an authenticated insert lands in the caller's family", async () => {
      const u = await mkUser();
      const first = await mkBaby(u);
      await db.asUser(u, async (c) => {
        const r = await c.query(
          "INSERT INTO public.babies (name, birth_date, created_by) VALUES ('Second', '2025-06-30', $1) RETURNING family_id",
          [u],
        );
        expect(r.rows[0].family_id).toBe(await familyOf(first));
      });
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("inbox arbiter (D-B)", () => {
    it("refuses a second account for the same canonical inbox when the first is a parent", async () => {
      const tag = uniq();
      const holder = await mkUser(`mom.${tag}@gmail.com`);
      const twin = await mkUser(`mom.${tag}+baby@googlemail.com`);
      await mkBaby(holder);
      await expect(mkBaby(twin)).rejects.toThrow(INBOX_RE);
      // Fixed message: no address, id or count.
      const e = await tryQuery(
        db.admin,
        "INSERT INTO public.babies (name, birth_date, created_by) VALUES ('x', '2025-06-30', $1)",
        [twin],
      );
      expect(e?.code).toBe("23514");
      expect(e?.message).not.toContain(tag);
    });

    it("allows it when the first account is only a guest", async () => {
      const tag = uniq();
      const guest = await mkUser(`guest${tag}@gmail.com`);
      const twin = await mkUser(`g.u.e.s.t${tag}+x@gmail.com`);
      const host = await mkUser();
      const hb = await mkBaby(host);
      await addMember(hb, guest, "contributor");
      const b = await mkBaby(twin);
      expect(await familyOf(b)).toBeTruthy();
      expect(await familyOf(b)).not.toBe(await familyOf(hb));
    });

    it("a soft-deleted holder still blocks and is named in the hint; a hard delete releases", async () => {
      const tag = uniq();
      const addr = `gone${tag}@gmail.com`;
      const gone = await mkUser(addr);
      const twin = await mkUser(`gone${tag}+two@gmail.com`);
      const b = await mkBaby(gone, { trashed: true }); // trashed, so the account can be hard-deleted
      await q("UPDATE public.profiles SET deleted_at = now() WHERE user_id = $1", [gone]);
      await expect(mkBaby(twin)).rejects.toThrow(INBOX_RE);
      const canon = await scalar<string>("SELECT public.email_canonical($1) AS v", [addr]);
      expect(
        await scalar("SELECT public.family_holder_email_for_canonical($1) AS v", [canon]),
      ).toBe(addr);
      void b;
      await q("DELETE FROM auth.users WHERE id = $1", [gone]); // hard delete: profile and admin row go
      expect(
        await scalar("SELECT public.family_holder_email_for_canonical($1) AS v", [canon]),
      ).toBeNull();
      await expect(mkBaby(twin)).resolves.toBeTruthy();
    });

    it("two concurrent family starts for one inbox admit exactly one", async () => {
      const tag = uniq();
      const a = await mkUser(`race${tag}@gmail.com`);
      const b = await mkUser(`race${tag}+b@gmail.com`);
      const [c1, c2] = [await client(), await client()];
      const ids = [randomUUID(), randomUUID()];
      babies.push(...ids);
      const ins = (c: pg.Client, id: string, u: string) =>
        c.query(
          "INSERT INTO public.babies (id, name, birth_date, created_by) VALUES ($1, 'R', '2025-06-30', $2)",
          [id, u],
        );
      const res = await Promise.allSettled([
        ins(c1, ids[0] as string, a),
        ins(c2, ids[1] as string, b),
      ]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(String(rejected.reason.message)).toMatch(INBOX_RE);
    });

    it("family_holder_email_for_canonical returns the parent's address, NULL when nobody holds a family", async () => {
      const tag = uniq();
      const addr = `holder${tag}@gmail.com`;
      const holder = await mkUser(addr);
      const canon = await scalar<string>("SELECT public.email_canonical($1) AS v", [addr]);
      expect(
        await scalar("SELECT public.family_holder_email_for_canonical($1) AS v", [canon]),
      ).toBeNull();
      await mkBaby(holder);
      expect(
        await scalar("SELECT public.family_holder_email_for_canonical($1) AS v", [canon]),
      ).toBe(addr);
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("baby_members_one_family", () => {
    it("refuses an admin insert across families, with a fixed message", async () => {
      const a = await mkUser();
      const b = await mkUser();
      await mkBaby(a);
      const bb = await mkBaby(b);
      const err = await tryQuery(
        db.admin,
        "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
        [bb, a],
      );
      expect(err?.code).toBe("23514");
      expect(err?.message).toMatch(ONE_FAMILY_RE);
    });

    it("refuses a promotion across families but allows a contributor row there", async () => {
      const a = await mkUser();
      const b = await mkUser();
      await mkBaby(a);
      const bb = await mkBaby(b);
      await addMember(bb, a, "contributor"); // a guest in B's family: fine
      const err = await tryQuery(
        db.admin,
        "UPDATE public.baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
        [bb, a],
      );
      expect(err?.message).toMatch(ONE_FAMILY_RE);
    });

    it("allows becoming admin of a second album of the same family", async () => {
      const a = await mkUser();
      const b = await mkUser();
      const ba = await mkBaby(a);
      const sib = await mkBaby(a, { plan: "plus" });
      await addMember(ba, b, "admin");
      await addMember(sib, b, "admin");
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS v FROM public.baby_members WHERE user_id = $1 AND role = 'admin'",
          [b],
        ),
      ).toBe(2);
    });

    it("a trashed album still makes its admin a parent of that family", async () => {
      const a = await mkUser();
      const b = await mkUser();
      const ba = await mkBaby(a, { trashed: true });
      const bb = await mkBaby(b);
      expect(await familyOf(ba)).not.toBe(await familyOf(bb));
      const err = await tryQuery(
        db.admin,
        "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
        [bb, a],
      );
      expect(err?.message).toMatch(ONE_FAMILY_RE);
    });

    it("two concurrent admin accepts into different families admit exactly one", async () => {
      const x = await mkUser();
      const o1 = await mkUser();
      const o2 = await mkUser();
      const b1 = await mkBaby(o1);
      const b2 = await mkBaby(o2);
      const [c1, c2] = [await client(), await client()];
      const ins = (c: pg.Client, baby: string) =>
        c.query(
          "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
          [baby, x],
        );
      const res = await Promise.allSettled([ins(c1, b1), ins(c2, b2)]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        String((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message),
      ).toMatch(ONE_FAMILY_RE);
    });

    it("demote, leave and account deletion leave the family intact; created_by goes NULL on founder deletion", async () => {
      const founder = await mkUser();
      const co = await mkUser();
      const b = await mkBaby(founder);
      const f = await familyOf(b);
      await addMember(b, co, "admin");
      // demote the co-parent, then re-promote, then the founder leaves (co is the remaining parent)
      await q(
        "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
        [b, co],
      );
      expect(await familyExists(f)).toBe(true);
      await q("UPDATE public.baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2", [
        b,
        co,
      ]);
      await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [b, founder]);
      expect(await familyExists(f)).toBe(true);
      expect(await scalar("SELECT created_by AS v FROM public.families WHERE id = $1", [f])).toBe(
        founder,
      );
      await q("DELETE FROM auth.users WHERE id = $1", [founder]);
      expect(await familyExists(f)).toBe(true);
      expect(
        await scalar("SELECT created_by AS v FROM public.families WHERE id = $1", [f]),
      ).toBeNull();
      expect(await familyOf(b)).toBe(f);
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("the founder tie (a founder who handed over admin is still bound to the family)", () => {
    /** Founder u of F1 with co-parent c; u is then demoted (or leaves). */
    async function handedOver(how: "demote" | "leave") {
      const u = await mkUser();
      const c = await mkUser();
      const b = await mkBaby(u);
      await addMember(b, c, "admin");
      if (how === "demote")
        await q(
          "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
          [b, u],
        );
      else await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [b, u]);
      return { u, c, b, f: await familyOf(b) };
    }
    const myFamily = (u: string) =>
      db.asUser(
        u,
        async (c) =>
          (await c.query("SELECT public.my_family_id() AS f")).rows[0].f as string | null,
      );

    it("demoted or left: my_family_id is still F1 and a new album joins F1 (no second family)", async () => {
      for (const how of ["demote", "leave"] as const) {
        const { u, f } = await handedOver(how);
        expect(await myFamily(u), how).toBe(f);
        const b2 = await mkBaby(u);
        expect(await familyOf(b2), how).toBe(f);
      }
    });

    it("accepting or being promoted to admin elsewhere is refused; a guest join is fine", async () => {
      const { u } = await handedOver("demote");
      const other = await mkUser();
      const ob = await mkBaby(other);
      const ins = await tryQuery(
        db.admin,
        "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
        [ob, u],
      );
      expect(ins?.message).toMatch(ONE_FAMILY_RE);
      await addMember(ob, u, "contributor");
      const upd = await tryQuery(
        db.admin,
        "UPDATE public.baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
        [ob, u],
      );
      expect(upd?.message).toMatch(ONE_FAMILY_RE);
    });

    it("when every F1 album is trashed the tie ends: the founder is free again", async () => {
      const { u, b, f } = await handedOver("leave");
      expect(await myFamily(u)).toBe(f);
      await q("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [b]);
      expect(await myFamily(u)).toBeNull();
      const other = await mkUser();
      const ob = await mkBaby(other);
      await addMember(ob, u, "admin"); // now allowed
      expect(await myFamily(u)).toBe(await familyOf(ob));
    });

    it("founder account deleted: created_by NULL, the family stays with the co-parent", async () => {
      const { u, c, b, f } = await handedOver("leave");
      await q("DELETE FROM auth.users WHERE id = $1", [u]);
      expect(
        await scalar("SELECT created_by AS v FROM public.families WHERE id = $1", [f]),
      ).toBeNull();
      expect(await familyOf(b)).toBe(f);
      expect(await myFamily(c)).toBe(f);
    });

    it("a founder-only account (no admin row) still holds its inbox", async () => {
      const tag = uniq();
      const addr = `fo.under${tag}@gmail.com`;
      const u = await mkUser(addr);
      const c = await mkUser();
      const b = await mkBaby(u);
      await addMember(b, c, "admin");
      await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [b, u]);
      const canon = await scalar<string>("SELECT public.email_canonical($1) AS v", [addr]);
      expect(
        await scalar("SELECT public.family_holder_email_for_canonical($1) AS v", [canon]),
      ).toBe(addr);
      // a different account whose canonical address equals the founder's is refused
      const same = await mkUser(`fo.under${tag}+again@gmail.com`);
      await expect(mkBaby(same)).rejects.toThrow(INBOX_RE);
    });

    it("babies_family_guard refuses moving an album away when its admin is the founder of a family that keeps a live album", async () => {
      const u = await mkUser();
      const c = await mkUser();
      const b1 = await mkBaby(u);
      const f1 = await familyOf(b1);
      await addMember(b1, c, "admin");
      await q(
        "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
        [b1, u],
      );
      const b2 = await mkBaby(null, { family: f1 });
      await addMember(b2, u, "admin"); // same family: fine
      const other = await mkUser();
      const ob = await mkBaby(other);
      const err = await tryQuery(
        db.admin,
        "UPDATE public.babies SET family_id = $1 WHERE id = $2",
        [await familyOf(ob), b2],
      );
      expect(err?.message).toMatch(ONE_FAMILY_RE);
      expect(await familyOf(b2)).toBe(f1);
    });
  });

  describe("babies_family_guard and babies_release_family", () => {
    it("refuses moving an album to another family while one of its admins is a parent elsewhere", async () => {
      const a = await mkUser();
      const other = await mkUser();
      const b1 = await mkBaby(a);
      const b2 = await mkBaby(a);
      const ob = await mkBaby(other);
      const err = await tryQuery(
        db.admin,
        "UPDATE public.babies SET family_id = $1 WHERE id = $2",
        [await familyOf(ob), b2],
      );
      expect(err?.code).toBe("23514");
      expect(err?.message).toMatch(ONE_FAMILY_RE);
      expect(await familyOf(b2)).toBe(await familyOf(b1));
    });

    it("moving an album whose admins have no other album releases (drops) the emptied family", async () => {
      const a = await mkUser();
      const other = await mkUser();
      const b = await mkBaby(a);
      const oldFamily = await familyOf(b);
      const ob = await mkBaby(other);
      await q("UPDATE public.babies SET family_id = $1 WHERE id = $2", [await familyOf(ob), b]);
      expect(await familyOf(b)).toBe(await familyOf(ob));
      expect(await familyExists(oldFamily)).toBe(false);
    });

    it("a hard delete of the last album drops the family; of a non-last album keeps it", async () => {
      const u = await mkUser();
      const b1 = await mkBaby(u);
      const b2 = await mkBaby(u);
      const f = await familyOf(b1);
      await q("UPDATE public.babies SET deleted_at = now() WHERE id = ANY($1::uuid[])", [[b1, b2]]);
      await q("DELETE FROM public.babies WHERE id = $1", [b1]);
      expect(await familyExists(f)).toBe(true);
      await q("DELETE FROM public.babies WHERE id = $1", [b2]);
      expect(await familyExists(f)).toBe(false);
    });

    it("a concurrent purge of a family's last two albums leaves no family", async () => {
      for (let round = 0; round < 3; round++) {
        const u = await mkUser();
        const b1 = await mkBaby(u);
        const b2 = await mkBaby(u);
        const f = await familyOf(b1);
        await q("UPDATE public.babies SET deleted_at = now() WHERE id = ANY($1::uuid[])", [
          [b1, b2],
        ]);
        const [c1, c2] = [await client(), await client()];
        await Promise.all([
          c1.query("DELETE FROM public.babies WHERE id = $1", [b1]),
          c2.query("DELETE FROM public.babies WHERE id = $1", [b2]),
        ]);
        expect(await familyExists(f)).toBe(false);
      }
    });

    it("the family FK is RESTRICT: a family with albums cannot be deleted", async () => {
      const u = await mkUser();
      const f = await familyOf(await mkBaby(u));
      const err = await tryQuery(db.admin, "DELETE FROM public.families WHERE id = $1", [f]);
      expect(err?.code).toBe("23503");
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("families visibility", () => {
    it("a member of any album (a guest too) sees the family; a stranger does not", async () => {
      const parent = await mkUser();
      const guest = await mkUser();
      const stranger = await mkUser();
      const b = await mkBaby(parent);
      await addMember(b, guest, "contributor");
      const f = await familyOf(b);
      for (const u of [parent, guest]) {
        await db.asUser(u, async (c) => {
          expect(
            (await c.query("SELECT id FROM public.families WHERE id = $1", [f])).rows,
          ).toHaveLength(1);
        });
      }
      await db.asUser(stranger, async (c) => {
        expect(
          (await c.query("SELECT id FROM public.families WHERE id = $1", [f])).rows,
        ).toHaveLength(0);
      });
    });

    it("a parent of only a trashed album still sees the family; a guest of a trashed one does not", async () => {
      const parent = await mkUser();
      const guest = await mkUser();
      const b = await mkBaby(parent, { trashed: true });
      await addMember(b, guest, "contributor");
      const f = await familyOf(b);
      await db.asUser(parent, async (c) => {
        expect(
          (await c.query("SELECT id FROM public.families WHERE id = $1", [f])).rows,
        ).toHaveLength(1);
      });
      await db.asUser(guest, async (c) => {
        expect(
          (await c.query("SELECT id FROM public.families WHERE id = $1", [f])).rows,
        ).toHaveLength(0);
      });
    });

    it("viewer, pipeline and anon have no access to families", async () => {
      for (const role of ["viewer", "pipeline", "anon"])
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
          expect(
            await scalar<boolean>("SELECT has_table_privilege($1, 'public.families', $2) AS v", [
              role,
              p,
            ]),
            `${role} ${p}`,
          ).toBe(false);
    });

    it("my_family_id: the caller's parent family; NULL for a guest-only account", async () => {
      const parent = await mkUser();
      const guest = await mkUser();
      const b = await mkBaby(parent);
      await addMember(b, guest, "contributor");
      await db.asUser(parent, async (c) => {
        expect((await c.query("SELECT public.my_family_id() AS f")).rows[0].f).toBe(
          await familyOf(b),
        );
      });
      await db.asUser(guest, async (c) => {
        expect((await c.query("SELECT public.my_family_id() AS f")).rows[0].f).toBeNull();
      });
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("the 1,000-photo pool (per family, approved only)", () => {
    it("counts approved photos only, across the family's free albums; Plus and trashed albums are outside", async () => {
      const u = await mkUser();
      const free1 = await mkBaby(u);
      const free2 = await mkBaby(u);
      const plus = await mkBaby(u, { plan: "plus" });
      const trashed = await mkBaby(u, { trashed: true });
      const guest = await mkUser();
      await addMember(free1, guest, "contributor");
      await addPhotos(free1, u, 3);
      await addPhotos(free2, u, 2);
      await addPhotos(plus, u, 5);
      await addPhotos(trashed, u, 7);
      await addPhotos(free1, guest, 4, { approval: "pending" });
      await addPhotos(free1, u, 1, { approval: "rejected" });
      await addPhotos(free1, u, 1, { trashed: true });
      await addPhotos(free1, u, 1, { status: "failed" });
      await addPhotos(free1, u, 1, { status: "duplicate" });
      expect(await scalar("SELECT public.free_tier_pool_used($1) AS v", [free1])).toBe(5);
      expect(await scalar("SELECT public.free_tier_pool_used($1) AS v", [free2])).toBe(5);
      expect(await scalar("SELECT public.free_tier_pool_albums($1) AS v", [free2])).toBe(2);
      // another family's photos never count
      const stranger = await mkUser();
      const sb = await mkBaby(stranger);
      await addPhotos(sb, stranger, 9);
      expect(await scalar("SELECT public.free_tier_pool_used($1) AS v", [free1])).toBe(5);
      expect(await scalar("SELECT public.free_tier_pool_used($1) AS v", [sb])).toBe(9);
    });

    it("pool functions answer 0 to a non-member and the full value to a member", async () => {
      const u = await mkUser();
      const b = await mkBaby(u);
      await addPhotos(b, u, 3);
      const stranger = await mkUser();
      await db.asUser(stranger, async (c) => {
        expect(
          (
            await c.query(
              "SELECT public.free_tier_pool_used($1) AS n, public.free_tier_pool_albums($1) AS a",
              [b],
            )
          ).rows[0],
        ).toEqual({ n: 0, a: 0 });
      });
      await db.asUser(u, async (c) => {
        expect(
          (
            await c.query(
              "SELECT public.free_tier_pool_used($1) AS n, public.free_tier_pool_albums($1) AS a",
              [b],
            )
          ).rows[0],
        ).toEqual({ n: 3, a: 1 });
      });
    });

    it("the 1,001st approved photo is refused across two sibling albums, with the stable prefix", async () => {
      expect(FREE_TIER_PHOTO_LIMIT).toBe(1000);
      const u = await mkUser();
      const b1 = await mkBaby(u);
      const b2 = await mkBaby(u);
      await addPhotos(b1, u, 600);
      await addPhotos(b2, u, 399);
      await onePhoto(b2, u); // the 1000th
      const err = await tryQuery(
        db.admin,
        `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval, approved_by) VALUES ($1, $2, 'fam/${randomUUID()}', 'approved', $2)`,
        [b1, u],
      );
      expect(err?.code).toBe("23514");
      expect(err?.message).toMatch(CAP_RE);
    });

    it("a pending upload is not checked at insert; approving at 1000 is refused, and works after a trash", async () => {
      const u = await mkUser();
      const guest = await mkUser();
      const b = await mkBaby(u);
      await addMember(b, guest, "contributor");
      await addPhotos(b, u, 1000);
      const pend = await onePhoto(b, guest, "pending"); // not refused
      const refused = await tryQuery(
        db.admin,
        "UPDATE public.photos SET approval = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
        [pend, u],
      );
      expect(refused?.message).toMatch(CAP_RE);
      expect(await scalar("SELECT approval AS v FROM public.photos WHERE id = $1", [pend])).toBe(
        "pending",
      );
      await q(
        "UPDATE public.photos SET deleted_at = now() WHERE id = (SELECT id FROM public.photos WHERE baby_id = $1 AND approval = 'approved' LIMIT 1)",
        [b],
      );
      await q(
        "UPDATE public.photos SET approval = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
        [pend, u],
      );
      expect(await scalar("SELECT public.free_tier_pool_used($1) AS v", [b])).toBe(1000);
    });

    it("restoring a trashed approved photo at 1000 is refused; restoring a rejected one (to pending) is allowed", async () => {
      const u = await mkUser();
      const guest = await mkUser();
      const b = await mkBaby(u);
      await addMember(b, guest, "contributor");
      await addPhotos(b, u, 999);
      const trashedApproved = await onePhoto(b, u);
      await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [trashedApproved]);
      await onePhoto(b, u); // fills to 1000 again
      const rejected = await onePhoto(b, guest, "rejected");
      await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [rejected]);
      const refused = await tryQuery(
        db.admin,
        "UPDATE public.photos SET deleted_at = NULL WHERE id = $1",
        [trashedApproved],
      );
      expect(refused?.message).toMatch(CAP_RE);
      // a restore of the rejected photo that turns it pending does not touch the pool
      await q("UPDATE public.photos SET deleted_at = NULL, approval = 'pending' WHERE id = $1", [
        rejected,
      ]);
      expect(
        await scalar("SELECT approval AS v FROM public.photos WHERE id = $1", [rejected]),
      ).toBe("pending");
    });

    it("a Plus album is never capped", async () => {
      const u = await mkUser();
      const b = await mkBaby(u, { plan: "plus" });
      await addPhotos(b, u, 1003);
      expect(
        await scalar("SELECT count(*)::int AS v FROM public.photos WHERE baby_id = $1", [b]),
      ).toBe(1003);
    });

    it("concurrent inserts at 999 admit exactly one", async () => {
      const u = await mkUser();
      const b1 = await mkBaby(u);
      const b2 = await mkBaby(u);
      await addPhotos(b1, u, 999);
      const [c1, c2] = [await client(), await client()];
      const ins = (c: pg.Client, baby: string) =>
        c.query(
          `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval, approved_by) VALUES ($1, $2, 'fam/${randomUUID()}', 'approved', $2)`,
          [baby, u],
        );
      const res = await Promise.allSettled([ins(c1, b1), ins(c2, b2)]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        String((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message),
      ).toMatch(CAP_RE);
      expect(await scalar("SELECT public.free_tier_pool_used($1) AS v", [b1])).toBe(1000);
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("the pending cap (per guest per family)", () => {
    it("the default mirrors the shared constant", async () => {
      expect(PENDING_PHOTOS_PER_GUEST_PER_FAMILY).toBe(200);
      expect(await scalar("SELECT public.pending_photo_limit() AS v")).toBe(200);
    });

    it("the 201st pending photo by one guest in one family is refused; another guest and another family are not", async () => {
      const u = await mkUser();
      const guest = await mkUser();
      const guest2 = await mkUser();
      const b = await mkBaby(u);
      const sibling = await mkBaby(u);
      await addMember(b, guest, "contributor");
      await addMember(b, guest2, "contributor");
      await addPhotos(b, guest, 200, { approval: "pending" });
      const err = await tryQuery(
        db.admin,
        `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, 'fam/${randomUUID()}', 'pending')`,
        [b, guest],
      );
      expect(err?.code).toBe("23514");
      expect(err?.message).toMatch(PENDING_RE);
      // the family-wide count includes a sibling album
      await addMember(sibling, guest, "contributor");
      expect(
        (
          await tryQuery(
            db.admin,
            `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, 'fam/${randomUUID()}', 'pending')`,
            [sibling, guest],
          )
        )?.message,
      ).toMatch(PENDING_RE);
      // another guest: unaffected
      await onePhoto(b, guest2, "pending");
      // the same guest in another family: unaffected
      const otherParent = await mkUser();
      const otherBaby = await mkBaby(otherParent);
      await addMember(otherBaby, guest, "contributor");
      await onePhoto(otherBaby, guest, "pending");
      // my_pending_photo_count: the family-wide number for the guest, 0 for a non-member
      await db.asUser(guest, async (c) => {
        expect(
          (await c.query("SELECT public.my_pending_photo_count($1) AS n", [b])).rows[0].n,
        ).toBe(200);
        expect(
          (await c.query("SELECT public.my_pending_photo_count($1) AS n", [otherBaby])).rows[0].n,
        ).toBe(1);
      });
      await db.asUser(await mkUser(), async (c) => {
        expect(
          (await c.query("SELECT public.my_pending_photo_count($1) AS n", [b])).rows[0].n,
        ).toBe(0);
      });
    });

    it("the GUC override is honoured (session scope), and is never below 1", async () => {
      const u = await mkUser();
      const guest = await mkUser();
      const b = await mkBaby(u);
      await addMember(b, guest, "contributor");
      try {
        await q("SET app.pending_photo_limit = '2'");
        expect(await scalar("SELECT public.pending_photo_limit() AS v")).toBe(2);
        await onePhoto(b, guest, "pending");
        await onePhoto(b, guest, "pending");
        const err = await tryQuery(
          db.admin,
          `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, 'fam/${randomUUID()}', 'pending')`,
          [b, guest],
        );
        expect(err?.message).toMatch(PENDING_RE);
        await q("SET app.pending_photo_limit = '0'");
        expect(await scalar("SELECT public.pending_photo_limit() AS v")).toBe(1);
      } finally {
        await q("RESET app.pending_photo_limit");
      }
      expect(await scalar("SELECT public.pending_photo_limit() AS v")).toBe(200);
    });

    it("applies to every plan (a Plus family too) and ignores failed, duplicate, trashed and rejected rows", async () => {
      const u = await mkUser();
      const guest = await mkUser();
      const b = await mkBaby(u, { plan: "plus" });
      await addMember(b, guest, "contributor");
      try {
        await q("SET app.pending_photo_limit = '1'");
        await addPhotos(b, guest, 1, { approval: "pending", status: "failed" });
        await addPhotos(b, guest, 1, { approval: "pending", status: "duplicate" });
        await addPhotos(b, guest, 1, { approval: "pending", trashed: true });
        await addPhotos(b, guest, 1, { approval: "rejected" });
        await onePhoto(b, guest, "pending");
        const err = await tryQuery(
          db.admin,
          `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, 'fam/${randomUUID()}', 'pending')`,
          [b, guest],
        );
        expect(err?.message).toMatch(PENDING_RE);
      } finally {
        await q("RESET app.pending_photo_limit");
      }
    });

    it("restoring a trashed pending photo at the cap is refused; approving a pending one never trips it", async () => {
      const u = await mkUser();
      const guest = await mkUser();
      const b = await mkBaby(u);
      await addMember(b, guest, "contributor");
      try {
        await q("SET app.pending_photo_limit = '2'");
        const first = await onePhoto(b, guest, "pending");
        await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [first]);
        await onePhoto(b, guest, "pending");
        const second = await onePhoto(b, guest, "pending");
        const refused = await tryQuery(
          db.admin,
          "UPDATE public.photos SET deleted_at = NULL WHERE id = $1",
          [first],
        );
        expect(refused?.message).toMatch(PENDING_RE);
        // approving frees a slot and is not itself a pending-cap event
        await q(
          "UPDATE public.photos SET approval = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
          [second, u],
        );
        await q("UPDATE public.photos SET deleted_at = NULL WHERE id = $1", [first]);
      } finally {
        await q("RESET app.pending_photo_limit");
      }
    });

    it("import_book_photo books a guest's item as pending_limit when the cap is reached", async () => {
      const u = await mkUser();
      const guest = await mkUser();
      const b = await mkBaby(u);
      await addMember(b, guest, "contributor");
      await onePhoto(b, guest, "pending");
      const batch = randomUUID();
      const item = randomUUID();
      await q(
        `INSERT INTO public.import_batches (id, baby_id, requested_by, kind, status, provider_session_id, picker_expires_at)
         VALUES ($1, $2, $3, 'google_picker', 'running', 's', now() + interval '20 minutes')`,
        [batch, b, guest],
      );
      await q(
        `INSERT INTO public.import_items (id, batch_id, baby_id, provider_item_id, status, mime_hint, bytes, sha256)
         VALUES ($1, $2, $3, $4, 'downloaded', 'image/jpeg', 10, decode(md5($4) || md5($4 || 'x'), 'hex'))`,
        [item, batch, b, `g-${item}`],
      );
      const outcome = await db.asPipeline(async (c) => {
        await c.query("SELECT set_config('app.pending_photo_limit', '1', true)");
        return (await c.query("SELECT public.import_book_photo($1) AS o", [item])).rows[0].o;
      });
      expect(outcome).toBe("pending_limit");
      expect(
        await scalar("SELECT count(*)::int AS v FROM public.photos WHERE id = $1", [item]),
      ).toBe(0);
      // without the override the same guest books fine
      const booked = await db.asPipeline(
        async (c) => (await c.query("SELECT public.import_book_photo($1) AS o", [item])).rows[0].o,
      );
      expect(booked).toBe("booked");
    });

    it("the three error vocabularies accept pending_limit", async () => {
      for (const [table, con] of [
        ["upload_files", "upload_files_error_check"],
        ["import_sources", "import_sources_last_error_check"],
        ["import_items", "import_items_error_check"],
      ]) {
        const def = await scalar<string>(
          "SELECT pg_get_constraintdef(c.oid) AS v FROM pg_constraint c WHERE c.conname = $1 AND c.conrelid = ('public.' || $2)::regclass",
          [con, table],
        );
        expect(def, con).toContain("pending_limit");
        expect(def, con).toContain("free_tier_limit");
      }
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("family_starts ledger", () => {
    it("is deny-all below service_role", async () => {
      for (const role of ["authenticated", "viewer", "pipeline", "anon"])
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
          expect(
            await scalar<boolean>(
              "SELECT has_table_privilege($1, 'public.family_starts', $2) AS v",
              [role, p],
            ),
            `${role} ${p}`,
          ).toBe(false);
      expect(
        await scalar<boolean>(
          "SELECT has_table_privilege('service_role', 'public.family_starts', 'UPDATE') AS v",
        ),
      ).toBe(false);
      for (const p of ["SELECT", "INSERT", "DELETE"])
        expect(
          await scalar<boolean>(
            "SELECT has_table_privilege('service_role', 'public.family_starts', $1) AS v",
            [p],
          ),
          p,
        ).toBe(true);
      const rls = await q(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'family_starts'",
      );
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const u = await mkUser();
      await db.asUser(u, async (c) => {
        expect((await tryQuery(c, "SELECT * FROM public.family_starts"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
      await db.asViewer(randomUUID(), async (c) => {
        expect((await tryQuery(c, "SELECT * FROM public.family_starts"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
      await db.asPipeline(async (c) => {
        expect((await tryQuery(c, "SELECT * FROM public.family_starts"))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
    });

    it("has no email, IP or user-agent column", async () => {
      const cols = await q(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'family_starts' ORDER BY ordinal_position",
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual([
        "id",
        "family_id",
        "user_id",
        "ip_hash",
        "ip_country",
        "client",
        "plus_tag",
        "dots_folded",
        "created_at",
      ]);
    });

    it("service_role inserts and reads; the CHECKs reject a short hash, a bad country and a bad client", async () => {
      const u = await mkUser();
      const b = await mkBaby(u);
      const f = await familyOf(b);
      const hash = "decode(md5('a') || md5('b'), 'hex')";
      await db.asRole("service_role", null, async (c) => {
        await c.query(
          `INSERT INTO public.family_starts (family_id, user_id, ip_hash, ip_country, client) VALUES ($1, $2, ${hash}, 'US', 'web')`,
          [f, u],
        );
        expect(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM public.family_starts WHERE user_id = $1",
              [u],
            )
          ).rows[0].n,
        ).toBe(1);
        const bad = [
          "decode('00', 'hex'), 'US', 'web'",
          `${hash}, 'usa', 'web'`,
          `${hash}, 'US', 'tablet'`,
        ];
        for (const v of bad) {
          const e = await tryQuery(
            c,
            `INSERT INTO public.family_starts (ip_hash, ip_country, client) VALUES (${v})`,
          );
          expect(e?.code, v).toBe("23514");
        }
      });
    });

    it("service_role may UPDATE family_starts.family_id and nothing else", async () => {
      for (const [col, ok] of [
        ["family_id", true],
        ["ip_hash", false],
        ["user_id", false],
        ["created_at", false],
        ["client", false],
      ] as const)
        expect(
          await scalar<boolean>(
            "SELECT has_column_privilege('service_role', 'public.family_starts', $1, 'UPDATE') AS v",
            [col],
          ),
          col,
        ).toBe(ok);
      const u = await mkUser();
      const f = await familyOf(await mkBaby(u));
      const hash = "decode(md5('r1') || md5('r2'), 'hex')";
      await q(
        `INSERT INTO public.family_starts (user_id, ip_hash, client) VALUES ($1, ${hash}, 'web')`,
        [u],
      );
      await db.asRole("service_role", null, async (c) => {
        const r = await c.query(
          `UPDATE public.family_starts SET family_id = $1 WHERE user_id = $2 AND family_id IS NULL`,
          [f, u],
        );
        expect(r.rowCount).toBe(1);
        expect(
          (
            await tryQuery(
              c,
              "UPDATE public.family_starts SET ip_hash = ip_hash WHERE user_id = $1",
              [u],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
        // release only touches reservations
        const del = await c.query(
          "DELETE FROM public.family_starts WHERE user_id = $1 AND family_id IS NULL",
          [u],
        );
        expect(del.rowCount).toBe(0);
      });
      await q("DELETE FROM public.family_starts WHERE user_id = $1", [u]);
    });

    it("keeps the row (family_id / user_id NULL) after the family is purged and the account deleted", async () => {
      const u = await mkUser();
      const b = await mkBaby(u);
      const f = await familyOf(b);
      await q(
        "INSERT INTO public.family_starts (family_id, user_id, ip_hash, client) VALUES ($1, $2, decode(md5('c') || md5('d'), 'hex'), 'native')",
        [f, u],
      );
      await q("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [b]);
      await q("DELETE FROM public.babies WHERE id = $1", [b]);
      await q("DELETE FROM auth.users WHERE id = $1", [u]);
      const row = await q(
        "SELECT family_id, user_id FROM public.family_starts WHERE ip_hash = decode(md5('c') || md5('d'), 'hex')",
      );
      expect(row.rows).toEqual([{ family_id: null, user_id: null }]);
      await q(
        "DELETE FROM public.family_starts WHERE ip_hash = decode(md5('c') || md5('d'), 'hex')",
      );
    });

    it("family_starts_prune removes rows older than 30 days only, and is callable by service_role and pipeline", async () => {
      const tag = `decode(md5('${uniq()}') || md5('p'), 'hex')`;
      await q(
        `INSERT INTO public.family_starts (ip_hash, client, created_at) VALUES (${tag}, 'web', now() - interval '31 days'), (${tag}, 'web', now() - interval '29 days')`,
      );
      const removed = await db.asPipeline(
        async (c) => (await c.query("SELECT public.family_starts_prune() AS n")).rows[0].n,
      );
      expect(removed).toBeGreaterThanOrEqual(1); // pipeline may call it (rolled back by the harness)
      await q("SELECT public.family_starts_prune()");
      expect(
        await scalar<number>(
          `SELECT count(*)::int AS v FROM public.family_starts WHERE ip_hash = ${tag}`,
        ),
      ).toBe(1);
      await db.asRole("service_role", null, async (c) => {
        expect(
          (await c.query("SELECT public.family_starts_prune() AS n")).rows[0].n,
        ).toBeGreaterThanOrEqual(0);
      });
      await q(`DELETE FROM public.family_starts WHERE ip_hash = ${tag}`);
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("function grants", () => {
    const fnPriv = (role: string, sig: string) =>
      scalar<boolean>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS v", [role, sig]);

    it("my_family_id: authenticated only", async () => {
      expect(await fnPriv("authenticated", "public.my_family_id()")).toBe(true);
      for (const r of ["viewer", "pipeline", "anon"])
        expect(await fnPriv(r, "public.my_family_id()"), r).toBe(false);
    });

    it("parent_family_of is not granted to any user role", async () => {
      for (const r of ["authenticated", "viewer", "pipeline", "anon"])
        expect(await fnPriv(r, "public.parent_family_of(uuid)"), r).toBe(false);
    });

    it("pool and pending helpers: authenticated, pipeline, service_role; not viewer or anon", async () => {
      for (const sig of [
        "public.free_tier_pool_used(uuid)",
        "public.free_tier_pool_albums(uuid)",
        "public.pending_photo_limit()",
        "public.my_pending_photo_count(uuid)",
      ]) {
        for (const r of ["authenticated", "pipeline", "service_role"])
          expect(await fnPriv(r, sig), `${r} ${sig}`).toBe(true);
        for (const r of ["viewer", "anon"]) expect(await fnPriv(r, sig), `${r} ${sig}`).toBe(false);
      }
    });

    it("account_state_for_email and family_holder_email_for_canonical are service_role only", async () => {
      for (const sig of [
        "public.account_state_for_email(text)",
        "public.family_holder_email_for_canonical(text)",
      ]) {
        expect(await fnPriv("service_role", sig), sig).toBe(true);
        for (const r of ["authenticated", "viewer", "pipeline", "anon"])
          expect(await fnPriv(r, sig), `${r} ${sig}`).toBe(false);
      }
      const u = await mkUser();
      await db.asUser(u, async (c) => {
        expect(
          (await tryQuery(c, "SELECT public.account_state_for_email('a@b.c')"))?.message,
        ).toMatch(PERMISSION_DENIED);
        expect(
          (await tryQuery(c, "SELECT public.family_holder_email_for_canonical('a@b.c')"))?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("account_state_for_email: none | active | suspended", async () => {
      const addr = `state-${uniq()}@tinyglow.test`;
      const state = (a: string) =>
        db.asRole(
          "service_role",
          null,
          async (c) =>
            (await c.query("SELECT public.account_state_for_email($1) AS s", [a])).rows[0].s,
        );
      expect(await state(addr)).toBe("none");
      const u = await mkUser(addr);
      expect(await state(addr)).toBe("active");
      expect(await state(addr.toUpperCase())).toBe("active");
      await q(
        "UPDATE public.profiles SET suspended_at = now(), suspended_reason = 'abuse' WHERE user_id = $1",
        [u],
      );
      expect(await state(addr)).toBe("suspended");
    });

    it("email_canonical in SQL agrees with canonicalEmail over the shared fixtures", async () => {
      for (const [input, canonical] of CANONICAL_EMAIL_FIXTURES)
        expect(await scalar("SELECT public.email_canonical($1) AS v", [input]), input).toBe(
          canonical,
        );
    });
  });

  // -----------------------------------------------------------------------------------------
  describe("backfill of migration 21 (down 1, up 1)", () => {
    it("assigns albums that share an admin to one family and separate ones to their own", async () => {
      const u1 = await mkUser();
      const u2 = await mkUser();
      const u3 = await mkUser();
      const u4 = await mkUser();
      const b1 = randomUUID();
      const b2 = randomUUID();
      const b3 = randomUUID();
      const b4 = randomUUID();
      const b5 = randomUUID();
      babies.push(b1, b2, b3, b4, b5);
      try {
        await runMigrations({
          direction: "down",
          count: 1,
          bootstrap: false,
          databaseUrl,
          env,
          log: quiet,
        });
        for (const [b, name] of [
          [b1, "B1"],
          [b2, "B2"],
          [b3, "B3"],
          [b4, "B4"],
          [b5, "B5"],
        ] as const)
          await q(
            "INSERT INTO public.babies (id, name, birth_date, plan) VALUES ($1, $2, '2025-06-30', 'free')",
            [b, name],
          );
        // chain: b1 -(u1)- b2 -(u2)- b3 => one family; b4 (u3) and b5 (u4) alone
        for (const [b, u] of [
          [b1, u1],
          [b2, u1],
          [b2, u2],
          [b3, u2],
          [b4, u3],
          [b5, u4],
        ] as const)
          await q(
            "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
            [b, u],
          );
      } finally {
        await runMigrations({ direction: "up", databaseUrl, env, log: quiet });
      }
      const fam = async (b: string) => familyOf(b);
      expect(await fam(b1)).toBe(await fam(b2));
      expect(await fam(b2)).toBe(await fam(b3));
      const f4 = await fam(b4);
      const f5 = await fam(b5);
      expect(new Set([await fam(b1), f4, f5]).size).toBe(3);
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS v FROM public.babies WHERE family_id IS NULL",
        ),
      ).toBe(0);
      // the founder is the baby's earliest admin (created_by is NULL for these albums)
      expect(await scalar("SELECT created_by AS v FROM public.families WHERE id = $1", [f4])).toBe(
        u3,
      );
      // after the round trip the rules are live again
      const err = await tryQuery(
        db.admin,
        "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
        [b4, u1],
      );
      expect(err?.message).toMatch(ONE_FAMILY_RE);
    });

    it("founder choice: the creator while still an admin, else the earliest-joined admin, else NULL", async () => {
      const [uA, uB, uC, uD, uE, uF] = [
        await mkUser(),
        await mkUser(),
        await mkUser(),
        await mkUser(),
        await mkUser(),
        await mkUser(),
      ];
      const [ba, bb, bc, bd] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      babies.push(ba, bb, bc, bd);
      try {
        await runMigrations({
          direction: "down",
          count: 1,
          bootstrap: false,
          databaseUrl,
          env,
          log: quiet,
        });
        const mk = (b: string, by: string | null) =>
          q(
            "INSERT INTO public.babies (id, name, birth_date, plan, created_by) VALUES ($1, 'F', '2025-06-30', 'free', $2)",
            [b, by],
          );
        await mk(ba, uA); // creator uA is auto-admin; uB also admin, joined earlier
        await addMember(ba, uB, "admin");
        await q(
          "UPDATE public.baby_members SET joined_at = now() - interval '2 days' WHERE baby_id = $1 AND user_id = $2",
          [ba, uB],
        );
        await mk(bb, uC); // creator uC leaves; uD remains
        await addMember(bb, uD, "admin");
        await q("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [bb, uC]);
        await mk(bc, null); // no creator: earliest-joined admin
        await addMember(bc, uE, "admin");
        await q(
          "UPDATE public.baby_members SET joined_at = now() - interval '3 days' WHERE baby_id = $1 AND user_id = $2",
          [bc, uE],
        );
        await addMember(bc, uF, "admin");
        await mk(bd, null); // trashed and admin-less: founder NULL
        await q("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [bd]);
      } finally {
        await runMigrations({ direction: "up", databaseUrl, env, log: quiet });
      }
      const founder = async (b: string) =>
        scalar<string | null>(
          "SELECT f.created_by AS v FROM public.families f JOIN public.babies b ON b.family_id = f.id WHERE b.id = $1",
          [b],
        );
      expect(await founder(ba)).toBe(uA);
      expect(await founder(bb)).toBe(uD);
      expect(await founder(bc)).toBe(uE);
      expect(await founder(bd)).toBeNull();
    });
  });
});
