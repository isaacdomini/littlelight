import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  authConfigResponseSchema,
  deletionPreviewResponseSchema,
  PASSKEY_MAX_PER_USER,
  passkeyOptionsResponseSchema,
  passkeySchema,
  passkeysListResponseSchema,
  sessionResponseSchema,
} from "@tinyglow/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { ApiConfig } from "../config";
import { captureMailer } from "../email/mailer";
import { hashPasscode } from "../sharing/crypto";
import { type FakeDb, fakeDb } from "../testing/fake-db";
import {
  type GoTrueStub,
  goTruePasskeyBody,
  goTruePasskeyOptionsBody,
  gotrueSession,
  signAccessToken,
  stubGoTrue,
  testConfig,
} from "../testing/support";
import {
  assertionCredential,
  FLAGS_UP_ONLY,
  FLAGS_UV,
  registrationCredential,
} from "../testing/webauthn";
import { GoTrueError } from "./gotrue";

// Passkey routes without Postgres (docs/plans/step-13.md 2.4, 2.8; decisions b, c, d, g; Q3–Q7).
// GoTrue is a recording stub answering with its real wire shapes (Unix-second `expires_at`, bare
// list array, 200 on registration verify); the database is `fakeDb` (live session, consent given,
// audit rows recorded). Everything that needs real tables is in *.integration.test.ts.

const okS3 = { send: (async () => ({})) as never, destroy: () => undefined };
const WEB = { "x-tinyglow-client": "web" };
const NATIVE = { "x-tinyglow-client": "native" };
const UID = "11111111-1111-4111-8111-111111111111";
const EMAIL = "parent@example.com";
const REVIEW_EMAIL = "review@example.com";
const PK_ID = "3f2c1b0a-1234-4abc-8def-0123456789ab";
const CH_ID = "7e1d2c3b-4a5f-4e6d-8c7b-0a1b2c3d4e5f";

const errorOf = (res: { json(): unknown }) => apiErrorSchema.parse(res.json());
const cookiesOf = (res: { headers: Record<string, unknown> }) =>
  [res.headers["set-cookie"]].flat().filter(Boolean).map(String);

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Made {
  app: NonNullable<typeof app>;
  gotrue: GoTrueStub;
  db: FakeDb;
  mailer: ReturnType<typeof captureMailer>;
}

async function make(
  opts: {
    gotrue?: GoTrueStub;
    config?: Partial<ApiConfig>;
    db?: FakeDb;
    passkeysOn?: boolean;
  } = {},
): Promise<Made> {
  const gotrue = opts.gotrue ?? stubGoTrue();
  const db = opts.db ?? fakeDb();
  const mailer = captureMailer();
  app = await buildApp({
    config: testConfig({
      AUTH_PASSKEYS_ENABLED: opts.passkeysOn ?? true,
      ...opts.config,
    }),
    db,
    s3: okS3,
    gotrue,
    mailer,
    aiEnv: {},
    logger: false,
  });
  return { app, gotrue, db, mailer };
}

/** A signed-in user's bearer header (the fake DB says its session is live). */
async function bearer(over: { sub?: string; email?: string | null } = {}) {
  const token = await signAccessToken({
    sub: over.sub ?? UID,
    email: over.email === undefined ? EMAIL : over.email,
    sessionId: randomUUID(),
  });
  return { token, headers: { authorization: `Bearer ${token}` } };
}

/** Stub answers for a happy registration/management session. */
function managementStub(list: ReturnType<typeof goTruePasskeyBody>[] = []): GoTrueStub {
  return stubGoTrue({
    passkeyList: async () => list,
    passkeyRegOptions: async () => goTruePasskeyOptionsBody({ challenge_id: CH_ID }),
    passkeyRegVerify: async () => goTruePasskeyBody({ id: PK_ID }),
    passkeyRename: async (_t, id, name) => goTruePasskeyBody({ id, friendly_name: name }),
    passkeyDelete: async () => undefined,
  });
}

const ALL_ROUTES: [string, string, unknown][] = [
  ["POST", "/auth/passkey/options", {}],
  ["POST", "/auth/passkey/verify", { challengeId: CH_ID, credential: assertionCredential() }],
  ["POST", "/me/passkeys/options", undefined],
  ["POST", "/me/passkeys", { challengeId: CH_ID, credential: registrationCredential() }],
  ["GET", "/me/passkeys", undefined],
  ["PATCH", `/me/passkeys/${PK_ID}`, { name: "x" }],
  ["DELETE", `/me/passkeys/${PK_ID}`, undefined],
];

// ---------------------------------------------------------------------------------------------

describe("feature flag", () => {
  it("GET /auth/config reports passkeys from AUTH_PASSKEYS_ENABLED", async () => {
    const off = await make({ passkeysOn: false });
    expect(
      authConfigResponseSchema.parse((await off.app.inject({ url: "/auth/config" })).json())
        .passkeys,
    ).toBe(false);
    await off.app.close();
    const on = await make({ passkeysOn: true });
    expect(
      authConfigResponseSchema.parse((await on.app.inject({ url: "/auth/config" })).json())
        .passkeys,
    ).toBe(true);
  });

  it("off: all 7 routes are 404 passkey_disabled before validation and before auth (garbage body, no session), no GoTrue call", async () => {
    const { app, gotrue } = await make({ passkeysOn: false });
    for (const [method, url] of ALL_ROUTES) {
      const res = await app.inject({
        method: method as "GET",
        url,
        headers: WEB,
        ...(method === "GET" || method === "DELETE" ? {} : { payload: { garbage: 1 } }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errorOf(res).error, `${method} ${url}`).toBe("passkey_disabled");
    }
    // a signed-in caller gets the same answer
    const me = await bearer();
    const res = await app.inject({ method: "GET", url: "/me/passkeys", headers: me.headers });
    expect(errorOf(res).error).toBe("passkey_disabled");
    for (const calls of Object.values(gotrue.calls)) expect(calls).toHaveLength(0);
  });

  it("a GoTrue client without the passkey methods (pre-step-13) fails closed with 503 on every route", async () => {
    const { app, gotrue } = await make({ gotrue: stubGoTrue({}, { passkeys: false }) });
    const me = await bearer();
    for (const [method, url, payload] of ALL_ROUTES) {
      const res = await app.inject({
        method: method as "GET",
        url,
        headers: { ...WEB, ...me.headers },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(errorOf(res).error).toBe("internal");
    }
    for (const calls of Object.values(gotrue.calls)) expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("POST /auth/passkey/options (public)", () => {
  it("returns challengeId + ISO expiresAt + the options pass-through; forwards the client headers upstream (decision d)", async () => {
    const { app, gotrue } = await make({
      gotrue: stubGoTrue({
        passkeyAuthOptions: async () =>
          goTruePasskeyOptionsBody({ challenge_id: CH_ID, expires_at: 1_760_000_000 }),
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/passkey/options",
      headers: { ...WEB, "cf-connecting-ip": "203.0.113.9", "user-agent": "UA/1" },
    });
    expect(res.statusCode).toBe(200);
    const body = passkeyOptionsResponseSchema.parse(res.json());
    expect(body.challengeId).toBe(CH_ID);
    expect(body.expiresAt).toBe("2025-10-09T08:53:20.000Z");
    expect(body.options).toMatchObject({ rpId: "localhost", userVerification: "preferred" });
    expect(Object.keys(res.json()).sort()).toEqual(["challengeId", "expiresAt", "options"]);
    expect(gotrue.calls.passkeyAuthOptions).toHaveLength(1);
    expect(gotrue.calls.passkeyAuthOptions[0]?.[0]).toMatchObject({
      "x-forwarded-for": "203.0.113.9",
      "cf-connecting-ip": "203.0.113.9",
      "user-agent": "UA/1",
    });
  });

  it("accepts no body, an empty body and a captchaToken; rejects an oversize token", async () => {
    const { app } = await make({
      gotrue: stubGoTrue({ passkeyAuthOptions: async () => goTruePasskeyOptionsBody() }),
    });
    expect(
      (await app.inject({ method: "POST", url: "/auth/passkey/options", headers: WEB })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/passkey/options",
          headers: WEB,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/passkey/options",
          headers: WEB,
          payload: { captchaToken: "t" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/passkey/options",
          headers: WEB,
          payload: { captchaToken: "x".repeat(3000) },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("maps GoTrue failures: passkey_disabled -> 404, 4xx -> 401 passkey_failed, 5xx/transport -> 503", async () => {
    for (const [err, status, code] of [
      [new GoTrueError(404, "passkey_disabled"), 404, "passkey_disabled"],
      [new GoTrueError(429, "over_request_rate_limit"), 429, "rate_limited"],
      [new GoTrueError(500, "http_500"), 503, "internal"],
      [new GoTrueError(503, "ECONNREFUSED"), 503, "internal"],
      [new Error("boom"), 503, "internal"],
    ] as const) {
      const { app } = await make({
        gotrue: stubGoTrue({
          passkeyAuthOptions: async () => {
            throw err;
          },
        }),
      });
      const res = await app.inject({ method: "POST", url: "/auth/passkey/options", headers: WEB });
      expect(res.statusCode).toBe(status);
      expect(errorOf(res).error).toBe(code);
      await app.close();
    }
  });

  it("relays GoTrue's own options limiter as 429 rate_limited: Retry-After 120 when GoTrue sent one, no header otherwise", async () => {
    const withHeader = await make({
      gotrue: stubGoTrue({
        passkeyAuthOptions: async () => {
          throw new GoTrueError(429, "over_request_rate_limit", 120);
        },
      }),
    });
    const r1 = await withHeader.app.inject({
      method: "POST",
      url: "/auth/passkey/options",
      headers: WEB,
    });
    expect(r1.statusCode).toBe(429);
    expect(errorOf(r1).error).toBe("rate_limited");
    expect(r1.headers["retry-after"]).toBe("120");
    await withHeader.app.close();
    const without = await make({
      gotrue: stubGoTrue({
        passkeyAuthOptions: async () => {
          throw new GoTrueError(429, "over_request_rate_limit");
        },
      }),
    });
    const r2 = await without.app.inject({
      method: "POST",
      url: "/auth/passkey/options",
      headers: WEB,
    });
    expect(r2.statusCode).toBe(429);
    expect(errorOf(r2).error).toBe("rate_limited");
    expect(r2.headers["retry-after"]).toBeUndefined();
  });

  it("limits to 60 per IP per hour with Retry-After; another IP is unaffected", async () => {
    const { app, gotrue } = await make({
      gotrue: stubGoTrue({ passkeyAuthOptions: async () => goTruePasskeyOptionsBody() }),
    });
    const ip = { "cf-connecting-ip": "203.0.113.60" };
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/passkey/options",
        headers: { ...WEB, ...ip },
      });
      expect(res.statusCode, `call ${i + 1}`).toBe(200);
    }
    const sixtyFirst = await app.inject({
      method: "POST",
      url: "/auth/passkey/options",
      headers: { ...WEB, ...ip },
    });
    expect(sixtyFirst.statusCode).toBe(429);
    expect(errorOf(sixtyFirst).error).toBe("rate_limited");
    expect(Number(sixtyFirst.headers["retry-after"])).toBeGreaterThan(0);
    expect(gotrue.calls.passkeyAuthOptions).toHaveLength(60);
    const other = await app.inject({
      method: "POST",
      url: "/auth/passkey/options",
      headers: { ...WEB, "cf-connecting-ip": "203.0.113.61" },
    });
    expect(other.statusCode).toBe(200);
  });

  it("with Turnstile configured: captcha_required after 3 failed verifies from the IP; other IPs unaffected; captcha_failed on a bad token", async () => {
    const { app, gotrue } = await make({
      gotrue: stubGoTrue({ passkeyAuthOptions: async () => goTruePasskeyOptionsBody() }),
      config: { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_SITE_KEY: "site" },
    });
    const ip = { "cf-connecting-ip": "203.0.113.77" };
    const options = (headers: Record<string, string>, payload?: object) =>
      app.inject({
        method: "POST",
        url: "/auth/passkey/options",
        headers: { ...WEB, ...headers },
        payload,
      });
    // 3 failed verifies (UV missing: refused by the API itself, no GoTrue call)
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/passkey/verify",
        headers: { ...WEB, ...ip },
        payload: { challengeId: CH_ID, credential: assertionCredential({ flags: FLAGS_UP_ONLY }) },
      });
      expect(res.statusCode).toBe(401);
    }
    // before the 3rd failure the options route was open; now it asks for the captcha
    const needs = await options(ip);
    expect(needs.statusCode).toBe(403);
    expect(errorOf(needs).error).toBe("captcha_required");
    const bad = await options(ip, { captchaToken: "bad-token" });
    expect(bad.statusCode).toBe(403);
    expect(["captcha_failed", "captcha_required"]).toContain(errorOf(bad).error);
    expect(gotrue.calls.passkeyAuthOptions).toHaveLength(0);
    // another IP is unaffected
    expect((await options({ "cf-connecting-ip": "203.0.113.78" })).statusCode).toBe(200);
    expect(gotrue.calls.passkeyAuthVerify).toHaveLength(0);
  });

  it("never asks for a captcha without a Turnstile secret, however many failures", async () => {
    const { app } = await make({
      gotrue: stubGoTrue({ passkeyAuthOptions: async () => goTruePasskeyOptionsBody() }),
    });
    const ip = { "cf-connecting-ip": "203.0.113.79" };
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/auth/passkey/verify",
        headers: { ...WEB, ...ip },
        payload: { challengeId: CH_ID, credential: assertionCredential({ flags: FLAGS_UP_ONLY }) },
      });
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/passkey/options",
          headers: { ...WEB, ...ip },
        })
      ).statusCode,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------

let afterFetch: (() => void) | null = null;
afterEach(() => {
  afterFetch?.();
  afterFetch = null;
});

describe("POST /auth/passkey/verify (public)", () => {
  const verify = (
    a: NonNullable<typeof app>,
    payload: unknown,
    headers: Record<string, string> = {},
  ) =>
    a.inject({
      method: "POST",
      url: "/auth/passkey/verify",
      headers: { ...WEB, ...headers },
      payload: payload as object,
    });

  it("validates the body (bad challengeId, oversize clientDataJSON, wrong type) without calling GoTrue", async () => {
    const { app, gotrue } = await make();
    const good = assertionCredential();
    for (const payload of [
      {},
      { challengeId: "abc", credential: good },
      { challengeId: CH_ID },
      { challengeId: CH_ID, credential: { ...good, type: "password" } },
      {
        challengeId: CH_ID,
        credential: { ...good, response: { ...good.response, clientDataJSON: "A".repeat(8193) } },
      },
      {
        challengeId: CH_ID,
        credential: { ...good, response: { ...good.response, clientDataJSON: "{not-b64}" } },
      },
    ]) {
      const res = await verify(app, payload);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).error).toBe("validation_failed");
    }
    expect(gotrue.calls.passkeyAuthVerify).toHaveLength(0);
  });

  it("UV refusals (decision g): no UV flag, no authenticatorData, 36-byte authenticatorData -> 401 passkey_failed with ZERO GoTrue calls", async () => {
    const { app, gotrue } = await make();
    for (const credential of [
      assertionCredential({ flags: FLAGS_UP_ONLY }),
      assertionCredential({ flags: 0x00 }),
      assertionCredential({ omitAuthenticatorData: true }),
      assertionCredential({ flags: FLAGS_UV, authDataLength: 36 }),
    ]) {
      const res = await verify(app, { challengeId: CH_ID, credential });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).error).toBe("passkey_failed");
      expect(errorOf(res).message).toBe("That passkey didn't work. Use your email code instead.");
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    for (const calls of Object.values(gotrue.calls)) expect(calls).toHaveLength(0);
  });

  it("happy path, web: GoTrue session -> cookies (ll_access, ll_refresh), no tokens in the body, isFresh true, audit auth.sign_in method=passkey", async () => {
    const SESSION_ID = randomUUID();
    const session = await gotrueSession({ sub: UID, email: EMAIL, sessionId: SESSION_ID });
    const { app, gotrue, db, mailer } = await make({
      gotrue: stubGoTrue({ passkeyAuthVerify: async () => session }),
    });
    const credential = assertionCredential({ flags: FLAGS_UV });
    const res = await verify(
      app,
      { challengeId: CH_ID, credential },
      {
        "cf-connecting-ip": "203.0.113.5",
        "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1",
        "cf-ipcountry": "de",
      },
    );
    expect(res.statusCode).toBe(200);
    const body = sessionResponseSchema.parse(res.json());
    expect(body.user).toEqual({ id: UID, email: EMAIL });
    expect(body.session.isFresh).toBe(true);
    expect(body.tokens).toBeUndefined();
    expect(res.body).not.toContain(session.accessToken);
    expect(res.body).not.toContain(session.refreshToken);
    const cookies = cookiesOf(res);
    expect(
      cookies.some((c) => c.startsWith(`ll_access=${session.accessToken}`) && /HttpOnly/i.test(c)),
    ).toBe(true);
    expect(
      cookies.some(
        (c) => c.startsWith(`ll_refresh=${session.refreshToken}`) && /HttpOnly/i.test(c),
      ),
    ).toBe(true);
    // GoTrue got the ceremony and the client facts
    expect(gotrue.calls.passkeyAuthVerify).toHaveLength(1);
    expect(gotrue.calls.passkeyAuthVerify[0]?.[0]).toEqual({ challengeId: CH_ID, credential });
    expect(gotrue.calls.passkeyAuthVerify[0]?.[1]).toMatchObject({
      "x-forwarded-for": "203.0.113.5",
    });
    // audit: one auth.sign_in with method passkey and only the allowed keys
    const signIns = db.audits.filter((a) => a.event === "auth.sign_in");
    expect(signIns).toHaveLength(1);
    expect(signIns[0]?.actorUserId).toBe(UID);
    expect(signIns[0]?.metadata).toEqual({
      client: "web",
      user_agent_label: "Safari on iPhone",
      ip_country: "DE",
      method: "passkey",
      session_id: SESSION_ID,
    });
    // never credential or challenge material in any audit row (or anything bound to the db)
    const everything = JSON.stringify(db.queries) + JSON.stringify(db.audits);
    for (const secret of [
      CH_ID,
      credential.id,
      credential.response.clientDataJSON,
      credential.response.authenticatorData,
      credential.response.signature,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain("203.0.113.5");
    // one live session: no new-device alert
    expect(mailer.sent).toHaveLength(0);
  });

  it("happy path, native: tokens in the body, no cookies, audit client=native", async () => {
    const session = await gotrueSession({ sub: UID, email: EMAIL });
    const { app, db } = await make({
      gotrue: stubGoTrue({ passkeyAuthVerify: async () => session }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/passkey/verify",
      headers: NATIVE,
      payload: { challengeId: CH_ID, credential: assertionCredential() },
    });
    expect(res.statusCode).toBe(200);
    const body = sessionResponseSchema.parse(res.json());
    expect(body.tokens).toEqual({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: 3600,
    });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(db.audits.find((a) => a.event === "auth.sign_in")?.metadata).toMatchObject({
      client: "native",
      method: "passkey",
    });
  });

  it("a second live session triggers the new-device alert (same path as OTP)", async () => {
    const session = await gotrueSession({ sub: UID, email: EMAIL });
    const { app, db, mailer } = await make({
      gotrue: stubGoTrue({ passkeyAuthVerify: async () => session }),
      db: fakeDb({ liveSessions: 2 }),
    });
    const res = await verify(app, { challengeId: CH_ID, credential: assertionCredential() });
    expect(res.statusCode).toBe(200);
    expect(db.audits.map((a) => a.event)).toEqual(["auth.sign_in", "auth.new_device"]);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(EMAIL);
  });

  it("a passkey sign-in with a session already presented signs the old one out at GoTrue (local)", async () => {
    const session = await gotrueSession({ sub: UID, email: EMAIL });
    const { app, gotrue } = await make({
      gotrue: stubGoTrue({ passkeyAuthVerify: async () => session }),
    });
    const old = await bearer();
    const res = await app.inject({
      method: "POST",
      url: "/auth/passkey/verify",
      headers: { ...WEB, cookie: `ll_access=${old.token}` },
      payload: { challengeId: CH_ID, credential: assertionCredential() },
    });
    expect(res.statusCode).toBe(200);
    expect(gotrue.calls.logout).toHaveLength(1);
    expect(gotrue.calls.logout[0]?.[0]).toBe(old.token);
    expect(gotrue.calls.logout[0]?.[1]).toBe("local");
  });

  it("a suspended account's passkey sign-in is 403 account_suspended and the new GoTrue session is ended globally", async () => {
    const session = await gotrueSession({ sub: UID, email: EMAIL });
    const { app, gotrue } = await make({
      gotrue: stubGoTrue({ passkeyAuthVerify: async () => session }),
      db: fakeDb({ suspended: true }),
    });
    const res = await verify(app, { challengeId: CH_ID, credential: assertionCredential() });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).error).toBe("account_suspended");
    expect(gotrue.calls.logout).toEqual([[session.accessToken, "global", expect.anything()]]);
  });

  it("maps every GoTrue (status, error_code) exactly (decision b); the body never names the cause", async () => {
    const cases: [number, string, number, string][] = [
      [404, "passkey_disabled", 404, "passkey_disabled"],
      [400, "webauthn_verification_failed", 401, "passkey_failed"],
      [400, "webauthn_challenge_not_found", 401, "passkey_failed"],
      [400, "webauthn_challenge_expired", 401, "passkey_failed"],
      [400, "validation_failed", 401, "passkey_failed"],
      [400, "bad_json", 401, "passkey_failed"],
      [403, "email_not_confirmed", 401, "passkey_failed"],
      [403, "user_banned", 401, "passkey_failed"],
      [403, "insufficient_aal", 401, "passkey_failed"],
      [404, "validation_failed", 401, "passkey_failed"],
      [422, "validation_failed", 401, "passkey_failed"],
      [422, "too_many_passkeys", 409, "passkey_limit"],
      [422, "webauthn_credential_exists", 409, "passkey_exists"],
      [500, "http_500", 503, "internal"],
      [502, "bad_session_body", 503, "internal"],
      [503, "ECONNREFUSED", 503, "internal"],
      [503, "timeout", 503, "internal"],
    ];
    for (const [gs, gc, status, code] of cases) {
      const { app } = await make({
        gotrue: stubGoTrue({
          passkeyAuthVerify: async () => {
            throw new GoTrueError(gs, gc);
          },
        }),
      });
      const res = await verify(app, { challengeId: CH_ID, credential: assertionCredential() });
      expect(res.statusCode, `${gs} ${gc}`).toBe(status);
      const e = errorOf(res);
      expect(e.error, `${gs} ${gc}`).toBe(code);
      // the body names the API code only (identical to GoTrue's for passkey_disabled, by design)
      if (gc !== code) expect(res.body).not.toContain(gc);
      expect(res.headers["set-cookie"]).toBeUndefined();
      await app.close();
    }
  });

  it("failures per IP: the 11th within 15 minutes is 429 rate_limited with Retry-After; no GoTrue call for API-side refusals", async () => {
    const { app, gotrue } = await make();
    const ip = { "cf-connecting-ip": "203.0.113.11" };
    for (let i = 0; i < 10; i++) {
      const res = await verify(
        app,
        { challengeId: CH_ID, credential: assertionCredential({ flags: FLAGS_UP_ONLY }) },
        ip,
      );
      expect(res.statusCode, `failure ${i + 1}`).toBe(401);
    }
    const eleventh = await verify(
      app,
      { challengeId: CH_ID, credential: assertionCredential({ flags: FLAGS_UV }) },
      ip,
    );
    expect(eleventh.statusCode).toBe(429);
    expect(errorOf(eleventh).error).toBe("rate_limited");
    expect(Number(eleventh.headers["retry-after"])).toBeGreaterThan(0);
    expect(gotrue.calls.passkeyAuthVerify).toHaveLength(0);
    // another IP still gets through to the UV check
    const other = await verify(
      app,
      { challengeId: CH_ID, credential: assertionCredential({ flags: FLAGS_UP_ONLY }) },
      { "cf-connecting-ip": "203.0.113.12" },
    );
    expect(other.statusCode).toBe(401);
  });

  it("GoTrue-side failures count against the failure limit too", async () => {
    const { app, gotrue } = await make({
      gotrue: stubGoTrue({
        passkeyAuthVerify: async () => {
          throw new GoTrueError(400, "webauthn_verification_failed");
        },
      }),
    });
    const ip = { "cf-connecting-ip": "203.0.113.13" };
    for (let i = 0; i < 10; i++) {
      expect(
        (await verify(app, { challengeId: CH_ID, credential: assertionCredential() }, ip))
          .statusCode,
      ).toBe(401);
    }
    expect(
      (await verify(app, { challengeId: CH_ID, credential: assertionCredential() }, ip)).statusCode,
    ).toBe(429);
    expect(gotrue.calls.passkeyAuthVerify).toHaveLength(10);
  });

  it("(1) GoTrue outage (503 transport) ×10: each answers 503, the failure limiter stays at 0, the total limiter counts 10, options from that IP stay open (Turnstile configured)", async () => {
    const { app, gotrue } = await make({
      gotrue: stubGoTrue({
        passkeyAuthOptions: async () => goTruePasskeyOptionsBody(),
        passkeyAuthVerify: async () => {
          throw new GoTrueError(503, "network");
        },
      }),
      config: { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_SITE_KEY: "site" },
    });
    const IP = "203.0.113.101";
    const ip = { "cf-connecting-ip": IP };
    for (let i = 0; i < 10; i++) {
      const res = await verify(app, { challengeId: CH_ID, credential: assertionCredential() }, ip);
      expect(res.statusCode, `attempt ${i + 1}`).toBe(503);
    }
    const { throttles } = app.authRuntime;
    expect(throttles.passkeyVerifyFailuresPerIp.count(IP)).toBe(0);
    expect(throttles.passkeyVerifyPerIp.count(IP)).toBe(10);
    expect(gotrue.calls.passkeyAuthVerify).toHaveLength(10);
    const options = await app.inject({
      method: "POST",
      url: "/auth/passkey/options",
      headers: { ...WEB, ...ip },
    });
    expect(options.statusCode).toBe(200);
  });

  it("(2) a GoTrue 500 and a 404 passkey_disabled leave the failure counter unchanged", async () => {
    let err: GoTrueError = new GoTrueError(500, "unexpected_failure");
    const { app } = await make({
      gotrue: stubGoTrue({
        passkeyAuthVerify: async () => {
          throw err;
        },
      }),
      config: { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_SITE_KEY: "site" },
    });
    const IP = "203.0.113.102";
    const ip = { "cf-connecting-ip": IP };
    const failures = app.authRuntime.throttles.passkeyVerifyFailuresPerIp;
    const r500 = await verify(app, { challengeId: CH_ID, credential: assertionCredential() }, ip);
    expect(r500.statusCode).toBe(503);
    expect(failures.count(IP)).toBe(0);
    err = new GoTrueError(404, "passkey_disabled");
    const r404 = await verify(app, { challengeId: CH_ID, credential: assertionCredential() }, ip);
    expect(r404.statusCode).toBe(404);
    expect(errorOf(r404).error).toBe("passkey_disabled");
    expect(failures.count(IP)).toBe(0);
    expect(app.authRuntime.throttles.passkeyVerifyPerIp.count(IP)).toBe(2);
  });

  it("(3) one no-UV refusal + two GoTrue webauthn_verification_failed = 3 failures: options asks for the captcha; a valid token passes", async () => {
    let verified: { token: string; ip: string } | null = null;
    // Turnstile talks to Cloudflare over the global fetch (bound when the runtime is created):
    // answer it here, before the app is built (good-token succeeds).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body ?? ""));
      verified = { token: form.get("response") ?? "", ip: form.get("remoteip") ?? "" };
      expect(String(url)).toContain("challenges.cloudflare.com");
      return new Response(JSON.stringify({ success: form.get("response") === "good-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    afterFetch = () => {
      globalThis.fetch = realFetch;
    };
    const { app } = await make({
      gotrue: stubGoTrue({
        passkeyAuthOptions: async () => goTruePasskeyOptionsBody(),
        passkeyAuthVerify: async () => {
          throw new GoTrueError(400, "webauthn_verification_failed");
        },
      }),
      config: { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_SITE_KEY: "site" },
    });
    const IP = "203.0.113.103";
    const ip = { "cf-connecting-ip": IP };
    const failures = app.authRuntime.throttles.passkeyVerifyFailuresPerIp;
    const noUv = await verify(
      app,
      { challengeId: CH_ID, credential: assertionCredential({ flags: FLAGS_UP_ONLY }) },
      ip,
    );
    expect(noUv.statusCode).toBe(401);
    expect(failures.count(IP)).toBe(1);
    for (let i = 0; i < 2; i++) {
      const res = await verify(app, { challengeId: CH_ID, credential: assertionCredential() }, ip);
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).error).toBe("passkey_failed");
    }
    expect(failures.count(IP)).toBe(3);
    const options = (payload?: object) =>
      app.inject({
        method: "POST",
        url: "/auth/passkey/options",
        headers: { ...WEB, ...ip },
        payload,
      });
    const needs = await options();
    expect(needs.statusCode).toBe(403);
    expect(errorOf(needs).error).toBe("captcha_required");
    const bad = await options({ captchaToken: "bad-token" });
    expect(bad.statusCode).toBe(403);
    expect(errorOf(bad).error).toBe("captcha_failed");
    const ok = await options({ captchaToken: "good-token" });
    expect(ok.statusCode).toBe(200);
    expect(verified).toEqual({ token: "good-token", ip: IP });
  });

  it("(4) the 11th genuine failure is 429 with Retry-After while 60 outage attempts from another IP never reach the failure limiter", async () => {
    let outage = false;
    const { app } = await make({
      gotrue: stubGoTrue({
        passkeyAuthVerify: async () => {
          throw outage
            ? new GoTrueError(503, "network")
            : new GoTrueError(400, "webauthn_verification_failed");
        },
      }),
      config: { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_SITE_KEY: "site" },
    });
    const { throttles } = app.authRuntime;
    // genuine failures
    const G = "203.0.113.104";
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await verify(
            app,
            { challengeId: CH_ID, credential: assertionCredential() },
            { "cf-connecting-ip": G },
          )
        ).statusCode,
      ).toBe(401);
    }
    const eleventh = await verify(
      app,
      { challengeId: CH_ID, credential: assertionCredential() },
      { "cf-connecting-ip": G },
    );
    expect(eleventh.statusCode).toBe(429);
    expect(errorOf(eleventh).error).toBe("rate_limited");
    expect(Number(eleventh.headers["retry-after"])).toBeGreaterThan(0);
    expect(throttles.passkeyVerifyFailuresPerIp.count(G)).toBe(10);
    // outage attempts
    outage = true;
    const O = "203.0.113.105";
    for (let i = 0; i < 60; i++) {
      expect(
        (
          await verify(
            app,
            { challengeId: CH_ID, credential: assertionCredential() },
            { "cf-connecting-ip": O },
          )
        ).statusCode,
        `outage attempt ${i + 1}`,
      ).toBe(503);
    }
    expect(throttles.passkeyVerifyFailuresPerIp.count(O)).toBe(0);
    expect(throttles.passkeyVerifyPerIp.count(O)).toBe(60);
    // the hourly total limiter still applies to the outage IP (61st is 429), unrelated to failures
    const sixtyFirst = await verify(
      app,
      { challengeId: CH_ID, credential: assertionCredential() },
      { "cf-connecting-ip": O },
    );
    expect(sixtyFirst.statusCode).toBe(429);
  });

  it("total attempts per IP: the 61st verify within an hour is 429 even when every earlier one succeeded", async () => {
    const { app, gotrue } = await make({
      gotrue: stubGoTrue({
        passkeyAuthVerify: async () => gotrueSession({ sub: UID, email: EMAIL }),
      }),
    });
    const ip = { "cf-connecting-ip": "203.0.113.61" };
    for (let i = 0; i < 60; i++) {
      const res = await verify(app, { challengeId: CH_ID, credential: assertionCredential() }, ip);
      expect(res.statusCode, `attempt ${i + 1}`).toBe(200);
    }
    const sixtyFirst = await verify(
      app,
      { challengeId: CH_ID, credential: assertionCredential() },
      ip,
    );
    expect(sixtyFirst.statusCode).toBe(429);
    expect(errorOf(sixtyFirst).error).toBe("rate_limited");
    expect(Number(sixtyFirst.headers["retry-after"])).toBeGreaterThan(0);
    expect(gotrue.calls.passkeyAuthVerify).toHaveLength(60);
  });
});

// ---------------------------------------------------------------------------------------------

describe("/me/passkeys* (signed in)", () => {
  it("every management route needs a session (401) and, via cookie, the CSRF header (403)", async () => {
    const { app, gotrue } = await make({ gotrue: managementStub() });
    for (const [method, url, payload] of ALL_ROUTES.slice(2)) {
      const res = await app.inject({
        method: method as "GET",
        url,
        headers: WEB,
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(errorOf(res).error).toBe("unauthorized");
    }
    const me = await bearer();
    const csrf = await app.inject({
      method: "POST",
      url: "/me/passkeys/options",
      cookies: { ll_access: me.token },
    });
    expect(csrf.statusCode).toBe(403);
    expect(errorOf(csrf).error).toBe("csrf_rejected");
    for (const calls of Object.values(gotrue.calls)) expect(calls).toHaveLength(0);
  });

  it("a revoked session is 401 session_revoked; missing consent is 403 consent_required", async () => {
    const gone = await make({ gotrue: managementStub(), db: fakeDb({ sessionGone: true }) });
    const me = await bearer();
    const r1 = await gone.app.inject({ method: "GET", url: "/me/passkeys", headers: me.headers });
    expect(r1.statusCode).toBe(401);
    expect(errorOf(r1).error).toBe("session_revoked");
    await gone.app.close();
    const noConsent = await make({ gotrue: managementStub(), db: fakeDb({ consent: false }) });
    const r2 = await noConsent.app.inject({
      method: "GET",
      url: "/me/passkeys",
      headers: me.headers,
    });
    expect(r2.statusCode).toBe(403);
    expect(errorOf(r2).error).toBe("consent_required");
    expect(noConsent.gotrue.calls.passkeyList).toHaveLength(0);
  });

  describe("GET /me/passkeys", () => {
    it("lists the caller's passkeys newest first with defaults filled, max = 5, and passes the caller's own token to GoTrue", async () => {
      const list = [
        goTruePasskeyBody({ id: PK_ID, created_at: "2026-10-01T00:00:00Z" }),
        goTruePasskeyBody({
          id: CH_ID,
          friendly_name: "Laptop",
          created_at: "2026-10-05T00:00:00Z",
          last_used_at: "2026-10-11T08:00:00Z",
        }),
      ];
      const { app, gotrue } = await make({ gotrue: managementStub(list) });
      const me = await bearer();
      const res = await app.inject({ method: "GET", url: "/me/passkeys", headers: me.headers });
      expect(res.statusCode).toBe(200);
      const body = passkeysListResponseSchema.parse(res.json());
      expect(body.max).toBe(PASSKEY_MAX_PER_USER);
      expect(body.passkeys).toEqual([
        {
          id: CH_ID,
          name: "Laptop",
          createdAt: "2026-10-05T00:00:00Z",
          lastUsedAt: "2026-10-11T08:00:00Z",
        },
        { id: PK_ID, name: "Passkey", createdAt: "2026-10-01T00:00:00Z", lastUsedAt: null },
      ]);
      expect(gotrue.calls.passkeyList).toEqual([[me.token]]);
      // the cookie transport works for GET too
      const viaCookie = await app.inject({
        method: "GET",
        url: "/me/passkeys",
        cookies: { ll_access: me.token },
      });
      expect(viaCookie.statusCode).toBe(200);
    });

    it("an empty list is { passkeys: [], max: 5 }; GoTrue down is 503; feature-off upstream is 404", async () => {
      const { app } = await make({ gotrue: managementStub([]) });
      const me = await bearer();
      expect(
        (await app.inject({ method: "GET", url: "/me/passkeys", headers: me.headers })).json(),
      ).toEqual({
        passkeys: [],
        max: 5,
      });
      await app.close();
      for (const [err, status, code] of [
        [new GoTrueError(503, "ECONNREFUSED"), 503, "internal"],
        [new GoTrueError(502, "bad_passkey_body"), 503, "internal"],
        [new GoTrueError(404, "passkey_disabled"), 404, "passkey_disabled"],
        [new GoTrueError(401, "no_authorization"), 401, "passkey_failed"],
      ] as const) {
        const down = await make({
          gotrue: stubGoTrue({
            passkeyList: async () => {
              throw err;
            },
          }),
        });
        const res = await down.app.inject({
          method: "GET",
          url: "/me/passkeys",
          headers: me.headers,
        });
        expect(res.statusCode).toBe(status);
        expect(errorOf(res).error).toBe(code);
        await down.app.close();
      }
    });
  });

  describe("POST /me/passkeys/options", () => {
    it("returns registration options (ISO expiresAt) after pre-checking the list; forwards client headers with the bearer", async () => {
      const { app, gotrue } = await make({ gotrue: managementStub([goTruePasskeyBody()]) });
      const me = await bearer();
      const res = await app.inject({
        method: "POST",
        url: "/me/passkeys/options",
        headers: { ...me.headers, "cf-connecting-ip": "203.0.113.5", "user-agent": "UA/2" },
      });
      expect(res.statusCode).toBe(200);
      const body = passkeyOptionsResponseSchema.parse(res.json());
      expect(body.challengeId).toBe(CH_ID);
      expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(gotrue.calls.passkeyList).toEqual([[me.token]]);
      expect(gotrue.calls.passkeyRegOptions).toHaveLength(1);
      expect(gotrue.calls.passkeyRegOptions[0]?.[0]).toBe(me.token);
      expect(gotrue.calls.passkeyRegOptions[0]?.[1]).toMatchObject({
        "x-forwarded-for": "203.0.113.5",
        "user-agent": "UA/2",
      });
    });

    it("409 passkey_limit { max: 5 } when the account already has 5, without asking GoTrue for options", async () => {
      const five = Array.from({ length: 5 }, () => goTruePasskeyBody());
      const { app, gotrue } = await make({ gotrue: managementStub(five) });
      const me = await bearer();
      const res = await app.inject({
        method: "POST",
        url: "/me/passkeys/options",
        headers: me.headers,
      });
      expect(res.statusCode).toBe(409);
      const e = errorOf(res);
      expect(e.error).toBe("passkey_limit");
      expect(e.details).toEqual({ max: 5 });
      expect(gotrue.calls.passkeyRegOptions).toHaveLength(0);
    });

    it("the store-review account is refused with 403 passkey_unavailable_for_account (Q6), no GoTrue call", async () => {
      const { app, gotrue } = await make({
        gotrue: managementStub([]),
        config: {
          REVIEW_ACCOUNT_EMAIL: REVIEW_EMAIL,
          REVIEW_ACCOUNT_CODE_HASH: await hashPasscode("123456"),
        },
      });
      const reviewer = await bearer({ email: REVIEW_EMAIL });
      const res = await app.inject({
        method: "POST",
        url: "/me/passkeys/options",
        headers: reviewer.headers,
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).error).toBe("passkey_unavailable_for_account");
      const reg = await app.inject({
        method: "POST",
        url: "/me/passkeys",
        headers: reviewer.headers,
        payload: { challengeId: CH_ID, credential: registrationCredential() },
      });
      expect(reg.statusCode).toBe(403);
      expect(errorOf(reg).error).toBe("passkey_unavailable_for_account");
      expect(gotrue.calls.passkeyList).toHaveLength(0);
      expect(gotrue.calls.passkeyRegOptions).toHaveLength(0);
      expect(gotrue.calls.passkeyRegVerify).toHaveLength(0);
      // a normal account on the same server is fine, and the review account may still list
      const parent = await bearer();
      expect(
        (await app.inject({ method: "POST", url: "/me/passkeys/options", headers: parent.headers }))
          .statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: "/me/passkeys", headers: reviewer.headers }))
          .statusCode,
      ).toBe(200);
    });

    it("maps GoTrue's options failures: insufficient_aal -> 401 passkey_failed, outage -> 503", async () => {
      for (const [err, status, code] of [
        [new GoTrueError(403, "insufficient_aal"), 401, "passkey_failed"],
        [new GoTrueError(500, "http_500"), 503, "internal"],
      ] as const) {
        const { app } = await make({
          gotrue: stubGoTrue({
            passkeyList: async () => [],
            passkeyRegOptions: async () => {
              throw err;
            },
          }),
        });
        const me = await bearer();
        const res = await app.inject({
          method: "POST",
          url: "/me/passkeys/options",
          headers: me.headers,
        });
        expect(res.statusCode).toBe(status);
        expect(errorOf(res).error).toBe(code);
        await app.close();
      }
    });
  });

  describe("POST /me/passkeys (register)", () => {
    const register = (
      a: NonNullable<typeof app>,
      headers: Record<string, string>,
      payload: unknown,
    ) =>
      a.inject({
        method: "POST",
        url: "/me/passkeys",
        headers: { ...WEB, ...headers },
        payload: payload as object,
      });

    it("201 passkeySchema from GoTrue's 200; renames when a name is given; audit auth.passkey_added { passkey_id, client }; Q7 email with no link and no name", async () => {
      const { app, gotrue, db, mailer } = await make({ gotrue: managementStub([]) });
      const me = await bearer();
      const credential = registrationCredential({ flags: FLAGS_UV });
      const res = await register(
        app,
        { ...me.headers, "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1", "cf-ipcountry": "DE" },
        { challengeId: CH_ID, credential, name: "  Mom's iPhone  " },
      );
      expect(res.statusCode).toBe(201);
      const body = passkeySchema.parse(res.json());
      expect(body).toEqual({
        id: PK_ID,
        name: "Mom's iPhone",
        createdAt: "2026-10-11T12:34:56.123456Z",
        lastUsedAt: null,
      });
      expect(gotrue.calls.passkeyRegVerify).toHaveLength(1);
      expect(gotrue.calls.passkeyRegVerify[0]?.[0]).toBe(me.token);
      expect(gotrue.calls.passkeyRegVerify[0]?.[1]).toEqual({ challengeId: CH_ID, credential });
      expect(gotrue.calls.passkeyRename).toEqual([[me.token, PK_ID, "Mom's iPhone"]]);
      // audit
      const added = db.audits.filter((a) => a.event === "auth.passkey_added");
      expect(added).toHaveLength(1);
      expect(added[0]?.actorUserId).toBe(UID);
      expect(added[0]?.metadata).toEqual({ passkey_id: PK_ID, client: "web" });
      const everything = JSON.stringify(db.audits) + JSON.stringify(db.queries);
      expect(everything).not.toContain("Mom's iPhone");
      expect(everything).not.toContain(CH_ID);
      expect(everything).not.toContain(credential.id);
      expect(everything).not.toContain(credential.response.attestationObject);
      // Q7 email
      expect(mailer.sent).toHaveLength(1);
      const mail = mailer.sent[0];
      expect(mail?.to).toBe(EMAIL);
      expect(mail?.template).toBe("passkey_added");
      expect(mail?.subject).toBe("A passkey was added to your Tinyglow account");
      expect(mail?.html).not.toContain("<a ");
      expect(mail?.text).not.toMatch(/https?:\/\//);
      expect(mail?.text).not.toContain("Mom's iPhone");
      expect(mail?.html).not.toContain("Mom's iPhone");
      expect(mail?.text).toContain("Safari on iPhone");
      expect(mail?.text).toContain("country DE");
    });

    it("without a name: no rename call, name defaults to Passkey", async () => {
      const { app, gotrue } = await make({ gotrue: managementStub([]) });
      const me = await bearer();
      const res = await register(app, me.headers, {
        challengeId: CH_ID,
        credential: registrationCredential(),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe("Passkey");
      expect(gotrue.calls.passkeyRename).toHaveLength(0);
    });

    it("UV refusal on the attestation (decision g): UP-only, 36-byte authData, no attestationObject -> 401 passkey_failed, zero GoTrue calls, no audit, no mail", async () => {
      const { app, gotrue, db, mailer } = await make({ gotrue: managementStub([]) });
      const me = await bearer();
      const noObject = registrationCredential();
      delete (noObject.response as { attestationObject?: string }).attestationObject;
      for (const credential of [
        registrationCredential({ flags: FLAGS_UP_ONLY }),
        registrationCredential({ flags: FLAGS_UV, authDataLength: 36 }),
        noObject,
      ]) {
        const res = await register(app, me.headers, { challengeId: CH_ID, credential });
        expect(res.statusCode).toBe(401);
        expect(errorOf(res).error).toBe("passkey_failed");
      }
      expect(gotrue.calls.passkeyRegVerify).toHaveLength(0);
      expect(gotrue.calls.passkeyRename).toHaveLength(0);
      expect(db.audits).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);
    });

    it("a control character in the name is 400 validation_failed naming body.name, before GoTrue", async () => {
      const { app, gotrue } = await make({ gotrue: managementStub([]) });
      const me = await bearer();
      for (const name of ["Phone\u0007", "Pho\nne", "Pho\u0085ne", "Pho\u2028ne"]) {
        const res = await register(app, me.headers, {
          challengeId: CH_ID,
          credential: registrationCredential(),
          name,
        });
        expect(res.statusCode).toBe(400);
        expect(errorOf(res).error).toBe("validation_failed");
        expect(errorOf(res).details).toEqual({ fields: ["body.name"] });
        expect(res.body).not.toContain("Phone");
      }
      expect(gotrue.calls.passkeyRegVerify).toHaveLength(0);
    });

    it("a failed rename after a successful verify still answers 201 (the passkey exists) with the default name", async () => {
      const { app, db } = await make({
        gotrue: stubGoTrue({
          passkeyList: async () => [],
          passkeyRegVerify: async () => goTruePasskeyBody({ id: PK_ID }),
          passkeyRename: async () => {
            throw new GoTrueError(503, "timeout");
          },
        }),
      });
      const me = await bearer();
      const res = await register(app, me.headers, {
        challengeId: CH_ID,
        credential: registrationCredential(),
        name: "Laptop",
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe("Passkey");
      expect(db.audits.filter((a) => a.event === "auth.passkey_added")).toHaveLength(1);
    });

    it("maps GoTrue's verify failures exactly (too_many_passkeys 409 {max}, credential_exists 409, 400s -> 401, 404 validation_failed -> 401 here)", async () => {
      const cases: [number, string, number, string][] = [
        [422, "too_many_passkeys", 409, "passkey_limit"],
        [422, "webauthn_credential_exists", 409, "passkey_exists"],
        [400, "webauthn_challenge_expired", 401, "passkey_failed"],
        [400, "webauthn_verification_failed", 401, "passkey_failed"],
        [400, "validation_failed", 401, "passkey_failed"],
        [404, "validation_failed", 401, "passkey_failed"],
        [403, "insufficient_aal", 401, "passkey_failed"],
        [404, "passkey_disabled", 404, "passkey_disabled"],
        [503, "network", 503, "internal"],
      ];
      for (const [gs, gc, status, code] of cases) {
        const { app, db, mailer } = await make({
          gotrue: stubGoTrue({
            passkeyList: async () => [],
            passkeyRegVerify: async () => {
              throw new GoTrueError(gs, gc);
            },
          }),
        });
        const me = await bearer();
        const res = await register(app, me.headers, {
          challengeId: CH_ID,
          credential: registrationCredential(),
        });
        expect(res.statusCode, `${gs} ${gc}`).toBe(status);
        expect(errorOf(res).error, `${gs} ${gc}`).toBe(code);
        if (code === "passkey_limit") expect(errorOf(res).details).toEqual({ max: 5 });
        expect(db.audits).toHaveLength(0);
        expect(mailer.sent).toHaveLength(0);
        await app.close();
      }
    });

    it("adding does NOT need a fresh sign-in (Q4): a 30-minute-old session may register", async () => {
      const { app } = await make({ gotrue: managementStub([]), db: fakeDb({ sessionAgeMin: 30 }) });
      const me = await bearer();
      const res = await register(app, me.headers, {
        challengeId: CH_ID,
        credential: registrationCredential(),
      });
      expect(res.statusCode).toBe(201);
    });

    it("a mailer failure never fails the registration", async () => {
      const { app, mailer } = await make({ gotrue: managementStub([]) });
      mailer.send = async () => {
        throw new Error("smtp down");
      };
      const me = await bearer();
      const res = await register(app, me.headers, {
        challengeId: CH_ID,
        credential: registrationCredential(),
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe("PATCH /me/passkeys/:id (rename)", () => {
    it("renames via GoTrue with the caller's token, answers passkeySchema, audits auth.passkey_renamed { passkey_id } only", async () => {
      const { app, gotrue, db, mailer } = await make({ gotrue: managementStub() });
      const me = await bearer();
      const res = await app.inject({
        method: "PATCH",
        url: `/me/passkeys/${PK_ID}`,
        headers: me.headers,
        payload: { name: " Work laptop " },
      });
      expect(res.statusCode).toBe(200);
      expect(passkeySchema.parse(res.json()).name).toBe("Work laptop");
      expect(gotrue.calls.passkeyRename).toEqual([[me.token, PK_ID, "Work laptop"]]);
      expect(db.audits).toEqual([
        expect.objectContaining({
          event: "auth.passkey_renamed",
          actorUserId: UID,
          metadata: { passkey_id: PK_ID },
        }),
      ]);
      expect(JSON.stringify(db.audits)).not.toContain("Work laptop");
      // renaming sends no email and needs no fresh sign-in
      expect(mailer.sent).toHaveLength(0);
    });

    it("works for a stale session (not destructive)", async () => {
      const { app } = await make({ gotrue: managementStub(), db: fakeDb({ sessionAgeMin: 60 }) });
      const me = await bearer();
      const res = await app.inject({
        method: "PATCH",
        url: `/me/passkeys/${PK_ID}`,
        headers: me.headers,
        payload: { name: "x" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("404 not_found for an unknown id (GoTrue 404 validation_failed) and for a non-uuid id (no GoTrue call)", async () => {
      const { app, gotrue } = await make({
        gotrue: stubGoTrue({
          passkeyRename: async () => {
            throw new GoTrueError(404, "validation_failed");
          },
        }),
      });
      const me = await bearer();
      const unknown = await app.inject({
        method: "PATCH",
        url: `/me/passkeys/${randomUUID()}`,
        headers: me.headers,
        payload: { name: "x" },
      });
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).error).toBe("not_found");
      expect(gotrue.calls.passkeyRename).toHaveLength(1);
      const notUuid = await app.inject({
        method: "PATCH",
        url: "/me/passkeys/not-a-uuid",
        headers: me.headers,
        payload: { name: "x" },
      });
      expect([400, 404]).toContain(notUuid.statusCode);
      expect(gotrue.calls.passkeyRename).toHaveLength(1);
    });

    it("validates the name: empty/blank/too long -> 400; control characters -> 400 naming body.name", async () => {
      const { app, gotrue } = await make({ gotrue: managementStub() });
      const me = await bearer();
      for (const payload of [
        {},
        { name: "" },
        { name: "   " },
        { name: "x".repeat(61) },
        { name: "a\u0007" },
      ]) {
        const res = await app.inject({
          method: "PATCH",
          url: `/me/passkeys/${PK_ID}`,
          headers: me.headers,
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(errorOf(res).error).toBe("validation_failed");
      }
      expect(gotrue.calls.passkeyRename).toHaveLength(0);
    });
  });

  describe("DELETE /me/passkeys/:id (remove)", () => {
    it("needs a fresh sign-in (Q4): a stale session is 403 fresh_sign_in_required with no GoTrue call, no audit, no mail", async () => {
      const { app, gotrue, db, mailer } = await make({
        gotrue: managementStub(),
        db: fakeDb({ sessionAgeMin: 11 }),
      });
      const me = await bearer();
      const res = await app.inject({
        method: "DELETE",
        url: `/me/passkeys/${PK_ID}`,
        headers: me.headers,
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).error).toBe("fresh_sign_in_required");
      expect(gotrue.calls.passkeyDelete).toHaveLength(0);
      expect(db.audits).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);
    });

    it("fresh: 204, GoTrue delete with the caller's token, audit auth.passkey_removed { passkey_id, client }, Q7 email (no link, no name)", async () => {
      const { app, gotrue, db, mailer } = await make({
        gotrue: managementStub(),
        db: fakeDb({ sessionAgeMin: 9 }),
      });
      const me = await bearer();
      const res = await app.inject({
        method: "DELETE",
        url: `/me/passkeys/${PK_ID}`,
        headers: {
          ...me.headers,
          ...NATIVE,
          "user-agent": "Mozilla/5.0 (Linux; Android 15) Tinyglow/1.0.0",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect(gotrue.calls.passkeyDelete).toEqual([[me.token, PK_ID]]);
      expect(db.audits).toEqual([
        expect.objectContaining({
          event: "auth.passkey_removed",
          actorUserId: UID,
          metadata: { passkey_id: PK_ID, client: "native" },
        }),
      ]);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.template).toBe("passkey_removed");
      expect(mailer.sent[0]?.subject).toBe("A passkey was removed from your Tinyglow account");
      expect(mailer.sent[0]?.html).not.toContain("<a ");
      expect(mailer.sent[0]?.text).not.toMatch(/https?:\/\//);
      expect(mailer.sent[0]?.text).toContain("Tinyglow app on Android");
    });

    it("removing the last passkey is allowed (the email code remains)", async () => {
      const { app } = await make({ gotrue: managementStub([goTruePasskeyBody({ id: PK_ID })]) });
      const me = await bearer();
      expect(
        (await app.inject({ method: "DELETE", url: `/me/passkeys/${PK_ID}`, headers: me.headers }))
          .statusCode,
      ).toBe(204);
    });

    it("404 not_found for an unknown id; the (status, code) map otherwise; nothing audited or mailed on failure", async () => {
      for (const [err, status, code] of [
        [new GoTrueError(404, "validation_failed"), 404, "not_found"],
        [new GoTrueError(403, "insufficient_aal"), 401, "passkey_failed"],
        [new GoTrueError(404, "passkey_disabled"), 404, "passkey_disabled"],
        [new GoTrueError(503, "ECONNREFUSED"), 503, "internal"],
      ] as const) {
        const { app, db, mailer } = await make({
          gotrue: stubGoTrue({
            passkeyDelete: async () => {
              throw err;
            },
          }),
        });
        const me = await bearer();
        const res = await app.inject({
          method: "DELETE",
          url: `/me/passkeys/${PK_ID}`,
          headers: me.headers,
        });
        expect(res.statusCode, err.code).toBe(status);
        expect(errorOf(res).error).toBe(code);
        expect(db.audits).toHaveLength(0);
        expect(mailer.sent).toHaveLength(0);
        await app.close();
      }
    });

    it("the caller's own token goes to GoTrue: one user cannot address another's passkeys (no user id in the route)", async () => {
      const { app, gotrue } = await make({ gotrue: managementStub() });
      const other = await bearer({ sub: randomUUID(), email: "other@example.com" });
      const res = await app.inject({
        method: "DELETE",
        url: `/me/passkeys/${PK_ID}`,
        headers: other.headers,
      });
      expect(res.statusCode).toBe(204);
      // GoTrue scopes the id to the token's user; the API never names a user
      expect(gotrue.calls.passkeyDelete).toEqual([[other.token, PK_ID]]);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("GET /me/deletion-preview passkeys count (0.1 decision f)", () => {
  it("equals the stubbed list length", async () => {
    const { app, gotrue } = await make({
      gotrue: managementStub([goTruePasskeyBody(), goTruePasskeyBody()]),
    });
    const me = await bearer();
    const res = await app.inject({
      method: "GET",
      url: "/me/deletion-preview",
      headers: me.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = deletionPreviewResponseSchema.parse(res.json());
    expect(body.passkeys).toBe(2);
    expect(gotrue.calls.passkeyList).toEqual([[me.token]]);
  });

  it("is 0 when GoTrue is down (best effort) and 0 without a call when passkeys are off", async () => {
    const down = await make({
      gotrue: stubGoTrue({
        passkeyList: async () => {
          throw new GoTrueError(503, "ECONNREFUSED");
        },
      }),
    });
    const me = await bearer();
    const r1 = await down.app.inject({
      method: "GET",
      url: "/me/deletion-preview",
      headers: me.headers,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().passkeys).toBe(0);
    await down.app.close();
    const off = await make({ gotrue: managementStub([goTruePasskeyBody()]), passkeysOn: false });
    const r2 = await off.app.inject({
      method: "GET",
      url: "/me/deletion-preview",
      headers: me.headers,
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().passkeys).toBe(0);
    expect(off.gotrue.calls.passkeyList).toHaveLength(0);
  });
});
