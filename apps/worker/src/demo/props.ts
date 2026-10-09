import { circle, ellipse, g, line, path, prng, pts, rect, shadow } from "./svg";

// Backgrounds and objects for the demo illustrations. Coordinates are canvas pixels (1200x1600)
// unless a function says it draws in local units.

/** Warm palette after docs/DESIGN.md (coral accent #E8836B, warm neutrals, soft greens). */
export const C = {
  cream: "#fbf5ee",
  linen: "#f4eadf",
  oat: "#ece0d1",
  peach: "#f8dccb",
  blush: "#f6cabd",
  coral: "#e8836b",
  coralDeep: "#d26a52",
  coralSoft: "#f2ab97",
  sage: "#a9c5a0",
  sageDeep: "#7fa57a",
  sageSoft: "#d3e2cb",
  sky: "#d4e7f0",
  skyDeep: "#a9cde0",
  mustard: "#e9c46a",
  butter: "#f6e3a8",
  sand: "#eadbc2",
  wood: "#c99a6e",
  woodDeep: "#a47552",
  woodSoft: "#e0c29d",
  lavender: "#d4cdea",
  lilac: "#b7acd8",
  white: "#ffffff",
  snow: "#fdfbf8",
  grey: "#bdb6ae",
  greySoft: "#e3ded8",
  red: "#d65f4b",
  berry: "#c9566b",
  teal: "#86bcb4",
  tealDeep: "#5e9d95",
  night: "#3f4b6e",
  nightDeep: "#2c3654",
  denim: "#7d97b8",
  charcoal: "#5b5a60",
} as const;

// --- Rooms -------------------------------------------------------------------------------------

export function wall(color: string): string {
  return rect(0, 0, 1200, 1600, color);
}

export function floor(y: number, color: string, board?: string): string {
  const out = [rect(0, y, 1200, 1600 - y, color)];
  if (board) {
    for (let x = -60, i = 0; x < 1200; x += 240, i++) {
      out.push(
        line(`M ${pts(x + (i % 2) * 120, y)} L ${pts(x + (i % 2) * 120 - 80, 1600)}`, board, 4, {
          opacity: 0.5,
        }),
      );
    }
  }
  return out.join("") + rect(0, y - 14, 1200, 14, C.snow, 0, { opacity: 0.85 });
}

export function windowPane(
  x: number,
  y: number,
  w: number,
  h: number,
  sky: string,
  extra = "",
): string {
  return [
    rect(x - 16, y - 16, w + 32, h + 32, C.white, 12),
    rect(x, y, w, h, sky, 6),
    extra,
    rect(x + w / 2 - 7, y, 14, h, C.white),
    rect(x, y + h / 2 - 7, w, 14, C.white),
    rect(x - 30, y + h + 12, w + 60, 22, C.white, 8),
  ].join("");
}

export function cloud(cx: number, cy: number, s: number, color: string = C.white): string {
  return g(
    [ellipse(0, 0, 70, 34, color), circle(-30, -18, 34, color), circle(22, -26, 42, color)],
    { transform: `translate(${cx} ${cy}) scale(${s})` },
  );
}

export function frame(
  x: number,
  y: number,
  w: number,
  h: number,
  mat: string,
  art: string,
): string {
  return [
    rect(x - 10, y - 10, w + 20, h + 20, C.woodSoft, 6),
    rect(x, y, w, h, mat, 2),
    path(
      `M ${pts(x + w * 0.1, y + h * 0.85)} L ${pts(x + w * 0.4, y + h * 0.45, x + w * 0.62, y + h * 0.7, x + w * 0.75, y + h * 0.55, x + w * 0.9, y + h * 0.85)} Z`,
      art,
    ),
    circle(x + w * 0.72, y + h * 0.28, Math.min(w, h) * 0.1, C.mustard),
  ].join("");
}

export function plant(
  x: number,
  y: number,
  s: number,
  leaf: string = C.sageDeep,
  pot: string = C.coralSoft,
): string {
  const leaves: string[] = [];
  for (const [a, l] of [
    [-50, 150],
    [-25, 190],
    [0, 210],
    [25, 185],
    [55, 140],
  ] as const) {
    leaves.push(ellipse(0, -l / 2, 26, l / 2, leaf, { transform: `rotate(${a})` }));
  }
  return g(
    [
      g(leaves, { transform: "translate(0 -90)" }),
      path(`M ${pts(-70, -100)} L ${pts(70, -100, 52, 0, -52, 0)} Z`, pot),
    ],
    { transform: `translate(${x} ${y}) scale(${s})` },
  );
}

export function rug(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rings: readonly string[],
): string {
  return rings
    .map((c, i) =>
      ellipse(cx, cy, rx * (1 - i * (0.7 / rings.length)), ry * (1 - i * (0.7 / rings.length)), c),
    )
    .join("");
}

export function garland(y: number, colors: readonly string[], x0 = -20, x1 = 1220): string {
  const out = [line(`M ${pts(x0, y)} Q ${pts((x0 + x1) / 2, y + 90, x1, y)}`, C.woodDeep, 4)];
  const count = 9;
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const x = x0 + (x1 - x0) * t;
    const yy = y + 2 * t * (1 - t) * 90;
    const c = colors[i % colors.length] ?? C.coral;
    out.push(path(`M ${pts(x - 34, yy)} L ${pts(x + 34, yy, x, yy + 70)} Z`, c));
  }
  return out.join("");
}

// --- Outdoors ----------------------------------------------------------------------------------

export function sky(color: string): string {
  return rect(0, 0, 1200, 1600, color);
}

export function sun(cx: number, cy: number, r: number, color: string = C.butter): string {
  return circle(cx, cy, r * 1.5, color, { opacity: 0.35 }) + circle(cx, cy, r, color);
}

export function hills(y: number, back: string, front: string): string {
  return [
    path(
      `M ${pts(0, y - 40)} Q ${pts(300, y - 170, 650, y - 60)} T ${pts(1200, y - 90)} L ${pts(1200, 1600, 0, 1600)} Z`,
      back,
    ),
    path(
      `M ${pts(0, y + 40)} Q ${pts(500, y - 60, 1200, y + 30)} L ${pts(1200, 1600, 0, 1600)} Z`,
      front,
    ),
  ].join("");
}

export function tree(
  x: number,
  ground: number,
  s: number,
  leaf: string,
  trunk: string = C.woodDeep,
): string {
  return g(
    [
      rect(-18, -220, 36, 220, trunk, 14),
      circle(0, -300, 120, leaf),
      circle(-80, -250, 80, leaf),
      circle(80, -250, 84, leaf),
    ],
    { transform: `translate(${x} ${ground}) scale(${s})` },
  );
}

export function flowers(
  seed: number,
  count: number,
  y0: number,
  y1: number,
  colors: readonly string[],
): string {
  const r = prng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = 30 + r() * 1140;
    const y = y0 + r() * (y1 - y0);
    const c = colors[i % colors.length] ?? C.white;
    const s = 0.7 + r() * 0.6;
    out.push(line(`M ${pts(x, y)} L ${pts(x, y + 30 * s)}`, C.sageDeep, 4));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      out.push(circle(x + Math.cos(a) * 9 * s, y + Math.sin(a) * 9 * s, 7 * s, c));
    }
    out.push(circle(x, y, 5 * s, C.mustard));
  }
  return out.join("");
}

export function stars(seed: number, count: number, y1: number, color: string = C.butter): string {
  const r = prng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = r() * 1200;
    const y = r() * y1;
    const s = 3 + r() * 6;
    out.push(circle(x, y, s, color, { opacity: 0.55 + r() * 0.45 }));
  }
  return out.join("");
}

// --- Objects -----------------------------------------------------------------------------------

export function sofa(x: number, y: number, w: number, color: string, cushion: string): string {
  return [
    shadow(x + w / 2, y + 250, w / 2 + 20, 24, 0.1),
    rect(x, y - 180, w, 260, color, 60),
    rect(x - 50, y - 30, 120, 260, color, 50),
    rect(x + w - 70, y - 30, 120, 260, color, 50),
    rect(x + 40, y + 40, w - 80, 150, cushion, 40),
    rect(x - 40, y + 180, w + 80, 50, color, 25),
    rect(x + 10, y + 225, 30, 40, C.woodDeep, 8),
    rect(x + w - 40, y + 225, 30, 40, C.woodDeep, 8),
  ].join("");
}

export function armchair(x: number, y: number, color: string, cushion: string): string {
  return [
    rect(x - 260, y - 520, 520, 600, color, 120),
    rect(x - 330, y - 160, 140, 380, color, 60),
    rect(x + 190, y - 160, 140, 380, color, 60),
    rect(x - 220, y + 40, 440, 160, cushion, 50),
  ].join("");
}

export function ball(cx: number, cy: number, r: number, a: string, b: string): string {
  return [
    shadow(cx, cy + r * 0.95, r * 0.9, r * 0.18),
    circle(cx, cy, r, a),
    path(
      `M ${pts(cx - r, cy)} Q ${pts(cx, cy - r * 0.6, cx + r, cy)} Q ${pts(cx, cy + r * 0.6, cx - r, cy)} Z`,
      b,
    ),
    circle(cx - r * 0.35, cy - r * 0.4, r * 0.16, C.white, { opacity: 0.6 }),
  ].join("");
}

export function blocks(
  x: number,
  y: number,
  s: number,
  colors: readonly string[],
  layout: readonly (readonly [number, number])[],
): string {
  const out: string[] = [];
  layout.forEach(([bx, by], i) => {
    const c = colors[i % colors.length] ?? C.coral;
    out.push(rect(x + bx * s, y + by * s, 70 * s, 70 * s, c, 10 * s));
    out.push(
      rect(x + bx * s + 16 * s, y + by * s + 16 * s, 38 * s, 38 * s, C.white, 6 * s, {
        opacity: 0.3,
      }),
    );
  });
  return out.join("");
}

export function teddy(x: number, y: number, s: number, fur: string, belly: string): string {
  return g(
    [
      shadow(0, 0, 120, 18),
      ellipse(-70, -20, 40, 30, fur),
      ellipse(70, -20, 40, 30, fur),
      ellipse(0, -110, 90, 100, fur),
      ellipse(0, -95, 55, 60, belly),
      ellipse(-95, -140, 30, 55, fur, { transform: "rotate(25 -95 -140)" }),
      ellipse(95, -140, 30, 55, fur, { transform: "rotate(-25 95 -140)" }),
      circle(-55, -310, 32, fur),
      circle(55, -310, 32, fur),
      circle(-55, -310, 16, belly),
      circle(55, -310, 16, belly),
      circle(0, -255, 78, fur),
      ellipse(0, -230, 34, 26, belly),
      circle(0, -240, 9, "#4a3b35"),
      circle(-28, -268, 7, "#4a3b35"),
      circle(28, -268, 7, "#4a3b35"),
    ],
    { transform: `translate(${x} ${y}) scale(${s})` },
  );
}

export function book(
  cx: number,
  cy: number,
  s: number,
  cover: string,
  page: string = C.white,
): string {
  return g(
    [
      path(
        `M ${pts(-170, -10)} Q ${pts(-85, -40, 0, -10)} L ${pts(0, 120)} Q ${pts(-85, 90, -170, 120)} Z`,
        cover,
      ),
      path(
        `M ${pts(170, -10)} Q ${pts(85, -40, 0, -10)} L ${pts(0, 120)} Q ${pts(85, 90, 170, 120)} Z`,
        cover,
      ),
      path(
        `M ${pts(-155, -18)} Q ${pts(-80, -46, 0, -18)} L ${pts(0, 106)} Q ${pts(-80, 80, -155, 106)} Z`,
        page,
      ),
      path(
        `M ${pts(155, -18)} Q ${pts(80, -46, 0, -18)} L ${pts(0, 106)} Q ${pts(80, 80, 155, 106)} Z`,
        page,
      ),
      circle(-80, 30, 26, C.mustard),
      path(`M ${pts(40, 70)} L ${pts(80, 10, 120, 70)} Z`, C.sage),
    ],
    { transform: `translate(${cx} ${cy}) scale(${s})` },
  );
}

export function rattle(cx: number, cy: number, s: number, angle: number): string {
  return g(
    [
      line(`M ${pts(0, 0)} L ${pts(0, -120)}`, C.woodDeep, 18),
      circle(0, -150, 46, C.wood),
      circle(0, -150, 22, C.woodSoft),
      circle(0, 14, 16, C.wood),
    ],
    { transform: `translate(${cx} ${cy}) rotate(${angle}) scale(${s})` },
  );
}

export function duck(cx: number, cy: number, s: number): string {
  return g(
    [
      ellipse(0, 0, 80, 48, C.mustard),
      circle(48, -54, 40, C.mustard),
      path(`M ${pts(82, -58)} L ${pts(118, -48, 82, -38)} Z`, C.coral),
      circle(58, -64, 7, "#4a3b35"),
      path(`M ${pts(-30, -20)} Q ${pts(0, -50, 30, -15)} Z`, "#ddb04f"),
    ],
    { transform: `translate(${cx} ${cy}) scale(${s})` },
  );
}

export function bubbles(
  seed: number,
  count: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  rMin: number,
  rMax: number,
): string {
  const r = prng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = x0 + r() * (x1 - x0);
    const y = y0 + r() * (y1 - y0);
    const rr = rMin + r() * (rMax - rMin);
    out.push(circle(x, y, rr, C.white, { stroke: C.skyDeep, "stroke-width": 3, opacity: 0.95 }));
    out.push(circle(x - rr * 0.35, y - rr * 0.35, rr * 0.18, C.skyDeep, { opacity: 0.35 }));
  }
  return out.join("");
}

export function cake(cx: number, cy: number, s: number): string {
  return g(
    [
      ellipse(0, 10, 300, 40, C.white),
      rect(-220, -170, 440, 180, C.coralSoft, 30),
      path(
        `M ${pts(-220, -120)} Q ${pts(-180, -60, -140, -120)} Q ${pts(-100, -60, -60, -120)} Q ${pts(-20, -60, 20, -120)} Q ${pts(60, -60, 100, -120)} Q ${pts(140, -60, 180, -120)} Q ${pts(210, -80, 220, -120)} L ${pts(220, -150)} Q ${pts(220, -175, 190, -175)} L ${pts(-190, -175)} Q ${pts(-220, -175, -220, -150)} Z`,
        C.snow,
      ),
      ellipse(0, -172, 220, 36, C.snow),
      rect(-12, -330, 24, 150, C.lavender, 8),
      line(
        `M ${pts(-8, -300)} L ${pts(8, -284)} M ${pts(-8, -250)} L ${pts(8, -234)} M ${pts(-8, -200)} L ${pts(8, -184)}`,
        C.lilac,
        6,
      ),
      path(
        `M ${pts(0, -420)} Q ${pts(34, -370, 0, -336)} Q ${pts(-34, -370, 0, -420)} Z`,
        C.mustard,
      ),
      path(`M ${pts(0, -392)} Q ${pts(14, -365, 0, -346)} Q ${pts(-14, -365, 0, -392)} Z`, C.coral),
      circle(-150, -60, 10, C.berry),
      circle(-60, -40, 10, C.teal),
      circle(40, -60, 10, C.mustard),
      circle(140, -40, 10, C.berry),
    ],
    { transform: `translate(${cx} ${cy}) scale(${s})` },
  );
}

export function xmasTree(cx: number, ground: number, s: number): string {
  const ornaments: string[] = [];
  const r = prng(1225);
  const colors = [C.coral, C.mustard, C.white, C.berry];
  for (let i = 0; i < 14; i++) {
    const t = 0.15 + r() * 0.8;
    const half = 60 + t * 300;
    const x = (r() * 2 - 1) * half * 0.8;
    const y = -780 + t * 650;
    ornaments.push(circle(x, y, 18, colors[i % colors.length] ?? C.coral));
  }
  return g(
    [
      shadow(0, 0, 360, 34),
      rect(-40, -120, 80, 120, C.woodDeep, 10),
      path(`M ${pts(0, -560)} L ${pts(340, -120, -340, -120)} Z`, C.sageDeep),
      path(`M ${pts(0, -720)} L ${pts(270, -360, -270, -360)} Z`, "#8db384"),
      path(`M ${pts(0, -860)} L ${pts(190, -580, -190, -580)} Z`, C.sage),
      line(
        `M ${pts(-250, -200)} Q ${pts(0, -120, 260, -260)} M ${pts(-200, -430)} Q ${pts(0, -350, 210, -480)}`,
        C.butter,
        8,
      ),
      ...ornaments,
      path(
        `M ${pts(0, -920)} L ${pts(18, -880, 60, -876, 26, -852, 38, -810, 0, -834, -38, -810, -26, -852, -60, -876, -18, -880)} Z`,
        C.mustard,
      ),
    ],
    { transform: `translate(${cx} ${ground}) scale(${s})` },
  );
}

export function present(
  x: number,
  y: number,
  w: number,
  h: number,
  box: string,
  ribbon: string,
): string {
  return [
    rect(x, y - h, w, h, box, 8),
    rect(x + w / 2 - 10, y - h, 20, h, ribbon),
    rect(x, y - h * 0.6, w, 18, ribbon),
    ellipse(x + w / 2 - 24, y - h - 12, 26, 14, ribbon),
    ellipse(x + w / 2 + 24, y - h - 12, 26, 14, ribbon),
  ].join("");
}

/** `inside` (local units, drawn between hood and body) is e.g. a baby's head at (-40, -330). */
export function stroller(
  cx: number,
  ground: number,
  s: number,
  body: string,
  hood: string,
  inside = "",
): string {
  return g(
    [
      shadow(0, 0, 260, 26),
      line(`M ${pts(-130, -90)} L ${pts(150, -90)}`, C.charcoal, 14),
      line(`M ${pts(150, -90)} L ${pts(260, -420)} L ${pts(320, -420)}`, C.charcoal, 14),
      path(`M ${pts(-230, -330)} Q ${pts(-210, -560, 30, -560)} L ${pts(30, -330)} Z`, hood),
      line(`M ${pts(-170, -350)} Q ${pts(-120, -500, 10, -520)}`, C.white, 6, { opacity: 0.4 }),
      inside,
      path(
        `M ${pts(-220, -330)} Q ${pts(-220, -110, 0, -110)} L ${pts(200, -110)} Q ${pts(230, -110, 230, -150)} L ${pts(230, -330)} Z`,
        body,
      ),
      circle(-130, -60, 60, C.charcoal),
      circle(-130, -60, 26, C.grey),
      circle(150, -60, 60, C.charcoal),
      circle(150, -60, 26, C.grey),
    ],
    { transform: `translate(${cx} ${ground}) scale(${s})` },
  );
}

export function cart(cx: number, ground: number, s: number, colors: readonly string[]): string {
  return g(
    [
      shadow(0, 0, 220, 22),
      line(`M ${pts(-170, -220)} L ${pts(-230, -470)}`, C.woodDeep, 16),
      line(`M ${pts(-260, -470)} L ${pts(-200, -470)}`, C.woodDeep, 22),
      rect(-190, -260, 380, 170, C.wood, 18),
      rect(-170, -240, 340, 18, C.woodSoft, 8),
      blocks(-150, -360, 1, colors, [
        [0, 0],
        [80, 0],
        [160, 0],
        [40, -78],
      ]),
      circle(-120, -70, 52, C.coral),
      circle(-120, -70, 20, C.butter),
      circle(120, -70, 52, C.coral),
      circle(120, -70, 20, C.butter),
    ],
    { transform: `translate(${cx} ${ground}) scale(${s})` },
  );
}

export function crib(x: number, y: number, w: number, h: number, color: string): string {
  const bars: string[] = [];
  for (let bx = x + 60; bx < x + w - 30; bx += 70)
    bars.push(rect(bx, y + 60, 22, h - 120, color, 10));
  return [
    rect(x, y, w, 50, color, 20),
    rect(x, y + h - 60, w, 50, color, 20),
    rect(x - 20, y - 40, 50, h + 140, color, 22),
    rect(x + w - 30, y - 40, 50, h + 140, color, 22),
    ...bars,
  ].join("");
}

export function mobile(cx: number, top: number, colors: readonly string[]): string {
  const out = [
    line(`M ${pts(cx, 0)} L ${pts(cx, top)}`, C.woodDeep, 6),
    line(`M ${pts(cx - 220, top)} Q ${pts(cx, top - 50, cx + 220, top)}`, C.woodDeep, 8),
  ];
  const xs = [-200, -70, 70, 200];
  xs.forEach((dx, i) => {
    const len = 90 + (i % 2) * 70;
    out.push(line(`M ${pts(cx + dx, top - 8)} L ${pts(cx + dx, top + len)}`, C.woodDeep, 3));
    const c = colors[i % colors.length] ?? C.coral;
    if (i % 2 === 0) {
      out.push(
        path(
          `M ${pts(cx + dx, top + len - 30)} L ${pts(cx + dx + 12, top + len - 6, cx + dx + 38, top + len - 2, cx + dx + 18, top + len + 16, cx + dx + 24, top + len + 42, cx + dx, top + len + 28, cx + dx - 24, top + len + 42, cx + dx - 18, top + len + 16, cx + dx - 38, top + len - 2, cx + dx - 12, top + len - 6)} Z`,
          c,
        ),
      );
    } else {
      out.push(
        path(
          `M ${pts(cx + dx + 20, top + len - 26)} A 34 34 0 1 0 ${pts(cx + dx + 20, top + len + 34)} A 26 26 0 1 1 ${pts(cx + dx + 20, top + len - 26)} Z`,
          c,
        ),
      );
    }
  });
  return out.join("");
}

export function highChair(cx: number, ground: number, color: string): string {
  return [
    shadow(cx, ground, 240, 26),
    line(`M ${pts(cx - 150, ground)} L ${pts(cx - 100, ground - 560)}`, color, 30),
    line(`M ${pts(cx + 150, ground)} L ${pts(cx + 100, ground - 560)}`, color, 30),
    line(`M ${pts(cx - 135, ground - 160)} L ${pts(cx + 135, ground - 160)}`, color, 18),
    rect(cx - 170, ground - 1080, 340, 520, color, 70),
    rect(cx - 140, ground - 1050, 280, 460, C.white, 56, { opacity: 0.35 }),
  ].join("");
}

export function trayFront(cx: number, top: number, tray: string): string {
  return [
    rect(cx - 330, top, 660, 70, tray, 30),
    rect(cx - 300, top + 60, 600, 40, tray, 18, { opacity: 0.7 }),
  ].join("");
}

export function bowl(cx: number, cy: number, s: number, color: string, food: string): string {
  return g(
    [
      ellipse(0, -30, 120, 30, food),
      path(`M ${pts(-125, -30)} Q ${pts(-110, 70, 0, 70)} Q ${pts(110, 70, 125, -30)} Z`, color),
      ellipse(-40, -36, 30, 8, C.white, { opacity: 0.4 }),
    ],
    { transform: `translate(${cx} ${cy}) scale(${s})` },
  );
}

export function spoon(
  x: number,
  y: number,
  s: number,
  angle: number,
  color: string,
  food: string,
): string {
  return g(
    [
      line(`M ${pts(0, 0)} L ${pts(0, -170)}`, color, 18),
      ellipse(0, -200, 30, 42, color),
      ellipse(0, -205, 20, 26, food),
    ],
    {
      transform: `translate(${x} ${y}) rotate(${angle}) scale(${s})`,
    },
  );
}

export function gingham(
  x: number,
  y: number,
  w: number,
  h: number,
  base: string,
  band: string,
): string {
  const out = [rect(x, y, w, h, base, 24)];
  const step = 80;
  for (let bx = x + 20; bx < x + w; bx += step)
    out.push(rect(bx, y, 40, h, band, 0, { opacity: 0.35 }));
  for (let by = y + 20; by < y + h; by += step)
    out.push(rect(x, by, w, 40, band, 0, { opacity: 0.35 }));
  return out.join("");
}

export function basket(cx: number, ground: number, s: number): string {
  return g(
    [
      shadow(0, 0, 170, 20),
      line(`M ${pts(-110, -150)} Q ${pts(0, -330, 110, -150)}`, C.woodDeep, 18),
      path(`M ${pts(-160, -160)} L ${pts(160, -160, 130, 0, -130, 0)} Z`, C.wood),
      line(
        `M ${pts(-150, -110)} L ${pts(150, -110)} M ${pts(-140, -60)} L ${pts(140, -60)}`,
        C.woodDeep,
        6,
        { opacity: 0.5 },
      ),
      rect(-170, -190, 340, 40, C.woodSoft, 16),
      gingham(-120, -230, 120, 60, C.white, C.coral),
    ],
    { transform: `translate(${cx} ${ground}) scale(${s})` },
  );
}

export function playGym(
  cx: number,
  cy: number,
  w: number,
  h: number,
  colors: readonly string[],
): string {
  const out = [
    line(
      `M ${pts(cx - w / 2, cy + h / 2)} Q ${pts(cx - w / 2, cy - h / 2, cx, cy - h / 2)} Q ${pts(cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2)}`,
      C.woodSoft,
      34,
    ),
  ];
  const xs = [-0.28, -0.08, 0.12, 0.3];
  xs.forEach((fx, i) => {
    const x = cx + fx * w;
    const yTop = cy - h / 2 + 40 + Math.abs(fx) * 120;
    const c = colors[i % colors.length] ?? C.coral;
    out.push(line(`M ${pts(x, yTop)} L ${pts(x, yTop + 110)}`, C.woodDeep, 4));
    out.push(
      i % 2 === 0
        ? circle(x, yTop + 140, 34, c)
        : path(`M ${pts(x, yTop + 105)} L ${pts(x + 36, yTop + 170, x - 36, yTop + 170)} Z`, c),
    );
  });
  return out.join("");
}

export function swing(cx: number, top: number, seatY: number): string {
  return [
    line(`M ${pts(cx - 170, top)} L ${pts(cx - 150, seatY)}`, C.woodDeep, 8),
    line(`M ${pts(cx + 170, top)} L ${pts(cx + 150, seatY)}`, C.woodDeep, 8),
  ].join("");
}

export function swingSeatFront(cx: number, seatY: number, color: string): string {
  return path(
    `M ${pts(cx - 190, seatY - 60)} L ${pts(cx + 190, seatY - 60)} Q ${pts(cx + 200, seatY + 60, cx, seatY + 70)} Q ${pts(cx - 200, seatY + 60, cx - 190, seatY - 60)} Z`,
    color,
  );
}

export function rings(cx: number, ground: number, s: number, colors: readonly string[]): string {
  const out = [
    shadow(0, 0, 110, 16),
    ellipse(0, -18, 100, 26, C.woodSoft),
    rect(-14, -330, 28, 320, C.wood, 12),
  ];
  colors.forEach((c, i) => {
    const rx = 90 - i * 14;
    out.push(ellipse(0, -60 - i * 52, rx, 34, c));
  });
  out.push(circle(0, -340, 26, C.wood));
  return g(out, { transform: `translate(${cx} ${ground}) scale(${s})` });
}

export function bouncer(cx: number, ground: number, s: number, fabric: string): string {
  return g(
    [
      shadow(0, 0, 300, 26),
      line(`M ${pts(-200, -10)} L ${pts(-170, -170)}`, C.grey, 14),
      line(`M ${pts(220, -10)} L ${pts(250, -240)}`, C.grey, 14),
      line(`M ${pts(-280, -14)} Q ${pts(0, 30, 280, -14)}`, C.grey, 18),
      rect(-310, -360, 620, 240, fabric, 118, { transform: "rotate(-12)" }),
      rect(-270, -330, 540, 180, C.white, 90, { transform: "rotate(-12)", opacity: 0.25 }),
    ],
    { transform: `translate(${cx} ${ground}) scale(${s})` },
  );
}

export function quilt(
  x: number,
  y: number,
  w: number,
  h: number,
  colors: readonly string[],
  cell = 150,
): string {
  const out = [rect(x, y, w, h, colors[0] ?? C.cream, 20)];
  let i = 0;
  for (let cy = y; cy < y + h; cy += cell) {
    for (let cx = x; cx < x + w; cx += cell) {
      const c = colors[(i++ * 7 + Math.floor(cy / cell)) % colors.length] ?? C.cream;
      out.push(
        rect(
          cx + 6,
          cy + 6,
          Math.min(cell, x + w - cx) - 12,
          Math.min(cell, y + h - cy) - 12,
          c,
          10,
        ),
      );
    }
  }
  return out.join("");
}

export function cat(x: number, ground: number, s: number, fur: string): string {
  return g(
    [
      shadow(0, 0, 130, 16),
      line(`M ${pts(110, -40)} Q ${pts(200, -60, 170, -170)}`, fur, 24),
      ellipse(0, -70, 130, 70, fur),
      circle(-110, -140, 60, fur),
      path(`M ${pts(-160, -170)} L ${pts(-150, -230, -120, -190)} Z`, fur),
      path(`M ${pts(-100, -195)} L ${pts(-70, -240, -60, -180)} Z`, fur),
      line(
        `M ${pts(-140, -142)} Q ${pts(-132, -134, -124, -142)} M ${pts(-104, -142)} Q ${pts(-96, -134, -88, -142)}`,
        "#4a3b35",
        4,
      ),
    ],
    { transform: `translate(${x} ${ground}) scale(${s})` },
  );
}

export function pillow(
  cx: number,
  cy: number,
  w: number,
  h: number,
  color: string,
  angle = 0,
): string {
  return rect(cx - w / 2, cy - h / 2, w, h, color, h / 2.4, {
    transform: `rotate(${angle} ${cx} ${cy})`,
  });
}

export function moon(cx: number, cy: number, r: number, color: string, bg: string): string {
  return circle(cx, cy, r, color) + circle(cx + r * 0.45, cy - r * 0.25, r * 0.85, bg);
}

export function towel(x: number, y: number, color: string, stripe: string): string {
  return [
    circle(x, y - 20, 14, C.grey),
    rect(x - 110, y - 10, 220, 340, color, 20),
    rect(x - 110, y + 250, 220, 24, stripe),
    rect(x - 110, y + 286, 220, 12, stripe),
  ].join("");
}

export function tiles(y0: number, y1: number, size: number, a: string, b: string): string {
  const out: string[] = [rect(0, y0, 1200, y1 - y0, a)];
  for (let y = y0, row = 0; y < y1; y += size, row++) {
    for (let x = (row % 2) * size; x < 1200; x += size * 2)
      out.push(rect(x, y, size, Math.min(size, y1 - y), b));
  }
  return out.join("");
}
