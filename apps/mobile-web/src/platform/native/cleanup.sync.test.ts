import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";

// Sign-out and account deletion also stop Apple album sync on this phone (docs/plans/step-10.md
// 2.5): pause the server row while the bearer is valid, then forget the setup and the ledger; the
// code is only loaded when sync was ever turned on here.

const mods = vi.hoisted(() => ({
  wipeNativeFiles: vi.fn(),
  unregisterCurrentPushDevice: vi.fn(),
  onSignOut: vi.fn(),
  clearLocal: vi.fn(),
  on: { value: true },
}));
vi.mock("./files", () => ({ wipeNativeFiles: mods.wipeNativeFiles }));
vi.mock("./push", () => ({ unregisterCurrentPushDevice: mods.unregisterCurrentPushDevice }));
vi.mock("./syncFlag", () => ({ syncMayBeOn: () => mods.on.value }));
vi.mock("./photoSync", () => ({
  photoSync: { onSignOut: mods.onSignOut, clearLocal: mods.clearLocal },
}));

import { beforeNativeSignOut, wipeNativeLocalData } from "./cleanup";

beforeEach(() => {
  mods.wipeNativeFiles.mockReset().mockResolvedValue(undefined);
  mods.unregisterCurrentPushDevice.mockReset().mockResolvedValue(undefined);
  mods.onSignOut.mockReset().mockResolvedValue(undefined);
  mods.clearLocal.mockReset().mockResolvedValue(undefined);
  mods.on.value = true;
  setNativePlatform("ios");
});
afterEach(() => setNativePlatform(null));

describe("sign-out with album sync", () => {
  it("pauses the sync (after the push device is removed) on iOS when sync is set up", async () => {
    await beforeNativeSignOut();
    expect(mods.onSignOut).toHaveBeenCalledTimes(1);
    expect(mods.unregisterCurrentPushDevice.mock.invocationCallOrder[0]).toBeLessThan(
      mods.onSignOut.mock.invocationCallOrder[0] as number,
    );
  });

  it("does not load or call the sync code when sync was never turned on, on Android, or on the web", async () => {
    mods.on.value = false;
    await beforeNativeSignOut();
    mods.on.value = true;
    setNativePlatform("android");
    await beforeNativeSignOut();
    setNativePlatform(null);
    await beforeNativeSignOut();
    expect(mods.onSignOut).not.toHaveBeenCalled();
  });

  it("a failing or hanging sync pause never blocks signing out", async () => {
    mods.onSignOut.mockRejectedValue(new Error("offline"));
    await expect(beforeNativeSignOut()).resolves.toBeUndefined();
    vi.useFakeTimers();
    mods.onSignOut.mockReturnValue(new Promise(() => undefined));
    const p = beforeNativeSignOut();
    await vi.advanceTimersByTimeAsync(5001);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("local wipe with album sync", () => {
  it("clears the sync config and ledger without an API call", async () => {
    await wipeNativeLocalData();
    expect(mods.wipeNativeFiles).toHaveBeenCalledTimes(1);
    expect(mods.clearLocal).toHaveBeenCalledTimes(1);
    expect(mods.onSignOut).not.toHaveBeenCalled();
  });

  it("skips it when sync is off or the platform is not iOS; a failure does not matter", async () => {
    mods.on.value = false;
    await wipeNativeLocalData();
    setNativePlatform("android");
    mods.on.value = true;
    await wipeNativeLocalData();
    expect(mods.clearLocal).not.toHaveBeenCalled();
    setNativePlatform("ios");
    mods.clearLocal.mockRejectedValue(new Error("x"));
    await expect(wipeNativeLocalData()).resolves.toBeUndefined();
  });
});
