import { describe, expect, it } from "vitest";
import { parentsOnly, planRequired, safeTimeZone, todayIn } from "./access";

describe("safeTimeZone", () => {
  it("keeps a known IANA zone and falls back to UTC for null, empty or unknown values", () => {
    expect(safeTimeZone("America/New_York")).toBe("America/New_York");
    expect(safeTimeZone("UTC")).toBe("UTC");
    expect(safeTimeZone(null)).toBe("UTC");
    expect(safeTimeZone(undefined)).toBe("UTC");
    expect(safeTimeZone("")).toBe("UTC");
    expect(safeTimeZone("Mars/Olympus")).toBe("UTC");
  });
});

describe("todayIn", () => {
  it("is the local calendar date in the zone", () => {
    const t = new Date("2026-10-09T02:30:00Z");
    expect(todayIn("UTC", t)).toBe("2026-10-09");
    expect(todayIn("America/Los_Angeles", t)).toBe("2026-10-08");
    expect(todayIn("Pacific/Auckland", t)).toBe("2026-10-09");
    expect(todayIn("Pacific/Kiritimati", new Date("2026-10-09T11:00:00Z"))).toBe("2026-10-10");
  });
});

describe("gate errors", () => {
  it("plan_required is a 403 and parents-only a 403 forbidden, with fixed copy", () => {
    expect(planRequired()).toMatchObject({
      status: 403,
      code: "plan_required",
      message: "AI search and chat are part of Plus",
    });
    expect(parentsOnly()).toMatchObject({ status: 403, code: "forbidden" });
    expect(parentsOnly().message).toBe("Chat and search are for the baby's parents");
  });
});
