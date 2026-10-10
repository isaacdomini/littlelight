import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import exifr from "exifr";
import sharp from "sharp";
import { buildTiff, type ExifSpec, jpegWithExif, webpWithExif } from "../../testing/exif-writer";

// Catalogue of the fake Google Picker server (docs/plans/step-10.md 2.9, task 10.7).
//
// Rendered once at start with sharp, deterministically (a seeded PRNG picks colours and shapes,
// the same sharp build gives the same bytes), so tests can assert SHA-256 values:
// - G-1 … G-8: JPEG photos, 640×480 (odd) / 480×640 (even);
// - P-1: PNG, W-1: WebP (same EXIF as the JPEGs);
// - V-1: a `type: VIDEO` item (a tiny MP4 `ftyp` box, never a playable video);
// - X-1: a JPEG whose download claims 200 MiB in `Content-Length` and is cut after 1 MiB (the
//   worker's size guard);
// - H-1: a committed HEIC fixture, only when `FAKE_GOOGLE_FIXTURES_DIR` holds it.
// EXIF on every photo: `Make "Fake"`, `Model "Picker"`, `DateTimeOriginal` = 2026-03-01 + i days
// 10:00 (i = catalogue index), `OffsetTimeOriginal "+01:00"`. **Never a GPS IFD** (Google strips
// location from downloads, D20): `buildFakeCatalogue` reads every file back and throws if one
// carries any GPS tag or a photo lacks its capture date.

export type FakeItemType = "PHOTO" | "VIDEO";

export interface FakeCatalogueItem {
  /** Picker media item id (`G-1`, `P-1`, …). */
  readonly id: string;
  readonly type: FakeItemType;
  readonly mimeType: string;
  /** Picker `mediaFile.filename` (synthetic; the real one is the user's and never logged). */
  readonly filename: string;
  readonly width: number;
  readonly height: number;
  /** Picker `createTime` (UTC, RFC 3339): the EXIF capture time. */
  readonly createTime: string;
  /** EXIF `DateTimeOriginal` as written (`YYYY:MM:DD HH:MM:SS`), `null` for V-1. */
  readonly exifDateTimeOriginal: string | null;
  readonly exifOffsetTimeOriginal: string | null;
  /** The bytes served by `GET /media/<id>=d` (for X-1: the first 1 MiB only). */
  readonly bytes: Buffer;
  /** Hex SHA-256 of `bytes`. */
  readonly sha256: string;
  /**
   * `Content-Length` the media download announces when it differs from `bytes.length` (X-1:
   * 200 MiB); the connection is then destroyed after `bytes` are sent.
   */
  readonly claimedLength: number | null;
}

/** Seed of the PRNG that draws the catalogue (changing it changes every SHA-256). */
export const FAKE_CATALOGUE_SEED = 0x11_9e_c0_de;
/** Base capture date of catalogue index 0 (the local wall clock at `+01:00`). */
const BASE_DAY_UTC = Date.UTC(2026, 2, 1);
const EXIF_OFFSET = "+01:00";
const EXIF_HOUR_LOCAL = 10;
/** X-1: announced size (above `IMPORT_MAX_FILE_BYTES` = 100 MiB) and bytes actually sent. */
export const FAKE_OVERSIZE_CLAIMED_BYTES = 200 * 1024 * 1024;
export const FAKE_OVERSIZE_SENT_BYTES = 1024 * 1024;
/** File name of the HEIC fixture served as H-1 (EXIF date, no GPS). */
export const FAKE_HEIC_FIXTURE = "datetime-tz.heic";

/** mulberry32: tiny deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** EXIF date of catalogue index `i` and the matching UTC `createTime`. */
function captureTime(i: number): { exif: string; createTime: string } {
  const day = new Date(BASE_DAY_UTC + i * 86_400_000);
  const exif = `${day.getUTCFullYear()}:${pad(day.getUTCMonth() + 1)}:${pad(day.getUTCDate())} ${pad(EXIF_HOUR_LOCAL)}:00:00`;
  // 10:00 at +01:00 is 09:00Z.
  const utc = new Date(BASE_DAY_UTC + i * 86_400_000 + (EXIF_HOUR_LOCAL - 1) * 3_600_000);
  return { exif, createTime: utc.toISOString().replace(".000Z", "Z") };
}

/** A synthetic scene (gradient, bar, circle, triangle): no people, nothing personal. */
function sceneSvg(w: number, h: number, rnd: () => number): Buffer {
  const hue = Math.floor(rnd() * 360);
  const cx = Math.round(w * (0.2 + rnd() * 0.6));
  const cy = Math.round(h * (0.2 + rnd() * 0.6));
  const r = Math.round(Math.min(w, h) * (0.08 + rnd() * 0.15));
  const tx = Math.round(w * rnd() * 0.5);
  const fill = `hsl(${(hue + 150) % 360},65%,50%)`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="hsl(${hue},70%,62%)"/>` +
      `<stop offset="1" stop-color="hsl(${(hue + 80) % 360},55%,32%)"/></linearGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#g)"/>` +
      `<rect x="0" y="0" width="${Math.round(w * 0.3)}" height="${Math.round(h * 0.12)}" fill="#fff"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>` +
      `<polygon points="${tx},${h} ${tx + Math.round(w * 0.2)},${Math.round(h * 0.55)} ${tx + Math.round(w * 0.4)},${h}" fill="#1d3557"/>` +
      `</svg>`,
  );
}

/**
 * EXIF of every catalogue photo. Written with the repo's fixture writer (`testing/exif-writer`),
 * not sharp's EXIF writer: the worker-wide "no metadata-keeping sharp calls" tripwire
 * (docs/plans/step-4.md 4.4) covers this folder too. `gps` is never set.
 */
function exifFor(dateTimeOriginal: string, w: number, h: number): ExifSpec {
  return {
    make: "Fake",
    model: "Picker",
    dateTimeOriginal,
    offsetTimeOriginal: EXIF_OFFSET,
    exifImageWidth: w,
    exifImageHeight: h,
  };
}

/** CRC-32 (PNG chunk checksum). */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Insert an `eXIf` chunk (PNG 1.5 extension) before the first `IDAT`. */
function pngWithExif(png: Buffer, spec: ExifSpec): Buffer {
  if (png.toString("latin1", 1, 4) !== "PNG") throw new Error("not a PNG");
  let at = 8;
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") break;
    at += 12 + len;
  }
  const tiff = buildTiff(spec);
  const typeAndData = Buffer.concat([Buffer.from("eXIf", "latin1"), tiff]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(tiff.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([png.subarray(0, at), len, typeAndData, crc, png.subarray(at)]);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** A minimal ISO-BMFF `ftyp` box + padding: sniffs as `video/mp4`, decodes as nothing. */
function fakeMp4(): Buffer {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftypisom", 4, "latin1");
  ftyp.writeUInt32BE(0x200, 12);
  ftyp.write("isommp41", 16, "latin1");
  const free = Buffer.alloc(1000);
  free.writeUInt32BE(1000, 0);
  free.write("free", 4, "latin1");
  return Buffer.concat([ftyp, free]);
}

/** EXIF tags of `buf` (TIFF block read through sharp, which also handles WebP), or `null`. */
async function readExif(buf: Buffer): Promise<Record<string, unknown> | null> {
  const meta = await sharp(buf).metadata();
  if (!meta.exif || meta.exif.length <= 6) return null;
  // sharp returns the APP1 payload: "Exif\0\0" + TIFF.
  const tiff =
    meta.exif.subarray(0, 4).toString("latin1") === "Exif" ? meta.exif.subarray(6) : meta.exif;
  const parsed = (await exifr.parse(tiff, {
    tiff: true,
    ifd0: {},
    exif: true,
    gps: true,
    interop: false,
    ifd1: false,
    reviveValues: false,
    translateKeys: true,
  })) as Record<string, unknown> | undefined;
  return parsed ?? null;
}

/** True when `tags` holds any GPS field (exifr names them `GPS*`, plus `latitude`/`longitude`). */
function hasGps(tags: Record<string, unknown> | null): boolean {
  if (!tags) return false;
  return Object.keys(tags).some(
    (k) => k.startsWith("GPS") || k === "latitude" || k === "longitude",
  );
}

/**
 * Throws unless `buf` has no GPS tag (checked through sharp + exifr and, for formats exifr reads
 * natively, through exifr's own GPS reader) and, when `expectDate`, carries `DateTimeOriginal`.
 */
export async function assertFakeMediaClean(
  id: string,
  buf: Buffer,
  expectDate: boolean,
): Promise<void> {
  const tags = await readExif(buf);
  let gps: unknown;
  try {
    gps = await exifr.gps(buf);
  } catch {
    gps = undefined; // WebP: exifr has no container reader; the sharp path above covers it.
  }
  if (hasGps(tags) || gps !== undefined) {
    throw new Error(`fake catalogue item ${id} carries GPS`);
  }
  if (expectDate && (tags === null || tags.DateTimeOriginal === undefined)) {
    throw new Error(`fake catalogue item ${id} lacks DateTimeOriginal`);
  }
}

interface PhotoSpec {
  readonly id: string;
  readonly format: "jpeg" | "png" | "webp";
  readonly mimeType: string;
  readonly ext: string;
  readonly w: number;
  readonly h: number;
}

function photoSpecs(): PhotoSpec[] {
  const specs: PhotoSpec[] = [];
  for (let n = 1; n <= 8; n++) {
    const portrait = n % 2 === 0;
    specs.push({
      id: `G-${n}`,
      format: "jpeg",
      mimeType: "image/jpeg",
      ext: "jpg",
      w: portrait ? 480 : 640,
      h: portrait ? 640 : 480,
    });
  }
  specs.push({ id: "P-1", format: "png", mimeType: "image/png", ext: "png", w: 640, h: 480 });
  specs.push({ id: "W-1", format: "webp", mimeType: "image/webp", ext: "webp", w: 640, h: 480 });
  return specs;
}

async function renderPhoto(spec: PhotoSpec, exifDate: string, rnd: () => number): Promise<Buffer> {
  const img = sharp(sceneSvg(spec.w, spec.h, rnd));
  const exif = exifFor(exifDate, spec.w, spec.h);
  if (spec.format === "jpeg") return jpegWithExif(await img.jpeg({ quality: 80 }).toBuffer(), exif);
  if (spec.format === "png") {
    return pngWithExif(await img.png({ compressionLevel: 9 }).toBuffer(), exif);
  }
  return webpWithExif(await img.webp({ quality: 80 }).toBuffer(), exif, spec.w, spec.h);
}

export interface BuildFakeCatalogueOptions {
  /** Directory holding `FAKE_HEIC_FIXTURE` (`e2e/fixtures/heic`); H-1 is omitted without it. */
  readonly fixturesDir?: string | undefined;
}

/**
 * Renders the catalogue (12 items, 13 with the HEIC fixture). Deterministic for one sharp build.
 * Throws if any file carries GPS or a photo lacks `DateTimeOriginal`.
 */
export async function buildFakeCatalogue(
  options: BuildFakeCatalogueOptions = {},
): Promise<FakeCatalogueItem[]> {
  const rnd = prng(FAKE_CATALOGUE_SEED);
  const items: FakeCatalogueItem[] = [];
  let i = 0;

  for (const spec of photoSpecs()) {
    const t = captureTime(i);
    const bytes = await renderPhoto(spec, t.exif, rnd);
    items.push({
      id: spec.id,
      type: "PHOTO",
      mimeType: spec.mimeType,
      filename: `FAKE_${spec.id}.${spec.ext}`,
      width: spec.w,
      height: spec.h,
      createTime: t.createTime,
      exifDateTimeOriginal: t.exif,
      exifOffsetTimeOriginal: EXIF_OFFSET,
      bytes,
      sha256: sha256(bytes),
      claimedLength: null,
    });
    i++;
  }

  {
    const t = captureTime(i);
    const bytes = fakeMp4();
    items.push({
      id: "V-1",
      type: "VIDEO",
      mimeType: "video/mp4",
      filename: "FAKE_V-1.mp4",
      width: 640,
      height: 480,
      createTime: t.createTime,
      exifDateTimeOriginal: null,
      exifOffsetTimeOriginal: null,
      bytes,
      sha256: sha256(bytes),
      claimedLength: null,
    });
    i++;
  }

  {
    const t = captureTime(i);
    const head = await renderPhoto(
      { id: "X-1", format: "jpeg", mimeType: "image/jpeg", ext: "jpg", w: 640, h: 480 },
      t.exif,
      rnd,
    );
    // A valid JPEG start (sniffs as image/jpeg), then deterministic filler up to 1 MiB.
    const bytes = Buffer.alloc(FAKE_OVERSIZE_SENT_BYTES, 0x5a);
    head.copy(bytes, 0, 0, Math.min(head.length, bytes.length));
    items.push({
      id: "X-1",
      type: "PHOTO",
      mimeType: "image/jpeg",
      filename: "FAKE_X-1.jpg",
      width: 640,
      height: 480,
      createTime: t.createTime,
      exifDateTimeOriginal: t.exif,
      exifOffsetTimeOriginal: EXIF_OFFSET,
      bytes,
      sha256: sha256(bytes),
      claimedLength: FAKE_OVERSIZE_CLAIMED_BYTES,
    });
    i++;
  }

  if (options.fixturesDir) {
    const heic = await readFile(path.join(options.fixturesDir, FAKE_HEIC_FIXTURE)).catch(
      () => null,
    );
    if (heic) {
      const tags = await readExif(heic);
      const date = typeof tags?.DateTimeOriginal === "string" ? tags.DateTimeOriginal : null;
      const offset = typeof tags?.OffsetTimeOriginal === "string" ? tags.OffsetTimeOriginal : null;
      items.push({
        id: "H-1",
        type: "PHOTO",
        mimeType: "image/heic",
        filename: "FAKE_H-1.heic",
        width: 640,
        height: 480,
        createTime: exifToUtc(date, offset) ?? captureTime(i).createTime,
        exifDateTimeOriginal: date,
        exifOffsetTimeOriginal: offset,
        bytes: heic,
        sha256: sha256(heic),
        claimedLength: null,
      });
    }
  }

  for (const item of items) {
    // V-1 is a bare `ftyp` box built above (no metadata to read). X-1 is cut mid-file; its head
    // still must not carry GPS.
    if (item.type === "VIDEO") continue;
    await assertFakeMediaClean(item.id, item.bytes, item.id !== "X-1");
  }
  return items;
}

/** `"2026:06:14 15:04:05"` + `"-07:00"` ⇒ `"2026-06-14T22:04:05Z"`; `null` when unparsable. */
function exifToUtc(date: string | null, offset: string | null): string | null {
  if (!date) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(date);
  if (!m) return null;
  const off = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "Z";
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(".000Z", "Z");
}
