import { describe, expect, it } from "vitest";
import { normalizeTimeZone } from "./me";

describe("normalizeTimeZone", () => {
  it("accepts UTC and names ICU lists", () => {
    expect(normalizeTimeZone("UTC")).toBe("UTC");
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
    expect(normalizeTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("keeps the client's spelling of an alias ICU resolves (Asia/Kolkata)", () => {
    expect(normalizeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(normalizeTimeZone("America/Argentina/Buenos_Aires")).toBe(
      "America/Argentina/Buenos_Aires",
    );
  });

  it("rejects offsets, junk and injection-looking strings", () => {
    for (const bad of [
      "+05:30",
      "GMT+5",
      "Nowhere/Land",
      "utc",
      "",
      "America/New_York; DROP TABLE profiles",
      "../../etc/passwd",
      "A/B/C/D",
    ]) {
      expect(normalizeTimeZone(bad), bad).toBeNull();
    }
  });
});
