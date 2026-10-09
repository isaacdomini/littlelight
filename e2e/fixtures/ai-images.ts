// Header-only image fixtures for the AI tests (packages/ai, apps/worker): a byte string that
// `readImageInfo` (packages/ai/src/image.ts) reads as a JPEG of the given size. Not decodable
// pictures, which is all the adapters, mock servers and the fake provider ever need. Test-only;
// no real photos, no people.

/** A JPEG header (SOI, JFIF APP0, SOF0 with `width` x `height`) padded with zeros to `totalBytes`. */
export function craftJpeg(width: number, height: number, totalBytes = 2048): Uint8Array {
  const head = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // APP0
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08, // SOF0, length 17, 8-bit
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01, // 3 components
  ];
  const out = new Uint8Array(Math.max(totalBytes, head.length + 2));
  out.set(head, 0);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9; // EOI
  return out;
}

/** A WebP VP8X header of `width` x `height`, padded to `totalBytes`. */
export function craftWebp(width: number, height: number, totalBytes = 2048): Uint8Array {
  const out = new Uint8Array(Math.max(totalBytes, 32));
  const put = (i: number, s: string) => {
    for (let k = 0; k < s.length; k++) out[i + k] = s.charCodeAt(k);
  };
  put(0, "RIFF");
  put(8, "WEBP");
  put(12, "VP8X");
  const w = width - 1;
  const h = height - 1;
  out[24] = w & 0xff;
  out[25] = (w >> 8) & 0xff;
  out[26] = (w >> 16) & 0xff;
  out[27] = h & 0xff;
  out[28] = (h >> 8) & 0xff;
  out[29] = (h >> 16) & 0xff;
  return out;
}

export const ANALYSIS_WIDTH = 768;
export const ANALYSIS_HEIGHT = 576;

/** A valid analysis-copy `AnalysisImage` (768 x 576 JPEG, 2 KB). */
export function analysisImage(seed = 0): {
  bytes: Uint8Array;
  mimeType: "image/jpeg";
  width: number;
  height: number;
} {
  const bytes = craftJpeg(ANALYSIS_WIDTH, ANALYSIS_HEIGHT, 2048 + seed);
  return { bytes, mimeType: "image/jpeg", width: ANALYSIS_WIDTH, height: ANALYSIS_HEIGHT };
}
