import type { MediaMime, PhotoMime, VideoMime } from "@tinyglow/shared";
import { fileTypeFromBuffer } from "file-type";

// Magic-byte sniffing (docs/plans/step-4.md 2.7 step 3; docs/plans/step-12.md 2.6; PRD "FR-2
// Upload"). The client's mime hint and the file extension are ignored: only the bytes decide.
// Anything outside the five accepted photo types and the two accepted video containers is a
// non-retryable `unsupported_media_type`. The sniff needs only the first 4 KiB
// (`SNIFF_HEAD_BYTES`): a video is never read whole for it.

/** ISO-BMFF major brands of still HEIF images (libheif's list). Sequences/AVIF are rejected. */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "heif"]);
/**
 * ISO-BMFF major brands of MP4 files (ISO base media, MP4 v1/v2, AVC, iTunes M4V, the 3GPP/ISO
 * profile brands phones write). Everything else with an `ftyp` box but QuickTime is refused.
 */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "mp71",
  "avc1",
  "m4v",
  "m4a",
  "f4v",
  "3gp4",
  "3gp5",
  "3gp6",
  "3gp7",
  "dash",
  "msnv",
]);
/** QuickTime movie brand (`qt  `, trimmed). */
const QUICKTIME_BRAND = "qt";

/** Bytes needed by `sniffMediaMime` (file-type reads at most 4100). */
export const SNIFF_HEAD_BYTES = 4100;

/** Major brand of an ISO-BMFF `ftyp` box at offset 4, or undefined. */
function ftypBrand(buf: Uint8Array): string | undefined {
  if (buf.byteLength < 12) return undefined;
  if (buf[4] !== 0x66 || buf[5] !== 0x74 || buf[6] !== 0x79 || buf[7] !== 0x70) return undefined;
  return String.fromCharCode(buf[8] ?? 0, buf[9] ?? 0, buf[10] ?? 0, buf[11] ?? 0)
    .replace(/\0/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Sniff `buf` and return one of the accepted photo mimes, or `null` for anything else
 * (text, PDF, SVG, GIF, AVIF, video, truncated input...).
 */
export async function sniffPhotoMime(buf: Uint8Array): Promise<PhotoMime | null> {
  const mime = await sniffMediaMime(buf);
  return mime !== null && !isVideoMime(mime) ? mime : null;
}

/**
 * Sniff `buf` and return one of the accepted photo or video mimes, or `null` for anything else.
 * Videos: `video/mp4` for the MP4 family of `ftyp` brands, `video/quicktime` for `qt  `. An MP4
 * container with no video stream (an `.m4a`) still sniffs as `video/mp4` here; ffprobe refuses
 * it afterwards (`unsupported_media_type`).
 */
export async function sniffMediaMime(buf: Uint8Array): Promise<MediaMime | null> {
  const brand = ftypBrand(buf);
  if (brand !== undefined) {
    if (HEIC_BRANDS.has(brand)) return "image/heic";
    if (HEIF_BRANDS.has(brand)) return "image/heif";
    if (brand === QUICKTIME_BRAND) return "video/quicktime";
    if (MP4_BRANDS.has(brand)) return "video/mp4";
    return null;
  }
  const detected = await fileTypeFromBuffer(buf);
  switch (detected?.mime) {
    case "image/jpeg":
    case "image/png":
    case "image/webp":
      return detected.mime;
    case "video/quicktime":
      return "video/quicktime";
    case "video/mp4":
      return "video/mp4";
    default:
      return null;
  }
}

export function isHeif(mime: PhotoMime): boolean {
  return mime === "image/heic" || mime === "image/heif";
}

/** True for the two accepted video containers (step 12). */
export function isVideoMime(mime: MediaMime): mime is VideoMime {
  return mime === "video/mp4" || mime === "video/quicktime";
}
