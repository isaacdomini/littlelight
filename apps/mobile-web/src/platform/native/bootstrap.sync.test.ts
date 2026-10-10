import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";

// bootstrapNative registers the album-sync background listeners only on iOS when sync is set up
// (docs/plans/step-10.md 2.5), lazily and without ever delaying or failing the launch.

const mods = vi.hoisted(() => ({ init: vi.fn(), on: { value: true } }));
vi.mock("../tokenStore", () => ({ setTokenStore: vi.fn() }));
vi.mock("../uploader", () => ({ setUploader: vi.fn() }));
vi.mock("./nativeUploader", () => ({ nativeUploader: {} }));
vi.mock("./secureTokenStore", () => ({ createSecureTokenStore: () => ({}) }));
vi.mock("./session", () => ({ refreshIfNeeded: vi.fn(async () => undefined) }));
vi.mock("./ui", () => ({ hideSplash: vi.fn(), syncStatusBar: vi.fn() }));
vi.mock("./syncFlag", () => ({ syncMayBeOn: () => mods.on.value }));
vi.mock("./photoSync", () => ({ photoSync: { init: mods.init } }));

import { bootstrapNative } from "./bootstrap";

beforeEach(() => {
  mods.init.mockReset().mockResolvedValue(undefined);
  mods.on.value = true;
});
afterEach(() => setNativePlatform(null));

describe("bootstrapNative: album sync", () => {
  it("iOS with sync set up: registers the background listeners", async () => {
    setNativePlatform("ios");
    await bootstrapNative();
    await vi.waitFor(() => expect(mods.init).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["sync never turned on", "ios", false],
    ["Android", "android", true],
    ["the web", null, true],
  ] as const)("does not touch the sync code on %s", async (_n, platform, on) => {
    setNativePlatform(platform);
    mods.on.value = on;
    await bootstrapNative();
    await new Promise((r) => setTimeout(r, 20));
    expect(mods.init).not.toHaveBeenCalled();
  });

  it("a failing init never fails the launch", async () => {
    setNativePlatform("ios");
    mods.init.mockRejectedValue(new Error("plugin missing"));
    await expect(bootstrapNative()).resolves.toBeUndefined();
  });
});
