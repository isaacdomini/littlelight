import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../testing/native";
import {
  isPasskeyError,
  PasskeyError,
  type PasskeyPlatform,
  passkeyPlatform,
  setPasskeyPlatform,
  webPasskeys,
} from "./passkeys";

// The WebAuthn seam (docs/plans/step-13.md 2.5): the JSON-form API only (no polyfill), feature
// hidden when it is absent, browser errors reduced to our codes with no message, and the platform
// chosen by runtime (plugin in the app, WebAuthn on the web) with a test override.

interface FakeStatics {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  isConditionalMediationAvailable?: () => Promise<boolean>;
  parseCreationOptionsFromJSON?: (json: unknown) => unknown;
  parseRequestOptionsFromJSON?: (json: unknown) => unknown;
}

const credentialJson = {
  id: "AQIDBA",
  rawId: "AQIDBA",
  type: "public-key" as const,
  response: { clientDataJSON: "e30", authenticatorData: "AAAA", signature: "BBBB" },
  clientExtensionResults: {},
};

const credentials = { create: vi.fn(), get: vi.fn() };

function install(statics: FakeStatics | null) {
  const g = globalThis as { PublicKeyCredential?: unknown };
  if (statics === null) {
    delete g.PublicKeyCredential;
    return;
  }
  // a constructor-like object carrying the statics, as browsers expose it
  const ctor = function PublicKeyCredential() {} as unknown as FakeStatics;
  Object.assign(ctor, statics);
  g.PublicKeyCredential = ctor;
}

const fullSupport = (): FakeStatics => ({
  isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
  isConditionalMediationAvailable: async () => true,
  parseCreationOptionsFromJSON: (j) => ({ parsedCreate: j }),
  parseRequestOptionsFromJSON: (j) => ({ parsedGet: j }),
});

beforeEach(() => {
  credentials.create.mockReset().mockResolvedValue({ toJSON: () => credentialJson });
  credentials.get.mockReset().mockResolvedValue({ toJSON: () => credentialJson });
  Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });
  install(fullSupport());
});
afterEach(() => {
  install(null);
  setPasskeyPlatform(null);
  setNativePlatform(null);
});

describe("webPasskeys.supported / conditionalUiSupported", () => {
  it("true only with the JSON API and a user-verifying platform authenticator", async () => {
    expect(await webPasskeys.supported()).toBe(true);
    expect(await webPasskeys.conditionalUiSupported()).toBe(true);
  });

  it("false without PublicKeyCredential at all", async () => {
    install(null);
    expect(await webPasskeys.supported()).toBe(false);
    expect(await webPasskeys.conditionalUiSupported()).toBe(false);
  });

  it("false when the JSON helpers are missing (older browsers): the feature hides instead of polyfilling", async () => {
    install({ ...fullSupport(), parseRequestOptionsFromJSON: undefined });
    expect(await webPasskeys.supported()).toBe(false);
    install({ ...fullSupport(), parseCreationOptionsFromJSON: undefined });
    expect(await webPasskeys.supported()).toBe(false);
    expect(await webPasskeys.conditionalUiSupported()).toBe(false);
  });

  it("false when no user-verifying platform authenticator is available, or the probe throws", async () => {
    install({ ...fullSupport(), isUserVerifyingPlatformAuthenticatorAvailable: async () => false });
    expect(await webPasskeys.supported()).toBe(false);
    install({ ...fullSupport(), isUserVerifyingPlatformAuthenticatorAvailable: undefined });
    expect(await webPasskeys.supported()).toBe(false);
    install({
      ...fullSupport(),
      isUserVerifyingPlatformAuthenticatorAvailable: async () => {
        throw new Error("x");
      },
    });
    expect(await webPasskeys.supported()).toBe(false);
  });

  it("conditional UI is false when isConditionalMediationAvailable is absent, false or throws", async () => {
    install({ ...fullSupport(), isConditionalMediationAvailable: undefined });
    expect(await webPasskeys.conditionalUiSupported()).toBe(false);
    install({ ...fullSupport(), isConditionalMediationAvailable: async () => false });
    expect(await webPasskeys.conditionalUiSupported()).toBe(false);
    install({
      ...fullSupport(),
      isConditionalMediationAvailable: async () => {
        throw new Error("x");
      },
    });
    expect(await webPasskeys.conditionalUiSupported()).toBe(false);
  });

  it("false when navigator.credentials is missing", async () => {
    Object.defineProperty(navigator, "credentials", { value: undefined, configurable: true });
    expect(await webPasskeys.supported()).toBe(false);
  });
});

describe("webPasskeys.create / get", () => {
  it("create: parses the options from JSON, calls navigator.credentials.create and returns toJSON()", async () => {
    const out = await webPasskeys.create({ challenge: "abc", rp: { id: "localhost" } });
    expect(out).toEqual(credentialJson);
    expect(credentials.create).toHaveBeenCalledWith({
      publicKey: { parsedCreate: { challenge: "abc", rp: { id: "localhost" } } },
    });
  });

  it("get: default mediation, no signal; conditional adds mediation 'conditional' and the signal", async () => {
    await webPasskeys.get({ challenge: "abc" });
    expect(credentials.get).toHaveBeenLastCalledWith({
      publicKey: { parsedGet: { challenge: "abc" } },
    });
    const ctrl = new AbortController();
    await webPasskeys.get({ challenge: "abc" }, { conditional: true, signal: ctrl.signal });
    expect(credentials.get).toHaveBeenLastCalledWith({
      publicKey: { parsedGet: { challenge: "abc" } },
      mediation: "conditional",
      signal: ctrl.signal,
    });
  });

  it("without the JSON API both ceremonies fail with `unsupported`", async () => {
    install({ ...fullSupport(), parseCreationOptionsFromJSON: undefined });
    await expect(webPasskeys.create({})).rejects.toMatchObject({ code: "unsupported" });
    await expect(webPasskeys.get({})).rejects.toMatchObject({ code: "unsupported" });
    expect(credentials.create).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it.each([
    ["NotAllowedError", "cancelled"],
    ["AbortError", "cancelled"],
    ["NotSupportedError", "not_available"],
    ["SecurityError", "failed"],
    ["InvalidStateError", "failed"],
  ])("maps DOMException %s to %s and drops the browser's message", async (name, code) => {
    credentials.get.mockRejectedValueOnce(new DOMException("browser detail about the user", name));
    const err = await webPasskeys.get({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasskeyError);
    expect((err as PasskeyError).code).toBe(code);
    expect((err as Error).message).not.toContain("browser detail");
    expect(isPasskeyError(err, code as "failed")).toBe(true);
  });

  it("non-DOMException failures, a null credential and a credential without toJSON are `failed`", async () => {
    credentials.create.mockRejectedValueOnce(new Error("boom"));
    await expect(webPasskeys.create({})).rejects.toMatchObject({ code: "failed" });
    credentials.create.mockResolvedValueOnce(null);
    await expect(webPasskeys.create({})).rejects.toMatchObject({ code: "failed" });
    credentials.get.mockResolvedValueOnce({ id: "x" });
    await expect(webPasskeys.get({})).rejects.toMatchObject({ code: "failed" });
  });

  it("a parse failure of the options is `failed`, not a thrown browser error", async () => {
    install({
      ...fullSupport(),
      parseRequestOptionsFromJSON: () => {
        throw new TypeError("bad options");
      },
    });
    const err = await webPasskeys.get({}).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "failed" });
    expect((err as Error).message).not.toContain("bad options");
  });
});

describe("passkeyPlatform selection", () => {
  it("is the web implementation on the web", () => {
    expect(passkeyPlatform()).toBe(webPasskeys);
  });

  it("is a lazy native wrapper in the app (conditional UI never offered there)", async () => {
    setNativePlatform("ios");
    const p = passkeyPlatform();
    expect(p).not.toBe(webPasskeys);
    expect(await p.conditionalUiSupported()).toBe(false);
  });

  it("setPasskeyPlatform overrides both runtimes until reset", () => {
    const fake: PasskeyPlatform = {
      supported: async () => true,
      conditionalUiSupported: async () => false,
      create: async () => credentialJson,
      get: async () => credentialJson,
    };
    setPasskeyPlatform(fake);
    expect(passkeyPlatform()).toBe(fake);
    setNativePlatform("android");
    expect(passkeyPlatform()).toBe(fake);
    setPasskeyPlatform(null);
    expect(passkeyPlatform()).not.toBe(fake);
  });

  it("isPasskeyError distinguishes codes and rejects other errors", () => {
    const e = new PasskeyError("cancelled");
    expect(isPasskeyError(e)).toBe(true);
    expect(isPasskeyError(e, "cancelled")).toBe(true);
    expect(isPasskeyError(e, "failed")).toBe(false);
    expect(isPasskeyError(new Error("cancelled"))).toBe(false);
    expect(e.message).toBe("passkey cancelled");
  });
});
