import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, registerErrorHandling } from "../lib/errors";

// Unit tests of the push routes with the auth layer mocked (docs/plans/step-9.md 2.8, 2.15): the
// native-header rule, body validation, throttle, response shape and the fixed SQL. The real
// database behaviour (RLS, session binding, consent) is in push.integration.test.ts.

const queries: Array<{ sql: string; params: unknown[] }> = [];
let consent: "ok" | "missing" = "ok";
let registerResult: { id: string } | undefined;

vi.mock("../auth", async () => {
  const actual = await vi.importActual<typeof import("../auth")>("../auth");
  return {
    ...actual,
    requireAuth: async (request: { headers: Record<string, unknown>; auth?: unknown }) => {
      if (!request.headers.authorization) {
        throw new ApiError(401, "unauthorized", "Sign in to continue");
      }
      request.auth = { uid: "11111111-1111-4111-8111-111111111111" };
    },
    requireConsent: async () => {
      if (consent === "missing") throw new ApiError(403, "consent_required", "Accept the Terms");
    },
    withClaims: async (
      _request: unknown,
      fn: (client: unknown, ctx: unknown) => Promise<unknown>,
    ) => {
      const client = {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("register_push_device")) {
            return { rows: registerResult ? [registerResult] : [] };
          }
          if (sql.includes("FROM public.push_devices")) {
            return {
              rows: [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  platform: "ios",
                  created_at: new Date("2026-10-09T10:00:00Z"),
                },
              ],
            };
          }
          return { rows: [] };
        },
      };
      return fn(client, { uid: "11111111-1111-4111-8111-111111111111" });
    },
  };
});

import { pushRoutes } from "./push";

const TOKEN = "a".repeat(64);
const body = { platform: "ios", provider: "apns", token: TOKEN, appVersion: "1.0.0" };
const AUTH = { authorization: "Bearer x" };
const NATIVE = { ...AUTH, "x-littlelight-client": "native" };

async function build(throttle?: { hit: () => { allowed: boolean; retryAfterSec: number } }) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  pushRoutes(app, throttle ? { throttle: { ...throttle, close: () => undefined } as never } : {});
  await app.ready();
  return app;
}

beforeEach(() => {
  queries.length = 0;
  consent = "ok";
  registerResult = { id: "22222222-2222-4222-8222-222222222222" };
});

describe("POST /me/push-devices", () => {
  it("registers through register_push_device and answers 201 with id/platform/createdAt only", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      headers: NATIVE,
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      device: {
        id: "22222222-2222-4222-8222-222222222222",
        platform: "ios",
        createdAt: "2026-10-09T10:00:00.000Z",
      },
    });
    expect(res.body).not.toContain(TOKEN);
    const reg = queries.find((q) => q.sql.includes("register_push_device"));
    expect(reg?.params).toEqual(["ios", "apns", TOKEN, "1.0.0"]);
    // The read-back never selects the token.
    const read = queries.find((q) => q.sql.includes("FROM public.push_devices"));
    expect(read?.sql).not.toMatch(/token/i);
    await app.close();
  });

  it("requires X-Littlelight-Client: native: web or missing is 400 validation_failed and touches nothing", async () => {
    const app = await build();
    for (const headers of [AUTH, { ...AUTH, "x-littlelight-client": "web" }]) {
      const res = await app.inject({
        method: "POST",
        url: "/me/push-devices",
        headers,
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation_failed" });
    }
    expect(queries).toHaveLength(0);
    await app.close();
  });

  it("is 401 without credentials", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      headers: { "x-littlelight-client": "native" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(queries).toHaveLength(0);
    await app.close();
  });

  it("requires consent (403 consent_required) and registers nothing", async () => {
    consent = "missing";
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      headers: NATIVE,
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "consent_required" });
    expect(queries.some((q) => q.sql.includes("register_push_device"))).toBe(false);
    await app.close();
  });

  it.each([
    ["ios with fcm", { ...body, provider: "fcm" }],
    ["android with apns", { ...body, platform: "android" }],
    ["an unknown platform", { ...body, platform: "web" }],
    ["a short token", { ...body, token: "short" }],
    ["a token with spaces", { ...body, token: "abcd efgh ijkl" }],
    ["an over-long token", { ...body, token: "a".repeat(4097) }],
    ["a bad app version", { ...body, appVersion: "1 0" }],
    ["an unexpected key", { ...body, userId: "11111111-1111-4111-8111-111111111111" }],
    ["no body fields", {}],
  ])("rejects %s with 400 and never echoes the token", async (_n, payload) => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      headers: NATIVE,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain("abcd efgh");
    expect(queries).toHaveLength(0);
    await app.close();
  });

  it("is throttled per user: a blocked hit is 429 with Retry-After and registers nothing", async () => {
    const app = await build({ hit: () => ({ allowed: false, retryAfterSec: 1800 }) });
    const res = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      headers: NATIVE,
      payload: body,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "rate_limited" });
    expect(res.headers["retry-after"]).toBe("1800");
    expect(queries).toHaveLength(0);
    await app.close();
  });

  it("the default throttle allows 20 registrations an hour per user, then 429", async () => {
    const app = await build();
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/me/push-devices",
        headers: NATIVE,
        payload: body,
      });
      expect(res.statusCode, `request ${i + 1}`).toBe(201);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      headers: NATIVE,
      payload: body,
    });
    expect(blocked.statusCode).toBe(429);
    await app.close();
  });

  it("answers 500 internal (no detail) if the function returns no id", async () => {
    registerResult = undefined;
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      headers: NATIVE,
      payload: body,
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(TOKEN);
    await app.close();
  });
});

describe("DELETE /me/push-devices/current", () => {
  it("calls unregister_push_devices_for_session and answers 204 with no body", async () => {
    const app = await build();
    const res = await app.inject({
      method: "DELETE",
      url: "/me/push-devices/current",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(queries.map((q) => q.sql)).toEqual([
      "SELECT public.unregister_push_devices_for_session()",
    ]);
    await app.close();
  });

  it("needs no native header and no consent (best effort during sign-out) but needs auth", async () => {
    consent = "missing";
    const app = await build();
    expect(
      (await app.inject({ method: "DELETE", url: "/me/push-devices/current", headers: AUTH }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "DELETE", url: "/me/push-devices/current" })).statusCode,
    ).toBe(401);
    await app.close();
  });
});
