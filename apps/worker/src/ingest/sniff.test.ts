import { describe, expect, it } from "vitest";
import { ftypBuffer, noiseJpeg, sceneJpeg, scenePng, sceneWebp } from "../testing/images";
import { isHeif, sniffPhotoMime } from "./sniff";

describe("sniffPhotoMime (magic bytes only)", () => {
  it("recognises JPEG, PNG and WebP", async () => {
    expect(await sniffPhotoMime(await sceneJpeg(64, 48, 1))).toBe("image/jpeg");
    expect(await sniffPhotoMime(await scenePng(64, 48, 1))).toBe("image/png");
    expect(await sniffPhotoMime(await sceneWebp(64, 48, 1))).toBe("image/webp");
  });

  it.each(["heic", "heix", "hevc", "hevx", "heim", "heis"])(
    "ftyp brand %s is image/heic",
    async (brand) => {
      expect(await sniffPhotoMime(ftypBuffer(brand))).toBe("image/heic");
    },
  );

  it.each(["mif1", "msf1", "heif"])("ftyp brand %s is image/heif", async (brand) => {
    expect(await sniffPhotoMime(ftypBuffer(brand))).toBe("image/heif");
  });

  it.each([
    ["AVIF", ftypBuffer("avif")],
    ["AVIF sequence", ftypBuffer("avis")],
    ["MP4 video", ftypBuffer("isom")],
    ["QuickTime movie", ftypBuffer("qt")],
    ["GIF89a", Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)])],
    ["GIF87a", Buffer.concat([Buffer.from("GIF87a"), Buffer.alloc(32)])],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')],
    [
      "SVG with xml prolog",
      Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
    ],
    ["PDF", Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n", "latin1")],
    ["plain text", Buffer.from("hello, this is not a photo\n")],
    ["text named .jpg", Buffer.from("I am a text file with a .jpg extension")],
    ["HTML", Buffer.from("<!doctype html><html><body>x</body></html>")],
    ["ZIP", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["empty", Buffer.alloc(0)],
    ["truncated (1 byte)", Buffer.from([0xff])],
    ["zeros", Buffer.alloc(64)],
  ])("rejects %s", async (_name, buf) => {
    expect(await sniffPhotoMime(buf)).toBeNull();
  });

  it("ignores everything but the bytes: a JPEG is a JPEG whatever the caller claimed", async () => {
    // (the function takes no hint at all; this documents that a renamed file is judged on content)
    expect(await sniffPhotoMime(await noiseJpeg(32, 32, 3))).toBe("image/jpeg");
  });

  it("detection is by signature only: a truncated JPEG still sniffs as JPEG (the decoder rejects it later)", async () => {
    expect(await sniffPhotoMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  });

  it("a PNG prefix that is actually truncated garbage is still treated by its signature only", async () => {
    const png = await scenePng(32, 32, 2);
    expect(await sniffPhotoMime(png.subarray(0, 64))).toBe("image/png");
  });

  it("isHeif is true for heic and heif only", () => {
    expect(isHeif("image/heic")).toBe(true);
    expect(isHeif("image/heif")).toBe(true);
    expect(isHeif("image/jpeg")).toBe(false);
    expect(isHeif("image/webp")).toBe(false);
  });
});
