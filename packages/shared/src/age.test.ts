import { describe, expect, it } from "vitest";
import { ageDays, localCalendarDate } from "./age";

describe("localCalendarDate", () => {
  it("shifts the instant by the offset before taking the date", () => {
    expect(localCalendarDate(new Date("2026-06-14T23:30:00Z"), -420)).toBe("2026-06-14");
    expect(localCalendarDate(new Date("2026-06-14T23:30:00Z"), 120)).toBe("2026-06-15");
    expect(localCalendarDate(new Date("2026-06-14T01:30:00Z"), -420)).toBe("2026-06-13");
  });
  it("null offset means UTC", () => {
    expect(localCalendarDate(new Date("2026-06-14T23:59:59Z"), null)).toBe("2026-06-14");
    expect(localCalendarDate(new Date("2026-06-15T00:00:00Z"), null)).toBe("2026-06-15");
  });
  it.each([841, -841, 1.5, Number.NaN])("rejects offset %s", (o) => {
    expect(() => localCalendarDate(new Date(), o)).toThrow(RangeError);
  });
  it("rejects an invalid date", () => {
    expect(() => localCalendarDate(new Date("nope"), 0)).toThrow(RangeError);
  });
});

describe("ageDays", () => {
  it("the documented example: 349 days at UTC-07:00 near midnight", () => {
    expect(ageDays("2025-06-30", new Date("2026-06-14T23:30:00Z"), -420)).toBe(349);
  });

  it("an offset that crosses midnight changes the day count", () => {
    const t = new Date("2026-06-14T23:30:00Z");
    expect(ageDays("2025-06-30", t, -420)).toBe(349);
    expect(ageDays("2025-06-30", t, 0)).toBe(349);
    expect(ageDays("2025-06-30", t, 120)).toBe(350); // already June 15 locally
    expect(ageDays("2025-06-30", new Date("2026-06-15T03:00:00Z"), -420)).toBe(349); // still June 14
  });

  it("zero on the birth date, one the next day", () => {
    expect(ageDays("2026-01-15", new Date("2026-01-15T12:00:00Z"), 0)).toBe(0);
    expect(ageDays("2026-01-15", new Date("2026-01-16T12:00:00Z"), 0)).toBe(1);
  });

  it("negative before birth (bump photos, due-date babies)", () => {
    expect(ageDays("2026-01-15", new Date("2026-01-10T12:00:00Z"), 0)).toBe(-5);
  });

  it("is exact across leap days and year ends", () => {
    expect(ageDays("2024-02-28", new Date("2024-03-01T12:00:00Z"), 0)).toBe(2);
    expect(ageDays("2025-02-28", new Date("2025-03-01T12:00:00Z"), 0)).toBe(1);
    expect(ageDays("2025-12-31", new Date("2026-01-01T00:00:00Z"), 0)).toBe(1);
  });

  it("is not thrown off by DST because only calendar dates are compared", () => {
    expect(ageDays("2026-03-01", new Date("2026-03-09T12:00:00Z"), -420)).toBe(8);
  });

  it.each(["2026-02-30", "2026-13-01", "26-01-01", "2026/01/01", ""])(
    "rejects birth date %j",
    (d) => {
      expect(() => ageDays(d, new Date("2026-01-01T00:00:00Z"), 0)).toThrow(RangeError);
    },
  );
});
