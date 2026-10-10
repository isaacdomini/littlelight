import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturableError,
  captureJobError,
  closeTelemetry,
  initTelemetry,
  sentryOptions,
  telemetryEnabled,
  wrapHandler,
} from "./telemetry";

async function sink() {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let buf = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") buf = gunzipSync(buf);
      bodies.push(buf.toString("utf8"));
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    dsn: `http://publickey@127.0.0.1:${(server.address() as AddressInfo).port}/1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

afterEach(async () => {
  await Sentry.close(500);
  vi.restoreAllMocks();
});

describe("worker telemetry off (no DSN)", () => {
  it("does not initialise and makes no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(
      initTelemetry({ NODE_ENV: "test", SENTRY_DSN: undefined, SENTRY_ENVIRONMENT: "test" }),
    ).toBe(false);
    expect(telemetryEnabled()).toBe(false);
    captureJobError("data.export", new Error("x"));
    await closeTelemetry();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wrapHandler passes results through and rethrows errors unchanged", async () => {
    const ok = wrapHandler("q", async (a: number) => a + 1);
    expect(await ok(1)).toBe(2);
    const boom = new Error("boom");
    const bad = wrapHandler("q", async () => {
      throw boom;
    });
    await expect(bad()).rejects.toBe(boom);
  });
});

describe("sentryOptions", () => {
  const o = sentryOptions({ SENTRY_DSN: "http://k@localhost:9009/1", SENTRY_ENVIRONMENT: "test" });
  it("is the same locked-down contract as the api", () => {
    expect(o.defaultIntegrations).toBe(false);
    expect(o.tracesSampleRate).toBe(0);
    expect(o.maxBreadcrumbs).toBe(0);
    expect(o.includeServerName).toBe(false);
    expect(o.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      stackFrameVariables: false,
    });
    expect((o.integrations as { name: string }[]).map((i) => i.name).sort()).toEqual([
      "Dedupe",
      "LinkedErrors",
      "OnUncaughtException",
      "OnUnhandledRejection",
    ]);
  });
});

describe("capturableError", () => {
  it("replaces a Postgres error by its SQLSTATE", () => {
    const e = capturableError(
      Object.assign(new Error("Failing row contains (mom@example.com)"), {
        code: "23514",
        severity: "ERROR",
      }),
    ) as Error;
    expect(e.message).toBe("sqlstate 23514");
    expect(e.stack).not.toContain("mom@example.com");
  });
});

describe("worker telemetry on (local ingest)", () => {
  it("captures a failed job once with tags {service, queue} and a scrubbed message, then rethrows", async () => {
    const s = await sink();
    try {
      expect(initTelemetry({ SENTRY_DSN: s.dsn, SENTRY_ENVIRONMENT: "t", NODE_ENV: "test" })).toBe(
        true,
      );
      const err = new Error(
        "export for mom@example.com failed at 47.6062, -122.3321 https://h/a.zip?X-Amz-Signature=abc",
      );
      const handler = wrapHandler("data.export", async (_payload: { exportId: string }) => {
        throw err;
      });
      await expect(handler({ exportId: "11111111-1111-4111-8111-111111111111" })).rejects.toBe(err);
      await Sentry.flush(3000);
      const raw = s.bodies.join("\n");
      const event = raw
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => "exception" in e);
      expect(event?.tags).toMatchObject({ service: "worker", queue: "data.export" });
      for (const secret of [
        "mom@example.com",
        "47.6062",
        "X-Amz-Signature=abc",
        "11111111-1111-4111",
      ])
        expect(raw, secret).not.toContain(secret);
      for (const k of ["request", "user", "breadcrumbs", "server_name"])
        expect(event, k).not.toHaveProperty(k);
    } finally {
      await s.close();
    }
  });
});
