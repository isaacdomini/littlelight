/**
 * Generates the whole Tinyglow brand kit into /brand from code. Deterministic (byte-identical on rerun).
 *
 *   pnpm --filter @tinyglow/mobile-web exec tsx scripts/brand.ts
 *
 * The wordmark is Nunito Bold (SIL OFL), converted to outlined SVG paths by the tiny TrueType reader
 * below, so no font is needed at runtime and no font dependency is added. Only `sharp` (already a
 * dependency of this package) rasterises. The mark is the approved aperture + footprints drawing
 * (brand/concept/tinyglow-icon.svg); its geometry lives in src/components/logo/markGeometry.ts so
 * the in-app <LogoMark> and every exported file share it. Also refreshes apps/mobile-web/public.
 * There is deliberately no flat / simplified cut: small sizes scale the glowing icon.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  iconSvg,
  LOGO,
  MARK_VIEWBOX,
  type MarkOptions,
  markDoc,
  markSvg,
} from "../src/components/logo/markGeometry";

const here = dirname(fileURLToPath(import.meta.url));
const brand = join(here, "../../../brand");
const publicDir = join(here, "../public");
const png = { compressionLevel: 9, adaptiveFiltering: false, effort: 10 } as const;

// ---------------------------------------------------------------------------------------------
// Colours (docs/DESIGN.md)
// ---------------------------------------------------------------------------------------------
const C = {
  coral: "#E8836B",
  coralDark: "#F0957F",
  ink: "#1C1C1E",
  paper: "#F2F2F3",
  bg: "#FFFFFF",
  bgDark: "#0E0F11",
  surface: "#F7F6F4",
  border: "#ECEAE7",
  blush: "#FBE4DD",
};

// ---------------------------------------------------------------------------------------------
// Minimal TrueType reader: glyf outlines (simple + composite), cmap 4/12, hmtx. Enough for Latin.
// ---------------------------------------------------------------------------------------------
type Pt = { x: number; y: number; on: boolean };
type Glyph = { contours: Pt[][]; advance: number };

class Font {
  private dv: DataView;
  private tables = new Map<string, { off: number; len: number }>();
  readonly upem: number;
  private locaLong: boolean;
  private numHM: number;
  private cmap = new Map<number, number>();
  readonly capHeight: number;

  constructor(buf: Buffer) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const n = this.dv.getUint16(4);
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(...[0, 1, 2, 3].map((k) => buf[o + k] as number));
      this.tables.set(tag, { off: this.dv.getUint32(o + 8), len: this.dv.getUint32(o + 12) });
    }
    const head = this.t("head");
    this.upem = this.dv.getUint16(head + 18);
    this.locaLong = this.dv.getInt16(head + 50) === 1;
    this.numHM = this.dv.getUint16(this.t("hhea") + 34);
    this.capHeight = this.dv.getInt16(this.t("OS/2") + 88);
    this.readCmap();
  }

  private t(tag: string): number {
    const e = this.tables.get(tag);
    if (!e) throw new Error(`font table ${tag} missing`);
    return e.off;
  }

  private readCmap(): void {
    const base = this.t("cmap");
    const n = this.dv.getUint16(base + 2);
    for (let i = 0; i < n; i++) {
      const off = base + this.dv.getUint32(base + 4 + i * 8 + 4);
      const fmt = this.dv.getUint16(off);
      if (fmt === 4) {
        const segX2 = this.dv.getUint16(off + 6);
        const seg = segX2 / 2;
        const endO = off + 14;
        const startO = endO + segX2 + 2;
        const deltaO = startO + segX2;
        const rangeO = deltaO + segX2;
        for (let s = 0; s < seg; s++) {
          const end = this.dv.getUint16(endO + s * 2);
          const start = this.dv.getUint16(startO + s * 2);
          const delta = this.dv.getInt16(deltaO + s * 2);
          const ro = this.dv.getUint16(rangeO + s * 2);
          for (let c = start; c <= end && c !== 0xffff; c++) {
            let g: number;
            if (ro === 0) g = (c + delta) & 0xffff;
            else {
              const gi = this.dv.getUint16(rangeO + s * 2 + ro + (c - start) * 2);
              g = gi === 0 ? 0 : (gi + delta) & 0xffff;
            }
            if (g) this.cmap.set(c, g);
          }
        }
      } else if (fmt === 12) {
        const groups = this.dv.getUint32(off + 12);
        for (let g = 0; g < groups; g++) {
          const o = off + 16 + g * 12;
          const s = this.dv.getUint32(o);
          const e = this.dv.getUint32(o + 4);
          const gid = this.dv.getUint32(o + 8);
          for (let c = s; c <= e; c++) this.cmap.set(c, gid + (c - s));
        }
      }
    }
  }

  glyphFor(ch: string): Glyph {
    const gid = this.cmap.get(ch.codePointAt(0) as number);
    if (gid === undefined) throw new Error(`glyph missing for "${ch}"`);
    return this.glyph(gid);
  }

  private advance(gid: number): number {
    const hm = this.t("hmtx");
    return this.dv.getUint16(hm + Math.min(gid, this.numHM - 1) * 4);
  }

  private glyph(gid: number): Glyph {
    return { contours: this.outline(gid), advance: this.advance(gid) };
  }

  private outline(gid: number): Pt[][] {
    const loca = this.t("loca");
    const a = this.locaLong
      ? this.dv.getUint32(loca + gid * 4)
      : this.dv.getUint16(loca + gid * 2) * 2;
    const b = this.locaLong
      ? this.dv.getUint32(loca + gid * 4 + 4)
      : this.dv.getUint16(loca + gid * 2 + 2) * 2;
    if (a === b) return [];
    let p = this.t("glyf") + a;
    const nc = this.dv.getInt16(p);
    p += 10;
    if (nc >= 0) {
      const ends: number[] = [];
      for (let i = 0; i < nc; i++) ends.push(this.dv.getUint16(p + i * 2));
      p += nc * 2;
      p += 2 + this.dv.getUint16(p);
      const total = (ends[nc - 1] as number) + 1;
      const flags: number[] = [];
      while (flags.length < total) {
        const f = this.dv.getUint8(p++);
        flags.push(f);
        if (f & 8) {
          let r = this.dv.getUint8(p++);
          while (r-- > 0) flags.push(f);
        }
      }
      const xs: number[] = [];
      let v = 0;
      for (const f of flags) {
        if (f & 2) {
          const d = this.dv.getUint8(p++);
          v += f & 16 ? d : -d;
        } else if (!(f & 16)) {
          v += this.dv.getInt16(p);
          p += 2;
        }
        xs.push(v);
      }
      const ys: number[] = [];
      v = 0;
      for (const f of flags) {
        if (f & 4) {
          const d = this.dv.getUint8(p++);
          v += f & 32 ? d : -d;
        } else if (!(f & 32)) {
          v += this.dv.getInt16(p);
          p += 2;
        }
        ys.push(v);
      }
      const out: Pt[][] = [];
      let s = 0;
      for (const e of ends) {
        const c: Pt[] = [];
        for (let i = s; i <= e; i++) {
          c.push({ x: xs[i] as number, y: ys[i] as number, on: ((flags[i] as number) & 1) === 1 });
        }
        out.push(c);
        s = e + 1;
      }
      return out;
    }
    // composite
    const out: Pt[][] = [];
    for (;;) {
      const fl = this.dv.getUint16(p);
      const sub = this.dv.getUint16(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (fl & 1) {
        dx = this.dv.getInt16(p);
        dy = this.dv.getInt16(p + 2);
        p += 4;
      } else {
        dx = this.dv.getInt8(p);
        dy = this.dv.getInt8(p + 1);
        p += 2;
      }
      if (!(fl & 2)) throw new Error("composite glyph with point matching is unsupported");
      let sx = 1;
      let sy = 1;
      if (fl & 8) {
        sx = sy = this.dv.getInt16(p) / 16384;
        p += 2;
      } else if (fl & 0x40) {
        sx = this.dv.getInt16(p) / 16384;
        sy = this.dv.getInt16(p + 2) / 16384;
        p += 4;
      } else if (fl & 0x80) throw new Error("2x2 composite unsupported");
      for (const c of this.outline(sub)) {
        out.push(c.map((q) => ({ x: q.x * sx + dx, y: q.y * sy + dy, on: q.on })));
      }
      if (!(fl & 0x20)) break;
    }
    return out;
  }
}

const font = new Font(readFileSync(join(brand, "fonts/Nunito-Bold-subset.ttf")));

const num = (n: number): string => {
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

// Hand-tuned pair kerning (em/1000): the subset drops GPOS, so fix the pairs that matter for "Tinyglow".
const KERN: Record<string, number> = { Ti: -18, ny: -6, yg: 8 };

type Text = { d: string; width: number; top: number; bottom: number; cap: number };

/** Outline `str` at `size` px-units; baseline at y=0, starts at x=0, y grows downward. */
function textPath(str: string, size: number, tracking = 0): Text {
  const k = size / font.upem;
  let pen = 0;
  let top = 0;
  let bottom = 0;
  const parts: string[] = [];
  const chars = [...str];
  chars.forEach((ch, i) => {
    const g = font.glyphFor(ch);
    for (const c of g.contours) {
      const pts = c;
      const n = pts.length;
      const P = (q: Pt) => ({ x: pen + q.x * k, y: -q.y * k, on: q.on });
      const q = pts.map(P);
      for (const p of q) {
        top = Math.min(top, p.y);
        bottom = Math.max(bottom, p.y);
      }
      let startIdx = q.findIndex((p) => p.on);
      let start: { x: number; y: number };
      let seq: typeof q;
      if (startIdx === -1) {
        const a = q[0] as (typeof q)[0];
        const b = q[1] as (typeof q)[0];
        start = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        seq = [...q.slice(1), a];
        startIdx = -2;
      } else {
        start = q[startIdx] as (typeof q)[0];
        seq = [...q.slice(startIdx + 1), ...q.slice(0, startIdx + 1)];
      }
      let d = `M${num(start.x)} ${num(start.y)}`;
      let ctrl: { x: number; y: number } | null = null;
      for (const p of seq) {
        if (p.on) {
          d += ctrl
            ? `Q${num(ctrl.x)} ${num(ctrl.y)} ${num(p.x)} ${num(p.y)}`
            : `L${num(p.x)} ${num(p.y)}`;
          ctrl = null;
        } else {
          if (ctrl) {
            const mx = (ctrl.x + p.x) / 2;
            const my = (ctrl.y + p.y) / 2;
            d += `Q${num(ctrl.x)} ${num(ctrl.y)} ${num(mx)} ${num(my)}`;
          }
          ctrl = { x: p.x, y: p.y };
        }
      }
      if (ctrl) d += `Q${num(ctrl.x)} ${num(ctrl.y)} ${num(start.x)} ${num(start.y)}`;
      parts.push(`${d}Z`);
      void n;
    }
    pen += g.advance * k + tracking;
    const next = chars[i + 1];
    if (next) pen += ((KERN[ch + next] ?? 0) * size) / 1000;
  });
  return {
    d: parts.join(""),
    width: pen - tracking,
    top,
    bottom,
    cap: (font.capHeight * size) / font.upem,
  };
}

// ---------------------------------------------------------------------------------------------
// The mark (1024 coordinate space; see src/components/logo/markGeometry.ts)
// ---------------------------------------------------------------------------------------------
// Every embedded copy of the mark needs its own gradient/mask ids (several share one document).
let idSeq = 0;
const nextId = (): string => `m${++idSeq}`;

/** Mark markup (defs inline) for embedding in a larger document, in the 1024 space. */
function markBody(opts: MarkOptions = {}): string {
  const m = markSvg({ glow: 0.5, ...opts, id: opts.id ?? nextId() });
  return `<defs>${m.defs}</defs>${m.body}`;
}

/** Small-size tuning of the icon (favicons, 16-48 px): mark a touch larger, gaps and soles bolder,
 *  tighter glow. Still the same gradient + glow artwork, never a flat cut. */
const SMALL: MarkOptions & { scale: number } = {
  scale: 1.14,
  gap: 34,
  soleStroke: 26,
  glow: 0.6,
  glowBlur: 16,
};

const MARK_BOX = 600; // lockups size the aperture (750 units) to ~fill a 600-unit square…
const MK = MARK_BOX / 760;
const GLOW_PAD = 40; // …and pad the viewBox so the glow is not clipped
const placeMark = (body: string, cx: number, cy: number, scale: number): string =>
  `<g transform="translate(${num(cx)} ${num(cy)}) scale(${num(scale * MK)}) translate(-512 -512)">${body}</g>`;

// ---------------------------------------------------------------------------------------------
// Lockups
// ---------------------------------------------------------------------------------------------
type Variant = "light" | "dark" | "white" | "black";
const VARIANTS: Variant[] = ["light", "dark", "white", "black"];
/** The mark is always full colour; variants change the wordmark colour. */
const textColour = (v: Variant): string =>
  ({ light: C.ink, dark: C.paper, white: "#FFFFFF", black: "#000000" })[v];

type Kind = "horizontal" | "stacked" | "wordmark";
const KINDS: Kind[] = ["horizontal", "stacked", "wordmark"];
type Lockup = { vb: [number, number, number, number]; body: string };

const WORD = "Tinyglow";
const WS = 430; // wordmark font size in lockup units (same layout as Logo.tsx)
const TRACK = 4;

function markLockup(): Lockup {
  const [x, y, w, h] = MARK_VIEWBOX;
  return { vb: [x, y, w, h], body: markBody() };
}

function lockup(kind: Kind, v: Variant): Lockup {
  const text = textColour(v);
  const t = textPath(WORD, WS, TRACK);
  const pad = 4;
  if (kind === "wordmark") {
    return {
      vb: [-pad, t.top - pad, t.width + pad * 2, t.bottom - t.top + pad * 2],
      body: `<path fill="${text}" d="${t.d}"/>`,
    };
  }
  if (kind === "horizontal") {
    const gap = 170;
    const tx = MARK_BOX + gap;
    const base = MARK_BOX / 2 + t.cap / 2; // cap height centred on the mark
    const w = tx + t.width;
    return {
      vb: [-GLOW_PAD, -GLOW_PAD, w + GLOW_PAD * 2, MARK_BOX + GLOW_PAD * 2],
      body:
        placeMark(markBody(), MARK_BOX / 2, MARK_BOX / 2, 1) +
        `<path fill="${text}" transform="translate(${num(tx)} ${num(base)})" d="${t.d}"/>`,
    };
  }
  // stacked: mark above, wordmark centred below
  const ts = 270;
  const t2 = textPath(WORD, ts, TRACK * (ts / WS));
  const markSize = 860;
  const k = markSize / MARK_BOX;
  const gap = 30;
  const w = Math.max(t2.width, markSize);
  const ty = markSize + gap + t2.cap;
  return {
    vb: [-GLOW_PAD, -GLOW_PAD, w + GLOW_PAD * 2, ty + t2.bottom + 4 + GLOW_PAD * 2],
    body:
      placeMark(markBody(), w / 2, markSize / 2, k) +
      `<path fill="${text}" transform="translate(${num((w - t2.width) / 2)} ${num(ty)})" d="${t2.d}"/>`,
  };
}

const svgDoc = (l: Lockup, title: string, width?: number, extra = ""): string => {
  const [x, y, w, h] = l.vb;
  const size = width ? ` width="${width}" height="${Math.round((width * h) / w)}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}"${size}>` +
    `<title>${title}</title>${extra}${l.body}</svg>\n`
  );
};

// ---------------------------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------------------------
const written: string[] = [];
function out(rel: string, data: Buffer | string): void {
  const p = join(brand, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  written.push(rel);
}
/** Copy a generated brand file into apps/mobile-web/public. */
function publish(rel: string, data: Buffer | string): void {
  const p = join(publicDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  written.push(`(public) ${rel}`);
}

/** Render an SVG document at `width` px (rasterised at 1:1 from its own size); optional bg. */
async function renderSvg(svg: string, width: number, bg?: string): Promise<Buffer> {
  const vb = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  const vw = vb ? Number(vb[1]) : width;
  const vh = vb ? Number(vb[2]) : width;
  const height = Math.round((width * vh) / vw);
  // Re-size the root element so librsvg rasterises at the target size (crisp, no resampling).
  const sized = svg.replace(/^<svg([^>]*?)( width="[^"]*" height="[^"]*")?>/, (_m, a: string) => {
    const attrs = a.replace(/ width="[^"]*"| height="[^"]*"/g, "");
    return `<svg${attrs} width="${width}" height="${height}">`;
  });
  let img = sharp(Buffer.from(sized), { density: 72 }).resize(width, height);
  if (bg) img = img.flatten({ background: bg });
  return img.png(png).toBuffer();
}

const lockupPng = (l: Lockup, width: number, bg?: string): Promise<Buffer> =>
  renderSvg(svgDoc(l, "Tinyglow"), width, bg);

/** Label text as outlined paths (the brand sheet needs no font either). */
function label(
  str: string,
  size: number,
  x: number,
  y: number,
  fill: string,
  anchor: "start" | "middle" = "start",
): string {
  const t = textPath(str, size);
  const dx = anchor === "middle" ? x - t.width / 2 : x;
  return `<path fill="${fill}" transform="translate(${num(dx)} ${num(y)})" d="${t.d}"/>`;
}

const nested = (l: Lockup, x: number, y: number, w: number, h: number): string => {
  const [vx, vy, vw, vh] = l.vb;
  return `<svg x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}" preserveAspectRatio="xMidYMid meet">${l.body}</svg>`;
};

/** App icon artwork embedded at (x, y) with side `s` (for sheets/showcases). */
const iconAt = (x: number, y: number, s: number, opts: Parameters<typeof iconSvg>[0] = {}) =>
  iconSvg({ ...opts, id: nextId() }).replace(
    /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 1024 1024" width="1024" height="1024">/,
    `<svg x="${num(x)}" y="${num(y)}" width="${num(s)}" height="${num(s)}" viewBox="0 0 1024 1024">`,
  );

// ---------------------------------------------------------------------------------------------
// 1. Logo SVG masters
// ---------------------------------------------------------------------------------------------
function logos(): void {
  out("logo/mark.svg", markDoc({ id: "m" }));
  out("logo/app-icon.svg", iconSvg({ id: "m" }));
  out("logo/app-icon-small.svg", iconSvg({ id: "m", ...SMALL }));
  for (const kind of KINDS) {
    for (const v of VARIANTS) {
      idSeq = 0;
      out(
        `logo/${kind === "wordmark" ? "wordmark" : `logo-${kind}`}-${v}.svg`,
        svgDoc(lockup(kind, v), `Tinyglow ${kind}`),
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 2. PNG exports
// ---------------------------------------------------------------------------------------------
const MARK_SIZES = [24, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
const ICON_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
async function pngs(): Promise<void> {
  const mark = markDoc({ id: "m" });
  for (const s of MARK_SIZES) out(`png/mark/mark-${s}.png`, await renderSvg(mark, s));
  for (const s of [512, 1024]) {
    out(`png/mark/mark-on-white-${s}.png`, await renderSvg(mark, s, C.bg));
    out(`png/mark/mark-on-dark-${s}.png`, await renderSvg(mark, s, C.bgDark));
  }
  for (const s of ICON_SIZES) {
    const svg = s <= 48 ? iconSvg({ id: "m", ...SMALL }) : iconSvg({ id: "m" });
    out(`png/app-icon/app-icon-${s}.png`, await renderSvg(svg, s));
  }
  out(
    "png/app-icon/app-icon-square-1024.png",
    await renderSvg(iconSvg({ id: "m", radius: 0 }), 1024),
  );
  for (const w of [512, 1024, 2048]) {
    out(
      `png/horizontal/logo-horizontal-${w}.png`,
      await lockupPng(lockup("horizontal", "light"), w),
    );
    out(
      `png/horizontal/logo-horizontal-dark-${w}.png`,
      await lockupPng(lockup("horizontal", "dark"), w),
    );
    out(
      `png/horizontal/logo-horizontal-on-white-${w}.png`,
      await lockupPng(lockup("horizontal", "light"), w, C.bg),
    );
    out(
      `png/horizontal/logo-horizontal-on-dark-${w}.png`,
      await lockupPng(lockup("horizontal", "dark"), w, C.bgDark),
    );
  }
  out("png/stacked/logo-stacked-1024.png", await lockupPng(lockup("stacked", "light"), 1024));
  out("png/stacked/logo-stacked-dark-1024.png", await lockupPng(lockup("stacked", "dark"), 1024));
  out("png/wordmark/wordmark-1024.png", await lockupPng(lockup("wordmark", "light"), 1024));
  out("png/wordmark/wordmark-dark-1024.png", await lockupPng(lockup("wordmark", "dark"), 1024));
}

// ---------------------------------------------------------------------------------------------
// 3. Web icon set (also copied into apps/mobile-web/public)
// ---------------------------------------------------------------------------------------------
function icoFrom(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let off = head.length;
  images.forEach((im, i) => {
    const o = 6 + i * 16;
    head[o] = im.size;
    head[o + 1] = im.size;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(im.data.length, o + 8);
    head.writeUInt32LE(off, o + 12);
    off += im.data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

async function web(): Promise<void> {
  const both = (rel: string, pub: string, data: Buffer | string) => {
    out(rel, data);
    publish(pub, data);
  };
  // Favicons: the small-size tuned app icon (night square), which holds up better than the
  // transparent mark on any tab colour.
  const small = iconSvg({ id: "m", ...SMALL });
  both("web/favicon.svg", "favicon.svg", small);
  const frames: { size: number; data: Buffer }[] = [];
  for (const s of [16, 32, 48]) frames.push({ size: s, data: await renderSvg(small, s) });
  both("web/favicon.ico", "favicon.ico", icoFrom(frames));
  // apple-touch-icon: opaque full-bleed square (iOS applies its own rounding).
  both(
    "web/apple-touch-icon.png",
    "apple-touch-icon.png",
    await renderSvg(iconSvg({ id: "m", radius: 0 }), 180, LOGO.night),
  );
  both("web/icon-192.png", "icons/icon-192.png", await renderSvg(iconSvg({ id: "m" }), 192));
  both("web/icon-512.png", "icons/icon-512.png", await renderSvg(iconSvg({ id: "m" }), 512));
  // Maskable: full bleed; the aperture (r 375/1024 = 37 %) sits inside the 40 % safe circle.
  both(
    "web/icon-maskable-512.png",
    "icons/icon-maskable-512.png",
    await renderSvg(iconSvg({ id: "m", radius: 0, scale: 0.94 }), 512, LOGO.night),
  );
  out(
    "web/README.md",
    "Web icon set, also written straight into apps/mobile-web/public by scripts/brand.ts:\n\n" +
      "- favicon.ico (16/32/48) and favicon.svg: the app icon tuned for small sizes (night square, glowing mark)\n" +
      "- apple-touch-icon.png (180, opaque, full bleed)\n" +
      "- icon-192.png, icon-512.png (purpose `any`, rounded), icon-maskable-512.png (purpose `maskable`, full bleed, mark inside the 80 % safe zone)\n",
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Social and marketing
// ---------------------------------------------------------------------------------------------
const nightBg = (id: string, w: number, h: number): string =>
  `<defs><radialGradient id="${id}" cx="50%" cy="42%" r="75%"><stop offset="0" stop-color="#33263D"/><stop offset=".6" stop-color="${LOGO.night}"/><stop offset="1" stop-color="#17131F"/></radialGradient></defs>` +
  `<rect width="${w}" height="${h}" fill="url(#${id})"/>`;

async function social(): Promise<void> {
  // OG image 1200x630: night field, glowing horizontal lockup, tagline.
  const W = 1200;
  const H = 630;
  idSeq = 0;
  const logo = lockup("horizontal", "dark");
  const lw = 700;
  const lh = (lw * logo.vb[3]) / logo.vb[2];
  const tag = textPath("Your baby’s photos, beautifully kept", 44);
  const gy = 160;
  const og =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    nightBg("bg", W, H) +
    nested(logo, (W - lw) / 2, gy, lw, lh) +
    `<path fill="${C.paper}" fill-opacity="0.8" transform="translate(${num((W - tag.width) / 2)} ${num(gy + lh + 90)})" d="${tag.d}"/></svg>`;
  const ogPng = await renderSvg(og, W);
  out("social/og-image.png", ogPng);
  publish("og-image.png", ogPng);

  // App icon showcase: 1024 icon (rounded) on a warm background, 2048x1536 canvas.
  const SW = 2048;
  const SH = 1536;
  const icon = 1024;
  const showcase =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SW} ${SH}" width="${SW}" height="${SH}">` +
    `<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF4E4"/><stop offset="1" stop-color="#F6CFB8"/></linearGradient>` +
    `<filter id="s" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="28" stdDeviation="36" flood-color="#2A1F33" flood-opacity="0.35"/></filter></defs>` +
    `<rect width="${SW}" height="${SH}" fill="url(#b)"/>` +
    `<g filter="url(#s)">${iconAt((SW - icon) / 2, (SH - icon) / 2, icon)}</g></svg>`;
  out("social/app-icon-showcase.png", await renderSvg(showcase, SW));

  // Avatars 400x400 (platforms crop to a circle: keep the aperture well inside).
  out(
    "social/avatar-night-400.png",
    await renderSvg(iconSvg({ id: "m", radius: 0, scale: 1.1 }), 400, LOGO.night),
  );
  const white =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><rect width="1024" height="1024" fill="#FFFFFF"/>` +
    `<g transform="translate(512 512) scale(1.05) translate(-512 -512)">${markBody({ id: "m" })}</g></svg>`;
  out("social/avatar-white-400.png", await renderSvg(white, 400, C.bg));
}

// ---------------------------------------------------------------------------------------------
// 5. Email logos (240 pt wide at 2x = 480 px). public/email/logo.png = logo-email.png.
// ---------------------------------------------------------------------------------------------
/** Email lockup at the exact 480x108 the GoTrue and API templates declare (240x54 at 2x): the
 *  mark is shrunk so its glow fits the 600-unit box instead of padding the viewBox. */
function emailLockup(v: Variant): Lockup {
  const t = textPath(WORD, WS, TRACK);
  const w = (MARK_BOX * 480) / 108;
  const content = MARK_BOX + 170 + t.width;
  const base = MARK_BOX / 2 + t.cap / 2;
  return {
    vb: [-(w - content) / 2, 0, w, MARK_BOX],
    body:
      placeMark(markBody(), MARK_BOX / 2, MARK_BOX / 2, 760 / MARK_VIEWBOX[2]) +
      `<path fill="${textColour(v)}" transform="translate(${num(MARK_BOX + 170)} ${num(base)})" d="${t.d}"/>`,
  };
}

async function email(): Promise<void> {
  idSeq = 0;
  const light = await lockupPng(emailLockup("light"), 480);
  out("email/logo-email.png", light);
  publish("email/logo.png", light);
  out("email/logo-email-on-white.png", await lockupPng(emailLockup("light"), 480, C.bg));
  out("email/logo-email-dark.png", await lockupPng(emailLockup("dark"), 480));
}

// ---------------------------------------------------------------------------------------------
// 6. Clear-space diagram and brand sheet
// ---------------------------------------------------------------------------------------------
async function clearSpace(): Promise<void> {
  idSeq = 0;
  const l = lockup("horizontal", "light");
  const ap = 375 * MK; // aperture radius in lockup units
  const x = Math.round(ap); // clear space x = aperture radius
  const w = l.vb[2] - GLOW_PAD * 2; // measured from the aperture and wordmark, not the glow
  const h = l.vb[3] - GLOW_PAD * 2;
  const pad = 40;
  const total = { w: w + 2 * x + 2 * pad, h: h + 2 * x + 2 * pad };
  const ox = pad + x;
  const oy = pad + x;
  const sq = (px: number, py: number) =>
    `<rect x="${px}" y="${py}" width="${x}" height="${x}" fill="${C.coral}" fill-opacity="0.18" stroke="${C.coral}" stroke-width="3" stroke-dasharray="14 10"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total.w} ${total.h}" width="${total.w}" height="${total.h}">` +
    `<rect width="${total.w}" height="${total.h}" fill="#FFFFFF"/>` +
    `<rect x="${pad}" y="${pad}" width="${w + 2 * x}" height="${h + 2 * x}" fill="none" stroke="${C.coral}" stroke-width="3" stroke-dasharray="14 10"/>` +
    `<rect x="${ox}" y="${oy}" width="${w}" height="${h}" fill="none" stroke="#B9B9BE" stroke-width="2"/>` +
    sq(pad, pad) +
    sq(ox + w, pad) +
    sq(pad, oy + h) +
    sq(ox + w, oy + h) +
    `<g transform="translate(${ox} ${oy})">${l.body}</g>` +
    `<line x1="${ox + 300}" y1="${oy + 300}" x2="${num(ox + 300 + ap)}" y2="${oy + 300}" stroke="#6B6B70" stroke-width="3" stroke-dasharray="8 8"/>` +
    `<circle cx="${ox + 300}" cy="${oy + 300}" r="${num(ap)}" fill="none" stroke="#6B6B70" stroke-width="2" stroke-dasharray="8 8"/>` +
    label("x", 120, pad + x / 2, pad + x / 2 + 42, C.coral, "middle") +
    label("x", 120, ox + w + x / 2, pad + x / 2 + 42, C.coral, "middle") +
    label("x", 120, pad + x / 2, oy + h + x / 2 + 42, C.coral, "middle") +
    label("x", 120, ox + w + x / 2, oy + h + x / 2 + 42, C.coral, "middle") +
    `</svg>`;
  out("clear-space.png", await renderSvg(svg, 1600));
}

async function sheet(): Promise<void> {
  idSeq = 0;
  const W = 2400;
  const margin = 40;
  const gutter = 24;
  const cols = VARIANTS.length;
  const tw = (W - 2 * margin - (cols - 1) * gutter) / cols;
  const th = 290;
  const tiles: Record<Variant, string> = {
    light: C.bg,
    dark: C.bgDark,
    white: LOGO.night,
    black: C.surface,
  };
  const names: Record<Variant, string> = {
    light: "Light background (ink wordmark)",
    dark: "Dark background (paper wordmark)",
    white: "White wordmark (photos, night)",
    black: "Black wordmark (pale fields)",
  };
  let y = margin;
  let body = "";
  body += label("Tinyglow brand sheet", 76, margin, y + 64, C.ink);
  body += label(
    "Mark: a warm aperture glowing around two baby footprints.   Wordmark: Nunito Bold (SIL OFL), outlined.   No flat cut.",
    28,
    margin,
    y + 120,
    "#6B6B70",
  );
  y += 170;
  VARIANTS.forEach((v, i) => {
    body += label(names[v], 26, margin + i * (tw + gutter), y + 24, C.ink);
  });
  y += 44;
  for (const kind of [...KINDS, "mark"] as const) {
    VARIANTS.forEach((v, i) => {
      const x = margin + i * (tw + gutter);
      body += `<rect x="${num(x)}" y="${y}" width="${num(tw)}" height="${th}" rx="20" fill="${tiles[v]}" stroke="${C.border}" stroke-width="2"/>`;
      const l = kind === "mark" ? markLockup() : lockup(kind, v);
      const pw = kind === "mark" ? 200 : kind === "stacked" ? 220 : tw - 100;
      const ph = kind === "mark" ? 200 : kind === "stacked" ? th - 50 : 130;
      body += nested(l, x + (tw - pw) / 2, y + (th - ph) / 2, pw, ph);
    });
    y += th + gutter;
  }
  // app icon at sizes
  y += 10;
  body += label(
    "App icon (favicons use the small-size tuning at 16-48 px)",
    30,
    margin,
    y + 28,
    C.ink,
  );
  y += 52;
  body += `<rect x="${margin}" y="${y}" width="${W - 2 * margin}" height="340" rx="20" fill="${C.surface}" stroke="${C.border}" stroke-width="2"/>`;
  let ix = margin + 40;
  for (const s of [240, 120, 60, 48, 32, 16]) {
    const opts = s <= 48 ? SMALL : {};
    body += iconAt(ix, y + 150 - s / 2, s, opts);
    body += label(`${s}`, 24, ix + s / 2, y + 315, "#6B6B70", "middle");
    ix += s + 60;
  }
  y += 340 + gutter;
  // palette
  y += 10;
  body += label(
    "Colour (logo: night, butter, apricot. UI accent stays coral)",
    30,
    margin,
    y + 28,
    C.ink,
  );
  y += 52;
  const sw: [string, string, string, string][] = [
    ["Night purple (logo)", LOGO.night, "#FFFFFF", "31 26 46"],
    ["Butter (logo)", LOGO.butter, C.ink, "251 223 151"],
    ["Apricot (logo)", LOGO.apricot, C.ink, "242 180 127"],
    ["Coral (UI accent)", C.coral, C.ink, "232 131 107"],
    ["Coral dark mode (UI)", C.coralDark, C.ink, "240 149 127"],
    ["Ink", C.ink, "#FFFFFF", "28 28 30"],
    ["Paper", C.paper, C.ink, "242 242 243"],
  ];
  const swc = sw.length;
  const sww = (W - 2 * margin - (swc - 1) * gutter) / swc;
  sw.forEach(([n, hex, fg, rgb], i) => {
    const x = margin + i * (sww + gutter);
    body += `<rect x="${num(x)}" y="${y}" width="${num(sww)}" height="170" rx="20" fill="${hex}" stroke="${C.border}" stroke-width="2"/>`;
    body += label(n, 22, x + 20, y + 50, fg);
    body += label(hex, 32, x + 20, y + 100, fg);
    body += label(`RGB ${rgb}`, 20, x + 20, y + 140, fg);
  });
  y += 170 + margin;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${y}" width="${W}" height="${y}"><rect width="${W}" height="${y}" fill="#FFFFFF"/>${body}</svg>`;
  out("brand-sheet.png", await renderSvg(svg, W));
}

// ---------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  for (const d of ["logo", "png", "web", "social", "email"])
    rmSync(join(brand, d), { recursive: true, force: true });
  logos();
  await pngs();
  await web();
  await social();
  await email();
  await clearSpace();
  await sheet();
  // eslint-disable-next-line no-console
  console.log(`brand: wrote ${written.length} files (brand/ and apps/mobile-web/public)`);
}

await main();
