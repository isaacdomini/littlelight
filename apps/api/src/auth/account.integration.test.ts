import { randomUUID } from "node:crypto";
import { deletionPreviewResponseSchema } from "@tinyglow/shared";
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
      expect(body).toEqual({
        googlePhotosConnected: false,
        blockingBabies: [],
        babiesKept: [],
        freshSignIn: false,
      });
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
        headers: { "x-tinyglow-client": "web" },
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
        { "x-tinyglow-client": "native" },
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
  describe("DELETE /me: compensation and the single account.deleted row (review-fixes D14)", () => {
    const deletedRows = async (uid: string) =>
      (
        await h.admin.query(
          "SELECT actor_user_id, metadata FROM public.audit_log WHERE event = 'account.deleted' AND metadata ->> 'target_user_id' = $1",
          [uid],
        )
      ).rows;
    const deletedAt = async (uid: string) =>
      (await h.admin.query("SELECT deleted_at FROM public.profiles WHERE user_id = $1", [uid]))
        .rows[0]?.deleted_at ?? null;

    it("GoTrue down: 503, profile deleted_at back to NULL, no account.deleted row; the retry succeeds with exactly one row naming the target", async () => {
      let up = false;
      const flaky = await createHarness({
        gotrue: {
          adminDeleteUser: async (uid: string) => {
            if (!up) throw new GoTrueError(503, "ECONNREFUSED");
            await flaky.admin.query("DELETE FROM auth.users WHERE id = $1", [uid]);
          },
        },
      });
      try {
        const u = await flaky.user();
        const first = await flaky.inject(u, "DELETE", "/me", { acknowledge: true });
        expect(first.statusCode).toBe(503);
        const mark = (
          await flaky.admin.query("SELECT deleted_at FROM public.profiles WHERE user_id = $1", [
            u.id,
          ])
        ).rows[0];
        expect(mark.deleted_at).toBeNull();
        const none = await flaky.admin.query(
          "SELECT 1 FROM public.audit_log WHERE event = 'account.deleted' AND metadata ->> 'target_user_id' = $1",
          [u.id],
        );
        expect(none.rowCount).toBe(0);
        // the account is fully usable: still a live member everywhere, still signed in
        expect((await flaky.inject(u, "GET", "/me")).statusCode).toBe(200);

        up = true;
        const second = await flaky.inject(u, "DELETE", "/me", { acknowledge: true });
        expect(second.statusCode).toBe(204);
        const rows = await flaky.admin.query(
          "SELECT actor_user_id, metadata FROM public.audit_log WHERE event = 'account.deleted' AND metadata ->> 'target_user_id' = $1",
          [u.id],
        );
        expect(rows.rowCount).toBe(1);
        expect(rows.rows[0].actor_user_id).toBeNull();
        expect(rows.rows[0].metadata).toEqual({ client: "web", target_user_id: u.id });
      } finally {
        await flaky.close();
      }
    });

    it("while GoTrue works the profile is pre-marked (co-members see a nameless row); after a failed attempt the name is back", async () => {
      let during: string[] | null = null;
      let ctx: { keeper: Awaited<ReturnType<typeof h.user>>; babyId: string } = {
        keeper: undefined as never,
        babyId: "",
      };
      const probe = await createHarness({
        gotrue: {
          adminDeleteUser: async () => {
            const res = await probe.inject(ctx.keeper, "GET", `/babies/${ctx.babyId}/members`);
            during = res
              .json()
              .members.map((m: { displayName: string }) => m.displayName)
              .sort();
            throw new GoTrueError(503, "down");
          },
        },
      });
      try {
        const leaver = await probe.user({ displayName: "Leaver" });
        const keeper = await probe.user({ displayName: "Keeper" });
        const babyId = await probe.baby(keeper, "Shared");
        await probe.member(babyId, leaver, "admin");
        ctx = { keeper, babyId };
        const res = await probe.inject(leaver, "DELETE", "/me", { acknowledge: true });
        expect(res.statusCode).toBe(503);
        expect(during).toEqual(["", "Keeper"]);
        const after = (await probe.inject(keeper, "GET", `/babies/${babyId}/members`)).json();
        expect(after.members.map((m: { displayName: string }) => m.displayName).sort()).toEqual([
          "Keeper",
          "Leaver",
        ]);
      } finally {
        await probe.close();
      }
    });

    it("GoTrue reports a failure but the user is gone (timeout): treated as success, one account.deleted row", async () => {
      const lost = await createHarness({
        gotrue: {
          adminDeleteUser: async (uid: string) => {
            await lost.admin.query("DELETE FROM auth.users WHERE id = $1", [uid]);
            throw new GoTrueError(504, "gateway timeout");
          },
        },
      });
      try {
        const u = await lost.user();
        const res = await lost.inject(u, "DELETE", "/me", { acknowledge: true });
        expect(res.statusCode).toBe(204);
        const rows = await lost.admin.query(
          "SELECT 1 FROM public.audit_log WHERE event = 'account.deleted' AND metadata ->> 'target_user_id' = $1",
          [u.id],
        );
        expect(rows.rowCount).toBe(1);
      } finally {
        await lost.close();
      }
    });

    it("a failing delete never leaves a pre-mark behind, whatever the error type", async () => {
      for (const err of [new GoTrueError(500, "boom"), new Error("network down")]) {
        const bad = await createHarness({
          gotrue: {
            adminDeleteUser: async () => {
              throw err;
            },
          },
        });
        try {
          const u = await bad.user();
          expect((await bad.inject(u, "DELETE", "/me", { acknowledge: true })).statusCode).toBe(
            503,
          );
          const r = await bad.admin.query(
            "SELECT deleted_at FROM public.profiles WHERE user_id = $1",
            [u.id],
          );
          expect(r.rows[0].deleted_at).toBeNull();
        } finally {
          await bad.close();
        }
      }
    });

    it("the sole-admin 409 leaves the profile untouched and writes no account.deleted row", async () => {
      const u = await h.user();
      await h.baby(u, "Solo");
      expect((await del(u)).statusCode).toBe(409);
      expect(await deletedAt(u.id)).toBeNull();
      expect(await deletedRows(u.id)).toEqual([]);
    });

    it("a successful deletion writes one account.deleted row with the target in metadata", async () => {
      const u = await h.user();
      expect((await del(u)).statusCode).toBe(204);
      const rows = await deletedRows(u.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBeNull();
      expect(rows[0].metadata).toMatchObject({ target_user_id: u.id });
      expect(JSON.stringify(rows[0].metadata)).not.toContain("@");
    });
  });

  describe("GET /me/deletion-preview: the co-admin's name comes from member_profiles", () => {
    it("falls back to 'the other admin' when the co-admin's profile is mid-deletion", async () => {
      const u = await h.user({ displayName: "Alice" });
      const other = await h.user({ displayName: "Bob" });
      const babyId = await h.baby(u, "Shared");
      await h.member(babyId, other, "admin");
      await h.admin.query("UPDATE public.profiles SET deleted_at = now() WHERE user_id = $1", [
        other.id,
      ]);
      const body = deletionPreviewResponseSchema.parse(
        (await h.inject(u, "GET", "/me/deletion-preview")).json(),
      );
      expect(body.babiesKept).toEqual([
        { id: babyId, name: "Shared", otherAdminName: "the other admin" },
      ]);
    });
  });
});
