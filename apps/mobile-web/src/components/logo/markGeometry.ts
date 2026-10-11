/**
 * Geometry of the Tinyglow mark: a six-blade camera aperture glowing warm around two baby
 * footprints (brand/concept/tinyglow-icon.svg). Pure data, no DOM: shared by Logo.tsx and the
 * brand kit generator (scripts/brand.ts), so the in-app mark and every exported asset match.
 *
 * Coordinates are a 1024 x 1024 space centred on (512, 512). Measured from the approved drawing.
 */

const f = (n: number): number => +n.toFixed(1);
type P = [number, number];

export const C = 512; // centre
export const R = 375; // aperture radius
const H = 0.71 * R; // hexagon circumradius (flat top / bottom)
const BEND = -3; // degrees: each blade edge bows slightly as it reaches the rim
export const TILT = -3; // the drawing is turned very slightly anticlockwise

/** Default gap between blades, and the corner rounding applied as a round-join stroke. */
export const GAP = 24;
export const ROUND = 14;

const vert = (i: number): P => {
  const a = (-60 * i * Math.PI) / 180;
  return [C + H * Math.cos(a), C + H * Math.sin(a)];
};

/**
 * One blade (the top one) as a path; the other five are 60° rotations. Hexagon edge k is
 * extended past one vertex to the rim; the blade sits between two consecutive extended edges.
 * `g` is the gap; `round` shrinks the blade so a round-join stroke of that width restores it.
 */
export function bladePath(g = GAP, round = ROUND): string {
  const off = g / 2 + round / 2;
  const rIn = R - round / 2;
  type Line = { p: P; d: P; n: P };
  const lineOff = (p: P, q: P, d: number): Line => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const L = Math.hypot(dx, dy);
    let nx = dy / L;
    let ny = -dx / L;
    if (nx * ((p[0] + q[0]) / 2 - C) + ny * ((p[1] + q[1]) / 2 - C) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { p: [p[0] + nx * d, p[1] + ny * d], d: [dx / L, dy / L], n: [nx, ny] };
  };
  const hitCircle = (Ln: Line): P => {
    const ox = Ln.p[0] - C;
    const oy = Ln.p[1] - C;
    const b = ox * Ln.d[0] + oy * Ln.d[1];
    const c = ox * ox + oy * oy - rIn * rIn;
    const t = -b + Math.sqrt(b * b - c);
    return [Ln.p[0] + Ln.d[0] * t, Ln.p[1] + Ln.d[1] * t];
  };
  const cross = (A: Line, B: Line): P => {
    const den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
    const t = ((B.p[0] - A.p[0]) * B.d[1] - (B.p[1] - A.p[1]) * B.d[0]) / den;
    return [A.p[0] + A.d[0] * t, A.p[1] + A.d[1] * t];
  };
  const turn = (pt: P, deg: number): P => {
    const a = (deg * Math.PI) / 180;
    const x = pt[0] - C;
    const y = pt[1] - C;
    return [C + x * Math.cos(a) - y * Math.sin(a), C + x * Math.sin(a) + y * Math.cos(a)];
  };
  const A = lineOff(vert(1), vert(2), off); // blade on A's outer side
  const B = lineOff(vert(0), vert(1), -off); // …and on B's centre side
  const V = cross(A, B);
  const a0: P = [vert(2)[0] + A.n[0] * off, vert(2)[1] + A.n[1] * off];
  const aEnd = hitCircle(A);
  const aBent = turn(aEnd, BEND);
  const aCtl: P = [a0[0] + (aEnd[0] - a0[0]) * 0.55, a0[1] + (aEnd[1] - a0[1]) * 0.55];
  const bEnd = hitCircle(B);
  const bBent = turn(bEnd, BEND);
  const bCtl: P = [V[0] + (bEnd[0] - V[0]) * 0.55, V[1] + (bEnd[1] - V[1]) * 0.55];
  const s = (pt: P) => `${f(pt[0])} ${f(pt[1])}`;
  return `M${s(V)}Q${s(bCtl)} ${s(bBent)}A${rIn} ${rIn} 0 0 0 ${s(aBent)}Q${s(aCtl)} ${s(a0)}Z`;
}

/** Rotations (degrees) for the five copies of the blade. */
export const BLADE_TURNS = [60, 120, 180, 240, 300] as const;

// Left sole centre-line (stroke centre); right foot = mirror of the left, 60.5 units higher.
const SOLE: P[] = [
  [428, 470],
  [460, 481],
  [475, 496],
  [479, 518],
  [475, 543],
  [468, 566],
  [470, 590],
  [482, 613],
  [492, 637],
  [492, 658],
  [480, 674],
  [452, 686],
  [424, 677],
  [401, 659],
  [385, 634],
  [370, 600],
  [358, 569],
  [353, 543],
  [357, 516],
  [371, 498],
  [394, 483],
];
function closedSpline(pts: P[]): string {
  const n = pts.length;
  const at = (i: number) => pts[(i + n) % n] as P;
  let d = `M${at(0)[0]} ${at(0)[1]}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: P = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: P = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${p2[0]} ${p2[1]}`;
  }
  return `${d}Z`;
}
export const SOLE_D = closedSpline(SOLE);
export const SOLE_STROKE = 15;
/** Toes of the left foot: cx, cy, rx, ry (big toe first). */
export const TOES: readonly [number, number, number, number][] = [
  [462, 429, 22.5, 26],
  [412, 433, 16.5, 19.5],
  [374, 448, 14.5, 16],
  [346, 472, 13.5, 14.5],
  [327, 503, 12, 12.5],
];
export const FEET_SHIFT = "translate(1.5 2)";
export const MIRROR = "translate(1019 -60.5) scale(-1 1)";

/** Logo palette (warm light on night). The UI accent stays coral; these are for the logo only. */
export const LOGO = {
  night: "#1F1A2E",
  nightInner: "#2A1F33",
  nightOuter: "#1D1829",
  butter: "#FBDF97",
  apricot: "#F2B47F",
  coralGlow: "#E8907A",
} as const;

export const STOPS = {
  warm: [
    [0, "#FCE29D"],
    [0.22, "#FBDA93"],
    [0.55, "#F2B47F"],
    [1, "#E8907A"],
  ],
  core: [
    [0, "#C38E57"],
    [0.45, "#94694F"],
    [0.8, "#7A5A4E"],
    [1, "#835A57"],
  ],
  feet: [
    [0, "#FAE597"],
    [0.55, "#F9D88A"],
    [1, "#F3B776"],
  ],
} as const;

/** Visible extent of the mark including its glow (used as the transparent mark's viewBox). */
export const MARK_VIEWBOX = [92, 92, 840, 840] as const;

export type MarkOptions = {
  /** id prefix, unique per document */
  id?: string;
  /** outer glow opacity (0 disables the glow) */
  glow?: number;
  /** outer glow blur */
  glowBlur?: number;
  gap?: number;
  soleStroke?: number;
  /** rim highlight opacity on the blades */
  rim?: number;
};

const stops = (list: readonly (readonly [number, string])[]) =>
  list.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("");

/** The mark as SVG markup ({defs, body}) in the 1024 space. */
export function markSvg(opts: MarkOptions = {}): { defs: string; body: string } {
  const p = opts.id ?? "m";
  const glow = opts.glow ?? 0.7;
  const blur = opts.glowBlur ?? 26;
  const gap = opts.gap ?? GAP;
  const sole = opts.soleStroke ?? SOLE_STROKE;
  const rim = opts.rim ?? 0.4;
  const uses = BLADE_TURNS.map(
    (a) => `<use href="#${p}b" transform="rotate(${a} ${C} ${C})"/>`,
  ).join("");
  const blades = `<use href="#${p}b"/>${uses}`;
  const defs =
    `<linearGradient id="${p}w" x1="430" y1="${C - R}" x2="640" y2="${C + R}" gradientUnits="userSpaceOnUse">${stops(STOPS.warm)}</linearGradient>` +
    `<radialGradient id="${p}c" cx="${C}" cy="${C - 10}" r="${R}" gradientUnits="userSpaceOnUse">${stops(STOPS.core)}</radialGradient>` +
    `<linearGradient id="${p}f" x1="0" y1="340" x2="0" y2="700" gradientUnits="userSpaceOnUse">${stops(STOPS.feet)}</linearGradient>` +
    `<filter id="${p}g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${blur}"/></filter>` +
    `<filter id="${p}s" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="9"/></filter>` +
    `<path id="${p}b" d="${bladePath(gap, ROUND)}" transform="rotate(${TILT} ${C} ${C})"/>` +
    `<mask id="${p}k" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><g fill="#fff" stroke="#fff" stroke-width="${ROUND}" stroke-linejoin="round">${blades}</g></mask>` +
    `<mask id="${p}r" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><g fill="#000" stroke="#fff" stroke-width="22" stroke-linejoin="round" filter="url(#${p}s)">${blades}</g></mask>`;
  const toes = TOES.map(
    ([x, y, rx, ry]) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}"/>`,
  ).join("");
  const body =
    (glow > 0
      ? `<circle cx="${C}" cy="${C}" r="${R + 4}" fill="#F4B27F" opacity="${glow}" filter="url(#${p}g)"/>`
      : "") +
    `<circle cx="${C}" cy="${C}" r="${R - 2}" fill="url(#${p}c)"/>` +
    `<circle cx="${C}" cy="${C}" r="${R}" fill="url(#${p}w)" mask="url(#${p}k)"/>` +
    (rim > 0
      ? `<g mask="url(#${p}k)"><circle cx="${C}" cy="${C}" r="${R}" fill="#FFF3D6" opacity="${rim}" mask="url(#${p}r)"/></g>`
      : "") +
    `<g fill="url(#${p}f)" transform="${FEET_SHIFT}"><g id="${p}t"><path d="${SOLE_D}" fill="none" stroke="url(#${p}f)" stroke-width="${sole}"/>${toes}</g>` +
    `<use href="#${p}t" transform="${MIRROR}"/></g>`;
  return { defs, body };
}

export type IconOptions = MarkOptions & {
  /** corner radius as a fraction of the side; 0 = full bleed square */
  radius?: number;
  /** scale of the mark inside the square (1 = the approved icon) */
  scale?: number;
};

/** The app icon (night-purple square + mark) as a standalone 1024-viewBox SVG document. */
export function iconSvg(opts: IconOptions = {}, size?: number): string {
  const p = opts.id ?? "m";
  const m = markSvg(opts);
  const rx = (opts.radius ?? 225 / 1024) * 1024; // 22 %, as in the approved drawing
  const k = opts.scale ?? 1;
  const dims = size ? ` width="${size}" height="${size}"` : ` width="1024" height="1024"`;
  const inner =
    k === 1
      ? m.body
      : `<g transform="translate(${C} ${C}) scale(${k}) translate(-${C} -${C})">${m.body}</g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"${dims}>\n<title>Tinyglow</title>\n` +
    `<defs>${m.defs}<radialGradient id="${p}bg" cx="512" cy="512" r="620" gradientUnits="userSpaceOnUse"><stop offset=".55" stop-color="${LOGO.nightInner}"/><stop offset="1" stop-color="${LOGO.nightOuter}"/></radialGradient></defs>\n` +
    `<rect width="1024" height="1024"${rx ? ` rx="${f(rx)}"` : ""} fill="url(#${p}bg)"/>${inner}\n</svg>\n`
  );
}

/** The transparent mark as a standalone SVG document (viewBox = mark + glow). */
export function markDoc(opts: MarkOptions = {}, size?: number): string {
  const m = markSvg({ glow: 0.5, ...opts });
  const [x, y, w, h] = MARK_VIEWBOX;
  const dims = size ? ` width="${size}" height="${size}"` : ` width="${w}" height="${h}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}"${dims}>\n<title>Tinyglow</title>\n<defs>${m.defs}</defs>${m.body}\n</svg>\n`;
}
