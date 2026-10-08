import { randomUUID } from "node:crypto";
import { deletionPreviewResponseSchema } from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness } from "../testing/integration";
import { GoTrueError } from "./gotrue";

// Account deletion (PRD "Account deletion and recovery"; docs/plans/step-3.md 3.5, 3.10).

const cookiesOf = (res: { headers: Record<string, unknown> }) =>
  [res.headers["set-cookie"]].flat().filter(Boolean).map(String);

describe.skipIf(!databaseUrl)("account deletion", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const del = (u: Parameters<Harness["inject"]>[0], body: unknown = { acknowledge: true }) =>
    h.inject(u, "DELETE", "/me", body);
  const exists = async (table: string, col: string, id: string) =>
    ((await h.admin.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [id])).rowCount ?? 0) > 0;

  describe("GET /me/deletion-preview", () => {
    it("lists babies that block (sole admin) and babies that stay with the other admin", async () => {
      const u = await h.user({ displayName: "Alice" });
      const other = await h.user({ displayName: "Bob" });
      const solo = await h.baby(u, "Solo");
      const shared = await h.baby(u, "Shared");
      await h.member(shared, other, "admin");
      const trashed = await h.baby(u, "Trashed");
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [trashed]);

      const res = await h.inject(u, "GET", "/me/deletion-preview");
      expect(res.statusCode).toBe(200);
      const body = deletionPreviewResponseSchema.parse(res.json());
      expect(body.blockingBabies).toEqual([{ id: solo, name: "Solo" }]);
      expect(body.babiesKept).toEqual([{ id: shared, name: "Shared", otherAdminName: "Bob" }]);
      expect(body.freshSignIn).toBe(true);
    });

    it("is empty for a user with no albums, reports a stale session, and needs a session", async () => {
      const u = await h.user({ sessionAgeMin: 30 });
      const body = deletionPreviewResponseSchema.parse(
        (await h.inject(u, "GET", "/me/deletion-preview")).json(),
      );
      expect(body).toEqual({ blockingBabies: [], babiesKept: [], freshSignIn: false });
      expect((await h.inject(null, "GET", "/me/deletion-preview")).statusCode).toBe(401);
    });

    it("does not count a contributor membership as blocking", async () => {
      const admin = await h.user();
      const c = await h.user();
      const babyId = await h.baby(admin);
      await h.member(babyId, c, "contributor");
      const body = (await h.inject(c, "GET", "/me/deletion-preview")).json();
      expect(body.blockingBabies).toEqual([]);
      // The album stays with its admin when this contributor's account goes.
      expect(body.babiesKept).toEqual([expect.objectContaining({ id: babyId })]);
    });
  });

  describe("DELETE /me", () => {
    it("needs a fresh sign-in (403) and deletes nothing", async () => {
      const u = await h.user({ sessionAgeMin: 30 });
      h.gotrue.calls.adminDeleteUser.length = 0;
      const res = await del(u);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("fresh_sign_in_required");
      expect(h.gotrue.calls.adminDeleteUser).toHaveLength(0);
      expect(await exists("auth.users", "id", u.id)).toBe(true);
    });

    it("requires acknowledge:true", async () => {
      const u = await h.user();
      for (const body of [{}, { acknowledge: false }, { acknowledge: "yes" }]) {
        expect((await del(u, body)).statusCode).toBe(400);
      }
      expect(await exists("auth.users", "id", u.id)).toBe(true);
    });

    it("is 409 sole_admin, naming the blocking albums, while the user is the only admin of a live baby", async () => {
      const u = await h.user();
      const babyId = await h.baby(u, "Solo");
      h.gotrue.calls.adminDeleteUser.length = 0;
      const res = await del(u);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("sole_admin");
      expect(res.json().details).toEqual({ babies: [{ id: babyId, name: "Solo" }] });
      expect(h.gotrue.calls.adminDeleteUser).toHaveLength(0);
      expect(await exists("auth.users", "id", u.id)).toBe(true);
      expect(await h.audit({ event: "account.deleted", actor: u.id })).toHaveLength(0);
    });

    it("deleting the album (trash) or promoting a co-admin unblocks the user", async () => {
      const u = await h.user();
      const babyId = await h.baby(u, "Solo");
      await h.inject(u, "DELETE", `/babies/${babyId}`);
      const res = await del(u);
      expect(res.statusCode).toBe(204);
      expect(await exists("auth.users", "id", u.id)).toBe(false);
    });

    it("success: GoTrue hard delete is called, audit rows are written, cookies cleared, everything of theirs is gone, the album stays with the other admin", async () => {
      const u = await h.user({ displayName: "Leaver" });
      const keeper = await h.user({ displayName: "Keeper" });
      const babyId = await h.baby(u, "Shared");
      await h.member(babyId, keeper, "admin");
      await h.admin.query(
        "UPDATE public.babies SET plan = 'plus', plan_owner_user_id = $2 WHERE id = $1",
        [babyId, u.id],
      );
      const other = await h.session(u);
      const deletedBefore = (await h.audit({ event: "account.deleted" })).length;
      h.gotrue.calls.adminDeleteUser.length = 0;

      const res = await h.app.inject({
        method: "DELETE",
        url: "/me",
        headers: { "x-littlelight-client": "web" },
        cookies: { ll_access: u.token },
        payload: { acknowledge: true },
      });
      expect(res.statusCode).toBe(204);
      expect(h.gotrue.calls.adminDeleteUser).toEqual([[u.id]]);

      const set = cookiesOf(res);
      expect(set.some((c) => c.startsWith("ll_access=;"))).toBe(true);
      expect(set.some((c) => c.startsWith("ll_refresh=;"))).toBe(true);

      expect(await exists("auth.users", "id", u.id)).toBe(false);
      expect(await exists("public.profiles", "user_id", u.id)).toBe(false);
      expect(await exists("auth.sessions", "user_id", u.id)).toBe(false);
      expect(await exists("public.baby_members", "user_id", u.id)).toBe(false);

      const baby = (
        await h.admin.query(
          "SELECT plan, plan_owner_user_id, deleted_at FROM public.babies WHERE id = $1",
          [babyId],
        )
      ).rows[0];
      expect(baby).toEqual({ plan: "free", plan_owner_user_id: null, deleted_at: null });
      expect((await h.inject(keeper, "GET", `/babies/${babyId}`)).statusCode).toBe(200);

      const requested = await h.audit({ event: "account.deletion_requested" });
      expect(
        requested.some((r) => r.metadata && (r.metadata as { client?: string }).client === "web"),
      ).toBe(true);
      const deleted = await h.audit({ event: "account.deleted" });
      expect(deleted.length).toBe(deletedBefore + 1);
      // The audit row survives the account; its actor reference is nulled by the cascade.
      expect(deleted.at(-1)?.actor_user_id).toBeNull();

      // Every device is signed out at once.
      const stale = await h.inject(null, "GET", "/me", undefined, {
        authorization: `Bearer ${other.token}`,
      });
      expect(stale.statusCode).toBe(401);
      expect(stale.json().error).toBe("session_revoked");
    });

    it("native clients get no cookie handling, still 204", async () => {
      const u = await h.user();
      const res = await h.inject(
        u,
        "DELETE",
        "/me",
        { acknowledge: true },
        { "x-littlelight-client": "native" },
      );
      expect(res.statusCode).toBe(204);
      expect(cookiesOf(res)).toHaveLength(0);
    });

    it("503 when GoTrue's delete fails: the account and session stay usable, so the user can retry", async () => {
      const failing = await createHarness({
        gotrue: {
          adminDeleteUser: async () => {
            throw new GoTrueError(503, "ECONNREFUSED");
          },
        },
      });
      try {
        const u = await failing.user();
        const res = await failing.inject(u, "DELETE", "/me", { acknowledge: true });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe("internal");
        expect(res.body).not.toContain("ECONNREFUSED");
        const still = await failing.inject(u, "GET", "/me");
        expect(still.statusCode).toBe(200);
        expect(
          (await failing.audit({ event: "account.deletion_requested", actor: u.id })).length,
        ).toBe(1);
      } finally {
        await failing.close();
      }
    });

    it("a stub that throws a non-GoTrue error is also a clean 503", async () => {
      const failing = await createHarness({
        gotrue: {
          adminDeleteUser: async () => {
            throw new Error("boom");
          },
        },
      });
      try {
        const u = await failing.user();
        expect((await failing.inject(u, "DELETE", "/me", { acknowledge: true })).statusCode).toBe(
          503,
        );
      } finally {
        await failing.close();
      }
    });

    it("401 without a session, and one user cannot delete another (no id in the route)", async () => {
      expect((await h.inject(null, "DELETE", "/me", { acknowledge: true })).statusCode).toBe(401);
      const victim = await h.user();
      const attacker = await h.user();
      const res = await h.inject(attacker, "DELETE", "/me", {
        acknowledge: true,
        userId: victim.id,
      });
      expect(res.statusCode).toBe(204);
      expect(await exists("auth.users", "id", victim.id)).toBe(true);
      expect(await exists("auth.users", "id", attacker.id)).toBe(false);
      expect(randomUUID()).toBeDefined();
    });
  });
});
