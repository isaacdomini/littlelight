import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PERF_LANDSCAPE_MONTHS, PERF_MONTHS } from "./perf-content";
import {
  PERF_DERIVATIVE_KINDS,
  perfBaseKey,
  perfBasePrefix,
  perfBaseSvg,
  perfMonthLabel,
  renderPerfBase,
} from "./perf-images";

const BABY = "00000000-0000-4000-8000-000000000900";

describe("perf image labels and keys", () => {
  it("weeks for the first three months, then M<n> matching the m<n> group key", () => {
    expect(perfMonthLabel(0)).toBe("W1-5");
    expect(perfMonthLabel(1)).toBe("W5-9");
    expect(perfMonthLabel(2)).toBe("W9-12");
    expect(perfMonthLabel(3)).toBe("M4");
    expect(perfMonthLabel(23)).toBe("M24");
    expect(new Set(Array.from({ length: PERF_MONTHS }, (_, m) => perfMonthLabel(m))).size).toBe(
      PERF_MONTHS,
    );
  });

  it("base keys live under the baby's derivatives/_base prefix and reject bad months", () => {
    expect(perfBaseKey(BABY, "thumb", 0)).toBe(`babies/${BABY}/derivatives/_base/thumb-0.jpg`);
    expect(perfBaseKey(BABY, "display", 23)).toBe(
      `babies/${BABY}/derivatives/_base/display-23.jpg`,
    );
    expect(perfBaseKey(BABY, "thumb", 5).startsWith(perfBasePrefix(BABY))).toBe(true);
    for (const bad of [-1, 24, 1.5, Number.NaN])
      expect(() => perfBaseKey(BABY, "thumb", bad)).toThrow(RangeError);
  });

  it("only thumb and display are produced: never an analysis derivative", () => {
    expect([...PERF_DERIVATIVE_KINDS]).toEqual(["thumb", "display"]);
  });

  it("the SVG follows the month's orientation and uses no <text> (no font needed)", () => {
    for (let m = 0; m < PERF_MONTHS; m++) {
      const { svg, width, height } = perfBaseSvg(m);
      expect(width > height, `month ${m}`).toBe(PERF_LANDSCAPE_MONTHS.has(m));
      expect(svg).not.toContain("<text");
      expect(perfBaseSvg(m).svg).toBe(svg);
    }
  });
});

describe("rendered derivatives", () => {
  it.each([0, 1])(
    "month %i: thumb <= 320 px, display <= 1600 px, JPEG without EXIF or ICC",
    async (month) => {
      const out = await renderPerfBase(month);
      expect(out.map((o) => o.kind)).toEqual(["thumb", "display"]);
      for (const o of out) {
        const meta = await sharp(o.buffer).metadata();
        expect(meta.format).toBe("jpeg");
        expect(meta.exif, `${o.kind} exif`).toBeUndefined();
        expect(meta.icc, `${o.kind} icc`).toBeUndefined();
        expect(meta.xmp).toBeUndefined();
        const long = Math.max(meta.width ?? 0, meta.height ?? 0);
        expect(long).toBeLessThanOrEqual(o.kind === "thumb" ? 320 : 1600);
        expect(long).toBeGreaterThan(o.kind === "thumb" ? 200 : 1000);
        expect([meta.width, meta.height]).toEqual([o.width, o.height]);
        expect(o.bytes).toBe(o.buffer.length);
        expect((meta.width ?? 0) > (meta.height ?? 0)).toBe(PERF_LANDSCAPE_MONTHS.has(month));
      }
    },
    60_000,
  );
});
