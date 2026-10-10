import cookie from "@fastify/cookie";
import { VIEWER_COOKIE } from "@tinyglow/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { testConfig } from "../testing/support";
import { mintViewerJwt } from "./crypto";
import {
  clearViewerCookie,
  extractViewerToken,
  isViewerUrl,
  registerViewerAuth,
  requireViewer,
  setViewerCookie,
  viewerCookieOptions,
} from "./viewer-auth";

// Viewer authentication hook for `/share/*` (docs/plans/step-8.md 2.2, 2.6): cookie vs native
// bearer selection, CSRF rule for the cookie transport, URL scoping, cookie attributes.

const LINK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WEB = { "x-tinyglow-client": "web" };
const NATIVE = { "x-tinyglow-client": "native" };

const config = testConfig();
let app: FastifyInstance | undefined;

async function build(c = config) {
  const a = Fastify();
  await a.register(cookie);
  registerViewerAuth(a, c);
  // Echo what the hook decided on any method and path.
  a.route({
    method: ["GET", "POST", "DELETE", "PATCH", "PUT"],
    url: "/share/probe",
    handler: async (request) => ({
      viewer: request.viewer
        ? { transport: request.viewer.transport, jti: request.viewer.claims.jti }
        : null,
      error: request.viewerError?.code ?? null,
    }),
  });
  a.route({
    method: ["GET", "POST"],
    url: "/share/guarded",
    preHandler: requireViewer,
    handler: async () => ({ ok: true }),
  });
  a.get("/babies/probe", async (request) => ({
    viewer: request.viewer,
    error: request.viewerError,
  }));
  a.get("/share/set-cookie", async (_request, reply) => {
    setViewerCookie(reply, c, "tok", Math.floor(Date.now() / 1000) + 600);
    return {};
  });
  a.get("/share/clear-cookie", async (_request, reply) => {
    clearViewerCookie(reply, c);
    return {};
  });
  a.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; status?: number; code?: string };
    return reply.code(e.status ?? e.statusCode ?? 500).send({ error: e.code ?? "internal" });
  });
  await a.ready();
  app = a;
  return a;
}

const jwt = async (c = config, ttlSec = 600) =>
  (
    await mintViewerJwt(c, {
      shareLinkId: LINK,
      sessionId: SESSION,
      linkExpiresAt: new Date(Date.now() + ttlSec * 1000),
    })
  ).token;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("isViewerUrl", () => {
  it("matches only /share/ paths (query strings ignored)", () => {
    expect(isViewerUrl("/share/album")).toBe(true);
    expect(isViewerUrl("/share/photos?cursor=abc")).toBe(true);
    expect(isViewerUrl("/share/session")).toBe(true);
    for (const no of [
      "/share",
      "/sharex/album",
      "/babies/1/share/album",
      "/babies/share/",
      "/api/share/album",
      "/auth/session",
      "/",
      "/?x=/share/album",
      "/photos?next=/share/album",
    ]) {
      expect(isViewerUrl(no), no).toBe(false);
    }
  });
});

describe("extractViewerToken", () => {
  const req = (headers: Record<string, string>, cookies: Record<string, string> = {}) =>
    ({ headers, cookies, ip: "127.0.0.1" }) as never;

  it("reads the ll_viewer cookie on the web", () => {
    expect(extractViewerToken(req({}, { [VIEWER_COOKIE]: "c" }))).toEqual({
      token: "c",
      transport: "cookie",
    });
    expect(extractViewerToken(req(WEB, { [VIEWER_COOKIE]: "c" }))?.transport).toBe("cookie");
  });

  it("reads the bearer token only for native clients", () => {
    expect(extractViewerToken(req({ ...NATIVE, authorization: "Bearer abc" }))).toEqual({
      token: "abc",
      transport: "bearer",
    });
    // a web/unlabelled request never trusts an Authorization header
    expect(extractViewerToken(req({ authorization: "Bearer abc" }))).toBeNull();
    expect(extractViewerToken(req({ ...WEB, authorization: "Bearer abc" }))).toBeNull();
  });

  it("native: the bearer wins over the cookie; a malformed bearer falls back to the cookie", () => {
    expect(
      extractViewerToken(req({ ...NATIVE, authorization: "Bearer abc" }, { [VIEWER_COOKIE]: "c" })),
    ).toMatchObject({ token: "abc", transport: "bearer" });
    expect(
      extractViewerToken(req({ ...NATIVE, authorization: "Basic abc" }, { [VIEWER_COOKIE]: "c" })),
    ).toMatchObject({ token: "c", transport: "cookie" });
  });

  it("never reads the parent cookies", () => {
    expect(extractViewerToken(req({}, { ll_access: "parent", ll_refresh: "r" }))).toBeNull();
  });
});

describe("the onRequest hook", () => {
  it("accepts a valid cookie on GET with no client header", async () => {
    const a = await build();
    const res = await a.inject({
      method: "GET",
      url: "/share/probe",
      headers: { cookie: `${VIEWER_COOKIE}=${await jwt()}` },
    });
    expect(res.json()).toEqual({ viewer: { transport: "cookie", jti: SESSION }, error: null });
  });

  it("a non-GET over the cookie without X-Tinyglow-Client: web is 403 csrf_rejected", async () => {
    const a = await build();
    const cookieHeader = `${VIEWER_COOKIE}=${await jwt()}`;
    for (const method of ["POST", "DELETE", "PATCH", "PUT"] as const) {
      const bare = await a.inject({
        method,
        url: "/share/probe",
        headers: { cookie: cookieHeader },
      });
      expect(bare.json(), method).toEqual({ viewer: null, error: "csrf_rejected" });
      const native = await a.inject({
        method,
        url: "/share/probe",
        headers: { cookie: cookieHeader, ...NATIVE },
      });
      expect(native.json().error, `${method} native`).toBe("csrf_rejected");
      const ok = await a.inject({
        method,
        url: "/share/probe",
        headers: { cookie: cookieHeader, ...WEB },
      });
      expect(ok.json(), `${method} web`).toEqual({
        viewer: { transport: "cookie", jti: SESSION },
        error: null,
      });
    }
  });

  it("requireViewer answers a cookie POST without the client header with 403 csrf_rejected", async () => {
    const a = await build();
    const cookieHeader = `${VIEWER_COOKIE}=${await jwt()}`;
    const bare = await a.inject({
      method: "POST",
      url: "/share/guarded",
      headers: { cookie: cookieHeader },
    });
    expect(bare.statusCode).toBe(403);
    expect(bare.json()).toEqual({ error: "csrf_rejected" });
    const web = await a.inject({
      method: "POST",
      url: "/share/guarded",
      headers: { cookie: cookieHeader, ...WEB },
    });
    expect(web.statusCode).toBe(200);
  });

  it("a native bearer needs no CSRF header and is the bearer transport", async () => {
    const a = await build();
    const res = await a.inject({
      method: "POST",
      url: "/share/probe",
      headers: { ...NATIVE, authorization: `Bearer ${await jwt()}` },
    });
    expect(res.json()).toEqual({ viewer: { transport: "bearer", jti: SESSION }, error: null });
  });

  it("a bearer viewer JWT without the native client header is ignored (no credential)", async () => {
    const a = await build();
    const res = await a.inject({
      method: "GET",
      url: "/share/probe",
      headers: { authorization: `Bearer ${await jwt()}` },
    });
    expect(res.json()).toEqual({ viewer: null, error: null });
  });

  it("a missing credential: viewer null and no error; requireViewer answers 401 unauthorized", async () => {
    const a = await build();
    expect((await a.inject({ method: "GET", url: "/share/probe" })).json()).toEqual({
      viewer: null,
      error: null,
    });
    const guarded = await a.inject({ method: "GET", url: "/share/guarded" });
    expect(guarded.statusCode).toBe(401);
    expect(guarded.json()).toEqual({ error: "unauthorized" });
  });

  it("garbage, expired and foreign-key tokens are viewerError unauthorized -> 401", async () => {
    const a = await build();
    const foreign = await jwt(
      testConfig({ JWT_SECRET: "another-secret-at-least-32-characters-long" }),
    );
    const expired = await (async () =>
      (
        await mintViewerJwt(config, {
          shareLinkId: LINK,
          sessionId: SESSION,
          linkExpiresAt: new Date(Date.now() - 3600_000),
          now: new Date(Date.now() - 7200_000),
        })
      ).token)();
    for (const token of ["garbage", foreign, expired]) {
      const probe = await a.inject({
        method: "GET",
        url: "/share/probe",
        headers: { cookie: `${VIEWER_COOKIE}=${token}` },
      });
      expect(probe.json()).toEqual({ viewer: null, error: "unauthorized" });
      const guarded = await a.inject({
        method: "GET",
        url: "/share/guarded",
        headers: { cookie: `${VIEWER_COOKIE}=${token}` },
      });
      expect(guarded.statusCode).toBe(401);
    }
  });

  it("a parent ll_access cookie or a user bearer token is not a viewer credential", async () => {
    const a = await build();
    const res = await a.inject({
      method: "GET",
      url: "/share/guarded",
      headers: { cookie: "ll_access=whatever", ...NATIVE, authorization: "Bearer whatever" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("does nothing off /share/: no credential parsed, no headers added", async () => {
    const a = await build();
    const res = await a.inject({
      method: "GET",
      url: "/babies/probe",
      headers: { cookie: `${VIEWER_COOKIE}=${await jwt()}` },
    });
    expect(res.json()).toEqual({ viewer: null, error: null });
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(res.headers["x-robots-tag"]).toBeUndefined();
  });

  it("every /share/ response is no-store and noindex", async () => {
    const a = await build();
    const res = await a.inject({ method: "GET", url: "/share/probe" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toMatch(/noindex/);
  });
});

describe("cookie attributes", () => {
  it("ll_viewer is HttpOnly, SameSite=Lax, Path=/api/share and Secure only in production", () => {
    for (const [env, secure] of [
      ["production", true],
      ["development", false],
      ["test", false],
    ] as const) {
      expect(viewerCookieOptions({ NODE_ENV: env })).toEqual({
        httpOnly: true,
        sameSite: "lax",
        path: "/api/share",
        secure,
      });
    }
  });

  it("setViewerCookie sets Max-Age from exp and the Secure flag from NODE_ENV", async () => {
    for (const nodeEnv of ["production", "test"] as const) {
      const a = await build(testConfig({ NODE_ENV: nodeEnv }));
      const res = await a.inject({ method: "GET", url: "/share/set-cookie" });
      const header = String(res.headers["set-cookie"]);
      expect(header).toMatch(new RegExp(`^${VIEWER_COOKIE}=tok;`));
      expect(header).toMatch(/Path=\/api\/share/);
      expect(header).toMatch(/HttpOnly/);
      expect(header).toMatch(/SameSite=Lax/);
      expect(header).toMatch(/Max-Age=(59\d|600)/);
      expect(/;\s*Secure/i.test(header), nodeEnv).toBe(nodeEnv === "production");
      await a.close();
      app = undefined;
    }
  });

  it("clearViewerCookie expires it on the same path", async () => {
    const a = await build();
    const header = String(
      (await a.inject({ method: "GET", url: "/share/clear-cookie" })).headers["set-cookie"],
    );
    expect(header).toMatch(new RegExp(`^${VIEWER_COOKIE}=;`));
    expect(header).toMatch(/Path=\/api\/share/);
    expect(header).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});
