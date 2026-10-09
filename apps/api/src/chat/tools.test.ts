import { describe, expect, it } from "vitest";
import { AGE_WINDOW_MARGIN_DAYS, WINDOW_RETRY_MARGIN_DAYS, widenAges, widenDates } from "./tools";

describe("widenAges", () => {
  it("adds 15 days on each side when the search has free text", () => {
    expect(AGE_WINDOW_MARGIN_DAYS).toBe(15);
    expect(widenAges(163, 203, true)).toEqual({ from: 148, to: 218 });
    expect(widenAges(365, 365, true)).toEqual({ from: 350, to: 380 });
  });

  it("leaves the window alone for filter-only searches (every result must match it exactly)", () => {
    expect(widenAges(163, 203, false)).toEqual({ from: 163, to: 203 });
    expect(widenAges(0, 30, false)).toEqual({ from: 0, to: 30 });
  });

  it("widens only the bounds that are set", () => {
    expect(widenAges(100, null, true)).toEqual({ from: 85, to: null });
    expect(widenAges(null, 100, true)).toEqual({ from: null, to: 115 });
    expect(widenAges(null, null, true)).toEqual({ from: null, to: null });
  });

  it("never goes below the smallest age the API accepts (-300 days)", () => {
    expect(widenAges(-295, 0, true).from).toBe(-300);
    expect(widenAges(0, 5, true).from).toBe(-15);
  });
});

describe("widenAges with a custom margin", () => {
  it("the retry margin is 45 days", () => {
    expect(WINDOW_RETRY_MARGIN_DAYS).toBe(45);
    expect(widenAges(100, 120, true, WINDOW_RETRY_MARGIN_DAYS)).toEqual({ from: 55, to: 165 });
    expect(widenAges(100, 120, false, WINDOW_RETRY_MARGIN_DAYS)).toEqual({ from: 100, to: 120 });
  });
});

describe("widenDates", () => {
  it("adds 15 days on each side when the search has free text", () => {
    expect(widenDates("2026-06-10", "2026-06-20", true)).toEqual({
      from: "2026-05-26",
      to: "2026-07-05",
    });
  });

  it("filter-only searches keep the exact window", () => {
    expect(widenDates("2026-06-10", "2026-06-20", false)).toEqual({
      from: "2026-06-10",
      to: "2026-06-20",
    });
  });

  it("widens only the bounds that are set; no bounds, nothing to widen", () => {
    expect(widenDates("2026-06-10", null, true)).toEqual({ from: "2026-05-26", to: null });
    expect(widenDates(null, "2026-06-20", true)).toEqual({ from: null, to: "2026-07-05" });
    expect(widenDates(null, null, true)).toEqual({ from: null, to: null });
    expect(widenDates(null, null, false)).toEqual({ from: null, to: null });
  });

  it("crosses month, year and leap-day boundaries correctly", () => {
    expect(widenDates("2026-01-05", "2026-12-25", true)).toEqual({
      from: "2025-12-21",
      to: "2027-01-09",
    });
    expect(widenDates("2024-03-10", "2024-03-10", true)).toEqual({
      from: "2024-02-24",
      to: "2024-03-25",
    });
    expect(widenDates("2023-03-05", "2023-02-20", true)).toEqual({
      from: "2023-02-18",
      to: "2023-03-07",
    });
  });

  it("takes a custom margin (the 45 day retry)", () => {
    expect(widenDates("2026-06-10", "2026-06-20", true, WINDOW_RETRY_MARGIN_DAYS)).toEqual({
      from: "2026-04-26",
      to: "2026-08-04",
    });
  });
});
