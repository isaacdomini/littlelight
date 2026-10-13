import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PasskeyPlatform, setPasskeyPlatform } from "../platform/passkeys";
import { setTokenStore, webTokenStore } from "../platform/tokenStore";
import { jsonResponse, memoryTokenStore, setNativePlatform, stubFetch } from "../testing/native";
import { newQueryClient } from "../testing/render";
import { ApiError } from "./api";
import {
  listPasskeys,
  passkeySignIn,
  registerPasskey,
  removePasskey,
  renamePasskey,
  usePasskeySupport,
} from "./passkeys";

// The API <-> ceremony glue (docs/plans/step-13.md 2.1, 2.5): options -> platform -> verify /
// register, tokens kept on native, and the `usePasskeySupport` gate (server flag AND platform).

const CH = "7e1d2c3b-4a5f-4e6d-8c7b-0a1b2c3d4e5f";
const PK = "3f2c1b0a-1234-4abc-8def-0123456789ab";
const credential = {
  id: "AQIDBA",
  rawId: "AQIDBA",
  type: "public-key" as const,
  response: { clientDataJSON: "e30", authenticatorData: "AAAA", signature: "BBBB" },
  clientExtensionResults: {},
};
const optionsBody = {
  challengeId: CH,
  options: { challenge: "dGVzdA", rpId: "localhost" },
  expiresAt: "2026-10-11T12:05:00.000Z",
};
const session = {
  user: { id: "11111111-1111-4111-8111-111111111111", email: "p@example.com" },
  session: {
    createdAt: "2026-10-11T12:00:00.000Z",
    expiresAt: "2026-10-11T13:00:00.000Z",
    isFresh: true,
  },
};
const passkey = {
  id: PK,
  name: "Passkey",
  createdAt: "2026-10-11T12:00:00.000Z",
  lastUsedAt: null,
};
const config = (passkeys: boolean) => ({
  providers: { apple: false, google: false },
  turnstileSiteKey: null,
  termsVersion: "2026-01",
  privacyVersion: "2026-01",
  passkeys,
});

function fakePlatform(over: Partial<PasskeyPlatform> = {}) {
  const p = {
    supported: vi.fn(async () => true),
    conditionalUiSupported: vi.fn(async () => true),
    create: vi.fn(async () => credential),
    get: vi.fn(async () => credential),
    ...over,
  };
  setPasskeyPlatform(p as PasskeyPlatform);
  return p;
}

/** Scripted API: records bodies; `fail` makes one path answer an error. */
function scriptApi(
  fail: { path: string; status: number; error: string } = { path: "", status: 0, error: "" },
) {
  return stubFetch((c) => {
    const path = new URL(c.url, "http://localhost").pathname.replace(/^\/api/, "");
    if (fail.path && path.endsWith(fail.path)) {
      return jsonResponse(
        {
          error: fail.error,
          message: "m",
          details: fail.error === "passkey_limit" ? { max: 5 } : undefined,
        },
        fail.status,
      );
    }
    if (path === "/auth/config") return jsonResponse(config(true));
    if (path === "/auth/passkey/options") return jsonResponse(optionsBody);
    if (path === "/auth/passkey/verify") return jsonResponse(session);
    if (path === "/me/passkeys/options") return jsonResponse(optionsBody);
    if (path === "/me/passkeys" && c.method === "POST") return jsonResponse(passkey, 201);
    if (path === "/me/passkeys") return jsonResponse({ passkeys: [passkey], max: 5 });
    if (path === `/me/passkeys/${PK}` && c.method === "PATCH")
      return jsonResponse({ ...passkey, name: (c.body as { name: string }).name });
    if (path === `/me/passkeys/${PK}` && c.method === "DELETE") return jsonResponse(null, 204);
    return jsonResponse({ error: "not_found", message: "nope" }, 404);
  });
}

const callsTo = (f: ReturnType<typeof stubFetch>, suffix: string) =>
  f.calls.filter((c) => new URL(c.url, "http://localhost").pathname.endsWith(suffix));

afterEach(() => {
  setPasskeyPlatform(null);
  setNativePlatform(null);
  setTokenStore(webTokenStore);
  vi.unstubAllGlobals();
});

describe("passkeySignIn", () => {
  it("options -> platform.get(options) -> verify { challengeId, credential }; the session comes back", async () => {
    const p = fakePlatform();
    const f = scriptApi();
    const res = await passkeySignIn();
    expect(res).toEqual(session);
    expect(p.get).toHaveBeenCalledWith(optionsBody.options, {});
    const verify = callsTo(f, "/auth/passkey/verify")[0];
    expect(verify?.method).toBe("POST");
    expect(verify?.body).toEqual({ challengeId: CH, credential });
    const options = callsTo(f, "/auth/passkey/options")[0];
    expect(options?.method).toBe("POST");
    expect(options?.body).toEqual({});
    // web: cookie session, nothing stored
    expect(res.tokens).toBeUndefined();
  });

  it("passes conditional + signal to the platform and a captcha token to the options call", async () => {
    const p = fakePlatform();
    const f = scriptApi();
    const ctrl = new AbortController();
    await passkeySignIn({ conditional: true, signal: ctrl.signal, captchaToken: "cf-token" });
    expect(p.get).toHaveBeenCalledWith(optionsBody.options, {
      conditional: true,
      signal: ctrl.signal,
    });
    expect(callsTo(f, "/auth/passkey/options")[0]?.body).toEqual({ captchaToken: "cf-token" });
  });

  it("a platform refusal (cancelled) stops before verify is called", async () => {
    const { PasskeyError } = await import("../platform/passkeys");
    fakePlatform({
      get: vi.fn(async () => {
        throw new PasskeyError("cancelled");
      }),
    });
    const f = scriptApi();
    await expect(passkeySignIn()).rejects.toMatchObject({ code: "cancelled" });
    expect(callsTo(f, "/auth/passkey/verify")).toHaveLength(0);
  });

  it("surfaces the API's errors as ApiError (passkey_failed 401, captcha_required 403, rate_limited 429)", async () => {
    fakePlatform();
    scriptApi({ path: "/auth/passkey/verify", status: 401, error: "passkey_failed" });
    const err = await passkeySignIn().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("passkey_failed");
    vi.unstubAllGlobals();
    const p = fakePlatform();
    scriptApi({ path: "/auth/passkey/options", status: 403, error: "captcha_required" });
    await expect(passkeySignIn()).rejects.toMatchObject({ code: "captcha_required" });
    expect(p.get).not.toHaveBeenCalled();
  });

  it("native: the returned tokens are kept in the token store", async () => {
    setNativePlatform("ios");
    const store = memoryTokenStore();
    setTokenStore(store);
    fakePlatform();
    stubFetch((c) => {
      const path = new URL(c.url, "http://localhost").pathname.replace(/^\/api/, "");
      if (path === "/auth/passkey/options") return jsonResponse(optionsBody);
      if (path === "/auth/passkey/verify") {
        return jsonResponse({
          ...session,
          tokens: { accessToken: "AT", refreshToken: "RT", expiresIn: 3600 },
        });
      }
      return jsonResponse({}, 404);
    });
    const res = await passkeySignIn();
    expect(res.tokens?.accessToken).toBe("AT");
    expect(store.value).toEqual({ accessToken: "AT", refreshToken: "RT" });
  });
});

describe("management calls", () => {
  it("listPasskeys GETs /me/passkeys", async () => {
    scriptApi();
    expect(await listPasskeys()).toEqual({ passkeys: [passkey], max: 5 });
  });

  it("registerPasskey: options -> platform.create -> POST /me/passkeys with the trimmed name (omitted when blank)", async () => {
    const p = fakePlatform();
    const f = scriptApi();
    const created = await registerPasskey("  My iPhone  ");
    expect(created).toEqual(passkey);
    expect(p.create).toHaveBeenCalledWith(optionsBody.options);
    const post = callsTo(f, "/me/passkeys").find((c) => c.method === "POST");
    expect(post?.body).toEqual({ challengeId: CH, credential, name: "My iPhone" });
    await registerPasskey("   ");
    const posts = callsTo(f, "/me/passkeys").filter((c) => c.method === "POST");
    expect(posts[1]?.body).toEqual({ challengeId: CH, credential });
    await registerPasskey();
    expect(callsTo(f, "/me/passkeys").filter((c) => c.method === "POST")[2]?.body).toEqual({
      challengeId: CH,
      credential,
    });
  });

  it("registerPasskey surfaces passkey_limit with its details and never calls the platform when options fail", async () => {
    const p = fakePlatform();
    scriptApi({ path: "/me/passkeys/options", status: 409, error: "passkey_limit" });
    const err = await registerPasskey().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "passkey_limit", details: { max: 5 } });
    expect(p.create).not.toHaveBeenCalled();
  });

  it("renamePasskey PATCHes the trimmed name; removePasskey DELETEs", async () => {
    const f = scriptApi();
    expect((await renamePasskey(PK, " Laptop ")).name).toBe("Laptop");
    expect(callsTo(f, `/me/passkeys/${PK}`)[0]).toMatchObject({
      method: "PATCH",
      body: { name: "Laptop" },
    });
    await removePasskey(PK);
    expect(callsTo(f, `/me/passkeys/${PK}`)[1]?.method).toBe("DELETE");
  });

  it("removePasskey surfaces fresh_sign_in_required for the gate to handle", async () => {
    scriptApi({ path: `/me/passkeys/${PK}`, status: 403, error: "fresh_sign_in_required" });
    await expect(removePasskey(PK)).rejects.toMatchObject({ code: "fresh_sign_in_required" });
  });
});

describe("usePasskeySupport", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={newQueryClient()}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("server flag off: enabled false without probing the platform", async () => {
    const p = fakePlatform();
    stubFetch(() => jsonResponse(config(false)));
    const { result } = renderHook(() => usePasskeySupport(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(p.supported).not.toHaveBeenCalled();
    expect(result.current.conditionalUi).toBe(false);
  });

  it("server flag on + platform supported: enabled true; conditional UI only when the platform offers it", async () => {
    fakePlatform({ conditionalUiSupported: vi.fn(async () => false) });
    stubFetch(() => jsonResponse(config(true)));
    const { result } = renderHook(() => usePasskeySupport(), { wrapper });
    expect(result.current.enabled).toBeUndefined();
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(result.current.conditionalUi).toBe(false);
  });

  it("server flag on + unsupported browser: enabled false (nothing passkey-related renders)", async () => {
    fakePlatform({
      supported: vi.fn(async () => false),
      conditionalUiSupported: vi.fn(async () => true),
    });
    stubFetch(() => jsonResponse(config(true)));
    const { result } = renderHook(() => usePasskeySupport(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(result.current.conditionalUi).toBe(false);
  });

  it("a probe that throws is treated as unsupported", async () => {
    fakePlatform({
      supported: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    stubFetch(() => jsonResponse(config(true)));
    const { result } = renderHook(() => usePasskeySupport(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(false));
  });
});

describe("a failed passkey sign-in is a form error, not a lost session", () => {
  it("401 passkey_failed on /auth/passkey/verify never fires onSignedOut (the fresh-sign-in gate would otherwise sign the user out)", async () => {
    const { onSignedOut } = await import("./api");
    const signedOut = vi.fn();
    const off = onSignedOut(signedOut);
    try {
      fakePlatform();
      scriptApi({ path: "/auth/passkey/verify", status: 401, error: "passkey_failed" });
      await expect(passkeySignIn()).rejects.toMatchObject({ code: "passkey_failed" });
      expect(signedOut).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});
