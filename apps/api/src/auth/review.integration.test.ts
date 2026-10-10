import { randomUUID } from "node:crypto";
import { reviewBabyId } from "@tinyglow/db/review";
import { sessionResponseSchema } from "@tinyglow/shared";
import { afterEach, describe, expect, it } from "vitest";
import { hashPasscode } from "../sharing/crypto";
import { createHarness, databaseUrl, type Harness } from "../testing/integration";
import { GoTrueError } from "./gotrue";

// Store-review sign-in against a real database (docs/plans/step-9.md 2.5, 2.15; D4): off by
// default, a static 6-digit code for exactly one configured account, throttled like any code, and
// refused for an account that belongs to a real family. The config is the only source.

const CODE = "482915";
const NATIVE = { "x-tinyglow-client": "native" };
const WEB = { "x-tinyglow-client": "web" };
let hash: string;

describe.skipIf(!databaseUrl)("review sign-in (api + db)", () => {
  const open: Harness[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()?.close();
  });

  async function harness(
    review: boolean,
    email = `review-${randomUUID().slice(0, 8)}@example.test`,
    extra: Parameters<typeof createHarness>[0] = {},
  ) {
    hash ??= await hashPasscode(CODE);
    const h = await createHarness({
      ...extra,
      config: {
        ...(review ? { REVIEW_ACCOUNT_EMAIL: email, REVIEW_ACCOUNT_CODE_HASH: hash } : {}),
        ...extra.config,
      },
    });
    open.push(h);
    return { h, email };
  }

  const verify = (h: Harness, email: string, code: string, headers = NATIVE) =>
    h.app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { ...headers, "cf-connecting-ip": "198.51.100.77" },
      payload: { email, code },
    });
  const otp = (h: Harness, email: string, headers = NATIVE) =>
    h.app.inject({
      method: "POST",
      url: "/auth/otp",
      headers: { ...headers, "cf-connecting-ip": "198.51.100.78" },
      payload: { email },
    });

  describe("off (the default)", () => {
    it("POST /auth/otp sends the normal email code for any address", async () => {
      const { h, email } = await harness(false);
      const res = await otp(h, email);
      expect(res.statusCode).toBe(202);
      expect(h.gotrue.calls.sendOtp).toHaveLength(1);
      expect(h.gotrue.calls.sendOtp[0]?.[0]).toBe(email);
    });

    it("the static code is just a code: verify goes to GoTrue's normal verify, never generate_link", async () => {
      const { h, email } = await harness(false);
      h.gotrue.impl.verify = async () => {
        throw new GoTrueError(403, "otp_expired");
      };
      const res = await verify(h, email, CODE);
      expect(res.statusCode).toBe(400);
      expect(h.gotrue.calls.verify).toHaveLength(1);
      expect(h.gotrue.calls.verify[0]?.[0]).toMatchObject({ kind: "code", email, token: CODE });
      expect(h.gotrue.calls.adminGenerateMagicLink).toHaveLength(0);
    });

    it("process.env alone cannot switch it on", async () => {
      const email = `env-${randomUUID().slice(0, 8)}@example.test`;
      process.env.REVIEW_ACCOUNT_EMAIL = email;
      process.env.REVIEW_ACCOUNT_CODE_HASH = await hashPasscode(CODE);
      try {
        const { h } = await harness(false);
        const user = await h.user({ email });
        h.gotrue.impl.verify = async () => {
          throw new GoTrueError(403, "otp_expired");
        };
        const res = await verify(h, user.email, CODE);
        expect(res.statusCode).toBe(400);
        expect(h.gotrue.calls.adminGenerateMagicLink).toHaveLength(0);
        await otp(h, user.email);
        expect(h.gotrue.calls.sendOtp).toHaveLength(1);
      } finally {
        delete process.env.REVIEW_ACCOUNT_EMAIL;
        delete process.env.REVIEW_ACCOUNT_CODE_HASH;
      }
    });

    it("the review account can accept an invite when the feature is off", async () => {
      const { h, email } = await harness(false);
      const admin = await h.user();
      const babyId = await h.baby(admin);
      const guest = await h.user({ email });
      const created = await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email,
        role: "contributor",
      });
      expect(created.statusCode).toBe(201);
      const token = /\/invite\/([\w-]+)/.exec(h.mailer.sent.at(-1)?.text ?? "")?.[1] as string;
      const res = await h.inject(guest, "POST", `/invites/${token}/accept`, undefined, {
        "cf-connecting-ip": "198.51.100.90",
      });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe("on", () => {
    it("POST /auth/otp for the review address is a normal 202 but sends nothing", async () => {
      const { h, email } = await harness(true);
      const res = await otp(h, email);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
      expect(h.gotrue.calls.sendOtp).toHaveLength(0);
      expect(h.mailer.sent).toHaveLength(0);
    });

    it("POST /auth/otp for any other address still sends the email code", async () => {
      const { h } = await harness(true);
      const other = `other-${randomUUID().slice(0, 8)}@example.test`;
      expect((await otp(h, other)).statusCode).toBe(202);
      expect(h.gotrue.calls.sendOtp).toHaveLength(1);
    });

    it("the right code signs in without any email: bearer session for native, audit method review", async () => {
      const { h, email } = await harness(true);
      const user = await h.user({ email });
      const res = await verify(h, email, CODE);
      expect(res.statusCode, res.body).toBe(200);
      const session = sessionResponseSchema.parse(res.json());
      expect(session.user.id).toBe(user.id);
      // No sign-in code email exists (the harness user already has another live session, so the
      // only mail possible is the new-device alert, which carries no code).
      for (const m of h.mailer.sent) {
        expect(`${m.subject} ${m.text}`).not.toMatch(/\b\d{6}\b/);
        expect(m.subject.toLowerCase()).not.toContain("code");
      }
      // generate_link then verify of its single-use token; never a code exchange.
      expect(h.gotrue.calls.adminGenerateMagicLink.map((c) => c[0])).toEqual([email]);
      expect(h.gotrue.calls.verify).toHaveLength(1);
      expect(h.gotrue.calls.verify[0]?.[0]).toMatchObject({ kind: "token_hash" });
      const audit = await h.audit({ event: "auth.sign_in", actor: user.id });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ method: "review", client: "native" });
      const other = await h.audit({ event: "auth.sign_in" });
      expect(
        other.filter((a) => a.actor_user_id !== user.id && a.metadata.method === "review"),
      ).toHaveLength(0);
      expect(JSON.stringify(audit)).not.toContain(CODE);
      expect(JSON.stringify(audit)).not.toContain(hash);
    });

    it("the email is matched after normalisation (case, spaces)", async () => {
      const { h, email } = await harness(true);
      await h.user({ email });
      const res = await verify(h, `  ${email.toUpperCase()} `, CODE);
      expect(res.statusCode, res.body).toBe(200);
    });

    it("web sign-in sets the cookies and returns no tokens", async () => {
      const { h, email } = await harness(true);
      await h.user({ email });
      const res = await verify(h, email, CODE, WEB);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.cookies.map((c) => c.name).sort()).toEqual(["ll_access", "ll_refresh"]);
      expect(JSON.stringify(res.json())).not.toMatch(/accessToken|refreshToken/);
    });

    it("a wrong code is the same 400 invalid_code, mints nothing and writes no sign-in audit", async () => {
      const { h, email } = await harness(true);
      const user = await h.user({ email });
      const res = await verify(h, email, "000000");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_code");
      expect(h.gotrue.calls.adminGenerateMagicLink).toHaveLength(0);
      expect(await h.audit({ event: "auth.sign_in", actor: user.id })).toHaveLength(0);
    });

    it("wrong attempts count against the 5-per-10-minutes per-email throttle; the right code then 429s too", async () => {
      const { h, email } = await harness(true);
      await h.user({ email });
      for (let i = 0; i < 5; i++) {
        expect((await verify(h, email, "000000")).statusCode, `attempt ${i + 1}`).toBe(400);
      }
      const blocked = await verify(h, email, CODE);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe("rate_limited");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(h.gotrue.calls.adminGenerateMagicLink).toHaveLength(0);
    });

    it("a success resets the throttle", async () => {
      const { h, email } = await harness(true);
      await h.user({ email });
      for (let i = 0; i < 4; i++) await verify(h, email, "000000");
      expect((await verify(h, email, CODE)).statusCode).toBe(200);
      for (let i = 0; i < 5; i++) {
        expect((await verify(h, email, "000000")).statusCode).toBe(400);
      }
    });

    it("a different address is unaffected: its emailed code still goes to GoTrue's verify, not the static code", async () => {
      const { h } = await harness(true);
      const other = await h.user();
      h.gotrue.impl.verify = async () => {
        throw new GoTrueError(403, "otp_expired");
      };
      const res = await verify(h, other.email, CODE);
      expect(res.statusCode).toBe(400);
      expect(h.gotrue.calls.verify).toHaveLength(1);
      expect(h.gotrue.calls.adminGenerateMagicLink).toHaveLength(0);
    });

    it("works when the review user only has its own review family", async () => {
      const { h, email } = await harness(true);
      const user = await h.user({ email });
      const babyId = reviewBabyId(user.id);
      await h.admin.query(
        "INSERT INTO public.babies (id, name, birth_date, plan) VALUES ($1, 'Sunny', '2026-01-01', 'plus')",
        [babyId],
      );
      await h.member(babyId, user, "admin");
      const res = await verify(h, email, CODE);
      expect(res.statusCode, res.body).toBe(200);
      await h.admin.query("DELETE FROM public.babies WHERE id = $1", [babyId]);
    });

    it("403 for an account that also belongs to another family, even with the right code; no session, no audit", async () => {
      const { h, email } = await harness(true);
      const user = await h.user({ email });
      await h.baby(user, "A real family");
      const res = await verify(h, email, CODE);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
      expect(res.cookies).toHaveLength(0);
      expect(JSON.stringify(res.json())).not.toContain("accessToken");
      expect(h.gotrue.calls.verify).toHaveLength(0);
      expect(await h.audit({ event: "auth.sign_in", actor: user.id })).toHaveLength(0);
    });

    it("the guard also counts a trashed or a contributor membership in another family", async () => {
      const { h, email } = await harness(true);
      const user = await h.user({ email });
      const owner = await h.user();
      const babyId = await h.baby(owner, "Their baby");
      await h.member(babyId, user, "contributor");
      expect((await verify(h, email, CODE)).statusCode).toBe(403);
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [babyId]);
      expect((await verify(h, email, CODE)).statusCode).toBe(403);
    });

    it("the review account cannot accept an invite into a real family", async () => {
      const { h, email } = await harness(true);
      const admin = await h.user();
      const babyId = await h.baby(admin, "Real family");
      const guest = await h.user({ email });
      expect(
        (await h.inject(admin, "POST", `/babies/${babyId}/invites`, { email, role: "admin" }))
          .statusCode,
      ).toBe(201);
      const token = /\/invite\/([\w-]+)/.exec(h.mailer.sent.at(-1)?.text ?? "")?.[1] as string;
      const res = await h.inject(guest, "POST", `/invites/${token}/accept`, undefined, {
        "cf-connecting-ip": "198.51.100.91",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
      const members = await h.admin.query(
        "SELECT 1 FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
        [babyId, guest.id],
      );
      expect(members.rowCount).toBe(0);
    });

    it("another user can still accept invites normally", async () => {
      const { h } = await harness(true);
      const admin = await h.user();
      const babyId = await h.baby(admin);
      const partner = await h.user();
      await h.inject(admin, "POST", `/babies/${babyId}/invites`, {
        email: partner.email,
        role: "contributor",
      });
      const token = /\/invite\/([\w-]+)/.exec(h.mailer.sent.at(-1)?.text ?? "")?.[1] as string;
      const res = await h.inject(partner, "POST", `/invites/${token}/accept`, undefined, {
        "cf-connecting-ip": "198.51.100.92",
      });
      expect(res.statusCode, res.body).toBe(200);
    });

    it("503 fails closed when the GoTrue client has no review links (right code, nothing minted)", async () => {
      const { h, email } = await harness(true, undefined, { gotrueReviewLinks: false });
      await h.user({ email });
      const res = await verify(h, email, CODE);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("internal");
      expect(res.cookies).toHaveLength(0);
    });

    it("503 when generate_link fails, without leaking anything", async () => {
      const { h, email } = await harness(true, undefined, {
        gotrue: {
          adminGenerateMagicLink: async () => {
            throw new GoTrueError(500, "http_500");
          },
        },
      });
      await h.user({ email });
      const res = await verify(h, email, CODE);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain(CODE);
    });

    it("a session for a different user than generate_link named is never handed out", async () => {
      const { h, email } = await harness(true);
      const user = await h.user({ email });
      const mallory = await h.user();
      h.gotrue.impl.adminGenerateMagicLink = async () => ({ userId: user.id, hashedToken: "tok" });
      h.gotrue.impl.verify = async () => {
        const { gotrueSession } = await import("../testing/support");
        return gotrueSession({
          sub: mallory.id,
          email: mallory.email,
          sessionId: mallory.sessionId,
        });
      };
      const res = await verify(h, email, CODE);
      expect(res.statusCode).toBe(503);
      expect(res.cookies).toHaveLength(0);
      expect(h.gotrue.calls.logout).toHaveLength(1);
    });

    it("never logs the code, the hash or the email", async () => {
      const lines: string[] = [];
      const email = `logcheck-${randomUUID().slice(0, 8)}@example.test`;
      const { h } = await harness(true, email, {
        logger: { level: "debug", stream: { write: (s: string) => void lines.push(s) } },
      });
      await h.user({ email });
      await otp(h, email);
      await verify(h, email, "000000");
      expect((await verify(h, email, CODE)).statusCode).toBe(200);
      const text = lines.join("\n");
      expect(text).not.toContain(CODE);
      expect(text).not.toContain(hash);
      expect(text).not.toContain(email);
    });
  });
});
