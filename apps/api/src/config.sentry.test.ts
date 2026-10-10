import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

const SECRET = "dev-only-jwt-secret-at-least-32-characters";
const env = {
  DATABASE_URL: "postgres://postgres:hunter2pw@db:5432/tinyglow",
  S3_ENDPOINT: "http://storage:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "dev",
  S3_SECRET_KEY: "devdevdev",
  S3_BUCKET: "tinyglow-dev",
  JWT_SECRET: SECRET,
  GOTRUE_JWT_SECRET: SECRET,
  DATA_ENCRYPTION_KEY: "dev-only-data-encryption-key-32-chars-min",
  PUBLIC_URL: "http://localhost:8080",
  SMTP_HOST: "mail",
  MAIL_FROM: "noreply@tinyglow.test",
};

describe("api loadConfig: Sentry (review fixes 2.6)", () => {
  it("no DSN means telemetry is off, the environment defaults to NODE_ENV", () => {
    const c = loadConfig({ ...env, NODE_ENV: "development" });
    expect(c.SENTRY_DSN).toBeUndefined();
    expect(c.SENTRY_ENVIRONMENT).toBe("development");
  });

  it("treats the blank values compose passes as unset", () => {
    const c = loadConfig({ ...env, SENTRY_DSN: "", SENTRY_ENVIRONMENT: "" });
    expect(c.SENTRY_DSN).toBeUndefined();
  });

  it("accepts a DSN and an explicit environment", () => {
    const c = loadConfig({
      ...env,
      SENTRY_DSN: "https://abc@o1.ingest.sentry.io/42",
      SENTRY_ENVIRONMENT: "staging",
    });
    expect(c.SENTRY_DSN).toBe("https://abc@o1.ingest.sentry.io/42");
    expect(c.SENTRY_ENVIRONMENT).toBe("staging");
  });

  it("a malformed DSN fails boot naming the field and never echoing the value", () => {
    try {
      loadConfig({ ...env, SENTRY_DSN: "https://secretkey@nowhere" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).fields.join(" ")).toContain("SENTRY_DSN");
      expect((e as ConfigError).message).not.toContain("secretkey");
    }
  });
});
