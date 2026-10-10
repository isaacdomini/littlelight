import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";
import { renderApp } from "../../testing/render";

// NativeEvents drives album sync (docs/plans/step-10.md 2.5): a signed-in launch and every resume
// run a sync on iOS when it is set up; never on the web, Android, or when sync is off.

type Cb = (e: never) => void;
const listeners = new Map<string, Cb>();
const App = vi.hoisted(() => ({ addListener: vi.fn(), getLaunchUrl: vi.fn(), exitApp: vi.fn() }));
const sync = vi.hoisted(() => ({ runSync: vi.fn(), on: { value: true } }));
const auth = vi.hoisted(() => ({ me: null as unknown }));

vi.mock("@capacitor/app", () => ({ App }));
vi.mock("./push", () => ({
  onPushTap: () => () => undefined,
  refreshPushRegistration: vi.fn(async () => undefined),
}));
vi.mock("./session", () => ({ refreshIfNeeded: vi.fn(async () => undefined) }));
vi.mock("./syncFlag", () => ({ syncMayBeOn: () => sync.on.value }));
vi.mock("./photoSync", () => ({ photoSync: { runSync: sync.runSync } }));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ me: auth.me, setCurrentBabyId: vi.fn() }),
}));

import { NativeEvents } from "./NativeEvents";

beforeEach(() => {
  listeners.clear();
  App.addListener.mockReset().mockImplementation(async (name: string, cb: Cb) => {
    listeners.set(name, cb);
    return { remove: vi.fn(async () => undefined) };
  });
  App.getLaunchUrl.mockReset().mockResolvedValue(null);
  sync.runSync.mockReset().mockResolvedValue(undefined);
  sync.on.value = true;
  auth.me = { user: {} };
  setNativePlatform("ios");
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

describe("NativeEvents: album sync triggers", () => {
  it("a signed-in launch runs a 'launch' sync", async () => {
    renderApp(<NativeEvents />);
    await waitFor(() => expect(sync.runSync).toHaveBeenCalledWith("launch"));
  });

  it("returning to the app runs a 'resume' sync (after the session refresh)", async () => {
    renderApp(<NativeEvents />);
    await waitFor(() => expect(listeners.has("resume")).toBe(true));
    sync.runSync.mockClear();
    listeners.get("resume")?.({} as never);
    await waitFor(() => expect(sync.runSync).toHaveBeenCalledWith("resume"));
  });

  it("signed out: no launch sync", async () => {
    auth.me = null;
    renderApp(<NativeEvents />);
    await new Promise((r) => setTimeout(r, 30));
    expect(sync.runSync).not.toHaveBeenCalledWith("launch");
  });

  it.each([
    ["sync is not set up", "ios", false],
    ["Android", "android", true],
  ] as const)("nothing runs when %s", async (_n, platform, on) => {
    setNativePlatform(platform);
    sync.on.value = on;
    renderApp(<NativeEvents />);
    await waitFor(() => expect(listeners.has("resume")).toBe(true));
    listeners.get("resume")?.({} as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(sync.runSync).not.toHaveBeenCalled();
  });

  it("a failing sync never breaks the app event handlers", async () => {
    sync.runSync.mockRejectedValue(new Error("boom"));
    renderApp(<NativeEvents />);
    await waitFor(() => expect(listeners.has("resume")).toBe(true));
    expect(() => listeners.get("resume")?.({} as never)).not.toThrow();
  });
});
