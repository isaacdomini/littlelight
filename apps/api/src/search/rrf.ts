import { SEARCH_RRF_K } from "@littlelight/shared";

// Reciprocal Rank Fusion (docs/plans/step-7.md 2.8 step 6; PRD "Chat and RAG pipeline"):
// `score(d) = Σ_legs 1 / (k + rank_leg(d))`, rank from 1, k = 60. Ties by capture time
// (newest first), then id, so the order is deterministic. Pure.

export interface FusedResult {
  id: string;
  score: number;
}

export function reciprocalRankFusion(
  legs: ReadonlyArray<readonly string[]>,
  opts: { k?: number; takenAt?: ReadonlyMap<string, number> } = {},
): FusedResult[] {
  const k = opts.k ?? SEARCH_RRF_K;
  const scores = new Map<string, number>();
  for (const leg of legs) {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of leg) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank++;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  const takenAt = opts.takenAt ?? new Map<string, number>();
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (takenAt.get(b.id) ?? Number.NEGATIVE_INFINITY) -
          (takenAt.get(a.id) ?? Number.NEGATIVE_INFINITY) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
}
