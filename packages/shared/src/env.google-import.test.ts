import { describe, expect, it } from "vitest";
import {
  GOOGLE_IMPORT_DEFAULTS,
  googleImportEndpoints,
  googleImportEnvSchema,
  googleImportMediaAllowList,
} from "./env";
import { isAllowedMediaUrl } from "./google-photos";

const parse = (env: Record<string, string | undefined>) => googleImportEnvSchema.safeParse(env);

describe("googleImportEnvSchema", () => {
  it("defaults to provider none with the documented defaults", () => {
    const r = googleImportEnvSchema.parse({});
    expect(r.GOOGLE_IMPORT_PROVIDER).toBe("none");
    expect(r.IMPORT_CONCURRENCY).toBe(2);
    expect(r.GOOGLE_IMPORT_MEDIA_HOSTS).toEqual(["googleusercontent.com"]);
    expect(r.GOOGLE_IMPORT_FAKE_URL).toBe(GOOGLE_IMPORT_DEFAULTS.GOOGLE_IMPORT_FAKE_URL);
  });

  it("treats empty strings as unset", () => {
    const r = googleImportEnvSchema.parse({
      GOOGLE_IMPORT_PROVIDER: "",
      GOOGLE_IMPORT_CLIENT_ID: "",
      IMPORT_CONCURRENCY: "",
    });
    expect(r.GOOGLE_IMPORT_PROVIDER).toBe("none");
    expect(r.GOOGLE_IMPORT_CLIENT_ID).toBeUndefined();
    expect(r.IMPORT_CONCURRENCY).toBe(2);
  });

  it("refuses fake in production, naming the field only", () => {
    const r = parse({ GOOGLE_IMPORT_PROVIDER: "fake", NODE_ENV: "production" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["GOOGLE_IMPORT_PROVIDER"]);
    expect(parse({ GOOGLE_IMPORT_PROVIDER: "fake", NODE_ENV: "development" }).success).toBe(true);
    expect(parse({ GOOGLE_IMPORT_PROVIDER: "fake", NODE_ENV: "test" }).success).toBe(true);
  });

  it("live needs both client id and secret, without echoing values", () => {
    expect(parse({ GOOGLE_IMPORT_PROVIDER: "live" }).success).toBe(false);
    const onlyId = parse({
      GOOGLE_IMPORT_PROVIDER: "live",
      GOOGLE_IMPORT_CLIENT_ID: "abc.apps.googleusercontent.com",
    });
    expect(onlyId.success).toBe(false);
    if (!onlyId.success) {
      expect(onlyId.error.issues.map((i) => i.path[0])).toEqual(["GOOGLE_IMPORT_CLIENT_SECRET"]);
      expect(JSON.stringify(onlyId.error.issues)).not.toContain("abc.apps");
    }
    expect(
      parse({
        GOOGLE_IMPORT_PROVIDER: "live",
        GOOGLE_IMPORT_CLIENT_ID: "abc.apps.googleusercontent.com",
        GOOGLE_IMPORT_CLIENT_SECRET: "GOCSPX-secret",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown provider, a bad concurrency and bad host suffixes", () => {
    expect(parse({ GOOGLE_IMPORT_PROVIDER: "maybe" }).success).toBe(false);
    expect(parse({ IMPORT_CONCURRENCY: "0" }).success).toBe(false);
    expect(parse({ IMPORT_CONCURRENCY: "5" }).success).toBe(false);
    expect(parse({ IMPORT_CONCURRENCY: "4" }).success).toBe(true);
    expect(parse({ GOOGLE_IMPORT_MEDIA_HOSTS: "127.0.0.1" }).success).toBe(false);
    expect(parse({ GOOGLE_IMPORT_MEDIA_HOSTS: "com" }).success).toBe(false);
    expect(parse({ GOOGLE_IMPORT_MEDIA_HOSTS: "https://x.com" }).success).toBe(false);
  });

  it("parses, lowercases and de-duplicates media hosts", () => {
    const r = googleImportEnvSchema.parse({
      GOOGLE_IMPORT_MEDIA_HOSTS: " A.com, .a.com ,b.example.org",
    });
    expect(r.GOOGLE_IMPORT_MEDIA_HOSTS).toEqual(["a.com", "b.example.org"]);
  });
});

describe("googleImportEndpoints / googleImportMediaAllowList", () => {
  it("none has no endpoints", () => {
    expect(googleImportEndpoints(googleImportEnvSchema.parse({}))).toBeNull();
  });

  it("live uses Google", () => {
    const e = googleImportEndpoints(
      googleImportEnvSchema.parse({
        GOOGLE_IMPORT_PROVIDER: "live",
        GOOGLE_IMPORT_CLIENT_ID: "a",
        GOOGLE_IMPORT_CLIENT_SECRET: "b",
      }),
    );
    expect(e?.authUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(e?.pickerBaseUrl).toBe("https://photospicker.googleapis.com");
  });

  it("fake: browser-facing auth URL on the public base, server calls on the internal base", () => {
    const env = googleImportEnvSchema.parse({
      GOOGLE_IMPORT_PROVIDER: "fake",
      NODE_ENV: "development",
      GOOGLE_IMPORT_FAKE_URL: "http://google-fake:8099/",
      GOOGLE_IMPORT_FAKE_PUBLIC_URL: "http://localhost:18099",
    });
    const e = googleImportEndpoints(env);
    expect(e).toEqual({
      authUrl: "http://localhost:18099/o/oauth2/v2/auth",
      tokenUrl: "http://google-fake:8099/token",
      revokeUrl: "http://google-fake:8099/revoke",
      pickerBaseUrl: "http://google-fake:8099",
    });
  });

  it("the fake origin joins the allow-list in fake mode only", () => {
    const fake = googleImportMediaAllowList(
      googleImportEnvSchema.parse({ GOOGLE_IMPORT_PROVIDER: "fake", NODE_ENV: "development" }),
    );
    expect(fake.exactOrigins).toEqual(["http://google-fake:8099"]);
    expect(isAllowedMediaUrl("http://google-fake:8099/media/G-1", fake.hostSuffixes, fake)).toBe(
      true,
    );
    const live = googleImportMediaAllowList(
      googleImportEnvSchema.parse({
        GOOGLE_IMPORT_PROVIDER: "live",
        GOOGLE_IMPORT_CLIENT_ID: "a",
        GOOGLE_IMPORT_CLIENT_SECRET: "b",
      }),
    );
    expect(live.exactOrigins).toEqual([]);
    expect(isAllowedMediaUrl("http://google-fake:8099/media/G-1", live.hostSuffixes, live)).toBe(
      false,
    );
  });
});
