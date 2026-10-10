import { afterEach, describe, expect, it, vi } from "vitest";
import { toAppPath } from "./deepLinks";

// Deep-link allow-list (docs/plans/step-9.md 2.4, 2.15): the URL is only ever turned into an
// in-app route; everything outside the allow-list is ignored.

const HOST = "tinyglow.app";
const INVITE = "A".repeat(43);
const SHARE = "B".repeat(22);

afterEach(() => vi.unstubAllEnvs());

describe("toAppPath: accepted links", () => {
  it("accepts invite and share links on the app link host", () => {
    expect(toAppPath(`https://${HOST}/invite/${INVITE}`)).toBe(`/invite/${INVITE}`);
    expect(toAppPath(`https://${HOST}/s/${SHARE}`)).toBe(`/s/${SHARE}`);
  });

  it("is case-insensitive on the host", () => {
    expect(toAppPath(`https://TinyGlow.APP/s/${SHARE}`)).toBe(`/s/${SHARE}`);
  });

  it("accepts the token length range (share 22..64, invite 20..128) and url-safe characters", () => {
    expect(toAppPath(`https://${HOST}/s/${"a-_".repeat(7)}a`)).toBe(`/s/${"a-_".repeat(7)}a`);
    expect(toAppPath(`https://${HOST}/s/${"x".repeat(64)}`)).not.toBeNull();
    expect(toAppPath(`https://${HOST}/invite/${"x".repeat(20)}`)).not.toBeNull();
    expect(toAppPath(`https://${HOST}/invite/${"x".repeat(128)}`)).not.toBeNull();
  });

  it("drops the query and fragment of invite and share links (they never reach the router)", () => {
    expect(toAppPath(`https://${HOST}/s/${SHARE}?utm=1#frag`)).toBe(`/s/${SHARE}`);
    expect(toAppPath(`https://${HOST}/invite/${INVITE}?x=1`)).toBe(`/invite/${INVITE}`);
  });

  it("keeps the query and fragment of /signin/native only", () => {
    expect(toAppPath(`https://${HOST}/signin/native?code=abc#state=1`)).toBe(
      "/signin/native?code=abc#state=1",
    );
    expect(toAppPath(`https://${HOST}/signin/native`)).toBe("/signin/native");
  });
});

describe("toAppPath: rejected links", () => {
  it.each([
    ["a foreign host", `https://evil.example/s/${SHARE}`],
    ["a look-alike host", `https://${HOST}.evil.example/s/${SHARE}`],
    ["a sub-domain of the host", `https://x.${HOST}/s/${SHARE}`],
    ["http", `http://${HOST}/s/${SHARE}`],
    ["a custom port", `https://${HOST}:8443/s/${SHARE}`],
    ["credentials in the URL", `https://user:pw@${HOST}/s/${SHARE}`],
    ["the web callback path", `https://${HOST}/signin/callback#access_token=x`],
    ["the web sign-in path", `https://${HOST}/signin/native/extra`],
    ["a path that is not allow-listed", `https://${HOST}/settings/account`],
    ["the root", `https://${HOST}/`],
    ["a share token that is too short", `https://${HOST}/s/${"a".repeat(21)}`],
    ["a share token that is too long", `https://${HOST}/s/${"a".repeat(65)}`],
    ["an invite token that is too short", `https://${HOST}/invite/${"a".repeat(19)}`],
    ["an invite token that is too long", `https://${HOST}/invite/${"a".repeat(129)}`],
    ["path traversal out of the allow-list", `https://${HOST}/s/${SHARE}/../../settings/account`],
    ["encoded path traversal", `https://${HOST}/s/%2e%2e%2f${SHARE}`],
    ["a trailing path segment", `https://${HOST}/s/${SHARE}/extra`],
    ["a trailing slash", `https://${HOST}/s/${SHARE}/`],
    ["an encoded slash in the token", `https://${HOST}/s/${"a".repeat(11)}%2f${"a".repeat(11)}`],
    ["another scheme", `ftp://${HOST}/s/${SHARE}`],
    ["javascript:", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["not a URL", "not a url"],
    ["an empty string", ""],
    ["the capacitor origin", `capacitor://localhost/s/${SHARE}`],
  ])("ignores %s", (_n, url) => {
    expect(toAppPath(url)).toBeNull();
  });

  it("dot segments are resolved by URL parsing before matching (the result must still be allow-listed)", () => {
    expect(toAppPath(`https://${HOST}/s/../invite/${INVITE}`)).toBe(`/invite/${INVITE}`);
    expect(toAppPath(`https://${HOST}/x/../s/${SHARE}`)).toBe(`/s/${SHARE}`);
  });

  it("ignores very long tokens without throwing", () => {
    expect(toAppPath(`https://${HOST}/s/${"a".repeat(100_000)}`)).toBeNull();
  });
});

describe("toAppPath: the debug URL scheme", () => {
  it("is ignored unless the build enables it", () => {
    expect(toAppPath(`tinyglow://s/${SHARE}`)).toBeNull();
    vi.stubEnv("VITE_DEEPLINK_DEV_SCHEME", "0");
    expect(toAppPath(`tinyglow://s/${SHARE}`)).toBeNull();
    vi.stubEnv("VITE_DEEPLINK_DEV_SCHEME", "true");
    expect(toAppPath(`tinyglow://s/${SHARE}`)).toBeNull();
  });

  it("with VITE_DEEPLINK_DEV_SCHEME=1 accepts the same paths", () => {
    vi.stubEnv("VITE_DEEPLINK_DEV_SCHEME", "1");
    expect(toAppPath(`tinyglow://s/${SHARE}`)).toBe(`/s/${SHARE}`);
    expect(toAppPath(`tinyglow://invite/${INVITE}`)).toBe(`/invite/${INVITE}`);
    expect(toAppPath("tinyglow://signin/native?code=1")).toBe("/signin/native?code=1");
  });

  it("still rejects paths outside the allow-list and other schemes", () => {
    vi.stubEnv("VITE_DEEPLINK_DEV_SCHEME", "1");
    expect(toAppPath("tinyglow://settings/account")).toBeNull();
    expect(toAppPath(`tinyglow://s/${"a".repeat(5)}`)).toBeNull();
    expect(toAppPath(`otherapp://s/${SHARE}`)).toBeNull();
  });
});

describe("toAppPath: VITE_APP_LINK_HOSTS", () => {
  it("replaces the default host list (comma separated, trimmed, case-insensitive)", () => {
    vi.stubEnv("VITE_APP_LINK_HOSTS", " Example.Test , other.test ");
    expect(toAppPath(`https://example.test/s/${SHARE}`)).toBe(`/s/${SHARE}`);
    expect(toAppPath(`https://other.test/s/${SHARE}`)).toBe(`/s/${SHARE}`);
    expect(toAppPath(`https://${HOST}/s/${SHARE}`)).toBeNull();
  });

  it("an empty list falls back to the default host", () => {
    vi.stubEnv("VITE_APP_LINK_HOSTS", " , ");
    expect(toAppPath(`https://${HOST}/s/${SHARE}`)).toBe(`/s/${SHARE}`);
  });
});
