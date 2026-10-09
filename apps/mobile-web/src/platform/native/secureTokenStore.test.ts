import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keychain/Keystore token store (docs/plans/step-9.md 2.5, 2.15): never touches localStorage or
// sessionStorage, degrades to memory when the plugin is missing, and uses the this-device-only
// keychain class.

const secure = {
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
};

vi.mock("@aparajita/capacitor-secure-storage", () => ({
  SecureStorage: secure,
  KeychainAccess: { afterFirstUnlockThisDeviceOnly: 2, whenUnlocked: 0 },
}));

const tokens = { accessToken: "access-123", refreshToken: "refresh-456" };

let storageSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.resetModules();
  secure.get.mockReset();
  secure.set.mockReset().mockResolvedValue(undefined);
  secure.remove.mockReset().mockResolvedValue(undefined);
  storageSpies = [
    vi.spyOn(Storage.prototype, "getItem"),
    vi.spyOn(Storage.prototype, "setItem"),
    vi.spyOn(Storage.prototype, "removeItem"),
  ];
});
afterEach(() => vi.restoreAllMocks());

async function store() {
  const { createSecureTokenStore } = await import("./secureTokenStore");
  return createSecureTokenStore();
}

describe("secureTokenStore", () => {
  it("stores one JSON entry in the Keychain with afterFirstUnlockThisDeviceOnly", async () => {
    const s = await store();
    await s.set(tokens);
    expect(secure.set).toHaveBeenCalledTimes(1);
    const [key, value, convert, sync, access] = secure.set.mock.calls[0] ?? [];
    expect(key).toBe("ll.session.v1");
    expect(JSON.parse(value as string)).toEqual(tokens);
    expect(convert).toBe(false);
    expect(sync).toBe(false); // no iCloud Keychain sync
    expect(access).toBe(2);
  });

  it("reads back what the Keychain holds (JSON string or object) and caches it", async () => {
    secure.get.mockResolvedValue(JSON.stringify(tokens));
    const s = await store();
    expect(await s.get()).toEqual(tokens);
    expect(await s.get()).toEqual(tokens);
    expect(secure.get).toHaveBeenCalledTimes(1);

    vi.resetModules();
    secure.get.mockResolvedValue(tokens);
    expect(await (await store()).get()).toEqual(tokens);
  });

  it("keeps only the two token fields", async () => {
    secure.get.mockResolvedValue(JSON.stringify({ ...tokens, extra: "x" }));
    expect(await (await store()).get()).toEqual(tokens);
  });

  it.each([
    ["nothing stored", null],
    ["corrupt JSON", "{not json"],
    ["a wrong shape", JSON.stringify({ accessToken: 1, refreshToken: "x" })],
    ["a missing refresh token", JSON.stringify({ accessToken: "a" })],
    ["a number", 7],
  ])("treats %s as signed out", async (_n, raw) => {
    secure.get.mockResolvedValue(raw);
    expect(await (await store()).get()).toBeNull();
  });

  it("clear() removes the entry and later reads are empty", async () => {
    const s = await store();
    await s.set(tokens);
    await s.clear();
    expect(secure.remove).toHaveBeenCalledWith("ll.session.v1", false);
    expect(await s.get()).toBeNull();
  });

  it("clear() works even when the plugin throws", async () => {
    secure.remove.mockRejectedValue(new Error("nothing"));
    const s = await store();
    await s.set(tokens);
    await expect(s.clear()).resolves.toBeUndefined();
    expect(await s.get()).toBeNull();
  });

  it("degrades to memory for this launch when the plugin fails, and never falls back to web storage", async () => {
    secure.get.mockRejectedValue(new Error("plugin missing"));
    secure.set.mockRejectedValue(new Error("plugin missing"));
    const s = await store();
    expect(await s.get()).toBeNull();
    await s.set(tokens);
    expect(await s.get()).toEqual(tokens);
    // a broken plugin is not retried on every call
    secure.set.mockClear();
    await s.set({ accessToken: "a2", refreshToken: "r2" });
    expect(secure.set).not.toHaveBeenCalled();
    expect(await s.get()).toEqual({ accessToken: "a2", refreshToken: "r2" });
    await s.clear();
  });

  it("never touches localStorage or sessionStorage in any path", async () => {
    secure.get.mockResolvedValueOnce(JSON.stringify(tokens));
    const s = await store();
    await s.get();
    await s.set(tokens);
    await s.clear();
    secure.set.mockRejectedValue(new Error("x"));
    await s.set(tokens);
    for (const spy of storageSpies) expect(spy).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
