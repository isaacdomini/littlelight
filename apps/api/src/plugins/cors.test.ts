import { PassThrough } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerErrorHandling } from "../lib/errors";
import { openEventStream } from "../lib/sse";
import {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  CORS_MAX_AGE_SEC,
  registerNativeCors,
} from "./cors";

// Native CORS (docs/plans/step-9.md 2.3, 2.15): allow-list, no credentials, preflight answered
// before anything else, native header required on actual requests from an allowed origin.

const ORIGINS = ["capacitor://localhost", "https://localhost"];

async function build(allowed: readonly string[] = ORIGINS) {
  const app = Fastify({ logger: false });
  registerErrorHandling(app);
  registerNativeCors(app, allowed);
  app.get("/ping", async () => ({ ok: true }));
  app.post("/ping", async () => ({ ok: true }));
  app.get("/boom", async () => {
    throw new Error("internal detail");
  });
  app.get("/stream", async (_req, reply) => {
    reply.header("content-type", "text/event-stream");
    const stream = openEventStream(reply, { keepaliveMs: 60_000 });
    stream.send("hello", { a: 1 });
    stream.close();
    return reply;
  });
  app.get("/piped", async (_req, reply) => {
    const body = new PassThrough();
    body.end("x");
    return reply.send(body);
  });
  await app.ready();
  return app;
}

const NATIVE = { "x-tinyglow-client": "native" };

describe("native CORS plugin", () => {
  it.each(ORIGINS)(
    "answers a preflight from %s with 204 and the allow headers, without credentials",
    async (origin) => {
      const app = await build();
      const res = await app.inject({
        method: "OPTIONS",
        url: "/me/push-devices",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type,x-tinyglow-client",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-methods"]).toBe(CORS_ALLOW_METHODS);
      expect(res.headers["access-control-allow-headers"]).toBe(CORS_ALLOW_HEADERS);
      expect(CORS_ALLOW_HEADERS).toContain("x-tinyglow-client");
      expect(CORS_ALLOW_HEADERS).toContain("authorization");
      expect(res.headers["access-control-max-age"]).toBe(String(CORS_MAX_AGE_SEC));
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(String(res.headers.vary)).toMatch(/Origin/i);
      expect(res.body).toBe("");
      await app.close();
    },
  );

  it("a preflight does not need the native header and never reaches a route or auth", async () => {
    const app = await build();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/ping",
      headers: { origin: ORIGINS[0] as string, "access-control-request-method": "GET" },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("an actual request from an allowed origin gets the allow-origin header (no credentials) and passes", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "capacitor://localhost", ...NATIVE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("capacitor://localhost");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["access-control-expose-headers"]).toBe("Retry-After");
    expect(String(res.headers.vary)).toMatch(/Origin/i);
    await app.close();
  });

  it("matching is case-insensitive on the origin and echoes it lowercase", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "HTTPS://LocalHost", ...NATIVE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://localhost");
    await app.close();
  });

  it("an allowed origin without the native header is 403 csrf_rejected, with CORS headers so the app can read it", async () => {
    const app = await build();
    for (const method of ["GET", "POST"] as const) {
      const res = await app.inject({
        method,
        url: "/ping",
        headers: { origin: "https://localhost" },
      });
      expect(res.statusCode, method).toBe(403);
      expect(res.json()).toMatchObject({ error: "csrf_rejected" });
      expect(res.headers["access-control-allow-origin"]).toBe("https://localhost");
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    }
    await app.close();
  });

  it("a web client header does not satisfy the native requirement", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "https://localhost", "x-tinyglow-client": "web" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it.each([
    "https://evil.example",
    "http://localhost",
    "capacitor://localhost.evil.example",
    "https://localhost:8443",
    "null",
    "",
  ])(
    "leaves a request from an unknown origin (%j) untouched: no CORS headers, normal handling",
    async (origin) => {
      const app = await build();
      const res = await app.inject({ method: "GET", url: "/ping", headers: { origin } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-expose-headers"]).toBeUndefined();
      await app.close();
    },
  );

  it("an OPTIONS preflight from an unknown origin gets no CORS answer (404/405 from the framework, no allow-origin)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/ping",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).not.toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("requests without an Origin header (the web SPA, curl, the worker) are unaffected", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("error responses from an allowed origin carry the CORS headers", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/boom",
      headers: { origin: "capacitor://localhost", ...NATIVE },
    });
    expect(res.statusCode).toBe(500);
    expect(res.headers["access-control-allow-origin"]).toBe("capacitor://localhost");
    await app.close();
  });

  it("the SSE route carries the header on its streamed response", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/stream",
      headers: { origin: "https://localhost", ...NATIVE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["access-control-allow-origin"]).toBe("https://localhost");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.body).toContain("event: hello");
    await app.close();
  });

  it("a piped (stream) body also carries the header", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/piped",
      headers: { origin: "https://localhost", ...NATIVE },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://localhost");
    await app.close();
  });

  it("an empty allow-list never emits CORS headers", async () => {
    const app = await build([]);
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "https://localhost", ...NATIVE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("never reflects a wildcard", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "https://localhost", ...NATIVE },
    });
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
    await app.close();
  });
});
