import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

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

const prodEnv = {
  ...env,
  NODE_ENV: "production",
  SMTP_HOST: "smtp.example.test",
  MAIL_FROM: "hi@example.test",
};

describe("worker loadConfig: step 9 push settings (pushEnvSchema)", () => {
  it("defaults to provider none, sandbox APNs, the app bundle id and the 600/60/60 timings", () => {
    const c = loadConfig(env);
    expect(c.PUSH_PROVIDER).toBe("none");
    expect(c.APNS_ENVIRONMENT).toBe("sandbox");
    expect(c.APNS_BUNDLE_ID).toBe("com.tesarsoft.littlelight");
    expect(c.PUSH_PHOTOS_DEBOUNCE_SEC).toBe(600);
    expect(c.PUSH_SHARE_DEBOUNCE_SEC).toBe(60);
    expect(c.PUSH_MIN_GAP_MIN).toBe(60);
    expect(c.APNS_PRIVATE_KEY_BASE64).toBeUndefined();
    expect(c.FCM_SERVICE_ACCOUNT_BASE64).toBeUndefined();
  });

  it("treats the blank APNS_/FCM_ values compose passes as unset", () => {
    const c = loadConfig({
      ...env,
      PUSH_PROVIDER: "",
      APNS_TEAM_ID: "",
      APNS_KEY_ID: "",
      APNS_PRIVATE_KEY_BASE64: "",
      FCM_PROJECT_ID: "",
      FCM_SERVICE_ACCOUNT_BASE64: "",
    });
    expect(c.PUSH_PROVIDER).toBe("none");
    expect(c.APNS_TEAM_ID).toBeUndefined();
    expect(c.FCM_PROJECT_ID).toBeUndefined();
  });

  it("the dev fake provider and zero debounces load outside production", () => {
    const c = loadConfig({
      ...env,
      NODE_ENV: "development",
      PUSH_PROVIDER: "fake",
      PUSH_PHOTOS_DEBOUNCE_SEC: "0",
      PUSH_SHARE_DEBOUNCE_SEC: "0",
      PUSH_MIN_GAP_MIN: "0",
    });
    expect(c.PUSH_PROVIDER).toBe("fake");
    expect(c.PUSH_MIN_GAP_MIN).toBe(0);
  });

  it("the fake provider fails boot in production, naming the field", () => {
    try {
      loadConfig({ ...prodEnv, PUSH_PROVIDER: "fake" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).fields.join(" ")).toContain("PUSH_PROVIDER");
    }
    expect(() => loadConfig({ ...prodEnv, PUSH_PROVIDER: "none" })).not.toThrow();
  });

  it("production without SMTP settings fails boot, naming SMTP_HOST", () => {
    try {
      loadConfig({ ...env, NODE_ENV: "production" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).fields.join(" ")).toContain("SMTP_HOST");
    }
  });

  it("an http URL override fails boot in production", () => {
    expect(() => loadConfig({ ...prodEnv, PUSH_FCM_BASE_URL: "http://127.0.0.1:9" })).toThrow(
      ConfigError,
    );
    expect(
      loadConfig({ ...prodEnv, PUSH_FCM_BASE_URL: "https://fcm.example.test/" }).PUSH_FCM_BASE_URL,
    ).toBe("https://fcm.example.test");
  });

  it("rejects malformed provider settings by field name, never echoing the secret", () => {
    const secret = "-----BEGIN PRIVATE KEY----- not base64 -----";
    try {
      loadConfig({ ...env, APNS_PRIVATE_KEY_BASE64: secret });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).fields.join(" ")).toContain("APNS_PRIVATE_KEY_BASE64");
      expect((e as Error).message).not.toContain("BEGIN PRIVATE KEY");
    }
    for (const bad of [
      { APNS_TEAM_ID: "short" },
      { APNS_KEY_ID: "lowercase1" },
      { APNS_ENVIRONMENT: "staging" },
      { PUSH_PROVIDER: "apns" },
      { PUSH_PHOTOS_DEBOUNCE_SEC: "3601" },
      { PUSH_MIN_GAP_MIN: "-1" },
    ]) {
      expect(() => loadConfig({ ...env, ...bad }), JSON.stringify(bad)).toThrow(ConfigError);
    }
  });
});
