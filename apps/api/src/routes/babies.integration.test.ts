import { randomUUID } from "node:crypto";
import { babiesListResponseSchema, babySchema } from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness } from "../testing/integration";

// /babies (docs/plans/step-3.md 2.4; PRD FR-1.2, FR-1.4, "Roles and permissions").
// Authorization is RLS: these tests check what the HTTP surface does with it.

describe.skipIf(!databaseUrl)("/babies", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const create = (u: Parameters<Harness["inject"]>[0], body: unknown) =>
    h.inject(u, "POST", "/babies", body);

  describe("create", () => {
    it("201 with the caller as admin on the free plan, and an audit row", async () => {
      const u = await h.user();
      const res = await create(u, {
        name: " Mia ",
        nickname: "Mimi",
        birthDate: "2026-03-01",
        birthDateIsDueDate: true,
        birthWeightG: 3400,
        birthLengthMm: 500,
      });
      expect(res.statusCode).toBe(201);
      const baby = babySchema.parse(res.json());
      expect(baby).toMatchObject({
        name: "Mia",
        nickname: "Mimi",
        birthDate: "2026-03-01",
        birthDateIsDueDate: true,
        birthWeightG: 3400,
        birthLengthMm: 500,
        plan: "free",
        role: "admin",
        deletedAt: null,
      });
      const { rows } = await h.admin.query(
        "SELECT role FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [baby.id, u.id],
      );
      expect(rows[0].role).toBe("admin");
      const audit = await h.audit({ event: "baby.created", baby: baby.id });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: u.id });
      expect(audit[0]?.metadata).toMatchObject({ role: "admin", client: "web" });
      await h.admin
        .query("DELETE FROM public.babies WHERE id = $1", [baby.id])
        .catch(() => undefined);
    });

    it("birth date round-trips as YYYY-MM-DD regardless of server time zone", async () => {
      const u = await h.user();
      const res = await create(u, { name: "Edge", birthDate: "2026-12-31" });
      expect(res.json().birthDate).toBe("2026-12-31");
      const list = babiesListResponseSchema.parse((await h.inject(u, "GET", "/babies")).json());
      expect(list.babies[0]?.birthDate).toBe("2026-12-31");
    });

    it("403 consent_required without consent, nothing created", async () => {
      const u = await h.user({ consent: false });
      const res = await create(u, { name: "Mia", birthDate: "2026-03-01" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("consent_required");
      const { rows } = await h.admin.query("SELECT 1 FROM public.babies WHERE created_by = $1", [
        u.id,
      ]);
      expect(rows).toHaveLength(0);
    });

    it("400 for missing/blank name, bad date, absurd weight; plan/owner fields are ignored", async () => {
      const u = await h.user();
      for (const body of [
        { birthDate: "2026-03-01" },
        { name: "  ", birthDate: "2026-03-01" },
        { name: "Mia", birthDate: "03/01/2026" },
        { name: "Mia", birthDate: "2026-03-01", birthWeightG: -5 },
        { name: "Mia", birthDate: "2026-03-01", birthWeightG: 99_999 },
      ]) {
        expect((await create(u, body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      const res = await create(u, {
        name: "Mia",
        birthDate: "2026-03-01",
        plan: "plus",
        plan_owner_user_id: u.id,
        created_by: randomUUID(),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().plan).toBe("free");
      const row = (
        await h.admin.query(
          "SELECT plan, plan_owner_user_id, created_by FROM public.babies WHERE id = $1",
          [res.json().id],
        )
      ).rows[0];
      expect(row).toEqual({ plan: "free", plan_owner_user_id: null, created_by: u.id });
    });
  });

  describe("read", () => {
    it("lists only my babies; a non-member gets 404 on someone else's baby (and cannot tell it exists)", async () => {
      const a = await h.user();
      const b = await h.user();
      const babyA = await h.baby(a, "A");
      const babyB = await h.baby(b, "B");
      const listA = babiesListResponseSchema.parse((await h.inject(a, "GET", "/babies")).json());
      expect(listA.babies.map((x) => x.id)).toEqual([babyA]);
      const peek = await h.inject(a, "GET", `/babies/${babyB}`);
      const nothing = await h.inject(a, "GET", `/babies/${randomUUID()}`);
      expect(peek.statusCode).toBe(404);
      expect(nothing.statusCode).toBe(404);
      expect(peek.json()).toEqual(nothing.json());
      expect((await h.inject(b, "GET", `/babies/${babyB}`)).statusCode).toBe(200);
    });

    it("trash visibility: admins still see a trashed baby (deletedAt set), contributors and strangers do not", async () => {
      const admin = await h.user();
      const contrib = await h.user();
      const stranger = await h.user();
      const id = await h.baby(admin, "Trashed");
      await h.member(id, contrib, "contributor");
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [id]);

      const adminList = babiesListResponseSchema.parse(
        (await h.inject(admin, "GET", "/babies")).json(),
      );
      expect(adminList.babies).toHaveLength(1);
      expect(adminList.babies[0]?.deletedAt).not.toBeNull();
      expect((await h.inject(admin, "GET", `/babies/${id}`)).statusCode).toBe(200);

      expect(
        babiesListResponseSchema.parse((await h.inject(contrib, "GET", "/babies")).json()).babies,
      ).toEqual([]);
      expect((await h.inject(contrib, "GET", `/babies/${id}`)).statusCode).toBe(404);
      expect((await h.inject(stranger, "GET", `/babies/${id}`)).statusCode).toBe(404);
    });

    it("rejects a malformed id with 400", async () => {
      const u = await h.user();
      expect((await h.inject(u, "GET", "/babies/not-a-uuid")).statusCode).toBe(400);
    });

    it("needs consent to list", async () => {
      const u = await h.user({ consent: false });
      expect((await h.inject(u, "GET", "/babies")).json().error).toBe("consent_required");
    });
  });

  describe("PATCH", () => {
    it("an admin can edit and clear optional fields", async () => {
      const u = await h.user();
      const id = await h.baby(u);
      const res = await h.inject(u, "PATCH", `/babies/${id}`, {
        name: "Mia Rose",
        nickname: "Mimi",
        birthWeightG: 3500,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "Mia Rose", nickname: "Mimi", birthWeightG: 3500 });
      const cleared = await h.inject(u, "PATCH", `/babies/${id}`, { nickname: null });
      expect(cleared.json().nickname).toBeNull();
    });

    it("cannot set plan, owner or created_by (ignored, not applied), and an empty body is 400", async () => {
      const u = await h.user();
      const id = await h.baby(u);
      const res = await h.inject(u, "PATCH", `/babies/${id}`, {
        name: "Same",
        plan: "plus",
        planOwnerUserId: u.id,
        plan_owner_user_id: u.id,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().plan).toBe("free");
      const row = (
        await h.admin.query("SELECT plan, plan_owner_user_id FROM public.babies WHERE id = $1", [
          id,
        ])
      ).rows[0];
      expect(row).toEqual({ plan: "free", plan_owner_user_id: null });
      expect((await h.inject(u, "PATCH", `/babies/${id}`, { plan: "plus" })).statusCode).toBe(400);
      expect((await h.inject(u, "PATCH", `/babies/${id}`, {})).statusCode).toBe(400);
    });

    it("a contributor gets 403, a non-member 404; neither changes anything", async () => {
      const admin = await h.user();
      const contrib = await h.user();
      const stranger = await h.user();
      const id = await h.baby(admin, "Original");
      await h.member(id, contrib, "contributor");
      const asContrib = await h.inject(contrib, "PATCH", `/babies/${id}`, { name: "Hacked" });
      expect(asContrib.statusCode).toBe(403);
      expect(asContrib.json().error).toBe("forbidden");
      expect(
        (await h.inject(stranger, "PATCH", `/babies/${id}`, { name: "Hacked" })).statusCode,
      ).toBe(404);
      const row = (await h.admin.query("SELECT name FROM public.babies WHERE id = $1", [id]))
        .rows[0];
      expect(row.name).toBe("Original");
    });

    it("a trashed baby cannot be edited: 409 conflict", async () => {
      const u = await h.user();
      const id = await h.baby(u);
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [id]);
      const res = await h.inject(u, "PATCH", `/babies/${id}`, { name: "Zombie" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("conflict");
    });
  });

  describe("DELETE (trash)", () => {
    it("a stale session gets 403 fresh_sign_in_required and nothing is trashed", async () => {
      const u = await h.user({ sessionAgeMin: 30 });
      const id = await h.baby(u);
      const res = await h.inject(u, "DELETE", `/babies/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("fresh_sign_in_required");
      const row = (await h.admin.query("SELECT deleted_at FROM public.babies WHERE id = $1", [id]))
        .rows[0];
      expect(row.deleted_at).toBeNull();
      expect(await h.audit({ event: "baby.deleted", baby: id })).toHaveLength(0);
    });

    it("a fresh session trashes (204) and audits; repeating is 204 with no extra audit row", async () => {
      const u = await h.user();
      const id = await h.baby(u);
      expect((await h.inject(u, "DELETE", `/babies/${id}`)).statusCode).toBe(204);
      const row = (await h.admin.query("SELECT deleted_at FROM public.babies WHERE id = $1", [id]))
        .rows[0];
      expect(row.deleted_at).toBeInstanceOf(Date);
      expect(await h.audit({ event: "baby.deleted", baby: id })).toHaveLength(1);
      expect((await h.inject(u, "DELETE", `/babies/${id}`)).statusCode).toBe(204);
      expect(await h.audit({ event: "baby.deleted", baby: id })).toHaveLength(1);
    });

    it("a contributor gets 403 even when fresh; a stranger 404; the baby survives", async () => {
      const admin = await h.user();
      const contrib = await h.user();
      const stranger = await h.user();
      const id = await h.baby(admin);
      await h.member(id, contrib, "contributor");
      expect((await h.inject(contrib, "DELETE", `/babies/${id}`)).statusCode).toBe(403);
      expect((await h.inject(stranger, "DELETE", `/babies/${id}`)).statusCode).toBe(404);
      const row = (await h.admin.query("SELECT deleted_at FROM public.babies WHERE id = $1", [id]))
        .rows[0];
      expect(row.deleted_at).toBeNull();
    });

    it("401 without a session; trashing needs consent", async () => {
      const id = randomUUID();
      expect((await h.inject(null, "DELETE", `/babies/${id}`)).statusCode).toBe(401);
      const u = await h.user({ consent: false });
      expect((await h.inject(u, "DELETE", `/babies/${id}`)).json().error).toBe("consent_required");
    });
  });
});
