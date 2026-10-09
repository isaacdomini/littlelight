import { describe, expect, it } from "vitest";
import {
  nativeCorsEnvSchema,
  PUSH_ENDPOINTS,
  pushEnvSchema,
  reviewAccountEnabled,
  reviewAccountEnvSchema,
} from "./env";

const HASH = "scrypt$1$16384$8$1$c2FsdHNhbHQ$ZGVyaXZlZGtleQ";

describe("pushEnvSchema", () => {
  it("defaults: provider none, sandbox, bundle id, debounces and gap", () => {
    const e = pushEnvSchema.parse({});
    expect(e.PUSH_PROVIDER).toBe("none");
    expect(e.APNS_ENVIRONMENT).toBe("sandbox");
    expect(e.APNS_BUNDLE_ID).toBe("com.tesarsoft.littlelight");
    expect(e.PUSH_PHOTOS_DEBOUNCE_SEC).toBe(600);
    expect(e.PUSH_SHARE_DEBOUNCE_SEC).toBe(60);
    expect(e.PUSH_MIN_GAP_MIN).toBe(60);
    expect(e.APNS_TEAM_ID).toBeUndefined();
    expect(e.PUSH_APNS_BASE_URL).toBeUndefined();
  });

  it("treats empty strings as unset", () => {
    const e = pushEnvSchema.parse({
      PUSH_PROVIDER: "",
      APNS_TEAM_ID: "",
      APNS_KEY_ID: "",
      APNS_PRIVATE_KEY_BASE64: "",
      APNS_BUNDLE_ID: "",
      APNS_ENVIRONMENT: "",
      FCM_PROJECT_ID: "",
      FCM_SERVICE_ACCOUNT_BASE64: "",
      PUSH_APNS_BASE_URL: "",
      PUSH_MIN_GAP_MIN: "",
    });
    expect(e.PUSH_PROVIDER).toBe("none");
    expect(e.APNS_TEAM_ID).toBeUndefined();
    expect(e.APNS_ENVIRONMENT).toBe("sandbox");
    expect(e.PUSH_MIN_GAP_MIN).toBe(60);
  });

  it("accepts live provider settings", () => {
    const e = pushEnvSchema.parse({
      PUSH_PROVIDER: "live",
      APNS_TEAM_ID: "ABCDE12345",
      APNS_KEY_ID: "ZYXWV98765",
      APNS_PRIVATE_KEY_BASE64: "LS0tLS1CRUdJTg==",
      APNS_ENVIRONMENT: "production",
      FCM_PROJECT_ID: "littlelight-prod",
      FCM_SERVICE_ACCOUNT_BASE64: "eyJhIjoxfQ==",
      PUSH_FCM_BASE_URL: "https://fcm.example.test///",
    });
    expect(e.PUSH_PROVIDER).toBe("live");
    expect(e.PUSH_FCM_BASE_URL).toBe("https://fcm.example.test");
  });

  it.each([
    ["APNS_TEAM_ID", "short"],
    ["APNS_KEY_ID", "abcde12345"],
    ["APNS_ENVIRONMENT", "staging"],
    ["APNS_BUNDLE_ID", "no spaces allowed"],
    ["FCM_PROJECT_ID", "Bad_Project"],
    ["APNS_PRIVATE_KEY_BASE64", "-----BEGIN PRIVATE KEY-----\nabc"],
    ["FCM_SERVICE_ACCOUNT_BASE64", "{ not base64 }"],
    ["PUSH_PROVIDER", "apns"],
    ["PUSH_PHOTOS_DEBOUNCE_SEC", "3601"],
    ["PUSH_SHARE_DEBOUNCE_SEC", "-1"],
    ["PUSH_MIN_GAP_MIN", "1441"],
    ["PUSH_APNS_BASE_URL", "ftp://x.test"],
  ])("rejects %s=%j", (key, value) => {
    expect(pushEnvSchema.safeParse({ [key]: value }).success).toBe(false);
  });

  it("allows 0 for the debounces and the gap (test and gate settings)", () => {
    const e = pushEnvSchema.parse({
      PUSH_PHOTOS_DEBOUNCE_SEC: "0",
      PUSH_SHARE_DEBOUNCE_SEC: "0",
      PUSH_MIN_GAP_MIN: "0",
    });
    expect([e.PUSH_PHOTOS_DEBOUNCE_SEC, e.PUSH_SHARE_DEBOUNCE_SEC, e.PUSH_MIN_GAP_MIN]).toEqual([
      0, 0, 0,
    ]);
  });

  describe("production", () => {
    it("refuses the fake provider", () => {
      const r = pushEnvSchema.safeParse({ PUSH_PROVIDER: "fake", NODE_ENV: "production" });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.path).toEqual(["PUSH_PROVIDER"]);
    });

    it("allows fake outside production", () => {
      expect(
        pushEnvSchema.safeParse({ PUSH_PROVIDER: "fake", NODE_ENV: "development" }).success,
      ).toBe(true);
      expect(pushEnvSchema.safeParse({ PUSH_PROVIDER: "fake", NODE_ENV: "test" }).success).toBe(
        true,
      );
    });

    it("requires https for the URL overrides", () => {
      for (const key of ["PUSH_APNS_BASE_URL", "PUSH_FCM_BASE_URL", "PUSH_OAUTH_TOKEN_URL"]) {
        expect(
          pushEnvSchema.safeParse({ [key]: "http://127.0.0.1:9", NODE_ENV: "production" }).success,
          key,
        ).toBe(false);
        expect(
          pushEnvSchema.safeParse({ [key]: "https://mock.test", NODE_ENV: "production" }).success,
          key,
        ).toBe(true);
        expect(
          pushEnvSchema.safeParse({ [key]: "http://127.0.0.1:9", NODE_ENV: "development" }).success,
          key,
        ).toBe(true);
      }
    });

    it("defaults to production when NODE_ENV is unset (so fake is refused)", () => {
      expect(pushEnvSchema.safeParse({ PUSH_PROVIDER: "fake" }).success).toBe(false);
    });
  });

  it("never echoes a secret value in an error", () => {
    const secret = "{ super secret key }";
    const r = pushEnvSchema.safeParse({ APNS_PRIVATE_KEY_BASE64: secret });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).not.toContain(secret);
  });

  it("exposes the provider endpoints", () => {
    expect(PUSH_ENDPOINTS.APNS_SANDBOX).toBe("https://api.sandbox.push.apple.com");
    expect(PUSH_ENDPOINTS.APNS_PRODUCTION).toBe("https://api.push.apple.com");
    expect(PUSH_ENDPOINTS.FCM).toBe("https://fcm.googleapis.com");
  });
});

describe("nativeCorsEnvSchema", () => {
  it("defaults to the two WebView origins when unset or empty", () => {
    const want = ["capacitor://localhost", "https://localhost"];
    expect(nativeCorsEnvSchema.parse({}).NATIVE_APP_ORIGINS).toEqual(want);
    expect(nativeCorsEnvSchema.parse({ NATIVE_APP_ORIGINS: "" }).NATIVE_APP_ORIGINS).toEqual(want);
  });

  it("parses, trims, lowercases and de-duplicates", () => {
    expect(
      nativeCorsEnvSchema.parse({
        NATIVE_APP_ORIGINS:
          " Capacitor://Localhost , https://localhost,capacitor://localhost,, http://10.0.2.2:5173 ",
      }).NATIVE_APP_ORIGINS,
    ).toEqual(["capacitor://localhost", "https://localhost", "http://10.0.2.2:5173"]);
  });

  it.each([
    "*",
    "https://*.example.com",
    "https://localhost/",
    "https://localhost/path",
    "ftp://x",
    "localhost",
    "https://",
    "capacitor://localhost?x=1",
    ",",
  ])("rejects %j", (v) => {
    expect(nativeCorsEnvSchema.safeParse({ NATIVE_APP_ORIGINS: v }).success).toBe(false);
  });

  it("allows at most 10 origins", () => {
    const many = Array.from({ length: 11 }, (_, i) => `https://h${i}.test`).join(",");
    expect(nativeCorsEnvSchema.safeParse({ NATIVE_APP_ORIGINS: many }).success).toBe(false);
    expect(
      nativeCorsEnvSchema.safeParse({ NATIVE_APP_ORIGINS: many.split(",").slice(0, 10).join(",") })
        .success,
    ).toBe(true);
  });
});

describe("reviewAccountEnvSchema", () => {
  it("is off when neither is set (or both are empty)", () => {
    expect(reviewAccountEnabled(reviewAccountEnvSchema.parse({}))).toBe(false);
    expect(
      reviewAccountEnabled(
        reviewAccountEnvSchema.parse({ REVIEW_ACCOUNT_EMAIL: "", REVIEW_ACCOUNT_CODE_HASH: "" }),
      ),
    ).toBe(false);
  });

  it("is on when both are set; the email is normalized", () => {
    const e = reviewAccountEnvSchema.parse({
      REVIEW_ACCOUNT_EMAIL: "  Reviewer@Example.COM ",
      REVIEW_ACCOUNT_CODE_HASH: HASH,
    });
    expect(e.REVIEW_ACCOUNT_EMAIL).toBe("reviewer@example.com");
    expect(reviewAccountEnabled(e)).toBe(true);
  });

  it("rejects exactly one of the pair, naming the missing field", () => {
    const a = reviewAccountEnvSchema.safeParse({ REVIEW_ACCOUNT_EMAIL: "r@example.com" });
    expect(a.success).toBe(false);
    if (!a.success) expect(a.error.issues[0]?.path).toEqual(["REVIEW_ACCOUNT_CODE_HASH"]);
    const b = reviewAccountEnvSchema.safeParse({ REVIEW_ACCOUNT_CODE_HASH: HASH });
    expect(b.success).toBe(false);
    if (!b.success) expect(b.error.issues[0]?.path).toEqual(["REVIEW_ACCOUNT_EMAIL"]);
  });

  it.each([
    "123456",
    "scrypt$2$1$1$1$a$b",
    "plain text",
    "scrypt$1$16384$8$1$salt",
    `${HASH}$extra!`,
  ])("rejects a hash that is not scrypt$1$ (%s)", (hash) => {
    expect(
      reviewAccountEnvSchema.safeParse({
        REVIEW_ACCOUNT_EMAIL: "r@example.com",
        REVIEW_ACCOUNT_CODE_HASH: hash,
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid email without echoing the hash", () => {
    const r = reviewAccountEnvSchema.safeParse({
      REVIEW_ACCOUNT_EMAIL: "not-an-email",
      REVIEW_ACCOUNT_CODE_HASH: HASH,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).not.toContain(HASH);
  });
});
