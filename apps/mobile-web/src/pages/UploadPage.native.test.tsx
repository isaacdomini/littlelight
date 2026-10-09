import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../testing/native";
import { ionReady, renderApp } from "../testing/render";

// Upload screen on native (docs/plans/step-9.md 2.6, 2.15): native picker and camera instead of
// file inputs, the picked refs go to `uploadManager.addNative`, errors are explained, the push
// primer appears after a finished upload.

const BABY = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Mia",
  nickname: null,
  role: "admin",
  plan: "plus",
};
const ui = vi.hoisted(() => ({
  items: [] as unknown[],
  summary: { uploaded: 0, failed: 0, duplicates: 0, total: 0, active: 0 },
}));
const manager = vi.hoisted(() => ({
  add: vi.fn(),
  addNative: vi.fn(),
  resume: vi.fn(),
  retry: vi.fn(),
  retryFailed: vi.fn(),
  cancel: vi.fn(),
  clearFinished: vi.fn(),
}));
const picker = vi.hoisted(() => ({ pickPhotos: vi.fn(), takePhoto: vi.fn() }));
const haptic = vi.hoisted(() => ({ hapticSuccess: vi.fn() }));
const primer = vi.hoisted(() => ({ lastProps: null as null | { uploaded: boolean } }));

vi.mock("../auth/AuthProvider", () => ({
  useCurrentBaby: () => ({ baby: BABY, babies: [BABY], setCurrentBabyId: vi.fn() }),
  useAuth: () => ({ me: null }),
}));
vi.mock("../lib/queries", () => ({ usePhotosInvalidation: () => undefined }));
vi.mock("../lib/upload/manager", () => ({
  uploadManager: manager,
  hasResumableUpload: () => false,
  clearResumableUpload: vi.fn(),
}));
vi.mock("../lib/upload/useUploads", () => ({
  useUploadItems: () => ({ items: ui.items, summary: ui.summary }),
}));
vi.mock("../platform/native/picker", () => picker);
vi.mock("../lib/haptics", () => haptic);
vi.mock("../components/PushPrimer", () => ({
  PushPrimer: (p: { uploaded: boolean }) => {
    primer.lastProps = p;
    return <div data-testid="push-primer-stub">{String(p.uploaded)}</div>;
  },
}));
vi.mock("../components/UploadRow", () => ({ UploadRow: () => <li data-testid="upload-row" /> }));

import { UploadPage } from "./UploadPage";

const ref = (name: string) => ({
  path: `file:///cache/${name}`,
  name,
  mime: "image/jpeg",
  size: 1000,
});

beforeEach(() => {
  ui.items = [];
  ui.summary = { uploaded: 0, failed: 0, duplicates: 0, total: 0, active: 0 };
  for (const fn of Object.values(manager)) fn.mockReset();
  picker.pickPhotos.mockReset().mockResolvedValue({ status: "cancelled" });
  picker.takePhoto.mockReset().mockResolvedValue({ status: "cancelled" });
  haptic.hapticSuccess.mockReset();
  primer.lastProps = null;
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

describe("UploadPage on native", () => {
  it("shows the native Choose photos and Take photo buttons and no web file inputs or drop hint", async () => {
    setNativePlatform("ios");
    const { container } = await open();
    expect(screen.getByTestId("upload-choose").textContent).toBe("Choose photos");
    expect(screen.getByTestId("upload-camera").textContent).toContain("Take photo");
    expect(screen.queryByTestId("upload-input")).toBeNull();
    expect(screen.queryByTestId("upload-resume-input")).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.textContent).not.toMatch(/drag|drop/i);
    expect(screen.getByTestId("upload-background-note")).toBeTruthy();
  });

  it("the Android-only location note appears on Android, not on iOS", async () => {
    setNativePlatform("android");
    await open();
    expect(screen.getByTestId("upload-android-note")).toBeTruthy();
    cleanup();
    setNativePlatform("ios");
    await open();
    expect(screen.queryByTestId("upload-android-note")).toBeNull();
  });

  it("web (control): file inputs, no camera button", async () => {
    setNativePlatform(null);
    await open();
    expect(screen.getByTestId("upload-input")).toBeTruthy();
    expect(screen.queryByTestId("upload-camera")).toBeNull();
    expect(screen.queryByTestId("upload-background-note")).toBeNull();
  });

  it("picked photos go to uploadManager.addNative for the current baby (never add())", async () => {
    setNativePlatform("ios");
    const files = [ref("a.jpg"), ref("b.jpg")];
    picker.pickPhotos.mockResolvedValue({ status: "picked", files, failed: 0 });
    await open();
    fireEvent.click(screen.getByTestId("upload-choose"));
    await waitFor(() => expect(manager.addNative).toHaveBeenCalledTimes(1));
    expect(manager.addNative).toHaveBeenCalledWith(BABY.id, files, undefined);
    expect(manager.add).not.toHaveBeenCalled();
    expect(screen.queryByTestId("upload-pick-error")).toBeNull();
  });

  it("the details form (milestone/people/note/location) rides along with the picked photos", async () => {
    setNativePlatform("ios");
    picker.pickPhotos.mockResolvedValue({ status: "picked", files: [ref("a.jpg")], failed: 0 });
    await open();
    fireEvent.click(screen.getByTestId("upload-details-toggle"));
    fireEvent.change(screen.getByTestId("upload-note"), { target: { value: "  Beach day  " } });
    fireEvent.change(screen.getByTestId("upload-location"), { target: { value: "Pier" } });
    fireEvent.click(screen.getByTestId("upload-choose"));
    await waitFor(() => expect(manager.addNative).toHaveBeenCalled());
    expect(manager.addNative.mock.calls[0]?.[2]).toEqual({
      note: "Beach day",
      locationLabel: "Pier",
    });
  });

  it("the camera button uses takePhoto and addNative", async () => {
    setNativePlatform("android");
    const shot = [ref("Camera-1.jpg")];
    picker.takePhoto.mockResolvedValue({ status: "picked", files: shot, failed: 0 });
    await open();
    fireEvent.click(screen.getByTestId("upload-camera"));
    await waitFor(() => expect(manager.addNative).toHaveBeenCalledWith(BABY.id, shot, undefined));
    expect(picker.pickPhotos).not.toHaveBeenCalled();
  });

  it("a cancelled pick does nothing and shows nothing", async () => {
    setNativePlatform("ios");
    await open();
    fireEvent.click(screen.getByTestId("upload-choose"));
    await waitFor(() => expect(picker.pickPhotos).toHaveBeenCalled());
    expect(manager.addNative).not.toHaveBeenCalled();
    expect(screen.queryByTestId("upload-pick-error")).toBeNull();
  });

  it.each([
    ["library", "denied", "upload-choose", "Littlelight can't open your photos"],
    ["camera", "denied", "upload-camera", "Littlelight can't use the camera"],
    ["library", "error", "upload-choose", "Couldn't get those photos"],
    ["camera", "error", "upload-camera", "Couldn't get those photos"],
  ])("a %s %s outcome explains itself and adds nothing", async (_src, status, button, text) => {
    setNativePlatform("ios");
    picker.pickPhotos.mockResolvedValue({ status });
    picker.takePhoto.mockResolvedValue({ status });
    await open();
    fireEvent.click(screen.getByTestId(button));
    const msg = await screen.findByTestId("upload-pick-error");
    expect(msg.textContent).toContain(text);
    expect(manager.addNative).not.toHaveBeenCalled();
  });

  it("photos that could not be read are counted in a message while the rest are queued", async () => {
    setNativePlatform("ios");
    picker.pickPhotos.mockResolvedValue({ status: "picked", files: [ref("a.jpg")], failed: 3 });
    await open();
    fireEvent.click(screen.getByTestId("upload-choose"));
    const msg = await screen.findByTestId("upload-pick-error");
    expect(msg.textContent).toContain("3 photos couldn't be read");
    expect(manager.addNative).toHaveBeenCalledTimes(1);
  });

  it("buttons are disabled while a pick is open (no double picker)", async () => {
    setNativePlatform("ios");
    let finish: (v: unknown) => void = () => undefined;
    picker.pickPhotos.mockReturnValue(new Promise((r) => (finish = r)));
    await open();
    fireEvent.click(screen.getByTestId("upload-choose"));
    await waitFor(() =>
      expect((screen.getByTestId("upload-choose") as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByTestId("upload-camera") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("upload-choose"));
    expect(picker.pickPhotos).toHaveBeenCalledTimes(1);
    finish({ status: "cancelled" });
    await waitFor(() =>
      expect((screen.getByTestId("upload-choose") as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

describe("UploadPage: push primer and haptics", () => {
  it("offers the primer only when something uploaded and nothing is still active", async () => {
    setNativePlatform("ios");
    ui.items = [{ clientId: "1", babyId: BABY.id, state: "ingested" }];
    ui.summary = { uploaded: 1, failed: 0, duplicates: 0, total: 1, active: 0 };
    await open();
    expect(primer.lastProps).toEqual({ uploaded: true });
    cleanup();
    ui.summary = { uploaded: 1, failed: 0, duplicates: 0, total: 2, active: 1 };
    await open();
    expect(primer.lastProps).toEqual({ uploaded: false });
  });

  it("is not rendered at all before there is any item", async () => {
    setNativePlatform("ios");
    await open();
    expect(screen.queryByTestId("push-primer-stub")).toBeNull();
  });
});
