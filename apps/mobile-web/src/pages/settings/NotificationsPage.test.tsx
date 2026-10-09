import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, memoryTokenStore, setNativePlatform, stubFetch } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Settings -> Notifications (docs/plans/step-9.md 2.8, 2.15): opt-in, per-kind toggles stored on
// the profile, contributors see no toggles.

interface Baby {
  id: string;
  role: string;
  plan: string;
}
const auth = vi.hoisted(() => ({
  me: { babies: [] as unknown[], profile: undefined as undefined | Record<string, unknown> },
}));
const push = vi.hoisted(() => ({ pushPermission: vi.fn(), enablePush: vi.fn() }));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ me: auth.me }),
  useCurrentBaby: () => ({ baby: null, babies: [], setCurrentBabyId: vi.fn() }),
  ME_KEY: ["me"],
}));
vi.mock("../../platform/native/push", () => push);

import { NotificationsPage } from "./NotificationsPage";

const babies = (...b: Baby[]) => b;
const admin = (plan = "plus"): Baby => ({ id: `a-${plan}`, role: "admin", plan });
const contributor: Baby = { id: "c1", role: "contributor", plan: "plus" };

beforeEach(async () => {
  auth.me = {
    babies: babies(admin()),
    profile: { notifyPhotosAnalyzed: true, notifyShareViewed: true },
  };
  push.pushPermission.mockReset().mockResolvedValue("granted");
  push.enablePush.mockReset().mockResolvedValue("enabled");
  setNativePlatform("ios");
  vi.stubEnv("VITE_API_URL", "https://api.example.test");
  const { setTokenStore } = await import("../../platform/tokenStore");
  setTokenStore(memoryTokenStore({ accessToken: "AT", refreshToken: "RT" }));
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function open() {
  const r = renderApp(<NotificationsPage />, { route: "/settings/notifications" });
  await ionReady(r.container);
  return r;
}

describe("NotificationsPage: permission states", () => {
  it("granted: says notifications are on", async () => {
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-on")).toBeTruthy());
    expect(screen.queryByTestId("notifications-enable")).toBeNull();
  });

  it("denied: explains how to change it in system settings, no button", async () => {
    push.pushPermission.mockResolvedValue("denied");
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-denied")).toBeTruthy());
    expect(screen.queryByTestId("notifications-enable")).toBeNull();
  });

  it("prompt: shows Turn on notifications; nothing is requested until it is tapped", async () => {
    push.pushPermission.mockResolvedValue("prompt");
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-enable")).toBeTruthy());
    expect(push.enablePush).not.toHaveBeenCalled();
  });

  it("tapping Turn on calls enablePush once and re-reads the permission", async () => {
    push.pushPermission.mockResolvedValueOnce("prompt").mockResolvedValue("granted");
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-enable")).toBeTruthy());
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await waitFor(() => expect(push.enablePush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("notifications-on")).toBeTruthy());
  });

  it("a failed enable shows an error", async () => {
    push.pushPermission.mockResolvedValue("prompt");
    push.enablePush.mockResolvedValue("failed");
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-enable")).toBeTruthy());
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await waitFor(() => expect(screen.getByTestId("notifications-error")).toBeTruthy());
  });

  it("unavailable (an Android build without FCM): says so and shows no toggles", async () => {
    push.pushPermission.mockResolvedValue("unavailable");
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-unavailable")).toBeTruthy());
    expect(screen.queryByTestId("notifications-prefs")).toBeNull();
  });

  it("on the web the page reads as unavailable without touching the plugin", async () => {
    setNativePlatform(null);
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-unavailable")).toBeTruthy());
    expect(push.pushPermission).not.toHaveBeenCalled();
  });
});

describe("NotificationsPage: who sees which toggle", () => {
  it("a paid admin sees both kinds", async () => {
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-prefs")).toBeTruthy());
    expect(screen.getByTestId("notify-photos-analyzed")).toBeTruthy();
    expect(screen.getByTestId("notify-share-viewed")).toBeTruthy();
  });

  it("a free-tier admin sees only the share-viewed toggle (photos-analyzed is paid-tier only)", async () => {
    auth.me = { babies: babies(admin("free")), profile: {} };
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-prefs")).toBeTruthy());
    expect(screen.queryByTestId("notify-photos-analyzed")).toBeNull();
    expect(screen.getByTestId("notify-share-viewed")).toBeTruthy();
  });

  it("a contributor-only user sees no toggles at all", async () => {
    auth.me = { babies: babies(contributor), profile: {} };
    await open();
    await waitFor(() => expect(screen.getByTestId("notifications-on")).toBeTruthy());
    expect(screen.queryByTestId("notifications-prefs")).toBeNull();
  });

  it("a missing preference counts as on; an explicit false is off", async () => {
    auth.me = { babies: babies(admin()), profile: { notifyShareViewed: false } };
    await open();
    await waitFor(() => expect(screen.getByTestId("notify-share-viewed")).toBeTruthy());
    expect((screen.getByTestId("notify-photos-analyzed") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("notify-share-viewed") as HTMLInputElement).checked).toBe(false);
  });
});

describe("NotificationsPage: saving preferences", () => {
  const meBody = {
    user: { id: "11111111-1111-4111-8111-111111111111", email: "a@example.com" },
    profile: null,
    consent: { ok: true, requiredTermsVersion: "x", requiredPrivacyVersion: "y" },
    profileComplete: true,
    babies: [],
    session: { isFresh: true },
  };

  it("toggling a kind PATCHes only that field to /me/profile", async () => {
    const f = stubFetch(() => jsonResponse({ nope: true }, 200));
    await open();
    await waitFor(() => expect(screen.getByTestId("notify-photos-analyzed")).toBeTruthy());
    fireEvent.click(screen.getByTestId("notify-photos-analyzed"));
    await waitFor(() => expect(f.calls.length).toBeGreaterThan(0));
    const call = f.calls[0];
    expect(call?.method).toBe("PATCH");
    expect(call?.url).toBe("https://api.example.test/api/me/profile");
    expect(call?.body).toEqual({ notifyPhotosAnalyzed: false });
    expect(call?.headers.get("X-Littlelight-Client")).toBe("native");
    fireEvent.click(screen.getByTestId("notify-share-viewed"));
    await waitFor(() => expect(f.calls.length).toBe(2));
    expect(f.calls[1]?.body).toEqual({ notifyShareViewed: false });
    expect(meBody).toBeTruthy();
  });

  it("a failed save shows an error", async () => {
    stubFetch(() => jsonResponse({ error: "internal", message: "Something went wrong" }, 500));
    await open();
    await waitFor(() => expect(screen.getByTestId("notify-share-viewed")).toBeTruthy());
    fireEvent.click(screen.getByTestId("notify-share-viewed"));
    await waitFor(() => expect(screen.getByTestId("notifications-error")).toBeTruthy());
  });
});
