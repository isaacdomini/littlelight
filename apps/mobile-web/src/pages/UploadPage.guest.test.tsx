import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../testing/native";
import { ionReady, renderApp } from "../testing/render";

// Upload screen for guests (docs/plans/step-11.md 2.8, 2.9): contributors get a one-line note
// that their photos wait for approval and count toward the family's free photos once approved;
// parents do not.

const cur = vi.hoisted(() => ({
  baby: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Mia",
    nickname: null,
    role: "contributor" as "admin" | "contributor",
    plan: "plus",
  },
}));
vi.mock("../auth/AuthProvider", () => ({
  useCurrentBaby: () => ({ baby: cur.baby, babies: [cur.baby], setCurrentBabyId: vi.fn() }),
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
vi.mock("../components/UploadRow", () => ({ UploadRow: () => <li data-testid="upload-row" /> }));
vi.mock("../components/PushPrimer", () => ({ PushPrimer: () => null }));

import { UploadPage } from "./UploadPage";

beforeEach(() => {
  cur.baby = { ...cur.baby, role: "contributor", plan: "plus" };
  setNativePlatform(null);
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

async function open() {
  const r = renderApp(<UploadPage />, { route: "/upload" });
  await ionReady(r.container);
  return r;
}

describe("guest upload note", () => {
  it("contributors see that photos wait for a parent's approval and count once approved", async () => {
    await open();
    const note = screen.getByTestId("upload-guest-note").textContent ?? "";
    expect(note).toMatch(/wait for a parent's approval/i);
    expect(note).toMatch(/count toward the family's free photos once approved/i);
  });

  it("parents (admins) do not see it", async () => {
    cur.baby = { ...cur.baby, role: "admin" };
    await open();
    expect(screen.queryByTestId("upload-guest-note")).toBeNull();
  });

  it("native guests see it too", async () => {
    setNativePlatform("ios");
    await open();
    expect(screen.getByTestId("upload-guest-note")).toBeTruthy();
  });
});
