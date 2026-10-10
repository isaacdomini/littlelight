import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../testing/native";
import { ionReady, renderApp } from "../testing/render";

// Upload screen, photo import (docs/plans/step-10.md 2.11): the Google card appears only when the
// server offers it and the user can add photos; the album-sync card only for admins in the iPhone
// app; the web bundle never asks for the sync chunk.

const state = vi.hoisted(() => ({ role: "admin" as string }));
vi.mock("../auth/AuthProvider", () => ({
  useCurrentBaby: () => ({
    baby: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Mia",
      nickname: null,
      role: state.role,
      plan: "plus",
    },
    babies: [],
    setCurrentBabyId: vi.fn(),
  }),
  useAuth: () => ({ me: null }),
}));
vi.mock("../lib/queries", () => ({ usePhotosInvalidation: () => undefined }));
vi.mock("../lib/upload/manager", () => ({
  uploadManager: {
    add: vi.fn(),
    addNative: vi.fn(),
    resume: vi.fn(),
    retry: vi.fn(),
    retryFailed: vi.fn(),
    cancel: vi.fn(),
    clearFinished: vi.fn(),
  },
  hasResumableUpload: () => false,
  clearResumableUpload: vi.fn(),
}));
vi.mock("../lib/upload/useUploads", () => ({
  useUploadItems: () => ({
    items: [],
    summary: { uploaded: 0, failed: 0, duplicates: 0, total: 0, active: 0 },
  }),
}));
vi.mock("../components/PushPrimer", () => ({ PushPrimer: () => null }));
vi.mock("../components/import/GoogleCard", () => ({
  GoogleCard: (p: { compact?: boolean; returnTo: string }) => (
    <div data-testid="google-card-stub">{`${p.compact ? "compact" : "full"}:${p.returnTo}`}</div>
  ),
}));
vi.mock("../components/import/SyncCard", () => ({
  SyncCard: (p: { compact?: boolean }) => (
    <div data-testid="sync-card-stub">{p.compact ? "compact" : "full"}</div>
  ),
}));

import { UploadPage } from "./UploadPage";

let available = true;

beforeEach(() => {
  state.role = "admin";
  available = true;
  stubFetch((c) =>
    c.url.endsWith("/me/import/google/connection")
      ? jsonResponse({ available, connected: false, connectedAt: null, needsReconnect: false })
      : jsonResponse({}, 404),
  );
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
  vi.unstubAllGlobals();
});

async function open() {
  const r = renderApp(<UploadPage />, { route: "/upload" });
  await ionReady(r.container);
  return r;
}

describe("Upload screen: Google Photos", () => {
  it("shown (compact, returning to /upload) when the server offers Google import", async () => {
    await open();
    await waitFor(() =>
      expect(screen.getByTestId("google-card-stub").textContent).toBe("compact:/upload"),
    );
  });

  it("hidden when the server has it off", async () => {
    available = false;
    await open();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("google-card-stub")).toBeNull();
  });

  it("a contributor sees it too (their photos wait for approval)", async () => {
    state.role = "contributor";
    await open();
    await waitFor(() => expect(screen.getByTestId("google-card-stub")).toBeTruthy());
  });

  it("a role that cannot add photos never even asks the server", async () => {
    state.role = "viewer";
    const { calls } = stubFetch(() => jsonResponse({}, 404));
    await open();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.url.includes("/import/google"))).toBe(false);
    expect(screen.queryByTestId("google-card-stub")).toBeNull();
  });
});

describe("Upload screen: Apple album sync", () => {
  it("iPhone admin: the compact sync card", async () => {
    setNativePlatform("ios");
    await open();
    await waitFor(() => expect(screen.getByTestId("sync-card-stub").textContent).toBe("compact"));
  });

  it.each([
    ["web", null, "admin"],
    ["Android", "android", "admin"],
    ["an iPhone contributor", "ios", "contributor"],
  ] as const)("not shown on %s", async (_n, platform, role) => {
    setNativePlatform(platform);
    state.role = role;
    await open();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("sync-card-stub")).toBeNull();
  });
});
