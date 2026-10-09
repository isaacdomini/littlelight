import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authUrl } from "./apiBase";

// API origin (docs/plans/step-9.md 2.3, 2.15): relative on the web, VITE_API_URL in the app.

function setNative(platform: "ios" | "android" | null) {
  (globalThis as { Capacitor?: unknown }).Capacitor = platform
    ? { isNativePlatform: () => true, getPlatform: () => platform }
    : undefined;
}

afterEach(() => {
  setNative(null);
  vi.unstubAllEnvs();
});

describe("apiUrl / authUrl", () => {
  it("on the web every URL is same-origin and relative, whatever VITE_API_URL says", () => {
    vi.stubEnv("VITE_API_URL", "https://api.example.test");
    expect(apiUrl("/me")).toBe("/api/me");
    expect(authUrl("/health")).toBe("/auth/health");
  });

  it("in the app they are prefixed with VITE_API_URL", () => {
    setNative("ios");
    vi.stubEnv("VITE_API_URL", "https://api.example.test");
    expect(apiUrl("/me")).toBe("https://api.example.test/api/me");
    expect(authUrl("/health")).toBe("https://api.example.test/auth/health");
  });

  it("trailing slashes on the origin are dropped", () => {
    setNative("android");
    vi.stubEnv("VITE_API_URL", "http://10.0.2.2:8080///");
    expect(apiUrl("/share/session")).toBe("http://10.0.2.2:8080/api/share/session");
  });

  it("a Capacitor object that says it is not native stays relative", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => false };
    vi.stubEnv("VITE_API_URL", "https://api.example.test");
    expect(apiUrl("/me")).toBe("/api/me");
  });

  it("a throwing Capacitor probe counts as web", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => {
        throw new Error("boom");
      },
    };
    expect(apiUrl("/me")).toBe("/api/me");
  });
});
