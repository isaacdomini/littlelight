import { NATIVE_UPLOAD_PICK_MAX } from "@littlelight/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Photo selection (docs/plans/step-9.md 2.6, 2.15): originals (no transcoding), copied into
// app-private storage, outcomes mapped for the UI.

const FP = vi.hoisted(() => ({ pickImages: vi.fn() }));
const CAM = vi.hoisted(() => ({ takePhoto: vi.fn() }));
const FS = vi.hoisted(() => ({ stat: vi.fn() }));
const files = vi.hoisted(() => ({ copyIntoUploadCache: vi.fn() }));
vi.mock("@capawesome/capacitor-file-picker", () => ({ FilePicker: FP }));
vi.mock("@capacitor/camera", () => ({ Camera: CAM }));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: FS }));
vi.mock("./files", () => files);

import { pickPhotos, takePhoto } from "./picker";

const picked = (name: string, extra: object = {}) => ({
  path: `/tmp/${name}`,
  name,
  mimeType: "image/heic",
  size: 100,
  ...extra,
});

beforeEach(() => {
  FP.pickImages.mockReset();
  CAM.takePhoto.mockReset();
  FS.stat.mockReset().mockResolvedValue({ size: 4321 });
  files.copyIntoUploadCache
    .mockReset()
    .mockImplementation(async (s: { path: string; name: string; mime: string; size: number }) => ({
      path: `file:///cache/ll-uploads/${s.name}`,
      name: s.name,
      mime: s.mime,
      size: s.size,
    }));
});

describe("pickPhotos", () => {
  it("asks for originals (no transcoding, no data read) and caps the count at 500", async () => {
    FP.pickImages.mockResolvedValue({ files: [] });
    await pickPhotos(10_000);
    expect(FP.pickImages).toHaveBeenCalledWith({
      limit: NATIVE_UPLOAD_PICK_MAX,
      readData: false,
      skipTranscoding: true,
    });
    expect(NATIVE_UPLOAD_PICK_MAX).toBe(500);
    await pickPhotos(20);
    expect(FP.pickImages.mock.calls[1]?.[0].limit).toBe(20);
  });

  it("copies every pick into app-private cache and returns the references", async () => {
    FP.pickImages.mockResolvedValue({
      files: [picked("a.heic"), picked("b.jpg", { mimeType: "image/jpeg" })],
    });
    const out = await pickPhotos();
    expect(out).toMatchObject({ status: "picked", failed: 0 });
    if (out.status !== "picked") throw new Error("unreachable");
    expect(out.files.map((f) => f.name)).toEqual(["a.heic", "b.jpg"]);
    expect(files.copyIntoUploadCache).toHaveBeenCalledWith({
      path: "/tmp/a.heic",
      name: "a.heic",
      mime: "image/heic",
      size: 100,
    });
  });

  it("counts picks without a path or that fail to copy, and keeps the rest", async () => {
    FP.pickImages.mockResolvedValue({
      files: [
        picked("a.jpg"),
        { name: "nopath.jpg", mimeType: "image/jpeg", size: 1 },
        picked("c.jpg"),
      ],
    });
    files.copyIntoUploadCache.mockImplementation(
      async (s: { name: string; path: string; mime: string; size: number }) => {
        if (s.name === "c.jpg") throw new Error("disk full");
        return { path: `file:///x/${s.name}`, name: s.name, mime: s.mime, size: s.size };
      },
    );
    const out = await pickPhotos();
    expect(out).toMatchObject({ status: "picked", failed: 2 });
    if (out.status === "picked") expect(out.files).toHaveLength(1);
  });

  it("an empty pick is a cancel", async () => {
    FP.pickImages.mockResolvedValue({ files: [] });
    expect(await pickPhotos()).toEqual({ status: "cancelled" });
  });

  it("all picks failing is 'picked' with zero files so the UI can explain", async () => {
    FP.pickImages.mockResolvedValue({
      files: [{ name: "x.jpg", mimeType: "image/jpeg", size: 1 }],
    });
    expect(await pickPhotos()).toEqual({ status: "picked", files: [], failed: 1 });
  });

  it.each([
    ["pickerDismissed", "cancelled"],
    ["User cancelled photos app", "cancelled"],
    ["Permission denied", "denied"],
    ["access denied by user", "denied"],
    ["something broke", "error"],
  ])("maps the error %j to %s", async (message, status) => {
    FP.pickImages.mockRejectedValue(new Error(message));
    expect(await pickPhotos()).toEqual({ status });
  });

  it("maps a non-Error rejection to error", async () => {
    FP.pickImages.mockRejectedValue("nope");
    expect(await pickPhotos()).toEqual({ status: "error" });
  });
});

describe("takePhoto", () => {
  it("takes a full-quality photo that is not saved to the gallery, and copies it", async () => {
    CAM.takePhoto.mockResolvedValue({ uri: "file:///var/tmp/IMG.jpeg" });
    const out = await takePhoto();
    expect(CAM.takePhoto).toHaveBeenCalledWith({
      quality: 100,
      saveToGallery: false,
      correctOrientation: true,
    });
    expect(out.status).toBe("picked");
    if (out.status !== "picked") throw new Error("unreachable");
    expect(out.failed).toBe(0);
    expect(out.files).toHaveLength(1);
    const arg = files.copyIntoUploadCache.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ path: "file:///var/tmp/IMG.jpeg", mime: "image/jpeg", size: 4321 });
    expect(arg.name).toMatch(/^Camera-.*\.jpeg$/);
    expect(arg.name).not.toMatch(/[:.].*[:.]\./);
  });

  it.each([
    ["x.png", "image/png"],
    ["x.heic", "image/heic"],
    ["x.jpg", "image/jpeg"],
  ])("derives the mime from %s", async (name, mime) => {
    CAM.takePhoto.mockResolvedValue({ uri: `file:///tmp/${name}` });
    await takePhoto();
    expect(files.copyIntoUploadCache.mock.calls[0]?.[0].mime).toBe(mime);
  });

  it("falls back to webPath, and is an error with neither", async () => {
    CAM.takePhoto.mockResolvedValue({ webPath: "capacitor://localhost/_f_/x.jpg" });
    expect((await takePhoto()).status).toBe("picked");
    CAM.takePhoto.mockResolvedValue({});
    expect(await takePhoto()).toEqual({ status: "error" });
  });

  it.each([
    ["User cancelled photos app", "cancelled"],
    ["User denied access to camera", "denied"],
    ["camera exploded", "error"],
  ])("maps the error %j to %s", async (message, status) => {
    CAM.takePhoto.mockRejectedValue(new Error(message));
    expect(await takePhoto()).toEqual({ status });
  });
});
