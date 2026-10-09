import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, nativeSettings } from "./config";

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
  DATA_ENCRYPTION_KEY: "dev-only-data-encryption-key-32-chars-min",
  PUBLIC_URL: "http://localhost:8080",
  SMTP_HOST: "mail",
  MAIL_FROM: "noreply@littlelight.test",
};
const HASH = "scrypt$1$16384$8$1$c2FsdHNhbHQ$ZGVyaXZlZGtleQ";

describe("loadConfig: native origins and push (step 9)", () => {
  it("defaults NATIVE_APP_ORIGINS to the two WebView origins and the debounces to 600/60", () => {
    const cfg = loadConfig(env);
    expect(cfg.NATIVE_APP_ORIGINS).toEqual(["capacitor://localhost", "https://localhost"]);
    expect(cfg.PUSH_PHOTOS_DEBOUNCE_SEC).toBe(600);
    expect(cfg.PUSH_SHARE_DEBOUNCE_SEC).toBe(60);
  });

  it("parses NATIVE_APP_ORIGINS and treats empty as the default", () => {
    expect(
      loadConfig({ ...env, NATIVE_APP_ORIGINS: "Capacitor://localhost, http://10.0.2.2:5173" })
        .NATIVE_APP_ORIGINS,
    ).toEqual(["capacitor://localhost", "http://10.0.2.2:5173"]);
    expect(loadConfig({ ...env, NATIVE_APP_ORIGINS: "" }).NATIVE_APP_ORIGINS).toEqual([
      "capacitor://localhost",
      "https://localhost",
    ]);
  });

  it("rejects a wildcard or path origin, naming the field", () => {
    for (const bad of ["*", "https://localhost/app"]) {
      expect(() => loadConfig({ ...env, NATIVE_APP_ORIGINS: bad })).toThrow(ConfigError);
      expect(() => loadConfig({ ...env, NATIVE_APP_ORIGINS: bad })).toThrow("NATIVE_APP_ORIGINS");
    }
  });

  it("reads the two debounces (empty ⇒ default; 0 allowed; out of range fails)", () => {
    const cfg = loadConfig({ ...env, PUSH_PHOTOS_DEBOUNCE_SEC: "0", PUSH_SHARE_DEBOUNCE_SEC: "" });
    expect(cfg.PUSH_PHOTOS_DEBOUNCE_SEC).toBe(0);
    expect(cfg.PUSH_SHARE_DEBOUNCE_SEC).toBe(60);
    expect(() => loadConfig({ ...env, PUSH_SHARE_DEBOUNCE_SEC: "99999" })).toThrow(
      "PUSH_SHARE_DEBOUNCE_SEC",
    );
  });

  it("does not read the worker-only provider secrets (a bad APNS value cannot break the api boot)", () => {
    expect(() => loadConfig({ ...env, APNS_KEY_ID: "bad", PUSH_PROVIDER: "live" })).not.toThrow();
    const cfg = loadConfig({ ...env, APNS_PRIVATE_KEY_BASE64: "secret-key-material" }) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(cfg)).not.toContain("secret-key-material");
  });

  it("nativeSettings fills defaults for a partial config", () => {
    expect(nativeSettings({})).toEqual({
      NATIVE_APP_ORIGINS: ["capacitor://localhost", "https://localhost"],
      PUSH_PHOTOS_DEBOUNCE_SEC: 600,
      PUSH_SHARE_DEBOUNCE_SEC: 60,
    });
    expect(
      nativeSettings({ NATIVE_APP_ORIGINS: ["https://x.test"], PUSH_SHARE_DEBOUNCE_SEC: 1 }),
    ).toMatchObject({
      NATIVE_APP_ORIGINS: ["https://x.test"],
      PUSH_SHARE_DEBOUNCE_SEC: 1,
    });
  });
});

describe("loadConfig: review account (step 9)", () => {
  it("is off by default and when both are empty", () => {
    const cfg = loadConfig(env);
    expect(cfg.REVIEW_ACCOUNT_EMAIL).toBeUndefined();
    expect(cfg.REVIEW_ACCOUNT_CODE_HASH).toBeUndefined();
    const blank = loadConfig({ ...env, REVIEW_ACCOUNT_EMAIL: "", REVIEW_ACCOUNT_CODE_HASH: "" });
    expect(blank.REVIEW_ACCOUNT_EMAIL).toBeUndefined();
  });

  it("is on with both set; the email is normalised", () => {
    const cfg = loadConfig({
      ...env,
      REVIEW_ACCOUNT_EMAIL: " Review@Example.com ",
      REVIEW_ACCOUNT_CODE_HASH: HASH,
    });
    expect(cfg.REVIEW_ACCOUNT_EMAIL).toBe("review@example.com");
    expect(cfg.REVIEW_ACCOUNT_CODE_HASH).toBe(HASH);
  });

  it("fails boot on one without the other, naming the missing field and never the hash", () => {
    expect(() => loadConfig({ ...env, REVIEW_ACCOUNT_EMAIL: "r@example.com" })).toThrow(
      "REVIEW_ACCOUNT_CODE_HASH",
    );
    try {
      loadConfig({ ...env, REVIEW_ACCOUNT_CODE_HASH: HASH });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).fields.join(" ")).toContain("REVIEW_ACCOUNT_EMAIL");
      expect((e as Error).message).not.toContain(HASH);
    }
  });

  it("fails boot on a malformed hash or email", () => {
    expect(() =>
      loadConfig({
        ...env,
        REVIEW_ACCOUNT_EMAIL: "r@example.com",
        REVIEW_ACCOUNT_CODE_HASH: "123456",
      }),
    ).toThrow("REVIEW_ACCOUNT_CODE_HASH");
    expect(() =>
      loadConfig({ ...env, REVIEW_ACCOUNT_EMAIL: "nope", REVIEW_ACCOUNT_CODE_HASH: HASH }),
    ).toThrow("REVIEW_ACCOUNT_EMAIL");
  });
});
