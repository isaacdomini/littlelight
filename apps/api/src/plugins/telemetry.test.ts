import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import * as Sentry from "@sentry/node";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturableError,
  captureRequestError,
  initTelemetry,
  registerTelemetry,
  requestErrorTags,
  sentryOptions,
  telemetryEnabled,
} from "./telemetry";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

/** A local ingest: collects every envelope body POSTed to it. */
async function sink() {
  const bodies: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let buf = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") buf = gunzipSync(buf);
      bodies.push(buf.toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    bodies,
    dsn: `http://publickey@127.0.0.1:${port}/1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

afterEach(async () => {
  await Sentry.close(500);
  vi.restoreAllMocks();
});

const eventsOf = (bodies: string[]) =>
  bodies
    .flatMap((b) => b.split("\n"))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("initTelemetry without a DSN", () => {
  it("is off: nothing initialised, no network, no log", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(
      initTelemetry({ SENTRY_DSN: undefined, SENTRY_ENVIRONMENT: "x", NODE_ENV: "test" }),
    ).toBe(false);
    expect(initTelemetry({ NODE_ENV: "test" })).toBe(false);
    expect(telemetryEnabled()).toBe(false);
    expect(Sentry.isInitialized()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("capture helpers are no-ops", async () => {
    const routeOptions = { url: "/x" };
    expect(() =>
      captureRequestError({ method: "GET", routeOptions } as never, new Error("boom"), 500),
    ).not.toThrow();
    const app = Fastify();
    registerTelemetry(app);
    // nothing was added: no onClose/onError hooks
    app.get("/boom", async () => {
      throw new Error("x");
    });
    expect((await app.inject("/boom")).statusCode).toBe(500);
    await app.close();
  });
});

describe("sentryOptions (the hygiene contract)", () => {
  const o = sentryOptions({ SENTRY_DSN: "http://k@localhost:9009/1", SENTRY_ENVIRONMENT: "test" });

  it("collects nothing by default", () => {
    expect(o.defaultIntegrations).toBe(false);
    expect(o.tracesSampleRate).toBe(0);
    expect(o.maxBreadcrumbs).toBe(0);
    expect(o.includeServerName).toBe(false);
    expect(o.beforeBreadcrumb?.({ message: "x" } as never, undefined)).toBeNull();
    expect(o).not.toHaveProperty("sendDefaultPii", true);
    expect(o.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
  });

  it("only the process-level and error-linking integrations are installed", () => {
    const names = (o.integrations as { name: string }[]).map((i) => i.name).sort();
    expect(names).toEqual([
      "Dedupe",
      "LinkedErrors",
      "OnUncaughtException",
      "OnUnhandledRejection",
    ]);
  });

  it("beforeSend runs the shared scrubber", async () => {
    const out = await (
      o.beforeSend as unknown as (
        e: unknown,
        h: unknown,
      ) => Promise<Record<string, unknown>> | Record<string, unknown>
    )(
      {
        message: "mom@example.com 47.6062, -122.3321",
        request: { url: "/x" },
        user: { email: "mom@example.com" },
        breadcrumbs: [{ message: "x" }],
      },
      {},
    );
    expect(JSON.stringify(out)).not.toContain("mom@example.com");
    expect(out).not.toHaveProperty("request");
    expect(out).not.toHaveProperty("user");
    expect(out).not.toHaveProperty("breadcrumbs");
  });
});

describe("capturableError / requestErrorTags", () => {
  it("turns a Postgres error into a SQLSTATE-only error that keeps frames", () => {
    const pg = Object.assign(new Error("duplicate key value (email)=(mom@example.com)"), {
      code: "23505",
      severity: "ERROR",
      detail: "Key (email)=(mom@example.com) already exists.",
    });
    const safe = capturableError(pg) as Error;
    expect(safe.name).toBe("DatabaseError");
    expect(safe.message).toBe("sqlstate 23505");
    expect(safe.stack).not.toContain("mom@example.com");
    expect(safe.stack).toContain("at ");
  });

  it("passes other errors through", () => {
    const e = new Error("boom");
    expect(capturableError(e)).toBe(e);
  });

  it("tags carry the route pattern, never the URL", () => {
    const tags = requestErrorTags(
      {
        method: "POST",
        routeOptions: { url: "/babies/:id/exports" },
        url: "/babies/abc/exports?token=secret",
      } as never,
      500,
    );
    expect(tags).toEqual({
      service: "api",
      route: "/babies/:id/exports",
      method: "POST",
      status: "500",
    });
    expect(requestErrorTags({ method: "GET", routeOptions: undefined } as never, 503).route).toBe(
      "(unmatched)",
    );
  });
});

describe("with a DSN (local ingest)", () => {
  it("initialises once, captures a 5xx with only route tags and a scrubbed message", async () => {
    const s = await sink();
    try {
      const env = { SENTRY_DSN: s.dsn, SENTRY_ENVIRONMENT: "test", NODE_ENV: "test" as const };
      expect(initTelemetry(env)).toBe(true);
      expect(initTelemetry(env)).toBe(true);
      expect(telemetryEnabled()).toBe(true);

      const app = Fastify();
      app.setErrorHandler((err, _req, reply) => {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        void reply.code(status).send({ error: "x" });
      });
      registerTelemetry(app);
      app.get("/babies/:id/exports", async () => {
        throw new Error(`failed for mom@example.com with ${JWT} at 47.6062, -122.3321`);
      });
      app.get("/bad/:id", async () => {
        throw Object.assign(new Error("nope"), { statusCode: 404 });
      });
      const res = await app.inject({
        method: "GET",
        url: "/babies/11111111-1111-4111-8111-111111111111/exports?token=querysecret",
        headers: { cookie: `sb=${JWT}`, authorization: `Bearer ${JWT}` },
      });
      expect(res.statusCode).toBe(500);
      await app.inject("/bad/1");
      await Sentry.flush(3000);
      await app.close();

      const raw = s.bodies.join("\n");
      const events = eventsOf(s.bodies).filter((e) => "exception" in e);
      expect(events).toHaveLength(1); // the 404 was not captured
      const event = events[0] as Record<string, unknown>;
      expect(event.tags).toMatchObject({
        service: "api",
        route: "/babies/:id/exports",
        method: "GET",
        status: "500",
      });
      for (const secret of [
        "mom@example.com",
        "eyJhbGci",
        "47.6062",
        "querysecret",
        "11111111-1111-4111",
      ]) {
        expect(raw, secret).not.toContain(secret);
      }
      for (const key of ["request", "user", "breadcrumbs", "server_name"]) {
        expect(event, key).not.toHaveProperty(key);
      }
    } finally {
      await s.close();
    }
  });

  it("a Postgres error is captured by SQLSTATE, not by its message", async () => {
    const s = await sink();
    try {
      initTelemetry({ SENTRY_DSN: s.dsn, SENTRY_ENVIRONMENT: "t", NODE_ENV: "test" });
      captureRequestError(
        { method: "POST", routeOptions: { url: "/x" } } as never,
        Object.assign(new Error("Failing row contains (mom@example.com)"), {
          code: "23514",
          severity: "ERROR",
        }),
        500,
      );
      await Sentry.flush(3000);
      const raw = s.bodies.join("\n");
      expect(raw).toContain("sqlstate 23514");
      expect(raw).not.toContain("mom@example.com");
    } finally {
      await s.close();
    }
  });

  it("status below 500 is never captured", async () => {
    const s = await sink();
    try {
      initTelemetry({ SENTRY_DSN: s.dsn, SENTRY_ENVIRONMENT: "t", NODE_ENV: "test" });
      captureRequestError(
        { method: "GET", routeOptions: { url: "/x" } } as never,
        new Error("e"),
        429,
      );
      await Sentry.flush(1000);
      expect(s.bodies).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
