import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeFailure,
  main,
  PerfSeedError,
  type PerfSeedTarget,
  perfSeedRefusal,
  resolvePerfSeedTarget,
} from "./perf-seed";

const ok: PerfSeedTarget = {
  databaseUrl: "postgres://postgres:dev@localhost:5432/littlelight",
  s3Endpoint: "http://localhost:9000",
  s3Region: "us-east-1",
  s3AccessKey: "dev",
  s3SecretKey: "devdevdev",
  s3Bucket: "littlelight-dev",
  concurrency: 32,
};

afterEach(() => vi.restoreAllMocks());

describe("resolvePerfSeedTarget", () => {
  it("defaults to the dev stack on localhost", () => {
    expect(resolvePerfSeedTarget({})).toEqual(ok);
  });

  it("derives the default ports from DB_PORT / STORAGE_PORT and honours overrides", () => {
    const t = resolvePerfSeedTarget({ DB_PORT: "55432", STORAGE_PORT: "59000", S3_BUCKET: "b" });
    expect(t.databaseUrl).toBe("postgres://postgres:dev@localhost:55432/littlelight");
    expect(t.s3Endpoint).toBe("http://localhost:59000");
    expect(t.s3Bucket).toBe("b");
    expect(
      resolvePerfSeedTarget({ DATABASE_URL: "postgres://postgres:x@127.0.0.1/db" }).databaseUrl,
    ).toBe("postgres://postgres:x@127.0.0.1/db");
  });

  it("blank variables fall back to defaults; concurrency is clamped and sanitized", () => {
    expect(resolvePerfSeedTarget({ DATABASE_URL: "  " }).databaseUrl).toBe(ok.databaseUrl);
    expect(resolvePerfSeedTarget({ PERF_SEED_CONCURRENCY: "1000" }).concurrency).toBe(128);
    expect(resolvePerfSeedTarget({ PERF_SEED_CONCURRENCY: "0" }).concurrency).toBe(32);
    expect(resolvePerfSeedTarget({ PERF_SEED_CONCURRENCY: "abc" }).concurrency).toBe(32);
    expect(resolvePerfSeedTarget({ PERF_SEED_CONCURRENCY: "8" }).concurrency).toBe(8);
  });
});

describe("perfSeedRefusal", () => {
  it("accepts the dev defaults, 127.0.0.1 and IPv6 loopback", () => {
    expect(perfSeedRefusal(ok, {})).toBeNull();
    expect(
      perfSeedRefusal({ ...ok, databaseUrl: "postgresql://postgres:dev@127.0.0.1:5432/x" }, {}),
    ).toBeNull();
    expect(perfSeedRefusal({ ...ok, s3Endpoint: "https://localhost:9000" }, {})).toBeNull();
    expect(
      perfSeedRefusal({ ...ok, databaseUrl: "postgres://postgres:dev@[::1]:5432/x" }, {}),
    ).toBeNull();
  });

  it("refuses NODE_ENV=production", () => {
    expect(perfSeedRefusal(ok, { NODE_ENV: "production" })).toMatch(/production/);
    expect(perfSeedRefusal(ok, { NODE_ENV: " production " })).toMatch(/production/);
    expect(perfSeedRefusal(ok, { NODE_ENV: "development" })).toBeNull();
  });

  it("refuses a non-localhost database host, including look-alikes", () => {
    for (const host of [
      "db",
      "db.internal",
      "10.0.0.5",
      "localhost.evil.com",
      "evil.com",
      "127.0.0.2",
    ]) {
      expect(
        perfSeedRefusal({ ...ok, databaseUrl: `postgres://postgres:dev@${host}:5432/x` }, {}),
        host,
      ).toMatch(/localhost/);
    }
  });

  it("refuses non-postgres schemes and unparsable URLs", () => {
    expect(perfSeedRefusal({ ...ok, databaseUrl: "mysql://postgres@localhost/x" }, {})).toMatch(
      /postgres:\/\//,
    );
    expect(perfSeedRefusal({ ...ok, databaseUrl: "http://localhost:5432/x" }, {})).toMatch(
      /postgres:\/\//,
    );
    expect(perfSeedRefusal({ ...ok, databaseUrl: "not a url" }, {})).toMatch(/not a valid URL/);
  });

  it("refuses connection-parameter host overrides and any user but postgres", () => {
    for (const p of ["host=db.prod", "hostaddr=10.0.0.1", "port=6543"]) {
      expect(
        perfSeedRefusal({ ...ok, databaseUrl: `postgres://postgres:dev@localhost/x?${p}` }, {}),
      ).toMatch(/must not set/);
    }
    expect(
      perfSeedRefusal({ ...ok, databaseUrl: "postgres://littlelight_api:dev@localhost/x" }, {}),
    ).toMatch(/postgres/);
  });

  it("refuses a remote or non-http S3 endpoint", () => {
    expect(perfSeedRefusal({ ...ok, s3Endpoint: "https://s3.amazonaws.com" }, {})).toMatch(
      /S3_ENDPOINT/,
    );
    expect(perfSeedRefusal({ ...ok, s3Endpoint: "http://storage:9000" }, {})).toMatch(/localhost/);
    expect(perfSeedRefusal({ ...ok, s3Endpoint: "ftp://localhost" }, {})).toMatch(/http/);
    expect(perfSeedRefusal({ ...ok, s3Endpoint: "???" }, {})).toMatch(/not a valid URL/);
  });

  it("never prints the URL or the password", () => {
    const msgs = [
      perfSeedRefusal({ ...ok, databaseUrl: "postgres://postgres:hunter2@prod.example.com/x" }, {}),
      perfSeedRefusal({ ...ok, databaseUrl: "mysql://postgres:hunter2@localhost/x" }, {}),
    ];
    for (const m of msgs) {
      expect(m).not.toContain("hunter2");
      expect(m).not.toContain("prod.example.com");
    }
  });
});

describe("describeFailure", () => {
  it("prints our own messages verbatim", () => {
    expect(describeFailure(new PerfSeedError("the demo family is missing"))).toBe(
      "the demo family is missing",
    );
  });

  it("never echoes a generic error's message (it can carry a connection string)", () => {
    const s = describeFailure(
      new Error("connect ECONNREFUSED postgres://postgres:hunter2@localhost:5432/x"),
    );
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("postgres://");
  });

  it("a non-Error value gives a category, not its text", () => {
    expect(describeFailure("secret-token-123")).not.toContain("secret-token-123");
  });
});

describe("main", () => {
  it("an unknown flag prints usage and exits 2 without touching anything", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["--bogus"], {})).toBe(2);
    expect(err.mock.calls[0]?.[0]).toMatch(/usage/);
  });

  it("--remove with --force is a usage error (2)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["--remove", "--force"], {})).toBe(2);
  });

  it("--help exits 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["--help"], {})).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("refuses production and a remote database with exit 1 before connecting", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main([], { NODE_ENV: "production" })).toBe(1);
    expect(
      await main(["--remove"], { DATABASE_URL: "postgres://postgres:pw@prod.example.com/x" }),
    ).toBe(1);
    expect(err.mock.calls.flat().join(" ")).not.toContain("prod.example.com");
  });

  it("tolerates the `--` pnpm passes through", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["--", "--bogus"], {})).toBe(2);
  });
});
