import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { PasskeyError, type PasskeyPlatform, setPasskeyPlatform } from "../../platform/passkeys";
import { jsonResponse, stubFetch } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Settings -> Passkeys (docs/plans/step-13.md 2.5, Q3, Q4): list states (empty / items / full),
// add with an optional name, inline rename, remove behind a confirm and the fresh-sign-in gate;
// the server's refusals are shown as its messages; unsupported browsers see one notice.

const fresh = vi.hoisted(() => ({
  mode: "pass" as "pass" | "cancel",
  calls: 0,
}));
vi.mock("../../auth/FreshSignInGate", () => ({
  useFreshSignIn: () => async (fn: () => Promise<unknown>) => {
    fresh.calls += 1;
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: string }).code === "fresh_sign_in_required") {
        if (fresh.mode === "cancel") throw e;
        return fn(); // the gate re-verified; retry once
      }
      throw e;
    }
  },
}));
vi.mock("@ionic/react", async () => {
  const actual = await vi.importActual<typeof import("@ionic/react")>("@ionic/react");
  const m = await import("../../testing/ionMocks");
  return { ...actual, IonAlert: m.FakeAlert, IonModal: m.FakeModal };
});

import { PasskeysPage } from "./PasskeysPage";

const PK1 = "3f2c1b0a-1234-4abc-8def-0123456789ab";
const PK2 = "7e1d2c3b-4a5f-4e6d-8c7b-0a1b2c3d4e5f";
const CH = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const credential = {
  id: "AQIDBA",
  rawId: "AQIDBA",
  type: "public-key" as const,
  response: { clientDataJSON: "e30", attestationObject: "o2M" },
  clientExtensionResults: {},
};
type Item = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
const item = (id: string, name: string, lastUsedAt: string | null = null): Item => ({
  id,
  name,
  createdAt: "2026-10-01T10:00:00.000Z",
  lastUsedAt,
});

const state = {
  passkeysOn: true,
  list: [] as Item[],
  /** the next DELETE answers 403 fresh_sign_in_required this many times */
  staleDeletes: 0,
  registerError: null as { status: number; body: unknown } | null,
};

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
      if (state.registerError)
        return jsonResponse(state.registerError.body, state.registerError.status);
      return jsonResponse({
        challengeId: CH,
        options: { challenge: "x" },
        expiresAt: "2026-10-11T12:05:00.000Z",
      });
    }
    if (path === "/me/passkeys" && c.method === "POST") {
      const body = c.body as { name?: string };
      const created = item(PK2, body.name ?? "Passkey");
      state.list = [created, ...state.list];
      return jsonResponse(created, 201);
    }
    const m = /^\/me\/passkeys\/([0-9a-f-]+)$/.exec(path);
    if (m && c.method === "PATCH") {
      const target = state.list.find((p) => p.id === m[1]);
      if (!target) return jsonResponse({ error: "not_found", message: "No such passkey" }, 404);
      target.name = (c.body as { name: string }).name;
      return jsonResponse(target);
    }
    if (m && c.method === "DELETE") {
      if (state.staleDeletes > 0) {
        state.staleDeletes -= 1;
        return jsonResponse(
          {
            error: "fresh_sign_in_required",
            message: "Please verify your email again to continue",
          },
          403,
        );
      }
      state.list = state.list.filter((p) => p.id !== m[1]);
      return jsonResponse(null, 204);
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
  state.passkeysOn = true;
  state.list = [];
  state.staleDeletes = 0;
  state.registerError = null;
  fresh.mode = "pass";
  fresh.calls = 0;
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  setPasskeyPlatform(null);
  vi.unstubAllGlobals();
});

async function render() {
  const r = renderApp(<PasskeysPage />, { route: "/settings/passkeys" });
  await ionReady(r.container);
  return r;
}
const names = () => screen.queryAllByTestId("passkey-name").map((e) => e.textContent);

describe("PasskeysPage states", () => {
  it("empty: the empty state and a primary 'Add a passkey' button; no count line", async () => {
    platform();
    api();
    await render();
    await waitFor(() => expect(screen.getByTestId("passkeys-empty")).toBeTruthy());
    expect(screen.getByTestId("passkeys-add")).toBeTruthy();
    expect(screen.queryByTestId("passkeys-list")).toBeNull();
    expect(screen.queryByTestId("passkeys-count")).toBeNull();
    expect(screen.queryByTestId("passkeys-full")).toBeNull();
  });

  it("list: name, created, last used (or 'Not used yet'), the count line and a secondary add button", async () => {
    state.list = [item(PK1, "Laptop", "2026-10-11T08:00:00.000Z"), item(PK2, "Phone")];
    platform();
    api();
    await render();
    await waitFor(() => expect(screen.getByTestId("passkeys-list")).toBeTruthy());
    expect(names()).toEqual(["Laptop", "Phone"]);
    const lastUsed = screen.getAllByTestId("passkey-last-used").map((e) => e.textContent);
    expect(lastUsed[0]).toMatch(/^Last used /);
    expect(lastUsed[1]).toBe("Not used yet");
    expect(screen.getByTestId("passkeys-count").textContent).toBe("2 of 5 passkeys");
    expect(screen.getByTestId("passkeys-add")).toBeTruthy();
    expect(screen.queryByTestId("passkeys-empty")).toBeNull();
    // never shows ids or credential material
    expect(screen.getByTestId("passkeys").textContent).not.toContain(PK1);
  });

  it("full (5 of 5): the limit notice replaces the add button", async () => {
    state.list = Array.from({ length: 5 }, (_, i) =>
      item(`${i}f2c1b0a-1234-4abc-8def-0123456789ab`, `Key ${i}`),
    );
    platform();
    api();
    await render();
    await waitFor(() => expect(screen.getByTestId("passkeys-full")).toBeTruthy());
    expect(screen.getByTestId("passkeys-full").textContent).toBe(
      "You have the most passkeys allowed (5). Remove one before adding another.",
    );
    expect(screen.queryByTestId("passkeys-add")).toBeNull();
    expect(screen.getByTestId("passkeys-count").textContent).toBe("5 of 5 passkeys");
  });

  it("unsupported browser or feature off: one notice, no list fetched", async () => {
    platform({ supported: vi.fn(async () => false) });
    const f = api();
    await render();
    await waitFor(() => expect(screen.getByTestId("passkeys-unavailable")).toBeTruthy());
    expect(screen.queryByTestId("passkeys")).toBeNull();
    expect(f.calls.some((c) => c.url.endsWith("/me/passkeys"))).toBe(false);
    cleanup();
    vi.unstubAllGlobals();
    state.passkeysOn = false;
    const p = platform();
    const f2 = api();
    await render();
    await waitFor(() => expect(screen.getByTestId("passkeys-unavailable")).toBeTruthy());
    expect(p.supported).not.toHaveBeenCalled();
    expect(f2.calls.some((c) => c.url.endsWith("/me/passkeys"))).toBe(false);
  });
});

describe("PasskeysPage add", () => {
  it("opens the name form, runs the ceremony with the trimmed name and shows the new passkey first", async () => {
    state.list = [item(PK1, "Laptop")];
    const p = platform();
    const f = api();
    await render();
    await waitFor(() => expect(screen.getByTestId("passkeys-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("passkeys-add"));
    const input = screen.getByTestId("passkey-name-input") as HTMLInputElement;
    expect(input.placeholder).toBe("Passkey");
    expect(input.maxLength).toBe(60);
    fireEvent.change(input, { target: { value: "  My iPhone  " } });
    fireEvent.click(screen.getByTestId("passkey-create"));
    await waitFor(() => expect(names()).toEqual(["My iPhone", "Laptop"]));
    expect(p.create).toHaveBeenCalledWith({ challenge: "x" });
    const post = f.calls.find((c) => c.url.endsWith("/me/passkeys") && c.method === "POST");
    expect(post?.body).toEqual({ challengeId: CH, credential, name: "My iPhone" });
    expect(screen.queryByTestId("passkey-name-input")).toBeNull();
    // the enrol card is dismissed for good once a passkey exists
    expect(window.localStorage.getItem("ll.passkey.prompt.v1")).toBeTruthy();
  });

  it("an empty name is omitted (server default 'Passkey')", async () => {
    platform();
    const f = api();
    await render();
    await waitFor(() => expect(screen.getByTestId("passkeys-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("passkeys-add"));
    fireEvent.click(screen.getByTestId("passkey-create"));
    await waitFor(() => expect(names()).toEqual(["Passkey"]));
    const post = f.calls.find((c) => c.url.endsWith("/me/passkeys") && c.method === "POST");
    expect(post?.body).toEqual({ challengeId: CH, credential });
  });

  it("shows the server's refusals: passkey_limit with max, passkey_exists, passkey_unavailable_for_account, passkey_failed", async () => {
    const cases: [number, string, string][] = [
      [
        409,
        "passkey_limit",
        "You have the most passkeys allowed (5). Remove one before adding another.",
      ],
      [409, "passkey_exists", "This device already has a passkey for your account."],
      [403, "passkey_unavailable_for_account", "Passkeys can't be added to this account."],
      [401, "passkey_failed", "That didn't work. Please try again."],
    ];
    for (const [status, error, text] of cases) {
      state.registerError = {
        status,
        body: {
          error,
          message: "server text",
          details: error === "passkey_limit" ? { max: 5 } : undefined,
        },
      };
      platform();
      api();
      await render();
      await waitFor(() => expect(screen.getByTestId("passkeys-add")).toBeTruthy());
      fireEvent.click(screen.getByTestId("passkeys-add"));
      fireEvent.click(screen.getByTestId("passkey-create"));
      await waitFor(() => expect(screen.getByTestId("passkeys-error").textContent).toBe(text));
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("a cancelled or failed ceremony shows a safe line and never posts", async () => {
    platform({
      create: vi.fn(async () => {
        throw new PasskeyError("cancelled");
      }),
    });
    const f = api();
    await render();
    await waitFor(() => expect(screen.getByTestId("passkeys-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("passkeys-add"));
    fireEvent.click(screen.getByTestId("passkey-create"));
    await waitFor(() =>
      expect(screen.getByTestId("passkeys-error").textContent).toBe(
        "Cancelled. Nothing was changed.",
      ),
    );
    expect(f.calls.some((c) => c.url.endsWith("/me/passkeys") && c.method === "POST")).toBe(false);
  });
});

describe("PasskeysPage rename", () => {
  it("renames inline: input prefilled, save disabled when blank, PATCH with the trimmed name", async () => {
    state.list = [item(PK1, "Laptop")];
    platform();
    const f = api();
    await render();
    await waitFor(() => expect(names()).toEqual(["Laptop"]));
    fireEvent.click(screen.getByTestId("passkey-rename"));
    const input = screen.getByTestId("passkey-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Laptop");
    fireEvent.change(input, { target: { value: "   " } });
    expect((screen.getByTestId("passkey-rename-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: " Work laptop " } });
    fireEvent.click(screen.getByTestId("passkey-rename-save"));
    await waitFor(() => expect(names()).toEqual(["Work laptop"]));
    const patch = f.calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toMatch(new RegExp(`/me/passkeys/${PK1}$`));
    expect(patch?.body).toEqual({ name: "Work laptop" });
    // no fresh sign-in needed to rename
    expect(fresh.calls).toBe(0);
  });
});

describe("PasskeysPage remove", () => {
  it("asks for confirmation; cancel changes nothing", async () => {
    state.list = [item(PK1, "Laptop")];
    platform();
    const f = api();
    await render();
    await waitFor(() => expect(names()).toEqual(["Laptop"]));
    fireEvent.click(screen.getByTestId("passkey-remove"));
    expect(screen.getByTestId("alert").textContent).toContain("Remove this passkey?");
    fireEvent.click(screen.getByText("Cancel"));
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(names()).toEqual(["Laptop"]);
  });

  it("confirm removes through the fresh-sign-in gate and refreshes the list (the last one may go)", async () => {
    state.list = [item(PK1, "Laptop")];
    platform();
    const f = api();
    await render();
    await waitFor(() => expect(names()).toEqual(["Laptop"]));
    fireEvent.click(screen.getByTestId("passkey-remove"));
    fireEvent.click(screen.getByText("Remove passkey"));
    await waitFor(() => expect(screen.getByTestId("passkeys-empty")).toBeTruthy());
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(fresh.calls).toBe(1);
  });

  it("a stale session: the gate re-verifies and the removal is retried once", async () => {
    state.list = [item(PK1, "Laptop")];
    state.staleDeletes = 1;
    platform();
    const f = api();
    await render();
    await waitFor(() => expect(names()).toEqual(["Laptop"]));
    fireEvent.click(screen.getByTestId("passkey-remove"));
    fireEvent.click(screen.getByText("Remove passkey"));
    await waitFor(() => expect(screen.getByTestId("passkeys-empty")).toBeTruthy());
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
    expect(screen.queryByTestId("passkeys-error")).toBeNull();
  });

  it("the user cancelling the gate leaves the passkey in place with no error message", async () => {
    state.list = [item(PK1, "Laptop")];
    state.staleDeletes = 5;
    fresh.mode = "cancel";
    platform();
    api();
    await render();
    await waitFor(() => expect(names()).toEqual(["Laptop"]));
    fireEvent.click(screen.getByTestId("passkey-remove"));
    fireEvent.click(screen.getByText("Remove passkey"));
    await new Promise((r) => setTimeout(r, 60));
    expect(names()).toEqual(["Laptop"]);
    expect(screen.queryByTestId("passkeys-error")).toBeNull();
  });

  it("another failure is shown as the server's message", async () => {
    state.list = [item(PK1, "Laptop")];
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
      if (path === "/me/passkeys") return jsonResponse({ passkeys: state.list, max: 5 });
      if (c.method === "DELETE")
        return jsonResponse({ error: "not_found", message: "No such passkey" }, 404);
      return jsonResponse({}, 404);
    });
    await render();
    await waitFor(() => expect(names()).toEqual(["Laptop"]));
    fireEvent.click(screen.getByTestId("passkey-remove"));
    fireEvent.click(screen.getByText("Remove passkey"));
    await waitFor(() =>
      expect(screen.getByTestId("passkeys-error").textContent).toBe("No such passkey"),
    );
    expect(new ApiError(404, "not_found", "x").code).toBe("not_found");
  });
});
