import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// If the lazily imported push module fails to load (chunk error, missing plugin), the page shows
// the "unavailable" card instead of hanging or crashing.

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ me: { babies: [], profile: undefined } }),
  useCurrentBaby: () => ({ baby: null, babies: [], setCurrentBabyId: vi.fn() }),
  ME_KEY: ["me"],
}));
vi.mock("../../platform/native/push", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

import { NotificationsPage } from "./NotificationsPage";

afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

describe("NotificationsPage: failing lazy import", () => {
  it("shows the unavailable card", async () => {
    setNativePlatform("ios");
    const r = renderApp(<NotificationsPage />, { route: "/settings/notifications" });
    await ionReady(r.container);
    await waitFor(() => expect(screen.getByTestId("notifications-unavailable")).toBeTruthy());
    expect(screen.queryByTestId("notifications-enable")).toBeNull();
  });
});
