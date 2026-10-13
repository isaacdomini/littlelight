import { afterEach, describe, expect, it, vi } from "vitest";

// Native working copies (docs/plans/step-9.md 2.6; step 12 iOS fix): a video's duration is read
// from a metadata-only <video> on the WebView file URL (`convertFileSrc`), never by fetching the
// file; a missing Capacitor bridge means "no hint" (undefined), not an error.

const validate = vi.hoisted(() => ({ readVideoDurationFromUrl: vi.fn() }));
vi.mock("../../lib/upload/validate", () => validate);

import { fileFromRef, nativeVideoDuration } from "./files";

const ref = {
  path: "file:///cache/ll-uploads/abc.mov",
  name: "clip.mov",
  mime: "video/quicktime",
  size: 10,
};

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { Capacitor?: unknown }).Capacitor = undefined;
});

describe("nativeVideoDuration", () => {
  it("(6) reads the duration from readVideoDurationFromUrl(convertFileSrc(path)), never fetching the file", async () => {
    const convertFileSrc = vi.fn((p: string) => `capacitor://localhost/_capacitor_file_${p}`);
    (globalThis as { Capacitor?: unknown }).Capacitor = { convertFileSrc };
    validate.readVideoDurationFromUrl.mockResolvedValueOnce(12_000);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(nativeVideoDuration(ref)).resolves.toBe(12_000);
    expect(convertFileSrc).toHaveBeenCalledWith(ref.path);
    expect(validate.readVideoDurationFromUrl).toHaveBeenCalledWith(
      `capacitor://localhost/_capacitor_file_${ref.path}`,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("(6b) convertFileSrc throwing (no Capacitor bridge) resolves undefined without calling the reader; a reader answering undefined passes through", async () => {
    await expect(nativeVideoDuration(ref)).resolves.toBeUndefined();
    expect(validate.readVideoDurationFromUrl).not.toHaveBeenCalled();
    (globalThis as { Capacitor?: unknown }).Capacitor = { convertFileSrc: () => "x://y" };
    validate.readVideoDurationFromUrl.mockResolvedValueOnce(undefined);
    await expect(nativeVideoDuration(ref)).resolves.toBeUndefined();
  });
});

describe("fileFromRef (photos only)", () => {
  it("fetches the converted file URL into a File with the ref's name and mime; a non-ok response throws", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      convertFileSrc: (p: string) => `cap://${p}`,
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const f = await fileFromRef({ ...ref, name: "IMG.jpg", mime: "image/jpeg" });
    expect(fetchSpy).toHaveBeenCalledWith(`cap://${ref.path}`);
    expect(f.name).toBe("IMG.jpg");
    expect(f.type).toBe("image/jpeg");
    expect(f.size).toBe(3);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(fileFromRef({ ...ref, name: "IMG.jpg", mime: "image/jpeg" })).rejects.toThrow(
      "native file unreadable",
    );
  });
});
