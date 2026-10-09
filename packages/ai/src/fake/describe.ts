/**
 * Deterministic, schema-valid v1 descriptions for the fake provider and the mock servers.
 * Derived from `sha256(photoId)`: the same id always yields the same description. About 80 %
 * have `baby_present: true`; photo ids whose first hex nibble is `0` (~1/16) are flagged
 * `sensitive_content: ["bath"]` so the sensitive path is exercised.
 */

import { createHash } from "node:crypto";
import type { AiDescriptionV1 } from "@littlelight/shared";

const POSES = ["lying", "sitting", "crawling", "standing", "walking", "held"] as const;
const EXPRESSIONS = ["smiling", "neutral", "sleeping", "surprised", "crying"] as const;
const PLACES = [
  { place: "living room", io: "indoor" },
  { place: "bedroom", io: "indoor" },
  { place: "kitchen", io: "indoor" },
  { place: "park", io: "outdoor" },
  { place: "garden", io: "outdoor" },
  { place: "beach", io: "outdoor" },
] as const;
const OBJECTS = [
  "blanket",
  "toy",
  "teddy bear",
  "ball",
  "book",
  "high chair",
  "rattle",
  "stroller",
];
const ACTIVITIES = ["playing", "tummy time", "feeding", "reading", "napping", "exploring"];
const COLORS = ["yellow", "blue", "green", "red", "white", "pink"];
const MOODS = ["joyful", "calm", "curious", "sleepy"];
const CLOTHING = ["striped onesie", "sun hat", "knit sweater", "yellow sundress", "pajamas"];
const TIMES = ["morning", "afternoon", "evening"];

function pick<T>(list: readonly T[], byte: number | undefined): T {
  return list[(byte ?? 0) % list.length] as T;
}

/** A deterministic, `aiDescriptionV1Schema`-valid description for `photoId`. */
export function fakeDescription(photoId: string): AiDescriptionV1 {
  const h = createHash("sha256").update(photoId, "utf8").digest();
  const babyPresent = (h[0] ?? 0) % 10 < 8;
  const sensitive = photoId.toLowerCase().startsWith("0");
  const pose = babyPresent ? pick(POSES, h[1]) : "unknown";
  const expression = babyPresent ? pick(EXPRESSIONS, h[2]) : "unknown";
  const place = sensitive ? ({ place: "bathroom", io: "indoor" } as const) : pick(PLACES, h[3]);
  const object = sensitive ? "bathtub" : pick(OBJECTS, h[4]);
  const activity = sensitive ? "bath" : pick(ACTIVITIES, h[5]);
  const color = pick(COLORS, h[6]);
  const mood = pick(MOODS, h[7]);
  const clothing = sensitive ? [] : [pick(CLOTHING, h[8])];
  const time = pick(TIMES, h[9]);
  const milestone = babyPresent && (h[10] ?? 0) % 5 === 0;

  const subject = babyPresent
    ? `A baby ${pose === "held" ? "is held" : pose === "lying" ? "lies" : `is ${pose}`}`
    : "A quiet scene";
  const caption = `${subject} in the ${place.place}, near a ${color} ${object}.`;
  const tags = [
    ...(babyPresent ? ["baby"] : []),
    place.place,
    place.io,
    object,
    activity,
    color,
    mood,
    time,
    ...(sensitive ? ["bath", "bath time"] : []),
    ...(babyPresent && pose !== "unknown" ? [pose] : []),
    "family",
    "home album",
  ];

  return {
    caption,
    detailed_description: `${caption} The setting is ${place.io} during the ${time}. The mood is ${mood}.`,
    subjects: babyPresent ? [{ who: "baby", relation_hint: null, is_target_baby: true }] : [],
    baby_present: babyPresent,
    baby_state: { pose, expression, activity: babyPresent ? activity : null },
    setting: {
      indoor_outdoor: place.io,
      place_type: place.place,
      weather: null,
      time_of_day: time,
    },
    objects: [object],
    clothing,
    activities: [activity],
    possible_milestones: milestone ? [{ name: "sitting up", confidence: 0.4 }] : [],
    occasion: null,
    mood: [mood],
    colors: [color],
    text_in_image: null,
    photo_quality: { blurry: false, is_screenshot: false, is_duplicate_like: false },
    sensitive_content: sensitive ? ["bath"] : [],
    search_tags: [...new Set(tags)].slice(0, 15),
  };
}
