import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appUpdateStatus, type UpdaterInfo } from "../../platform/native/appUpdateStatus";
import { setNativePlatform } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Settings -> About (docs/plans/step-14.md 2.8): web shows the build only; native shows the shell
// version, the running bundle (bundled / updated), "Update ready" + Restart (disabled while busy),
// a manual check with its outcome copy, and "Reset app files" behind a confirm.

const busy = vi.hoisted(() => ({
  uploads: 0,
  sync: "idle" as string,
  listeners: new Set<() => void>(),
}));
vi.mock("../../lib/upload/manager", () => ({
  uploadManager: {
    subscribe: (cb: () => void) => {
      busy.listeners.add(cb);
      return () => busy.listeners.delete(cb);
    },
    getSnapshot: () => busy.uploads,
  },
  summarize: (n: number) => ({ active: n }),
}));
vi.mock("../../platform/native/photoSync", () => {
  let snap = { phase: "idle" };
  return {
    photoSync: {
      subscribe: (cb: () => void) => {
        busy.listeners.add(cb);
        return () => busy.listeners.delete(cb);
      },
      getStatus: () => {
        if (snap.phase !== busy.sync) snap = { phase: busy.sync };
        return snap;
      },
    },
  };
});
vi.mock("@ionic/react", async () => {
  const actual = await vi.importActual<typeof import("@ionic/react")>("@ionic/react");
  const m = await import("../../testing/ionMocks");
  return { ...actual, IonAlert: m.FakeAlert };
});

import { appUpdater } from "../../platform/native/appUpdate";
import { AboutPage } from "./AboutPage";

// The lazy updater chunk is the real module; its `appUpdater` object is spied (the module-level
// `checkForUpdate` / `updaterInfo` delegate to it), so no native plugin is ever reached.
const updater = {
  updaterInfo: vi.spyOn(appUpdater, "info"),
  checkForUpdate: vi.spyOn(appUpdater, "checkForUpdate"),
  appUpdater: {
    applyNow: vi.spyOn(appUpdater, "applyNow"),
    reset: vi.spyOn(appUpdater, "reset"),
  },
};

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const info = (o: Partial<UpdaterInfo> = {}): UpdaterInfo => ({
  nativeVersion: "1.4.0",
  nativeBuild: 12,
  builtinVersion: A,
  currentVersion: A,
  currentSource: "builtin",
  stagedVersion: null,
  androidPushConfigured: false,
  ...o,
});

function setBusy(uploads: number, sync = "idle") {
  act(() => {
    busy.uploads = uploads;
    busy.sync = sync;
    for (const l of busy.listeners) l();
  });
}

beforeEach(() => {
  appUpdateStatus.reset();
  busy.uploads = 0;
  busy.sync = "idle";
  updater.updaterInfo.mockReset().mockImplementation(async () => appUpdateStatus.get().info);
  updater.checkForUpdate.mockReset().mockResolvedValue("up_to_date");
  updater.appUpdater.applyNow.mockReset().mockResolvedValue("applied");
  updater.appUpdater.reset.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

async function open(i: UpdaterInfo | null = info()) {
  if (i) appUpdateStatus.set({ info: i, infoLoaded: true });
  const r = renderApp(<AboutPage />, { route: "/settings/about" });
  await ionReady(r.container);
  return r;
}

describe("AboutPage: web", () => {
  it("shows the web build only; never loads the updater", async () => {
    await open(null);
    expect(screen.getByTestId("about")).toBeTruthy();
    expect(screen.getByTestId("about-web-version").textContent).toBe("1.0.0");
    for (const id of [
      "about-app-version",
      "about-source",
      "about-check",
      "about-reset",
      "about-ready",
    ])
      expect(screen.queryByTestId(id)).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(updater.updaterInfo).not.toHaveBeenCalled();
  });
});

describe("AboutPage: native", () => {
  beforeEach(() => setNativePlatform("ios"));

  it("bundled: app version + build, Bundled badge, bundle id; asks for fresh info; no reset", async () => {
    await open();
    expect(screen.getByTestId("about-app-version").textContent).toBe("1.4.0 (12)");
    expect(screen.getByTestId("about-source").getAttribute("data-source")).toBe("builtin");
    expect(screen.getByTestId("about-source").textContent).toContain("Bundled");
    expect(screen.getByTestId("about-bundle-id").textContent).toBe(A);
    expect(screen.queryByTestId("about-ready")).toBeNull();
    expect(screen.queryByTestId("about-reset")).toBeNull();
    await waitFor(() => expect(updater.updaterInfo).toHaveBeenCalledWith({ fresh: true }));
  });

  it("updated (ota): Updated badge and Reset available", async () => {
    await open(info({ currentVersion: B, currentSource: "ota" }));
    expect(screen.getByTestId("about-source").textContent).toContain("Updated");
    expect(screen.getByTestId("about-bundle-id").textContent).toBe(B);
    expect(screen.getByTestId("about-reset")).toBeTruthy();
  });

  it("update ready: Restart applies it", async () => {
    await open(info({ stagedVersion: B }));
    expect(screen.getByTestId("about-ready").textContent).toContain("Update ready");
    fireEvent.click(screen.getByTestId("about-restart"));
    await waitFor(() => expect(updater.appUpdater.applyNow).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("about-error")).toBeNull();
  });

  it("Restart is disabled while an upload or an album sync runs", async () => {
    await open(info({ stagedVersion: B }));
    const restart = () => screen.getByTestId("about-restart") as HTMLButtonElement;
    expect(restart().disabled).toBe(false);
    setBusy(1);
    expect(restart().disabled).toBe(true);
    expect(screen.getByTestId("about-ready").textContent).toContain("uploads and album sync");
    setBusy(0, "syncing");
    expect(restart().disabled).toBe(true);
    setBusy(0, "idle");
    expect(restart().disabled).toBe(false);
  });

  it("a failed restart shows an error", async () => {
    updater.appUpdater.applyNow.mockResolvedValue("failed");
    await open(info({ stagedVersion: B }));
    fireEvent.click(screen.getByTestId("about-restart"));
    expect((await screen.findByTestId("about-error")).textContent).toContain("Couldn't restart");
  });

  it("a staged version equal to the current one is not 'ready'", async () => {
    await open(info({ stagedVersion: A }));
    expect(screen.queryByTestId("about-ready")).toBeNull();
  });

  it("Check for updates runs a manual check", async () => {
    await open();
    fireEvent.click(screen.getByTestId("about-check"));
    await waitFor(() => expect(updater.checkForUpdate).toHaveBeenCalledWith("manual"));
  });

  it("the check button is disabled and shows progress while checking / downloading", async () => {
    await open();
    act(() => appUpdateStatus.set({ phase: "checking" }));
    expect((screen.getByTestId("about-check") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("about-outcome").textContent).toContain("Checking");
    act(() => appUpdateStatus.set({ phase: "downloading" }));
    expect(screen.getByTestId("about-outcome").textContent).toContain("Downloading");
  });

  it.each([
    ["up_to_date", "up to date"],
    ["wifi_required", "Wi-Fi"],
    ["native_too_old", "App Store"],
    ["no_space", "free space"],
    ["busy", "uploads and album sync"],
    ["error", "Couldn't check"],
    ["network", "Couldn't check"],
    ["disabled", "No update"],
    ["unavailable", "No update"],
  ] as const)("outcome %s shows its copy", async (outcome, copy) => {
    await open();
    act(() => appUpdateStatus.set({ phase: "idle", outcome }));
    const el = screen.getByTestId("about-outcome");
    expect(el.getAttribute("data-outcome")).toBe(outcome);
    expect(el.textContent).toContain(copy);
  });

  it("native_too_old on Android names Google Play", async () => {
    setNativePlatform("android");
    await open();
    act(() => appUpdateStatus.set({ outcome: "native_too_old" }));
    expect(screen.getByTestId("about-outcome").textContent).toContain("Google Play");
  });

  it("Reset app files asks first, then resets", async () => {
    await open(info({ currentVersion: B, currentSource: "ota" }));
    fireEvent.click(screen.getByTestId("about-reset"));
    expect(updater.appUpdater.reset).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId("alert");
    expect(dialog.textContent).toContain("Reset app files?");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(updater.appUpdater.reset).toHaveBeenCalledTimes(1));
  });

  it("Reset cancelled does nothing; a failed reset shows an error", async () => {
    await open(info({ currentVersion: B, currentSource: "ota" }));
    fireEvent.click(screen.getByTestId("about-reset"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(updater.appUpdater.reset).not.toHaveBeenCalled();
    updater.appUpdater.reset.mockResolvedValue(false);
    fireEvent.click(screen.getByTestId("about-reset"));
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    expect((await screen.findByTestId("about-error")).textContent).toContain("Couldn't reset");
  });

  it("a shell without the updater shows the web build only (no check button)", async () => {
    await open(null);
    expect(screen.getByTestId("about-web-version")).toBeTruthy();
    expect(screen.queryByTestId("about-check")).toBeNull();
    expect(screen.queryByTestId("about-app-version")).toBeNull();
  });
});
