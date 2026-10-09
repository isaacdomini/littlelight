import type { ModelUsage, VisionBatchState, VisionResult } from "./types";

/** Terminal states: results are final (possibly partial or none); artifacts may be deleted. */
export const TERMINAL_BATCH_STATES: readonly VisionBatchState[] = [
  "completed",
  "failed",
  "expired",
  "cancelled",
];

export function isTerminalBatchState(state: VisionBatchState): boolean {
  return TERMINAL_BATCH_STATES.includes(state);
}

/** Sum of per-result usage (billed failures included); `undefined` when nothing was billed. */
export function sumUsage(results: readonly VisionResult[]): ModelUsage | undefined {
  let any = false;
  const total: Required<ModelUsage> = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    imageTokens: 0,
    costUsd: 0,
  };
  for (const r of results) {
    const u = r.usage;
    if (!u) continue;
    any = true;
    total.inputTokens += u.inputTokens;
    total.cachedInputTokens += u.cachedInputTokens;
    total.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    total.outputTokens += u.outputTokens;
    total.reasoningTokens += u.reasoningTokens ?? 0;
    total.imageTokens += u.imageTokens ?? 0;
    total.costUsd += u.costUsd;
  }
  if (!any) return undefined;
  total.costUsd = Math.round(total.costUsd * 1e10) / 1e10;
  return total;
}
