import { describe, expect, it } from "vitest";
import { JOBS } from "./jobs";

describe("JOBS", () => {
  it("reserves the purge.trash queue name", () => {
    expect(JOBS.purgeTrash).toBe("purge.trash");
  });

  it("has unique queue names", () => {
    const names = Object.values(JOBS);
    expect(new Set(names).size).toBe(names.length);
  });
});
