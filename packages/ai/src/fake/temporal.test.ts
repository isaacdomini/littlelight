import { describe, expect, it } from "vitest";
import { ageRangeToDates, resolveTemporal, type TemporalContext } from "./temporal";

const CTX: TemporalContext = { today: "2026-10-09", birthDate: "2025-07-01" };
const R = (
  dateFrom: string | null,
  dateTo: string | null,
  ageFromDays = null as number | null,
  ageToDays = null as number | null,
) => ({
  dateFrom,
  dateTo,
  ageFromDays,
  ageToDays,
});

describe("resolveTemporal: seasons", () => {
  it("'last summer' is the most recent Jun 1 - Aug 31 that has ended", () => {
    expect(resolveTemporal("pictures from last summer", CTX).ranges).toEqual([
      R("2026-06-01", "2026-08-31"),
    ]);
    // before the end of this year's summer: the previous one
    expect(resolveTemporal("last summer", { today: "2026-07-10", birthDate: null }).ranges).toEqual(
      [R("2025-06-01", "2025-08-31")],
    );
    // the day after it ended
    expect(resolveTemporal("last summer", { today: "2026-09-01", birthDate: null }).ranges).toEqual(
      [R("2026-06-01", "2026-08-31")],
    );
    // on its last day it has not ended yet
    expect(resolveTemporal("last summer", { today: "2026-08-31", birthDate: null }).ranges).toEqual(
      [R("2025-06-01", "2025-08-31")],
    );
  });

  it("'this summer', explicit years and other seasons", () => {
    expect(resolveTemporal("this summer", CTX).ranges).toEqual([R("2026-06-01", "2026-08-31")]);
    expect(resolveTemporal("the summer of 2025", CTX).ranges).toEqual([
      R("2025-06-01", "2025-08-31"),
    ]);
    expect(resolveTemporal("spring 2025", CTX).ranges).toEqual([R("2025-03-01", "2025-05-31")]);
    expect(resolveTemporal("fall 2025", CTX).ranges).toEqual([R("2025-09-01", "2025-11-30")]);
    expect(resolveTemporal("winter 2025", CTX).ranges).toEqual([R("2025-12-01", "2026-02-28")]);
    expect(resolveTemporal("last winter", CTX).ranges).toEqual([R("2025-12-01", "2026-02-28")]);
  });
});

describe("resolveTemporal: age periods", () => {
  it("'month N' matches the timeline's Month N group", () => {
    expect(resolveTemporal("month 1", CTX).ranges).toEqual([R(null, null, 0, 30)]);
    expect(resolveTemporal("What happened in month 3?", CTX).ranges).toEqual([
      R(null, null, 61, 91),
    ]);
    expect(resolveTemporal("month 12", CTX).ranges).toEqual([R(null, null, 335, 365)]);
    expect(resolveTemporal("month three", CTX).ranges).toEqual([R(null, null, 61, 91)]);
  });

  it("month 0 is not an age period", () => {
    expect(resolveTemporal("month 0", CTX).ranges).toEqual([]);
  });

  it("weeks, first week/month/year and newborn", () => {
    expect(resolveTemporal("week 2", CTX).ranges).toEqual([R(null, null, 7, 13)]);
    expect(resolveTemporal("her first week", CTX).ranges).toEqual([R(null, null, 0, 6)]);
    expect(resolveTemporal("first month", CTX).ranges).toEqual([R(null, null, 0, 30)]);
    expect(resolveTemporal("the first year", CTX).ranges).toEqual([R(null, null, 0, 364)]);
    expect(resolveTemporal("as a newborn", CTX).ranges).toEqual([R(null, null, 0, 28)]);
  });

  it("ages with a tolerance around the centre", () => {
    expect(resolveTemporal("at 6 months", CTX).ranges).toEqual([R(null, null, 163, 203)]);
    expect(resolveTemporal("when she was 6 months old", CTX).ranges).toEqual([
      R(null, null, 163, 203),
    ]);
    expect(resolveTemporal("a 6-month-old", CTX).ranges).toEqual([R(null, null, 163, 203)]);
    expect(resolveTemporal("at three weeks", CTX).ranges).toEqual([R(null, null, 18, 24)]);
    expect(resolveTemporal("aged 2 years", CTX).ranges).toEqual([R(null, null, 700, 760)]);
  });

  it("a comparison yields one range per age, in order", () => {
    expect(resolveTemporal("show her at 1, 6 and 12 months", CTX).ranges).toEqual([
      R(null, null, 10, 50),
      R(null, null, 163, 203),
      R(null, null, 345, 385),
    ]);
  });
});

describe("resolveTemporal: calendar phrases and bounds", () => {
  it("relative days, weeks, months and years", () => {
    expect(resolveTemporal("yesterday", CTX).ranges).toEqual([R("2026-10-08", "2026-10-08")]);
    expect(resolveTemporal("today", CTX).ranges).toEqual([R("2026-10-09", "2026-10-09")]);
    expect(resolveTemporal("last week", CTX).ranges).toEqual([R("2026-10-02", "2026-10-08")]);
    expect(resolveTemporal("this month", CTX).ranges).toEqual([R("2026-10-01", "2026-10-31")]);
    expect(resolveTemporal("last month", CTX).ranges).toEqual([R("2026-09-01", "2026-09-30")]);
    expect(resolveTemporal("last year", CTX).ranges).toEqual([R("2025-01-01", "2025-12-31")]);
    expect(resolveTemporal("this year", CTX).ranges).toEqual([R("2026-01-01", "2026-12-31")]);
    expect(resolveTemporal("in 2025", CTX).ranges).toEqual([R("2025-01-01", "2025-12-31")]);
  });

  it("'last month' in January is December of the previous year", () => {
    expect(resolveTemporal("last month", { today: "2026-01-15", birthDate: null }).ranges).toEqual([
      R("2025-12-01", "2025-12-31"),
    ]);
  });

  it("a month without a year is its most recent occurrence not after today", () => {
    expect(resolveTemporal("in July", CTX).ranges).toEqual([R("2026-07-01", "2026-07-31")]);
    expect(resolveTemporal("in December", CTX).ranges).toEqual([R("2025-12-01", "2025-12-31")]);
    expect(resolveTemporal("July 2025", CTX).ranges).toEqual([R("2025-07-01", "2025-07-31")]);
    expect(resolveTemporal("in February 2024", CTX).ranges).toEqual([
      R("2024-02-01", "2024-02-29"),
    ]);
  });

  it("'may' as an ordinary word is not a month", () => {
    const r = resolveTemporal("she may like it", CTX);
    expect(r.ranges).toEqual([]);
    expect(r.rest).toBe("she may like it");
    expect(resolveTemporal("in May", CTX).ranges).toEqual([R("2026-05-01", "2026-05-31")]);
  });

  it("before / after / since / until", () => {
    expect(resolveTemporal("before 2026-02-01", CTX).ranges).toEqual([R(null, "2026-01-31")]);
    expect(resolveTemporal("after March", CTX).ranges).toEqual([R("2026-04-01", null)]);
    expect(resolveTemporal("since June 2026", CTX).ranges).toEqual([R("2026-06-01", null)]);
    expect(resolveTemporal("until 2026-03-05", CTX).ranges).toEqual([R(null, "2026-03-05")]);
  });

  it("phrases intersect", () => {
    expect(resolveTemporal("in July 2026 at 12 months", CTX).ranges).toEqual([
      R("2026-07-01", "2026-07-31", 345, 385),
    ]);
  });

  it("matched phrases are removed from rest, other words stay", () => {
    expect(resolveTemporal("beach photos from last summer", CTX).rest).toBe("beach photos from");
    expect(resolveTemporal("duck bath", CTX)).toEqual({ ranges: [], rest: "duck bath" });
  });

  it("is case-insensitive", () => {
    expect(resolveTemporal("LAST SUMMER", CTX).ranges).toHaveLength(1);
    expect(resolveTemporal("Month 3", CTX).ranges).toEqual([R(null, null, 61, 91)]);
  });
});

describe("ageRangeToDates", () => {
  it("converts ages to dates with the birth date and intersects with existing dates", () => {
    expect(ageRangeToDates(R(null, null, 163, 203), "2025-07-01")).toEqual({
      dateFrom: "2025-12-11",
      dateTo: "2026-01-20",
    });
    expect(ageRangeToDates(R("2026-01-01", null, 163, 203), "2025-07-01")).toEqual({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-20",
    });
  });

  it("without a birth date, ages are ignored", () => {
    expect(ageRangeToDates(R("2026-01-01", null, 10, 20), null)).toEqual({
      dateFrom: "2026-01-01",
      dateTo: null,
    });
  });
});
