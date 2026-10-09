import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One-time native wiring (docs/plans/step-9.md 2.5, 2.6, 2.15): secure token store, background
// uploader, launch-time refresh; never throws.

const mods = vi.hoisted(() => ({
  setTokenStore: vi.fn(),
  setUploader: vi.fn(),
  refreshIfNeeded: vi.fn(),
  hideSplash: vi.fn(),
  syncStatusBar: vi.fn(),
  store: { id: "secure-store" },
}));
vi.mock("../tokenStore", () => ({ setTokenStore: mods.setTokenStore }));
vi.mock("../uploader", () => ({ setUploader: mods.setUploader }));
vi.mock("./nativeUploader", () => ({ nativeUploader: { id: "native-uploader" } }));
vi.mock("./secureTokenStore", () => ({ createSecureTokenStore: () => mods.store }));
vi.mock("./session", () => ({ refreshIfNeeded: mods.refreshIfNeeded }));
vi.mock("./ui", () => ({ hideSplash: mods.hideSplash, syncStatusBar: mods.syncStatusBar }));

import { afterFirstRender, bootstrapNative } from "./bootstrap";

beforeEach(() => {
  for (const f of [mods.setTokenStore, mods.setUploader, mods.hideSplash, mods.syncStatusBar])
    f.mockReset();
  mods.refreshIfNeeded.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("bootstrapNative", () => {
  it("installs the Keychain token store and the background uploader before refreshing", async () => {
    await bootstrapNative();
    expect(mods.setTokenStore).toHaveBeenCalledWith(mods.store);
    expect(mods.setUploader).toHaveBeenCalledWith({ id: "native-uploader" });
    expect(mods.refreshIfNeeded).toHaveBeenCalledTimes(1);
    expect(mods.setTokenStore.mock.invocationCallOrder[0]).toBeLessThan(
      mods.refreshIfNeeded.mock.invocationCallOrder[0] as number,
    );
  });

  it("never throws when the launch refresh fails (offline)", async () => {
    mods.refreshIfNeeded.mockRejectedValue(new Error("offline"));
    await expect(bootstrapNative()).resolves.toBeUndefined();
    expect(mods.setUploader).toHaveBeenCalled();
  });
});

describe("afterFirstRender", () => {
  it("styles the status bar, then hides the splash", async () => {
    await afterFirstRender();
    expect(mods.syncStatusBar).toHaveBeenCalledTimes(1);
    expect(mods.hideSplash).toHaveBeenCalledTimes(1);
    expect(mods.syncStatusBar.mock.invocationCallOrder[0]).toBeLessThan(
      mods.hideSplash.mock.invocationCallOrder[0] as number,
    );
  });
});
