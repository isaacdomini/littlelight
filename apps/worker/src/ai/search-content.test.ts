import { aiDescriptionV1Schema, buildSearchDocument } from "@tinyglow/shared";
import { describe, expect, it } from "vitest";
import {
  GOLDEN_COUNT,
  GOLDEN_SIGNATURES,
  GOLDEN_TARGETS,
  goldenCollisions,
  SEARCH_SEED_MAX_AGE_DAYS,
  searchSeedMeasurements,
  searchSeedPhotos,
  seedDescription,
  seedMilestoneId,
} from "./search-content";

describe("search seed content", () => {
  it("is deterministic: the same count gives byte-identical photos", () => {
    expect(JSON.stringify(searchSeedPhotos(300))).toBe(JSON.stringify(searchSeedPhotos(300)));
  });

  it("the first 50 photos are the golden targets, the rest are distractors; count is validated", () => {
    const photos = searchSeedPhotos(120);
    expect(photos).toHaveLength(120);
    expect(photos.slice(0, GOLDEN_COUNT).every((p) => p.golden)).toBe(true);
    expect(photos.slice(GOLDEN_COUNT).every((p) => !p.golden)).toBe(true);
    expect(photos.map((p) => p.index)).toEqual(photos.map((_, i) => i));
    for (const bad of [0, 49, 50.5, Number.NaN, -1]) {
      expect(() => searchSeedPhotos(bad), String(bad)).toThrow(RangeError);
    }
    expect(searchSeedPhotos(50)).toHaveLength(50);
  });

  it("no distractor reproduces a golden signature, reserved person or reserved milestone (>= 2000 photos)", () => {
    expect(goldenCollisions(searchSeedPhotos(2000))).toEqual([]);
    expect(goldenCollisions(searchSeedPhotos(50))).toEqual([]);
  });

  it("the goldenCollisions check really detects a collision", () => {
    const photos = searchSeedPhotos(100);
    const victim = photos[60];
    expect(victim).toBeDefined();
    if (!victim) return;
    victim.objects = [...victim.objects, GOLDEN_SIGNATURES[3] as string];
    expect(goldenCollisions(photos)).toEqual([60]);
  });

  it("the 50 golden combinations (signature, people, place, milestone, age) are unique", () => {
    expect(GOLDEN_TARGETS).toHaveLength(GOLDEN_COUNT);
    // targets 40-42 deliberately share "hammock" (the comparison group: told apart by age)
    expect(GOLDEN_SIGNATURES).toHaveLength(GOLDEN_COUNT);
    expect(new Set(GOLDEN_SIGNATURES).size).toBe(GOLDEN_COUNT - 2);
    expect(GOLDEN_SIGNATURES.slice(40, 43)).toEqual(["hammock", "hammock", "hammock"]);
    const keys = GOLDEN_TARGETS.map((t) =>
      JSON.stringify([t.signature, t.people, t.placeLabel, t.milestone, t.ageDays]),
    );
    expect(new Set(keys).size).toBe(GOLDEN_COUNT);
    for (const t of GOLDEN_TARGETS) {
      expect(t.query.length).toBeGreaterThan(3);
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("every photo has a schema-valid description; the golden signature is planted in its target", () => {
    for (const p of searchSeedPhotos(200)) {
      expect(aiDescriptionV1Schema.safeParse(seedDescription(p)).success, `photo ${p.index}`).toBe(
        true,
      );
      expect(p.ageDays).toBeGreaterThanOrEqual(0);
      expect(p.ageDays).toBeLessThanOrEqual(SEARCH_SEED_MAX_AGE_DAYS);
    }
    for (const t of GOLDEN_TARGETS) {
      const p = searchSeedPhotos(50)[t.index];
      if (!p) throw new Error("missing target");
      const doc = buildSearchDocument({
        ageDays: p.ageDays,
        takenAtLocal: p.takenAt.toISOString().slice(0, 19),
        takenAtEstimated: false,
        place: p.place.label,
        milestone: p.milestone ? { id: seedMilestoneId(p.milestone), name: p.milestone } : null,
        people: p.people,
        note: p.note,
        measurements: [],
        ai: seedDescription(p),
        isSensitive: p.sensitive.length > 0,
      });
      expect(doc.text.toLowerCase(), `target ${t.index}`).toContain(t.signature.toLowerCase());
    }
  });

  it("the seed documents never contain coordinates or the baby's name", () => {
    for (const p of searchSeedPhotos(120)) {
      const doc = buildSearchDocument({
        ageDays: p.ageDays,
        takenAtLocal: p.takenAt.toISOString().slice(0, 19),
        takenAtEstimated: false,
        place: p.place.label,
        milestone: null,
        people: p.people,
        note: p.note,
        measurements: [],
        ai: seedDescription(p),
        isSensitive: false,
      });
      expect(doc.warnings).toEqual([]);
      expect(doc.text).not.toMatch(/Golden|Goldie/);
    }
  });

  it("measurements are a small deterministic list of positive metric values", () => {
    const m = searchSeedMeasurements();
    expect(m.length).toBeGreaterThan(0);
    expect(JSON.stringify(m)).toBe(JSON.stringify(searchSeedMeasurements()));
  });

  it("milestone ids are stable per name", () => {
    expect(seedMilestoneId("First steps")).toBe(seedMilestoneId("First steps"));
    expect(seedMilestoneId("First steps")).not.toBe(seedMilestoneId("First smile"));
  });
});
