import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { PASSKEY_FAILED_MESSAGE } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { PasskeyError, type PasskeyPlatform, setPasskeyPlatform } from "../platform/passkeys";
import { jsonResponse, stubFetch } from "../testing/native";
import { ionReady, renderApp } from "../testing/render";

// The fresh-sign-in gate's passkey option (docs/plans/step-13.md Q5, 2.5): a passkey sign-in is
// user-verified and creates a new session, so the gate offers it next to the email code, but only
// when the account has a passkey and this device can use one. The email code stays available.

const auth = vi.hoisted(() => ({
  me: { user: { id: "u1", email: "p@example.com" } } as unknown,
  refetchMe: vi.fn(async () => null),
}));
vi.mock("./AuthProvider", () => ({
  useAuth: () => ({ me: auth.me, refetchMe: auth.refetchMe }),
  ME_KEY: ["me"],
}));
vi.mock("../components/CodeEntry", () => ({
  CodeEntry: ({ email }: { email: string }) => <div data-testid="code-entry">{email}</div>,
}));
vi.mock("@ionic/react", async () => {
  const actual = await vi.importActual<typeof import("@ionic/react")>("@ionic/react");
  const m = await import("../testing/ionMocks");
  return { ...actual, IonModal: m.FakeModal };
});

import { FreshSignInProvider, useFreshSignIn } from "./FreshSignInGate";

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
const state = {
  passkeysOn: true,
  list: [] as unknown[],
  verify: { status: 200, body: session as unknown },
};

function api() {
  return stubFetch((c) => {
    const path = new URL(c.url, "http://localhost").pathname.replace(/^\/api/, "");
    if (path === "/auth/config") {
      return jsonResponse({
        providers: { apple: false, google: false },
        turnstileSiteKey: null,
        termsVersion: "a",
        privacyVersion: "b",
        passkeys: state.passkeysOn,
      });
    }
    if (path === "/me/passkeys") return jsonResponse({ passkeys: state.list, max: 5 });
    if (path === "/auth/passkey/options")
      return jsonResponse({
        challengeId: CH,
        options: { challenge: "x" },
        expiresAt: "2026-10-11T12:05:00.000Z",
      });
    if (path === "/auth/passkey/verify")
      return jsonResponse(state.verify.body, state.verify.status);
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

/** A destructive action: fails with fresh_sign_in_required the first `stale` times, then succeeds. */
function Destructive({ stale, onDone }: { stale: number; onDone: (r: string) => void }) {
  const withFresh = useFreshSignIn();
  let left = stale;
  return (
    <button
      type="button"
      data-testid="do-it"
      onClick={() =>
        void withFresh(async () => {
          if (left > 0) {
            left -= 1;
            throw new ApiError(
              403,
              "fresh_sign_in_required",
              "Please verify your email again to continue",
            );
          }
          return "done";
        })
          .then((r) => onDone(String(r)))
          .catch((e: unknown) => onDone(`rejected:${(e as ApiError).code}`))
      }
    >
      go
    </button>
  );
}

beforeEach(() => {
  state.passkeysOn = true;
  state.list = [
    {
      id: "3f2c1b0a-1234-4abc-8def-0123456789ab",
      name: "Laptop",
      createdAt: "2026-10-01T00:00:00.000Z",
      lastUsedAt: null,
    },
  ];
  state.verify = { status: 200, body: session };
  auth.refetchMe.mockClear();
});
afterEach(() => {
  cleanup();
  setPasskeyPlatform(null);
  vi.unstubAllGlobals();
});

async function open(stale = 1) {
  const outcomes: string[] = [];
  const r = renderApp(
    <FreshSignInProvider>
      <Destructive stale={stale} onDone={(o) => outcomes.push(o)} />
    </FreshSignInProvider>,
    { route: "/settings" },
  );
  await ionReady(r.container);
  fireEvent.click(screen.getByTestId("do-it"));
  await waitFor(() => expect(screen.getByTestId("modal")).toBeTruthy());
  return { ...r, outcomes };
}

describe("FreshSignInGate passkey option", () => {
  it("offers 'Use a passkey instead' next to the email code when the account has a passkey and the device supports it", async () => {
    platform();
    api();
    await open();
    expect(screen.getByTestId("code-entry").textContent).toBe("p@example.com");
    await waitFor(() => expect(screen.getByTestId("fresh-gate-passkey")).toBeTruthy());
    expect(screen.getByTestId("fresh-gate-passkey").textContent).toBe("Use a passkey instead");
    expect(screen.getByTestId("fresh-gate-cancel")).toBeTruthy();
  });

  it("hides the option when the account has no passkey, when the feature is off, or on an unsupported device", async () => {
    state.list = [];
    platform();
    api();
    await open();
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId("fresh-gate-passkey")).toBeNull();
    expect(screen.getByTestId("code-entry")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    state.list = [
      { id: "x", name: "Laptop", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null },
    ];
    state.passkeysOn = false;
    const p = platform();
    const f = api();
    await open();
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId("fresh-gate-passkey")).toBeNull();
    expect(p.supported).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.url.endsWith("/me/passkeys"))).toBe(false);
    cleanup();
    vi.unstubAllGlobals();

    state.passkeysOn = true;
    platform({ supported: vi.fn(async () => false) });
    api();
    await open();
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId("fresh-gate-passkey")).toBeNull();
  });

  it("a passkey sign-in re-verifies: /me is refetched, the gate closes and the action is retried once", async () => {
    const p = platform();
    const f = api();
    const { outcomes } = await open(1);
    await waitFor(() => expect(screen.getByTestId("fresh-gate-passkey")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fresh-gate-passkey"));
    await waitFor(() => expect(outcomes).toEqual(["done"]));
    expect(p.get).toHaveBeenCalledTimes(1);
    expect(f.calls.some((c) => c.url.endsWith("/auth/passkey/verify"))).toBe(true);
    expect(auth.refetchMe).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("modal")).toBeNull());
  });

  it("a failed passkey (401 passkey_failed) shows the generic line and keeps the gate (and the email code) open", async () => {
    platform();
    state.verify = {
      status: 401,
      body: { error: "passkey_failed", message: PASSKEY_FAILED_MESSAGE },
    };
    api();
    const { outcomes } = await open(1);
    await waitFor(() => expect(screen.getByTestId("fresh-gate-passkey")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fresh-gate-passkey"));
    await waitFor(() =>
      expect(screen.getByTestId("fresh-gate-passkey-error").textContent).toBe(
        PASSKEY_FAILED_MESSAGE,
      ),
    );
    expect(screen.getByTestId("modal")).toBeTruthy();
    expect(screen.getByTestId("code-entry")).toBeTruthy();
    expect(outcomes).toEqual([]);
  });

  it("a cancelled ceremony shows nothing and keeps the gate open; Cancel rejects the action", async () => {
    platform({
      get: vi.fn(async () => {
        throw new PasskeyError("cancelled");
      }),
    });
    api();
    const { outcomes } = await open(1);
    await waitFor(() => expect(screen.getByTestId("fresh-gate-passkey")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fresh-gate-passkey"));
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId("fresh-gate-passkey-error")).toBeNull();
    expect(screen.getByTestId("modal")).toBeTruthy();
    fireEvent.click(screen.getByTestId("fresh-gate-cancel"));
    await waitFor(() => expect(outcomes).toEqual(["rejected:fresh_sign_in_required"]));
  });
});
