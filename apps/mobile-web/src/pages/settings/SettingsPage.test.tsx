import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Settings on native (docs/plans/step-9.md 2.8, 2.15): a Notifications row for admins only, and
// an easy-to-find "Delete account" (App Store 5.1.1(v)).

const auth = vi.hoisted(() => ({
  me: { babies: [] as { id: string; role: string; plan: string }[] },
}));
const signOut = vi.hoisted(() => vi.fn());
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ me: auth.me, clearSession: vi.fn() }),
  useCurrentBaby: () => ({ baby: null, babies: [], setCurrentBabyId: vi.fn() }),
  ME_KEY: ["me"],
}));
vi.mock("../../auth/useSignOut", () => ({ useSignOut: () => signOut }));

import { SettingsPage } from "./SettingsPage";

const baby = (role: string, plan = "plus") => ({ id: `b-${role}-${plan}`, role, plan });

beforeEach(() => {
  signOut.mockReset().mockResolvedValue(undefined);
  auth.me = { babies: [baby("admin")] };
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

async function open() {
  const r = renderApp(<SettingsPage />, { route: "/settings" });
  await ionReady(r.container);
  return r;
}

describe("SettingsPage", () => {
  it("native admin: Notifications, Devices, Delete account", async () => {
    setNativePlatform("ios");
    await open();
    expect(screen.getByTestId("settings-notifications").textContent).toContain("Notifications");
    expect(screen.getByTestId("settings-devices")).toBeTruthy();
    expect(screen.getByTestId("settings-account").textContent).toContain("Delete account");
  });

  it("native Notifications row opens /settings/notifications", async () => {
    setNativePlatform("ios");
    const r = await open();
    fireEvent.click(screen.getByTestId("settings-notifications"));
    expect(r.location()).toBe("/settings/notifications");
  });

  it("native: a contributor-only user gets no Notifications row (contributors never get push)", async () => {
    setNativePlatform("ios");
    auth.me = { babies: [baby("contributor")] };
    await open();
    expect(screen.queryByTestId("settings-notifications")).toBeNull();
    expect(screen.getByTestId("settings-account")).toBeTruthy();
  });

  it("native: a user with no babies has no Notifications row", async () => {
    setNativePlatform("android");
    auth.me = { babies: [] };
    await open();
    expect(screen.queryByTestId("settings-notifications")).toBeNull();
  });

  it("native: a free-tier admin still gets the row (share-viewed pushes are not an AI feature)", async () => {
    setNativePlatform("ios");
    auth.me = { babies: [baby("admin", "free")] };
    await open();
    expect(screen.getByTestId("settings-notifications")).toBeTruthy();
  });

  it("web: no Notifications row and the account row keeps its web label", async () => {
    setNativePlatform(null);
    await open();
    expect(screen.queryByTestId("settings-notifications")).toBeNull();
    expect(screen.getByTestId("settings-account").textContent).toContain("Account");
    expect(screen.getByTestId("settings-account").textContent).not.toContain("Delete account");
  });

  it("Sign out signs this device out (local scope)", async () => {
    setNativePlatform("ios");
    await open();
    fireEvent.click(screen.getByTestId("signout-local"));
    expect(signOut).toHaveBeenCalledWith("local");
  });
});
