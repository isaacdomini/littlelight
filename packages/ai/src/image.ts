/**
 * Analysis-copy guard (README rule 1; PRD "Image compression for the model"). The only image a
 * request may carry is the 768 px long-edge analysis derivative. Every adapter (including the
 * fake) calls `assertAnalysisImage` before building a request, so a display copy or an
 * original can never reach a provider, whatever the caller passes.
 *
 * Dimensions are read from the JPEG/WebP header (no image library) and must match the declared
 * `width`/`height`. Image bytes are never logged or put in an error.
 */

import { ANALYSIS_LONG_EDGE_PX, ANALYSIS_MAX_BYTES } from "./defaults";
import { AiRequestError } from "./errors";
import type { AnalysisImage } from "./types";

export interface ImageInfo {
  type: "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
}
function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}
function u24le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
}
function ascii(b: Uint8Array, i: number, n: number): string {
  return String.fromCharCode(...b.subarray(i, i + n));
}

function jpegSize(b: Uint8Array): ImageInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: "image/jpeg", height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): ImageInfo | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) {
    return { type: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) {
    return { type: "image/webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

/** Type and dimensions from a JPEG or WebP header, or null when unreadable. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return jpegSize(bytes);
  }
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return webpSize(bytes);
  }
  return null;
}

/**
 * Throws `AiRequestError` unless `image` is a JPEG/WebP whose header matches the declared type
 * and dimensions, with a long edge ≤ 768 px and ≤ 400 KB.
 */
export function assertAnalysisImage(image: AnalysisImage): void {
  const { width, height, bytes, mimeType } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new AiRequestError("image_bad_dimensions");
  }
  if (Math.max(width, height) > ANALYSIS_LONG_EDGE_PX) throw new AiRequestError("image_too_large");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new AiRequestError("image_bad_type");
  }
  if (bytes.byteLength > ANALYSIS_MAX_BYTES) throw new AiRequestError("image_too_many_bytes");
  if (mimeType !== "image/jpeg" && mimeType !== "image/webp") {
    throw new AiRequestError("image_bad_type");
  }
  const info = readImageInfo(bytes);
  if (!info || info.type !== mimeType) throw new AiRequestError("image_bad_type");
  if (info.width !== width || info.height !== height) {
    throw new AiRequestError("image_dimensions_mismatch");
  }
}

/** `data:<mime>;base64,<...>` for the OpenAI `input_image.image_url`. */
export function toDataUrl(image: AnalysisImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

export function toBase64(image: AnalysisImage): string {
  return Buffer.from(image.bytes).toString("base64");
}
