import { describe, expect, it } from "vitest";
import { buildVisionContext, captureTime, type PendingRow } from "./context";

const row = (over: Partial<PendingRow> = {}): PendingRow => ({
  photo_id: "p",
  baby_id: "b",
  attempt: 1,
  storage_key: "k",
  age_days: null,
  taken_at: null,
  taken_at_estimated: null,
  exif_taken_at: null,
  tz_offset_minutes: null,
  place_label: null,
  people: null,
  note: null,
  location_label: null,
  milestone_name: null,
  ...over,
});

describe("captureTime", () => {
  it("EXIF time with a known offset gives the local wall-clock date-time", () => {
    // 15:42Z at UTC-5 is 10:42 local
    expect(
      captureTime(
        row({ exif_taken_at: new Date("2026-06-14T15:42:00Z"), tz_offset_minutes: -300 }),
      ),
    ).toBe("2026-06-14T10:42:00");
    expect(
      captureTime(row({ exif_taken_at: new Date("2026-06-14T23:30:00Z"), tz_offset_minutes: 120 })),
    ).toBe("2026-06-15T01:30:00");
    expect(
      captureTime(row({ exif_taken_at: new Date("2026-06-14T10:00:00Z"), tz_offset_minutes: 0 })),
    ).toBe("2026-06-14T10:00:00");
  });

  it("EXIF time without an offset gives the date only (no invented hour)", () => {
    expect(captureTime(row({ exif_taken_at: new Date("2026-06-14T15:42:00Z") }))).toBe(
      "2026-06-14",
    );
  });

  it("a non-estimated photos.taken_at gives the date only; an estimated one gives nothing", () => {
    expect(
      captureTime(row({ taken_at: new Date("2026-06-14T15:42:00Z"), taken_at_estimated: false })),
    ).toBe("2026-06-14");
    expect(
      captureTime(row({ taken_at: new Date("2026-06-14T15:42:00Z"), taken_at_estimated: true })),
    ).toBeNull();
    expect(captureTime(row({ taken_at: new Date("2026-06-14T15:42:00Z") }))).toBeNull();
  });

  it("EXIF wins over photos.taken_at; invalid dates are ignored", () => {
    expect(
      captureTime(
        row({
          exif_taken_at: new Date("2026-01-01T00:00:00Z"),
          taken_at: new Date("2026-06-14T00:00:00Z"),
          taken_at_estimated: false,
        }),
      ),
    ).toBe("2026-01-01");
    expect(
      captureTime(
        row({
          exif_taken_at: new Date("nope"),
          taken_at: new Date("nope"),
          taken_at_estimated: false,
        }),
      ),
    ).toBeNull();
    expect(
      captureTime(
        row({ exif_taken_at: new Date("2026-06-14T15:00:00Z"), tz_offset_minutes: Number.NaN }),
      ),
    ).toBe("2026-06-14");
  });
});

describe("buildVisionContext", () => {
  it("is empty for a row with nothing", () => {
    expect(buildVisionContext(row())).toEqual({
      babyAgeDays: null,
      takenAt: null,
      placeLabel: null,
      people: [],
      milestone: null,
      parentNotes: null,
    });
  });

  it("maps age, people, milestone and notes (trimmed); the parents' location label beats the EXIF place", () => {
    const ctx = buildVisionContext(
      row({
        age_days: 120,
        people: ["Grandma", "  ", "Sam"],
        milestone_name: " First steps ",
        note: "  so proud  ",
        place_label: "Seattle",
        location_label: "  Grandma's house ",
      }),
    );
    expect(ctx).toMatchObject({
      babyAgeDays: 120,
      people: ["Grandma", "Sam"],
      milestone: "First steps",
      parentNotes: "so proud",
      placeLabel: "Grandma's house",
    });
    expect(
      buildVisionContext(row({ place_label: "Seattle", location_label: "  " })).placeLabel,
    ).toBe("Seattle");
  });

  it("has no coordinate, gps or baby-name key at all", () => {
    expect(Object.keys(buildVisionContext(row({ note: "x" }))).sort()).toEqual([
      "babyAgeDays",
      "milestone",
      "parentNotes",
      "people",
      "placeLabel",
      "takenAt",
    ]);
  });

  it("non-finite ages and non-array people are tolerated", () => {
    expect(buildVisionContext(row({ age_days: Number.NaN })).babyAgeDays).toBeNull();
    expect(buildVisionContext(row({ people: "Grandma" as never })).people).toEqual([]);
  });
});
