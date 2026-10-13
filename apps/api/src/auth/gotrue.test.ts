import { describe, expect, it } from "vitest";
import { testConfig } from "../testing/support";
import { createGoTrueClient, GoTrueError, retryAfterSecOf } from "./gotrue";

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fn, calls };
}

const headersOf = (c: Call | undefined) => (c?.init.headers ?? {}) as Record<string, string>;

const sessionBody = {
  access_token: "AT",
  refresh_token: "RT",
  expires_in: 3600,
  user: { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co" },
};
const UP = { "x-forwarded-for": "203.0.113.5", "user-agent": "UA" };

describe("GoTrueError", () => {
  it("carries status and code only, never a body", () => {
    const err = new GoTrueError(422, "otp_expired");
    expect(err.message).toBe("gotrue request failed (422 otp_expired)");
    expect(err.isClientError).toBe(true);
    expect(new GoTrueError(503, "network").isClientError).toBe(false);
    expect(new GoTrueError(500, "http_500").isClientError).toBe(false);
  });
});

describe("createGoTrueClient", () => {
  it("sendOtp posts email + create_user and forwards client headers", async () => {
    const f = fakeFetch(() => Response.json({}));
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    await client.sendOtp("a@b.co", UP);
    const call = f.calls[0];
    expect(call?.url).toBe("http://auth:9999/otp");
    expect(JSON.parse(String(call?.init.body))).toEqual({ email: "a@b.co", create_user: true });
    const headers = headersOf(call);
    expect(headers["x-forwarded-for"]).toBe("203.0.113.5");
    expect(headers["user-agent"]).toBe("UA");
    expect(call?.init.redirect).toBe("manual");
  });

  it("verify maps a code and a token_hash, and the session body", async () => {
    const f = fakeFetch(() => Response.json(sessionBody));
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    const s = await client.verify({ kind: "code", email: "a@b.co", token: "123456" }, UP);
    expect(s).toEqual({
      accessToken: "AT",
      refreshToken: "RT",
      expiresIn: 3600,
      user: { id: sessionBody.user.id, email: "a@b.co" },
    });
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
      type: "email",
      email: "a@b.co",
      token: "123456",
    });
    await client.verify({ kind: "token_hash", tokenHash: "h" }, UP);
    expect(JSON.parse(String(f.calls[1]?.init.body))).toEqual({ type: "email", token_hash: "h" });
  });

  it("refresh, logout, pkce and id-token hit the documented endpoints", async () => {
    const f = fakeFetch((c) =>
      c.url.includes("/logout") ? new Response(null, { status: 204 }) : Response.json(sessionBody),
    );
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    await client.refresh("rt", UP);
    await client.logout("at", "global", UP);
    await client.exchangePkce({ authCode: "c", codeVerifier: "v".repeat(43) }, UP);
    await client.signInWithIdToken({ provider: "google", idToken: "idt", nonce: "n" }, UP);
    expect(f.calls.map((c) => c.url)).toEqual([
      "http://auth:9999/token?grant_type=refresh_token",
      "http://auth:9999/logout?scope=global",
      "http://auth:9999/token?grant_type=pkce",
      "http://auth:9999/token?grant_type=id_token",
    ]);
    expect(headersOf(f.calls[1]).authorization).toBe("Bearer at");
    expect(JSON.parse(String(f.calls[3]?.init.body))).toEqual({
      provider: "google",
      id_token: "idt",
      nonce: "n",
    });
  });

  it("adminDeleteUser sends a freshly minted service_role token", async () => {
    const f = fakeFetch(() => new Response(null, { status: 200 }));
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    await client.adminDeleteUser("11111111-1111-4111-8111-111111111111");
    const call = f.calls[0];
    expect(call?.url).toBe("http://auth:9999/admin/users/11111111-1111-4111-8111-111111111111");
    expect(call?.init.method).toBe("DELETE");
    const auth = headersOf(call).authorization ?? "";
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const payload = JSON.parse(Buffer.from(auth.split(".")[1] ?? "", "base64url").toString());
    expect(payload.role).toBe("service_role");
  });

  describe("adminGenerateMagicLink (store-review sign-in)", () => {
    const UID = "22222222-2222-4222-8222-222222222222";
    const body = {
      id: UID,
      email: "r@example.com",
      hashed_token: "hashed-token-abc",
      email_otp: "654321",
      action_link: "http://auth/verify?token=SECRET",
      verification_type: "magiclink",
    };

    it("posts magiclink with a freshly minted service_role token and keeps only the id and hashed token", async () => {
      const f = fakeFetch(() => Response.json(body));
      const client = createGoTrueClient(testConfig(), { fetch: f.fn });
      const link = await client.adminGenerateMagicLink("r@example.com");
      expect(link).toEqual({ userId: UID, hashedToken: "hashed-token-abc" });
      expect(JSON.stringify(link)).not.toContain("654321");
      expect(JSON.stringify(link)).not.toContain("SECRET");
      const call = f.calls[0];
      expect(call?.url).toBe("http://auth:9999/admin/generate_link");
      expect(call?.init.method).toBe("POST");
      expect(JSON.parse(String(call?.init.body))).toEqual({
        type: "magiclink",
        email: "r@example.com",
      });
      const auth = headersOf(call).authorization ?? "";
      expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      const payload = JSON.parse(Buffer.from(auth.split(".")[1] ?? "", "base64url").toString());
      expect(payload.role).toBe("service_role");
    });

    it("lowercases the returned user id", async () => {
      const f = fakeFetch(() => Response.json({ ...body, id: UID.toUpperCase() }));
      const client = createGoTrueClient(testConfig(), { fetch: f.fn });
      expect((await client.adminGenerateMagicLink("r@example.com")).userId).toBe(UID);
    });

    it.each([
      ["a non-object body", "nope"],
      ["no id", { hashed_token: "h" }],
      ["a non-uuid id", { id: "not-a-uuid", hashed_token: "h" }],
      ["no hashed token", { id: UID }],
      ["an empty hashed token", { id: UID, hashed_token: "" }],
      ["an over-long hashed token", { id: UID, hashed_token: "h".repeat(513) }],
      ["a numeric hashed token", { id: UID, hashed_token: 12345 }],
    ])("rejects %s with a safe 502 bad_generate_link_body", async (_n, payload) => {
      const f = fakeFetch(() => Response.json(payload));
      const client = createGoTrueClient(testConfig(), { fetch: f.fn });
      await expect(client.adminGenerateMagicLink("r@example.com")).rejects.toMatchObject({
        status: 502,
        code: "bad_generate_link_body",
      });
    });

    it("turns a GoTrue error into a GoTrueError without the body", async () => {
      const f = fakeFetch(() =>
        Response.json({ error_code: "user_banned", msg: "r@example.com banned" }, { status: 403 }),
      );
      const client = createGoTrueClient(testConfig(), { fetch: f.fn });
      const err = await client.adminGenerateMagicLink("r@example.com").catch((e) => e);
      expect(err).toBeInstanceOf(GoTrueError);
      expect(err.message).not.toContain("r@example.com");
    });
  });

  it("turns error responses into GoTrueError with only a safe identifier", async () => {
    const cases: Array<[Response, number, string]> = [
      [
        Response.json(
          { code: 422, error_code: "otp_expired", msg: "Token for a@b.co expired" },
          { status: 422 },
        ),
        422,
        "otp_expired",
      ],
      [
        Response.json(
          { error: "invalid_grant", error_description: "Invalid Refresh Token for a@b.co" },
          { status: 400 },
        ),
        400,
        "invalid_grant",
      ],
      [Response.json({ error_code: "has spaces and a@b.co" }, { status: 400 }), 400, "http_400"],
      [new Response("<html>bad gateway a@b.co</html>", { status: 502 }), 502, "http_502"],
    ];
    for (const [res, status, code] of cases) {
      const client = createGoTrueClient(testConfig(), { fetch: fakeFetch(() => res).fn });
      try {
        await client.verify({ kind: "code", email: "a@b.co", token: "000000" }, UP);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(GoTrueError);
        expect(err).toMatchObject({ status, code });
        expect((err as Error).message).not.toContain("a@b.co");
        expect(JSON.stringify(err)).not.toContain("a@b.co");
      }
    }
  });

  it("maps transport failures to 503 with an errno-like code, and bad bodies to 502", async () => {
    const down = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(() => {
        throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.2:9999 a@b.co"), {
          code: "ECONNREFUSED",
        });
      }).fn,
    });
    await expect(down.sendOtp("a@b.co", UP)).rejects.toMatchObject({
      status: 503,
      code: "ECONNREFUSED",
    });
    const weird = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(() => {
        throw new Error("something with a@b.co");
      }).fn,
    });
    const err = await weird.sendOtp("a@b.co", UP).catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: "network" });
    expect(err.message).not.toContain("a@b.co");

    const bad = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(() => Response.json({ access_token: "x" })).fn,
    });
    await expect(bad.refresh("r", UP)).rejects.toMatchObject({
      status: 502,
      code: "bad_session_body",
    });
  });

  it("times out as a 503", async () => {
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("x"), { name: "AbortError" })),
        );
      })) as typeof fetch;
    const client = createGoTrueClient(testConfig(), { fetch: hang, timeoutMs: 20 });
    await expect(client.sendOtp("a@b.co", UP)).rejects.toMatchObject({
      status: 503,
      code: "timeout",
    });
  });

  it("treats an empty email as null", async () => {
    const f = fakeFetch(() => Response.json({ ...sessionBody, user: { id: "u", email: "" } }));
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    expect((await client.refresh("r", UP)).user.email).toBeNull();
  });
});

// ---- step 13: passkeys (docs/plans/step-13.md 0.1, 2.4) ----------------------------------------

describe("createGoTrueClient passkeys", () => {
  const PK = "3f2c1b0a-1234-4abc-8def-0123456789ab";
  const CH = "7e1d2c3b-4a5f-4e6d-8c7b-0a1b2c3d4e5f";
  const optionsBody = {
    challenge_id: CH,
    options: { challenge: "dGVzdA", rpId: "localhost", userVerification: "preferred" },
    expires_at: 1_760_000_000,
  };
  const credential = {
    id: "AQIDBA",
    rawId: "AQIDBA",
    type: "public-key" as const,
    response: { clientDataJSON: "eyJ0IjoxfQ", authenticatorData: "AAAA", signature: "BBBB" },
    clientExtensionResults: {},
  };

  it("passkeyAuthOptions posts to /passkeys/authentication/options with the client headers (decision d) and keeps Unix seconds", async () => {
    const f = fakeFetch(() => Response.json(optionsBody));
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    const o = await client.passkeyAuthOptions(UP);
    expect(o).toEqual(optionsBody);
    expect(typeof o.expires_at).toBe("number");
    const call = f.calls[0];
    expect(call?.url).toBe("http://auth:9999/passkeys/authentication/options");
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(String(call?.init.body))).toEqual({});
    const h = headersOf(call);
    expect(h["x-forwarded-for"]).toBe("203.0.113.5");
    expect(h["user-agent"]).toBe("UA");
    expect(h.authorization).toBeUndefined();
  });

  it("passkeyAuthVerify posts { challenge_id, credential } and maps the session", async () => {
    const f = fakeFetch(() => Response.json(sessionBody));
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    const s = await client.passkeyAuthVerify({ challengeId: CH, credential }, UP);
    expect(s.accessToken).toBe("AT");
    expect(s.user).toEqual({ id: sessionBody.user.id, email: "a@b.co" });
    const call = f.calls[0];
    expect(call?.url).toBe("http://auth:9999/passkeys/authentication/verify");
    expect(JSON.parse(String(call?.init.body))).toEqual({ challenge_id: CH, credential });
    expect(headersOf(call).authorization).toBeUndefined();
    expect(headersOf(call)["x-forwarded-for"]).toBe("203.0.113.5");
  });

  it("passkeyRegOptions / passkeyRegVerify carry the user's bearer token; verify accepts GoTrue's 200", async () => {
    const f = fakeFetch((c) =>
      c.url.endsWith("/registration/options")
        ? Response.json(optionsBody)
        : Response.json({ id: PK, friendly_name: "x", created_at: "2026-10-11T12:34:56.123456Z" }),
    );
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    const o = await client.passkeyRegOptions("user-at", UP);
    expect(o.challenge_id).toBe(CH);
    const created = await client.passkeyRegVerify("user-at", { challengeId: CH, credential }, UP);
    expect(created).toEqual({
      id: PK,
      friendly_name: "x",
      created_at: "2026-10-11T12:34:56.123456Z",
    });
    expect(f.calls.map((c) => c.url)).toEqual([
      "http://auth:9999/passkeys/registration/options",
      "http://auth:9999/passkeys/registration/verify",
    ]);
    for (const c of f.calls) {
      expect(c.init.method).toBe("POST");
      expect(headersOf(c).authorization).toBe("Bearer user-at");
      expect(headersOf(c)["x-forwarded-for"]).toBe("203.0.113.5");
    }
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({});
    expect(JSON.parse(String(f.calls[1]?.init.body))).toEqual({ challenge_id: CH, credential });
  });

  it("passkeyList GETs /passkeys/ (trailing slash) with the bearer and parses the bare array", async () => {
    const f = fakeFetch(() =>
      Response.json([
        { id: PK, created_at: "2026-10-11T12:34:56Z" },
        {
          id: CH,
          friendly_name: "Laptop",
          created_at: "2026-10-10T00:00:00Z",
          last_used_at: "2026-10-11T00:00:00Z",
        },
      ]),
    );
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    const list = await client.passkeyList("user-at");
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ id: PK, created_at: "2026-10-11T12:34:56Z" });
    expect(list[1]?.friendly_name).toBe("Laptop");
    const call = f.calls[0];
    expect(call?.url).toBe("http://auth:9999/passkeys/");
    expect(call?.init.method).toBe("GET");
    expect(call?.init.body).toBeUndefined();
    expect(headersOf(call).authorization).toBe("Bearer user-at");
    expect(headersOf(call)["content-type"]).toBeUndefined();
  });

  it("passkeyList: a null body is an empty list; an object body is a 502 bad_passkey_body", async () => {
    const nul = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(
        () =>
          new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
      ).fn,
    });
    expect(await nul.passkeyList("t")).toEqual([]);
    const empty = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(() => new Response("", { status: 200 })).fn,
    });
    expect(await empty.passkeyList("t")).toEqual([]);
    const obj = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(() => Response.json({ passkeys: [] })).fn,
    });
    await expect(obj.passkeyList("t")).rejects.toMatchObject({
      status: 502,
      code: "bad_passkey_body",
    });
    const badItem = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(() => Response.json([{ id: "not-a-uuid", created_at: "x" }])).fn,
    });
    await expect(badItem.passkeyList("t")).rejects.toMatchObject({ status: 502 });
  });

  it("passkeyRename PATCHes { friendly_name } to /passkeys/{id}; passkeyDelete DELETEs and accepts 204", async () => {
    const f = fakeFetch((c) =>
      c.init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: PK, friendly_name: "New", created_at: "2026-10-11T12:34:56Z" }),
    );
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    const renamed = await client.passkeyRename("user-at", PK, "New");
    expect(renamed.friendly_name).toBe("New");
    await client.passkeyDelete("user-at", PK);
    expect(f.calls.map((c) => [c.init.method, c.url])).toEqual([
      ["PATCH", `http://auth:9999/passkeys/${PK}`],
      ["DELETE", `http://auth:9999/passkeys/${PK}`],
    ]);
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ friendly_name: "New" });
    for (const c of f.calls) expect(headersOf(c).authorization).toBe("Bearer user-at");
    expect(f.calls[1]?.init.body).toBeUndefined();
  });

  it("URL-encodes the passkey id (no path injection)", async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createGoTrueClient(testConfig(), { fetch: f.fn });
    await client.passkeyDelete("t", "../admin/users?x=1");
    expect(f.calls[0]?.url).toBe("http://auth:9999/passkeys/..%2Fadmin%2Fusers%3Fx%3D1");
  });

  it("options bodies that are not GoTrue's shape (ISO expires_at, missing challenge_id) are 502", async () => {
    for (const body of [
      { ...optionsBody, expires_at: "2026-10-11T12:00:00Z" },
      { options: {}, expires_at: 1 },
      { challenge_id: "nope", options: {}, expires_at: 1 },
      [],
      "text",
    ]) {
      const client = createGoTrueClient(testConfig(), {
        fetch: fakeFetch(() => Response.json(body)).fn,
      });
      await expect(client.passkeyAuthOptions(UP)).rejects.toMatchObject({
        status: 502,
        code: "bad_passkey_body",
      });
    }
  });

  it("reduces GoTrue error bodies to (status, error_code) for every passkey route, never the message", async () => {
    const cases: [number, string][] = [
      [404, "passkey_disabled"],
      [400, "webauthn_verification_failed"],
      [400, "webauthn_challenge_expired"],
      [422, "too_many_passkeys"],
      [422, "webauthn_credential_exists"],
      [404, "validation_failed"],
      [403, "insufficient_aal"],
    ];
    for (const [status, code] of cases) {
      const f = fakeFetch(() =>
        Response.json(
          { code: status, error_code: code, msg: `Secret detail for a@b.co ${code}` },
          { status },
        ),
      );
      const client = createGoTrueClient(testConfig(), { fetch: f.fn });
      const err = await client
        .passkeyAuthVerify({ challengeId: CH, credential }, UP)
        .catch((e) => e);
      expect(err).toBeInstanceOf(GoTrueError);
      expect(err).toMatchObject({ status, code });
      expect(err.message).not.toContain("a@b.co");
      expect(err.message).not.toContain("Secret");
    }
    // the 500 "Failed to initialize WebAuthn" misconfiguration (0.1, decision e) is a 500 http_500
    const misconfigured = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(() =>
        Response.json({ code: 500, msg: "Failed to initialize WebAuthn" }, { status: 500 }),
      ).fn,
    });
    await expect(misconfigured.passkeyAuthOptions(UP)).rejects.toMatchObject({
      status: 500,
      code: "http_500",
    });
  });
});

describe("retryAfterSecOf (GoTrue 429 Retry-After)", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  it("delta seconds, HTTP-date in the future, and the 1 h clamp", () => {
    expect(retryAfterSecOf("120", now)).toBe(120);
    expect(retryAfterSecOf(" 45 ", now)).toBe(45);
    expect(retryAfterSecOf(new Date(now + 90_000).toUTCString(), now)).toBe(90);
    // clamp at 1 h; the delta form accepts 1..7 digits (an 8-digit value is treated as garbage)
    expect(retryAfterSecOf("9999999", now)).toBe(3600);
    expect(retryAfterSecOf("99999999", now)).toBeUndefined();
  });

  it("past dates, garbage and an absent header are undefined", () => {
    expect(retryAfterSecOf(new Date(now - 60_000).toUTCString(), now)).toBeUndefined();
    expect(retryAfterSecOf("soon", now)).toBeUndefined();
    expect(retryAfterSecOf("", now)).toBeUndefined();
    expect(retryAfterSecOf(null, now)).toBeUndefined();
    expect(retryAfterSecOf("-5", now)).toBeUndefined();
  });

  it("the client attaches retryAfterSec to a 429 GoTrueError (and only to a 429)", async () => {
    const limited = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(() =>
        Response.json(
          { code: 429, error_code: "over_request_rate_limit", msg: "x" },
          { status: 429, headers: { "retry-after": "120" } },
        ),
      ).fn,
    });
    const err = await limited.passkeyAuthOptions(UP).catch((e) => e);
    expect(err).toBeInstanceOf(GoTrueError);
    expect(err).toMatchObject({ status: 429, code: "over_request_rate_limit", retryAfterSec: 120 });
    const plain = createGoTrueClient(testConfig(), {
      fetch: fakeFetch(() =>
        Response.json(
          { error_code: "user_banned" },
          { status: 403, headers: { "retry-after": "120" } },
        ),
      ).fn,
    });
    const e2 = await plain.passkeyAuthOptions(UP).catch((e) => e);
    expect(e2.retryAfterSec).toBeUndefined();
  });
});
