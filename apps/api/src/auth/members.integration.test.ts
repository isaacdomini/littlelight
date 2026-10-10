import { randomUUID } from "node:crypto";
import { memberSchema, membersListResponseSchema } from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";

// Members (PRD "Roles and permissions", FR-1.3, FR-1.5, FR-1.6; docs/plans/step-3.md 3.5, 3.10).

describe.skipIf(!databaseUrl)("members", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  /** Album with admin A, optional co-admin B, optional contributor C. */
  async function album(
    opts: { coAdmin?: boolean; contributor?: boolean; staleAdmin?: boolean } = {},
  ) {
    const a = await h.user({ displayName: "Alice", sessionAgeMin: opts.staleAdmin ? 30 : 1 });
    const babyId = await h.baby(a, "Mia");
    const b = opts.coAdmin ? await h.user({ displayName: "Bob" }) : null;
    if (b) await h.member(babyId, b, "admin");
    const c = opts.contributor ? await h.user({ displayName: "Carol" }) : null;
    if (c) await h.member(babyId, c, "contributor");
    return { a, b, c, babyId };
  }
  const members = (u: TestUser, babyId: string) => h.inject(u, "GET", `/babies/${babyId}/members`);
  const roleOf = async (babyId: string, u: TestUser) =>
    (
      await h.admin.query(
        "SELECT role FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [babyId, u.id],
      )
    ).rows[0]?.role ?? null;
  const removalOf = async (babyId: string, u: TestUser) =>
    (
      await h.admin.query(
        "SELECT removal_requested_by AS by, removal_requested_at AS at FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [babyId, u.id],
      )
    ).rows[0];

  describe("GET /babies/:id/members", () => {
    it("members see each other (names, roles) and non-members get 404", async () => {
      const { a, b, c, babyId } = await album({ coAdmin: true, contributor: true });
      const stranger = await h.user();
      const res = await members(c as TestUser, babyId);
      expect(res.statusCode).toBe(200);
      const body = membersListResponseSchema.parse(res.json());
      expect(body.members.map((m) => m.displayName).sort()).toEqual(["Alice", "Bob", "Carol"]);
      expect(body.members.find((m) => m.userId === a.id)?.role).toBe("admin");
      expect(body.members.find((m) => m.userId === (b as TestUser).id)?.role).toBe("admin");
      expect(res.body).not.toContain(a.email);
      expect((await members(stranger, babyId)).statusCode).toBe(404);
      expect((await h.inject(null, "GET", `/babies/${babyId}/members`)).statusCode).toBe(401);
    });

    it("names and relationship labels come through member_profiles for every role (profiles itself is self-only)", async () => {
      const { a, b, c, babyId } = await album({ coAdmin: true, contributor: true });
      await h.admin.query(
        "UPDATE public.profiles SET relationship_label = 'grandma' WHERE user_id = $1",
        [c?.id],
      );
      for (const viewer of [a, b as TestUser, c as TestUser]) {
        const res = await members(viewer, babyId);
        expect(res.statusCode).toBe(200);
        const list = membersListResponseSchema.parse(res.json()).members;
        expect(list.map((m) => m.displayName).sort()).toEqual(["Alice", "Bob", "Carol"]);
        expect(list.find((m) => m.displayName === "Carol")?.relationshipLabel).toBe("grandma");
      }
    });

    it("a member whose profile is mid-deletion is still listed, with an empty name and no label", async () => {
      const { a, c, babyId } = await album({ contributor: true });
      await h.admin.query(
        "UPDATE public.profiles SET deleted_at = now(), relationship_label = 'secret' WHERE user_id = $1",
        [c?.id],
      );
      const res = await members(a, babyId);
      expect(res.statusCode).toBe(200);
      const list = membersListResponseSchema.parse(res.json()).members;
      expect(list).toHaveLength(2);
      const gone = list.find((m) => m.userId === c?.id);
      expect(gone).toMatchObject({ displayName: "", relationshipLabel: null, role: "contributor" });
      expect(JSON.stringify(res.json())).not.toContain("secret");
    });

    it("never exposes another album's members, nor profile fields beyond name and label", async () => {
      const one = await album({ contributor: true });
      const two = await album();
      const res = await members(one.a, one.babyId);
      const body = JSON.stringify(res.json());
      expect(body).not.toContain(two.a.id);
      expect(body).not.toContain(one.a.email);
      expect(Object.keys(res.json().members[0]).sort()).toEqual([
        "displayName",
        "joinedAt",
        "relationshipLabel",
        "removalRequestedAt",
        "removalRequestedBy",
        "role",
        "userId",
      ]);
      expect((await members(two.a, one.babyId)).statusCode).toBe(404);
    });

    it("pending invites are visible to admins only; accepted and revoked ones are never listed", async () => {
      const { a, c, babyId } = await album({ contributor: true });
      const pending = await h.inject(a, "POST", `/babies/${babyId}/invites`, {
        email: `p-${randomUUID().slice(0, 6)}@example.test`,
        role: "contributor",
      });
      const revoked = await h.inject(a, "POST", `/babies/${babyId}/invites`, {
        email: `r-${randomUUID().slice(0, 6)}@example.test`,
        role: "contributor",
      });
      await h.inject(a, "DELETE", `/babies/${babyId}/invites/${revoked.json().id}`);
      const asAdmin = membersListResponseSchema.parse((await members(a, babyId)).json());
      expect(asAdmin.invites.map((i) => i.id)).toEqual([pending.json().id]);
      const asContrib = membersListResponseSchema.parse(
        (await members(c as TestUser, babyId)).json(),
      );
      expect(asContrib.invites).toEqual([]);
    });

    it("a removal request is reported while live and hidden after 7 days", async () => {
      const { a, b, babyId } = await album({ coAdmin: true });
      const target = b as TestUser;
      await h.admin.query(
        "UPDATE public.baby_members SET removal_requested_by = $3, removal_requested_at = now() - interval '2 days' WHERE baby_id = $1 AND user_id = $2",
        [babyId, target.id, a.id],
      );
      let list = membersListResponseSchema.parse((await members(a, babyId)).json());
      expect(list.members.find((m) => m.userId === target.id)).toMatchObject({
        removalRequestedBy: a.id,
      });
      expect(list.members.find((m) => m.userId === target.id)?.removalRequestedAt).not.toBeNull();
      await h.admin.query(
        "UPDATE public.baby_members SET removal_requested_at = now() - interval '8 days' WHERE baby_id = $1 AND user_id = $2",
        [babyId, target.id],
      );
      list = membersListResponseSchema.parse((await members(a, babyId)).json());
      expect(list.members.find((m) => m.userId === target.id)).toMatchObject({
        removalRequestedBy: null,
        removalRequestedAt: null,
      });
    });
  });

  describe("PATCH role", () => {
    it("an admin promotes a contributor (no fresh sign-in needed) and it is audited", async () => {
      const { a, c, babyId } = await album({ contributor: true, staleAdmin: true });
      const res = await h.inject(a, "PATCH", `/babies/${babyId}/members/${(c as TestUser).id}`, {
        role: "admin",
      });
      expect(res.statusCode).toBe(200);
      expect(memberSchema.parse(res.json())).toMatchObject({
        userId: (c as TestUser).id,
        role: "admin",
        displayName: "Carol",
      });
      expect(await roleOf(babyId, c as TestUser)).toBe("admin");
      const audit = await h.audit({ event: "member.role_changed", baby: babyId });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toEqual({ target_user_id: (c as TestUser).id, role: "admin" });
    });

    it("409 admins_full when promoting a third admin", async () => {
      const { a, c, babyId } = await album({ coAdmin: true, contributor: true });
      const res = await h.inject(a, "PATCH", `/babies/${babyId}/members/${(c as TestUser).id}`, {
        role: "admin",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("admins_full");
      expect(await roleOf(babyId, c as TestUser)).toBe("contributor");
    });

    it("a no-op (same role) is 200 and writes no audit row", async () => {
      const { a, c, babyId } = await album({ contributor: true });
      const res = await h.inject(a, "PATCH", `/babies/${babyId}/members/${(c as TestUser).id}`, {
        role: "contributor",
      });
      expect(res.statusCode).toBe(200);
      expect(await h.audit({ event: "member.role_changed", baby: babyId })).toHaveLength(0);
    });

    it("self-demotion needs a fresh sign-in, then succeeds", async () => {
      const stale = await album({ coAdmin: true, staleAdmin: true });
      const denied = await h.inject(
        stale.a,
        "PATCH",
        `/babies/${stale.babyId}/members/${stale.a.id}`,
        { role: "contributor" },
      );
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe("fresh_sign_in_required");
      expect(await roleOf(stale.babyId, stale.a)).toBe("admin");

      const fresh = await album({ coAdmin: true });
      const ok = await h.inject(fresh.a, "PATCH", `/babies/${fresh.babyId}/members/${fresh.a.id}`, {
        role: "contributor",
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().role).toBe("contributor");
      // They are now a contributor: they can no longer manage members.
      const again = await h.inject(
        fresh.a,
        "PATCH",
        `/babies/${fresh.babyId}/members/${(fresh.b as TestUser).id}`,
        { role: "contributor" },
      );
      expect(again.statusCode).toBe(403);
    });

    it("an admin cannot demote the other admin (403); the other admin's role is unchanged", async () => {
      const { a, b, babyId } = await album({ coAdmin: true });
      const res = await h.inject(a, "PATCH", `/babies/${babyId}/members/${(b as TestUser).id}`, {
        role: "contributor",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
      expect(await roleOf(babyId, b as TestUser)).toBe("admin");
    });

    it("the last admin cannot demote themselves: 409 last_admin", async () => {
      const { a, babyId } = await album();
      const res = await h.inject(a, "PATCH", `/babies/${babyId}/members/${a.id}`, {
        role: "contributor",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("last_admin");
      expect(await roleOf(babyId, a)).toBe("admin");
    });

    it("the paying admin stepping down returns the plan to free", async () => {
      const { a, b, babyId } = await album({ coAdmin: true });
      await h.admin.query(
        "UPDATE public.babies SET plan = 'plus', plan_owner_user_id = $2, entitlement_expires_at = now() + interval '30 days' WHERE id = $1",
        [babyId, a.id],
      );
      const res = await h.inject(a, "PATCH", `/babies/${babyId}/members/${a.id}`, {
        role: "contributor",
      });
      expect(res.statusCode).toBe(200);
      const baby = (
        await h.admin.query(
          "SELECT plan, plan_owner_user_id, entitlement_expires_at FROM public.babies WHERE id = $1",
          [babyId],
        )
      ).rows[0];
      expect(baby).toEqual({
        plan: "free",
        plan_owner_user_id: null,
        entitlement_expires_at: null,
      });
      expect(b).toBeDefined();
    });

    it("contributors get 403, strangers 404, non-members as targets 404; bad role 400", async () => {
      const { a, b, c, babyId } = await album({ coAdmin: true, contributor: true });
      const stranger = await h.user();
      expect(
        (
          await h.inject(
            c as TestUser,
            "PATCH",
            `/babies/${babyId}/members/${(c as TestUser).id}`,
            { role: "admin" },
          )
        ).statusCode,
      ).toBe(403);
      expect(await roleOf(babyId, c as TestUser)).toBe("contributor");
      expect(
        (
          await h.inject(stranger, "PATCH", `/babies/${babyId}/members/${a.id}`, {
            role: "contributor",
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await h.inject(a, "PATCH", `/babies/${babyId}/members/${stranger.id}`, {
            role: "contributor",
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await h.inject(a, "PATCH", `/babies/${babyId}/members/${(b as TestUser).id}`, {
            role: "owner",
          })
        ).statusCode,
      ).toBe(400);
    });
  });

  describe("DELETE member", () => {
    it("a member leaves (fresh sign-in required); audited; the album disappears for them", async () => {
      const stale = await h.user({ sessionAgeMin: 30 });
      const { a, babyId } = await album();
      await h.member(babyId, stale, "contributor");
      const denied = await h.inject(stale, "DELETE", `/babies/${babyId}/members/${stale.id}`);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe("fresh_sign_in_required");
      expect(await roleOf(babyId, stale)).toBe("contributor");

      const { c, babyId: baby2 } = await album({ contributor: true });
      const ok = await h.inject(
        c as TestUser,
        "DELETE",
        `/babies/${baby2}/members/${(c as TestUser).id}`,
      );
      expect(ok.statusCode).toBe(204);
      expect(await roleOf(baby2, c as TestUser)).toBeNull();
      expect((await h.inject(c as TestUser, "GET", `/babies/${baby2}`)).statusCode).toBe(404);
      const audit = await h.audit({ event: "member.removed", baby: baby2 });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: (c as TestUser).id });
      expect(a).toBeDefined();
    });

    it("an admin may leave when a co-admin remains; the sole admin may not (409 last_admin)", async () => {
      const two = await album({ coAdmin: true });
      expect(
        (await h.inject(two.a, "DELETE", `/babies/${two.babyId}/members/${two.a.id}`)).statusCode,
      ).toBe(204);
      const sole = await album();
      const res = await h.inject(sole.a, "DELETE", `/babies/${sole.babyId}/members/${sole.a.id}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("last_admin");
      expect(await roleOf(sole.babyId, sole.a)).toBe("admin");
    });

    it("the paying admin leaving returns the plan to free", async () => {
      const { a, babyId } = await album({ coAdmin: true });
      await h.admin.query(
        "UPDATE public.babies SET plan = 'plus', plan_owner_user_id = $2 WHERE id = $1",
        [babyId, a.id],
      );
      expect((await h.inject(a, "DELETE", `/babies/${babyId}/members/${a.id}`)).statusCode).toBe(
        204,
      );
      const baby = (
        await h.admin.query("SELECT plan, plan_owner_user_id FROM public.babies WHERE id = $1", [
          babyId,
        ])
      ).rows[0];
      expect(baby).toEqual({ plan: "free", plan_owner_user_id: null });
    });

    it("an admin removes a contributor directly (204, audited); a stale admin session is fine for this", async () => {
      const { a, c, babyId } = await album({ contributor: true, staleAdmin: true });
      const res = await h.inject(a, "DELETE", `/babies/${babyId}/members/${(c as TestUser).id}`);
      expect(res.statusCode).toBe(204);
      expect(await roleOf(babyId, c as TestUser)).toBeNull();
      const audit = await h.audit({ event: "member.removed", baby: babyId });
      expect(audit[0]?.metadata).toEqual({
        target_user_id: (c as TestUser).id,
        role: "contributor",
      });
    });

    it("contributors cannot remove anyone else; strangers get 404", async () => {
      const { a, b, c, babyId } = await album({ coAdmin: true, contributor: true });
      const d = await h.user();
      await h.member(babyId, d, "contributor");
      expect(
        (await h.inject(c as TestUser, "DELETE", `/babies/${babyId}/members/${d.id}`)).statusCode,
      ).toBe(403);
      expect(
        (await h.inject(c as TestUser, "DELETE", `/babies/${babyId}/members/${(b as TestUser).id}`))
          .statusCode,
      ).toBe(403);
      expect(
        (await h.inject(await h.user(), "DELETE", `/babies/${babyId}/members/${a.id}`)).statusCode,
      ).toBe(404);
      expect(await roleOf(babyId, d)).toBe("contributor");
      expect(await roleOf(babyId, b as TestUser)).toBe("admin");
    });

    it("removing a co-admin is a 202 request, not a removal: the target stays and must confirm", async () => {
      const { a, b, babyId } = await album({ coAdmin: true });
      const res = await h.inject(a, "DELETE", `/babies/${babyId}/members/${(b as TestUser).id}`);
      expect(res.statusCode).toBe(202);
      expect(await roleOf(babyId, b as TestUser)).toBe("admin");
      const req = await removalOf(babyId, b as TestUser);
      expect(req.by).toBe(a.id);
      expect(req.at).toBeInstanceOf(Date);
      expect(await h.audit({ event: "member.removal_requested", baby: babyId })).toHaveLength(1);
      // Visible to both admins in the member list.
      const list = membersListResponseSchema.parse((await members(b as TestUser, babyId)).json());
      expect(list.members.find((m) => m.userId === (b as TestUser).id)?.removalRequestedBy).toBe(
        a.id,
      );
    });

    it("requesting a co-admin's removal needs a fresh sign-in and records nothing when stale", async () => {
      const { a, b, babyId } = await album({ coAdmin: true, staleAdmin: true });
      const res = await h.inject(a, "DELETE", `/babies/${babyId}/members/${(b as TestUser).id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("fresh_sign_in_required");
      expect((await removalOf(babyId, b as TestUser)).at).toBeNull();
    });

    it("404 for a target that is not a member", async () => {
      const { a, babyId } = await album();
      expect(
        (await h.inject(a, "DELETE", `/babies/${babyId}/members/${randomUUID()}`)).statusCode,
      ).toBe(404);
    });
  });

  describe("removal confirm / decline", () => {
    async function requested() {
      const x = await album({ coAdmin: true });
      await h.inject(x.a, "DELETE", `/babies/${x.babyId}/members/${(x.b as TestUser).id}`);
      return { ...x, b: x.b as TestUser };
    }

    it("the target confirms (fresh): removed, audited, plan is not touched", async () => {
      const { b, babyId } = await requested();
      const res = await h.inject(b, "POST", `/babies/${babyId}/members/${b.id}/removal/confirm`);
      expect(res.statusCode).toBe(204);
      expect(await roleOf(babyId, b)).toBeNull();
      const audit = await h.audit({ event: "member.removed", baby: babyId });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: b.id });
    });

    it("nobody else can confirm: the requester gets 403, others 403/404; the target stays", async () => {
      const { a, b, babyId } = await requested();
      const asRequester = await h.inject(
        a,
        "POST",
        `/babies/${babyId}/members/${b.id}/removal/confirm`,
      );
      expect(asRequester.statusCode).toBe(403);
      const stranger = await h.user();
      expect([403, 404]).toContain(
        (await h.inject(stranger, "POST", `/babies/${babyId}/members/${b.id}/removal/confirm`))
          .statusCode,
      );
      expect(await roleOf(babyId, b)).toBe("admin");
    });

    it("confirm without a pending request is 404; with an expired one (8 days) is 404", async () => {
      const { a, b, babyId } = await album({ coAdmin: true });
      const none = await h.inject(
        b as TestUser,
        "POST",
        `/babies/${babyId}/members/${(b as TestUser).id}/removal/confirm`,
      );
      expect(none.statusCode).toBe(404);
      await h.admin.query(
        "UPDATE public.baby_members SET removal_requested_by = $3, removal_requested_at = now() - interval '8 days' WHERE baby_id = $1 AND user_id = $2",
        [babyId, (b as TestUser).id, a.id],
      );
      const stale = await h.inject(
        b as TestUser,
        "POST",
        `/babies/${babyId}/members/${(b as TestUser).id}/removal/confirm`,
      );
      expect(stale.statusCode).toBe(404);
      expect(await roleOf(babyId, b as TestUser)).toBe("admin");
    });

    it("confirm needs a fresh sign-in", async () => {
      const a = await h.user();
      const babyId = await h.baby(a);
      const b = await h.user({ sessionAgeMin: 30 });
      await h.member(babyId, b, "admin");
      await h.inject(a, "DELETE", `/babies/${babyId}/members/${b.id}`);
      const res = await h.inject(b, "POST", `/babies/${babyId}/members/${b.id}/removal/confirm`);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("fresh_sign_in_required");
      expect(await roleOf(babyId, b)).toBe("admin");
    });

    it("if the requester left meanwhile, confirming would orphan the album: 409 last_admin", async () => {
      const { a, b, babyId } = await requested();
      await h.admin.query("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [
        babyId,
        a.id,
      ]);
      const res = await h.inject(b, "POST", `/babies/${babyId}/members/${b.id}/removal/confirm`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("last_admin");
    });

    it("the target or the other admin can decline; the request is cleared and the member stays", async () => {
      const first = await requested();
      expect(
        (
          await h.inject(
            first.b,
            "POST",
            `/babies/${first.babyId}/members/${first.b.id}/removal/decline`,
          )
        ).statusCode,
      ).toBe(204);
      expect((await removalOf(first.babyId, first.b)).at).toBeNull();
      expect(await roleOf(first.babyId, first.b)).toBe("admin");

      const second = await requested();
      expect(
        (
          await h.inject(
            second.a,
            "POST",
            `/babies/${second.babyId}/members/${second.b.id}/removal/decline`,
          )
        ).statusCode,
      ).toBe(204);
      const cleared = await removalOf(second.babyId, second.b);
      expect(cleared).toEqual({ by: null, at: null });
    });

    it("decline without a request is 404; a contributor cannot decline someone else's request", async () => {
      const none = await album({ coAdmin: true, contributor: true });
      expect(
        (
          await h.inject(
            none.a,
            "POST",
            `/babies/${none.babyId}/members/${(none.b as TestUser).id}/removal/decline`,
          )
        ).statusCode,
      ).toBe(404);
      const x = await requested();
      const c = await h.user();
      await h.member(x.babyId, c, "contributor");
      expect(
        (await h.inject(c, "POST", `/babies/${x.babyId}/members/${x.b.id}/removal/decline`))
          .statusCode,
      ).toBe(403);
      expect((await removalOf(x.babyId, x.b)).at).toBeInstanceOf(Date);
    });

    it("extra removal fields smuggled into a role PATCH are ignored (the columns are service_role-only)", async () => {
      const { a, babyId } = await album({ coAdmin: true });
      const res = await h.inject(a, "PATCH", `/babies/${babyId}/members/${a.id}`, {
        role: "admin",
        removalRequestedBy: a.id,
        removal_requested_at: new Date().toISOString(),
      });
      expect(res.statusCode).toBe(200);
      expect((await removalOf(babyId, a)).at).toBeNull();
    });
  });

  describe("non-members never learn anything", () => {
    it("every member route is 404 (or 401) for a stranger", async () => {
      const { a, b, babyId } = await album({ coAdmin: true });
      const s = await h.user();
      const target = (b as TestUser).id;
      const calls: Array<[string, string, unknown?]> = [
        ["GET", `/babies/${babyId}/members`],
        ["PATCH", `/babies/${babyId}/members/${target}`, { role: "contributor" }],
        ["DELETE", `/babies/${babyId}/members/${target}`],
        ["POST", `/babies/${babyId}/members/${target}/removal/decline`],
        ["POST", `/babies/${babyId}/invites`, { email: "x@example.test", role: "contributor" }],
      ];
      for (const [method, url, body] of calls) {
        const res = await h.inject(s, method as "GET", url, body);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      expect(a).toBeDefined();
    });
  });
});
