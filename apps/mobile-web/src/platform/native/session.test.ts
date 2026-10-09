import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeJwt,
  jsonResponse,
  memoryTokenStore,
  setNativePlatform,
  stubFetch,
} from "../../testing/native";

// Native session upkeep (docs/plans/step-9.md 2.5, 2.15): refresh when the access token is within
// five minutes of expiry; nothing when signed out.

const API = "https://api.example.test";

async function load() {
  vi.resetModules();
  const session = await import("./session");
  const store = await import("../tokenStore");
  return { session, store };
}

beforeEach(() => {
  setNativePlatform("ios");
  vi.stubEnv("VITE_API_URL", API);
});
afterEach(() => {
  setNativePlatform(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const refreshed = { tokens: { accessToken: fakeJwt(3600), refreshToken: "RT-new" } };

describe("refreshIfNeeded", () => {
  it("does nothing when nothing is stored", async () => {
    const { session, store } = await load();
    store.setTokenStore(memoryTokenStore(null));
    const f = stubFetch(() => jsonResponse(refreshed));
    await session.refreshIfNeeded();
    expect(f.calls).toHaveLength(0);
  });

  it("does nothing while the access token has more than five minutes left", async () => {
    const { session, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: fakeJwt(3600), refreshToken: "RT" }));
    const f = stubFetch(() => jsonResponse(refreshed));
    await session.refreshIfNeeded();
    expect(f.calls).toHaveLength(0);
  });

  it("refreshes when the token expires within five minutes", async () => {
    const { session, store } = await load();
    const tokens = memoryTokenStore({ accessToken: fakeJwt(120), refreshToken: "RT-old" });
    store.setTokenStore(tokens);
    const f = stubFetch(() => jsonResponse(refreshed));
    await session.refreshIfNeeded();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`${API}/api/auth/refresh`);
    expect(f.calls[0]?.body).toEqual({ refreshToken: "RT-old" });
    expect(tokens.value?.refreshToken).toBe("RT-new");
  });

  it("refreshes when the token has already expired", async () => {
    const { session, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: fakeJwt(-60), refreshToken: "RT" }));
    const f = stubFetch(() => jsonResponse(refreshed));
    await session.refreshIfNeeded();
    expect(f.calls).toHaveLength(1);
  });

  it("the five minute boundary: 301 s left waits, 299 s refreshes", async () => {
    const { session, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: fakeJwt(301), refreshToken: "RT" }));
    const f = stubFetch(() => jsonResponse(refreshed));
    await session.refreshIfNeeded();
    expect(f.calls).toHaveLength(0);
    store.setTokenStore(memoryTokenStore({ accessToken: fakeJwt(299), refreshToken: "RT" }));
    await session.refreshIfNeeded();
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ["not a JWT", "opaque-token"],
    ["a payload that is not base64 JSON", "a.%%%.c"],
    [
      "a payload without exp",
      `x.${Buffer.from(JSON.stringify({ sub: "u" })).toString("base64url")}.y`,
    ],
  ])("an undecodable token (%s) is refreshed rather than trusted", async (_n, accessToken) => {
    const { session, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken, refreshToken: "RT" }));
    const f = stubFetch(() => jsonResponse(refreshed));
    await session.refreshIfNeeded();
    expect(f.calls).toHaveLength(1);
  });

  it("a failed refresh does not throw (the first API call retries on demand)", async () => {
    const { session, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: fakeJwt(10), refreshToken: "RT" }));
    stubFetch(() => jsonResponse({ error: "session_revoked", message: "x" }, 401));
    await expect(session.refreshIfNeeded()).resolves.toBeUndefined();
  });

  it("never logs the tokens", async () => {
    const { session, store } = await load();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    store.setTokenStore(memoryTokenStore({ accessToken: fakeJwt(10), refreshToken: "RT-secret" }));
    stubFetch(() => jsonResponse(refreshed));
    await session.refreshIfNeeded();
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("RT-");
  });
});

describe("hasStoredSession", () => {
  it("reflects the token store", async () => {
    const { session, store } = await load();
    store.setTokenStore(memoryTokenStore(null));
    expect(await session.hasStoredSession()).toBe(false);
    store.setTokenStore(memoryTokenStore({ accessToken: "a", refreshToken: "r" }));
    expect(await session.hasStoredSession()).toBe(true);
  });
});
