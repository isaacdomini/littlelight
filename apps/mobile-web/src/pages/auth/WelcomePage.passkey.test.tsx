import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { PASSKEY_FAILED_MESSAGE } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasskeyError, type PasskeyPlatform, setPasskeyPlatform } from "../../platform/passkeys";
import { jsonResponse, setNativePlatform, stubFetch } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Sign-in screen with passkeys (docs/plans/step-13.md 2.5): the secondary button appears only
// when the server flag is on AND this browser can do passkeys; the email code stays primary and
// visible through every failure; autofill (conditional UI) starts silently and is cancelled when
// the user acts otherwise; native `not_configured` hides the button without a message.

const config = vi.hoisted(() => ({
  data: {
    providers: { apple: false, google: false },
    turnstileSiteKey: null as string | null,
    termsVersion: "2026-01",
    privacyVersion: "2026-01",
    passkeys: true,
  },
}));
vi.mock("../../lib/queries/account", async () => {
  const actual = await vi.importActual<typeof import("../../lib/queries/account")>(
    "../../lib/queries/account",
  );
  return { ...actual, useAuthConfig: () => ({ data: config.data, isPending: false }) };
});
const authApi = vi.hoisted(() => ({ requestCode: vi.fn(async () => undefined) }));
vi.mock("../../lib/authApi", () => authApi);

import { WelcomePage } from "./WelcomePage";

const CH = "7e1d2c3b-4a5f-4e6d-8c7b-0a1b2c3d4e5f";
const credential = {
  id: "AQIDBA",
  rawId: "AQIDBA",
  type: "public-key" as const,
  response: { clientDataJSON: "e30", authenticatorData: "AAAA", signature: "BBBB" },
  clientExtensionResults: {},
};
const session = {
  user: { id: "11111111-1111-4111-8111-111111111111", email: "p@example.com" },
  session: {
    createdAt: "2026-10-11T12:00:00.000Z",
    expiresAt: "2026-10-11T13:00:00.000Z",
    isFresh: true,
  },
};

function platform(over: Partial<PasskeyPlatform> = {}) {
  const p = {
    supported: vi.fn(async () => true),
    conditionalUiSupported: vi.fn(async () => false),
    create: vi.fn(async () => credential),
    get: vi.fn(async () => credential),
    ...over,
  };
  setPasskeyPlatform(p as PasskeyPlatform);
  return p;
}

function api(
  verify: { status: number; body: unknown } = { status: 200, body: session },
  options?: { status: number; body: unknown },
) {
  return stubFetch((c) => {
    const path = new URL(c.url, "http://localhost").pathname.replace(/^\/api/, "");
    if (path === "/auth/passkey/options") {
      if (options) return jsonResponse(options.body, options.status);
      return jsonResponse({
        challengeId: CH,
        options: { challenge: "x" },
        expiresAt: "2026-10-11T12:05:00.000Z",
      });
    }
    if (path === "/auth/passkey/verify") return jsonResponse(verify.body, verify.status);
    return jsonResponse({ error: "not_found", message: "nope" }, 404);
  });
}

beforeEach(() => {
  config.data = { ...config.data, passkeys: true, providers: { apple: false, google: false } };
  authApi.requestCode.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  setPasskeyPlatform(null);
  setNativePlatform(null);
  vi.unstubAllGlobals();
});

async function render() {
  const r = renderApp(<WelcomePage />, { route: "/welcome" });
  await ionReady(r.container);
  return r;
}
const button = () => screen.queryByTestId("welcome-passkey");
const emailInput = () => screen.getByTestId("welcome-email") as HTMLInputElement;
const settle = () => new Promise((r) => setTimeout(r, 40));

describe("WelcomePage passkey button visibility", () => {
  it("shows the button and the webauthn autocomplete when the flag is on and the browser supports passkeys", async () => {
    platform();
    api();
    await render();
    await waitFor(() => expect(button()).toBeTruthy());
    expect(button()?.textContent).toBe("Sign in with a passkey");
    expect(emailInput().getAttribute("autocomplete")).toBe("username webauthn");
    // the email code stays primary
    expect(screen.getByTestId("welcome-continue")).toBeTruthy();
  });

  it("hides it when the server flag is off (platform never probed) and uses the plain email autocomplete", async () => {
    config.data = { ...config.data, passkeys: false };
    const p = platform();
    api();
    await render();
    await settle();
    expect(button()).toBeNull();
    expect(p.supported).not.toHaveBeenCalled();
    expect(emailInput().getAttribute("autocomplete")).toBe("email");
  });

  it("hides it on an unsupported browser", async () => {
    platform({ supported: vi.fn(async () => false) });
    api();
    await render();
    await settle();
    expect(button()).toBeNull();
    expect(emailInput().getAttribute("autocomplete")).toBe("email");
  });

  it("renders the button in the native app too (plugin says available)", async () => {
    setNativePlatform("ios");
    platform();
    api();
    await render();
    await waitFor(() => expect(button()).toBeTruthy());
  });
});

describe("WelcomePage passkey sign-in", () => {
  it("button: options -> platform.get -> verify; no error shown", async () => {
    const p = platform();
    const f = api();
    await render();
    await waitFor(() => expect(button()).toBeTruthy());
    fireEvent.click(button() as HTMLElement);
    await waitFor(() =>
      expect(f.calls.some((c) => c.url.endsWith("/auth/passkey/verify"))).toBe(true),
    );
    expect(p.get).toHaveBeenCalledWith({ challenge: "x" }, {});
    const verify = f.calls.find((c) => c.url.endsWith("/auth/passkey/verify"));
    expect(verify?.body).toEqual({ challengeId: CH, credential });
    await settle();
    expect(screen.queryByTestId("welcome-error")).toBeNull();
    // the ceremony never put the credential or challenge anywhere persistent
    expect(JSON.stringify(window.localStorage)).not.toContain(CH);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(CH);
  });

  it("401 passkey_failed shows the one generic line and keeps the email form usable", async () => {
    platform();
    api({ status: 401, body: { error: "passkey_failed", message: PASSKEY_FAILED_MESSAGE } });
    await render();
    await waitFor(() => expect(button()).toBeTruthy());
    fireEvent.click(button() as HTMLElement);
    await waitFor(() =>
      expect(screen.getByTestId("welcome-error").textContent).toBe(PASSKEY_FAILED_MESSAGE),
    );
    expect(screen.getByTestId("welcome-email")).toBeTruthy();
    expect(screen.getByTestId("welcome-continue")).toBeTruthy();
    expect(button()).toBeTruthy();
  });

  it("a server-side passkey_disabled (flag flipped since config loaded) reads like a failure, not a crash", async () => {
    platform();
    api(session as never, { status: 404, body: { error: "passkey_disabled", message: "off" } });
    await render();
    await waitFor(() => expect(button()).toBeTruthy());
    fireEvent.click(button() as HTMLElement);
    await waitFor(() =>
      expect(screen.getByTestId("welcome-error").textContent).toBe(PASSKEY_FAILED_MESSAGE),
    );
  });

  it("a cancelled ceremony shows the cancel line; a rate limit shows the server's message", async () => {
    platform({
      get: vi.fn(async () => {
        throw new PasskeyError("cancelled");
      }),
    });
    api();
    await render();
    await waitFor(() => expect(button()).toBeTruthy());
    fireEvent.click(button() as HTMLElement);
    await waitFor(() =>
      expect(screen.getByTestId("welcome-error").textContent).toBe(
        "Passkey sign-in was cancelled. You can try again or use your email code.",
      ),
    );
  });

  it("captcha_required on options asks for the captcha (the OTP path's message) and never calls the platform", async () => {
    const p = platform();
    api(session as never, {
      status: 403,
      body: { error: "captcha_required", message: "Please complete the verification" },
    });
    await render();
    await waitFor(() => expect(button()).toBeTruthy());
    fireEvent.click(button() as HTMLElement);
    await waitFor(() =>
      expect(screen.getByTestId("welcome-error").textContent).toBe(
        "Please confirm you're not a robot.",
      ),
    );
    expect(p.get).not.toHaveBeenCalled();
  });

  it("native not_configured hides the button with no message; the email code remains", async () => {
    setNativePlatform("android");
    platform({
      get: vi.fn(async () => {
        throw new PasskeyError("not_configured");
      }),
    });
    api();
    await render();
    await waitFor(() => expect(button()).toBeTruthy());
    fireEvent.click(button() as HTMLElement);
    await waitFor(() => expect(button()).toBeNull());
    expect(screen.queryByTestId("welcome-error")).toBeNull();
    expect(screen.getByTestId("welcome-continue")).toBeTruthy();
  });
});

describe("WelcomePage conditional UI (autofill)", () => {
  it("starts one silent conditional request on mount when the platform offers it, and aborts it when the email is submitted", async () => {
    let signal: AbortSignal | undefined;
    const p = platform({
      conditionalUiSupported: vi.fn(async () => true),
      get: vi.fn(async (_o: unknown, opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return new Promise<never>((_r, reject) => {
          signal?.addEventListener("abort", () => reject(new PasskeyError("cancelled")));
        });
      }),
    });
    api();
    await render();
    await waitFor(() => expect(p.get).toHaveBeenCalledTimes(1));
    expect(vi.mocked(p.get).mock.calls[0]?.[1]).toMatchObject({ conditional: true });
    expect(signal?.aborted).toBe(false);
    fireEvent.change(emailInput(), { target: { value: "p@example.com" } });
    fireEvent.click(screen.getByTestId("welcome-continue"));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() =>
      expect(authApi.requestCode).toHaveBeenCalledWith("p@example.com", undefined),
    );
    // the abort never surfaces as an error
    expect(screen.queryByTestId("welcome-error")).toBeNull();
  });

  it("a failing options call on the conditional path (401 / 429 / captcha) stays silent: no error, no platform prompt", async () => {
    for (const [status, error] of [
      [401, "passkey_failed"],
      [429, "rate_limited"],
      [403, "captcha_required"],
    ] as const) {
      const p = platform({ conditionalUiSupported: vi.fn(async () => true) });
      api(session as never, { status, body: { error, message: "m" } });
      await render();
      await waitFor(() => expect(button()).toBeTruthy());
      await settle();
      expect(p.get).not.toHaveBeenCalled();
      expect(screen.queryByTestId("welcome-error")).toBeNull();
      cleanup();
      setPasskeyPlatform(null);
      vi.unstubAllGlobals();
    }
  });

  it("does not start a conditional request when the platform has no autofill", async () => {
    const p = platform({ conditionalUiSupported: vi.fn(async () => false) });
    api();
    await render();
    await waitFor(() => expect(button()).toBeTruthy());
    await settle();
    expect(p.get).not.toHaveBeenCalled();
  });

  it("the explicit button cancels the pending autofill request before its own ceremony", async () => {
    const signals: AbortSignal[] = [];
    const p = platform({
      conditionalUiSupported: vi.fn(async () => true),
      get: vi.fn(async (_o: unknown, opts?: { signal?: AbortSignal; conditional?: boolean }) => {
        if (opts?.conditional) {
          if (opts.signal) signals.push(opts.signal);
          return new Promise<never>((_r, reject) => {
            opts.signal?.addEventListener("abort", () => reject(new PasskeyError("cancelled")));
          });
        }
        return credential;
      }),
    });
    const f = api();
    await render();
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.click(button() as HTMLElement);
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await waitFor(() =>
      expect(f.calls.some((c) => c.url.endsWith("/auth/passkey/verify"))).toBe(true),
    );
    expect(p.get).toHaveBeenCalledTimes(2);
  });
});
