import type { GpsPoint } from "../ingest/exif";
import { isKnownTimeZone, wallTimeInZone } from "../ingest/tz";

// Video metadata from the container tags (docs/plans/step-12.md 2.6 step 5; PRD FR-4.1, FR-4.3).
// Same privacy rules as `ingest/exif.ts`:
// * GPS is returned only as a NON-ENUMERABLE `gps` property, parsed from the QuickTime location
//   tag (`com.apple.quicktime.location.ISO6709`, ffmpeg's `location` / `location-eng` mapping;
//   ISO 6709 `±DD.DDDD±DDD.DDDD[±AAA.AAA]/`). The caller binds the two numbers to
//   `encrypt_coord($n)` and drops them.
// * `rawJson` is a whitelist of container/camera tags (strings only, bounded), and every key
//   that mentions a location is excluded by construction; the `photo_exif_no_gps_keys` trigger
//   (`jsonb_has_gps_keys`, which matches `location` and `iso6709` since migration 22) is the
//   tripwire behind this filter, not the filter itself.
// * Nothing in this module logs.

/** `photo_exif.raw_json` keys of a video, in this order. No key may match `jsonb_has_gps_keys`. */
export const VIDEO_RAW_JSON_WHITELIST = [
  "major_brand",
  "minor_version",
  "compatible_brands",
  "encoder",
  "creation_time",
  "com.apple.quicktime.creationdate",
  "com.apple.quicktime.make",
  "com.apple.quicktime.model",
  "com.apple.quicktime.software",
  "handler_name",
] as const;

/** Keys that are never copied, whatever the whitelist says (defence in depth). */
const FORBIDDEN_KEY = /gps|latitude|longitude|location|iso6709|geo|^(lat|lng|lon)$/i;

const MAX_STRING = 120;

export interface VideoMetadata {
  /** Capture instant, or null (the caller estimates from the upload time). */
  takenAt: Date | null;
  /** UTC offset of the capture (east positive) when the tag carried one or `tzHint` resolved it. */
  tzOffsetMinutes: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  rawJson: Record<string, string>;
  /** Non-enumerable. Valid WGS84 point or null. Never log, never persist in plaintext. */
  readonly gps: GpsPoint | null;
}

function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return s.length > 0 ? s.slice(0, MAX_STRING) : null;
}

/** Whitelisted, sanitised copy of the tags (strings only); location-like keys never pass. */
export function whitelistVideoTags(
  tags: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of VIDEO_RAW_JSON_WHITELIST) {
    if (FORBIDDEN_KEY.test(key)) continue;
    const s = cleanString(tags[key]);
    if (s !== null) out[key] = s;
  }
  return out;
}

/**
 * Parse an ISO 6709 point as QuickTime writes it: `+37.3349-122.0090+012.345/` (altitude and the
 * trailing `/` optional; also the `±DDMM.MMMM±DDDMM.MMMM` minute forms). Null unless both
 * coordinates parse into a valid WGS84 point; (0, 0) is treated as unset.
 */
export function parseIso6709(raw: unknown): GpsPoint | null {
  if (typeof raw !== "string") return null;
  const m = /^\s*([+-])(\d{2,6}(?:\.\d+)?)([+-])(\d{3,7}(?:\.\d+)?)/.exec(raw);
  if (!m) return null;
  const toDeg = (body: string, degDigits: number): number | null => {
    const [intPart = "", frac = ""] = body.split(".");
    if (intPart.length === degDigits) return Number(body);
    if (intPart.length === degDigits + 2) {
      // DDMM.MMMM
      const deg = Number(intPart.slice(0, degDigits));
      const min = Number(`${intPart.slice(degDigits)}${frac ? `.${frac}` : ""}`);
      return deg + min / 60;
    }
    if (intPart.length === degDigits + 4) {
      // DDMMSS.SSSS
      const deg = Number(intPart.slice(0, degDigits));
      const min = Number(intPart.slice(degDigits, degDigits + 2));
      const sec = Number(`${intPart.slice(degDigits + 2)}${frac ? `.${frac}` : ""}`);
      return deg + min / 60 + sec / 3600;
    }
    return null;
  };
  const latAbs = toDeg(m[2] as string, 2);
  const lngAbs = toDeg(m[4] as string, 3);
  if (latAbs === null || lngAbs === null || !Number.isFinite(latAbs) || !Number.isFinite(lngAbs)) {
    return null;
  }
  const lat = m[1] === "-" ? -latAbs : latAbs;
  const lng = m[3] === "-" ? -lngAbs : lngAbs;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** The clip's location from any of the QuickTime / ffmpeg location tag spellings. */
export function gpsFromTags(tags: Readonly<Record<string, unknown>>): GpsPoint | null {
  for (const [key, value] of Object.entries(tags)) {
    const k = key.toLowerCase();
    if (
      k === "com.apple.quicktime.location.iso6709" ||
      k === "location" ||
      k.startsWith("location-")
    ) {
      const p = parseIso6709(value);
      if (p) return p;
    }
  }
  return null;
}

/**
 * Parse `com.apple.quicktime.creationdate` (`2026-07-12T10:30:00+0200`) or `creation_time`
 * (`2026-07-12T08:30:00.000000Z`): an ISO 8601 instant with an offset or `Z`. Returns the instant
 * and the offset (minutes east) when the string carried one.
 */
export function parseIsoInstant(
  raw: unknown,
): { utcMs: number; offsetMinutes: number | null; hasOffset: boolean } | null {
  if (typeof raw !== "string") return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      raw.trim(),
    );
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const wallMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wallMs);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const zone = m[8];
  if (!zone) return { utcMs: wallMs, offsetMinutes: null, hasOffset: false };
  if (zone === "Z") return { utcMs: wallMs, offsetMinutes: 0, hasOffset: true };
  const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!z) return null;
  const minutes = Number(z[2]) * 60 + Number(z[3]);
  if (Number(z[3]) > 59 || minutes > 840) return null;
  const offset = z[1] === "-" ? -minutes : minutes;
  return { utcMs: wallMs - offset * 60_000, offsetMinutes: offset, hasOffset: true };
}

/**
 * Capture instant + offset from the tags: the QuickTime creation date (carries the local offset)
 * wins; else `creation_time` (UTC from the muxer, or a wall time read in `tzHint`). Null for no
 * or invalid date, a date before 1990 or more than a day in the future (clock not set), and for
 * the mp4 muxer's epoch placeholder.
 */
export function resolveVideoCaptureTime(
  tags: Readonly<Record<string, unknown>>,
  tzHint: string | undefined,
  now: Date,
): { takenAt: Date; tzOffsetMinutes: number | null } | null {
  for (const key of ["com.apple.quicktime.creationdate", "creation_time"] as const) {
    const parsed = parseIsoInstant(tags[key]);
    if (!parsed) continue;
    let utcMs = parsed.utcMs;
    let tzOffsetMinutes = parsed.offsetMinutes;
    if (!parsed.hasOffset) {
      if (tzHint && isKnownTimeZone(tzHint)) {
        const r = wallTimeInZone(parsed.utcMs, tzHint);
        utcMs = r.utcMs;
        tzOffsetMinutes = r.offsetMinutes;
      } else {
        tzOffsetMinutes = null;
      }
    } else if (key === "creation_time" && parsed.offsetMinutes === 0) {
      // The muxer's UTC time: the local offset is unknown (the hint, if any, gives it).
      tzOffsetMinutes =
        tzHint && isKnownTimeZone(tzHint) ? wallTimeInZone(utcMs, tzHint).offsetMinutes : null;
    }
    if (utcMs < Date.UTC(1990, 0, 1) || utcMs > now.getTime() + 86_400_000) continue;
    return { takenAt: new Date(utcMs), tzOffsetMinutes };
  }
  return null;
}

function withGps(data: Omit<VideoMetadata, "gps">, gps: GpsPoint | null): VideoMetadata {
  return Object.defineProperty(data, "gps", {
    value: gps,
    enumerable: false,
    writable: false,
  }) as VideoMetadata;
}

/** Camera make/model: the QuickTime tags, else nothing (`encoder` is software, not a camera). */
function cameraFrom(tags: Readonly<Record<string, unknown>>): {
  make: string | null;
  model: string | null;
} {
  return {
    make: cleanString(tags["com.apple.quicktime.make"]),
    model: cleanString(tags["com.apple.quicktime.model"]),
  };
}

/**
 * Extract capture time, camera, GPS and the whitelisted raw tags from a probe's container tags.
 * Missing tags are not an error: every field is null and the caller estimates.
 */
export function extractVideoMetadata(
  tags: Readonly<Record<string, unknown>>,
  tzHint: string | undefined,
  now: Date = new Date(),
): VideoMetadata {
  const capture = resolveVideoCaptureTime(tags, tzHint, now);
  const camera = cameraFrom(tags);
  return withGps(
    {
      takenAt: capture?.takenAt ?? null,
      tzOffsetMinutes: capture?.tzOffsetMinutes ?? null,
      cameraMake: camera.make,
      cameraModel: camera.model,
      rawJson: whitelistVideoTags(tags),
    },
    gpsFromTags(tags),
  );
}
