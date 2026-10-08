// Minimal EXIF writer for test fixtures (big-endian TIFF inside a JPEG APP1 segment or a WebP
// EXIF chunk). Test-only. The worker itself never writes metadata, and sharp's EXIF writer is
// deliberately not used here so the repo-wide "no metadata-keeping calls under apps/worker/src"
// check (docs/plans/step-4.md gate) stays clean.

type Value =
  | { type: "ascii"; value: string }
  | { type: "short"; value: number }
  | { type: "long"; value: number }
  | { type: "rational"; value: [number, number][] };

export interface ExifSpec {
  make?: string;
  model?: string;
  /** EXIF Orientation 1..8. */
  orientation?: number;
  /** Free-text tags that must NEVER reach `raw_json` (privacy whitelist test). */
  imageDescription?: string;
  artist?: string;
  /** `YYYY:MM:DD HH:MM:SS` */
  dateTimeOriginal?: string;
  /** `+02:00` */
  offsetTimeOriginal?: string;
  exifImageWidth?: number;
  exifImageHeight?: number;
  fNumber?: number;
  iso?: number;
  gps?: { lat: number; lng: number };
}

interface Entry {
  tag: number;
  v: Value;
}

const TYPE: Record<Value["type"], { id: number; size: number }> = {
  ascii: { id: 2, size: 1 },
  short: { id: 3, size: 2 },
  long: { id: 4, size: 4 },
  rational: { id: 5, size: 8 },
};

function encodeValue(v: Value): { count: number; bytes: Buffer } {
  switch (v.type) {
    case "ascii": {
      const b = Buffer.from(`${v.value}\0`, "latin1");
      return { count: b.length, bytes: b };
    }
    case "short": {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(v.value);
      return { count: 1, bytes: b };
    }
    case "long": {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(v.value);
      return { count: 1, bytes: b };
    }
    case "rational": {
      const b = Buffer.alloc(v.value.length * 8);
      v.value.forEach(([n, d], i) => {
        b.writeUInt32BE(n, i * 8);
        b.writeUInt32BE(d, i * 8 + 4);
      });
      return { count: v.value.length, bytes: b };
    }
  }
}

const ifdSize = (n: number) => 2 + n * 12 + 4;

/** Serialise IFD entries (sorted by tag) at `offset`; out-of-line values go to `data`. */
function writeIfd(entries: Entry[], offset: number, data: { buf: Buffer[]; base: number }): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const out = Buffer.alloc(ifdSize(sorted.length));
  out.writeUInt16BE(sorted.length, 0);
  sorted.forEach((e, i) => {
    const o = 2 + i * 12;
    const { count, bytes } = encodeValue(e.v);
    out.writeUInt16BE(e.tag, o);
    out.writeUInt16BE(TYPE[e.v.type].id, o + 2);
    out.writeUInt32BE(count, o + 4);
    if (bytes.length <= 4) {
      bytes.copy(out, o + 8);
    } else {
      const at = data.base + data.buf.reduce((n, b) => n + b.length, 0);
      out.writeUInt32BE(at, o + 8);
      data.buf.push(bytes.length % 2 ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes);
    }
  });
  out.writeUInt32BE(0, 2 + sorted.length * 12); // no next IFD
  void offset;
  return out;
}

function dms(value: number): [number, number][] {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return [
    [deg, 1],
    [min, 1],
    [Math.round(sec * 10_000), 10_000],
  ];
}

/** TIFF structure (starting with the byte-order mark) for `spec`. */
export function buildTiff(spec: ExifSpec): Buffer {
  const ifd0: Entry[] = [];
  const exif: Entry[] = [];
  const gps: Entry[] = [];
  if (spec.make) ifd0.push({ tag: 0x010f, v: { type: "ascii", value: spec.make } });
  if (spec.model) ifd0.push({ tag: 0x0110, v: { type: "ascii", value: spec.model } });
  if (spec.orientation) ifd0.push({ tag: 0x0112, v: { type: "short", value: spec.orientation } });
  if (spec.imageDescription)
    ifd0.push({ tag: 0x010e, v: { type: "ascii", value: spec.imageDescription } });
  if (spec.artist) ifd0.push({ tag: 0x013b, v: { type: "ascii", value: spec.artist } });
  if (spec.dateTimeOriginal)
    exif.push({ tag: 0x9003, v: { type: "ascii", value: spec.dateTimeOriginal } });
  if (spec.offsetTimeOriginal)
    exif.push({ tag: 0x9011, v: { type: "ascii", value: spec.offsetTimeOriginal } });
  if (spec.exifImageWidth)
    exif.push({ tag: 0xa002, v: { type: "long", value: spec.exifImageWidth } });
  if (spec.exifImageHeight)
    exif.push({ tag: 0xa003, v: { type: "long", value: spec.exifImageHeight } });
  if (spec.fNumber)
    exif.push({
      tag: 0x829d,
      v: { type: "rational", value: [[Math.round(spec.fNumber * 10), 10]] },
    });
  if (spec.iso) exif.push({ tag: 0x8827, v: { type: "short", value: spec.iso } });
  if (spec.gps) {
    gps.push({ tag: 0x0001, v: { type: "ascii", value: spec.gps.lat >= 0 ? "N" : "S" } });
    gps.push({ tag: 0x0002, v: { type: "rational", value: dms(spec.gps.lat) } });
    gps.push({ tag: 0x0003, v: { type: "ascii", value: spec.gps.lng >= 0 ? "E" : "W" } });
    gps.push({ tag: 0x0004, v: { type: "rational", value: dms(spec.gps.lng) } });
  }

  // Layout: header (8) | IFD0 | ExifIFD | GPS IFD | data area.
  const n0 = ifd0.length + (exif.length ? 1 : 0) + (gps.length ? 1 : 0);
  const exifAt = 8 + ifdSize(n0);
  const gpsAt = exifAt + (exif.length ? ifdSize(exif.length) : 0);
  const dataAt = gpsAt + (gps.length ? ifdSize(gps.length) : 0);
  if (exif.length) ifd0.push({ tag: 0x8769, v: { type: "long", value: exifAt } });
  if (gps.length) ifd0.push({ tag: 0x8825, v: { type: "long", value: gpsAt } });

  const data = { buf: [] as Buffer[], base: dataAt };
  const header = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
  const parts = [header, writeIfd(ifd0, 8, data)];
  if (exif.length) parts.push(writeIfd(exif, exifAt, data));
  if (gps.length) parts.push(writeIfd(gps, gpsAt, data));
  return Buffer.concat([...parts, ...data.buf]);
}

/** Insert an APP1 EXIF segment right after the SOI marker of a JPEG. */
export function jpegWithExif(jpeg: Buffer, spec: ExifSpec): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), buildTiff(spec)]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, jpeg.subarray(2)]);
}

/**
 * Wrap a simple (single VP8/VP8L chunk) WebP into an extended WebP carrying an EXIF chunk.
 * `width`/`height` are the canvas size.
 */
export function webpWithExif(webp: Buffer, spec: ExifSpec, width: number, height: number): Buffer {
  if (webp.toString("latin1", 0, 4) !== "RIFF" || webp.toString("latin1", 8, 12) !== "WEBP") {
    throw new Error("not a WebP");
  }
  const image = webp.subarray(12); // one or more chunks
  const vp8x = Buffer.alloc(18);
  vp8x.write("VP8X", 0, "latin1");
  vp8x.writeUInt32LE(10, 4);
  vp8x[8] = 0x08; // EXIF flag
  vp8x.writeUIntLE(width - 1, 12, 3);
  vp8x.writeUIntLE(height - 1, 15, 3);
  const tiff = buildTiff(spec);
  const exifChunk = Buffer.alloc(8);
  exifChunk.write("EXIF", 0, "latin1");
  exifChunk.writeUInt32LE(tiff.length, 4);
  const pad = tiff.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), vp8x, image, exifChunk, tiff, pad]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
