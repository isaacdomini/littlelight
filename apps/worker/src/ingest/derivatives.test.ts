import { DERIVATIVE_LONG_EDGE } from "@tinyglow/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { jpegWithExif } from "../testing/exif-writer";
import { sceneJpeg, transparentPng } from "../testing/images";
import { decodeImage } from "./decode";
import { renderDerivative } from "./derivatives";

const GPS_EXIF = {
  make: "Acme",
  model: "Cam",
  dateTimeOriginal: "2026:06:14 15:04:05",
  imageDescription: "Mia, 12 Elm Street",
  gps: { lat: 47.6062, lng: -122.3321 },
};

const bytesInclude = (buf: Buffer, needle: string) => buf.includes(Buffer.from(needle, "latin1"));

describe("renderDerivative", () => {
  it("scales the long edge to the plan's sizes (thumb 320, display 1600, analysis 768)", async () => {
    const src = await decodeImage(await sceneJpeg(3000, 2000, 1), "image/jpeg");
    const thumb = await renderDerivative(src, "thumb");
    const display = await renderDerivative(src, "display");
    const analysis = await renderDerivative(src, "analysis");
    expect([thumb.width, thumb.height]).toEqual([320, 213]);
    expect([display.width, display.height]).toEqual([1600, 1067]);
    expect([analysis.width, analysis.height]).toEqual([768, 512]);
    expect(thumb.bytes).toBe(thumb.buffer.byteLength);
    expect(DERIVATIVE_LONG_EDGE).toEqual({ thumb: 320, display: 1600, analysis: 768 });
    expect(thumb.kind).toBe("thumb");
  });

  it("never enlarges a small image", async () => {
    const src = await decodeImage(await sceneJpeg(200, 100, 2), "image/jpeg");
    for (const kind of ["thumb", "display", "analysis"] as const) {
      const d = await renderDerivative(src, kind);
      expect([d.width, d.height], kind).toEqual([200, 100]);
    }
  });

  it("a portrait source keeps its aspect ratio (long edge is the height)", async () => {
    const src = await decodeImage(await sceneJpeg(1000, 3000, 3), "image/jpeg");
    const t = await renderDerivative(src, "thumb");
    expect([t.width, t.height]).toEqual([107, 320]);
  });

  it("EXIF orientation 6 input yields rotated (portrait) output", async () => {
    const jpeg = jpegWithExif(await sceneJpeg(1200, 800, 4), { orientation: 6 });
    const src = await decodeImage(jpeg, "image/jpeg");
    const d = await renderDerivative(src, "display");
    expect([d.width, d.height]).toEqual([800, 1200]);
  });

  it("output is a progressive JPEG with the FF D8 magic and sRGB", async () => {
    const src = await decodeImage(await sceneJpeg(640, 480, 5), "image/jpeg");
    const d = await renderDerivative(src, "thumb");
    expect(d.buffer[0]).toBe(0xff);
    expect(d.buffer[1]).toBe(0xd8);
    const m = await sharp(d.buffer).metadata();
    expect(m.format).toBe("jpeg");
    expect(m.isProgressive).toBe(true);
    expect(m.space).toBe("srgb");
  });

  it("carries NO metadata: no exif, icc, xmp, iptc and no GPS bytes", async () => {
    const jpeg = jpegWithExif(await sceneJpeg(1600, 1200, 6), GPS_EXIF);
    // Sanity: the input really has the metadata.
    expect((await sharp(jpeg).metadata()).exif).toBeTruthy();
    expect(bytesInclude(jpeg, "Elm Street")).toBe(true);

    const src = await decodeImage(jpeg, "image/jpeg");
    for (const kind of ["thumb", "display", "analysis"] as const) {
      const d = await renderDerivative(src, kind);
      const m = await sharp(d.buffer).metadata();
      expect(m.exif, `${kind} exif`).toBeUndefined();
      expect(m.icc, `${kind} icc`).toBeUndefined();
      expect(m.xmp, `${kind} xmp`).toBeUndefined();
      expect(m.iptc, `${kind} iptc`).toBeUndefined();
      expect(bytesInclude(d.buffer, "Exif"), `${kind} Exif marker`).toBe(false);
      expect(bytesInclude(d.buffer, "Elm Street"), `${kind} description`).toBe(false);
      expect(bytesInclude(d.buffer, "Acme"), `${kind} make`).toBe(false);
    }
  });

  it("flattens transparency onto white (JPEG has no alpha)", async () => {
    const src = await decodeImage(await transparentPng(64, 64), "image/png");
    const d = await renderDerivative(src, "thumb");
    const { data, info } = await sharp(d.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(data[0]).toBeGreaterThan(240);
    expect(data[1]).toBeGreaterThan(240);
    expect(data[2]).toBeGreaterThan(240);
  });

  it("a released source surfaces as a DecodeError", async () => {
    const src = await decodeImage(await sceneJpeg(64, 48, 7), "image/jpeg");
    src.release();
    await expect(renderDerivative(src, "thumb")).rejects.toMatchObject({ name: "DecodeError" });
  });
});
