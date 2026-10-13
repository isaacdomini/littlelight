import { UPLOAD_MAX_FILE_BYTES, VIDEO_LIMITS } from "@tinyglow/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maxBytesFor,
  mediaKindOf,
  readVideoDuration,
  readVideoDurationFromUrl,
  validateDuration,
  validateFile,
} from "./validate";

// Client-side pre-flight for the picker (docs/plans/step-12.md 2.8): kind by mime or extension,
// photos capped at 100 MiB, videos at the plan's per-clip cap, and `video_too_long` once the
// duration is known. Rejections never block the other files.

const MIB = 1024 * 1024;
const file = (name: string, type: string, size: number) =>
  ({ name, type, size }) as unknown as File;

describe("mediaKindOf", () => {
  it("video by mime, video by extension when the mime is empty (QuickTime from Safari), else photo", () => {
    expect(mediaKindOf(file("a.mp4", "video/mp4", 1))).toBe("video");
    expect(mediaKindOf(file("a.MOV", "", 1))).toBe("video");
    expect(mediaKindOf(file("a.m4v", "", 1))).toBe("video");
    expect(mediaKindOf(file("a.jpg", "image/jpeg", 1))).toBe("photo");
    expect(mediaKindOf(file("a.heic", "", 1))).toBe("photo");
  });
});

describe("maxBytesFor", () => {
  it("photos: 100 MiB whatever the plan; videos: the plan's cap, the Plus cap when the plan is unknown", () => {
    expect(maxBytesFor("photo", "free")).toBe(UPLOAD_MAX_FILE_BYTES);
    expect(maxBytesFor("photo", undefined)).toBe(UPLOAD_MAX_FILE_BYTES);
    expect(maxBytesFor("video", "free")).toBe(VIDEO_LIMITS.free.maxBytes);
    expect(maxBytesFor("video", "plus")).toBe(VIDEO_LIMITS.plus.maxBytes);
    expect(maxBytesFor("video", undefined)).toBe(VIDEO_LIMITS.plus.maxBytes);
  });
});

describe("validateFile", () => {
  it("accepts photos and videos within their caps", () => {
    expect(validateFile(file("a.jpg", "image/jpeg", 10 * MIB), "free")).toBeNull();
    expect(validateFile(file("clip.mov", "video/quicktime", 200 * MIB), "free")).toBeNull();
    expect(validateFile(file("clip.mp4", "video/mp4", 1.5 * 1024 * MIB), "plus")).toBeNull();
  });

  it("too_large: a 101 MiB photo on any plan; a 251 MB video on free; 2 GB + 1 on plus", () => {
    expect(validateFile(file("a.jpg", "image/jpeg", UPLOAD_MAX_FILE_BYTES + 1), "plus")).toBe(
      "too_large",
    );
    expect(
      validateFile(file("clip.mp4", "video/mp4", VIDEO_LIMITS.free.maxBytes + 1), "free"),
    ).toBe("too_large");
    expect(
      validateFile(file("clip.mp4", "video/mp4", VIDEO_LIMITS.plus.maxBytes + 1), "plus"),
    ).toBe("too_large");
  });

  it("unsupported: non-media mimes and unknown extensions; .webm is not accepted", () => {
    expect(validateFile(file("a.pdf", "application/pdf", 1), "free")).toBe("unsupported");
    expect(validateFile(file("a.webm", "video/webm", 1), "free")).toBe("unsupported");
    expect(validateFile(file("a.txt", "", 1), "free")).toBe("unsupported");
  });
});

describe("validateDuration", () => {
  it("video_too_long over the plan's seconds; null when unknown", () => {
    expect(validateDuration(61_000, "free")).toBe("video_too_long");
    expect(validateDuration(60_000, "free")).toBeNull();
    // whole seconds, rounded, like the server: a "1:00" clip of 60.4 s is within 60 s
    expect(validateDuration(60_400, "free")).toBeNull();
    expect(validateDuration(60_500, "free")).toBe("video_too_long");
    expect(validateDuration(300_400, "plus")).toBeNull();
    expect(validateDuration(300_600, "plus")).toBe("video_too_long");
    expect(validateDuration(301_000, "plus")).toBe("video_too_long");
    expect(validateDuration(300_000, "plus")).toBeNull();
    expect(validateDuration(undefined, "free")).toBeNull();
    expect(validateDuration(90_000, undefined)).toBeNull();
  });
});

describe("readVideoDurationFromUrl / readVideoDuration (metadata-only <video>)", () => {
  /** A stand-in <video> the module drives: the test fires the events it is waiting for. */
  function fakeVideo() {
    const el = {
      preload: "",
      muted: false,
      src: "",
      duration: Number.NaN,
      onloadedmetadata: null as (() => void) | null,
      onerror: null as (() => void) | null,
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    vi.spyOn(document, "createElement").mockReturnValueOnce(el as unknown as HTMLVideoElement);
    return el;
  }
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("(7) resolves Math.round(seconds × 1000) on loadedmetadata, loading metadata only, muted, and detaches the element", async () => {
    const el = fakeVideo();
    const p = readVideoDurationFromUrl("capacitor://localhost/_capacitor_file_/x.mov");
    expect(el.preload).toBe("metadata");
    expect(el.muted).toBe(true);
    expect(el.src).toBe("capacitor://localhost/_capacitor_file_/x.mov");
    el.duration = 12.3456;
    el.onloadedmetadata?.();
    await expect(p).resolves.toBe(12_346);
    expect(el.removeAttribute).toHaveBeenCalledWith("src");
    expect(el.load).toHaveBeenCalledTimes(1);
    expect(el.onloadedmetadata).toBeNull();
    expect(el.onerror).toBeNull();
  });

  it("(7b) a non-finite or zero duration, an error event, or the 8 s timeout resolve undefined (never throws)", async () => {
    const inf = fakeVideo();
    const pInf = readVideoDurationFromUrl("blob:a");
    inf.duration = Number.POSITIVE_INFINITY;
    inf.onloadedmetadata?.();
    await expect(pInf).resolves.toBeUndefined();

    const err = fakeVideo();
    const pErr = readVideoDurationFromUrl("blob:b");
    err.onerror?.();
    await expect(pErr).resolves.toBeUndefined();

    vi.useFakeTimers();
    const slow = fakeVideo();
    const pSlow = readVideoDurationFromUrl("blob:c");
    await vi.advanceTimersByTimeAsync(7_999);
    let settled = false;
    void pSlow.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pSlow).resolves.toBeUndefined();
    expect(slow.removeAttribute).toHaveBeenCalledWith("src");
    vi.useRealTimers();

    const thrower = fakeVideo();
    Object.defineProperty(thrower, "src", {
      set() {
        throw new Error("bad url");
      },
    });
    await expect(readVideoDurationFromUrl("x")).resolves.toBeUndefined();
  });

  it("(7c) readVideoDuration(blob) hands an object URL to the reader and revokes it on success and on failure", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-1");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const blob = new Blob([new Uint8Array(8)], { type: "video/mp4" });

    const ok = fakeVideo();
    const pOk = readVideoDuration(blob);
    expect(create).toHaveBeenCalledWith(blob);
    expect(ok.src).toBe("blob:fake-1");
    ok.duration = 2;
    ok.onloadedmetadata?.();
    await expect(pOk).resolves.toBe(2_000);
    expect(revoke).toHaveBeenCalledWith("blob:fake-1");

    const bad = fakeVideo();
    const pBad = readVideoDuration(blob);
    bad.onerror?.();
    await expect(pBad).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(2);

    create.mockImplementationOnce(() => {
      throw new Error("no object urls");
    });
    await expect(readVideoDuration(blob)).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
