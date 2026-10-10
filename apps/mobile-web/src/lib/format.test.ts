import { describe, expect, it } from "vitest";
import { formatCount } from "./format";

describe("formatCount", () => {
  it.each([
    [0, "0"],
    [7, "7"],
    [999, "999"],
    [1000, "1,000"],
    [1240, "1,240"],
    [1_234_567, "1,234,567"],
    [-1500, "-1,500"],
  ])("%d -> %s", (n, s) => {
    expect(formatCount(n)).toBe(s);
  });
});
