import { describe, expect, it } from "vitest";
import {
  googleTokenErrorSchema,
  googleTokenResponseSchema,
  IMPORT_MEDIA_MAX_REDIRECTS,
  isAllowedMediaUrl,
  MEDIA_URL_MAX_CHARS,
  mediaDownloadUrl,
  parseAllowedMediaUrl,
  parseGoogleDuration,
  pickerMediaItemSchema,
  pickerMediaItemsPageSchema,
  pickerSessionSchema,
  resolveMediaRedirect,
  scopeIncludesPicker,
} from "./google-photos";
import { GOOGLE_PICKER_SCOPE } from "./imports";

const SUFFIXES = ["googleusercontent.com"];

describe("isAllowedMediaUrl (SSRF guard)", () => {
  it.each([
    "https://lh3.googleusercontent.com/pw/AP1Gcz",
    "https://googleusercontent.com/x",
    "https://LH3.GoogleUserContent.com/x",
    "https://a.b.c.googleusercontent.com/x?y=z",
  ])("allows %s", (u) => {
    expect(isAllowedMediaUrl(u, SUFFIXES)).toBe(true);
  });

  it.each([
    ["http scheme", "http://lh3.googleusercontent.com/x"],
    ["lookalike prefix", "https://evil-googleusercontent.com/x"],
    ["suffix as a subdomain of another host", "https://googleusercontent.com.evil.test/x"],
    ["user-info", "https://user:pw@lh3.googleusercontent.com/x"],
    ["user-info trick", "https://lh3.googleusercontent.com@evil.test/x"],
    ["explicit port", "https://lh3.googleusercontent.com:8443/x"],
    ["IPv4 literal", "https://127.0.0.1/x"],
    ["IPv4 decimal literal", "https://2130706433/x"],
    ["IPv6 literal", "https://[::1]/x"],
    ["metadata service", "http://169.254.169.254/latest/meta-data"],
    ["localhost", "https://localhost/x"],
    ["trailing dot", "https://lh3.googleusercontent.com./x"],
    ["fragment", "https://lh3.googleusercontent.com/x#a"],
    ["backslash trick", "https://evil.test\\@lh3.googleusercontent.com/x"],
    ["whitespace", "https://lh3.googleusercontent.com/x y"],
    ["control chars", "https://lh3.googleusercontent.com/x\u0000"],
    ["file scheme", "file:///etc/passwd"],
    ["javascript scheme", "javascript:alert(1)"],
    ["empty", ""],
    ["not a url", "lh3.googleusercontent.com/x"],
    ["too long", `https://lh3.googleusercontent.com/${"a".repeat(MEDIA_URL_MAX_CHARS)}`],
  ])("refuses %s", (_name, u) => {
    expect(isAllowedMediaUrl(u, SUFFIXES)).toBe(false);
  });

  it("ignores invalid suffixes: a bad config allows less, never more", () => {
    for (const bad of ["com", "", ".", "127.0.0.1", "1.2", "a b.com"])
      expect(isAllowedMediaUrl("https://lh3.googleusercontent.com/x", [bad])).toBe(false);
    expect(isAllowedMediaUrl("https://x.com/x", ["com"])).toBe(false);
  });

  it("accepts a leading dot / upper case in the configured suffix", () => {
    expect(
      isAllowedMediaUrl("https://lh3.googleusercontent.com/x", [".GoogleUserContent.com"]),
    ).toBe(true);
  });

  it("honours the exact-origin allowance (dev fake) and nothing else about it", () => {
    const opts = { exactOrigins: ["http://google-fake:8099"] };
    expect(isAllowedMediaUrl("http://google-fake:8099/media/G-1", SUFFIXES, opts)).toBe(true);
    expect(isAllowedMediaUrl("http://google-fake:8099/media/G-1", SUFFIXES)).toBe(false);
    expect(isAllowedMediaUrl("http://google-fake:9999/media/G-1", SUFFIXES, opts)).toBe(false);
    expect(isAllowedMediaUrl("http://evil.test:8099/media/G-1", SUFFIXES, opts)).toBe(false);
    expect(isAllowedMediaUrl("http://u:p@google-fake:8099/media/G-1", SUFFIXES, opts)).toBe(false);
  });

  it("parseAllowedMediaUrl returns the exact checked href and never throws", () => {
    expect(parseAllowedMediaUrl("https://lh3.googleusercontent.com/a", SUFFIXES)?.href).toBe(
      "https://lh3.googleusercontent.com/a",
    );
    expect(parseAllowedMediaUrl(undefined as unknown as string, SUFFIXES)).toBeNull();
    expect(
      parseAllowedMediaUrl("https://lh3.googleusercontent.com/a", [undefined as unknown as string]),
    ).toBeNull();
  });
});

describe("resolveMediaRedirect", () => {
  const FROM = "https://lh3.googleusercontent.com/pw/A";

  it("follows a same-host redirect (relative or absolute)", () => {
    expect(resolveMediaRedirect(FROM, "/pw/B", SUFFIXES)?.href).toBe(
      "https://lh3.googleusercontent.com/pw/B",
    );
    expect(resolveMediaRedirect(FROM, "https://lh3.googleusercontent.com/z", SUFFIXES)?.href).toBe(
      "https://lh3.googleusercontent.com/z",
    );
  });

  it("refuses another host by default, even an allow-listed one", () => {
    expect(resolveMediaRedirect(FROM, "https://lh4.googleusercontent.com/z", SUFFIXES)).toBeNull();
    expect(
      resolveMediaRedirect(FROM, "https://lh4.googleusercontent.com/z", SUFFIXES, {
        sameHost: false,
      })?.host,
    ).toBe("lh4.googleusercontent.com");
  });

  it.each([
    ["an evil host", "https://evil.test/x"],
    ["metadata", "http://169.254.169.254/"],
    ["http downgrade", "http://lh3.googleusercontent.com/x"],
    ["missing", undefined],
    ["empty", ""],
    ["null", null],
  ])("refuses %s", (_n, loc) => {
    expect(resolveMediaRedirect(FROM, loc as string, SUFFIXES, { sameHost: false })).toBeNull();
  });

  it("is bounded", () => {
    expect(IMPORT_MEDIA_MAX_REDIRECTS).toBe(2);
  });
});

describe("parseGoogleDuration", () => {
  it.each([
    ["5s", 5],
    ["0s", 0],
    ["1800s", 1800],
    ["3.5s", 3.5],
    ["0.25s", 0.25],
  ])("%s", (v, n) => {
    expect(parseGoogleDuration(v)).toBe(n);
  });

  it.each(["", "5", "5m", "-5s", "s", "5 s", "1234567890s", "1.s", "abc"])("rejects %j", (v) => {
    expect(() => parseGoogleDuration(v)).toThrow(RangeError);
  });
});

describe("Google payload schemas", () => {
  it("token response: requires a Bearer access token, strips unknown keys", () => {
    const ok = googleTokenResponseSchema.parse({
      access_token: "ya29.abc",
      expires_in: 3599,
      refresh_token: "1//abc",
      scope: GOOGLE_PICKER_SCOPE,
      token_type: "Bearer",
      surprise: 1,
    });
    expect(ok).not.toHaveProperty("surprise");
    expect(
      googleTokenResponseSchema.safeParse({ access_token: "a", expires_in: 1, token_type: "mac" })
        .success,
    ).toBe(false);
    expect(
      googleTokenResponseSchema.safeParse({ expires_in: 1, token_type: "Bearer" }).success,
    ).toBe(false);
    expect(
      googleTokenResponseSchema.safeParse({
        access_token: "a",
        expires_in: 0,
        token_type: "Bearer",
      }).success,
    ).toBe(false);
  });

  it("token error", () => {
    expect(googleTokenErrorSchema.parse({ error: "invalid_grant" }).error).toBe("invalid_grant");
    expect(googleTokenErrorSchema.safeParse({}).success).toBe(false);
  });

  it("scopeIncludesPicker", () => {
    expect(scopeIncludesPicker(GOOGLE_PICKER_SCOPE)).toBe(true);
    expect(scopeIncludesPicker(`openid ${GOOGLE_PICKER_SCOPE}`)).toBe(true);
    expect(scopeIncludesPicker("openid email")).toBe(false);
    expect(scopeIncludesPicker(`${GOOGLE_PICKER_SCOPE}x`)).toBe(false);
    expect(scopeIncludesPicker(undefined)).toBe(false);
    expect(scopeIncludesPicker(null)).toBe(false);
  });

  it("picker session: http(s) pickerUri only, mediaItemsSet defaults false", () => {
    const s = pickerSessionSchema.parse({
      id: "s1",
      pickerUri: "https://photos.google.com/picker/abc",
      pollingConfig: { pollInterval: "5s", timeoutIn: "1800s" },
      expireTime: "2026-10-10T12:00:00Z",
    });
    expect(s.mediaItemsSet).toBe(false);
    expect(
      pickerSessionSchema.safeParse({ id: "s", pickerUri: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(pickerSessionSchema.safeParse({ id: "s", pickerUri: "data:text/html,x" }).success).toBe(
      false,
    );
    expect(
      pickerSessionSchema.safeParse({
        id: "s",
        pickerUri: "https://x.test/p",
        pollingConfig: { pollInterval: "fast" },
      }).success,
    ).toBe(false);
  });

  const item = {
    id: "i1",
    createTime: "2026-03-01T10:00:00Z",
    type: "PHOTO",
    mediaFile: {
      baseUrl: "https://lh3.googleusercontent.com/a",
      mimeType: "image/jpeg",
      mediaFileMetadata: { width: "640", height: 480 },
    },
  };

  it("media item: int64 strings become numbers; unknown type becomes TYPE_UNSPECIFIED", () => {
    const p = pickerMediaItemSchema.parse(item);
    expect(p.mediaFile.mediaFileMetadata?.width).toBe(640);
    expect(pickerMediaItemSchema.parse({ ...item, type: "LIVE_PHOTO" }).type).toBe(
      "TYPE_UNSPECIFIED",
    );
    expect(
      pickerMediaItemSchema.safeParse({
        ...item,
        mediaFile: { ...item.mediaFile, baseUrl: "ftp://x/y" },
      }).success,
    ).toBe(false);
  });

  it("media items page: empty list default, empty nextPageToken means the end, max 100", () => {
    expect(pickerMediaItemsPageSchema.parse({})).toEqual({ mediaItems: [] });
    expect(
      pickerMediaItemsPageSchema.parse({ mediaItems: [item], nextPageToken: "" }).nextPageToken,
    ).toBeUndefined();
    expect(
      pickerMediaItemsPageSchema.parse({ mediaItems: [item], nextPageToken: "t" }).nextPageToken,
    ).toBe("t");
    expect(
      pickerMediaItemsPageSchema.safeParse({ mediaItems: Array.from({ length: 101 }, () => item) })
        .success,
    ).toBe(false);
  });

  it("mediaDownloadUrl appends =d", () => {
    expect(mediaDownloadUrl("https://lh3.googleusercontent.com/a")).toBe(
      "https://lh3.googleusercontent.com/a=d",
    );
  });
});
