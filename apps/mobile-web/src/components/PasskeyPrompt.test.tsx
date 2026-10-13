import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { PASSKEY_PROMPT_KEY } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offerPasskeyPrompt, passkeyPromptOffered } from "../lib/passkeyPrompt";
import { PasskeyError, type PasskeyPlatform, setPasskeyPlatform } from "../platform/passkeys";
import { jsonResponse, stubFetch } from "../testing/native";
import { ionReady, renderApp } from "../testing/render";

// The one-time enrol card (docs/plans/step-13.md Q2, 2.5): after an email-code sign-in, in the
// app, when passkeys are on + supported and the account has none; "Not now" snoozes 30 days; a
// successful add never shows it again; off/unsupported renders nothing.

const auth = vi.hoisted(() => ({ me: { user: { id: "u1", email: "p@example.com" } } as unknown }));
const gate = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ me: auth.me }),
  ME_KEY: ["me"],
}));
vi.mock("../auth/onboarding", () => ({ onboardingGate: () => gate.value }));
vi.mock("@ionic/react", async () => {
  const actual = await vi.importActual<typeof import("@ionic/react")>("@ionic/react");
  const m = await import("../testing/ionMocks");
  return { ...actual, IonModal: m.FakeModal };
});

import { PasskeyPrompt } from "./PasskeyPrompt";

const PK = "3f2c1b0a-1234-4abc-8def-0123456789ab";
const CH = "7e1d2c3b-4a5f-4e6d-8c7b-0a1b2c3d4e5f";
const credential = {
  id: "AQIDBA",
  rawId: "AQIDBA",
  type: "public-key" as const,
  response: { clientDataJSON: "e30", attestationObject: "o2M" },
  clientExtensionResults: {},
};
const state = { passkeysOn: true, list: [] as unknown[] };

function api() {
  return stubFetch((c) => {
    const path = new URL(c.url, "http://localhost").pathname.replace(/^\/api/, "");
    if (path === "/auth/config") {
      return jsonResponse({
        providers: { apple: false, google: false },
        turnstileSiteKey: null,
        termsVersion: "2026-01",
        privacyVersion: "2026-01",
        passkeys: state.passkeysOn,
      });
    }
    if (path === "/me/passkeys" && c.method === "GET")
      return jsonResponse({ passkeys: state.list, max: 5 });
    if (path === "/me/passkeys/options") {
      return jsonResponse({
        challengeId: CH,
        options: { challenge: "x" },
        expiresAt: "2026-10-11T12:05:00.000Z",
      });
    }
    if (path === "/me/passkeys" && c.method === "POST") {
      return jsonResponse(
        { id: PK, name: "Passkey", createdAt: "2026-10-11T12:00:00.000Z", lastUsedAt: null },
        201,
      );
    }
    return jsonResponse({ error: "not_found", message: "nope" }, 404);
  });
}

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

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  state.passkeysOn = true;
  state.list = [];
  gate.value = null;
  offerPasskeyPrompt();
});
afterEach(() => {
  cleanup();
  setPasskeyPlatform(null);
  vi.unstubAllGlobals();
});

const shown = () => screen.queryByTestId("passkey-prompt-add");
const settle = () => new Promise((r) => setTimeout(r, 40));

async function render(route = "/timeline") {
  const r = renderApp(<PasskeyPrompt />, { route });
  await ionReady(r.container);
  return r;
}

describe("PasskeyPrompt eligibility", () => {
  it("shows once after an email-code sign-in, in the app, with no passkeys yet", async () => {
    platform();
    api();
    await render();
    await waitFor(() => expect(shown()).toBeTruthy());
    expect(screen.getByTestId("passkey-prompt-later")).toBeTruthy();
    expect(screen.getByText("Sign in faster next time")).toBeTruthy();
  });

  it("is not shown without the offer marker (no email-code sign-in this session)", async () => {
    window.sessionStorage.clear();
    platform();
    const f = api();
    await render();
    await settle();
    expect(shown()).toBeNull();
    // and the passkey list is never even fetched
    expect(f.calls.some((c) => c.url.endsWith("/me/passkeys"))).toBe(false);
  });

  it("is not shown when the server has passkeys off, and the platform is never probed", async () => {
    state.passkeysOn = false;
    const p = platform();
    api();
    await render();
    await settle();
    expect(shown()).toBeNull();
    expect(p.supported).not.toHaveBeenCalled();
  });

  it("is not shown on an unsupported browser", async () => {
    platform({ supported: vi.fn(async () => false) });
    api();
    await render();
    await settle();
    expect(shown()).toBeNull();
  });

  it("is not shown when the account already has a passkey (and the offer is consumed)", async () => {
    state.list = [
      { id: PK, name: "Laptop", createdAt: "2026-10-11T12:00:00.000Z", lastUsedAt: null },
    ];
    platform();
    api();
    await render();
    await waitFor(() => expect(passkeyPromptOffered()).toBe(false));
    expect(shown()).toBeNull();
  });

  it("is not shown while snoozed", async () => {
    window.localStorage.setItem(
      PASSKEY_PROMPT_KEY,
      JSON.stringify({ snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() }),
    );
    platform();
    api();
    await render();
    await waitFor(() => expect(passkeyPromptOffered()).toBe(false));
    expect(shown()).toBeNull();
  });

  it("waits for the user to be inside the app (not on an onboarding or auth route)", async () => {
    platform();
    api();
    await render("/onboarding/baby");
    await settle();
    expect(shown()).toBeNull();
    cleanup();
    gate.value = "/onboarding/profile";
    await render("/timeline");
    await settle();
    expect(shown()).toBeNull();
  });
});

describe("PasskeyPrompt actions", () => {
  it("'Not now' closes the card, consumes the offer and snoozes 30 days", async () => {
    platform();
    api();
    await render();
    await waitFor(() => expect(shown()).toBeTruthy());
    fireEvent.click(screen.getByTestId("passkey-prompt-later"));
    await waitFor(() => expect(shown()).toBeNull());
    expect(passkeyPromptOffered()).toBe(false);
    await waitFor(() => expect(window.localStorage.getItem(PASSKEY_PROMPT_KEY)).toBeTruthy());
    const rec = JSON.parse(window.localStorage.getItem(PASSKEY_PROMPT_KEY) ?? "{}") as {
      snoozedUntil: string;
    };
    const days = (Date.parse(rec.snoozedUntil) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("'Add passkey' runs the registration ceremony, shows the added state and dismisses the card for good", async () => {
    const p = platform();
    const f = api();
    await render();
    await waitFor(() => expect(shown()).toBeTruthy());
    fireEvent.click(screen.getByTestId("passkey-prompt-add"));
    await waitFor(() => expect(screen.getByTestId("passkey-prompt-added")).toBeTruthy());
    expect(p.create).toHaveBeenCalledWith({ challenge: "x" });
    const post = f.calls.find((c) => c.url.endsWith("/me/passkeys") && c.method === "POST");
    expect(post?.body).toEqual({ challengeId: CH, credential });
    const rec = JSON.parse(window.localStorage.getItem(PASSKEY_PROMPT_KEY) ?? "{}") as {
      snoozedUntil: string;
    };
    expect(Date.parse(rec.snoozedUntil) - Date.now()).toBeGreaterThan(10 * 365 * 86_400_000);
    // the body never carries a name the user did not type
    expect(JSON.stringify(post?.body)).not.toContain("name");
  });

  it("a cancelled ceremony keeps the card open with a safe message; the API is not called", async () => {
    platform({
      create: vi.fn(async () => {
        throw new PasskeyError("cancelled");
      }),
    });
    const f = api();
    await render();
    await waitFor(() => expect(shown()).toBeTruthy());
    fireEvent.click(screen.getByTestId("passkey-prompt-add"));
    await waitFor(() =>
      expect(screen.getByTestId("passkey-prompt-error").textContent).toBe(
        "Cancelled. Nothing was changed.",
      ),
    );
    expect(shown()).toBeTruthy();
    expect(f.calls.some((c) => c.url.endsWith("/me/passkeys") && c.method === "POST")).toBe(false);
    expect(window.localStorage.getItem(PASSKEY_PROMPT_KEY)).toBeNull();
  });

  it("an API refusal (passkey_limit) shows the limit message with the server's max", async () => {
    platform();
    stubFetch((c) => {
      const path = new URL(c.url, "http://localhost").pathname.replace(/^\/api/, "");
      if (path === "/auth/config") {
        return jsonResponse({
          providers: { apple: false, google: false },
          turnstileSiteKey: null,
          termsVersion: "a",
          privacyVersion: "b",
          passkeys: true,
        });
      }
      if (path === "/me/passkeys" && c.method === "GET")
        return jsonResponse({ passkeys: [], max: 5 });
      if (path === "/me/passkeys/options")
        return jsonResponse({ error: "passkey_limit", message: "m", details: { max: 5 } }, 409);
      return jsonResponse({}, 404);
    });
    await render();
    await waitFor(() => expect(shown()).toBeTruthy());
    fireEvent.click(screen.getByTestId("passkey-prompt-add"));
    await waitFor(() =>
      expect(screen.getByTestId("passkey-prompt-error").textContent).toBe(
        "You have the most passkeys allowed (5). Remove one before adding another.",
      ),
    );
  });

  it("native `not_configured` (RP not associated in this build) silently closes the card for the session", async () => {
    platform({
      create: vi.fn(async () => {
        throw new PasskeyError("not_configured");
      }),
    });
    api();
    await render();
    await waitFor(() => expect(shown()).toBeTruthy());
    fireEvent.click(screen.getByTestId("passkey-prompt-add"));
    await waitFor(() => expect(shown()).toBeNull());
    expect(screen.queryByTestId("passkey-prompt-error")).toBeNull();
    expect(passkeyPromptOffered()).toBe(false);
    // not a snooze: the card may be offered after a later sign-in once the build is associated
    expect(window.localStorage.getItem(PASSKEY_PROMPT_KEY)).toBeNull();
  });
});
