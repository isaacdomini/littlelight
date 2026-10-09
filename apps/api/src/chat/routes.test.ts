import { describe, expect, it } from "vitest";
import { secondsToNextUtcMonth } from "./routes";

describe("secondsToNextUtcMonth", () => {
  it("counts to the first instant of the next UTC month", () => {
    expect(secondsToNextUtcMonth(new Date("2026-10-31T23:59:00Z"))).toBe(60);
    expect(secondsToNextUtcMonth(new Date("2026-10-01T00:00:00Z"))).toBe(31 * 86400);
    expect(secondsToNextUtcMonth(new Date("2026-02-15T12:00:00Z"))).toBe(
      Math.ceil((Date.UTC(2026, 2, 1) - Date.UTC(2026, 1, 15, 12)) / 1000),
    );
  });

  it("rolls over the year", () => {
    expect(secondsToNextUtcMonth(new Date("2026-12-31T23:00:00Z"))).toBe(3600);
  });

  it("is at least 1 second, also at the exact boundary and with fractional seconds", () => {
    expect(secondsToNextUtcMonth(new Date("2026-11-01T00:00:00.000Z"))).toBe(30 * 86400);
    expect(secondsToNextUtcMonth(new Date("2026-10-31T23:59:59.500Z"))).toBe(1);
  });

  it("is a whole number", () => {
    expect(Number.isInteger(secondsToNextUtcMonth(new Date()))).toBe(true);
  });
});
