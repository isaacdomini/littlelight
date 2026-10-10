import type { PhotoMime } from "@tinyglow/shared";
import sharp, { type Sharp, type SharpOptions } from "sharp";
import { isHeif } from "./sniff";

// Decoding (docs/plans/step-4.md 2.7 step 6, D4, R2; PRD FR-2.3 "HEIC → JPEG derivatives,
// original untouched").
// * JPEG/PNG/WebP: libvips via sharp; `.rotate()` with no angle applies the EXIF Orientation and
//   drops the tag. A fresh pipeline is built per derivative so libvips can shrink-on-load JPEGs.
// * HEIC/HEIF: `heic-decode` (libheif compiled to WASM; sharp's prebuilt libvips has no HEVC
//   decoder) gives the primary image as RGBA. libheif already applies the container's
//   `irot`/`imir` transforms, so there is NO second rotation from EXIF Orientation here.
// Failures are `DecodeError` (non-retryable `decode_failed`).

/** Largest accepted input in pixels (~80 MP); larger inputs fail as `decode_failed`. */
export const MAX_INPUT_PIXELS = 80_000_000;

const SHARP_INPUT: SharpOptions = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" };

export class DecodeError extends Error {
  constructor(readonly reason: string) {
    super(`decode failed: ${reason}`);
    this.name = "DecodeError";
  }
}

export interface DecodedSource {
  /** Oriented (display) width/height of the full image. */
  width: number;
  height: number;
  /** A fresh, oriented sharp pipeline over the image (call once per output). */
  pipeline(): Sharp;
  /** Drop references to large buffers (decoded RGBA) as soon as derivatives are written. */
  release(): void;
}

/** sharp's message category only (never the message: it can contain paths). */
function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  if (/pixel limit/i.test(msg)) return "pixel_limit";
  if (/unsupported image format/i.test(msg)) return "unsupported_format";
  if (/not a HEIC image|HEIF image not found|HEIF processing error/i.test(msg)) return "heif";
  return "decode_error";
}

async function decodeWithSharp(buf: Buffer): Promise<DecodedSource> {
  try {
    const meta = await sharp(buf, SHARP_INPUT).metadata();
    const oriented = (meta as { autoOrient?: { width?: number; height?: number } }).autoOrient;
    const swap = (meta.orientation ?? 1) >= 5;
    const width = oriented?.width ?? (swap ? meta.height : meta.width);
    const height = oriented?.height ?? (swap ? meta.width : meta.height);
    if (!width || !height) throw new DecodeError("no_dimensions");
    if (width * height > MAX_INPUT_PIXELS) throw new DecodeError("pixel_limit");
    let source: Buffer | undefined = buf;
    return {
      width,
      height,
      pipeline() {
        if (!source) throw new DecodeError("released");
        return sharp(source, SHARP_INPUT).rotate();
      },
      release() {
        source = undefined;
      },
    };
  } catch (err) {
    throw err instanceof DecodeError ? err : new DecodeError(reasonOf(err));
  }
}

type HeicDecode = (input: { buffer: Uint8Array }) => Promise<{
  width: number;
  height: number;
  data: Uint8ClampedArray;
}>;

let heicDecoder: Promise<HeicDecode> | undefined;

/** Lazy: the WASM bundle is only loaded by workers that actually see a HEIC file. */
function loadHeicDecode(): Promise<HeicDecode> {
  heicDecoder ??= import("heic-decode").then((m) => {
    const mod = m as unknown as { default?: HeicDecode } & HeicDecode;
    return (mod.default ?? mod) as HeicDecode;
  });
  return heicDecoder;
}

async function decodeHeif(buf: Buffer): Promise<DecodedSource> {
  let decoded: Awaited<ReturnType<HeicDecode>>;
  try {
    const decode = await loadHeicDecode();
    decoded = await decode({ buffer: buf });
  } catch (err) {
    throw new DecodeError(reasonOf(err));
  }
  const { width, height } = decoded;
  if (!width || !height) throw new DecodeError("no_dimensions");
  if (width * height > MAX_INPUT_PIXELS) throw new DecodeError("pixel_limit");
  let raw: Buffer | undefined = Buffer.from(
    decoded.data.buffer,
    decoded.data.byteOffset,
    decoded.data.byteLength,
  );
  if (raw.byteLength !== width * height * 4) throw new DecodeError("bad_raw_length");
  return {
    width,
    height,
    pipeline() {
      if (!raw) throw new DecodeError("released");
      return sharp(raw, {
        raw: { width, height, channels: 4 },
        limitInputPixels: MAX_INPUT_PIXELS,
      });
    },
    release() {
      raw = undefined;
    },
  };
}

/** Decode the original into an oriented source for derivatives. */
export async function decodeImage(buf: Buffer, mime: PhotoMime): Promise<DecodedSource> {
  return isHeif(mime) ? decodeHeif(buf) : decodeWithSharp(buf);
}
