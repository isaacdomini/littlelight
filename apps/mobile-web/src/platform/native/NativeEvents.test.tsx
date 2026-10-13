import { cleanup, waitFor } from "@testing-library/react";
import type { PushData } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";
import { renderApp } from "../../testing/render";

// Native app-level events (docs/plans/step-9.md 2.4, 2.5, 2.8, 2.15): allow-listed deep links
// only, session refresh on resume, Android back, notification taps.

type Cb = (e: never) => void;
const listeners = new Map<string, Cb>();
const removers: ReturnType<typeof vi.fn>[] = [];
const App = vi.hoisted(() => ({
  addListener: vi.fn(),
  getLaunchUrl: vi.fn(),
  exitApp: vi.fn(),
}));
const push = vi.hoisted(() => ({
  tapCb: null as null | ((d: PushData) => void),
  off: vi.fn(),
  onPushTap: vi.fn(),
  refreshPushRegistration: vi.fn(),
}));
const session = vi.hoisted(() => ({ refreshIfNeeded: vi.fn() }));
const auth = vi.hoisted(() => ({ me: { user: {} } as unknown, setCurrentBabyId: vi.fn() }));

vi.mock("@capacitor/app", () => ({ App }));
vi.mock("./push", () => push);
vi.mock("./session", () => session);
const updater = vi.hoisted(() => ({ checkForUpdate: vi.fn() }));
vi.mock("./appUpdate", () => updater);
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ me: auth.me, setCurrentBabyId: auth.setCurrentBabyId }),
}));

import { NativeEvents, NativeViewerEvents } from "./NativeEvents";

const HOST = "https://tinyglow.app";
const INVITE = "I".repeat(43);
const SHARE = "S".repeat(22);
const BABY = "11111111-1111-4111-8111-111111111111";
const LINK = "22222222-2222-4222-8222-222222222222";
const assign = vi.fn();

const fire = (name: string, e: unknown) => listeners.get(name)?.(e as never);
const ready = () => waitFor(() => expect(listeners.size).toBe(3));

beforeEach(() => {
  window.sessionStorage.clear();
  listeners.clear();
  removers.length = 0;
  App.addListener.mockReset().mockImplementation(async (name: string, cb: Cb) => {
    listeners.set(name, cb);
    const remove = vi.fn(async () => undefined);
    removers.push(remove);
    return { remove };
  });
  App.getLaunchUrl.mockReset().mockResolvedValue(null);
  App.exitApp.mockReset();
  push.tapCb = null;
  push.off.mockReset();
  push.onPushTap.mockReset().mockImplementation((cb: (d: PushData) => void) => {
    push.tapCb = cb;
    return push.off;
  });
  push.refreshPushRegistration.mockReset().mockResolvedValue(undefined);
  session.refreshIfNeeded.mockReset().mockResolvedValue(undefined);
  updater.checkForUpdate.mockReset().mockResolvedValue("up_to_date");
  auth.me = { user: {} };
  auth.setCurrentBabyId.mockReset();
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign });
  setNativePlatform("ios");
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("NativeEvents: web", () => {
  it("registers nothing on the web", async () => {
    setNativePlatform(null);
    renderApp(<NativeEvents />);
    await new Promise((r) => setTimeout(r, 30));
    expect(App.addListener).not.toHaveBeenCalled();
    expect(push.refreshPushRegistration).not.toHaveBeenCalled();
  });
});

describe("NativeEvents: deep links", () => {
  it("an invite link opens the in-app invite route (router navigation)", async () => {
    const r = renderApp(<NativeEvents />);
    await ready();
    fire("appUrlOpen", { url: `${HOST}/invite/${INVITE}` });
    await waitFor(() => expect(r.location()).toBe(`/invite/${INVITE}`));
    expect(assign).not.toHaveBeenCalled();
  });

  it("a share link reloads into the viewer (no router there), not via the router", async () => {
    const r = renderApp(<NativeEvents />);
    await ready();
    fire("appUrlOpen", { url: `${HOST}/s/${SHARE}` });
    expect(assign).toHaveBeenCalledWith(`/s/${SHARE}`);
    expect(r.location()).toBe("/");
  });

  it("the query and fragment of /signin/native are kept", async () => {
    const r = renderApp(<NativeEvents />);
    await ready();
    fire("appUrlOpen", { url: `${HOST}/signin/native?code=abc` });
    await waitFor(() => expect(r.location()).toBe("/signin/native?code=abc"));
  });

  it.each([
    ["a foreign host", `https://evil.example/invite/${INVITE}`],
    ["the web callback", `${HOST}/signin/callback#access_token=x`],
    ["an unknown path", `${HOST}/settings/account`],
    ["a custom scheme without the debug flag", `tinyglow://s/${SHARE}`],
    ["a short token", `${HOST}/s/abc`],
    ["garbage", "not a url"],
  ])("ignores %s", async (_n, url) => {
    const r = renderApp(<NativeEvents />);
    await ready();
    fire("appUrlOpen", { url });
    await new Promise((res) => setTimeout(res, 20));
    expect(r.location()).toBe("/");
    expect(assign).not.toHaveBeenCalled();
  });

  it("the URL that launched the app is routed through the same allow-list", async () => {
    App.getLaunchUrl.mockResolvedValue({ url: `${HOST}/invite/${INVITE}` });
    const r = renderApp(<NativeEvents />);
    await waitFor(() => expect(r.location()).toBe(`/invite/${INVITE}`));
  });

  it("the same launch URL after a remount (same sessionStorage) is ignored; a different one is handled", async () => {
    App.getLaunchUrl.mockResolvedValue({ url: `${HOST}/s/${SHARE}` });
    const first = renderApp(<NativeEvents />);
    await ready();
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    first.unmount();
    cleanup();
    listeners.clear();
    assign.mockReset();
    // Full-page reload into the same WebView session: sessionStorage survives, launch URL is sticky.
    renderApp(<NativeEvents />);
    await ready();
    await new Promise((res) => setTimeout(res, 30));
    expect(assign).not.toHaveBeenCalled();

    cleanup();
    listeners.clear();
    const OTHER = "T".repeat(22);
    App.getLaunchUrl.mockResolvedValue({ url: `${HOST}/s/${OTHER}` });
    renderApp(<NativeEvents />);
    await ready();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/s/${OTHER}`));
  });

  it("hardNavigate to the page already shown does not call assign", async () => {
    vi.stubGlobal("location", {
      ...window.location,
      pathname: `/s/${SHARE}`,
      search: "",
      assign,
    });
    renderApp(<NativeEvents />);
    await ready();
    fire("appUrlOpen", { url: `${HOST}/s/${SHARE}` });
    await new Promise((res) => setTimeout(res, 20));
    expect(assign).not.toHaveBeenCalled();
  });

  it("a foreign launch URL is ignored", async () => {
    App.getLaunchUrl.mockResolvedValue({ url: `https://evil.example/s/${SHARE}` });
    const r = renderApp(<NativeEvents />);
    await ready();
    await new Promise((res) => setTimeout(res, 20));
    expect(r.location()).toBe("/");
    expect(assign).not.toHaveBeenCalled();
  });

  it("never logs the URL", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined),
    );
    renderApp(<NativeEvents />);
    await ready();
    fire("appUrlOpen", { url: `${HOST}/invite/${INVITE}` });
    fire("appUrlOpen", { url: `https://evil.example/invite/${INVITE}` });
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(INVITE);
  });
});

describe("NativeEvents: resume and back button", () => {
  it("resume refreshes the session if needed; a failure is swallowed", async () => {
    renderApp(<NativeEvents />);
    await ready();
    fire("resume", {});
    expect(session.refreshIfNeeded).toHaveBeenCalledTimes(1);
    session.refreshIfNeeded.mockRejectedValue(new Error("offline"));
    fire("resume", {});
    await new Promise((r) => setTimeout(r, 10));
  });

  it("back goes back in history when it can, else exits the app", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    renderApp(<NativeEvents />);
    await ready();
    fire("backButton", { canGoBack: true });
    expect(back).toHaveBeenCalledTimes(1);
    expect(App.exitApp).not.toHaveBeenCalled();
    fire("backButton", { canGoBack: false });
    expect(App.exitApp).toHaveBeenCalledTimes(1);
  });
});

describe("NativeEvents: notification taps", () => {
  it("photos_analyzed selects the baby and opens Chat", async () => {
    const r = renderApp(<NativeEvents />);
    await waitFor(() => expect(push.tapCb).not.toBeNull());
    push.tapCb?.({ kind: "photos_analyzed", babyId: BABY });
    expect(auth.setCurrentBabyId).toHaveBeenCalledWith(BABY);
    await waitFor(() => expect(r.location()).toBe("/chat"));
  });

  it("share_viewed selects the baby and opens Family", async () => {
    const r = renderApp(<NativeEvents />);
    await waitFor(() => expect(push.tapCb).not.toBeNull());
    push.tapCb?.({ kind: "share_viewed", babyId: BABY, shareLinkId: LINK });
    expect(auth.setCurrentBabyId).toHaveBeenCalledWith(BABY);
    await waitFor(() => expect(r.location()).toBe("/family"));
  });
});

describe("NativeEvents: lifecycle", () => {
  it("unmounting removes every native listener and the tap subscription", async () => {
    const r = renderApp(<NativeEvents />);
    await ready();
    r.unmount();
    await waitFor(() => {
      for (const rm of removers) expect(rm).toHaveBeenCalled();
    });
    expect(push.off).toHaveBeenCalled();
  });

  it("unmounting before the plugin answered still removes the late listeners", async () => {
    let release: (() => void) | undefined;
    App.addListener.mockImplementation(async (name: string, cb: Cb) => {
      await new Promise<void>((res) => {
        release ??= res;
        setTimeout(res, 20);
      });
      listeners.set(name, cb);
      const remove = vi.fn(async () => undefined);
      removers.push(remove);
      return { remove };
    });
    const r = renderApp(<NativeEvents />);
    r.unmount();
    release?.();
    await waitFor(() => expect(removers.length).toBeGreaterThan(0));
    await waitFor(() => {
      for (const rm of removers) expect(rm).toHaveBeenCalled();
    });
  });

  it("refreshes the push registration silently once signed in, not when signed out", async () => {
    renderApp(<NativeEvents />);
    await waitFor(() => expect(push.refreshPushRegistration).toHaveBeenCalledTimes(1));
    cleanup();
    push.refreshPushRegistration.mockClear();
    auth.me = null;
    renderApp(<NativeEvents />);
    await ready();
    expect(push.refreshPushRegistration).not.toHaveBeenCalled();
  });

  it("a failing push refresh never breaks the app", async () => {
    push.refreshPushRegistration.mockRejectedValue(new Error("nope"));
    renderApp(<NativeEvents />);
    await waitFor(() => expect(push.refreshPushRegistration).toHaveBeenCalled());
  });
});

describe("NativeEvents: live-update checks (step 14)", () => {
  afterEach(() => vi.useRealTimers());

  it("checks for an update 10 s after sign-in (launch), not before", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    renderApp(<NativeEvents />);
    await ready();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(updater.checkForUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    await waitFor(() => expect(updater.checkForUpdate).toHaveBeenCalledWith("launch"));
    expect(updater.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("no launch check when signed out, or when unmounted before 10 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    auth.me = null;
    renderApp(<NativeEvents />);
    await ready();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(updater.checkForUpdate).not.toHaveBeenCalled();
    cleanup();
    auth.me = { user: {} };
    renderApp(<NativeEvents />);
    await ready();
    cleanup();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(updater.checkForUpdate).not.toHaveBeenCalled();
  });

  it("resume: session refresh first, then a resume check (also when the refresh fails)", async () => {
    renderApp(<NativeEvents />);
    await ready();
    fire("resume", {});
    await waitFor(() => expect(updater.checkForUpdate).toHaveBeenCalledWith("resume"));
    expect(session.refreshIfNeeded.mock.invocationCallOrder[0]).toBeLessThan(
      updater.checkForUpdate.mock.invocationCallOrder[0] as number,
    );
    updater.checkForUpdate.mockClear();
    session.refreshIfNeeded.mockRejectedValue(new Error("offline"));
    fire("resume", {});
    await waitFor(() => expect(updater.checkForUpdate).toHaveBeenCalledWith("resume"));
  });

  it("a rejecting check never breaks the app", async () => {
    updater.checkForUpdate.mockRejectedValue(new Error("boom"));
    renderApp(<NativeEvents />);
    await ready();
    fire("resume", {});
    await waitFor(() => expect(updater.checkForUpdate).toHaveBeenCalled());
  });

  it("on the web nothing is checked", async () => {
    setNativePlatform(null);
    renderApp(<NativeEvents />);
    await new Promise((r) => setTimeout(r, 20));
    expect(updater.checkForUpdate).not.toHaveBeenCalled();
  });
});

describe("NativeViewerEvents (share viewer)", () => {
  it("any allowed link reloads into its route, even an invite", async () => {
    renderApp(<NativeViewerEvents />);
    await ready();
    fire("appUrlOpen", { url: `${HOST}/invite/${INVITE}` });
    expect(assign).toHaveBeenCalledWith(`/invite/${INVITE}`);
    fire("appUrlOpen", { url: `https://evil.example/s/${SHARE}` });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("ignores notification taps (there is no signed-in app behind the viewer)", async () => {
    renderApp(<NativeViewerEvents />);
    await ready();
    push.tapCb?.({ kind: "photos_analyzed", babyId: BABY });
    expect(auth.setCurrentBabyId).not.toHaveBeenCalled();
  });
});
