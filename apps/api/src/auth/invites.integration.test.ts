import { randomUUID } from "node:crypto";
import {
  INVITES_PER_BABY_PER_DAY,
  inviteAcceptResponseSchema,
  inviteEmailMismatchMessage,
  inviteLookupResponseSchema,
  inviteSchema,
} from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";

// Invites (PRD "Invites", FR-1.3; docs/plans/step-3.md 3.5, 3.10). The acceptance check for the
// step ("invite a co-admin, the invitee accepts with the matching email; mismatched email is
// rejected") is covered at HTTP level here; the browser version is the e2e (3.12).

const TOKEN_IN_MAIL = /\/invite\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;

describe.skipIf(!databaseUrl)("invites", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  let n = 0;
  const emailFor = (tag: string) => `${tag}-${++n}-${randomUUID().slice(0, 6)}@example.test`;
  let ipN = 0;
  const freshIp = () => `198.51.100.${(++ipN % 250) + 1}`;

  /** Admin + baby. */
  async function setup() {
    const admin = await h.user({ displayName: "Maria" });
    const babyId = await h.baby(admin, "Mia");
    return { admin, babyId };
  }

  /** Create an invite through the API and return {invite, token} (token read from the mail). */
  async function invite(
    admin: TestUser,
    babyId: string,
    email: string,
    role: "admin" | "contributor" = "contributor",
  ) {
    h.mailer.clear();
    const res = await h.inject(admin, "POST", `/babies/${babyId}/invites`, { email, role });
    expect(res.statusCode, res.body).toBe(201);
    const mail = h.mailer.sent.find((m) => m.to === email.toLowerCase());
    const token = TOKEN_IN_MAIL.exec(mail?.text ?? "")?.[1];
    if (!token) throw new Error("no invite link in the mail");
    return { invite: inviteSchema.parse(res.json()), token, mail };
  }

  const lookup = (token: string, ip = freshIp()) =>
    h.inject(null, "GET", `/invites/${token}`, undefined, { "cf-connecting-ip": ip });
  const accept = (u: TestUser | null, token: string) =>
    h.inject(u, "POST", `/invites/${token}/accept`, undefined, { "cf-connecting-ip": freshIp() });

  describe("create", () => {
    it("201; the token is only in the mail (never in the body); the stored value is a hash", async () => {
      const { admin, babyId } = await setup();
      const email = emailFor("invitee");
      const { invite: inv, token, mail } = await invite(admin, babyId, email, "admin");
      expect(inv).toMatchObject({ email, role: "admin", status: "pending" });
      expect(Date.parse(inv.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
      expect(Date.parse(inv.expiresAt) - Date.now()).toBeLessThan(7.1 * 86_400_000);

      const res = await h.inject(admin, "GET", `/babies/${babyId}/members`);
      expect(JSON.stringify(res.json())).not.toContain(token);

      expect(mail?.subject).toContain("Mia");
      expect(mail?.text).toContain("Maria");
      expect(mail?.text).toContain(`http://localhost:8080/invite/${token}`);
      expect(mail?.html).toContain(token);

      const row = (
        await h.admin.query(
          "SELECT encode(token_hash, 'hex') AS hex FROM public.invites WHERE id = $1",
          [inv.id],
        )
      ).rows[0];
      expect(row.hex).toHaveLength(64);
      expect(row.hex).not.toContain(token);

      const audit = await h.audit({ event: "invite.sent", baby: babyId });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toEqual({ role: "admin", invite_id: inv.id });
      expect(JSON.stringify(audit)).not.toContain(email);
    });

    it("normalises the email (case, whitespace) before storing and mailing", async () => {
      const { admin, babyId } = await setup();
      const raw = emailFor("MixedCase").toUpperCase();
      const res = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email: `  ${raw} `,
        role: "contributor",
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().email).toBe(raw.toLowerCase());
      expect(h.mailer.sent.at(-1)?.to).toBe(raw.toLowerCase());
    });

    it("409 invite_exists for a second live invite to the same address; fine after revoking", async () => {
      const { admin, babyId } = await setup();
      const email = emailFor("dup");
      const first = await invite(admin, babyId, email);
      const again = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email: email.toUpperCase(),
        role: "contributor",
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("invite_exists");
      expect(
        (await h.inject(admin, "DELETE", `/babies/${babyId}/invites/${first.invite.id}`))
          .statusCode,
      ).toBe(204);
      const third = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email,
        role: "contributor",
      });
      expect(third.statusCode).toBe(201);
    });

    it("an expired, never-revoked invite is retired and a fresh one goes out", async () => {
      const { admin, babyId } = await setup();
      const email = emailFor("expired");
      const old = await invite(admin, babyId, email);
      await h.admin.query(
        "UPDATE public.invites SET expires_at = now() - interval '1 hour' WHERE id = $1",
        [old.invite.id],
      );
      const fresh = await invite(admin, babyId, email);
      expect(fresh.invite.id).not.toBe(old.invite.id);
      const olds = (
        await h.admin.query("SELECT revoked_at FROM public.invites WHERE id = $1", [old.invite.id])
      ).rows[0];
      expect(olds.revoked_at).toBeInstanceOf(Date);
      expect((await lookup(old.token)).json().status).toBe("revoked");
    });

    it("409 already_member for the caller's own email and for a member who joined on an invite", async () => {
      const { admin, babyId } = await setup();
      const own = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email: admin.email.toUpperCase(),
        role: "contributor",
      });
      expect(own.statusCode).toBe(409);
      expect(own.json().error).toBe("already_member");

      const guest = await h.user();
      const { token } = await invite(admin, babyId, guest.email);
      expect((await accept(guest, token)).statusCode).toBe(200);
      const again = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email: guest.email,
        role: "contributor",
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("already_member");
    });

    it("409 admins_full at creation time when two admins already exist (contributors still fine)", async () => {
      const { admin, babyId } = await setup();
      const second = await h.user();
      await h.member(babyId, second, "admin");
      const res = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email: emailFor("third"),
        role: "admin",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("admins_full");
      const ok = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email: emailFor("contrib"),
        role: "contributor",
      });
      expect(ok.statusCode).toBe(201);
    });

    it("the 21st invite in a day is 429 with Retry-After 3600", async () => {
      const { admin, babyId } = await setup();
      for (let i = 0; i < INVITES_PER_BABY_PER_DAY; i++) {
        const res = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
          email: emailFor(`bulk${i}`),
          role: "contributor",
        });
        expect(res.statusCode, `invite ${i + 1}`).toBe(201);
      }
      const res = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email: emailFor("one-too-many"),
        role: "contributor",
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("rate_limited");
      expect(res.headers["retry-after"]).toBe("3600");
    });

    it("only admins: contributor 403, stranger 404, no consent 403; nothing is mailed", async () => {
      const { admin, babyId } = await setup();
      const contrib = await h.user();
      await h.member(babyId, contrib, "contributor");
      const stranger = await h.user();
      const noConsent = await h.user({ consent: false });
      h.mailer.clear();
      const body = { email: emailFor("x"), role: "contributor" };
      expect((await h.inject(contrib, "POST", `/babies/${babyId}/invites`, body)).statusCode).toBe(
        403,
      );
      expect((await h.inject(stranger, "POST", `/babies/${babyId}/invites`, body)).statusCode).toBe(
        404,
      );
      expect(
        (await h.inject(noConsent, "POST", `/babies/${babyId}/invites`, body)).json().error,
      ).toBe("consent_required");
      expect((await h.inject(null, "POST", `/babies/${babyId}/invites`, body)).statusCode).toBe(
        401,
      );
      expect(h.mailer.sent).toHaveLength(0);
      expect(admin).toBeDefined();
    });

    it("rejects bad email / role, and a trashed baby is 409", async () => {
      const { admin, babyId } = await setup();
      for (const body of [
        { email: "nope", role: "admin" },
        { email: emailFor("r"), role: "owner" },
        { role: "admin" },
      ]) {
        expect((await h.inject(admin, "POST", `/babies/${babyId}/invites`, body)).statusCode).toBe(
          400,
        );
      }
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [babyId]);
      const res = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email: emailFor("t"),
        role: "contributor",
      });
      expect(res.statusCode).toBe(409);
    });

    it("a mail failure is 503 and leaves no invite behind (retry works)", async () => {
      const { admin, babyId } = await setup();
      const email = emailFor("mailfail");
      const original = h.mailer.send;
      (h.mailer as { send: unknown }).send = async () => {
        throw new Error("smtp down");
      };
      try {
        const res = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
          email,
          role: "contributor",
        });
        expect(res.statusCode).toBe(503);
      } finally {
        (h.mailer as { send: unknown }).send = original;
      }
      const { rows } = await h.admin.query("SELECT 1 FROM public.invites WHERE baby_id = $1", [
        babyId,
      ]);
      expect(rows).toHaveLength(0);
      expect(
        (await h.inject(admin, "POST", `/babies/${babyId}/invites`, { email, role: "contributor" }))
          .statusCode,
      ).toBe(201);
    });
  });

  describe("lookup (public)", () => {
    it("valid: baby, inviter, role, masked email only; no auth needed", async () => {
      const { admin, babyId } = await setup();
      const email = emailFor("maria");
      const { token } = await invite(admin, babyId, email, "contributor");
      const res = await lookup(token);
      expect(res.statusCode).toBe(200);
      const body = inviteLookupResponseSchema.parse(res.json());
      expect(body).toMatchObject({
        status: "valid",
        babyName: "Mia",
        inviterName: "Maria",
        role: "contributor",
      });
      expect(body.maskedEmail).toBe(`${email[0]}***@example.test`);
      expect(res.body).not.toContain(email);
    });

    it("unknown token is 404 invite_not_found; a malformed token is 400", async () => {
      const unknown = await lookup("A".repeat(43));
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error).toBe("invite_not_found");
      expect((await lookup("short")).statusCode).toBe(400);
    });

    it("reports revoked, accepted and expired", async () => {
      const { admin, babyId } = await setup();
      const rev = await invite(admin, babyId, emailFor("rev"));
      await h.inject(admin, "DELETE", `/babies/${babyId}/invites/${rev.invite.id}`);
      expect((await lookup(rev.token)).json().status).toBe("revoked");

      const exp = await invite(admin, babyId, emailFor("exp"));
      await h.admin.query(
        "UPDATE public.invites SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [exp.invite.id],
      );
      expect((await lookup(exp.token)).json().status).toBe("expired");

      const guest = await h.user();
      const acc = await invite(admin, babyId, guest.email);
      await accept(guest, acc.token);
      expect((await lookup(acc.token)).json().status).toBe("accepted");
    });

    it("a trashed baby's invite is 404 (its name must not leak)", async () => {
      const { admin, babyId } = await setup();
      const { token } = await invite(admin, babyId, emailFor("trash"));
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [babyId]);
      const res = await lookup(token);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("Mia");
    });

    it("inviterName is null when the inviter's account no longer exists", async () => {
      const { admin, babyId } = await setup();
      const { invite: inv, token } = await invite(admin, babyId, emailFor("orphan"));
      await h.admin.query("UPDATE public.invites SET invited_by = NULL WHERE id = $1", [inv.id]);
      expect((await lookup(token)).json().inviterName).toBeNull();
    });

    it("is limited to 60 lookups per IP per hour", async () => {
      const ip = "203.0.113.200";
      const token = "B".repeat(43);
      for (let i = 0; i < 60; i++) {
        expect((await lookup(token, ip)).statusCode).toBe(404);
      }
      const limited = await lookup(token, ip);
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
      expect((await lookup(token, "203.0.113.201")).statusCode).toBe(404);
    });
  });

  describe("accept", () => {
    it("401 without a session", async () => {
      const { admin, babyId } = await setup();
      const { token } = await invite(admin, babyId, emailFor("anon"));
      expect((await accept(null, token)).statusCode).toBe(401);
    });

    it("the matching email joins: co-admin invite accepted end to end", async () => {
      const { admin, babyId } = await setup();
      const partner = await h.user({ displayName: "Dad" });
      const { invite: inv, token } = await invite(admin, babyId, partner.email, "admin");
      const res = await accept(partner, token);
      expect(res.statusCode).toBe(200);
      expect(inviteAcceptResponseSchema.parse(res.json())).toEqual({ babyId, role: "admin" });

      const member = (
        await h.admin.query(
          "SELECT role, invited_by FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
          [babyId, partner.id],
        )
      ).rows[0];
      expect(member).toEqual({ role: "admin", invited_by: admin.id });
      const row = (
        await h.admin.query("SELECT accepted_at, accepted_by FROM public.invites WHERE id = $1", [
          inv.id,
        ])
      ).rows[0];
      expect(row.accepted_at).toBeInstanceOf(Date);
      expect(row.accepted_by).toBe(partner.id);

      const audit = await h.audit({ event: "invite.accepted", baby: babyId });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: partner.id });
      expect(audit[0]?.metadata).toEqual({ role: "admin", invite_id: inv.id });

      // The new admin now sees the baby and the member list.
      expect((await h.inject(partner, "GET", `/babies/${babyId}`)).json().role).toBe("admin");
      const members = (await h.inject(partner, "GET", `/babies/${babyId}/members`)).json().members;
      expect(members).toHaveLength(2);
    });

    it("a mismatched email is rejected with the exact masked message and nothing changes", async () => {
      const { admin, babyId } = await setup();
      const email = emailFor("maria");
      const { invite: inv, token } = await invite(admin, babyId, email, "admin");
      const wrong = await h.user();
      const res = await accept(wrong, token);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("invite_email_mismatch");
      expect(res.json().message).toBe(inviteEmailMismatchMessage(email));
      expect(res.json().message).toBe(`This invite was sent to ${email[0]}***@example.test`);
      expect(res.body).not.toContain(email);
      const member = await h.admin.query(
        "SELECT 1 FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [babyId, wrong.id],
      );
      expect(member.rows).toHaveLength(0);
      const row = (
        await h.admin.query("SELECT accepted_at FROM public.invites WHERE id = $1", [inv.id])
      ).rows[0];
      expect(row.accepted_at).toBeNull();
      expect((await h.inject(wrong, "GET", `/babies/${babyId}`)).statusCode).toBe(404);
      expect(await h.audit({ event: "invite.accepted", baby: babyId })).toHaveLength(0);
    });

    it("the email comparison is case-insensitive in both directions", async () => {
      const { admin, babyId } = await setup();
      const mixed = emailFor("CaseUser").replace("caseuser", "CaseUser");
      const guest = await h.user({ email: mixed });
      const { token } = await invite(admin, babyId, mixed.toLowerCase());
      expect((await accept(guest, token)).statusCode).toBe(200);
    });

    it("consent gate: a signed-in user who has not accepted the terms cannot accept (no membership)", async () => {
      const { admin, babyId } = await setup();
      const guest = await h.user({ consent: false });
      const { token } = await invite(admin, babyId, guest.email);
      const res = await accept(guest, token);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("consent_required");
      const member = await h.admin.query(
        "SELECT 1 FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [babyId, guest.id],
      );
      expect(member.rows).toHaveLength(0);
    });

    it("an accepted invite cannot be used again: 410 invite_accepted", async () => {
      const { admin, babyId } = await setup();
      const guest = await h.user();
      const { token } = await invite(admin, babyId, guest.email);
      expect((await accept(guest, token)).statusCode).toBe(200);
      const again = await accept(guest, token);
      expect(again.statusCode).toBe(410);
      expect(again.json().error).toBe("invite_accepted");
    });

    it("a removed member cannot rejoin on the invite they already used", async () => {
      const { admin, babyId } = await setup();
      const guest = await h.user();
      const { token } = await invite(admin, babyId, guest.email);
      await accept(guest, token);
      await h.admin.query("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [
        babyId,
        guest.id,
      ]);
      const res = await accept(guest, token);
      expect(res.statusCode).toBe(410);
    });

    it("revoked and expired invites are 410", async () => {
      const { admin, babyId } = await setup();
      const guest = await h.user();
      const rev = await invite(admin, babyId, guest.email);
      await h.inject(admin, "DELETE", `/babies/${babyId}/invites/${rev.invite.id}`);
      const r1 = await accept(guest, rev.token);
      expect(r1.statusCode).toBe(410);
      expect(r1.json().error).toBe("invite_revoked");

      const exp = await invite(admin, babyId, guest.email);
      await h.admin.query(
        "UPDATE public.invites SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [exp.invite.id],
      );
      const r2 = await accept(guest, exp.token);
      expect(r2.statusCode).toBe(410);
      expect(r2.json().error).toBe("invite_expired");
      const member = await h.admin.query(
        "SELECT 1 FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [babyId, guest.id],
      );
      expect(member.rows).toHaveLength(0);
    });

    it("409 already_member for someone who is already in the album", async () => {
      const { admin, babyId } = await setup();
      const guest = await h.user();
      const { token } = await invite(admin, babyId, guest.email, "admin");
      await h.member(babyId, guest, "contributor");
      // Direct add consumes the pending invite (trigger), so the link is spent, not "already member".
      const res = await accept(guest, token);
      expect([409, 410]).toContain(res.statusCode);
      const role = (
        await h.admin.query(
          "SELECT role FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
          [babyId, guest.id],
        )
      ).rows[0];
      expect(role.role).toBe("contributor");
    });

    it("trigger admins_full: two admin invites out, only the first acceptance wins", async () => {
      const { admin, babyId } = await setup();
      const b = await h.user();
      const c = await h.user();
      const ib = await invite(admin, babyId, b.email, "admin");
      const ic = await invite(admin, babyId, c.email, "admin");
      expect((await accept(b, ib.token)).statusCode).toBe(200);
      const res = await accept(c, ic.token);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("admins_full");
      const member = await h.admin.query(
        "SELECT 1 FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [babyId, c.id],
      );
      expect(member.rows).toHaveLength(0);
      // The failed accept did not burn the invite.
      const row = (
        await h.admin.query("SELECT accepted_at FROM public.invites WHERE id = $1", [ic.invite.id])
      ).rows[0];
      expect(row.accepted_at).toBeNull();
    });

    it("a trashed baby's invite cannot be accepted (404)", async () => {
      const { admin, babyId } = await setup();
      const guest = await h.user();
      const { token } = await invite(admin, babyId, guest.email);
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [babyId]);
      expect((await accept(guest, token)).statusCode).toBe(404);
    });

    it("an unknown token is 404 and malformed is 400", async () => {
      const u = await h.user();
      expect((await accept(u, "C".repeat(43))).statusCode).toBe(404);
      expect((await accept(u, "nope")).statusCode).toBe(400);
    });
  });

  describe("resend", () => {
    it("rotates the token: the old link dies, the new one works, the expiry is renewed, mail goes out", async () => {
      const { admin, babyId } = await setup();
      const email = emailFor("resend");
      const first = await invite(admin, babyId, email);
      await h.admin.query(
        "UPDATE public.invites SET expires_at = now() + interval '1 hour' WHERE id = $1",
        [first.invite.id],
      );
      h.mailer.clear();
      const res = await h.inject(
        admin,
        "POST",
        `/babies/${babyId}/invites/${first.invite.id}/resend`,
      );
      expect(res.statusCode).toBe(200);
      const body = inviteSchema.parse(res.json());
      expect(body.id).toBe(first.invite.id);
      expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
      const newToken = TOKEN_IN_MAIL.exec(h.mailer.sent[0]?.text ?? "")?.[1];
      expect(newToken).toBeDefined();
      expect(newToken).not.toBe(first.token);
      expect((await lookup(first.token)).statusCode).toBe(404);
      expect((await lookup(newToken as string)).json().status).toBe("valid");
      expect(await h.audit({ event: "invite.resent", baby: babyId })).toHaveLength(1);
    });

    it("renews an expired (never revoked) invite", async () => {
      const { admin, babyId } = await setup();
      const first = await invite(admin, babyId, emailFor("renew"));
      await h.admin.query(
        "UPDATE public.invites SET expires_at = now() - interval '1 hour' WHERE id = $1",
        [first.invite.id],
      );
      const res = await h.inject(
        admin,
        "POST",
        `/babies/${babyId}/invites/${first.invite.id}/resend`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("pending");
    });

    it("410 for revoked and accepted invites; 404 for another baby's invite; 403 for a contributor", async () => {
      const { admin, babyId } = await setup();
      const rev = await invite(admin, babyId, emailFor("r1"));
      await h.inject(admin, "DELETE", `/babies/${babyId}/invites/${rev.invite.id}`);
      const r1 = await h.inject(admin, "POST", `/babies/${babyId}/invites/${rev.invite.id}/resend`);
      expect(r1.statusCode).toBe(410);
      expect(r1.json().error).toBe("invite_revoked");

      const guest = await h.user();
      const acc = await invite(admin, babyId, guest.email);
      await accept(guest, acc.token);
      const r2 = await h.inject(admin, "POST", `/babies/${babyId}/invites/${acc.invite.id}/resend`);
      expect(r2.statusCode).toBe(410);
      expect(r2.json().error).toBe("invite_accepted");

      const other = await setup();
      const foreign = await invite(other.admin, other.babyId, emailFor("foreign"));
      expect(
        (await h.inject(admin, "POST", `/babies/${babyId}/invites/${foreign.invite.id}/resend`))
          .statusCode,
      ).toBe(404);

      const contrib = await h.user();
      await h.member(babyId, contrib, "contributor");
      const live = await invite(admin, babyId, emailFor("live"));
      expect(
        (await h.inject(contrib, "POST", `/babies/${babyId}/invites/${live.invite.id}/resend`))
          .statusCode,
      ).toBe(403);
    });
  });

  describe("revoke", () => {
    it("204, audited once, idempotent, and the link stops working", async () => {
      const { admin, babyId } = await setup();
      const guest = await h.user();
      const { invite: inv, token } = await invite(admin, babyId, guest.email);
      expect(
        (await h.inject(admin, "DELETE", `/babies/${babyId}/invites/${inv.id}`)).statusCode,
      ).toBe(204);
      expect(
        (await h.inject(admin, "DELETE", `/babies/${babyId}/invites/${inv.id}`)).statusCode,
      ).toBe(204);
      expect(await h.audit({ event: "invite.revoked", baby: babyId })).toHaveLength(1);
      expect((await lookup(token)).json().status).toBe("revoked");
      expect((await accept(guest, token)).statusCode).toBe(410);
    });

    it("an accepted invite cannot be revoked (410); unknown 404; contributor and stranger 404", async () => {
      const { admin, babyId } = await setup();
      const guest = await h.user();
      const { invite: inv, token } = await invite(admin, babyId, guest.email);
      await accept(guest, token);
      const r = await h.inject(admin, "DELETE", `/babies/${babyId}/invites/${inv.id}`);
      expect(r.statusCode).toBe(410);
      expect(r.json().error).toBe("invite_accepted");
      expect(
        (await h.inject(admin, "DELETE", `/babies/${babyId}/invites/${randomUUID()}`)).statusCode,
      ).toBe(404);

      const live = await invite(admin, babyId, emailFor("live"));
      // A contributor cannot even see the invite (RLS: invites are admin-only), so it is a 404;
      // an invisible invite and a missing one look the same.
      expect(
        (await h.inject(guest, "DELETE", `/babies/${babyId}/invites/${live.invite.id}`)).statusCode,
      ).toBe(404);
      const stranger = await h.user();
      expect(
        (await h.inject(stranger, "DELETE", `/babies/${babyId}/invites/${live.invite.id}`))
          .statusCode,
      ).toBe(404);
      const still = (
        await h.admin.query("SELECT revoked_at FROM public.invites WHERE id = $1", [live.invite.id])
      ).rows[0];
      expect(still.revoked_at).toBeNull();
    });
  });
});
