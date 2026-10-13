import { createHash, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appUpdateEnvelopeSchema,
  appUpdateManifestQuerySchema,
  appUpdateManifestResponseSchema,
} from "./api/app-update";
import {
  APP_UPDATE_EXCLUDE_PREFIXES,
  APP_UPDATE_KEY_PLACEHOLDER,
  APP_UPDATE_MAX_BUNDLE_BYTES,
  APP_UPDATE_MAX_FILES,
  APP_UPDATE_P256_SPKI_BASE64_RE,
  APP_UPDATE_PUBLIC_KEYS,
  appUpdateContentId,
  appUpdateFileSchema,
  appUpdateFileUrl,
  appUpdateManifestSchema,
  appUpdateTrustedKeyForSpki,
  isAppUpdateBaseUrl,
  signedAppUpdateManifestSchema,
} from "./app-update";
import { appUpdateEnvSchema } from "./env";

// Live updates: shared contracts (docs/plans/step-14.md 2.3, 2.10).

const E = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    version: "0123456789abcdef",
    webVersion: "1.0.0",
    minNativeBuild: { ios: 1, android: 1 },
    builtAt: "2026-10-12T10:00:00.000Z",
    files: [
      { path: "index.html", sha256: E, size: 0 },
      { path: "assets/app-1.js", sha256: sha("x"), size: 1 },
    ],
    ...overrides,
  };
}

describe("appUpdateContentId", () => {
  it("matches the documented vectors (shared with the generator, Swift and Java)", () => {
    expect(appUpdateContentId([{ path: "index.html", sha256: E }])).toBe("da529e6871940b56");
    const a = { path: "index.html", sha256: sha("<html></html>") };
    const b = { path: "assets/app-1.js", sha256: sha("console.log(1)") };
    expect(a.sha256).toBe("b633a587c652d02386c4f16f8c6f6aab7352d97f16367c3c40576214372dd628");
    expect(b.sha256).toBe("0a286891c11c056e1ab5bfc25bf5d6b2f5b06d38eac10944f678fd8a2e70c393");
    expect(appUpdateContentId([a, b])).toBe("2f80d966699add55");
    expect(appUpdateContentId([b, a])).toBe("2f80d966699add55");
    expect(
      appUpdateContentId([
        { path: "index.html", sha256: "0".repeat(64) },
        { path: "a.txt", sha256: "2".repeat(64) },
        { path: "Z.txt", sha256: "1".repeat(64) },
      ]),
    ).toBe("0d576c52526db35a");
  });

  it("equals Node's sha256 of the sorted lines (the pure SHA-256 is correct, incl. multi-block input)", () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `assets/chunk-${i}-é.js`,
      sha256: sha(String(i)),
    }));
    const lines = [...files]
      .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
      .map((f) => `${f.path}\n${f.sha256}\n`)
      .join("");
    expect(appUpdateContentId(files)).toBe(sha(lines).slice(0, 16));
  });

  it("does not mutate its input and ignores sizes", () => {
    const files = [
      { path: "z.js", sha256: E, size: 1 },
      { path: "index.html", sha256: E, size: 2 },
    ];
    const id = appUpdateContentId(files);
    expect(files[0]?.path).toBe("z.js");
    expect(appUpdateContentId(files.map((f) => ({ ...f, size: 999 })))).toBe(id);
  });
});

describe("APP_UPDATE_PUBLIC_KEYS", () => {
  it.each(Object.entries(APP_UPDATE_PUBLIC_KEYS))("%s is a real P-256 SPKI", (_name, key) => {
    expect(key.spkiBase64).not.toBe(APP_UPDATE_KEY_PLACEHOLDER);
    expect(key.spkiBase64).toMatch(APP_UPDATE_P256_SPKI_BASE64_RE);
    const pub = createPublicKey({
      key: Buffer.from(key.spkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    expect(pub.asymmetricKeyType).toBe("ec");
    expect(pub.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(key.keyId.length).toBeLessThanOrEqual(32);
  });

  it("prod and dev are different keys with different ids", () => {
    expect(APP_UPDATE_PUBLIC_KEYS.prod.spkiBase64).not.toBe(APP_UPDATE_PUBLIC_KEYS.dev.spkiBase64);
    expect(APP_UPDATE_PUBLIC_KEYS.prod.keyId).not.toBe(APP_UPDATE_PUBLIC_KEYS.dev.keyId);
  });

  it("production trusts prod only; other environments trust prod and dev; placeholder never", () => {
    const { prod, dev } = APP_UPDATE_PUBLIC_KEYS;
    expect(appUpdateTrustedKeyForSpki(prod.spkiBase64, { production: true })).toBe(prod);
    expect(appUpdateTrustedKeyForSpki(dev.spkiBase64, { production: true })).toBeNull();
    expect(appUpdateTrustedKeyForSpki(dev.spkiBase64, { production: false })).toBe(dev);
    expect(appUpdateTrustedKeyForSpki(prod.spkiBase64, { production: false })).toBe(prod);
    expect(
      appUpdateTrustedKeyForSpki(APP_UPDATE_KEY_PLACEHOLDER, { production: false }),
    ).toBeNull();
    expect(appUpdateTrustedKeyForSpki("", { production: false })).toBeNull();
  });
});

describe("appUpdateFileSchema path rules", () => {
  const file = (path: string) => ({ path, sha256: E, size: 0 });
  it.each(["index.html", "assets/a.js", "a..b/c.js", "x/.well-known-ish", "dir/..hidden"])(
    "accepts %j",
    (p) => expect(appUpdateFileSchema.safeParse(file(p)).success).toBe(true),
  );
  it.each(["", "/etc/passwd", "..", "../x", "a/../b", "a/..", "a\u0000b", "x".repeat(513)])(
    "rejects %j",
    (p) => expect(appUpdateFileSchema.safeParse(file(p)).success).toBe(false),
  );

  it("rejects uppercase/short hashes and negative or huge sizes", () => {
    expect(appUpdateFileSchema.safeParse({ ...file("a"), sha256: E.toUpperCase() }).success).toBe(
      false,
    );
    expect(appUpdateFileSchema.safeParse({ ...file("a"), sha256: "ab" }).success).toBe(false);
    expect(appUpdateFileSchema.safeParse({ ...file("a"), size: -1 }).success).toBe(false);
    expect(
      appUpdateFileSchema.safeParse({ ...file("a"), size: APP_UPDATE_MAX_BUNDLE_BYTES + 1 })
        .success,
    ).toBe(false);
    expect(appUpdateFileSchema.safeParse({ ...file("a"), size: 1.5 }).success).toBe(false);
  });
});

describe("appUpdateManifestSchema", () => {
  it("accepts a valid manifest", () => {
    expect(appUpdateManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  it.each([
    ["schema 2", { schema: 2 }],
    ["uppercase version", { version: "0123456789ABCDEF" }],
    ["short version", { version: "0123" }],
    ["bad webVersion", { webVersion: "1.0 beta" }],
    ["minNativeBuild 0", { minNativeBuild: { ios: 0, android: 1 } }],
    ["bad builtAt", { builtAt: "yesterday" }],
    ["no files", { files: [] }],
    ["no index.html", { files: [{ path: "a.js", sha256: E, size: 0 }] }],
    [
      "duplicate path",
      {
        files: [
          { path: "index.html", sha256: E, size: 0 },
          { path: "index.html", sha256: E, size: 0 },
        ],
      },
    ],
    ...APP_UPDATE_EXCLUDE_PREFIXES.map((p) => [
      `excluded ${p}`,
      {
        files: [
          { path: "index.html", sha256: E, size: 0 },
          { path: `${p}x.json`, sha256: E, size: 0 },
        ],
      },
    ]),
    [
      "summed size over the cap",
      {
        files: [
          { path: "index.html", sha256: E, size: APP_UPDATE_MAX_BUNDLE_BYTES },
          { path: "a.js", sha256: E, size: 1 },
        ],
      },
    ],
    [
      "too many files",
      {
        files: Array.from({ length: APP_UPDATE_MAX_FILES + 1 }, (_, i) => ({
          path: i === 0 ? "index.html" : `f${i}`,
          sha256: E,
          size: 0,
        })),
      },
    ],
  ] as [string, Record<string, unknown>][])("rejects %s", (_n, o) => {
    expect(appUpdateManifestSchema.safeParse(manifest(o)).success).toBe(false);
  });

  it("the plain manifest strips baseUrl; the signed one requires it", () => {
    expect(signedAppUpdateManifestSchema.safeParse(manifest()).success).toBe(false);
    expect(
      signedAppUpdateManifestSchema.safeParse({ ...manifest(), baseUrl: "https://tinyglow.app" })
        .success,
    ).toBe(true);
  });
});

describe("base URL rules", () => {
  it.each([
    "https://tinyglow.app",
    "https://tinyglow.app/web",
    "https://tinyglow.app:8443",
    "http://localhost:18090",
    "http://127.0.0.1:8080",
    "http://10.0.2.2:18090",
  ])("accepts %s", (u) => {
    expect(isAppUpdateBaseUrl(u)).toBe(true);
    expect(signedAppUpdateManifestSchema.safeParse({ ...manifest(), baseUrl: u }).success).toBe(
      true,
    );
  });

  it.each([
    "http://tinyglow.app",
    "http://192.168.1.5:8080",
    "https://tinyglow.app/",
    "https://tinyglow.app?x=1",
    "https://tinyglow.app#f",
    "https://u:p@tinyglow.app",
    "ftp://tinyglow.app",
    "javascript:alert(1)",
    "not a url",
  ])("rejects %s", (u) => {
    expect(isAppUpdateBaseUrl(u)).toBe(false);
    expect(signedAppUpdateManifestSchema.safeParse({ ...manifest(), baseUrl: u }).success).toBe(
      false,
    );
  });

  it("appUpdateFileUrl encodes each segment, keeping the slashes", () => {
    expect(appUpdateFileUrl("https://x.test", "assets/a b#?.js")).toBe(
      "https://x.test/assets/a%20b%23%3F.js",
    );
    expect(appUpdateFileUrl("https://x.test/web", "index.html")).toBe(
      "https://x.test/web/index.html",
    );
  });
});

describe("api contracts", () => {
  it("query: platform enum, native >= 1, current is a content id", () => {
    expect(appUpdateManifestQuerySchema.safeParse({ platform: "ios", native: "12" }).success).toBe(
      true,
    );
    for (const bad of [
      { platform: "mac", native: "1" },
      { platform: "ios", native: "0" },
      { platform: "ios", native: "1.5" },
      { platform: "ios", native: "1000001" },
      { platform: "ios", native: "1", current: "builtin" },
      { platform: "android" },
    ]) {
      expect(appUpdateManifestQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("response: reason exactly when update is null", () => {
    const update = { manifestJson: "{}", signature: "MEUCIQ==", keyId: "dev" };
    expect(appUpdateManifestResponseSchema.safeParse({ update }).success).toBe(true);
    expect(
      appUpdateManifestResponseSchema.safeParse({ update: null, reason: "up_to_date" }).success,
    ).toBe(true);
    expect(appUpdateManifestResponseSchema.safeParse({ update: null }).success).toBe(false);
    expect(appUpdateManifestResponseSchema.safeParse({ update, reason: "disabled" }).success).toBe(
      false,
    );
    expect(
      appUpdateManifestResponseSchema.safeParse({ update: null, reason: "nope" }).success,
    ).toBe(false);
  });

  it("envelope: base64 signature of at most 96 chars, keyId <= 32", () => {
    const ok = { manifestJson: "{}", signature: "MEUCIQ==", keyId: "dev" };
    expect(appUpdateEnvelopeSchema.safeParse(ok).success).toBe(true);
    expect(appUpdateEnvelopeSchema.safeParse({ ...ok, signature: "a".repeat(100) }).success).toBe(
      false,
    );
    expect(appUpdateEnvelopeSchema.safeParse({ ...ok, signature: "not base64!" }).success).toBe(
      false,
    );
    expect(appUpdateEnvelopeSchema.safeParse({ ...ok, keyId: "k".repeat(33) }).success).toBe(false);
    expect(appUpdateEnvelopeSchema.safeParse({ ...ok, manifestJson: "" }).success).toBe(false);
  });
});

describe("appUpdateEnvSchema", () => {
  it("defaults: enabled, no key, compose source URL", () => {
    const env = appUpdateEnvSchema.parse({});
    expect(env.APP_UPDATE_ENABLED).toBe(true);
    expect(env.APP_UPDATE_SIGNING_KEY_BASE64).toBeUndefined();
    expect(env.APP_UPDATE_SOURCE_URL).toBe("http://web/app-update/manifest.json");
    expect(env.APP_UPDATE_FILES_BASE_URL).toBeUndefined();
  });

  it("blank key is unset; false disables; trailing slash of the files base is dropped", () => {
    const env = appUpdateEnvSchema.parse({
      APP_UPDATE_SIGNING_KEY_BASE64: "   ",
      APP_UPDATE_ENABLED: "false",
      APP_UPDATE_FILES_BASE_URL: "https://tinyglow.app/",
    });
    expect(env.APP_UPDATE_SIGNING_KEY_BASE64).toBeUndefined();
    expect(env.APP_UPDATE_ENABLED).toBe(false);
    expect(env.APP_UPDATE_FILES_BASE_URL).toBe("https://tinyglow.app");
  });

  it("an invalid files base URL fails without echoing the value", () => {
    const r = appUpdateEnvSchema.safeParse({ APP_UPDATE_FILES_BASE_URL: "http://192.168.1.9" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain("192.168.1.9");
  });
});
