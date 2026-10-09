// Tiny SVG building blocks for the demo illustrations (docs/plans/step-9.md 2.11). Pure string
// functions: no randomness except the seeded PRNG below, no fonts (text rendering would depend on
// the fonts installed in each image), so the same input always yields the same SVG.

export type Attrs = Readonly<Record<string, string | number | undefined>>;

/** Round to one decimal so the SVG text is short and stable. */
export function n(x: number): number {
  return Math.round(x * 10) / 10;
}

function attrs(a: Attrs): string {
  let out = "";
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    out += ` ${k}="${typeof v === "number" ? n(v) : v}"`;
  }
  return out;
}

export function el(tag: string, a: Attrs, children?: string): string {
  return children === undefined
    ? `<${tag}${attrs(a)}/>`
    : `<${tag}${attrs(a)}>${children}</${tag}>`;
}

export function g(children: readonly string[], a: Attrs = {}): string {
  return el("g", a, children.join(""));
}

export function at(x: number, y: number, s = 1, rotate = 0, flip = false): string {
  const parts = [`translate(${n(x)} ${n(y)})`];
  if (rotate) parts.push(`rotate(${n(rotate)})`);
  if (s !== 1 || flip) parts.push(`scale(${n(flip ? -s : s)} ${n(s)})`);
  return parts.join(" ");
}

export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  rx = 0,
  extra: Attrs = {},
): string {
  return el("rect", { x, y, width: w, height: h, rx: rx || undefined, fill, ...extra });
}

export function circle(cx: number, cy: number, r: number, fill: string, extra: Attrs = {}): string {
  return el("circle", { cx, cy, r, fill, ...extra });
}

export function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fill: string,
  extra: Attrs = {},
): string {
  return el("ellipse", { cx, cy, rx, ry, fill, ...extra });
}

export function path(d: string, fill: string, extra: Attrs = {}): string {
  return el("path", { d, fill, ...extra });
}

/** A rounded stroke (limbs, handles, ropes). */
export function line(d: string, stroke: string, width: number, extra: Attrs = {}): string {
  return el("path", {
    d,
    fill: "none",
    stroke,
    "stroke-width": width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    ...extra,
  });
}

/** `M x y` + pairs, for compact path data. */
export function pts(...xy: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < xy.length; i += 2) out.push(`${n(xy[i] ?? 0)} ${n(xy[i + 1] ?? 0)}`);
  return out.join(" ");
}

export function shadow(cx: number, cy: number, rx: number, ry: number, opacity = 0.09): string {
  return ellipse(cx, cy, rx, ry, "#3b2a20", { opacity });
}

/** Deterministic PRNG (mulberry32) for scattered details (bubbles, stars, flowers). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
