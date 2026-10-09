import { beforeEach, describe, expect, it, vi } from "vitest";

// Sign-out / account-deletion cleanup on the device (docs/plans/step-9.md 2.5, 2.15).

const mods = vi.hoisted(() => ({ wipeNativeFiles: vi.fn(), unregisterCurrentPushDevice: vi.fn() }));
vi.mock("./files", () => ({ wipeNativeFiles: mods.wipeNativeFiles }));
vi.mock("./push", () => ({ unregisterCurrentPushDevice: mods.unregisterCurrentPushDevice }));

import { beforeNativeSignOut, wipeNativeLocalData } from "./cleanup";

beforeEach(() => {
  mods.wipeNativeFiles.mockReset().mockResolvedValue(undefined);
  mods.unregisterCurrentPushDevice.mockReset().mockResolvedValue(undefined);
});

describe("native cleanup", () => {
  it("beforeNativeSignOut removes the push device (needs the bearer, so it runs first)", async () => {
    await beforeNativeSignOut();
    expect(mods.unregisterCurrentPushDevice).toHaveBeenCalledTimes(1);
    expect(mods.wipeNativeFiles).not.toHaveBeenCalled();
  });

  it("wipeNativeLocalData deletes the working copies of photos", async () => {
    await wipeNativeLocalData();
    expect(mods.wipeNativeFiles).toHaveBeenCalledTimes(1);
  });
});
