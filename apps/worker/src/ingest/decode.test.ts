import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { jpegWithExif } from "../testing/exif-writer";
import { ftypBuffer, sceneJpeg, scenePng, sceneWebp } from "../testing/images";
import { DecodeError, decodeImage, MAX_INPUT_PIXELS } from "./decode";

// HEIC fixtures are committed under e2e/fixtures/heic/ (docs/plans/step-4.md 2.14). Until they
// exist (or on a machine without them) the HEIC cases skip. HEIC_FIXTURE_DIR overrides the dir.
const HEIC_DIR =
  process.env.HEIC_FIXTURE_DIR ??
  path.resolve(import.meta.dirname, "../../../../e2e/fixtures/heic");
const heic = (name: string) => path.join(HEIC_DIR, name);
const hasHeic = (name: string) => existsSync(heic(name));

describe("decodeImage (JPEG / PNG / WebP)", () => {
  it("reports the stored size of an upright image", async () => {
    const src = await decodeImage(await sceneJpeg(640, 480, 1), "image/jpeg");
    expect([src.width, src.height]).toEqual([640, 480]);
    const out = await src.pipeline().jpeg().toBuffer({ resolveWithObject: true });
    expect([out.info.width, out.info.height]).toEqual([640, 480]);
  });

  it("EXIF Orientation 6 (1200x800 stored) is reported and rendered as 800x1200", async () => {
    const jpeg = jpegWithExif(await sceneJpeg(1200, 800, 2), { orientation: 6 });
    const src = await decodeImage(jpeg, "image/jpeg");
    expect([src.width, src.height]).toEqual([800, 1200]);
    const out = await src.pipeline().jpeg().toBuffer({ resolveWithObject: true });
    expect([out.info.width, out.info.height]).toEqual([800, 1200]);
  });

  it.each([
    [1, [1200, 800]],
    [3, [1200, 800]],
    [5, [800, 1200]],
    [6, [800, 1200]],
    [7, [800, 1200]],
    [8, [800, 1200]],
  ])("Orientation %i gives oriented dimensions %j", async (orientation, dims) => {
    const jpeg = jpegWithExif(await sceneJpeg(1200, 800, 3), { orientation });
    const src = await decodeImage(jpeg, "image/jpeg");
    expect([src.width, src.height]).toEqual(dims);
  });

  it("decodes PNG and WebP", async () => {
    const png = await decodeImage(await scenePng(300, 200, 4), "image/png");
    expect([png.width, png.height]).toEqual([300, 200]);
    const webp = await decodeImage(await sceneWebp(300, 200, 5), "image/webp");
    expect([webp.width, webp.height]).toEqual([300, 200]);
  });

  it("release() drops the buffer: the source cannot be used afterwards", async () => {
    const src = await decodeImage(await sceneJpeg(64, 48, 6), "image/jpeg");
    src.release();
    expect(() => src.pipeline()).toThrow(DecodeError);
  });

  it("corrupt and truncated input is a DecodeError", async () => {
    const good = await sceneJpeg(400, 300, 7);
    await expect(
      decodeImage(Buffer.from("not an image at all"), "image/jpeg"),
    ).rejects.toBeInstanceOf(DecodeError);
    await expect(decodeImage(good.subarray(0, 10), "image/jpeg")).rejects.toBeInstanceOf(
      DecodeError,
    );
    await expect(decodeImage(Buffer.alloc(0), "image/png")).rejects.toBeInstanceOf(DecodeError);
  });

  it("a truncated body whose header is fine fails when rendering, not silently", async () => {
    const good = await sceneJpeg(800, 600, 8);
    const src = await decodeImage(
      good.subarray(0, Math.floor(good.length / 3)),
      "image/jpeg",
    ).catch((e) => e);
    if (src instanceof DecodeError) return; // rejected up front: fine
    await expect(src.pipeline().jpeg().toBuffer()).rejects.toThrow();
  });

  it("an input over the pixel limit is a DecodeError with reason pixel_limit", async () => {
    // Real PNG with the IHDR size patched to 20000x20000 (400 MP) and the CRC fixed up.
    const png = Buffer.from(await scenePng(8, 8, 9));
    const ihdr = png.subarray(12, 12 + 4 + 13); // type + data
    ihdr.writeUInt32BE(20_000, 4);
    ihdr.writeUInt32BE(20_000, 8);
    png.writeUInt32BE(crc32(ihdr), 12 + 4 + 13);
    expect(20_000 * 20_000).toBeGreaterThan(MAX_INPUT_PIXELS);
    const err = await decodeImage(png, "image/png").catch((e) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).reason).toMatch(/pixel_limit|decode_error/);
  });

  it("DecodeError messages carry the category only", async () => {
    const err = (await decodeImage(Buffer.from("/secret/path/photo.jpg"), "image/jpeg").catch(
      (e) => e,
    )) as DecodeError;
    expect(err.message).toMatch(/^decode failed: [a-z_]+$/);
    expect(err.message).not.toContain("secret");
  });
});

describe("decodeImage (HEIC / HEIF)", () => {
  it("a file with a HEIC brand but no HEVC image is a DecodeError (not a crash)", async () => {
    await expect(decodeImage(ftypBuffer("heic"), "image/heic")).rejects.toBeInstanceOf(DecodeError);
    await expect(decodeImage(Buffer.from("garbage"), "image/heif")).rejects.toBeInstanceOf(
      DecodeError,
    );
  });

  it.skipIf(!hasHeic("plain-640x480.heic"))(
    "decodes the plain HEIC fixture at 640x480",
    async () => {
      const src = await decodeImage(readFileSync(heic("plain-640x480.heic")), "image/heic");
      expect([src.width, src.height]).toEqual([640, 480]);
      const out = await src.pipeline().jpeg().toBuffer({ resolveWithObject: true });
      expect([out.info.width, out.info.height]).toEqual([640, 480]);
      expect(out.data[0]).toBe(0xff);
      expect(out.data[1]).toBe(0xd8);
    },
  );

  it.skipIf(!hasHeic("portrait-480x640.heic"))(
    "a portrait HEIC is not rotated a second time (libheif already applied irot)",
    async () => {
      const src = await decodeImage(readFileSync(heic("portrait-480x640.heic")), "image/heic");
      expect([src.width, src.height]).toEqual([480, 640]);
      const out = await src.pipeline().jpeg().toBuffer({ resolveWithObject: true });
      expect([out.info.width, out.info.height]).toEqual([480, 640]);
    },
  );

  it.skipIf(!hasHeic("heif-mif1.heif"))("decodes the mif1 HEIF fixture", async () => {
    const src = await decodeImage(readFileSync(heic("heif-mif1.heif")), "image/heif");
    expect(src.width).toBeGreaterThan(0);
  });

  it.skipIf(!hasHeic("plain-640x480.heic"))("a truncated HEIC is a DecodeError", async () => {
    const buf = readFileSync(heic("plain-640x480.heic"));
    await expect(
      decodeImage(buf.subarray(0, Math.floor(buf.length / 2)), "image/heic"),
    ).rejects.toBeInstanceOf(DecodeError);
  });
});

describe("sharp sanity used by the fixtures", () => {
  it("sharp can read the fixture JPEG dims", async () => {
    const m = await sharp(await sceneJpeg(10, 20, 1)).metadata();
    expect([m.width, m.height]).toEqual([10, 20]);
  });
});
