import { SEARCH_RRF_K } from "@littlelight/shared";
import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./rrf";

describe("reciprocalRankFusion", () => {
  it("scores 1/(k+rank) per leg, rank from 1, k = 60", () => {
    expect(SEARCH_RRF_K).toBe(60);
    const out = reciprocalRankFusion([["a", "b"], ["b"]]);
    const score = Object.fromEntries(out.map((r) => [r.id, r.score]));
    expect(score.a).toBeCloseTo(1 / 61, 12);
    expect(score.b).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(out.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("an id in several legs outranks one that tops a single leg", () => {
    const out = reciprocalRankFusion([
      ["x", "shared"],
      ["y", "shared"],
      ["z", "shared"],
    ]);
    expect(out[0]?.id).toBe("shared");
  });

  it("honours a custom k", () => {
    const out = reciprocalRankFusion([["a"]], { k: 10 });
    expect(out[0]?.score).toBeCloseTo(1 / 11, 12);
  });

  it("ties break by newest capture time, then by id descending", () => {
    const takenAt = new Map([
      ["old", 1000],
      ["new", 2000],
    ]);
    // each is rank 1 in its own leg: equal scores
    expect(reciprocalRankFusion([["old"], ["new"]], { takenAt }).map((r) => r.id)).toEqual([
      "new",
      "old",
    ]);
    // no capture times: id descending, deterministic
    expect(reciprocalRankFusion([["a"], ["b"], ["c"]]).map((r) => r.id)).toEqual(["c", "b", "a"]);
    // unknown capture time sorts last
    expect(
      reciprocalRankFusion([["u"], ["k"]], { takenAt: new Map([["k", 5]]) }).map((r) => r.id),
    ).toEqual(["k", "u"]);
  });

  it("a duplicate id inside one leg counts once, at its first position", () => {
    const out = reciprocalRankFusion([["a", "a", "b"]]);
    expect(out.find((r) => r.id === "a")?.score).toBeCloseTo(1 / 61, 12);
    expect(out.find((r) => r.id === "b")?.score).toBeCloseTo(1 / 62, 12);
  });

  it("empty legs give an empty result; the output is the union of the legs", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
    expect(
      reciprocalRankFusion([["a"], ["b"], []])
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("is deterministic regardless of leg object identity", () => {
    const legs = [["a", "b", "c"], ["c", "a"], ["b"]];
    expect(reciprocalRankFusion(legs)).toEqual(reciprocalRankFusion(structuredClone(legs)));
  });
});
