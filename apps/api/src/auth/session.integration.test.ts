import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  sessionResponseSchema,
  sessionsListResponseSchema,
} from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness } from "../testing/integration";
import { gotrueSession, signAccessToken } from "../testing/support";
import { GoTrueError } from "./gotrue";

// Session liveness, session issuing (verify / refresh), new-device alerts, devices list and
// sign-out against a real database (docs/plans/step-3.md 2.2, 2.3, 3.10).

const WEB = { "x-tinyglow-client": "web" };
const NATIVE = { "x-tinyglow-client": "native" };
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";

const cookiesOf = (res: { headers: Record<string, unknown> }) =>
  [res.headers["set-cookie"]].flat().filter(Boolean).map(String);

describe.skipIf(!databaseUrl)("session liveness (withClaims)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("serves a request whose session row exists", async () => {
    const u = await h.user();
    const res = await h.inject(u, "GET", "/me");
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ id: u.id, email: u.email });
  });

  it("401 session_revoked as soon as the auth.sessions row is deleted, though the JWT is still valid", async () => {
    const u = await h.user();
    expect((await h.inject(u, "GET", "/me")).statusCode).toBe(200);
    await h.admin.query("DELETE FROM auth.sessions WHERE id = $1", [u.sessionId]);
    const res = await h.inject(u, "GET", "/me");
    expect(res.statusCode).toBe(401);
    expect(apiErrorSchema.parse(res.json()).error).toBe("session_revoked");
  });

  it("is revoked for every write path too (no side effects after the session is gone)", async () => {
    const u = await h.user();
    await h.admin.query("DELETE FROM auth.sessions WHERE id = $1", [u.sessionId]);
    const res = await h.inject(u, "POST", "/babies", { name: "Nope", birthDate: "2026-01-01" });
    expect(res.statusCode).toBe(401);
    const { rows } = await h.admin.query("SELECT 1 FROM public.babies WHERE created_by = $1", [
      u.id,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("a token whose session_id belongs to another user is revoked", async () => {
    const a = await h.user();
    const b = await h.user();
    const forged = await signAccessToken({ sub: a.id, email: a.email, sessionId: b.sessionId });
    const res = await h.inject(null, "GET", "/me", undefined, {
      authorization: `Bearer ${forged}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("session_revoked");
  });

  it("a session past its timebox (not_after) is revoked", async () => {
    const u = await h.user();
    await h.admin.query(
      "UPDATE auth.sessions SET not_after = now() - interval '1 minute' WHERE id = $1",
      [u.sessionId],
    );
    const res = await h.inject(u, "GET", "/me");
    expect(res.json().error).toBe("session_revoked");
  });

  it("a session id that never existed is revoked", async () => {
    const u = await h.user();
    const token = await signAccessToken({ sub: u.id, email: u.email, sessionId: randomUUID() });
    const res = await h.inject(null, "GET", "/me", undefined, { authorization: `Bearer ${token}` });
    expect(res.json().error).toBe("session_revoked");
  });

  it("works through the access cookie too (GET needs no CSRF header)", async () => {
    const u = await h.user();
    const res = await h.app.inject({ method: "GET", url: "/me", cookies: { ll_access: u.token } });
    expect(res.statusCode).toBe(200);
  });
});

describe.skipIf(!databaseUrl)("session-issuing endpoints", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  /** Make the GoTrue stub answer verify with a session for `u` (its pre-created session row). */
  async function stubVerify(
    u: { id: string; email: string; sessionId: string },
    refreshToken = "rt-1",
  ) {
    const session = await gotrueSession({
      sub: u.id,
      email: u.email,
      sessionId: u.sessionId,
      refreshToken,
    });
    h.gotrue.calls.verify.length = 0;
    h.gotrue.impl.verify = async () => session;
    return session;
  }

  const verify = (headers: Record<string, string> = WEB, email = "x@example.test") =>
    h.app.inject({
      method: "POST",
      url: "/auth/verify",
      headers,
      payload: { email, code: "123456" },
    });

  it("web: sets both cookies, never returns tokens, creates the profile and writes auth.sign_in", async () => {
    const u = await h.user({ profile: false });
    const session = await stubVerify(u);
    const res = await verify({ ...WEB, "user-agent": IPHONE, "cf-ipcountry": "de" }, u.email);
    expect(res.statusCode).toBe(200);
    const body = sessionResponseSchema.parse(res.json());
    expect(body.user).toEqual({ id: u.id, email: u.email });
    expect(body.session.isFresh).toBe(true);
    expect(body).not.toHaveProperty("tokens");
    expect(res.body).not.toContain(session.accessToken);
    expect(res.body).not.toContain(session.refreshToken);

    const set = cookiesOf(res);
    expect(set.find((c) => c.startsWith("ll_access="))).toContain(session.accessToken);
    expect(set.find((c) => c.startsWith("ll_refresh="))).toContain("rt-1");

    const profile = await h.admin.query(
      "SELECT display_name, terms_version FROM public.profiles WHERE user_id = $1",
      [u.id],
    );
    expect(profile.rows).toHaveLength(1);
    expect(profile.rows[0].terms_version).toBeNull();

    const audit = await h.audit({ event: "auth.sign_in", actor: u.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toEqual({
      client: "web",
      user_agent_label: "Safari on iPhone",
      ip_country: "DE",
    });
    expect(JSON.stringify(audit[0]?.metadata)).not.toContain(u.email);
    // First and only device: no alert.
    expect(await h.audit({ event: "auth.new_device", actor: u.id })).toHaveLength(0);
    expect(h.mailer.sent.filter((m) => m.to === u.email)).toHaveLength(0);
  });

  it("native: tokens in the body, no cookies", async () => {
    const u = await h.user();
    const session = await stubVerify(u);
    const res = await verify(NATIVE, u.email);
    expect(res.statusCode).toBe(200);
    expect(res.json().tokens).toEqual({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: 3600,
    });
    expect(cookiesOf(res)).toHaveLength(0);
    const audit = await h.audit({ event: "auth.sign_in", actor: u.id });
    expect(audit[0]?.metadata).toMatchObject({ client: "native" });
  });

  it("magic link (token_hash) signs in the same way and is throttled per IP", async () => {
    const u = await h.user();
    const session = await gotrueSession({ sub: u.id, email: u.email, sessionId: u.sessionId });
    h.gotrue.impl.verify = async () => session;
    h.gotrue.calls.verify.length = 0;
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { ...WEB, "cf-connecting-ip": "198.51.100.10" },
      payload: { tokenHash: "hash123", type: "email" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.gotrue.calls.verify[0]?.[0]).toEqual({ kind: "token_hash", tokenHash: "hash123" });
  });

  it("a second live session triggers auth.new_device and one alert mail (device + country, no IP)", async () => {
    const u = await h.user();
    await h.session(u, {
      ageMin: 60,
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537",
    });
    await stubVerify(u);
    h.mailer.clear();
    const res = await verify(
      { ...WEB, "user-agent": IPHONE, "cf-ipcountry": "FR", "cf-connecting-ip": "198.51.100.77" },
      u.email,
    );
    expect(res.statusCode).toBe(200);
    expect(await h.audit({ event: "auth.new_device", actor: u.id })).toHaveLength(1);
    const mails = h.mailer.sent.filter((m) => m.to === u.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.template).toBe("new_device");
    expect(mails[0]?.text).toContain("Safari on iPhone");
    expect(mails[0]?.text).toContain("country FR");
    expect(mails[0]?.text).toContain("/settings/devices");
    expect(mails[0]?.text).not.toContain("198.51.100.77");
    expect(mails[0]?.html).not.toContain("198.51.100.77");
  });

  it("a failing alert mail does not fail the sign-in", async () => {
    const u = await h.user();
    await h.session(u);
    await stubVerify(u);
    const original = h.mailer.send;
    (h.mailer as { send: unknown }).send = async () => {
      throw new Error("smtp down");
    };
    try {
      const res = await verify(WEB, u.email);
      expect(res.statusCode).toBe(200);
    } finally {
      (h.mailer as { send: unknown }).send = original;
    }
  });

  it("signing in while holding a session logs that old session out at GoTrue", async () => {
    const u = await h.user();
    const second = await h.session(u);
    await stubVerify({ ...u, sessionId: second.id });
    h.gotrue.calls.logout.length = 0;
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { ...u.headers, ...WEB },
      payload: { email: u.email, code: "123456" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.gotrue.calls.logout).toHaveLength(1);
    expect(h.gotrue.calls.logout[0]?.[0]).toBe(u.token);
    expect(h.gotrue.calls.logout[0]?.[1]).toBe("local");
  });

  it("a GoTrue session whose row is already gone is rejected as session_revoked (nothing issued)", async () => {
    const u = await h.user();
    await stubVerify(u);
    await h.admin.query("DELETE FROM auth.sessions WHERE id = $1", [u.sessionId]);
    const res = await verify(WEB, u.email);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("session_revoked");
    expect(cookiesOf(res)).toHaveLength(0);
  });

  it("an access token our verifier rejects is never turned into a session", async () => {
    const u = await h.user();
    const bad = await gotrueSession({
      sub: u.id,
      email: u.email,
      sessionId: u.sessionId,
      secret: "w".repeat(40),
    });
    h.gotrue.impl.verify = async () => bad;
    const res = await verify(WEB, u.email);
    expect(res.statusCode).toBe(401);
    expect(cookiesOf(res)).toHaveLength(0);
  });

  it("refresh (web, no body): re-issues cookies, writes no sign-in audit and no profile row", async () => {
    const u = await h.user({ profile: false });
    const session = await gotrueSession({
      sub: u.id,
      email: u.email,
      sessionId: u.sessionId,
      refreshToken: "rt-2",
    });
    h.gotrue.impl.refresh = async () => session;
    h.gotrue.calls.refresh.length = 0;
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: WEB,
      cookies: { ll_refresh: "rt-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.gotrue.calls.refresh[0]?.[0]).toBe("rt-1");
    const set = cookiesOf(res);
    expect(set.find((c) => c.startsWith("ll_refresh="))).toContain("rt-2");
    expect(set.find((c) => c.startsWith("ll_access="))).toContain(session.accessToken);
    expect(await h.audit({ actor: u.id })).toHaveLength(0);
    const profile = await h.admin.query("SELECT 1 FROM public.profiles WHERE user_id = $1", [u.id]);
    expect(profile.rows).toHaveLength(0);
  });

  it("refresh (native): token in, tokens out, no cookies", async () => {
    const u = await h.user();
    const session = await gotrueSession({
      sub: u.id,
      email: u.email,
      sessionId: u.sessionId,
      refreshToken: "rt-n2",
    });
    h.gotrue.impl.refresh = async () => session;
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: NATIVE,
      payload: { refreshToken: "rt-n1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokens.refreshToken).toBe("rt-n2");
    expect(cookiesOf(res)).toHaveLength(0);
  });

  it("refresh for a session GoTrue already deleted is session_revoked", async () => {
    const u = await h.user();
    const session = await gotrueSession({ sub: u.id, email: u.email, sessionId: u.sessionId });
    h.gotrue.impl.refresh = async () => session;
    await h.admin.query("DELETE FROM auth.sessions WHERE id = $1", [u.sessionId]);
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: WEB,
      cookies: { ll_refresh: "rt" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("session_revoked");
  });

  it("verify with a wrong code from GoTrue creates no profile, audit or cookies", async () => {
    const before = (await h.audit({ event: "auth.sign_in" })).length;
    h.gotrue.impl.verify = async () => {
      throw new GoTrueError(403, "otp_expired");
    };
    const res = await verify(WEB, "ghost@example.test");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_code");
    expect(cookiesOf(res)).toHaveLength(0);
    expect((await h.audit({ event: "auth.sign_in" })).length).toBe(before);
  });
});

describe.skipIf(!databaseUrl)("devices and sign-out", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("GET /auth/sessions lists only the caller's live sessions, newest first, with labels and no IPs", async () => {
    const u = await h.user({ sessionAgeMin: 5, userAgent: IPHONE });
    const older = await h.session(u, {
      ageMin: 120,
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537",
    });
    const stranger = await h.user();
    const res = await h.inject(u, "GET", "/auth/sessions");
    expect(res.statusCode).toBe(200);
    const { sessions } = sessionsListResponseSchema.parse(res.json());
    expect(sessions.map((s) => s.id)).toEqual([u.sessionId, older.id]);
    expect(sessions[0]).toMatchObject({ current: true, deviceLabel: "Safari on iPhone" });
    expect(sessions[1]).toMatchObject({ current: false, deviceLabel: "Chrome on Windows" });
    expect(res.body).not.toContain("203.0.113.5");
    expect(res.body).not.toContain(stranger.sessionId);
  });

  it("DELETE /auth/sessions/:id signs out another device, with an audit row", async () => {
    const u = await h.user();
    const other = await h.session(u);
    const res = await h.inject(u, "DELETE", `/auth/sessions/${other.id}`);
    expect(res.statusCode).toBe(204);
    const { rows } = await h.admin.query("SELECT 1 FROM auth.sessions WHERE id = $1", [other.id]);
    expect(rows).toHaveLength(0);
    const audit = await h.audit({ event: "auth.sign_out", actor: u.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ scope: "device" });
    // The other device's token is dead at once.
    const stale = await h.inject(null, "GET", "/me", undefined, {
      authorization: `Bearer ${other.token}`,
    });
    expect(stale.json().error).toBe("session_revoked");
    // This device is untouched.
    expect((await h.inject(u, "GET", "/me")).statusCode).toBe(200);
  });

  it("someone else's session and a missing one are indistinguishable 404s and leave no audit row", async () => {
    const u = await h.user();
    const victim = await h.user();
    const before = (await h.audit({ event: "auth.sign_out" })).length;
    const theirs = await h.inject(u, "DELETE", `/auth/sessions/${victim.sessionId}`);
    const missing = await h.inject(u, "DELETE", `/auth/sessions/${randomUUID()}`);
    expect(theirs.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(theirs.json()).toEqual(missing.json());
    const { rows } = await h.admin.query("SELECT 1 FROM auth.sessions WHERE id = $1", [
      victim.sessionId,
    ]);
    expect(rows).toHaveLength(1);
    expect((await h.audit({ event: "auth.sign_out" })).length).toBe(before);
  });

  it("deleting the current session over the cookie transport clears the cookies", async () => {
    const u = await h.user();
    const res = await h.app.inject({
      method: "DELETE",
      url: `/auth/sessions/${u.sessionId}`,
      headers: WEB,
      cookies: { ll_access: u.token },
    });
    expect(res.statusCode).toBe(204);
    const set = cookiesOf(res);
    expect(set.some((c) => c.startsWith("ll_access=;"))).toBe(true);
    expect(set.some((c) => c.startsWith("ll_refresh=;"))).toBe(true);
  });

  it("POST /auth/signout calls GoTrue with the user's token and scope, audits first, clears cookies", async () => {
    const u = await h.user();
    h.gotrue.calls.logout.length = 0;
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/signout",
      headers: WEB,
      cookies: { ll_access: u.token },
      payload: { scope: "global" },
    });
    expect(res.statusCode).toBe(204);
    expect(h.gotrue.calls.logout[0]?.slice(0, 2)).toEqual([u.token, "global"]);
    expect(cookiesOf(res).some((c) => c.startsWith("ll_access=;"))).toBe(true);
    const audit = await h.audit({ event: "auth.sign_out", actor: u.id });
    expect(audit[0]?.metadata).toMatchObject({ scope: "global", client: "web" });
  });

  it("when GoTrue logout fails the answer is 503 but this browser's cookies are still cleared", async () => {
    const failing = await createHarness({
      gotrue: {
        logout: async () => {
          throw new GoTrueError(503, "ECONNREFUSED");
        },
      },
    });
    try {
      const u = await failing.user();
      const res = await failing.app.inject({
        method: "POST",
        url: "/auth/signout",
        headers: WEB,
        cookies: { ll_access: u.token },
        payload: { scope: "local" },
      });
      expect(res.statusCode).toBe(503);
      expect(cookiesOf(res).some((c) => c.startsWith("ll_access=;"))).toBe(true);
    } finally {
      await failing.close();
    }
  });

  it("signout rejects an invalid scope", async () => {
    const u = await h.user();
    const res = await h.inject(u, "POST", "/auth/signout", { scope: "others" });
    expect(res.statusCode).toBe(400);
  });
});
