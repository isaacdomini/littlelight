import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, memoryTokenStore, setNativePlatform, stubFetch } from "../testing/native";

// authApi native behaviour (docs/plans/step-9.md 2.5, 2.15): tokens from the body go to the token
// store; sign-out unregisters the push device BEFORE the request and wipes the store after, even
// when the request fails.

const API = "https://api.example.test";
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.com" };
const session = (withTokens: boolean) => ({
  user: USER,
  session: {
    createdAt: "2026-10-09T10:00:00.000Z",
    expiresAt: "2026-10-09T11:00:00.000Z",
    isFresh: true,
  },
  ...(withTokens
    ? { tokens: { accessToken: "AT-new", refreshToken: "RT-new", expiresIn: 3600 } }
    : {}),
});

async function load() {
  vi.resetModules();
  const authApi = await import("./authApi");
  const store = await import("../platform/tokenStore");
  return { authApi, store };
}

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", API);
});
afterEach(() => {
  setNativePlatform(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("native sign-in persistence", () => {
  it.each([
    ["verifyCode", (a: typeof import("./authApi")) => a.verifyCode("a@example.com", "123456")],
    ["verifyTokenHash", (a: typeof import("./authApi")) => a.verifyTokenHash("hash")],
    ["exchangePkce", (a: typeof import("./authApi")) => a.exchangePkce("code", "v".repeat(43))],
  ])("%s keeps the body's tokens in the token store", async (_n, call) => {
    setNativePlatform("ios");
    const { authApi, store } = await load();
    const tokens = memoryTokenStore();
    store.setTokenStore(tokens);
    stubFetch(() => jsonResponse(session(true)));
    const res = await call(authApi);
    expect(res.user.id).toBe(USER.id);
    expect(tokens.value).toEqual({ accessToken: "AT-new", refreshToken: "RT-new" });
    expect(Object.keys(tokens.value ?? {}).sort()).toEqual(["accessToken", "refreshToken"]);
  });

  it("a response without tokens (web) stores nothing", async () => {
    setNativePlatform(null);
    const { authApi, store } = await load();
    const tokens = memoryTokenStore();
    store.setTokenStore(tokens);
    stubFetch(() => jsonResponse(session(false)));
    await authApi.verifyCode("a@example.com", "123456");
    expect(tokens.value).toBeNull();
  });

  it("on the web even a body that carries tokens is not stored", async () => {
    setNativePlatform(null);
    const { authApi, store } = await load();
    const tokens = memoryTokenStore();
    store.setTokenStore(tokens);
    stubFetch(() => jsonResponse(session(true)));
    await authApi.verifyCode("a@example.com", "123456");
    expect(tokens.value).toBeNull();
  });

  it("requestCode posts the email (and the captcha token only when given)", async () => {
    setNativePlatform("ios");
    const { authApi, store } = await load();
    store.setTokenStore(memoryTokenStore());
    const f = stubFetch(() => jsonResponse({ ok: true }, 202));
    await authApi.requestCode("a@example.com");
    await authApi.requestCode("a@example.com", "cap");
    expect(f.calls[0]?.body).toEqual({ email: "a@example.com" });
    expect(f.calls[1]?.body).toEqual({ email: "a@example.com", captchaToken: "cap" });
  });
});

describe("signOutRequest", () => {
  it("web: just the request, no push cleanup and no token store access", async () => {
    setNativePlatform(null);
    const { authApi, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "A", refreshToken: "R" });
    store.setTokenStore(tokens);
    const f = stubFetch(() => jsonResponse({}, 204));
    await authApi.signOutRequest("local");
    expect(f.calls.map((c) => c.url)).toEqual(["/api/auth/signout"]);
    expect(f.calls[0]?.body).toEqual({ scope: "local" });
    expect(tokens.clears).toBe(0);
  });

  it("native: unregisters the push device first (with the bearer), then signs out, then wipes the store", async () => {
    setNativePlatform("ios");
    const { authApi, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "AT-1", refreshToken: "RT-1" });
    store.setTokenStore(tokens);
    const order: string[] = [];
    const f = stubFetch((c) => {
      order.push(
        `${c.method} ${c.url.replace(API, "")} auth=${c.headers.get("Authorization")} stored=${tokens.value ? "yes" : "no"}`,
      );
      return jsonResponse({}, 204);
    });
    await authApi.signOutRequest("global");
    expect(order).toEqual([
      "DELETE /api/me/push-devices/current auth=Bearer AT-1 stored=yes",
      "POST /api/auth/signout auth=Bearer AT-1 stored=yes",
    ]);
    expect(f.calls[1]?.body).toEqual({ scope: "global" });
    expect(tokens.value).toBeNull();
    expect(tokens.clears).toBeGreaterThanOrEqual(1);
  });

  it("native: a failing push cleanup does not stop the sign-out", async () => {
    setNativePlatform("ios");
    const { authApi, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "AT-1", refreshToken: "RT-1" });
    store.setTokenStore(tokens);
    const f = stubFetch((c) =>
      c.url.includes("push-devices")
        ? jsonResponse({ error: "internal", message: "x" }, 500)
        : jsonResponse({}, 204),
    );
    await authApi.signOutRequest("local");
    expect(f.calls.some((c) => c.url.endsWith("/auth/signout"))).toBe(true);
    expect(tokens.value).toBeNull();
  });

  it("native: the store is wiped even when the sign-out request fails", async () => {
    setNativePlatform("ios");
    const { authApi, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "AT-1", refreshToken: "RT-1" });
    store.setTokenStore(tokens);
    stubFetch((c) =>
      c.url.endsWith("/auth/signout")
        ? jsonResponse({ error: "internal", message: "x" }, 500)
        : jsonResponse({}, 204),
    );
    await expect(authApi.signOutRequest("local")).rejects.toBeDefined();
    expect(tokens.value).toBeNull();
  });

  it("native: the store is wiped when offline too", async () => {
    setNativePlatform("android");
    const { authApi, store } = await load();
    const tokens = memoryTokenStore({ accessToken: "AT-1", refreshToken: "RT-1" });
    store.setTokenStore(tokens);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(authApi.signOutRequest("local")).rejects.toBeDefined();
    expect(tokens.value).toBeNull();
  });
});
