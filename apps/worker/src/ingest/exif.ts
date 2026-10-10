import type { PhotoMime } from "@tinyglow/shared";
import exifr from "exifr";
import sharp from "sharp";
import { isKnownTimeZone, wallTimeInZone } from "./tz";

// EXIF extraction (docs/plans/step-4.md 2.7 step 5; PRD FR-4.1, FR-4.3).
//
// Privacy rules enforced here:
// * GPS is returned only as a NON-ENUMERABLE `gps` property of the result, so a stray
//   `log.info({ exif })` or `JSON.stringify(exif)` can never print coordinates. The caller passes
//   the two numbers straight into `encrypt_coord($n)` bind parameters and drops them.
// * `rawJson` is a whitelist of camera/exposure tags (strings and finite numbers only), never the
//   parsed object: no GPS, no UserComment/ImageDescription/Artist/Copyright, no MakerNotes. The
//   `photo_exif_no_gps_keys` trigger is the tripwire behind this filter, not the filter itself.
// * Nothing in this module logs.

/** `photo_exif.raw_json` keys, in this order. */
export const RAW_JSON_WHITELIST = [
  "Make",
  "Model",
  "LensModel",
  "Software",
  "DateTimeOriginal",
  "OffsetTimeOriginal",
  "Orientation",
  "ExifImageWidth",
  "ExifImageHeight",
  "FNumber",
  "ExposureTime",
  "ISO",
  "FocalLength",
  "Flash",
  "WhiteBalance",
  "ColorSpace",
] as const;

export interface GpsPoint {
  lat: number;
  lng: number;
}

export interface ExifData {
  /** Capture instant from DateTimeOriginal (fallback CreateDate, ModifyDate), or null. */
  takenAt: Date | null;
  /** UTC offset of the capture (east positive), from the offset tag or `tzHint`; else null. */
  tzOffsetMinutes: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  /** EXIF Orientation 1..8 as stored in the file (HEIC pixels are already oriented by libheif). */
  orientation: number | null;
  exifWidth: number | null;
  exifHeight: number | null;
  rawJson: Record<string, string | number>;
  /** Non-enumerable. Valid WGS84 point or null. Never log, never persist in plaintext. */
  readonly gps: GpsPoint | null;
}

const EXIFR_OPTIONS = {
  tiff: true,
  exif: true,
  gps: true,
  ifd1: false,
  interop: false,
  makerNote: false,
  userComment: false,
  xmp: false,
  icc: false,
  iptc: false,
  jfif: false,
  ihdr: false,
  translateKeys: true,
  translateValues: false,
  reviveValues: false,
  sanitize: true,
  mergeOutput: true,
} as const;

const MAX_STRING = 120;

function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return s.length > 0 ? s.slice(0, MAX_STRING) : null;
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length === 1) return finiteNumber(v[0]);
  return null;
}

function positiveInt(v: unknown, max = 1_000_000): number | null {
  const n = finiteNumber(v);
  return n !== null && Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

/** Whitelisted, sanitised copy of the parsed tags (strings/finite numbers only). */
export function whitelistRawJson(tags: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const key of RAW_JSON_WHITELIST) {
    const v = tags[key];
    const s = cleanString(v);
    if (s !== null) {
      out[key] = s;
      continue;
    }
    const n = finiteNumber(v);
    if (n !== null) out[key] = n;
  }
  return out;
}

interface WallTime {
  /** Fields read as if UTC: `Date.UTC(y, m-1, d, h, mi, s)`. */
  asUtcMs: number;
}

/** Parse EXIF `YYYY:MM:DD HH:MM:SS` (optionally `.sss`, `-`/`/` separators tolerated). */
export function parseExifDateTime(raw: unknown): WallTime | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const asUtcMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(asUtcMs);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { asUtcMs };
}

/** Parse an EXIF offset tag (`+02:00`, `-07:00`, `+0530`, `Z`) into minutes east of UTC. */
export function parseExifOffset(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (v === "Z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(v);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  if (Number(m[3]) > 59 || minutes > 840) return null;
  return m[1] === "-" ? -minutes : minutes;
}

/**
 * Capture instant + offset from the EXIF tags. Offset tag wins; else the wall time is read in
 * `tzHint`; else as UTC with a null offset. Returns null for no/invalid date or a date more than
 * a day in the future (camera clock not set) or before 1990.
 */
export function resolveCaptureTime(
  tags: Record<string, unknown>,
  tzHint: string | undefined,
  now: Date,
): { takenAt: Date; tzOffsetMinutes: number | null } | null {
  const candidates: [string, string][] = [
    ["DateTimeOriginal", "OffsetTimeOriginal"],
    ["CreateDate", "OffsetTimeDigitized"],
    ["ModifyDate", "OffsetTime"],
  ];
  for (const [dateKey, offsetKey] of candidates) {
    const wall = parseExifDateTime(tags[dateKey]);
    if (!wall) continue;
    const offset = parseExifOffset(tags[offsetKey]) ?? parseExifOffset(tags.OffsetTime);
    let utcMs: number;
    let tzOffsetMinutes: number | null;
    if (offset !== null) {
      utcMs = wall.asUtcMs - offset * 60_000;
      tzOffsetMinutes = offset;
    } else if (tzHint && isKnownTimeZone(tzHint)) {
      const r = wallTimeInZone(wall.asUtcMs, tzHint);
      utcMs = r.utcMs;
      tzOffsetMinutes = r.offsetMinutes;
    } else {
      utcMs = wall.asUtcMs;
      tzOffsetMinutes = null;
    }
    if (utcMs < Date.UTC(1990, 0, 1) || utcMs > now.getTime() + 86_400_000) continue;
    return { takenAt: new Date(utcMs), tzOffsetMinutes };
  }
  return null;
}

function gpsFrom(tags: Record<string, unknown>): GpsPoint | null {
  const lat = finiteNumber(tags.latitude);
  const lng = finiteNumber(tags.longitude);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // (0, 0) is what unset GPS blocks decode to; it is never a real capture point here.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** TIFF payload of an EXIF blob (strips the `Exif\0\0` APP1 header sharp reports). */
function tiffFromExifBlob(blob: Buffer): Buffer {
  const header = Buffer.from("Exif\0\0", "latin1");
  return blob.subarray(0, 6).equals(header) ? blob.subarray(6) : blob;
}

async function readTags(buf: Buffer, mime: PhotoMime): Promise<Record<string, unknown>> {
  let source: Buffer | undefined = buf;
  if (mime === "image/webp") {
    // exifr has no WebP parser: take the EXIF chunk via libvips (header read only).
    const meta = await sharp(buf).metadata();
    source = meta.exif ? tiffFromExifBlob(meta.exif) : undefined;
  }
  if (!source) return {};
  const tags = (await exifr.parse(source, EXIFR_OPTIONS)) as unknown;
  return tags && typeof tags === "object" ? (tags as Record<string, unknown>) : {};
}

function emptyExif(): ExifData {
  return withGps(
    {
      takenAt: null,
      tzOffsetMinutes: null,
      cameraMake: null,
      cameraModel: null,
      orientation: null,
      exifWidth: null,
      exifHeight: null,
      rawJson: {},
    },
    null,
  );
}

function withGps(data: Omit<ExifData, "gps">, gps: GpsPoint | null): ExifData {
  return Object.defineProperty(data, "gps", {
    value: gps,
    enumerable: false,
    writable: false,
  }) as ExifData;
}

/**
 * Extract capture time, camera, orientation, dimensions, GPS and the whitelisted raw tags.
 * Unparseable or missing EXIF is not an error: every field is null and the caller estimates.
 */
export async function extractExif(
  buf: Buffer,
  mime: PhotoMime,
  tzHint: string | undefined,
  now: Date = new Date(),
): Promise<ExifData> {
  let tags: Record<string, unknown>;
  try {
    tags = await readTags(buf, mime);
  } catch {
    return emptyExif();
  }
  const capture = resolveCaptureTime(tags, tzHint, now);
  const orientation = positiveInt(tags.Orientation, 8);
  return withGps(
    {
      takenAt: capture?.takenAt ?? null,
      tzOffsetMinutes: capture?.tzOffsetMinutes ?? null,
      cameraMake: cleanString(tags.Make),
      cameraModel: cleanString(tags.Model),
      orientation,
      exifWidth: positiveInt(tags.ExifImageWidth),
      exifHeight: positiveInt(tags.ExifImageHeight),
      rawJson: whitelistRawJson(tags),
    },
    gpsFrom(tags),
  );
}
