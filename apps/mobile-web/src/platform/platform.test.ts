import { afterEach, describe, expect, it } from "vitest";
import { clientKind, convertFileSrc, isNative, nativePlatform } from "./platform";

const set = (cap: unknown) => {
  (globalThis as { Capacitor?: unknown }).Capacitor = cap;
};
afterEach(() => set(undefined));

describe("platform probe", () => {
  it("is web without a Capacitor global", () => {
    expect(isNative()).toBe(false);
    expect(nativePlatform()).toBeNull();
    expect(clientKind()).toBe("web");
  });

  it("is native only when isNativePlatform() is exactly true", () => {
    set({ isNativePlatform: () => true, getPlatform: () => "ios" });
    expect(isNative()).toBe(true);
    expect(nativePlatform()).toBe("ios");
    expect(clientKind()).toBe("native");
    set({ isNativePlatform: () => "yes", getPlatform: () => "ios" });
    expect(isNative()).toBe(false);
  });

  it("nativePlatform is ios or android, null for anything else", () => {
    set({ isNativePlatform: () => true, getPlatform: () => "android" });
    expect(nativePlatform()).toBe("android");
    set({ isNativePlatform: () => true, getPlatform: () => "electron" });
    expect(nativePlatform()).toBeNull();
    set({ isNativePlatform: () => false, getPlatform: () => "ios" });
    expect(nativePlatform()).toBeNull();
  });

  it("convertFileSrc delegates and throws when unavailable", () => {
    set({
      isNativePlatform: () => true,
      convertFileSrc: (p: string) => `capacitor://localhost/_f_${p}`,
    });
    expect(convertFileSrc("/x/y.jpg")).toBe("capacitor://localhost/_f_/x/y.jpg");
    set({ isNativePlatform: () => true });
    expect(() => convertFileSrc("/x")).toThrow();
  });
});
