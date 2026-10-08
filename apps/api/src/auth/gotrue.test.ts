import { describe, expect, it } from "vitest";
import { testConfig } from "../testing/support";
import { createGoTrueClient, GoTrueError } from "./gotrue";

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
