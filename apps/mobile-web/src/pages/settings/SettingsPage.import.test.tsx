import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Settings -> "Photo import" row (docs/plans/step-10.md 2.11): shown when Google import is
// offered to a member who can add photos, or when the iPhone admin can sync an album.

const auth = vi.hoisted(() => ({ me: { babies: [] as unknown[] } }));
const current = vi.hoisted(() => ({
  baby: null as null | { id: string; role: string; plan: string },
}));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ me: auth.me, clearSession: vi.fn() }),
  useCurrentBaby: () => ({ baby: current.baby, babies: [], setCurrentBabyId: vi.fn() }),
  ME_KEY: ["me"],
}));
vi.mock("../../auth/useSignOut", () => ({ useSignOut: () => vi.fn() }));

import { SettingsPage } from "./SettingsPage";

let available = true;
beforeEach(() => {
  available = true;
  auth.me = { babies: [] };
  current.baby = { id: "b1", role: "admin", plan: "plus" };
  stubFetch((c) =>
    c.url.endsWith("/me/import/google/connection")
      ? jsonResponse({ available, connected: false, connectedAt: null, needsReconnect: false })
      : jsonResponse({}, 404),
  );
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
  vi.unstubAllGlobals();
});

async function open() {
  const r = renderApp(<SettingsPage />, { route: "/settings" });
  await ionReady(r.container);
  return r;
}

describe("SettingsPage: Photo import row", () => {
  it("web admin with Google import available: the row opens /settings/import", async () => {
    const r = await open();
    await waitFor(() => expect(screen.getByTestId("settings-import")).toBeTruthy());
    expect(screen.getByTestId("settings-import").textContent).toContain("Photo import");
    fireEvent.click(screen.getByTestId("settings-import"));
    expect(r.location()).toBe("/settings/import");
  });

  it("a contributor sees it too", async () => {
    current.baby = { id: "b1", role: "contributor", plan: "plus" };
    await open();
    await waitFor(() => expect(screen.getByTestId("settings-import")).toBeTruthy());
  });

  it("Google import off on the server, on the web: no row (and no empty page behind it)", async () => {
    available = false;
    await open();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("settings-import")).toBeNull();
  });

  it("Google off but an iPhone admin: the row is there for album sync", async () => {
    available = false;
    setNativePlatform("ios");
    await open();
    await waitFor(() => expect(screen.getByTestId("settings-import")).toBeTruthy());
  });

  it("Google off, an iPhone contributor: no row", async () => {
    available = false;
    setNativePlatform("ios");
    current.baby = { id: "b1", role: "contributor", plan: "plus" };
    await open();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("settings-import")).toBeNull();
  });

  it("no current album: no request and no row", async () => {
    current.baby = null;
    const { calls } = stubFetch(() => jsonResponse({}, 404));
    await open();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.url.includes("/import/google"))).toBe(false);
    expect(screen.queryByTestId("settings-import")).toBeNull();
  });
});
