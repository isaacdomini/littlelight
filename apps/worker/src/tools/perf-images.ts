import { babyPrefix, type DerivativeKind } from "@littlelight/shared";
import sharp from "sharp";
import { decodeImage } from "../ingest/decode";
import { renderDerivative } from "../ingest/derivatives";
import { mulberry32, PERF_LANDSCAPE_MONTHS, PERF_MONTHS } from "./perf-content";

// Base images of the dev-only performance seed (docs/plans/step-5.md 2.8): one synthetic picture
// per month of age (a month-hued gradient, 8 circles and a large "W1-5" / "M7" block drawn as
// strokes, so a photo in the wrong age group is obvious while scrolling), rasterised once and
// pushed through the worker's real derivative renderer (`renderDerivative`: thumb 320 px,
// display 1600 px, metadata-free mozjpeg). No `analysis` derivative: the perf baby is free tier
// and is never analysed. Glyphs are SVG paths, not text, so no font is needed on the host.

/** Derivative kinds the seed stores per photo (never `analysis`). */
export const PERF_DERIVATIVE_KINDS = [
  "thumb",
  "display",
] as const satisfies readonly DerivativeKind[];
export type PerfDerivativeKind = (typeof PERF_DERIVATIVE_KINDS)[number];

/** Source raster size (a half-resolution 12 MP frame; display derivatives are 1600 px long). */
const LONG_EDGE = 2016;
const SHORT_EDGE = 1512;

/** `babies/<baby>/derivatives/_base/<kind>-<month>.jpg` (month 0..23). */
export function perfBaseKey(babyId: string, kind: PerfDerivativeKind, month: number): string {
  if (!Number.isInteger(month) || month < 0 || month >= PERF_MONTHS) {
    throw new RangeError(`month must be an integer in 0..${PERF_MONTHS - 1}`);
  }
  return `${babyPrefix(babyId)}derivatives/_base/${kind}-${month}.jpg`;
}

/** The prefix holding the base images (excluded from per-photo object counts). */
export function perfBasePrefix(babyId: string): string {
  return `${babyPrefix(babyId)}derivatives/_base/`;
}

/**
 * Big label of a month's image: months 0–2 span weeks (`W1-5`, `W5-9`, `W9-12`; the timeline
 * groups the first 84 days by week), later months are `M<n>` matching the `m<n>` group key.
 */
export function perfMonthLabel(month: number): string {
  if (month >= 3) return `M${month + 1}`;
  const first = Math.ceil(month * 30.4375);
  const last = Math.min(Math.ceil((month + 1) * 30.4375) - 1, 83);
  return `W${Math.floor(first / 7) + 1}-${Math.floor(last / 7) + 1}`;
}

// Glyphs on a 1 x 2 box as polylines (seven segments for digits, strokes for M, W and "-").
const SEG: Record<string, [number, number, number, number]> = {
  a: [0, 0, 1, 0],
  b: [1, 0, 1, 1],
  c: [1, 1, 1, 2],
  d: [0, 2, 1, 2],
  e: [0, 1, 0, 2],
  f: [0, 0, 0, 1],
  g: [0, 1, 1, 1],
};
const DIGITS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};
const LETTERS: Record<string, number[][]> = {
  M: [[0, 2, 0, 0, 0.5, 1, 1, 0, 1, 2]],
  W: [[0, 0, 0.25, 2, 0.5, 1, 0.75, 2, 1, 0]],
  "-": [[0.15, 1, 0.85, 1]],
};

function glyphPolylines(ch: string): number[][] {
  const digit = DIGITS[ch];
  if (digit) return [...digit].map((s) => SEG[s] as number[]);
  const letter = LETTERS[ch];
  if (letter) return letter;
  throw new Error(`no glyph for ${ch}`);
}

function labelPath(label: string, x0: number, y0: number, w: number, h: number, gap: number) {
  const parts: string[] = [];
  [...label].forEach((ch, i) => {
    const gx = x0 + i * (w + gap);
    for (const line of glyphPolylines(ch)) {
      const pts: string[] = [];
      for (let k = 0; k < line.length; k += 2) {
        pts.push(
          `${(gx + (line[k] as number) * w).toFixed(1)} ${(y0 + ((line[k + 1] as number) * h) / 2).toFixed(1)}`,
        );
      }
      parts.push(`M${pts.join(" L")}`);
    }
  });
  return parts.join(" ");
}

function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** The SVG of one month's base picture (exported for tests). */
export function perfBaseSvg(month: number): { svg: string; width: number; height: number } {
  const landscape = PERF_LANDSCAPE_MONTHS.has(month);
  const width = landscape ? LONG_EDGE : SHORT_EDGE;
  const height = landscape ? SHORT_EDGE : LONG_EDGE;
  const hue = (month * 15) % 360;
  const r = mulberry32(0x5eed + month);
  const circles: string[] = [];
  for (let i = 0; i < 8; i++) {
    const cx = Math.round(r() * width);
    const cy = Math.round(r() * height);
    const rad = Math.round((0.04 + r() * 0.14) * width);
    const fill = hslHex((hue + 120 + Math.round(r() * 120)) % 360, 0.6, 0.6 + r() * 0.25);
    circles.push(
      `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${fill}" fill-opacity="${(0.25 + r() * 0.4).toFixed(2)}"/>`,
    );
  }
  const label = perfMonthLabel(month);
  const gh = Math.round(Math.min(width, height) * 0.28); // glyph height
  const gw = Math.round(gh * 0.45);
  const gap = Math.round(gw * 0.45);
  const lw = label.length * gw + (label.length - 1) * gap;
  const x0 = Math.round((width - lw) / 2);
  const y0 = Math.round((height - gh) / 2);
  const pad = Math.round(gh * 0.25);
  const path = labelPath(label, x0, y0, gw, gh, gap);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${hslHex(hue, 0.7, 0.78)}"/><stop offset="1" stop-color="${hslHex((hue + 40) % 360, 0.6, 0.42)}"/>
</linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#g)"/>
${circles.join("\n")}
<rect x="${x0 - pad}" y="${y0 - pad}" width="${lw + 2 * pad}" height="${gh + 2 * pad}" rx="${pad}" fill="#000000" fill-opacity="0.35"/>
<path d="${path}" fill="none" stroke="#ffffff" stroke-width="${Math.round(gw * 0.2)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
  return { svg, width, height };
}

export interface PerfBaseImage {
  month: number;
  kind: PerfDerivativeKind;
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
}

/** Render one month's base image as a PNG and then through `renderDerivative` per kind. */
export async function renderPerfBase(month: number): Promise<PerfBaseImage[]> {
  const { svg } = perfBaseSvg(month);
  const png = await sharp(Buffer.from(svg, "utf8")).png({ compressionLevel: 1 }).toBuffer();
  const source = await decodeImage(png, "image/png");
  try {
    const out: PerfBaseImage[] = [];
    for (const kind of PERF_DERIVATIVE_KINDS) {
      const d = await renderDerivative(source, kind);
      out.push({ month, kind, buffer: d.buffer, width: d.width, height: d.height, bytes: d.bytes });
    }
    return out;
  } finally {
    source.release();
  }
}

/** All 48 base images (24 months x thumb/display), months rendered with limited parallelism. */
export async function renderPerfBases(parallel = 4): Promise<PerfBaseImage[]> {
  const months = Array.from({ length: PERF_MONTHS }, (_, m) => m);
  const out: PerfBaseImage[][] = new Array(PERF_MONTHS);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, parallel) }, async () => {
      while (next < months.length) {
        const m = next++;
        out[m] = await renderPerfBase(m);
      }
    }),
  );
  return out.flat();
}
