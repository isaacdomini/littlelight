import { healthzResponseSchema } from "@littlelight/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { ApiConfig } from "../config";
import { errorCategory } from "./healthz";

const config: ApiConfig = {
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  DATABASE_URL: "postgres://postgres:supersecretpw@db:5432/littlelight",
  S3_ENDPOINT: "http://storage-internal.example:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "AKIASECRETKEY",
  S3_SECRET_KEY: "s3-secret-value-xyz",
  S3_BUCKET: "littlelight-dev",
  S3_REGION: "us-east-1",
  S3_FORCE_PATH_STYLE: true,
  JWT_SECRET: "dev-only-jwt-secret-at-least-32-characters",
  GOTRUE_JWT_SECRET: "dev-only-jwt-secret-at-least-32-characters",
  DATA_ENCRYPTION_KEY: "dev-only-data-encryption-key-32-chars-min",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
};

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const okDb = { query: async () => ({ rows: [{ "?column?": 1 }] }), end: async () => undefined };
const okS3 = { send: (async () => ({})) as never, destroy: () => undefined };

describe("GET /healthz", () => {
  it("returns 200 ok when db and storage are reachable", async () => {
    app = await buildApp({ config, db: okDb, s3: okS3, logger: false });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = healthzResponseSchema.parse(res.json());
    expect(body.status).toBe("ok");
    expect(body.service).toBe("api");
    expect(body.checks.db.ok).toBe(true);
    expect(body.checks.storage.ok).toBe(true);
  });

  it("returns 503 degraded and leaks nothing when storage throws", async () => {
    const s3 = {
      send: (async () => {
        throw Object.assign(
          new Error(`connect ECONNREFUSED ${config.S3_ENDPOINT} key=${config.S3_ACCESS_KEY}`),
          { code: "ECONNREFUSED" },
        );
      }) as never,
      destroy: () => undefined,
    };
    app = await buildApp({ config, db: okDb, s3, logger: false });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    const body = healthzResponseSchema.parse(res.json());
    expect(body.status).toBe("degraded");
    expect(body.checks.db.ok).toBe(true);
    expect(body.checks.storage).toMatchObject({ ok: false, error: "ECONNREFUSED" });
    for (const secret of [
      "storage-internal.example",
      "AKIASECRETKEY",
      "s3-secret-value-xyz",
      "supersecretpw",
      config.JWT_SECRET,
      config.DATA_ENCRYPTION_KEY,
    ]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it("returns 503 when the database throws, with a safe error code", async () => {
    const db = {
      query: async () => {
        throw Object.assign(
          new Error("password authentication failed for postgres://x:supersecretpw@db"),
          {
            code: "28P01",
          },
        );
      },
      end: async () => undefined,
    };
    app = await buildApp({ config, db, s3: okS3, logger: false });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    const body = healthzResponseSchema.parse(res.json());
    expect(body.checks.db).toMatchObject({ ok: false, error: "28P01" });
    expect(body.checks.storage.ok).toBe(true);
    expect(res.body).not.toContain("supersecretpw");
  });
});

describe("errorCategory", () => {
  it("never returns a raw message, URL or non-identifier", () => {
    expect(errorCategory(new Error("http://host:9000/secret"))).toBe("error");
    expect(errorCategory({ code: "has spaces and http://x" })).toBe("error");
    expect(errorCategory("string")).toBe("error");
    expect(errorCategory(null)).toBe("error");
  });

  it("returns errno, SQLSTATE or SDK error name", () => {
    expect(errorCategory({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
    expect(errorCategory({ name: "NotFound" })).toBe("NotFound");
  });
});
