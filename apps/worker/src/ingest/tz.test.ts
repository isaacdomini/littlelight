import { describe, expect, it } from "vitest";
import { isKnownTimeZone, wallTimeInZone, zoneOffsetMinutes } from "./tz";

const wall = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, s);

describe("zoneOffsetMinutes", () => {
  it("east positive, DST aware", () => {
    expect(zoneOffsetMinutes("UTC", wall(2026, 6, 14, 12))).toBe(0);
    expect(zoneOffsetMinutes("America/Los_Angeles", wall(2026, 7, 1, 12))).toBe(-420);
    expect(zoneOffsetMinutes("America/Los_Angeles", wall(2026, 1, 1, 12))).toBe(-480);
    expect(zoneOffsetMinutes("Asia/Kolkata", wall(2026, 6, 14, 12))).toBe(330);
    expect(zoneOffsetMinutes("Pacific/Chatham", wall(2026, 1, 1, 12))).toBe(825);
  });
});

describe("isKnownTimeZone", () => {
  it("accepts IANA names and rejects junk", () => {
    expect(isKnownTimeZone("Europe/Berlin")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    expect(isKnownTimeZone("Not/AZone")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
    expect(isKnownTimeZone("../../etc/passwd")).toBe(false);
  });
});

describe("wallTimeInZone", () => {
  it("a normal summer and winter wall time", () => {
    const summer = wallTimeInZone(wall(2026, 6, 14, 15, 4, 5), "America/Los_Angeles");
    expect(summer).toEqual({ utcMs: wall(2026, 6, 14, 22, 4, 5), offsetMinutes: -420 });
    const winter = wallTimeInZone(wall(2026, 1, 14, 15, 4, 5), "America/Los_Angeles");
    expect(winter).toEqual({ utcMs: wall(2026, 1, 14, 23, 4, 5), offsetMinutes: -480 });
  });

  it("a positive-offset zone", () => {
    expect(wallTimeInZone(wall(2026, 6, 14, 12), "Asia/Kolkata")).toEqual({
      utcMs: wall(2026, 6, 14, 6, 30),
      offsetMinutes: 330,
    });
  });

  it("crosses midnight correctly", () => {
    const r = wallTimeInZone(wall(2026, 6, 14, 1, 0), "Pacific/Auckland");
    expect(new Date(r.utcMs).toISOString()).toBe("2026-06-13T13:00:00.000Z");
  });

  it("DST gap (02:30 on 2026-03-08 in Los Angeles does not exist): resolves to a real instant after the jump", () => {
    const r = wallTimeInZone(wall(2026, 3, 8, 2, 30), "America/Los_Angeles");
    // A real instant in the zone: its offset must be the one reported.
    expect(zoneOffsetMinutes("America/Los_Angeles", r.utcMs)).toBe(r.offsetMinutes);
    // Later offset (PDT) wins: 02:30 interpreted with -07:00 = 09:30Z, which is 01:30 PST;
    // the implementation chooses the post-jump reading, 10:30Z = 03:30 PDT.
    expect(new Date(r.utcMs).toISOString()).toBe("2026-03-08T10:30:00.000Z");
    expect(r.offsetMinutes).toBe(-420);
  });

  it("DST overlap (01:30 on 2026-11-01 happens twice): the first occurrence (PDT) wins", () => {
    const r = wallTimeInZone(wall(2026, 11, 1, 1, 30), "America/Los_Angeles");
    expect(new Date(r.utcMs).toISOString()).toBe("2026-11-01T08:30:00.000Z");
    expect(r.offsetMinutes).toBe(-420);
  });

  it("the hour after an overlap and the hour before a gap are unambiguous", () => {
    expect(
      new Date(wallTimeInZone(wall(2026, 11, 1, 2, 30), "America/Los_Angeles").utcMs).toISOString(),
    ).toBe("2026-11-01T10:30:00.000Z");
    expect(
      new Date(wallTimeInZone(wall(2026, 3, 8, 1, 30), "America/Los_Angeles").utcMs).toISOString(),
    ).toBe("2026-03-08T09:30:00.000Z");
  });

  it("DST overlap east of UTC (Sydney 2026-04-05 02:30): the first occurrence (AEDT +11:00) wins", () => {
    const r = wallTimeInZone(wall(2026, 4, 5, 2, 30), "Australia/Sydney");
    expect(zoneOffsetMinutes("Australia/Sydney", r.utcMs)).toBe(r.offsetMinutes);
    expect(r.offsetMinutes).toBe(660);
  });

  it("DST overlap in Berlin (2026-10-25 02:30): the first occurrence (CEST +02:00) wins", () => {
    const r = wallTimeInZone(wall(2026, 10, 25, 2, 30), "Europe/Berlin");
    expect(zoneOffsetMinutes("Europe/Berlin", r.utcMs)).toBe(r.offsetMinutes);
    expect(r.offsetMinutes).toBe(120);
  });

  it("documents current behaviour in a DST gap (Berlin 2026-03-29 02:30 does not exist): earlier offset +60", () => {
    const r = wallTimeInZone(wall(2026, 3, 29, 2, 30), "Europe/Berlin");
    expect(r.offsetMinutes).toBe(60);
  });

  it("a half-hour DST zone (Lord Howe, 30-minute shift)", () => {
    const r = wallTimeInZone(wall(2026, 6, 14, 12), "Australia/Lord_Howe");
    expect(zoneOffsetMinutes("Australia/Lord_Howe", r.utcMs)).toBe(r.offsetMinutes);
    expect(r.offsetMinutes).toBe(630);
  });
});
