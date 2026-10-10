import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Settings -> Photo import (docs/plans/step-10.md 2.11): the Google section where the server offers
// it, the Apple album sync section for iPhone admins with honest messages elsewhere, and the
// Google section first except on the iPhone.

const state = vi.hoisted(() => ({ role: "admin" as string }));
vi.mock("../../auth/AuthProvider", () => ({
  useCurrentBaby: () => ({
    baby: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Mia",
      nickname: null,
      role: state.role,
      plan: "plus",
    },
    babies: [],
    setCurrentBabyId: vi.fn(),
  }),
  useAuth: () => ({ me: null }),
  ME_KEY: ["me"],
}));
vi.mock("../../components/import/GoogleCard", () => ({
  GoogleCard: (p: { returnTo: string }) => <div data-testid="google-card-stub">{p.returnTo}</div>,
}));
vi.mock("../../components/import/SyncCard", () => ({
  SyncCard: () => <div data-testid="sync-card-stub" />,
}));

import { ImportPage } from "./ImportPage";

let available = true;
beforeEach(() => {
  state.role = "admin";
  available = true;
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
  const r = renderApp(<ImportPage />, { route: "/settings/import" });
  await ionReady(r.container);
  return r;
}

describe("ImportPage", () => {
  it("web: the Google section (returning here), and the Apple section says it is iPhone-only", async () => {
    await open();
    await waitFor(() =>
      expect(screen.getByTestId("google-card-stub").textContent).toBe("/settings/import"),
    );
    expect(screen.getByText("Album sync is available in the iPhone app.")).toBeTruthy();
    expect(screen.queryByTestId("sync-card-stub")).toBeNull();
  });

  it("iPhone admin: the sync card loads (lazily) and the Apple section comes first", async () => {
    setNativePlatform("ios");
    const r = await open();
    await waitFor(() => expect(screen.getByTestId("sync-card-stub")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("google-card-stub")).toBeTruthy());
    const order = Array.from(
      r.container.querySelectorAll("[data-testid=import-apple], [data-testid=import-google]"),
    ).map((e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["import-apple", "import-google"]);
  });

  it("web: Google comes first", async () => {
    const r = await open();
    await waitFor(() => expect(screen.getByTestId("google-card-stub")).toBeTruthy());
    const order = Array.from(
      r.container.querySelectorAll("[data-testid=import-apple], [data-testid=import-google]"),
    ).map((e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["import-google", "import-apple"]);
  });

  it("iPhone contributor: no sync card, 'only parents'", async () => {
    setNativePlatform("ios");
    state.role = "contributor";
    await open();
    expect(screen.getByText("Only a baby's parents can set up album sync.")).toBeTruthy();
    expect(screen.queryByTestId("sync-card-stub")).toBeNull();
  });

  it("the server has Google import off: no Google section", async () => {
    available = false;
    await open();
    await waitFor(() => expect(screen.queryByTestId("import-google")).toBeNull());
    expect(screen.getByTestId("import-apple")).toBeTruthy();
  });
});
