import { describe, expect, it } from "vitest";
import { isVideoMime, SNIFF_HEAD_BYTES, sniffMediaMime, sniffPhotoMime } from "./sniff";

// `sniffMediaMime` (docs/plans/step-12.md 2.6): the MP4 family of `ftyp` brands is `video/mp4`,
// `qt  ` is `video/quicktime`, HEIC/HEIF brands stay images, and a JPEG renamed `.mp4` is still a
// JPEG (the registered kind is a hint; the sniff is the truth). Only the first 4 KiB are read.

function ftyp(brand: string, compat = "isomiso2avc1mp41"): Uint8Array {
  const box = Buffer.alloc(8 + 4 + 4 + compat.length);
  box.writeUInt32BE(box.length, 0);
  box.write("ftyp", 4, "ascii");
  box.write(brand.padEnd(4, " "), 8, "ascii");
  box.writeUInt32BE(0x200, 12);
  box.write(compat, 16, "ascii");
  // a tiny mdat so the buffer looks like a file
  const mdat = Buffer.alloc(16);
  mdat.writeUInt32BE(16, 0);
  mdat.write("mdat", 4, "ascii");
  return new Uint8Array(Buffer.concat([box, mdat]));
}

const JPEG = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x10,
  0x4a,
  0x46,
  0x49,
  0x46,
  0x00,
  ...new Array(64).fill(0),
]);

describe("sniffMediaMime: videos", () => {
  it.each(["isom", "mp41", "mp42", "avc1", "M4V ", "iso2", "iso5"])(
    "ftyp brand %j is video/mp4",
    async (brand) => {
      expect(await sniffMediaMime(ftyp(brand))).toBe("video/mp4");
    },
  );

  it("the QuickTime brand is video/quicktime", async () => {
    expect(await sniffMediaMime(ftyp("qt  ", "qt  "))).toBe("video/quicktime");
  });

  it("HEIC/HEIF brands stay images; an unknown brand is refused", async () => {
    expect(await sniffMediaMime(ftyp("heic", "mif1heic"))).toBe("image/heic");
    expect(await sniffMediaMime(ftyp("mif1", "mif1heic"))).toBe("image/heif");
    expect(await sniffMediaMime(ftyp("zzzz"))).toBeNull();
  });

  it("a JPEG is a JPEG whatever the file was registered as; text is nothing", async () => {
    expect(await sniffMediaMime(JPEG)).toBe("image/jpeg");
    expect(await sniffMediaMime(new TextEncoder().encode("not a video at all, really"))).toBeNull();
    expect(await sniffMediaMime(new Uint8Array(0))).toBeNull();
    expect(await sniffMediaMime(new Uint8Array(8))).toBeNull();
  });

  it("sniffPhotoMime never returns a video mime", async () => {
    expect(await sniffPhotoMime(ftyp("isom"))).toBeNull();
    expect(await sniffPhotoMime(ftyp("qt  ", "qt  "))).toBeNull();
    expect(await sniffPhotoMime(JPEG)).toBe("image/jpeg");
  });

  it("isVideoMime narrows the two containers; the sniff head is ~4 KiB", () => {
    expect(isVideoMime("video/mp4")).toBe(true);
    expect(isVideoMime("video/quicktime")).toBe(true);
    expect(isVideoMime("image/heic")).toBe(false);
    expect(SNIFF_HEAD_BYTES).toBe(4100);
  });
});
