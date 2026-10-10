import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_ERROR,
  jsonResponse,
  memoryTokenStore,
  setNativePlatform,
  stubFetch,
} from "../testing/native";

// Native `lib/api` (docs/plans/step-9.md 2.5, 2.15): absolute URL, native client header, bearer
// from the token store, no cookies, transparent refresh, sign-out on a lost session.

const API = "https://api.example.test";

async function load() {
  vi.resetModules();
  const api = await import("./api");
  const store = await import("../platform/tokenStore");
  return { api, store };
}

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", API);
});
afterEach(() => {
  setNativePlatform(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("native requests", () => {
  it("go to VITE_API_URL with the native header, a bearer token and no credentials: include", async () => {
    setNativePlatform("ios");
    const { api, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: "AT-1", refreshToken: "RT-1" }));
    const f = stubFetch(() => jsonResponse({ ok: true }));
    await api.apiFetch("/me");
    const c = f.calls[0];
    expect(c?.url).toBe(`${API}/api/me`);
    expect(c?.headers.get("Authorization")).toBe("Bearer AT-1");
    expect(c?.headers.get("X-Tinyglow-Client")).toBe("native");
    expect(c?.headers.get("Accept")).toBe("application/json");
    expect(c?.credentials).not.toBe("include");
  });

  it("send no Authorization header when nothing is stored", async () => {
    setNativePlatform("android");
    const { api, store } = await load();
    store.setTokenStore(memoryTokenStore(null));
    const f = stubFetch(() => jsonResponse({ ok: true }));
    await api.apiFetch("/me");
    expect(f.calls[0]?.headers.has("Authorization")).toBe(false);
    expect(f.calls[0]?.headers.get("X-Tinyglow-Client")).toBe("native");
  });

  it("JSON bodies get a content type", async () => {
    setNativePlatform("ios");
    const { api, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: "A", refreshToken: "R" }));
    const f = stubFetch(() => jsonResponse({}));
    await api.apiFetch("/me/push-devices", { method: "POST", body: { a: 1 } });
    expect(f.calls[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(f.calls[0]?.body).toEqual({ a: 1 });
  });
});

describe("web requests (control)", () => {
  it("are relative, use the web client header and never send a bearer token", async () => {
    setNativePlatform(null);
    const { api, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: "SHOULD-NOT-BE-SENT", refreshToken: "R" }));
    const f = stubFetch(() => jsonResponse({}));
    await api.apiFetch("/me");
    expect(f.calls[0]?.url).toBe("/api/me");
    expect(f.calls[0]?.headers.get("X-Tinyglow-Client")).toBe("web");
    expect(f.calls[0]?.headers.has("Authorization")).toBe(false);
    expect(f.calls[0]?.credentials).toBe("same-origin");
  });
});

describe("native refresh", () => {
  it("a token_expired 401 refreshes with the stored refresh token, stores the new pair and retries once with it", async () => {
    setNativePlatform("ios");
    const { api, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "OLD", refreshToken: "RT-OLD" });
    store.setTokenStore(tokens);
    const f = stubFetch((c) => {
      if (c.url.endsWith("/auth/refresh")) {
        return jsonResponse({ tokens: { accessToken: "NEW", refreshToken: "RT-NEW" } });
      }
      return c.headers.get("Authorization") === "Bearer NEW"
        ? jsonResponse({ value: 1 })
        : jsonResponse(APP_ERROR("token_expired"), 401);
    });
    const out = await api.apiFetch<{ value: number }>("/me");
    expect(out).toEqual({ value: 1 });
    expect(tokens.value).toEqual({ accessToken: "NEW", refreshToken: "RT-NEW" });
    const refresh = f.calls.find((c) => c.url.endsWith("/auth/refresh"));
    expect(refresh?.body).toEqual({ refreshToken: "RT-OLD" });
    expect(refresh?.url).toBe(`${API}/api/auth/refresh`);
    expect(f.calls.filter((c) => c.url.endsWith("/me"))).toHaveLength(2);
  });

  it("concurrent expired requests share one refresh (single flight)", async () => {
    setNativePlatform("ios");
    const { api, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: "OLD", refreshToken: "RT-OLD" }));
    const f = stubFetch((c) => {
      if (c.url.endsWith("/auth/refresh")) {
        return jsonResponse({ tokens: { accessToken: "NEW", refreshToken: "RT-NEW" } });
      }
      return c.headers.get("Authorization") === "Bearer NEW"
        ? jsonResponse({ value: 1 })
        : jsonResponse(APP_ERROR("token_expired"), 401);
    });
    await Promise.all([api.apiFetch("/a"), api.apiFetch("/b"), api.apiFetch("/c")]);
    expect(f.calls.filter((c) => c.url.endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it("a failed refresh signs out: listeners fire, the Keychain copy is cleared and the caller sees 401", async () => {
    setNativePlatform("ios");
    const { api, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "OLD", refreshToken: "RT-OLD" });
    store.setTokenStore(tokens);
    const signedOut = vi.fn();
    api.onSignedOut(signedOut);
    stubFetch((c) =>
      c.url.endsWith("/auth/refresh")
        ? jsonResponse(APP_ERROR("session_revoked"), 401)
        : jsonResponse(APP_ERROR("token_expired"), 401),
    );
    await expect(api.apiFetch("/me")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(tokens.value).toBeNull();
    expect(tokens.clears).toBeGreaterThanOrEqual(1);
  });

  it("a refresh response without tokens in the body counts as failed on native", async () => {
    setNativePlatform("ios");
    const { api, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: "OLD", refreshToken: "RT-OLD" }));
    stubFetch((c) =>
      c.url.endsWith("/auth/refresh")
        ? jsonResponse({ user: {} })
        : jsonResponse(APP_ERROR("token_expired"), 401),
    );
    expect(await api.refreshSession()).toBe(false);
  });

  it("session_revoked (not token_expired) signs out without a refresh attempt", async () => {
    setNativePlatform("ios");
    const { api, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "A", refreshToken: "R" });
    store.setTokenStore(tokens);
    const signedOut = vi.fn();
    api.onSignedOut(signedOut);
    const f = stubFetch(() => jsonResponse(APP_ERROR("session_revoked"), 401));
    await expect(api.apiFetch("/me")).rejects.toMatchObject({
      status: 401,
      code: "session_revoked",
    });
    expect(f.calls.some((c) => c.url.endsWith("/auth/refresh"))).toBe(false);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(tokens.value).toBeNull();
  });

  it("a wrong sign-in code (401 on /auth/verify) is a form error, not a lost session", async () => {
    setNativePlatform("ios");
    const { api, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "A", refreshToken: "R" });
    store.setTokenStore(tokens);
    const signedOut = vi.fn();
    api.onSignedOut(signedOut);
    stubFetch(() => jsonResponse(APP_ERROR("invalid_code"), 401));
    await expect(api.apiFetch("/auth/verify", { method: "POST", body: {} })).rejects.toMatchObject({
      code: "invalid_code",
    });
    expect(signedOut).not.toHaveBeenCalled();
    expect(tokens.value).not.toBeNull();
  });

  it("the web refresh sends an empty body (the cookie is the credential) and stores nothing", async () => {
    setNativePlatform(null);
    const { api, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "IGNORED", refreshToken: "IGNORED" });
    store.setTokenStore(tokens);
    const f = stubFetch(() => jsonResponse({ user: {} }));
    expect(await api.refreshSession()).toBe(true);
    expect(f.calls[0]?.body).toEqual({});
    expect(tokens.value).toEqual({ accessToken: "IGNORED", refreshToken: "IGNORED" });
  });

  it("a network failure surfaces as a network ApiError", async () => {
    setNativePlatform("ios");
    const { api, store } = await load();
    store.setTokenStore(memoryTokenStore({ accessToken: "A", refreshToken: "R" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(api.apiFetch("/me")).rejects.toMatchObject({ status: 0, code: "network" });
  });
});
