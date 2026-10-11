import { createHash } from "node:crypto";
import {
  AGE_MONTH_DAYS,
  DEMO_IDS,
  G_PER_LB,
  type MeasurementKind,
  type MeasurementUnit,
  MILESTONE_PRESETS,
  MM_PER_IN,
  PERF_IDS,
  PERF_MEASUREMENT_COUNT,
  PERF_PHOTO_COUNT,
  roundTo,
  toMetric,
} from "@tinyglow/shared";

// Deterministic content of the dev-only performance seed (docs/plans/step-5.md 2.8). Pure: no
// I/O, no clock, no Math.random. Every value is a function of the photo/measurement index, so
// every run (and every machine) produces identical rows. Nothing here is real: names are a fixed
// pool, notes are lorem-like, there is no GPS and no home location.

/**
 * Dedicated owner of "Pixel" (step 11, migration 21): its creator and only parent, so Pixel is a
 * family of its own and the 10,000 photos fill that family's free pool, never the demo family's
 * (demo-mom and demo-dad are guests of Pixel). A GoTrue user that never signs in
 * (no password, no sessions); it exists only while the perf seed is present and `--remove`
 * deletes it. Ids sit in the perf range next to `PERF_IDS.baby` (…900); `@tinyglow/shared`'s
 * `PERF_IDS` does not list them.
 */
export const PERF_OWNER = {
  userId: "00000000-0000-4000-8000-000000000901",
  identityId: "00000000-0000-4000-8000-000000000902",
  email: "perf-owner@tinyglow.local",
  displayName: "Perf owner",
} as const;

/** "Pixel" was born on this date (local calendar date). */
export const PERF_BIRTH_DATE = "2024-10-01";
export const PERF_BABY_NAME = "Pixel";
export const PERF_BABY_NICKNAME = "Pix";
/** Every photo's EXIF offset: UTC-07:00 (`photo_exif.tz_offset_minutes`). */
export const PERF_TZ_OFFSET_MINUTES = -420;
/** Ages are uniform over `0 .. PERF_AGE_DAYS_END - 1` (0–24 months, never the `y2` group). */
export const PERF_AGE_DAYS_END = 730;
/** One base image per month of age: month index `floor(ageDays / 30.4375)`, 0..23. */
export const PERF_MONTHS = 24;
/** Months whose base image (and therefore whose photos) are landscape: 7 of 24 ≈ 30 %. */
export const PERF_LANDSCAPE_MONTHS: ReadonlySet<number> = new Set([1, 4, 7, 10, 13, 16, 19]);
/** Photos whose `created_at` is weeks after `taken_at` (index % 200 === 7: exactly 50). */
export const PERF_DELAYED_UPLOAD_COUNT = 50;
export const PERF_LOCATION_LABEL = "Riverside Park";
/** Fixed pool for `photo_details.people` (fictional). */
export const PERF_PEOPLE_POOL = [
  "Grandma Rose",
  "Grandpa Joe",
  "Aunt Lily",
  "Uncle Sam",
  "Cousin Ava",
  "Nanny Nadia",
  "Mom",
  "Dad",
] as const;
export const PERF_PEOPLE_PHOTOS = 300;
export const PERF_NOTE_PHOTOS = 150;
export const PERF_LOCATION_PHOTOS = 80;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const [BIRTH_Y, BIRTH_M, BIRTH_D] = PERF_BIRTH_DATE.split("-").map(Number) as [
  number,
  number,
  number,
];

/** mulberry32: small, fast, deterministic PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Independent streams per purpose so adding a draw in one never shifts another. */
function rng(index: number, stream: number): () => number {
  return mulberry32(Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(stream + 1, 0x85ebca77));
}

function intIn(r: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(r() * (maxInclusive - min + 1));
}

/** Month-of-age index of an age in days (0..23 for the seed's ages). */
export function perfMonthIndex(ageDays: number): number {
  return Math.floor(ageDays / AGE_MONTH_DAYS);
}

/** UTC instant of a local wall time `ageDays` after birth in the seed's fixed UTC-07:00 zone. */
export function perfLocalTime(ageDays: number, hour: number, minute = 0, second = 0): Date {
  const localAsUtc = Date.UTC(BIRTH_Y, BIRTH_M - 1, BIRTH_D + ageDays, hour, minute, second);
  return new Date(localAsUtc - PERF_TZ_OFFSET_MINUTES * 60_000);
}

export type PerfUploader = "mom" | "dad";

export interface PerfPhoto {
  index: number;
  id: string;
  ageDays: number;
  /** Month index → base image (`perfMonthIndex(ageDays)`). */
  month: number;
  landscape: boolean;
  width: number;
  height: number;
  bytes: number;
  takenAt: Date;
  createdAt: Date;
  uploader: PerfUploader;
  uploaderId: string;
  sha256: Buffer;
  cameraMake: string;
  cameraModel: string;
}

const CAMERAS: Record<PerfUploader, { make: string; model: string }> = {
  mom: { make: "Apple", model: "iPhone 16" },
  dad: { make: "Google", model: "Pixel 9" },
};

export function isDelayedUpload(index: number): boolean {
  return index % 200 === 7;
}

/** Photo `index` (0..9999). */
export function perfPhoto(index: number): PerfPhoto {
  const id = PERF_IDS.photo(index); // validates the range
  const r = rng(index, 1);
  const delayed = isDelayedUpload(index);
  // Delayed uploads stay within the first ~21 months so `created_at` (weeks later) is still in
  // the past on any machine whose clock is after the seed's 24-month window.
  const ageDays = Math.floor(r() * (delayed ? 650 : PERF_AGE_DAYS_END));
  const takenAt = perfLocalTime(ageDays, intIn(r, 7, 20), intIn(r, 0, 59), intIn(r, 0, 59));
  const createdAt = new Date(
    takenAt.getTime() +
      (delayed
        ? intIn(r, 14, 56) * DAY_MS + intIn(r, 0, 23) * HOUR_MS
        : intIn(r, 300, 172_800) * 1000),
  );
  const month = perfMonthIndex(ageDays);
  const landscape = PERF_LANDSCAPE_MONTHS.has(month);
  const uploader: PerfUploader = index % 2 === 0 ? "mom" : "dad";
  return {
    index,
    id,
    ageDays,
    month,
    landscape,
    width: landscape ? 4032 : 3024,
    height: landscape ? 3024 : 4032,
    bytes: intIn(r, 1_800_000, 3_400_000),
    takenAt,
    createdAt,
    uploader,
    uploaderId: DEMO_IDS.users[uploader],
    sha256: createHash("sha256").update(`perf-photo-${index}`, "utf8").digest(),
    cameraMake: CAMERAS[uploader].make,
    cameraModel: CAMERAS[uploader].model,
  };
}

/** All 10,000 photos in index order. */
export function perfPhotos(): PerfPhoto[] {
  return Array.from({ length: PERF_PHOTO_COUNT }, (_, i) => perfPhoto(i));
}

// --- Milestones ----------------------------------------------------------------------------------

export interface PerfCustomMilestone {
  id: string;
  name: string;
  category: "custom";
  sortOrder: number;
}

export const PERF_CUSTOM_MILESTONES: readonly PerfCustomMilestone[] = [
  { id: PERF_IDS.milestones[0], name: "First swim", category: "custom", sortOrder: 1000 },
  { id: PERF_IDS.milestones[1], name: "First snow", category: "custom", sortOrder: 1010 },
  { id: PERF_IDS.milestones[2], name: "Met Grandpa Joe", category: "custom", sortOrder: 1020 },
];

function presetId(name: string): string {
  const p = MILESTONE_PRESETS.find((m) => m.name === name);
  if (!p) throw new Error(`unknown milestone preset: ${name}`);
  return p.id;
}

/**
 * Target ages (days) per milestone: every preset once at a plausible age, 2 extra photos for 4
 * presets, and the 3 custom milestones on 3/2/1 photos (26 photos). Optional fixed people.
 */
export const PERF_MILESTONE_TARGETS: ReadonlyArray<{
  milestoneId: string;
  ages: readonly number[];
  people?: readonly string[];
}> = [
  { milestoneId: presetId("First smile"), ages: [45, 47, 52] },
  { milestoneId: presetId("First laugh"), ages: [110] },
  { milestoneId: presetId("Rolled over"), ages: [130] },
  { milestoneId: presetId("Sat up"), ages: [185] },
  { milestoneId: presetId("First food"), ages: [180, 181, 183] },
  { milestoneId: presetId("First tooth"), ages: [210] },
  { milestoneId: presetId("Crawled"), ages: [255] },
  { milestoneId: presetId("First steps"), ages: [372, 373, 380] },
  { milestoneId: presetId("First word"), ages: [330] },
  { milestoneId: presetId("First haircut"), ages: [420] },
  { milestoneId: presetId("First birthday"), ages: [365, 365, 365] },
  { milestoneId: presetId("First time with [person]"), ages: [60], people: ["Aunt Lily"] },
  { milestoneId: PERF_IDS.milestones[0], ages: [400, 401, 402] },
  { milestoneId: PERF_IDS.milestones[1], ages: [445, 446] },
  { milestoneId: PERF_IDS.milestones[2], ages: [20], people: ["Grandpa Joe"] },
];

/** Photo closest in age to `target` that is not in `used` (ties: lower index). */
function closestPhoto(photos: readonly PerfPhoto[], target: number, used: Set<number>): PerfPhoto {
  let best: PerfPhoto | undefined;
  for (const p of photos) {
    if (used.has(p.index)) continue;
    if (!best || Math.abs(p.ageDays - target) < Math.abs(best.ageDays - target)) best = p;
  }
  if (!best) throw new Error("no photo left for a milestone");
  used.add(best.index);
  return best;
}

// --- Details --------------------------------------------------------------------------------------

export interface PerfDetails {
  photoId: string;
  milestoneId: string | null;
  people: string[];
  note: string | null;
  locationLabel: string | null;
}

/** Bijections of 0..9999 (multipliers coprime with 10,000) pick fixed-size, spread-out sets. */
function inSet(index: number, multiplier: number, size: number): boolean {
  return (index * multiplier) % PERF_PHOTO_COUNT < size;
}
export function hasPeople(index: number): boolean {
  return inSet(index, 7919, PERF_PEOPLE_PHOTOS);
}
export function hasNote(index: number): boolean {
  return inSet(index, 6007, PERF_NOTE_PHOTOS);
}
export function hasLocation(index: number): boolean {
  return inSet(index, 4001, PERF_LOCATION_PHOTOS);
}

const LOREM = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "magna",
] as const;

function peopleFor(index: number): string[] {
  const r = rng(index, 2);
  const n = intIn(r, 1, 3);
  const out: string[] = [];
  while (out.length < n) {
    const name = PERF_PEOPLE_POOL[intIn(r, 0, PERF_PEOPLE_POOL.length - 1)] as string;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function noteFor(index: number): string {
  const r = rng(index, 3);
  const words = Array.from(
    { length: intIn(r, 4, 14) },
    () => LOREM[intIn(r, 0, LOREM.length - 1)] as string,
  );
  const text = words.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * `photo_details` rows (one per photo that has any detail), in photo index order: milestone
 * photos (closest age to each target), 300 with people, 150 with a note, 80 with a location.
 */
export function perfDetails(photos: readonly PerfPhoto[]): PerfDetails[] {
  const milestoneOf = new Map<number, { milestoneId: string; people?: readonly string[] }>();
  const used = new Set<number>();
  for (const t of PERF_MILESTONE_TARGETS) {
    for (const age of t.ages) {
      const p = closestPhoto(photos, age, used);
      milestoneOf.set(p.index, { milestoneId: t.milestoneId, people: t.people });
    }
  }
  const out: PerfDetails[] = [];
  for (const p of photos) {
    const m = milestoneOf.get(p.index);
    const people = new Set<string>(m?.people ?? []);
    if (hasPeople(p.index)) for (const name of peopleFor(p.index)) people.add(name);
    const note = hasNote(p.index) ? noteFor(p.index) : null;
    const locationLabel = hasLocation(p.index) ? PERF_LOCATION_LABEL : null;
    if (!m && people.size === 0 && note === null && locationLabel === null) continue;
    out.push({
      photoId: p.id,
      milestoneId: m?.milestoneId ?? null,
      people: [...people],
      note,
      locationLabel,
    });
  }
  return out;
}

// --- Measurements ---------------------------------------------------------------------------------

export interface PerfMeasurement {
  id: string;
  kind: MeasurementKind;
  valueMetric: number;
  valueEntered: number;
  unitEntered: MeasurementUnit;
  measuredAt: Date;
  photoId: string | null;
}

/** Saturating growth curve from `start` (day 0) to `end` (day 729) with time constant `tau`. */
function curve(start: number, end: number, tau: number, day: number): number {
  const last = PERF_AGE_DAYS_END - 1;
  return start + ((end - start) * (1 - Math.exp(-day / tau))) / (1 - Math.exp(-last / tau));
}

const SERIES: ReadonlyArray<{
  kind: MeasurementKind;
  count: number;
  start: number;
  end: number;
  tau: number;
  metricUnit: MeasurementUnit;
  imperialUnit: MeasurementUnit;
  /** Points (by position in the series) linked to the photo closest in age. */
  linked: readonly number[];
}> = [
  // grams: 3.2 kg → 11.5 kg
  {
    kind: "weight",
    count: 25,
    start: 3200,
    end: 11_500,
    tau: 220,
    metricUnit: "kg",
    imperialUnit: "lb",
    linked: [0, 6, 12, 24],
  },
  // millimetres: 50 cm → 86 cm
  {
    kind: "height",
    count: 13,
    start: 500,
    end: 860,
    tau: 300,
    metricUnit: "cm",
    imperialUnit: "in",
    linked: [6],
  },
  // millimetres: 34 cm → 47 cm
  {
    kind: "head",
    count: 7,
    start: 340,
    end: 470,
    tau: 200,
    metricUnit: "cm",
    imperialUnit: "in",
    linked: [3],
  },
];

function entered(unit: MeasurementUnit, metric: number): number {
  switch (unit) {
    case "kg":
      return roundTo(metric / 1000, 2);
    case "lb":
      return roundTo(metric / G_PER_LB, 2);
    case "cm":
      return roundTo(metric / 10, 1);
    case "in":
      return roundTo(metric / MM_PER_IN, 1);
    default:
      throw new Error(`unexpected unit ${unit}`);
  }
}

/**
 * 45 measurements (25 weights, 13 heights, 7 head circumferences) spread over 0–24 months, units
 * alternating metric/imperial, `valueMetric` normalized from the entered value exactly like the
 * API (`toMetric`), 6 linked to the photo closest in age (then `measuredAt` is that photo's
 * `takenAt`).
 */
export function perfMeasurements(photos: readonly PerfPhoto[]): PerfMeasurement[] {
  const out: PerfMeasurement[] = [];
  const used = new Set<number>();
  for (const s of SERIES) {
    for (let k = 0; k < s.count; k++) {
      const i = out.length;
      const day = Math.round((k * (PERF_AGE_DAYS_END - 1)) / (s.count - 1));
      const r = rng(i, 4);
      const jitter = k === 0 || k === s.count - 1 ? 1 : 1 + (r() - 0.5) * 0.02;
      const metricTarget = curve(s.start, s.end, s.tau, day) * jitter;
      const unit = i % 2 === 0 ? s.metricUnit : s.imperialUnit;
      const valueEntered = entered(unit, metricTarget);
      const photo = s.linked.includes(k) ? closestPhoto(photos, day, used) : null;
      out.push({
        id: PERF_IDS.measurement(i),
        kind: s.kind,
        valueMetric: toMetric(s.kind, valueEntered, unit),
        valueEntered,
        unitEntered: unit,
        measuredAt: photo ? photo.takenAt : perfLocalTime(day, 10),
        photoId: photo?.id ?? null,
      });
    }
  }
  if (out.length !== PERF_MEASUREMENT_COUNT) {
    throw new Error(`expected ${PERF_MEASUREMENT_COUNT} measurements, built ${out.length}`);
  }
  return out;
}
