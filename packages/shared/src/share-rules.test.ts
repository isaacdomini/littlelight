import { describe, expect, it } from "vitest";
import {
  normalizeShareTag,
  type ShareRuleFacts,
  shareRuleMatches,
  shareTagSchema,
} from "./share-rules";

// Auto-share matcher (PRD FR-9.4 modes, FR-9.5 safety gate; docs/plans/step-8.md 2.4).

const facts = (o: Partial<ShareRuleFacts> = {}): ShareRuleFacts => ({
  analyzed: true,
  isSensitive: false,
  hasMilestone: false,
  tags: ["outdoor", "park"],
  ...o,
});
const rule = (
  mode: "all" | "milestones" | "tags",
  include: string[] = [],
  exclude: string[] = [],
) => ({
  mode,
  includeTags: include,
  excludeTags: exclude,
});

describe("shareRuleMatches", () => {
  it("never matches a sensitive or unanalysed photo, whatever the mode and tags", () => {
    for (const r of [rule("all"), rule("milestones"), rule("tags", ["outdoor"])]) {
      expect(shareRuleMatches(r, facts({ isSensitive: true, hasMilestone: true }))).toBe(false);
      expect(shareRuleMatches(r, facts({ analyzed: false, hasMilestone: true }))).toBe(false);
    }
    // fail closed on odd values
    expect(shareRuleMatches(rule("all"), facts({ isSensitive: undefined as never }))).toBe(false);
    expect(shareRuleMatches(rule("all"), facts({ analyzed: undefined as never }))).toBe(false);
  });

  it("all: every analysed, non-sensitive photo", () => {
    expect(shareRuleMatches(rule("all"), facts())).toBe(true);
    expect(shareRuleMatches(rule("all"), facts({ tags: [] }))).toBe(true);
  });

  it("milestones: only a parent-tagged milestone", () => {
    expect(shareRuleMatches(rule("milestones"), facts({ hasMilestone: true }))).toBe(true);
    expect(shareRuleMatches(rule("milestones"), facts({ hasMilestone: false }))).toBe(false);
  });

  it("tags: any include tag, compared after normalization", () => {
    expect(shareRuleMatches(rule("tags", ["outdoor"]), facts())).toBe(true);
    expect(shareRuleMatches(rule("tags", ["  OUTDOOR "]), facts())).toBe(true);
    expect(shareRuleMatches(rule("tags", ["indoor", "park"]), facts())).toBe(true);
    expect(shareRuleMatches(rule("tags", ["indoor"]), facts())).toBe(false);
    expect(shareRuleMatches(rule("tags", []), facts())).toBe(false);
    expect(shareRuleMatches(rule("tags", [""]), facts({ tags: [""] }))).toBe(false);
  });

  it("exclude tags always win, in every mode", () => {
    expect(shareRuleMatches(rule("all", [], ["park"]), facts())).toBe(false);
    expect(shareRuleMatches(rule("milestones", [], ["Park"]), facts({ hasMilestone: true }))).toBe(
      false,
    );
    expect(shareRuleMatches(rule("tags", ["outdoor"], ["park"]), facts())).toBe(false);
    expect(shareRuleMatches(rule("tags", ["outdoor"], ["bath"]), facts())).toBe(true);
  });

  it("an unknown mode never matches", () => {
    expect(
      shareRuleMatches({ mode: "weird" as never, includeTags: [], excludeTags: [] }, facts()),
    ).toBe(false);
  });
});

describe("tag normalization", () => {
  it("NFC, trims, collapses whitespace, lower-cases and strips control characters", () => {
    expect(normalizeShareTag("  Outdoor\tPlay \n")).toBe("outdoor play");
    expect(normalizeShareTag("Café")).toBe("café");
    expect(normalizeShareTag("a\u0000b")).toBe("a b");
  });

  it("shareTagSchema accepts 1..60 normalized chars and rejects empty or long tags", () => {
    expect(shareTagSchema.parse(" Park ")).toBe("park");
    expect(shareTagSchema.safeParse("   ").success).toBe(false);
    expect(shareTagSchema.safeParse("x".repeat(61)).success).toBe(false);
    expect(shareTagSchema.safeParse("x".repeat(60)).success).toBe(true);
  });
});
