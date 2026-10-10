import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  authConfigResponseSchema,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from "@tinyglow/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { ApiConfig } from "../config";
import { captureMailer } from "../email/mailer";
import { signAccessToken, stubGoTrue, testConfig } from "../testing/support";
import { GoTrueError } from "./gotrue";

// Auth routes that do not need a database: the hook, config, OTP request, refresh failures,
// sign-out guard. (Session-issuing paths are in routes.integration.test.ts.)

const okDb = { query: async () => ({ rows: [] }), end: async () => undefined };
const okS3 = { send: (async () => ({})) as never, destroy: () => undefined };
const WEB = { "x-tinyglow-client": "web" };

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make(gotrue = stubGoTrue(), config: Partial<ApiConfig> = {}) {
  const mailer = captureMailer();
  app = await buildApp({
    config: testConfig(config),
    db: okDb,
    s3: okS3,
    gotrue,
    mailer,
    // Never build provider clients from the developer's real environment in a unit test.
    aiEnv: {},
    logger: false,
  });
  return { app, gotrue, mailer };
}

const errorOf = (res: { json(): unknown }) => apiErrorSchema.parse(res.json());

describe("GET /auth/config", () => {
  it("is public and reports providers, versions and a null site key without Turnstile", async () => {
    const { app } = await make(stubGoTrue(), { AUTH_GOOGLE_ENABLED: true });
    const res = await app.inject({ method: "GET", url: "/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(authConfigResponseSchema.parse(res.json())).toEqual({
      providers: { apple: false, google: true },
      turnstileSiteKey: null,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    });
  });

  it("exposes the site key only when Turnstile is configured", async () => {
    const { app } = await make(stubGoTrue(), {
      TURNSTILE_SECRET_KEY: "s",
      TURNSTILE_SITE_KEY: "site-key",
    });
    const res = await app.inject({ method: "GET", url: "/auth/config" });
    expect(res.json().turnstileSiteKey).toBe("site-key");
    expect(JSON.stringify(res.json())).not.toContain('"s"');
  });
});

describe("POST /auth/otp", () => {
  const post = (a: NonNullable<typeof app>, email: string, headers: Record<string, string> = {}) =>
    a.inject({
      method: "POST",
      url: "/auth/otp",
      headers: { ...WEB, ...headers },
      payload: { email },
    });

  it("answers 202 {ok:true} and passes the normalised email and client facts to GoTrue", async () => {
    const { app, gotrue } = await make();
    const res = await post(app, "  Maria@Example.COM ", {
      "cf-connecting-ip": "203.0.113.9",
      "user-agent": "UA/1",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    expect(gotrue.calls.sendOtp).toHaveLength(1);
    expect(gotrue.calls.sendOtp[0]?.[0]).toBe("maria@example.com");
    expect(gotrue.calls.sendOtp[0]?.[1]).toMatchObject({
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "UA/1",
    });
  });

  it("is generic: GoTrue failures (including unknown-user style 4xx and outages) still give 202", async () => {
    for (const err of [
      new GoTrueError(422, "email_address_invalid"),
      new GoTrueError(503, "network"),
      new Error("x"),
    ]) {
      const { app } = await make(
        stubGoTrue({
          sendOtp: async () => {
            throw err;
          },
        }),
      );
      const res = await post(app, "nobody@example.com");
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
      await app.close();
    }
  });

  it("rejects a malformed email with 400 validation_failed naming the field, not the value", async () => {
    const { app } = await make();
    const res = await post(app, "not-an-email");
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error).toBe("validation_failed");
    expect(res.body).not.toContain("not-an-email");
  });

  it("limits to 5 per email per hour with Retry-After, keyed on the normalised address", async () => {
    const { app, gotrue } = await make();
    for (let i = 0; i < 5; i++) {
      const res = await post(app, i % 2 ? "A@B.CO" : "a@b.co", {
        "cf-connecting-ip": `198.51.100.${i + 1}`,
      });
      expect(res.statusCode).toBe(202);
    }
    const sixth = await post(app, "a@b.co", { "cf-connecting-ip": "198.51.100.99" });
    expect(sixth.statusCode).toBe(429);
    expect(errorOf(sixth).error).toBe("rate_limited");
    expect(Number(sixth.headers["retry-after"])).toBeGreaterThan(0);
    expect(gotrue.calls.sendOtp).toHaveLength(5);
    // Another address from another IP is unaffected.
    expect(
      (await post(app, "other@b.co", { "cf-connecting-ip": "198.51.100.200" })).statusCode,
    ).toBe(202);
  });

  it("limits to 30 per IP per hour", async () => {
    const { app } = await make();
    for (let i = 0; i < 30; i++) {
      const res = await post(app, `user${i}@b.co`, { "cf-connecting-ip": "203.0.113.50" });
      expect(res.statusCode).toBe(202);
    }
    const res = await post(app, "user31@b.co", { "cf-connecting-ip": "203.0.113.50" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("with Turnstile configured: captcha_required after 3 requests from one IP, captcha_failed on a bad token", async () => {
    const { app, gotrue } = await make(stubGoTrue(), { TURNSTILE_SECRET_KEY: "secret" });
    const headers = { "cf-connecting-ip": "203.0.113.77" };
    for (let i = 0; i < 3; i++) {
      expect((await post(app, `u${i}@b.co`, headers)).statusCode).toBe(202);
    }
    const needs = await post(app, "u4@b.co", headers);
    expect(needs.statusCode).toBe(403);
    expect(errorOf(needs).error).toBe("captcha_required");
    const bad = await app.inject({
      method: "POST",
      url: "/auth/otp",
      headers: { ...WEB, ...headers },
      payload: { email: "u4@b.co", captchaToken: "bad-token" },
    });
    // Real Cloudflare is unreachable/unconfigured here: verification fails closed.
    expect(bad.statusCode).toBe(403);
    expect(["captcha_failed", "captcha_required"]).toContain(errorOf(bad).error);
    expect(gotrue.calls.sendOtp).toHaveLength(3);
  });

  it("never asks for a captcha without a Turnstile secret", async () => {
    const { app } = await make();
    for (let i = 0; i < 6; i++) {
      expect(
        (await post(app, `u${i}@b.co`, { "cf-connecting-ip": "203.0.113.78" })).statusCode,
      ).toBe(202);
    }
  });
});

describe("auth hook, CSRF and token errors", () => {
  it("401 unauthorized without credentials on a protected route", async () => {
    const { app } = await make();
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).error).toBe("unauthorized");
  });

  it("401 token_expired for an expired access token (so the SPA can refresh once)", async () => {
    const { app } = await make();
    const t = Math.floor(Date.now() / 1000);
    const token = await signAccessToken({ iat: t - 7200, exp: t - 3600 });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).error).toBe("token_expired");
    const viaCookie = await app.inject({
      method: "GET",
      url: "/me",
      cookies: { ll_access: token },
    });
    expect(errorOf(viaCookie).error).toBe("token_expired");
  });

  it("401 unauthorized for a token with the wrong secret or a non-authenticated role", async () => {
    const { app } = await make();
    for (const token of [
      await signAccessToken({ secret: "q".repeat(40) }),
      await signAccessToken({ role: "service_role" }),
      "garbage",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).error).toBe("unauthorized");
    }
  });

  it("403 csrf_rejected for a cookie-authenticated write without the web client header; bearer is exempt", async () => {
    const { app } = await make();
    const token = await signAccessToken();
    const noHeader = await app.inject({
      method: "POST",
      url: "/auth/signout",
      cookies: { ll_access: token },
      payload: { scope: "local" },
    });
    expect(noHeader.statusCode).toBe(403);
    expect(errorOf(noHeader).error).toBe("csrf_rejected");
    const nativeHeader = await app.inject({
      method: "POST",
      url: "/auth/signout",
      cookies: { ll_access: token },
      headers: { "x-tinyglow-client": "native" },
      payload: { scope: "local" },
    });
    expect(errorOf(nativeHeader).error).toBe("csrf_rejected");
    // Bearer + no header passes the hook; it then reaches the (db-less) handler and fails there,
    // but not with csrf_rejected / unauthorized.
    const bearer = await app.inject({
      method: "POST",
      url: "/auth/signout",
      headers: { authorization: `Bearer ${token}` },
      payload: { scope: "local" },
    });
    expect(["csrf_rejected", "unauthorized"]).not.toContain(errorOf(bearer).error);
  });
});

describe("POST /auth/refresh failures (no database needed)", () => {
  it("with no body, no content-type and no cookie: 401 and cookies cleared (not a 400)", async () => {
    const { app } = await make();
    const res = await app.inject({ method: "POST", url: "/auth/refresh", headers: WEB });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).error).toBe("unauthorized");
    const set = [res.headers["set-cookie"]].flat().map(String);
    expect(set.some((c) => c.startsWith("ll_access=;"))).toBe(true);
    expect(set.some((c) => c.startsWith("ll_refresh=;"))).toBe(true);
  });

  it("a refresh cookie without the web client header is csrf_rejected", async () => {
    const { app, gotrue } = await make();
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { ll_refresh: "rt" },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).error).toBe("csrf_rejected");
    expect(gotrue.calls.refresh).toHaveLength(0);
  });

  it("a rejected refresh token (GoTrue 4xx) is 401 and clears the cookies", async () => {
    const { app } = await make(
      stubGoTrue({
        refresh: async () => {
          throw new GoTrueError(400, "refresh_token_already_used");
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: WEB,
      cookies: { ll_refresh: "old" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).error).toBe("unauthorized");
    expect([res.headers["set-cookie"]].flat().join("\n")).toContain("ll_refresh=;");
  });

  it("an upstream outage is 503 and keeps the cookies (the user is not signed out by a blip)", async () => {
    const { app } = await make(
      stubGoTrue({
        refresh: async () => {
          throw new GoTrueError(503, "ECONNREFUSED");
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: WEB,
      cookies: { ll_refresh: "rt" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("the native refresh token travels in the body and needs no CSRF header", async () => {
    const { app, gotrue } = await make(
      stubGoTrue({
        refresh: async () => {
          throw new GoTrueError(400, "invalid_grant");
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: "native-rt" },
    });
    expect(res.statusCode).toBe(401);
    expect(gotrue.calls.refresh[0]?.[0]).toBe("native-rt");
  });
});

describe("POST /auth/verify, /auth/pkce, /auth/id-token validation", () => {
  it("rejects a non-6-digit code and a body with neither code nor token_hash", async () => {
    const { app, gotrue } = await make();
    for (const payload of [
      { email: "a@b.co", code: "12345" },
      { email: "a@b.co", code: "abcdef" },
      { email: "a@b.co" },
      {},
    ]) {
      const res = await app.inject({ method: "POST", url: "/auth/verify", headers: WEB, payload });
      expect(res.statusCode).toBe(400);
    }
    expect(gotrue.calls.verify).toHaveLength(0);
  });

  it("maps a wrong code (GoTrue 4xx) to 400 invalid_code, and an outage to 503", async () => {
    const wrong = await make(
      stubGoTrue({
        verify: async () => {
          throw new GoTrueError(403, "otp_expired");
        },
      }),
    );
    const res = await wrong.app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: WEB,
      payload: { email: "a@b.co", code: "123456" },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error).toBe("invalid_code");
    await wrong.app.close();

    const down = await make(
      stubGoTrue({
        verify: async () => {
          throw new GoTrueError(503, "ECONNREFUSED");
        },
      }),
    );
    const res2 = await down.app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: WEB,
      payload: { email: "a@b.co", code: "123456" },
    });
    expect(res2.statusCode).toBe(503);
  });

  it("allows 5 wrong codes per email, then 429 with Retry-After without calling GoTrue again", async () => {
    const { app, gotrue } = await make(
      stubGoTrue({
        verify: async () => {
          throw new GoTrueError(403, "otp_expired");
        },
      }),
    );
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/verify",
        headers: WEB,
        payload: { email: "a@b.co", code: "000000" },
      });
      expect(res.statusCode).toBe(400);
    }
    const sixth = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: WEB,
      payload: { email: "A@B.co", code: "000001" },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers["retry-after"]).toBeDefined();
    expect(gotrue.calls.verify).toHaveLength(5);
  });

  it("social sign-in endpoints answer provider_disabled while the flags are off", async () => {
    const { app, gotrue } = await make();
    const pkce = await app.inject({
      method: "POST",
      url: "/auth/pkce",
      headers: WEB,
      payload: { code: "c", codeVerifier: "v".repeat(43) },
    });
    expect(pkce.statusCode).toBe(400);
    expect(errorOf(pkce).error).toBe("provider_disabled");
    for (const provider of ["apple", "google"]) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/id-token",
        headers: WEB,
        payload: { provider, idToken: "idt" },
      });
      expect(errorOf(res).error).toBe("provider_disabled");
    }
    expect(gotrue.calls.exchangePkce).toHaveLength(0);
    expect(gotrue.calls.signInWithIdToken).toHaveLength(0);
  });

  it("protected auth routes need a session", async () => {
    const { app } = await make();
    for (const [method, url] of [
      ["GET", "/auth/sessions"],
      ["DELETE", `/auth/sessions/${randomUUID()}`],
      ["POST", "/auth/signout"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: WEB,
        payload: method === "POST" ? { scope: "local" } : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
