import { describe, expect, it } from "vitest";
import { analysisImage, craftJpeg, craftWebp } from "../../../e2e/fixtures/ai-images";
import type { AiRequestError } from "./errors";
import { assertAnalysisImage, readImageInfo, toBase64, toDataUrl } from "./image";

const img = (over: Record<string, unknown> = {}) => ({ ...analysisImage(), ...over }) as never;
const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return (e as AiRequestError).code;
  }
  return null;
};

describe("readImageInfo", () => {
  it("reads JPEG and WebP headers", () => {
    expect(readImageInfo(craftJpeg(640, 480))).toEqual({
      type: "image/jpeg",
      width: 640,
      height: 480,
    });
    expect(readImageInfo(craftWebp(500, 300))).toEqual({
      type: "image/webp",
      width: 500,
      height: 300,
    });
  });
  it("returns null for junk, truncated and PNG", () => {
    expect(readImageInfo(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readImageInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
    expect(readImageInfo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("assertAnalysisImage", () => {
  it("accepts a 768 px JPEG and WebP", () => {
    expect(() => assertAnalysisImage(analysisImage())).not.toThrow();
    expect(() =>
      assertAnalysisImage({
        bytes: craftWebp(768, 400),
        mimeType: "image/webp",
        width: 768,
        height: 400,
      }),
    ).not.toThrow();
  });
  it("rejects a long edge over 768 px (display copy)", () => {
    expect(
      code(() =>
        assertAnalysisImage({
          bytes: craftJpeg(769, 500),
          mimeType: "image/jpeg",
          width: 769,
          height: 500,
        }),
      ),
    ).toBe("image_too_large");
    expect(
      code(() =>
        assertAnalysisImage({
          bytes: craftJpeg(1600, 1200),
          mimeType: "image/jpeg",
          width: 1600,
          height: 1200,
        }),
      ),
    ).toBe("image_too_large");
  });
  it("rejects more than 400 KB", () => {
    expect(
      code(() =>
        assertAnalysisImage({
          bytes: craftJpeg(768, 576, 400_001),
          mimeType: "image/jpeg",
          width: 768,
          height: 576,
        }),
      ),
    ).toBe("image_too_many_bytes");
    expect(() =>
      assertAnalysisImage({
        bytes: craftJpeg(768, 576, 400_000),
        mimeType: "image/jpeg",
        width: 768,
        height: 576,
      }),
    ).not.toThrow();
  });
  it("rejects a header / declared size mismatch and a type mismatch", () => {
    expect(code(() => assertAnalysisImage(img({ width: 700 })))).toBe("image_dimensions_mismatch");
    expect(code(() => assertAnalysisImage(img({ mimeType: "image/webp" })))).toBe("image_bad_type");
    expect(code(() => assertAnalysisImage(img({ mimeType: "image/png" })))).toBe("image_bad_type");
  });
  it("rejects empty bytes, bad dimensions and non-image bytes", () => {
    expect(code(() => assertAnalysisImage(img({ bytes: new Uint8Array(0) })))).toBe(
      "image_bad_type",
    );
    expect(code(() => assertAnalysisImage(img({ width: 0 })))).toBe("image_bad_dimensions");
    expect(code(() => assertAnalysisImage(img({ width: 1.5 })))).toBe("image_bad_dimensions");
    expect(code(() => assertAnalysisImage(img({ bytes: new Uint8Array(100).fill(7) })))).toBe(
      "image_bad_type",
    );
  });
  it("errors never carry bytes", () => {
    try {
      assertAnalysisImage(img({ width: 700 }));
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/\d{5,}/);
    }
  });
});

describe("encoding", () => {
  it("data URL has the mime prefix and round-trips", () => {
    const i = analysisImage();
    const url = toDataUrl(i);
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(Buffer.from(url.split(",")[1] as string, "base64").equals(Buffer.from(i.bytes))).toBe(
      true,
    );
    expect(toBase64(i)).toBe(url.split(",")[1]);
  });
});
