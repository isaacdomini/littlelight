import {
  AGE_MONTH_DAYS,
  type AiDescriptionV1,
  aiDescriptionV1Schema,
  type MeasurementKind,
  MILESTONE_PRESETS,
} from "@littlelight/shared";

// Deterministic content of the dev search seed (docs/plans/step-7.md 2.6 "search-seed.ts", 2.12
// golden set). Pure, like `tools/perf-content.ts`: same `count` ⇒ same photos, details, AI
// descriptions and measurements, byte for byte.
//
// The "Golden" baby (born 2025-03-15) gets `count` photos at ages 0..560 days (nothing in the
// future as of the seed's writing). Photo indices 0..49 are the GOLDEN TARGETS: each carries a
// planted combination that no distractor reproduces. Uniqueness is by construction:
// - every target has a signature object word from `GOLDEN_SIGNATURES` that never appears in any
//   distractor pool (the 1-, 6- and 12-month comparison targets 40-42 share "hammock" and differ by
//   age);
// - some targets carry a person ("Aunt Lily", "Uncle Ben", …) or a milestone ("First steps",
//   "First birthday", …) reserved for targets only;
// - `goldenCollisions()` re-checks the generated set (the unit test asserts it is empty).
// `GOLDEN_TARGETS[i].query` is a suggested golden query in the form the fake chat model parses
// (absolute dates or ages, "with <Name>", preset milestone names), with the expected index; the
// gate's `e2e/search/golden.ts` owns the final list.

export const SEARCH_SEED_BIRTH_DATE = "2025-03-15";
export const SEARCH_SEED_BABY_NAME = "Golden";
export const SEARCH_SEED_BABY_NICKNAME = "Goldie";
export const SEARCH_SEED_TZ_OFFSET_MINUTES = 0;
/** Oldest age generated (≈ 18 months; the birth date + 560 days is in the past as of 2026-10). */
export const SEARCH_SEED_MAX_AGE_DAYS = 560;
export const GOLDEN_COUNT = 50;

const DAY_MS = 86_400_000;
const BIRTH_MS = Date.UTC(2025, 2, 15);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

// ---- pools ---------------------------------------------------------------------------------------

interface Place {
  label: string | null;
  type: string;
  outdoor: boolean;
  activities: readonly string[];
}

const PLACES: readonly Place[] = [
  {
    label: "Home",
    type: "living room",
    outdoor: false,
    activities: ["playing", "tummy time", "reading", "crawling"],
  },
  {
    label: "Home",
    type: "bedroom",
    outdoor: false,
    activities: ["sleeping", "napping", "waking up"],
  },
  {
    label: "Home",
    type: "kitchen",
    outdoor: false,
    activities: ["eating", "feeding", "snack time"],
  },
  { label: "Home", type: "bathroom", outdoor: false, activities: ["bath"] },
  {
    label: "Home",
    type: "nursery",
    outdoor: false,
    activities: ["sleeping", "diaper change", "playing"],
  },
  {
    label: "Riverside Park",
    type: "park",
    outdoor: true,
    activities: ["walking", "swinging", "picnic"],
  },
  {
    label: "Ocean Beach",
    type: "beach",
    outdoor: true,
    activities: ["playing in the sand", "splashing"],
  },
  {
    label: "Grandma's house",
    type: "living room",
    outdoor: false,
    activities: ["playing", "cuddling"],
  },
  {
    label: "City Zoo",
    type: "zoo",
    outdoor: true,
    activities: ["looking at animals", "stroller ride"],
  },
  {
    label: "Oak Street Playground",
    type: "playground",
    outdoor: true,
    activities: ["sliding", "swinging"],
  },
  { label: null, type: "car", outdoor: false, activities: ["car ride"] },
  { label: "Corner Cafe", type: "cafe", outdoor: false, activities: ["eating", "people watching"] },
];

const OBJECTS = [
  "teddy bear",
  "rattle",
  "blanket",
  "crib",
  "stroller",
  "ball",
  "book",
  "blocks",
  "bottle",
  "pacifier",
  "toy car",
  "rubber duck",
  "bib",
  "spoon",
  "sand bucket",
  "high chair",
  "stuffed bunny",
] as const;
const CLOTHING = [
  "onesie",
  "striped shirt",
  "blue overalls",
  "pajamas",
  "red jacket",
  "white socks",
  "green hoodie",
  "knit hat",
  "denim dress",
  "sleep sack",
] as const;
const MOODS = ["happy", "calm", "sleepy", "curious", "joyful", "giggly", "fussy"] as const;
const WEATHER = ["sunny", "cloudy", "windy"] as const;
const COMMON_PEOPLE = ["Mom", "Dad", "Grandma", "Grandpa", "Nanny"] as const;
const NOTES = [
  "such a sweet morning",
  "she loved this",
  "tired but happy",
  "a lazy weekend",
  "she would not stop smiling",
  "long day, good day",
] as const;

/** Milestones distractors may carry (1 in 40). */
const DISTRACTOR_MILESTONES = [
  "First smile",
  "Rolled over",
  "Sat up",
  "First food",
  "Crawled",
  "First tooth",
];
/** Milestones only golden targets carry. */
const RESERVED_MILESTONES = [
  "First steps",
  "First birthday",
  "First haircut",
  "First word",
  "First laugh",
];
/** People only golden targets carry. */
const RESERVED_PEOPLE = [
  "Aunt Lily",
  "Uncle Ben",
  "Cousin Noah",
  "Grandpa Joe",
  "Auntie Rose",
  "Uncle Theo",
];

/** One signature object word per target (index = target); 40-42 share "hammock". */
export const GOLDEN_SIGNATURES: readonly string[] = [
  "kite",
  "sandcastle",
  "pumpkin",
  "harmonica",
  "snowman",
  "xylophone",
  "tricycle",
  "lantern",
  "watermelon",
  "lighthouse",
  "carousel",
  "aquarium",
  "ukulele",
  "pinwheel",
  "balloon",
  "ferry",
  "tractor",
  "llama",
  "sunflower",
  "firetruck",
  "piano",
  "puppy",
  "kitten",
  "sundress",
  "strawberries",
  "cupcake",
  "umbrella",
  "rainboots",
  "puddle",
  "sled",
  "scale",
  "measuring tape",
  "tent",
  "campfire",
  "train",
  "candles",
  "scissors",
  "microphone",
  "tickles",
  "sailboat",
  "hammock",
  "hammock",
  "hammock",
  "fountain",
  "parade",
  "fireworks",
  "scarecrow",
  "orchard",
  "goat",
  "telescope",
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function milestoneId(name: string): string {
  const m = MILESTONE_PRESETS.find((p) => p.name === name);
  if (!m) throw new Error(`unknown preset ${name}`);
  return m.id;
}

// ---- content -------------------------------------------------------------------------------------

export interface SeedPhoto {
  index: number;
  ageDays: number;
  /** Capture instant (UTC; the EXIF offset is 0). */
  takenAt: Date;
  place: Place;
  activity: string;
  objects: string[];
  clothing: string[];
  mood: string[];
  weather: string | null;
  people: string[];
  milestone: string | null;
  note: string | null;
  sensitive: AiDescriptionV1["sensitive_content"];
  golden: boolean;
}

export type GoldenKind = "keyword" | "filter" | "fact" | "comparison";

export interface GoldenTarget {
  index: number;
  /** Signature object word planted in the target's description. */
  signature: string;
  ageDays: number;
  /** `YYYY-MM-DD` (UTC = local, offset 0). */
  date: string;
  people: string[];
  placeLabel: string | null;
  placeType: string;
  milestone: string | null;
  clothing: string[];
  /** Suggested golden query (fake-model friendly). */
  query: string;
  kind: GoldenKind;
  /** Targets answered together by one comparison query (40-42). */
  group: string | null;
}

function dateOf(ageDays: number, hourUtc: number): Date {
  return new Date(BIRTH_MS + ageDays * DAY_MS + hourUtc * 3_600_000);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The scene of golden target `i` (hand-planted for 7, 23, 30, 31, 35-38, 40-42). */
function goldenScene(i: number): Omit<SeedPhoto, "index" | "takenAt" | "golden" | "sensitive"> & {
  query: string;
  kind: GoldenKind;
  group: string | null;
} {
  const sig = GOLDEN_SIGNATURES[i] as string;
  const r = rng(10_000 + i);
  const place = PLACES[i % PLACES.length] as Place;
  const base = {
    place,
    activity: pick(r, place.activities),
    objects: [sig, pick(r, OBJECTS)],
    clothing: [pick(r, CLOTHING)],
    mood: [pick(r, MOODS)],
    weather: place.outdoor ? pick(r, WEATHER) : null,
    people: [] as string[],
    milestone: null as string | null,
    note: null as string | null,
    ageDays: 20 + ((i * 37) % 500),
    group: null as string | null,
  };
  // A place label naming a family word ("Grandma's house") would read as a people filter.
  const at = (label: string | null) =>
    label && !/grandma|grandpa|mom|dad|nanny/i.test(label) ? label : `the ${place.type}`;
  switch (i) {
    case 7: {
      const park = PLACES[5] as Place;
      return {
        ...base,
        place: park,
        activity: "walking",
        weather: "sunny",
        people: ["Dad"],
        milestone: "First steps",
        ageDays: 349,
        query: "show me her first steps at Riverside Park with Dad",
        kind: "filter",
      };
    }
    case 23: {
      const beach = PLACES[6] as Place;
      return {
        ...base,
        place: beach,
        activity: "splashing",
        clothing: ["yellow sundress", "sun hat"],
        weather: "sunny",
        people: ["Aunt Lily"],
        ageDays: 124, // 2025-07-17
        query: "photos with Aunt Lily at the beach in July 2025",
        kind: "filter",
      };
    }
    case 30:
      return { ...base, ageDays: 183, query: "What did she weigh at 6 months?", kind: "fact" };
    case 31:
      return { ...base, ageDays: 365, query: "How tall was she at 12 months?", kind: "fact" };
    case 35:
      return {
        ...base,
        milestone: "First birthday",
        ageDays: 365,
        query: "show her first birthday",
        kind: "filter",
      };
    case 36:
      return {
        ...base,
        milestone: "First haircut",
        ageDays: 420,
        query: "show me her first haircut",
        kind: "filter",
      };
    case 37:
      return {
        ...base,
        milestone: "First word",
        ageDays: 330,
        query: "show her first word",
        kind: "filter",
      };
    case 38:
      return {
        ...base,
        milestone: "First laugh",
        ageDays: 110,
        query: "show her first laugh",
        kind: "filter",
      };
    case 40:
    case 41:
    case 42: {
      const months = i === 40 ? 1 : i === 41 ? 6 : 12;
      return {
        ...base,
        ageDays: Math.round(months * AGE_MONTH_DAYS),
        query: "show her in the hammock at 1, 6 and 12 months",
        kind: "comparison",
        group: "hammock",
      };
    }
    default:
      break;
  }
  switch (i % 5) {
    case 0:
      return { ...base, query: `show me the ${sig}`, kind: "keyword" };
    case 1: {
      const person = RESERVED_PEOPLE[
        1 + (Math.floor(i / 5) % (RESERVED_PEOPLE.length - 1))
      ] as string;
      return { ...base, people: [person], query: `${sig} with ${person}`, kind: "filter" };
    }
    case 2: {
      const d = dateOf(base.ageDays, 12);
      const month = MONTH_NAMES[d.getUTCMonth()] as string;
      return { ...base, query: `${sig} in ${month} ${d.getUTCFullYear()}`, kind: "filter" };
    }
    case 3: {
      const months = 1 + (i % 17);
      return {
        ...base,
        ageDays: Math.round(months * AGE_MONTH_DAYS) + (i % 7) - 3,
        query: `the ${sig} at ${months} months`,
        kind: "filter",
      };
    }
    default:
      return {
        ...base,
        people: [pick(r, COMMON_PEOPLE)],
        query: `${sig} at ${at(place.label)}`,
        kind: "keyword",
      };
  }
}

function distractor(index: number): SeedPhoto {
  const r = rng(index + 1);
  const place = pick(r, PLACES);
  const ageDays = Math.floor(r() * (SEARCH_SEED_MAX_AGE_DAYS + 1));
  const activity = pick(r, place.activities);
  const peopleCount = r() < 0.5 ? 0 : r() < 0.8 ? 1 : 2;
  const people: string[] = [];
  for (let k = 0; k < peopleCount; k++) {
    const p = pick(r, COMMON_PEOPLE);
    if (!people.includes(p)) people.push(p);
  }
  return {
    index,
    ageDays,
    takenAt: dateOf(ageDays, 7 + Math.floor(r() * 13)),
    place,
    activity,
    objects: [pick(r, OBJECTS), pick(r, OBJECTS)].filter((v, i, a) => a.indexOf(v) === i),
    clothing: [pick(r, CLOTHING)],
    mood: [pick(r, MOODS)],
    weather: place.outdoor ? pick(r, WEATHER) : null,
    people,
    milestone: r() < 1 / 40 ? pick(r, DISTRACTOR_MILESTONES) : null,
    note: r() < 1 / 30 ? pick(r, NOTES) : null,
    sensitive: activity === "bath" ? ["bath"] : activity === "diaper change" ? ["diaper"] : [],
    golden: false,
  };
}

/** The `count` photos of the seed (indices 0..49 are the golden targets). */
export function searchSeedPhotos(count: number): SeedPhoto[] {
  if (!Number.isInteger(count) || count < GOLDEN_COUNT) {
    throw new RangeError(`count must be an integer >= ${GOLDEN_COUNT}`);
  }
  const out: SeedPhoto[] = [];
  for (let i = 0; i < count; i++) {
    if (i < GOLDEN_COUNT) {
      const g = goldenScene(i);
      out.push({
        index: i,
        ageDays: g.ageDays,
        takenAt: dateOf(g.ageDays, 12),
        place: g.place,
        activity: g.activity,
        objects: g.objects,
        clothing: g.clothing,
        mood: g.mood,
        weather: g.weather,
        people: g.people,
        milestone: g.milestone,
        note: g.note,
        sensitive: g.activity === "bath" ? ["bath"] : [],
        golden: true,
      });
    } else {
      out.push(distractor(i));
    }
  }
  return out;
}

/** The 50 planted targets and their suggested golden queries. */
export const GOLDEN_TARGETS: readonly GoldenTarget[] = Object.freeze(
  Array.from({ length: GOLDEN_COUNT }, (_, i) => {
    const g = goldenScene(i);
    return Object.freeze({
      index: i,
      signature: GOLDEN_SIGNATURES[i] as string,
      ageDays: g.ageDays,
      date: ymd(dateOf(g.ageDays, 12)),
      people: g.people,
      placeLabel: g.place.label,
      placeType: g.place.type,
      milestone: g.milestone,
      clothing: g.clothing,
      query: g.query,
      kind: g.kind,
      group: g.group,
    });
  }),
);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The schema-valid `photo_ai.description` of a photo (model `fake`, versions v1). */
export function seedDescription(p: SeedPhoto): AiDescriptionV1 {
  const main = p.objects[0] ?? "toy";
  const where = `the ${p.place.type}`;
  const caption = `The baby is ${p.activity} in ${where} with a ${main}.`;
  const detailed =
    `${capitalize(p.activity)} in ${where}${p.weather ? ` on a ${p.weather} day` : ""}. ` +
    `The baby wears ${p.clothing.join(" and ")} and looks ${p.mood.join(" and ")}. ` +
    `A ${p.objects.join(" and a ")} ${p.objects.length > 1 ? "are" : "is"} nearby.`;
  const tags = [
    ...new Set(
      [main, p.activity, p.place.type, ...p.clothing, ...p.mood, ...(p.sensitive as string[])].map(
        (t) => t.toLowerCase(),
      ),
    ),
  ].slice(0, 15);
  return aiDescriptionV1Schema.parse({
    caption,
    detailed_description: detailed,
    subjects: [
      { who: "baby", relation_hint: null, is_target_baby: true },
      ...p.people.map(() => ({ who: "adult", relation_hint: null, is_target_baby: false })),
    ],
    baby_present: true,
    baby_state: {
      pose: p.activity.includes("sleep") || p.activity === "napping" ? "lying" : "sitting",
      expression: p.mood.includes("sleepy") ? "sleeping" : "smiling",
      activity: p.activity,
    },
    setting: {
      indoor_outdoor: p.place.outdoor ? "outdoor" : "indoor",
      place_type: p.place.type,
      weather: p.weather,
      time_of_day: null,
    },
    objects: p.objects,
    clothing: p.clothing,
    activities: [p.activity],
    possible_milestones: [],
    occasion: null,
    mood: p.mood,
    colors: [],
    text_in_image: null,
    photo_quality: { blurry: false, is_screenshot: false, is_duplicate_like: false },
    sensitive_content: p.sensitive,
    search_tags: tags.length ? tags : ["baby"],
  });
}

export interface SeedMeasurement {
  index: number;
  kind: MeasurementKind;
  ageDays: number;
  /** Grams or millimetres. */
  valueMetric: number;
  /** Photo index the measurement is linked to (golden 30 and 31), else null. */
  photoIndex: number | null;
  measuredAt: Date;
}

/** 60 measurements: 30 weights, 20 heights, 10 head circumferences over 0..560 days. */
export function searchSeedMeasurements(): SeedMeasurement[] {
  const out: SeedMeasurement[] = [];
  const add = (kind: MeasurementKind, ageDays: number, value: number, photoIndex: number | null) =>
    out.push({
      index: out.length,
      kind,
      ageDays,
      valueMetric: Math.round(value * 1000) / 1000,
      photoIndex,
      measuredAt: dateOf(ageDays, 10),
    });
  for (let k = 0; k < 30; k++) {
    const age = k === 9 ? 183 : Math.round((k * SEARCH_SEED_MAX_AGE_DAYS) / 29);
    add("weight", age, 3300 + 22 * age - 0.012 * age * age, k === 9 ? 30 : null);
  }
  for (let k = 0; k < 20; k++) {
    const age = k === 13 ? 365 : Math.round((k * SEARCH_SEED_MAX_AGE_DAYS) / 19);
    add("height", age, 500 + 0.75 * age - 0.0004 * age * age, k === 13 ? 31 : null);
  }
  for (let k = 0; k < 10; k++) {
    const age = Math.round((k * SEARCH_SEED_MAX_AGE_DAYS) / 9);
    add("head", age, 345 + 0.2 * age - 0.0001 * age * age, null);
  }
  return out;
}

/** Preset id of a milestone name used by the seed. */
export function seedMilestoneId(name: string): string {
  return milestoneId(name);
}

/**
 * Distractors that reproduce a golden target's planted signature, reserved person or reserved
 * milestone (must be empty).
 */
export function goldenCollisions(photos: readonly SeedPhoto[]): number[] {
  const sigs = new Set(GOLDEN_SIGNATURES);
  const bad: number[] = [];
  for (const p of photos) {
    if (p.golden) continue;
    const words = [
      p.activity,
      ...p.objects,
      ...p.clothing,
      ...p.mood,
      p.note ?? "",
      p.place.type,
      p.place.label ?? "",
    ].join(" ");
    if (
      [...sigs].some((s) => new RegExp(`\\b${s}\\b`, "i").test(words)) ||
      p.people.some((x) => RESERVED_PEOPLE.includes(x)) ||
      (p.milestone !== null && RESERVED_MILESTONES.includes(p.milestone))
    ) {
      bad.push(p.index);
    }
  }
  return bad;
}
