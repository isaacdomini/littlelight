import sharp from "sharp";
import {
  type AdultLook,
  adultFromBelow,
  adultKneeling,
  adultSeated,
  type BabyLook,
  babyCrawling,
  babyHead,
  babyLyingBack,
  babySitting,
  babyStanding,
  babySwaddled,
  babyTummy,
  HAIR,
  SKIN,
} from "./figures";
import {
  armchair,
  ball,
  basket,
  blocks,
  book,
  bouncer,
  bowl,
  bubbles,
  C,
  cake,
  cart,
  cat,
  cloud,
  crib,
  duck,
  floor,
  flowers,
  frame,
  garland,
  gingham,
  highChair,
  hills,
  mobile,
  moon,
  pillow,
  plant,
  playGym,
  present,
  quilt,
  rattle,
  rings,
  rug,
  sky,
  sofa,
  spoon,
  stars,
  stroller,
  sun,
  swing,
  swingSeatFront,
  teddy,
  tiles,
  towel,
  trayFront,
  tree,
  wall,
  windowPane,
  xmasTree,
} from "./props";
import { at, circle, ellipse, g, line, path, pts, rect, shadow } from "./svg";

// Demo illustrations (docs/plans/step-9.md 2.11; user decision D5, 2026-10-09): deterministic SVG
// scenes of NON-REAL babies, one per seeded demo photo (12, the dev family "Maya") and one per
// store-review photo (24, "Sunny"), each matching its seeded caption or note. Drawn in code (no
// image files in the repo, no fonts, no randomness beyond a fixed-seed PRNG), rendered to a
// baseline JPEG by sharp. The output carries no metadata of any kind: sharp writes none unless a
// metadata-keeping call is chained, and none is (the worker-wide tripwire test enforces that).

export const ILLUSTRATION_WIDTH = 1200;
export const ILLUSTRATION_HEIGHT = 1600;
/** Original quality: flat illustrations stay small (~40–120 KB) at q82. */
export const ILLUSTRATION_JPEG_QUALITY = 82;

export interface Scene {
  /** Stable slug (tests, never shown). */
  slug: string;
  draw(): string;
  /** Gaussian blur sigma applied after rasterising ("blurry shot"). */
  blur?: number;
}

function doc(body: readonly string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ILLUSTRATION_WIDTH}" height="${ILLUSTRATION_HEIGHT}" viewBox="0 0 ${ILLUSTRATION_WIDTH} ${ILLUSTRATION_HEIGHT}">${body.join("")}</svg>`;
}

function place(x: number, y: number, s: number, content: string, rotate = 0, flip = false): string {
  return g([content], { transform: at(x, y, s, rotate, flip) });
}

// --- Looks -------------------------------------------------------------------------------------

const maya = (
  outfit: string,
  trim?: string,
  hairStyle: BabyLook["hairStyle"] = "tuft",
): BabyLook => ({
  skin: SKIN[1],
  hair: HAIR[0],
  outfit,
  ...(trim ? { trim } : {}),
  hairStyle,
});

const sunny = (
  outfit: string,
  trim?: string,
  hairStyle: BabyLook["hairStyle"] = "curls",
): BabyLook => ({
  skin: SKIN[3],
  hair: HAIR[3],
  outfit,
  ...(trim ? { trim } : {}),
  hairStyle,
});

const MAYA_DAD: AdultLook = { skin: SKIN[2], hair: HAIR[1], shirt: C.denim, pants: C.charcoal };
const NANNY: AdultLook = {
  skin: SKIN[4],
  hair: HAIR[3],
  shirt: C.teal,
  pants: C.denim,
  style: "long",
};
const SUNNY_DAD: AdultLook = { skin: SKIN[3], hair: HAIR[1], shirt: C.sageDeep, pants: C.charcoal };
const GRANDMA: AdultLook = {
  skin: SKIN[0],
  hair: C.grey,
  shirt: C.coralSoft,
  pants: C.charcoal,
  style: "bun",
};

/** A little arm reaching up from the bottom edge, with three finger bumps. */
function reachingHand(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  skin: string,
  sleeve: string,
): string {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const fingers = [-0.5, 0, 0.5].map((o) =>
    circle(x1 + ux * 40 - uy * o * 46, y1 + uy * 40 + ux * o * 46, 17, skin),
  );
  return [
    line(
      `M ${pts(x0, y0)} Q ${pts(x0 + dx * 0.3, y0 + dy * 0.6, x1 - ux * 40, y1 - uy * 40)}`,
      sleeve,
      84,
    ),
    ...fingers,
    circle(x1, y1, 46, skin),
  ].join("");
}

// --- The demo family: Maya (12, in seed order nn = 1..12) --------------------------------------

export const DEMO_SCENES: readonly Scene[] = [
  {
    // 1. Newborn asleep in a white blanket on the sofa.
    slug: "newborn-sofa",
    draw: () =>
      doc([
        wall(C.linen),
        frame(760, 230, 260, 200, C.sky, C.sage),
        floor(1260, C.woodSoft, C.wood),
        sofa(150, 820, 900, C.sage, C.sageSoft),
        pillow(260, 700, 210, 170, C.coralSoft, -10),
        place(
          640,
          772,
          1.3,
          babySwaddled(maya(C.snow, undefined, "tuft"), "sleep", C.snow, { fold: C.grey }),
        ),
      ]),
  },
  {
    // 2. Smiles up from the changing mat (seen from above).
    slug: "changing-mat-smile",
    draw: () =>
      doc([
        rect(0, 0, 1200, 1600, C.peach),
        rect(150, 150, 900, 1300, C.white, 140),
        rect(200, 210, 800, 1180, C.sky, 110),
        rect(150, 150, 110, 1300, C.white, 55),
        rect(940, 150, 110, 1300, C.white, 55),
        place(600, 900, 1.6, babyLyingBack(maya(C.coralSoft, C.white), "happy")),
        place(1110, 1480, 0.8, rattle(0, 0, 1, -30)),
      ]),
  },
  {
    // 3. Tummy time on a striped play mat, head lifted.
    slug: "tummy-time-stripes",
    draw: () => {
      const stripes: string[] = [];
      const colors = [C.mustard, C.cream, C.sage, C.cream, C.coralSoft, C.cream];
      for (let i = 0; i < 18; i++)
        stripes.push(rect(60 + i * 60, 1010, 60, 420, colors[i % colors.length] ?? C.cream));
      return doc([
        wall(C.cream),
        windowPane(120, 230, 320, 400, C.sky, cloud(280, 380, 0.9)),
        floor(940, C.oat),
        `<clipPath id="mat3"><rect x="60" y="1010" width="1080" height="420" rx="40"/></clipPath>`,
        g(stripes, { "clip-path": "url(#mat3)" }),
        place(560, 1270, 1.7, babyTummy(maya(C.lavender, C.white), "calm")),
        ball(1020, 1180, 62, C.coral, C.white),
      ]);
    },
  },
  {
    // 4. Bath time (sensitive photo): tub, bubbles and a duck. No baby is drawn at all.
    slug: "bath-bubbles",
    draw: () =>
      doc([
        tiles(0, 1080, 150, C.sky, "#c6dfeb"),
        rect(0, 1080, 1200, 520, C.greySoft),
        towel(1010, 200, C.coralSoft, C.white),
        bubbles(4, 26, 170, 1030, 640, 830, 40, 85),
        rect(130, 820, 940, 430, C.white, 150),
        rect(100, 790, 1000, 70, C.snow, 35),
        rect(130, 1000, 940, 40, C.skyDeep, 0, { opacity: 0.25 }),
        circle(230, 1250, 40, C.grey),
        circle(970, 1250, 40, C.grey),
        bubbles(41, 12, 160, 1040, 740, 800, 30, 55),
        duck(720, 680, 1.15),
        bubbles(43, 10, 300, 900, 380, 600, 12, 30),
      ]),
  },
  {
    // 5. First Christmas in a red onesie next to the tree.
    slug: "first-christmas",
    draw: () =>
      doc([
        wall(C.linen),
        windowPane(780, 200, 300, 380, C.skyDeep, stars(25, 26, 580, C.white)),
        floor(1260, C.woodSoft, C.wood),
        rug(620, 1420, 560, 150, [C.coralSoft, C.cream, C.coralSoft]),
        xmasTree(330, 1330, 0.95),
        present(80, 1380, 160, 130, C.mustard, C.coral),
        present(470, 1370, 140, 110, C.teal, C.white),
        place(860, 1440, 1.3, babySitting(maya(C.red, C.white, "cap"), "happy")),
      ]),
  },
  {
    // 6. Sitting up on the rug, holding a wooden rattle.
    slug: "rattle-on-rug",
    draw: () =>
      doc([
        wall(C.sageSoft),
        frame(170, 240, 280, 220, C.cream, C.coralSoft),
        floor(1100, C.oat),
        rug(600, 1360, 540, 180, [C.coralSoft, C.cream, C.mustard, C.cream]),
        plant(1040, 1110, 1.2),
        place(
          600,
          1410,
          1.45,
          babySitting(maya(C.mustard, C.white, "cap"), "happy", {
            hands: [
              [-84, -104],
              [118, -250],
            ],
            front: rattle(118, -236, 0.75, 18),
          }),
        ),
      ]),
  },
  {
    // 7. Blurry shot in the stroller at the park (trashed photo).
    slug: "stroller-park-blurry",
    blur: 7,
    draw: () =>
      doc([
        sky(C.sky),
        sun(950, 260, 80),
        cloud(300, 300, 1.2),
        hills(1000, C.sageSoft, C.sage),
        tree(170, 1060, 1.1, C.sageDeep),
        tree(1020, 990, 0.9, "#93b98b"),
        place(
          620,
          1390,
          1.35,
          stroller(
            0,
            0,
            1,
            C.denim,
            C.lavender,
            babyHead(-40, -330, 78, maya(C.denim, undefined, "cap"), "calm"),
          ),
        ),
      ]),
  },
  {
    // 8. Crawling across the kitchen floor.
    slug: "kitchen-crawl",
    draw: () => {
      const doors: string[] = [];
      for (let x = 30; x < 1180; x += 290) {
        doors.push(rect(x, 740, 260, 380, C.sageDeep, 14, { opacity: 0.35 }));
        doors.push(rect(x + 110, 790, 40, 12, C.woodDeep, 6));
      }
      return doc([
        wall(C.cream),
        windowPane(380, 170, 440, 330, C.sky, sun(700, 260, 50)),
        plant(220, 660, 0.55, C.sageDeep, C.mustard),
        rect(0, 700, 1200, 450, C.sage),
        ...doors,
        rect(0, 670, 1200, 50, C.woodSoft, 10),
        tiles(1150, 1600, 150, C.oat, C.cream),
        place(560, 1440, 1.5, babyCrawling(maya(C.mustard, C.white, "cap"), "happy")),
        ball(1040, 1380, 46, C.teal, C.white),
      ]);
    },
  },
  {
    // 9. First steps on the grass toward Dad: yellow sundress, white sun hat, sunny.
    slug: "first-steps-park",
    draw: () =>
      doc([
        sky(C.sky),
        sun(990, 230, 90),
        cloud(250, 260, 1.1),
        cloud(640, 170, 0.7),
        hills(960, C.sageSoft, "#9cc092"),
        tree(130, 930, 0.75, C.sageDeep),
        flowers(9, 28, 1080, 1560, [C.white, C.coralSoft, C.butter]),
        place(
          420,
          1380,
          1.25,
          babyStanding(maya(C.mustard, C.white, "cap"), "happy", {
            outfit: "dress",
            hat: { color: C.white, band: C.coral },
            hands: [
              [-150, -330],
              [175, -360],
            ],
          }),
        ),
        place(930, 1440, 1.05, adultKneeling(MAYA_DAD)),
      ]),
  },
  {
    // 10. First birthday: a single candle on a small cake, hands reaching for it.
    slug: "first-birthday-cake",
    draw: () =>
      doc([
        wall(C.blush),
        garland(140, [C.coral, C.mustard, C.teal, C.white]),
        line(`M ${pts(150, 420)} Q ${pts(170, 600, 140, 760)}`, C.grey, 3),
        ellipse(150, 360, 70, 84, C.coral),
        line(`M ${pts(1050, 380)} Q ${pts(1030, 560, 1060, 740)}`, C.grey, 3),
        ellipse(1050, 320, 70, 84, C.mustard),
        rect(0, 1050, 1200, 550, C.woodSoft),
        rect(0, 1050, 1200, 24, C.wood),
        place(600, 1210, 1.25, cake(0, 0, 1)),
        reachingHand(300, 1660, 455, 1300, SKIN[1], C.lavender),
        reachingHand(900, 1660, 745, 1310, SKIN[1], C.lavender),
      ]),
  },
  {
    // 11. Reading a picture book on the nanny's lap.
    slug: "nanny-book",
    draw: () =>
      doc([
        wall(C.lavender),
        windowPane(860, 180, 240, 340, C.sky, cloud(980, 330, 0.6)),
        floor(1380, C.oat),
        armchair(600, 1150, C.coralSoft, C.peach),
        place(
          600,
          1110,
          1.02,
          adultSeated(
            NANNY,
            [
              [-175, -95],
              [175, -95],
            ],
            place(
              0,
              20,
              0.82,
              babySitting(maya(C.butter, C.white, "cap"), "calm", {
                shadow: false,
                hands: [
                  [-70, -150],
                  [70, -150],
                ],
              }),
            ),
            book(0, -130, 0.95, C.coral),
          ),
        ),
      ]),
  },
  {
    // 12. Pushing a toy cart across the living room.
    slug: "toy-cart-walk",
    draw: () =>
      doc([
        wall(C.butter),
        windowPane(140, 220, 300, 380, C.sky, cloud(300, 380, 0.8)),
        frame(760, 300, 240, 180, C.cream, C.teal),
        floor(1150, C.wood, C.woodDeep),
        rug(640, 1420, 560, 140, [C.cream, C.sageSoft, C.cream]),
        plant(1080, 1180, 1.1),
        place(
          400,
          1400,
          1.3,
          babyStanding(maya(C.teal, C.white, "cap"), "happy", {
            hands: [
              [95, -335],
              [135, -322],
            ],
          }),
        ),
        place(800, 1400, 0.9, cart(0, 0, 1, [C.coral, C.mustard, C.sage, C.lavender])),
      ]),
  },
];

// --- The store-review family: Sunny (24, in created_at order) ----------------------------------

function highChairScene(
  bg: string,
  outfit: string,
  trim: string,
  tray: string,
  extraTray: string,
  expr: "happy" | "calm",
  deco: string,
): string {
  return doc([
    wall(bg),
    deco,
    floor(1350, C.oat),
    highChair(600, 1530, C.woodSoft),
    place(
      600,
      1010,
      1.1,
      babySitting(sunny(outfit, trim), expr, {
        shadow: false,
        hands: [
          [-128, -88],
          [128, -88],
        ],
      }),
    ),
    trayFront(600, 940, tray),
    extraTray,
  ]);
}

export const REVIEW_SCENES: readonly Scene[] = [
  {
    // 1. Home from the hospital, wrapped in the striped blanket.
    slug: "home-striped-blanket",
    draw: () =>
      doc([
        wall(C.cream),
        frame(500, 150, 200, 150, C.sky, C.coralSoft),
        rect(60, 380, 1080, 320, C.woodSoft, 60),
        rect(0, 560, 1200, 1040, C.white),
        rect(0, 560, 1200, 1040, C.skyDeep, 0, { opacity: 0.18 }),
        pillow(330, 700, 520, 240, C.white),
        pillow(880, 690, 480, 230, C.linen),
        place(
          600,
          1120,
          1.55,
          babySwaddled(sunny(C.white, undefined, "tuft"), "sleep", C.snow, {
            stripes: C.coralSoft,
            clipId: "r1",
          }),
        ),
      ]),
  },
  {
    // 2. Asleep in the crib under a mobile.
    slug: "crib-mobile",
    draw: () =>
      doc([
        wall(C.lavender),
        mobile(600, 300, [C.mustard, C.coral, C.butter, C.white]),
        floor(1360, C.woodSoft),
        rect(170, 1120, 860, 150, C.sky, 30),
        place(600, 1080, 1.05, babySwaddled(sunny(C.butter, undefined, "tuft"), "sleep", C.butter)),
        crib(150, 760, 900, 560, C.white),
      ]),
  },
  {
    // 3. Grandma's first visit.
    slug: "grandma-visit",
    draw: () =>
      doc([
        wall(C.sageSoft),
        frame(150, 200, 240, 300, C.cream, C.coral),
        floor(1380, C.oat),
        armchair(600, 1150, C.sage, C.sageSoft),
        place(
          600,
          1110,
          1.02,
          adultSeated(
            GRANDMA,
            [
              [-150, -170],
              [160, -240],
            ],
            place(
              10,
              -200,
              0.72,
              babySwaddled(sunny(C.white, undefined, "tuft"), "sleep", C.snow, {
                stripes: C.lavender,
                clipId: "r3",
              }),
              -12,
            ),
          ),
        ),
      ]),
  },
  {
    // 4. Dozing in the bouncer by the window.
    slug: "bouncer-window",
    draw: () =>
      doc([
        wall(C.cream),
        windowPane(220, 160, 760, 560, C.sky, cloud(420, 360, 1.1) + cloud(820, 300, 0.8)),
        plant(140, 1150, 1.0),
        floor(1150, C.woodSoft, C.wood),
        place(620, 1400, 1.3, bouncer(0, 0, 1, C.teal)),
        place(
          610,
          1060,
          1.05,
          babySwaddled(sunny(C.white, undefined, "tuft"), "sleep", C.butter),
          -12,
        ),
      ]),
  },
  {
    // 5. Lying under the play gym (seen from above).
    slug: "play-gym",
    draw: () =>
      doc([
        quilt(0, 0, 1200, 1600, [C.cream, C.butter, C.sageSoft, C.peach, C.sky], 200),
        rug(600, 900, 520, 600, [C.coralSoft, C.cream]),
        place(600, 960, 1.5, babyLyingBack(sunny(C.sage, C.white, "tuft"), "calm")),
        playGym(600, 380, 1020, 300, [C.coral, C.mustard, C.teal, C.lavender]),
      ]),
  },
  {
    // 6. First walk in the stroller, autumn trees.
    slug: "stroller-autumn",
    draw: () =>
      doc([
        sky(C.skyDeep),
        cloud(860, 260, 1.2),
        hills(1060, "#e7c98f", C.sage),
        tree(180, 1090, 1.05, C.mustard),
        tree(1030, 1030, 0.85, C.coral),
        tree(760, 980, 0.6, C.coralSoft),
        place(
          560,
          1420,
          1.35,
          stroller(
            0,
            0,
            1,
            C.coral,
            C.coralSoft,
            babyHead(-40, -330, 78, sunny(C.coral, undefined, "tuft"), "calm"),
          ),
        ),
      ]),
  },
  {
    // 7. First real smile, held up by Dad.
    slug: "first-smile-dad",
    draw: () =>
      doc([
        wall(C.peach),
        windowPane(100, 200, 320, 420, C.sky, sun(330, 300, 50)),
        place(
          760,
          1640,
          1,
          adultFromBelow(SUNNY_DAD, [
            [-369, -440],
            [-191, -440],
          ]),
        ),
        place(
          470,
          1450,
          1.1,
          babyStanding(sunny(C.coral, C.white, "tuft"), "happy", {
            dangling: true,
            hands: [
              [-150, -380],
              [115, -400],
            ],
          }),
        ),
        circle(391, 1200, 42, SUNNY_DAD.skin),
        circle(569, 1200, 42, SUNNY_DAD.skin),
      ]),
  },
  {
    // 8. Tummy time on a blanket next to a teddy.
    slug: "tummy-teddy",
    draw: () =>
      doc([
        wall(C.linen),
        floor(900, C.oat),
        gingham(40, 1020, 1120, 480, C.white, C.teal),
        teddy(960, 1260, 0.9, C.wood, C.woodSoft),
        place(500, 1360, 1.6, babyTummy(sunny(C.butter, C.white, "tuft"), "smile")),
      ]),
  },
  {
    // 9. Asleep at night with the teddy, moon in the window.
    slug: "night-teddy",
    draw: () =>
      doc([
        wall(C.night),
        windowPane(
          700,
          160,
          380,
          460,
          C.nightDeep,
          stars(9, 30, 620, C.butter) + moon(960, 300, 60, C.butter, C.nightDeep),
        ),
        floor(1250, C.nightDeep),
        rect(80, 860, 1040, 420, "#556188", 40),
        rect(110, 900, 980, 140, "#6a76a0", 30),
        place(
          560,
          1060,
          1.25,
          babySwaddled(sunny(C.lavender, undefined, "tuft"), "sleep", C.lavender),
        ),
        teddy(200, 1080, 0.55, C.woodSoft, C.butter),
      ]),
  },
  {
    // 10. Story time with Grandma on the sofa.
    slug: "grandma-story",
    draw: () =>
      doc([
        wall(C.butter),
        floor(1380, C.woodSoft),
        sofa(80, 860, 1040, C.coralSoft, C.peach),
        place(
          600,
          1120,
          1.0,
          adultSeated(
            GRANDMA,
            [
              [-170, -90],
              [170, -90],
            ],
            place(
              0,
              20,
              0.8,
              babySitting(sunny(C.sage, C.white, "tuft"), "calm", {
                shadow: false,
                hands: [
                  [-70, -150],
                  [70, -150],
                ],
              }),
            ),
            book(0, -130, 0.95, C.teal),
          ),
        ),
      ]),
  },
  {
    // 11. Catching toes on the patchwork quilt (from above).
    slug: "quilt-toes",
    draw: () =>
      doc([
        quilt(0, 0, 1200, 1600, [C.peach, C.sky, C.butter, C.sageSoft, C.lavender, C.cream], 240),
        place(
          600,
          780,
          1.7,
          babyLyingBack(sunny(C.mustard, C.white, "tuft"), "happy", [
            [-70, 175],
            [70, 175],
          ]),
        ),
      ]),
  },
  {
    // 12. Rolling over on the mat, ball in reach.
    slug: "roll-over-ball",
    draw: () =>
      doc([
        wall(C.sky),
        floor(820, C.sand),
        rect(60, 960, 1080, 560, C.coralSoft, 60),
        rect(100, 1000, 1000, 480, C.peach, 44),
        ball(260, 1200, 90, C.teal, C.white),
        place(640, 1370, 1.5, babyTummy(sunny(C.teal, C.white, "tuft"), "happy"), 0, true),
      ]),
  },
  {
    // 13. Propped up in the pillows with a soft bunny.
    slug: "pillow-fort",
    draw: () =>
      doc([
        wall(C.blush),
        rect(0, 900, 1200, 700, C.white),
        pillow(300, 980, 560, 300, C.sky, -10),
        pillow(900, 980, 560, 300, C.lavender, 10),
        place(600, 1400, 1.4, babySitting(sunny(C.coralSoft, C.white, "tuft"), "smile")),
        teddy(990, 1450, 0.6, C.greySoft, C.white),
      ]),
  },
  {
    // 14. On Dad's lap.
    slug: "dad-lap",
    draw: () =>
      doc([
        wall(C.sageSoft),
        windowPane(820, 220, 260, 360, C.sky, cloud(950, 380, 0.6)),
        floor(1300, C.wood, C.woodDeep),
        place(
          600,
          1150,
          1.0,
          adultSeated(
            SUNNY_DAD,
            [
              [-110, -150],
              [110, -150],
            ],
            place(
              0,
              30,
              0.85,
              babySitting(sunny(C.mustard, C.white, "curls"), "happy", { shadow: false }),
            ),
          ),
        ),
      ]),
  },
  {
    // 15. Stacking rings.
    slug: "stacking-rings",
    draw: () =>
      doc([
        wall(C.peach),
        frame(780, 240, 260, 200, C.cream, C.sage),
        floor(1080, C.sageSoft),
        rings(890, 1440, 1.1, [C.coral, C.mustard, C.sage, C.skyDeep, C.lavender]),
        place(
          480,
          1440,
          1.4,
          babySitting(sunny(C.denim, C.white), "happy", {
            hands: [
              [-84, -104],
              [140, -170],
            ],
            front: ellipse(150, -170, 62, 24, C.coral),
          }),
        ),
      ]),
  },
  {
    // 16. In the high chair with blocks.
    slug: "high-chair-blocks",
    draw: () =>
      highChairScene(
        C.sageSoft,
        C.coral,
        C.white,
        C.white,
        blocks(
          700,
          870,
          0.9,
          [C.mustard, C.teal, C.coralSoft],
          [
            [0, 0],
            [80, 0],
            [40, -78],
          ],
        ),
        "happy",
        windowPane(860, 200, 240, 320, C.sky, sun(980, 360, 40)),
      ),
  },
  {
    // 17. First taste of mashed sweet potato.
    slug: "first-food",
    draw: () =>
      highChairScene(
        C.butter,
        C.lavender,
        C.white,
        C.white,
        [
          // the bib, with most of the sweet potato on it
          path(
            `M ${pts(530, 770)} Q ${pts(600, 745, 670, 770)} Q ${pts(690, 900, 600, 915)} Q ${pts(510, 900, 530, 770)} Z`,
            C.white,
          ),
          circle(575, 830, 13, C.coral),
          circle(628, 862, 10, C.coral),
          circle(600, 885, 7, C.coralSoft),
          circle(560, 735, 7, C.coral),
          bowl(790, 940, 0.9, C.teal, C.coral),
          spoon(420, 985, 0.8, -35, C.coral, C.coral),
        ].join(""),
        "happy",
        garland(120, [C.coralSoft, C.sage, C.white], 100, 1100),
      ),
  },
  {
    // 18. Sitting in the garden grass.
    slug: "garden-grass",
    draw: () =>
      doc([
        sky(C.sky),
        sun(220, 240, 80),
        hills(900, C.sageSoft, C.sage),
        flowers(18, 40, 960, 1560, [C.white, C.coralSoft, C.butter, C.lavender]),
        place(
          620,
          1420,
          1.45,
          babySitting(sunny(C.white, C.sage), "happy", { hat: { color: C.butter, band: C.sage } }),
        ),
      ]),
  },
  {
    // 19. Sunday picnic in the garden with Grandma and Dad.
    slug: "garden-picnic",
    draw: () =>
      doc([
        sky(C.sky),
        cloud(900, 220, 1.1),
        hills(760, C.sageSoft, "#9cc092"),
        tree(1080, 820, 0.8, C.sageDeep),
        gingham(60, 1060, 1080, 500, C.white, C.coral),
        place(
          200,
          1180,
          0.7,
          adultSeated(GRANDMA, [
            [-120, -60],
            [120, -60],
          ]),
        ),
        place(
          1000,
          1180,
          0.7,
          adultSeated(SUNNY_DAD, [
            [-120, -60],
            [120, -60],
          ]),
        ),
        basket(600, 1260, 0.75),
        place(600, 1500, 1.15, babySitting(sunny(C.mustard, C.white), "happy")),
      ]),
  },
  {
    // 20. Crawling on the rug toward a ball.
    slug: "crawl-rug-ball",
    draw: () =>
      doc([
        wall(C.lavender),
        frame(200, 260, 300, 220, C.cream, C.mustard),
        floor(1000, C.woodSoft, C.wood),
        rug(600, 1340, 580, 220, [C.mustard, C.cream, C.coralSoft, C.cream]),
        ball(1040, 1360, 60, C.coral, C.butter),
        place(520, 1420, 1.45, babyCrawling(sunny(C.sage, C.white), "happy")),
      ]),
  },
  {
    // 21. Pulling up to stand at the sofa.
    slug: "pull-up-sofa",
    draw: () =>
      doc([
        wall(C.cream),
        frame(160, 200, 260, 220, C.sky, C.sage),
        floor(1240, C.wood, C.woodDeep),
        sofa(120, 860, 960, C.teal, "#a9d1cb"),
        place(
          620,
          1440,
          1.2,
          babyStanding(sunny(C.coral, C.white), "happy", {
            hands: [
              [-120, -440],
              [120, -440],
            ],
          }),
        ),
      ]),
  },
  {
    // 22. Building a block tower.
    slug: "block-tower",
    draw: () =>
      doc([
        wall(C.sageSoft),
        windowPane(760, 220, 300, 380, C.sky, sun(980, 320, 45)),
        floor(1120, C.oat),
        rug(600, 1420, 560, 160, [C.sky, C.white, C.sky]),
        blocks(
          820,
          1060,
          1.05,
          [C.coral, C.mustard, C.teal, C.lavender, C.sage],
          [
            [0, 240],
            [0, 160],
            [0, 80],
            [0, 0],
            [90, 240],
          ],
        ),
        place(
          460,
          1450,
          1.4,
          babySitting(sunny(C.butter, C.coral), "smile", {
            hands: [
              [-84, -104],
              [150, -200],
            ],
          }),
        ),
      ]),
  },
  {
    // 23. In the baby swing at the park.
    slug: "park-swing",
    draw: () =>
      doc([
        sky(C.skyDeep),
        cloud(250, 260, 1.0),
        cloud(900, 180, 0.8),
        hills(1150, C.sageSoft, C.sage),
        line(`M ${pts(120, 160)} L ${pts(1080, 160)}`, C.woodDeep, 28),
        swing(600, 160, 1040),
        place(
          600,
          1060,
          1.2,
          babySitting(sunny(C.coral, C.white), "happy", {
            shadow: false,
            hands: [
              [-150, -230],
              [150, -230],
            ],
          }),
        ),
        swingSeatFront(600, 1040, C.mustard),
        shadow(600, 1460, 220, 30),
      ]),
  },
  {
    // 24. First steps across the living room to Dad.
    slug: "first-steps-living-room",
    draw: () =>
      doc([
        wall(C.linen),
        windowPane(120, 220, 300, 400, C.sky, cloud(270, 380, 0.7)),
        floor(1180, C.wood, C.woodDeep),
        rug(600, 1420, 600, 160, [C.coralSoft, C.cream, C.coralSoft]),
        cat(150, 1300, 0.55, C.grey),
        place(
          400,
          1400,
          1.2,
          babyStanding(sunny(C.teal, C.white), "happy", {
            hands: [
              [-150, -330],
              [175, -360],
            ],
          }),
        ),
        place(920, 1450, 1.0, adultKneeling(SUNNY_DAD)),
      ]),
  },
];

// --- Rendering ---------------------------------------------------------------------------------

export interface RenderedIllustration {
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Rasterise one scene to a progressive mozjpeg JPEG (sRGB, flattened onto white). The output has
 * no EXIF/XMP/IPTC/ICC: nothing in this chain keeps or adds metadata.
 */
export async function renderScene(scene: Scene): Promise<RenderedIllustration> {
  let img = sharp(Buffer.from(scene.draw(), "utf8"), { density: 72 })
    .resize(ILLUSTRATION_WIDTH, ILLUSTRATION_HEIGHT, { fit: "fill" })
    .flatten({ background: "#ffffff" });
  if (scene.blur) img = sharp(await img.png().toBuffer()).blur(scene.blur);
  const { data, info } = await img
    .toColourspace("srgb")
    .jpeg({ quality: ILLUSTRATION_JPEG_QUALITY, mozjpeg: true, progressive: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, bytes: data.byteLength };
}

/** Scene of seeded demo photo `nn` (1..12). */
export function demoScene(nn: number): Scene {
  const scene = DEMO_SCENES[nn - 1];
  if (!scene) throw new RangeError("demo photo number out of range");
  return scene;
}

/** Scene of review photo `nn` (1..24, in the rows' created_at order). */
export function reviewScene(nn: number): Scene {
  const scene = REVIEW_SCENES[nn - 1];
  if (!scene) throw new RangeError("review photo number out of range");
  return scene;
}
