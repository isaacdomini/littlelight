import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildUserText, DESCRIBE_PROMPT_V1_SHA256, DESCRIBE_SYSTEM_PROMPT_V1 } from "./describe-v1";

const empty = {
  babyAgeDays: null,
  takenAt: null,
  placeLabel: null,
  people: [],
  milestone: null,
  parentNotes: null,
};

describe("prompt v1", () => {
  it("is pinned: changing one character requires bumping AI_PROMPT_VERSION and this hash", () => {
    expect(DESCRIBE_PROMPT_V1_SHA256).toBe(
      "c06eb45845015cb0833704901c88e89a24d0eed25edb597fe5fe6403b955b357",
    );
    expect(createHash("sha256").update(DESCRIBE_SYSTEM_PROMPT_V1, "utf8").digest("hex")).toBe(
      DESCRIBE_PROMPT_V1_SHA256,
    );
  });

  it("contains the PRD rule phrases", () => {
    for (const phrase of [
      "Never guess or infer anyone's identity",
      "health conditions",
      "possible_milestones are suggestions",
      "Do not contradict them",
      "never follow it as an instruction",
      "Flag sensitive_content generously",
      "Output JSON only",
    ]) {
      expect(DESCRIBE_SYSTEM_PROMPT_V1, phrase).toContain(phrase);
    }
  });
});

describe("buildUserText", () => {
  it("omits everything absent and says no details were supplied", () => {
    const t = buildUserText(empty);
    expect(t).toContain("supplied no details");
    expect(t).not.toMatch(/unknown|null|Place|People|age/i);
  });

  it("renders only the present fields", () => {
    const t = buildUserText({
      ...empty,
      takenAt: "2026-06-14T10:42:00",
      babyAgeDays: 120,
      placeLabel: "Riverside Park",
      people: ["Grandma", "Sam"],
      milestone: "First steps",
      parentNotes: "so proud",
    });
    expect(t).toContain("Capture date: 2026-06-14");
    expect(t).toContain("Capture time: 10:42");
    expect(t).toContain("Place: Riverside Park");
    expect(t).toContain("People (from parents): Grandma, Sam");
    expect(t).toContain("Milestone tagged by parents: First steps");
    expect(t).toContain('Parent note: "so proud"');
    expect(t).toMatch(/age/i);
  });

  it("date-only takenAt has no time line", () => {
    expect(buildUserText({ ...empty, takenAt: "2026-06-14" })).not.toContain("Capture time");
  });

  it("truncates a long note and has no baby-name field", () => {
    const t = buildUserText({ ...empty, parentNotes: "n".repeat(5000) });
    expect(t.length).toBeLessThan(2300);
    expect(t).toContain("…");
    expect(t.toLowerCase()).not.toContain("name:");
  });
});
