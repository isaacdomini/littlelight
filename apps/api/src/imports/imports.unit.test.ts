import { apiErrorSchema } from "@littlelight/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loggerOptions, redactUrl } from "../app";
import { ConfigError, googleImportSettings, loadConfig } from "../config";
import { mapPgError, registerErrorHandling } from "../lib/errors";
import { clampPollInterval, pickerExpiry } from "./batches";
import { googleFailure } from "./common";
import { GoogleError } from "./google/client";

const pgErr = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, severity: "ERROR", ...extra });

describe("clampPollInterval", () => {
  it.each([
    ["1s", 3],
    ["3s", 3],
    ["3.2s", 4],
    ["5s", 5],
    ["59s", 59],
    ["600s", 60],
    [undefined, 5],
    ["garbage", 5],
    ["-5s", 5],
  ])("%s -> %s", (input, out) => {
    expect(clampPollInterval(input)).toBe(out);
  });
});

describe("pickerExpiry", () => {
  const now = new Date("2026-10-10T10:00:00Z");
  it("caps at 30 minutes", () => {
    expect(pickerExpiry({ expireTime: "2026-10-10T18:00:00Z" }, now).toISOString()).toBe(
      "2026-10-10T10:30:00.000Z",
    );
  });
  it("takes Google's earlier expiry", () => {
    expect(pickerExpiry({ expireTime: "2026-10-10T10:10:00Z" }, now).toISOString()).toBe(
      "2026-10-10T10:10:00.000Z",
    );
  });
  it("falls back to the cap without an expiry or with garbage", () => {
    expect(pickerExpiry({}, now).toISOString()).toBe("2026-10-10T10:30:00.000Z");
    expect(pickerExpiry({ expireTime: "soon" }, now).toISOString()).toBe(
      "2026-10-10T10:30:00.000Z",
    );
  });
});

describe("googleFailure (Google category -> API error)", () => {
  const log = { warn: () => undefined };
  it.each([
    ["google_reconnect", 409, "google_reconnect"],
    ["rate_limited", 429, "rate_limited"],
    ["network", 503, "internal"],
    ["google_denied", 502, "internal"],
    ["internal", 502, "internal"],
    ["not_found", 502, "internal"],
  ] as const)("%s", (category, status, code) => {
    expect(googleFailure(new GoogleError(category), log, "x")).toMatchObject({ status, code });
  });

  it("logs the category and status only", () => {
    const lines: unknown[][] = [];
    googleFailure(
      new GoogleError("network", 502),
      { warn: (...a: unknown[]) => void lines.push(a) } as never,
      "poll",
    );
    expect(lines).toEqual([[{ category: "network", status: 502 }, "google poll failed"]]);
  });
});

describe("mapPgError: photo import triggers", () => {
  it.each([
    ["import source limit reached", 409, "import_source_limit"],
    ["cannot sync into a trashed album", 409, "baby_trashed"],
    ["cannot import into a trashed album", 409, "baby_trashed"],
    ["an import is already in progress for this album", 409, "import_in_progress"],
    ["import rate limit reached: 20 per album per day", 429, "rate_limited"],
    ["import batch transition not allowed", 409, "conflict"],
    ["google_accounts.scope must be set", 500, "internal"],
  ])("23514 %j", (message, status, code) => {
    expect(mapPgError(pgErr("23514", message))).toMatchObject({ status, code });
  });

  it("the one-active unique index is import_in_progress", () => {
    expect(
      mapPgError(
        pgErr("23505", "duplicate key", { constraint: "import_batches_one_active_per_baby" }),
      ),
    ).toMatchObject({ status: 409, code: "import_in_progress" });
  });

  it("a contributor's Apple source insert (42501) is 403 forbidden", () => {
    expect(
      mapPgError(
        pgErr("42501", 'new row violates row-level security policy for table "import_sources"'),
      ),
    ).toMatchObject({ status: 403 });
  });

  it("errors serialize to the shared envelope without the SQL message", async () => {
    const app = Fastify();
    registerErrorHandling(app);
    app.get("/x", async () => {
      throw pgErr("23514", "an import is already in progress for this album", {
        detail: "Failing row contains (secret-album)",
      });
    });
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.statusCode).toBe(409);
    expect(apiErrorSchema.parse(res.json()).error).toBe("import_in_progress");
    expect(res.body).not.toContain("secret-album");
    await app.close();
  });
});

describe("logging: the Google callback and capability URLs never reach a log", () => {
  it("redactUrl drops the code and state of the callback", () => {
    const out = redactUrl(
      "/api/import/google/callback?code=fake-code-abc&state=eyJhbGciOi.eyJzdWIi.sig",
    );
    expect(out).toBe("/api/import/google/callback?[redacted]");
  });

  it("the request serializer shows no query", () => {
    const opts = loggerOptions({ LOG_LEVEL: "info", NODE_ENV: "production" });
    const logged = opts.serializers.req({
      method: "GET",
      url: "/import/google/callback?code=fake-code-x&state=s",
      routeOptions: { url: "/import/google/callback" },
    });
    expect(JSON.stringify(logged)).not.toContain("fake-code");
  });

  it("pino redacts the token and capability fields", () => {
    const lines: string[] = [];
    const opts = loggerOptions({ LOG_LEVEL: "info", NODE_ENV: "production" });
    const app = Fastify({
      logger: {
        level: "info",
        redact: opts.redact,
        stream: { write: (s: string) => void lines.push(s) },
      },
    });
    const logger = app.log;
    logger.info({
      grant: {
        refresh_token: "fake-refresh-1",
        access_token: "fake-access-1",
        pickerUri: "http://x/picker/p",
        baseUrl: "http://x/media/m",
      },
      req: {
        query: { code: "fake-code-1", state: "stateval" },
        headers: { authorization: "Bearer fake-access-1" },
      },
      body: { refreshToken: "r", accessToken: "a" },
    });
    const out = lines.join("");
    for (const s of [
      "fake-refresh-1",
      "fake-access-1",
      "/picker/p",
      "/media/m",
      "fake-code-1",
      "stateval",
    ])
      expect(out, s).not.toContain(s);
  });
});

describe("config: Google import settings", () => {
  const env = {
    DATABASE_URL: "postgres://postgres:dev@db:5432/littlelight",
    S3_ENDPOINT: "http://storage:9000",
    S3_PUBLIC_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY: "dev",
    S3_SECRET_KEY: "devdevdev",
    S3_BUCKET: "b",
    JWT_SECRET: "dev-only-jwt-secret-at-least-32-characters",
    GOTRUE_JWT_SECRET: "dev-only-jwt-secret-at-least-32-characters",
    DATA_ENCRYPTION_KEY: "dev-only-data-encryption-key-32-chars-min",
    PUBLIC_URL: "http://localhost:8080",
    SMTP_HOST: "mail",
    MAIL_FROM: "noreply@littlelight.test",
  };

  it("defaults to none (feature unavailable)", () => {
    expect(googleImportSettings(loadConfig(env)).GOOGLE_IMPORT_PROVIDER).toBe("none");
  });

  it("fake is refused in production, live needs credentials; the error names fields only", () => {
    let err: unknown;
    try {
      loadConfig({ ...env, NODE_ENV: "production", GOOGLE_IMPORT_PROVIDER: "fake" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).fields.join()).toContain("GOOGLE_IMPORT_PROVIDER");
    expect(() => loadConfig({ ...env, GOOGLE_IMPORT_PROVIDER: "live" })).toThrow(ConfigError);
    const ok = loadConfig({
      ...env,
      GOOGLE_IMPORT_PROVIDER: "live",
      GOOGLE_IMPORT_CLIENT_ID: "cid",
      GOOGLE_IMPORT_CLIENT_SECRET: "sec",
    });
    expect(googleImportSettings(ok).GOOGLE_IMPORT_CLIENT_ID).toBe("cid");
  });
});
