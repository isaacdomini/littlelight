import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, mailConfigOf } from "./config";

const env = {
  DATABASE_URL: "postgres://littlelight_worker:pw@db:5432/littlelight",
  S3_ENDPOINT: "http://storage:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "dev",
  S3_SECRET_KEY: "devdevdev",
  S3_BUCKET: "b",
  JWT_SECRET: "dev-only-jwt-secret-at-least-32-characters",
  DATA_ENCRYPTION_KEY: "dev-only-data-encryption-key-32-chars-min",
};

describe("worker loadConfig: export, Sentry and SMTP (review fixes)", () => {
  it("defaults EXPORT_MAX_BYTES to 100 GiB and has no DSN or SMTP outside production", () => {
    const c = loadConfig(env);
    expect(c.EXPORT_MAX_BYTES).toBe(107_374_182_400);
    expect(c.SENTRY_DSN).toBeUndefined();
    expect(c.SMTP_HOST).toBeUndefined();
    expect(mailConfigOf(c)).toBeNull();
  });

  it("EXPORT_MAX_BYTES below 1 GiB fails boot naming the field", () => {
    try {
      loadConfig({ ...env, EXPORT_MAX_BYTES: "1024" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).fields.join(" ")).toContain("EXPORT_MAX_BYTES");
    }
  });

  it("parses SMTP when SMTP_HOST is set and builds the mail config", () => {
    const c = loadConfig({ ...env, SMTP_HOST: "mail", SMTP_PORT: "1025", MAIL_FROM: "a@b.test" });
    expect(mailConfigOf(c)).toMatchObject({
      SMTP_HOST: "mail",
      SMTP_PORT: 1025,
      SMTP_SECURE: false,
      MAIL_FROM: "a@b.test",
    });
  });

  it("SMTP_HOST without a valid MAIL_FROM fails boot", () => {
    expect(() => loadConfig({ ...env, SMTP_HOST: "mail" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, SMTP_HOST: "mail", MAIL_FROM: "nope" })).toThrow(ConfigError);
  });

  it("a malformed SENTRY_DSN fails boot without echoing it", () => {
    try {
      loadConfig({ ...env, SENTRY_DSN: "https://secretkey@nowhere" });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).fields.join(" ")).toContain("SENTRY_DSN");
      expect((e as ConfigError).message).not.toContain("secretkey");
    }
  });
});
