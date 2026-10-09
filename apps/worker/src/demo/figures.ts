import { circle, ellipse, g, line, path, pts, rect, shadow } from "./svg";

// Stylised, non-real people for the demo illustrations (docs/plans/step-9.md 2.11, D5): simple
// rounded shapes, dot or arc eyes, no likeness of anyone. Every figure is drawn in local units
// (baby head radius ~90, adult head ~110) with its origin at the floor contact point; callers
// place it with `at(x, y, scale)`.

export const INK = "#4a3b35";
const CHEEK = "#ef8f80";
const MOUTH = "#b5544a";

/** Non-real skin tones and hair colours, used in rotation across scenes. */
export const SKIN = ["#f6d3b8", "#e8b896", "#cf9a73", "#a8734f", "#83583b"] as const;
export const HAIR = ["#6b4530", "#3a2a22", "#c48a55", "#2b211d", "#8e5e3e"] as const;

export type Expr = "sleep" | "smile" | "happy" | "calm";
export type HairStyle = "tuft" | "cap" | "curls" | "none";

export interface BabyLook {
  skin: string;
  hair: string;
  outfit: string;
  /** Collar / cuffs / second colour. */
  trim?: string;
  hairStyle?: HairStyle;
}

export interface AdultLook {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  /** "short" (default), "bun" (grey bun + glasses for grandparents), "long". */
  style?: "short" | "bun" | "long";
}

type Point = readonly [number, number];

// --- Faces -------------------------------------------------------------------------------------

function eyes(cx: number, cy: number, r: number, expr: Expr): string {
  const y = cy + r * 0.05;
  const out: string[] = [];
  for (const side of [-1, 1]) {
    const x = cx + side * r * 0.34;
    if (expr === "sleep") {
      out.push(
        line(
          `M ${pts(x - r * 0.14, y)} Q ${pts(x, y + r * 0.12, x + r * 0.14, y)}`,
          INK,
          r * 0.055,
        ),
      );
    } else if (expr === "happy") {
      out.push(
        line(
          `M ${pts(x - r * 0.13, y + r * 0.04)} Q ${pts(x, y - r * 0.1, x + r * 0.13, y + r * 0.04)}`,
          INK,
          r * 0.06,
        ),
      );
    } else {
      out.push(ellipse(x, y, r * 0.075, r * 0.095, INK));
      out.push(circle(x + r * 0.025, y - r * 0.035, r * 0.025, "#ffffff"));
    }
  }
  return out.join("");
}

function mouth(cx: number, cy: number, r: number, expr: Expr): string {
  const y = cy + r * 0.38;
  if (expr === "happy") {
    return path(
      `M ${pts(cx - r * 0.2, y - r * 0.02)} Q ${pts(cx, y + r * 0.32, cx + r * 0.2, y - r * 0.02)} Z`,
      MOUTH,
    );
  }
  const w = expr === "smile" ? 0.2 : 0.1;
  const d = expr === "smile" ? 0.2 : 0.07;
  return line(`M ${pts(cx - r * w, y)} Q ${pts(cx, y + r * d, cx + r * w, y)}`, MOUTH, r * 0.05);
}

function cheeks(cx: number, cy: number, r: number): string {
  return [-1, 1]
    .map((s) =>
      ellipse(cx + s * r * 0.52, cy + r * 0.3, r * 0.15, r * 0.1, CHEEK, { opacity: 0.45 }),
    )
    .join("");
}

function hair(cx: number, cy: number, r: number, color: string, style: HairStyle): string {
  switch (style) {
    case "none":
      return "";
    case "cap":
      return path(
        `M ${pts(cx - r * 0.95, cy - r * 0.18)} C ${pts(cx - r * 0.95, cy - r * 1.18, cx + r * 0.95, cy - r * 1.18, cx + r * 0.95, cy - r * 0.18)} C ${pts(cx + r * 0.7, cy - r * 0.6, cx + r * 0.25, cy - r * 0.52, cx + r * 0.02, cy - r * 0.7)} C ${pts(cx - r * 0.2, cy - r * 0.48, cx - r * 0.65, cy - r * 0.62, cx - r * 0.95, cy - r * 0.18)} Z`,
        color,
      );
    case "curls": {
      const out: string[] = [];
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (1.12 + (i * 0.76) / 6);
        out.push(circle(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86, r * 0.24, color));
      }
      return out.join("");
    }
    default:
      return line(
        `M ${pts(cx - r * 0.1, cy - r * 0.92)} C ${pts(cx - r * 0.2, cy - r * 1.32, cx + r * 0.38, cy - r * 1.3, cx + r * 0.22, cy - r * 1.04)} C ${pts(cx + r * 0.12, cy - r * 0.88, cx - r * 0.02, cy - r * 1.0, cx + r * 0.08, cy - r * 1.1)}`,
        color,
        r * 0.075,
      );
  }
}

export function babyHead(cx: number, cy: number, r: number, look: BabyLook, expr: Expr): string {
  const style = look.hairStyle ?? "tuft";
  return [
    circle(cx - r * 0.94, cy + r * 0.08, r * 0.2, look.skin),
    circle(cx + r * 0.94, cy + r * 0.08, r * 0.2, look.skin),
    style === "curls" ? hair(cx, cy, r, look.hair, style) : "",
    circle(cx, cy, r, look.skin),
    style === "curls" ? "" : hair(cx, cy, r, look.hair, style),
    eyes(cx, cy, r, expr),
    cheeks(cx, cy, r),
    line(
      `M ${pts(cx - r * 0.05, cy + r * 0.24)} Q ${pts(cx, cy + r * 0.29, cx + r * 0.05, cy + r * 0.24)}`,
      INK,
      r * 0.03,
      { opacity: 0.35 },
    ),
    mouth(cx, cy, r, expr),
  ].join("");
}

/** A sun hat: brim + dome (drawn over the head). */
export function sunHat(cx: number, cy: number, r: number, color: string, band: string): string {
  return [
    path(
      `M ${pts(cx - r * 0.95, cy - r * 0.45)} Q ${pts(cx, cy - r * 1.75, cx + r * 0.95, cy - r * 0.45)} Z`,
      color,
    ),
    rect(cx - r * 0.93, cy - r * 0.62, r * 1.86, r * 0.2, band, r * 0.1),
    ellipse(cx, cy - r * 0.45, r * 1.6, r * 0.3, color),
  ].join("");
}

// --- Babies ------------------------------------------------------------------------------------

function arm(
  shoulder: Point,
  hand: Point,
  color: string,
  skin: string,
  width = 44,
  bend = 0.25,
): string {
  const [sx, sy] = shoulder;
  const [hx, hy] = hand;
  const mx = (sx + hx) / 2 + (sx > 0 ? 1 : -1) * Math.abs(hy - sy) * bend;
  const my = (sy + hy) / 2;
  return (
    line(`M ${pts(sx, sy)} Q ${pts(mx, my, hx, hy)}`, color, width) +
    circle(hx, hy, width * 0.58, skin)
  );
}

export interface SittingOpts {
  /** Hand positions (local units); default resting on the lap. */
  hands?: readonly [Point, Point];
  /** Drawn after the body, before the arms (e.g. an object held in the lap). */
  lap?: string;
  /** Drawn last (e.g. a rattle in the hand). */
  front?: string;
  legs?: string;
  shadow?: boolean;
  hat?: { color: string; band: string };
}

/** Sitting, front view. Origin: floor under the bottom. Height ~430. */
export function babySitting(look: BabyLook, expr: Expr, o: SittingOpts = {}): string {
  const legs = o.legs ?? look.outfit;
  const hands = o.hands ?? [
    [-82, -100],
    [82, -100],
  ];
  const out: string[] = [];
  if (o.shadow !== false) out.push(shadow(0, -6, 175, 26));
  for (const s of [-1, 1]) {
    out.push(line(`M ${pts(s * 42, -64)} Q ${pts(s * 110, -52, s * 132, -34)}`, legs, 64));
    out.push(ellipse(s * 150, -34, 32, 26, look.skin));
  }
  out.push(ellipse(0, -68, 104, 54, legs));
  out.push(rect(-74, -252, 148, 206, look.outfit, 64));
  if (look.trim) out.push(path(`M ${pts(-40, -246)} Q ${pts(0, -205, 40, -246)} Z`, look.trim));
  if (o.lap) out.push(o.lap);
  out.push(arm([-60, -218], hands[0], look.outfit, look.skin));
  out.push(arm([60, -218], hands[1], look.outfit, look.skin));
  out.push(babyHead(0, -338, 92, look, expr));
  if (o.hat) out.push(sunHat(0, -338, 92, o.hat.color, o.hat.band));
  if (o.front) out.push(o.front);
  return out.join("");
}

/** Lying on the back, seen from above. Origin: middle of the tummy. */
export function babyLyingBack(
  look: BabyLook,
  expr: Expr,
  hands: readonly [Point, Point] = [
    [-140, -170],
    [140, -170],
  ],
): string {
  const out: string[] = [];
  for (const s of [-1, 1]) {
    out.push(line(`M ${pts(s * 38, 62)} Q ${pts(s * 112, 112, s * 72, 188)}`, look.outfit, 54));
    out.push(ellipse(s * 72, 206, 28, 32, look.skin));
  }
  out.push(rect(-76, -100, 152, 196, look.outfit, 66));
  if (look.trim) out.push(path(`M ${pts(-40, -96)} Q ${pts(0, -58, 40, -96)} Z`, look.trim));
  out.push(arm([-60, -62], hands[0], look.outfit, look.skin, 44, 0.35));
  out.push(arm([60, -62], hands[1], look.outfit, look.skin, 44, 0.35));
  out.push(babyHead(0, -192, 92, look, expr));
  return out.join("");
}

/**
 * Swaddled newborn lying on its side (head to the right). Origin: centre of the bundle.
 * `stripes` draws evenly spaced bands over the blanket (clipped by `clipId`).
 */
export function babySwaddled(
  look: BabyLook,
  expr: Expr,
  blanket: string,
  opts: { stripes?: string; clipId?: string; fold?: string } = {},
): string {
  const out: string[] = [];
  const body = `M ${pts(-150, -90)} L ${pts(110, -90)} Q ${pts(200, -90, 200, 0)} Q ${pts(200, 90, 110, 90)} L ${pts(-150, 90)} Q ${pts(-240, 90, -240, 0)} Q ${pts(-240, -90, -150, -90)} Z`;
  out.push(shadow(-20, 92, 230, 22));
  out.push(circle(155, -12, 116, blanket));
  out.push(path(body, blanket));
  if (opts.stripes && opts.clipId) {
    const bands: string[] = [];
    for (let x = -230; x < 280; x += 70) bands.push(rect(x, -140, 26, 280, opts.stripes));
    out.push(
      `<clipPath id="${opts.clipId}"><path d="${body}"/><circle cx="155" cy="-12" r="116"/></clipPath>`,
    );
    out.push(g(bands, { "clip-path": `url(#${opts.clipId})`, opacity: 0.8 }));
  }
  out.push(
    line(`M ${pts(70, -84)} Q ${pts(10, 0, -40, 86)}`, opts.fold ?? "#000000", 8, {
      opacity: 0.08,
    }),
  );
  out.push(
    line(`M ${pts(-90, -84)} Q ${pts(-130, 0, -190, 70)}`, opts.fold ?? "#000000", 6, {
      opacity: 0.06,
    }),
  );
  out.push(babyHead(158, -6, 80, look, expr));
  out.push(
    path(`M ${pts(70, -60)} Q ${pts(155, -150, 245, -55)} Q ${pts(160, -110, 70, -60)} Z`, blanket),
  );
  return out.join("");
}

/** Tummy time, side view, facing right, head lifted. Origin: floor under the tummy. */
export function babyTummy(look: BabyLook, expr: Expr): string {
  return [
    shadow(-10, -4, 230, 22),
    line(`M ${pts(-70, -46)} L ${pts(-190, -32)}`, look.outfit, 56),
    ellipse(-206, -34, 28, 22, look.skin),
    ellipse(-10, -62, 128, 60, look.outfit),
    look.trim ? ellipse(-10, -40, 110, 20, look.trim, { opacity: 0.6 }) : "",
    line(`M ${pts(70, -82)} L ${pts(118, -26)}`, look.outfit, 42),
    ellipse(150, -22, 34, 20, look.skin),
    babyHead(140, -158, 88, look, expr),
  ].join("");
}

/** Crawling, side view, facing right. Origin: floor under the tummy. */
export function babyCrawling(look: BabyLook, expr: Expr): string {
  const shade = { opacity: 0.85 };
  return [
    shadow(0, -6, 240, 22),
    // far limbs (slightly offset and dimmed)
    g([line(`M ${pts(-60, -112)} L ${pts(-60, -36)} L ${pts(-170, -30)}`, look.outfit, 48)], shade),
    g(
      [
        line(`M ${pts(110, -120)} L ${pts(140, -30)}`, look.outfit, 40),
        ellipse(150, -22, 26, 18, look.skin),
      ],
      shade,
    ),
    ellipse(0, -124, 128, 66, look.outfit),
    look.trim ? ellipse(-6, -100, 112, 22, look.trim, { opacity: 0.55 }) : "",
    line(`M ${pts(-88, -110)} L ${pts(-96, -36)} L ${pts(-205, -30)}`, look.outfit, 56),
    ellipse(-222, -34, 28, 22, look.skin),
    line(`M ${pts(80, -122)} L ${pts(96, -32)}`, look.outfit, 44),
    ellipse(106, -22, 30, 20, look.skin),
    babyHead(168, -192, 88, look, expr),
  ].join("");
}

export interface StandingOpts {
  hands?: readonly [Point, Point];
  /** "dress" flares out; "romper" is a straight onesie with covered legs. */
  outfit?: "dress" | "romper";
  hat?: { color: string; band: string };
  shoes?: string;
  shadow?: boolean;
  /** Feet off the ground (held up by an adult). */
  dangling?: boolean;
}

/** Standing or walking, front view. Origin: floor between the feet. Height ~520. */
export function babyStanding(look: BabyLook, expr: Expr, o: StandingOpts = {}): string {
  const hands = o.hands ?? [
    [-178, -300],
    [178, -300],
  ];
  const kind = o.outfit ?? "romper";
  const out: string[] = [];
  if (o.shadow !== false && !o.dangling) out.push(shadow(0, -10, 130, 22));
  const legColor = kind === "romper" ? look.outfit : look.skin;
  for (const s of [-1, 1]) {
    const footX = o.dangling ? s * 30 : s * 44;
    out.push(line(`M ${pts(s * 32, -175)} L ${pts(footX, -40)}`, legColor, 50));
    out.push(ellipse(footX + s * 6, -26, 34, 20, o.shoes ?? look.skin));
  }
  for (const s of [-1, 1]) {
    out.push(
      line(
        `M ${pts(s * 52, -318)} Q ${pts(s * 70 + (hands[s < 0 ? 0 : 1][0] - s * 52) * 0.3, -350, hands[s < 0 ? 0 : 1][0], hands[s < 0 ? 0 : 1][1])}`,
        look.skin,
        38,
      ),
    );
    out.push(circle(hands[s < 0 ? 0 : 1][0], hands[s < 0 ? 0 : 1][1], 23, look.skin));
  }
  if (kind === "dress") {
    out.push(
      path(
        `M ${pts(-58, -342)} C ${pts(-74, -262, -100, -204, -120, -160)} Q ${pts(0, -128, 120, -160)} C ${pts(100, -204, 74, -262, 58, -342)} Q ${pts(0, -366, -58, -342)} Z`,
        look.outfit,
      ),
    );
  } else {
    out.push(rect(-72, -350, 144, 206, look.outfit, 56));
  }
  for (const s of [-1, 1]) out.push(circle(s * 54, -322, 30, look.outfit));
  if (look.trim) out.push(path(`M ${pts(-36, -346)} Q ${pts(0, -310, 36, -346)} Z`, look.trim));
  out.push(babyHead(0, -428, 90, look, expr));
  if (o.hat) out.push(sunHat(0, -428, 90, o.hat.color, o.hat.band));
  return out.join("");
}

// --- Adults (partial, stylised) ----------------------------------------------------------------

function adultHead(cx: number, cy: number, r: number, look: AdultLook, expr: Expr): string {
  const out: string[] = [];
  const style = look.style ?? "short";
  if (style === "long")
    out.push(rect(cx - r * 1.14, cy - r * 0.78, r * 2.28, r * 1.66, look.hair, r * 0.95));
  if (style === "bun") out.push(circle(cx, cy - r * 1.05, r * 0.42, look.hair));
  out.push(circle(cx - r * 0.97, cy + r * 0.1, r * 0.17, look.skin));
  out.push(circle(cx + r * 0.97, cy + r * 0.1, r * 0.17, look.skin));
  out.push(circle(cx, cy, r, look.skin));
  out.push(
    path(
      `M ${pts(cx - r * 1.0, cy - r * 0.05)} C ${pts(cx - r * 1.05, cy - r * 1.25, cx + r * 1.05, cy - r * 1.25, cx + r * 1.0, cy - r * 0.05)} C ${pts(cx + r * 0.8, cy - r * 0.55, cx + r * 0.2, cy - r * 0.5, cx - r * 0.1, cy - r * 0.62)} C ${pts(cx - r * 0.45, cy - r * 0.45, cx - r * 0.8, cy - r * 0.5, cx - r * 1.0, cy - r * 0.05)} Z`,
      look.hair,
    ),
  );
  out.push(eyes(cx, cy + r * 0.05, r * 0.85, expr === "calm" ? "happy" : expr));
  if (style === "bun") {
    for (const s of [-1, 1]) {
      out.push(
        circle(cx + s * r * 0.29, cy + r * 0.09, r * 0.2, "none", {
          stroke: INK,
          "stroke-width": r * 0.04,
          opacity: 0.6,
        }),
      );
    }
    out.push(
      line(
        `M ${pts(cx - r * 0.09, cy + r * 0.07)} L ${pts(cx + r * 0.09, cy + r * 0.07)}`,
        INK,
        r * 0.04,
        { opacity: 0.6 },
      ),
    );
  }
  out.push(cheeks(cx, cy + r * 0.05, r * 0.9));
  out.push(
    line(
      `M ${pts(cx - r * 0.2, cy + r * 0.42)} Q ${pts(cx, cy + r * 0.6, cx + r * 0.2, cy + r * 0.42)}`,
      MOUTH,
      r * 0.05,
    ),
  );
  return out.join("");
}

/**
 * Adult kneeling, facing left with both arms reaching out (to catch a walking baby).
 * Origin: floor under the knee.
 */
export function adultKneeling(
  look: AdultLook,
  hands: readonly [Point, Point] = [
    [-270, -420],
    [-230, -330],
  ],
): string {
  return [
    shadow(100, -6, 220, 26),
    rect(-40, -70, 300, 70, look.pants, 35),
    line(`M ${pts(10, -60)} L ${pts(50, -270)}`, look.pants, 120),
    line(`M ${pts(60, -520)} Q ${pts(-60, -420, hands[1][0], hands[1][1])}`, look.shirt, 62, {
      opacity: 0.92,
    }),
    circle(hands[1][0], hands[1][1], 34, look.skin),
    rect(-40, -620, 200, 380, look.shirt, 90),
    line(`M ${pts(20, -560)} Q ${pts(-110, -500, hands[0][0], hands[0][1])}`, look.shirt, 64),
    circle(hands[0][0], hands[0][1], 35, look.skin),
    adultHead(60, -730, 110, look, "happy"),
  ].join("");
}

/**
 * Adult sitting, front view (lap toward the viewer). Origin: middle of the lap.
 * `between` is drawn after the torso and lap but before the arms (a baby on the lap).
 */
export function adultSeated(
  look: AdultLook,
  hands: readonly [Point, Point],
  between = "",
  front = "",
): string {
  return [
    rect(-140, 60, 110, 360, look.pants, 50),
    rect(30, 60, 110, 360, look.pants, 50),
    rect(-175, -440, 350, 470, look.shirt, 130),
    adultHead(0, -560, 118, look, "happy"),
    rect(-180, -40, 360, 140, look.pants, 66),
    between,
    arm([-150, -380], hands[0], look.shirt, look.skin, 66, 0.15),
    arm([150, -380], hands[1], look.shirt, look.skin, 66, 0.15),
    front,
  ].join("");
}

/** Adult torso rising from the bottom edge, arms up holding something. Origin: bottom centre. */
export function adultFromBelow(
  look: AdultLook,
  hands: readonly [Point, Point],
  expr: Expr = "happy",
): string {
  return [
    rect(-260, -560, 520, 700, look.shirt, 180),
    adultHead(0, -700, 140, look, expr),
    arm([-210, -470], hands[0], look.shirt, look.skin, 82, 0.1),
    arm([210, -470], hands[1], look.shirt, look.skin, 82, 0.1),
  ].join("");
}
