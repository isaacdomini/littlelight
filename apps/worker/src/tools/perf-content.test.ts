import {
  ageDays,
  ageGroupKey,
  DEMO_IDS,
  MEASUREMENT_LIMITS,
  MILESTONE_PRESETS,
  PERF_IDS,
  PERF_MEASUREMENT_COUNT,
  PERF_PHOTO_COUNT,
  PHOTO_DETAILS_LIMITS,
  toMetric,
} from "@littlelight/shared";
import { describe, expect, it } from "vitest";
import {
  hasLocation,
  hasNote,
  hasPeople,
  isDelayedUpload,
  PERF_BIRTH_DATE,
  PERF_CUSTOM_MILESTONES,
  PERF_LOCATION_PHOTOS,
  PERF_NOTE_PHOTOS,
  PERF_PEOPLE_PHOTOS,
  PERF_TZ_OFFSET_MINUTES,
  perfDetails,
  perfMeasurements,
  perfPhoto,
  perfPhotos,
} from "./perf-content";

const photos = perfPhotos();

describe("perf photos", () => {
  it("are deterministic for a fixed index and differ between indexes", () => {
    expect(perfPhoto(1234)).toEqual(perfPhoto(1234));
    expect(perfPhoto(1234)).not.toEqual(perfPhoto(1235));
    expect(perfPhotos()[77]).toEqual(photos[77]);
  });

  it("10,000 of them with unique ids, hashes and the fixed id scheme", () => {
    expect(photos).toHaveLength(PERF_PHOTO_COUNT);
    expect(new Set(photos.map((p) => p.id)).size).toBe(PERF_PHOTO_COUNT);
    expect(new Set(photos.map((p) => p.sha256.toString("hex"))).size).toBe(PERF_PHOTO_COUNT);
    expect(photos[0]?.id).toBe(PERF_IDS.photo(0));
    expect(photos[9999]?.id).toBe(PERF_IDS.photo(9999));
    expect(() => perfPhoto(10_000)).toThrow(RangeError);
  });

  it("ageDays equals the shared ageDays() of the baby's birth date and takenAt for every photo", () => {
    for (const p of photos) {
      expect(ageDays(PERF_BIRTH_DATE, p.takenAt, PERF_TZ_OFFSET_MINUTES), `photo ${p.index}`).toBe(
        p.ageDays,
      );
    }
  });

  it("spans every group w1..w12 and m3..m24 and stays under 730 days", () => {
    const keys = new Set(photos.map((p) => ageGroupKey(p.ageDays)));
    for (let w = 1; w <= 12; w++) expect(keys.has(`w${w}`), `w${w}`).toBe(true);
    for (let m = 3; m <= 24; m++) expect(keys.has(`m${m}`), `m${m}`).toBe(true);
    expect(keys.has("pre")).toBe(false);
    expect(keys.has("unknown")).toBe(false);
    expect(Math.max(...photos.map((p) => p.ageDays))).toBeLessThan(730);
    expect(Math.min(...photos.map((p) => p.ageDays))).toBeGreaterThanOrEqual(0);
  });

  it("uploaders alternate mom/dad with the demo ids; createdAt is never before takenAt", () => {
    for (const p of photos.slice(0, 200)) {
      expect(p.uploaderId).toBe(DEMO_IDS.users[p.uploader]);
      expect(p.uploader).toBe(p.index % 2 === 0 ? "mom" : "dad");
    }
    expect(photos.every((p) => p.createdAt.getTime() > p.takenAt.getTime())).toBe(true);
    expect(photos.filter((p) => isDelayedUpload(p.index))).toHaveLength(50);
  });

  it("sizes are portrait 3024x4032 or landscape 4032x3024", () => {
    for (const p of photos) {
      expect([p.width, p.height].sort()).toEqual([3024, 4032]);
      expect(p.landscape).toBe(p.width > p.height);
    }
  });
});

describe("perf details", () => {
  const details = perfDetails(photos);

  it("is deterministic and one row per photo with any detail", () => {
    expect(perfDetails(photos)).toEqual(details);
    expect(new Set(details.map((d) => d.photoId)).size).toBe(details.length);
  });

  it("counts: 300 with people, 150 notes, 80 locations (plus milestone extras)", () => {
    expect(photos.filter((p) => hasPeople(p.index))).toHaveLength(PERF_PEOPLE_PHOTOS);
    expect(photos.filter((p) => hasNote(p.index))).toHaveLength(PERF_NOTE_PHOTOS);
    expect(photos.filter((p) => hasLocation(p.index))).toHaveLength(PERF_LOCATION_PHOTOS);
    expect(details.filter((d) => d.note !== null)).toHaveLength(PERF_NOTE_PHOTOS);
    expect(details.filter((d) => d.locationLabel !== null)).toHaveLength(PERF_LOCATION_PHOTOS);
    expect(details.filter((d) => d.people.length > 0).length).toBeGreaterThanOrEqual(
      PERF_PEOPLE_PHOTOS,
    );
  });

  it("26 photos carry a milestone: every preset at least once and all three custom ones (3/2/1)", () => {
    const tagged = details.filter((d) => d.milestoneId);
    expect(tagged).toHaveLength(26);
    const ids = new Set(tagged.map((d) => d.milestoneId));
    for (const p of MILESTONE_PRESETS) expect(ids.has(p.id), p.name).toBe(true);
    const customCounts = PERF_CUSTOM_MILESTONES.map(
      (m) => tagged.filter((d) => d.milestoneId === m.id).length,
    );
    expect(customCounts).toEqual([3, 2, 1]);
    expect(PERF_CUSTOM_MILESTONES.map((m) => m.id)).toEqual([...PERF_IDS.milestones]);
  });

  it("every row respects the database limits (people <= 20, note <= 2000, label <= 120)", () => {
    for (const d of details) {
      expect(d.people.length).toBeLessThanOrEqual(PHOTO_DETAILS_LIMITS.people);
      expect(new Set(d.people.map((x) => x.toLowerCase())).size).toBe(d.people.length);
      for (const person of d.people)
        expect(person.length).toBeLessThanOrEqual(PHOTO_DETAILS_LIMITS.personName);
      expect((d.note ?? "").length).toBeLessThanOrEqual(PHOTO_DETAILS_LIMITS.note);
      expect((d.locationLabel ?? "").length).toBeLessThanOrEqual(
        PHOTO_DETAILS_LIMITS.locationLabel,
      );
    }
  });
});

describe("perf measurements", () => {
  const ms = perfMeasurements(photos);

  it("45 of them: 25 weights, 13 heights, 7 head circumferences, ids 920..964", () => {
    expect(ms).toHaveLength(PERF_MEASUREMENT_COUNT);
    expect(ms.filter((m) => m.kind === "weight")).toHaveLength(25);
    expect(ms.filter((m) => m.kind === "height")).toHaveLength(13);
    expect(ms.filter((m) => m.kind === "head")).toHaveLength(7);
    expect(ms.map((m) => m.id)).toEqual(
      Array.from({ length: 45 }, (_, i) => PERF_IDS.measurement(i)),
    );
  });

  it("valueMetric equals the API's toMetric(kind, entered, unit) and lies within the limits", () => {
    for (const m of ms) {
      expect(m.valueMetric, m.id).toBe(toMetric(m.kind, m.valueEntered, m.unitEntered));
      const { min, max } = MEASUREMENT_LIMITS[m.kind];
      expect(m.valueMetric).toBeGreaterThanOrEqual(min);
      expect(m.valueMetric).toBeLessThanOrEqual(max);
    }
  });

  it("units alternate metric / imperial and every unit fits its kind", () => {
    const units = new Set(ms.map((m) => `${m.kind}:${m.unitEntered}`));
    expect(units).toEqual(
      new Set(["weight:kg", "weight:lb", "height:cm", "height:in", "head:cm", "head:in"]),
    );
  });

  it("six are linked to a photo and then dated at that photo's takenAt; links are unique", () => {
    const linked = ms.filter((m) => m.photoId);
    expect(linked).toHaveLength(6);
    expect(new Set(linked.map((m) => m.photoId)).size).toBe(6);
    for (const m of linked) {
      const p = photos.find((x) => x.id === m.photoId);
      expect(m.measuredAt).toEqual(p?.takenAt);
    }
  });

  it("grow over time within a series (first below last) and are deterministic", () => {
    for (const kind of ["weight", "height", "head"] as const) {
      const s = ms.filter((m) => m.kind === kind);
      expect(s[0]?.valueMetric).toBeLessThan(s.at(-1)?.valueMetric as number);
    }
    expect(perfMeasurements(photos)).toEqual(ms);
  });
});
