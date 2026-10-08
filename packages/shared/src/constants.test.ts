import { describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_MILESTONES_PER_BABY,
  PERF_IDS,
  PERF_MEASUREMENT_COUNT,
  PERF_PHOTO_COUNT,
  TIMELINE_PAGE_SIZE,
} from "./constants";

describe("PERF_IDS", () => {
  it("photo ids span 0..9999, zero-padded, unique and valid uuids", () => {
    expect(PERF_IDS.photo(0)).toBe("00000000-0000-4000-8000-010000000000");
    expect(PERF_IDS.photo(9999)).toBe("00000000-0000-4000-8000-010000009999");
    const seen = new Set<string>();
    for (let i = 0; i < PERF_PHOTO_COUNT; i++) seen.add(PERF_IDS.photo(i));
    expect(seen.size).toBe(PERF_PHOTO_COUNT);
    for (const id of [PERF_IDS.photo(0), PERF_IDS.photo(1234)])
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each([-1, 10_000, 1.5, Number.NaN])("photo(%s) throws RangeError", (i) => {
    expect(() => PERF_IDS.photo(i)).toThrow(RangeError);
  });

  it("measurement ids span 920..964 and never collide with the fixed ids", () => {
    expect(PERF_IDS.measurement(0)).toBe("00000000-0000-4000-8000-000000000920");
    expect(PERF_IDS.measurement(PERF_MEASUREMENT_COUNT - 1)).toBe(
      "00000000-0000-4000-8000-000000000964",
    );
    expect(() => PERF_IDS.measurement(45)).toThrow(RangeError);
    expect(() => PERF_IDS.measurement(-1)).toThrow(RangeError);
    const fixed = new Set<string>([PERF_IDS.baby, ...PERF_IDS.milestones]);
    for (let i = 0; i < PERF_MEASUREMENT_COUNT; i++) {
      const id = PERF_IDS.measurement(i);
      expect(fixed.has(id)).toBe(false);
      fixed.add(id);
    }
    expect(fixed.size).toBe(1 + 3 + PERF_MEASUREMENT_COUNT);
  });

  it("limits", () => {
    expect(TIMELINE_PAGE_SIZE).toBe(200);
    expect(MAX_CUSTOM_MILESTONES_PER_BABY).toBe(200);
  });
});
