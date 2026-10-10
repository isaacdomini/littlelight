import type { PhotoMime } from "@tinyglow/shared";
import { fileTypeFromBuffer } from "file-type";

// Magic-byte sniffing (docs/plans/step-4.md 2.7 step 3; PRD "FR-2 Upload"). The client's mime
// hint and the file extension are ignored: only the bytes decide. Anything outside the five
// accepted photo types is a non-retryable `unsupported_media_type`.

/** ISO-BMFF major brands of still HEIF images (libheif's list). Sequences/AVIF are rejected. */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "heif"]);

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
  const brand = ftypBrand(buf);
  if (brand !== undefined) {
    if (HEIC_BRANDS.has(brand)) return "image/heic";
    if (HEIF_BRANDS.has(brand)) return "image/heif";
    return null;
  }
  const detected = await fileTypeFromBuffer(buf);
  switch (detected?.mime) {
    case "image/jpeg":
    case "image/png":
    case "image/webp":
      return detected.mime;
    default:
      return null;
  }
}

export function isHeif(mime: PhotoMime): boolean {
  return mime === "image/heic" || mime === "image/heif";
}
