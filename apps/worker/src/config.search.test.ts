import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

const env = {
  DATABASE_URL: "postgres://tinyglow_worker:pw@db:5432/tinyglow",
  S3_ENDPOINT: "http://storage:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "dev",
  S3_SECRET_KEY: "devdevdev",
  S3_BUCKET: "b",
  JWT_SECRET: "dev-only-jwt-secret-at-least-32-characters",
  DATA_ENCRYPTION_KEY: "dev-only-data-encryption-key-32-chars-min",
};

describe("worker loadConfig: step 7 settings", () => {
  it("applies the search defaults", () => {
    const c = loadConfig(env);
    expect(c.SEARCH_RECONCILE_CRON).toBe("17 * * * *");
    expect(c.SEARCH_EMBED_BATCH).toBe(100);
  });

  it("reads overrides and rejects bad ones by field name", () => {
    expect(loadConfig({ ...env, SEARCH_EMBED_BATCH: "25" }).SEARCH_EMBED_BATCH).toBe(25);
    expect(() => loadConfig({ ...env, SEARCH_EMBED_BATCH: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, SEARCH_RECONCILE_CRON: "nope" })).toThrow(ConfigError);
  });

  it("refuses to start with EMBED_DIMS other than the 1024-wide column", () => {
    for (const bad of ["512", "3072", "abc"]) {
      try {
        loadConfig({ ...env, EMBED_DIMS: bad });
        expect.unreachable(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).fields[0]).toMatch(/^EMBED_DIMS\b/);
        expect((e as Error).message).not.toContain(bad);
      }
    }
    expect(() => loadConfig({ ...env, EMBED_DIMS: "1024" })).not.toThrow();
    expect(() => loadConfig({ ...env, EMBED_DIMS: "" })).not.toThrow();
    expect(loadConfig({ ...env, EMBED_DIMS: "1024" })).not.toHaveProperty("EMBED_DIMS");
  });

  it("does not carry a provider key in the config", () => {
    const c = loadConfig({ ...env, OPENAI_API_KEY: "sk-secret" });
    expect(JSON.stringify(c)).not.toContain("sk-secret");
  });
});
