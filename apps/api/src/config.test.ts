import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

const SECRET = "dev-only-jwt-secret-at-least-32-characters";
const env = {
  DATABASE_URL: "postgres://postgres:hunter2pw@db:5432/littlelight",
  S3_ENDPOINT: "http://storage:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "dev",
  S3_SECRET_KEY: "devdevdev",
  S3_BUCKET: "littlelight-dev",
  JWT_SECRET: SECRET,
  GOTRUE_JWT_SECRET: SECRET,
};

describe("loadConfig", () => {
  it("loads a valid env and applies defaults", () => {
    const cfg = loadConfig(env);
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.S3_REGION).toBe("us-east-1");
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ ...env, API_PORT: "" }).API_PORT).toBe(3000);
  });

  it("rejects GOTRUE_JWT_SECRET != JWT_SECRET and never echoes values", () => {
    try {
      loadConfig({ ...env, GOTRUE_JWT_SECRET: "x".repeat(40) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain("GOTRUE_JWT_SECRET");
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain("x".repeat(40));
    }
  });

  it("reports field names only for a bad DATABASE_URL", () => {
    try {
      loadConfig({ ...env, DATABASE_URL: "hunter2pw-not-a-url" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("DATABASE_URL");
      expect((err as Error).message).not.toContain("hunter2pw");
    }
  });

  it("fails on missing required vars", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
});
