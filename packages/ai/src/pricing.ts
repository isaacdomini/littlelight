/**
 * Pinned price table and cost math (docs/plans/step-6.md 2.2, 2.5). Every recorded
 * `cost_usd` comes from here; an unknown model is a config error at adapter construction,
 * never a silent $0.
 *
 * Sources (fetched 2026-10-08):
 * - OpenAI: https://developers.openai.com/api/docs/pricing ,
 *   https://developers.openai.com/api/docs/models/gpt-6-luna
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing ,
 *   https://platform.claude.com/docs/en/models/haiku-5-5/overview
 *
 * Assumptions (plan R6): Anthropic's cached-read and cache-write prices under Batch are not
 * published; the batch tier assumes the same 50 % discount as input/output. `gpt-6.1-sol` is the
 * escalation tier (config only in step 6).
 */

import { AiConfigError } from "./errors";

export const PRICE_TABLE_VERSION = "2026-10-08";

/** USD per 1M tokens. */
export interface Tier {
  inputPerM: number;
  cachedInputPerM: number;
  /** Prompt-cache writes (OpenAI; Anthropic 5-minute TTL). */
  cacheWritePerM: number;
  /** Anthropic 1-hour TTL cache writes, when priced differently from 5-minute writes. */
  cacheWrite1hPerM?: number;
  outputPerM: number;
}

export type PriceTierName = "standard" | "batch";

export const PRICES: Readonly<Record<string, Readonly<Record<PriceTierName, Readonly<Tier>>>>> = {
  "gpt-6-luna": {
    standard: { inputPerM: 0.1, cachedInputPerM: 0.01, cacheWritePerM: 0.125, outputPerM: 0.5 },
    batch: { inputPerM: 0.05, cachedInputPerM: 0.005, cacheWritePerM: 0.0625, outputPerM: 0.25 },
  },
  "gpt-6.1-sol": {
    standard: { inputPerM: 2, cachedInputPerM: 0.1, cacheWritePerM: 2.5, outputPerM: 10 },
    batch: { inputPerM: 1, cachedInputPerM: 0.05, cacheWritePerM: 1.25, outputPerM: 5 },
  },
  "claude-haiku-5-5": {
    standard: {
      inputPerM: 0.1,
      cachedInputPerM: 0.01,
      cacheWritePerM: 0.125,
      cacheWrite1hPerM: 0.2,
      outputPerM: 0.5,
    },
    batch: {
      inputPerM: 0.05,
      cachedInputPerM: 0.005,
      cacheWritePerM: 0.0625,
      cacheWrite1hPerM: 0.1,
      outputPerM: 0.25,
    },
  },
  "text-embedding-3-small": {
    standard: { inputPerM: 0.02, cachedInputPerM: 0.02, cacheWritePerM: 0.02, outputPerM: 0 },
    batch: { inputPerM: 0.01, cachedInputPerM: 0.01, cacheWritePerM: 0.01, outputPerM: 0 },
  },
};

export interface PricedUsage {
  /** All prompt tokens, including cached reads and cache writes. */
  inputTokens: number;
  cachedInputTokens: number;
  /** All cache-write tokens (5-minute and 1-hour). */
  cacheWriteTokens?: number;
  /** The 1-hour subset of `cacheWriteTokens` (Anthropic), priced at `cacheWrite1hPerM`. */
  cacheWrite1hTokens?: number;
  /** All output tokens; reasoning tokens are already included (billed as output). */
  outputTokens: number;
}

export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

/** Throws `AiConfigError([field])` when the model is not in the price table. */
export function assertPriced(model: string, field: string): void {
  if (!hasPrice(model)) throw new AiConfigError([field]);
}

/**
 * `((input − cached − cacheWrite) × in + cached × cachedIn + cacheWrite × write + output × out) / 1e6`,
 * rounded to 1e-10 USD (`cost_usd` is `numeric(12,8)`).
 * Example: 1,400 in / 700 cached / 400 out on `gpt-6-luna` batch = 0.0001385.
 */
export function costUsd(model: string, tier: PriceTierName, usage: PricedUsage): number {
  const table = PRICES[model];
  if (!table) throw new AiConfigError(["VISION_MODEL"]);
  const t = table[tier];
  const nn = (n: number | undefined) =>
    Number.isFinite(n) && (n as number) > 0 ? (n as number) : 0;
  const cached = nn(usage.cachedInputTokens);
  const write = nn(usage.cacheWriteTokens);
  const write1h = Math.min(nn(usage.cacheWrite1hTokens), write);
  const uncached = Math.max(0, nn(usage.inputTokens) - cached - write);
  const micro =
    uncached * t.inputPerM +
    cached * t.cachedInputPerM +
    (write - write1h) * t.cacheWritePerM +
    write1h * (t.cacheWrite1hPerM ?? t.cacheWritePerM) +
    nn(usage.outputTokens) * t.outputPerM;
  return Math.round((micro / 1e6) * 1e10) / 1e10;
}
