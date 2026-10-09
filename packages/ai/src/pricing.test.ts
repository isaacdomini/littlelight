import { describe, expect, it } from "vitest";
import { AiConfigError } from "./errors";
import { assertPriced, costUsd, hasPrice, PRICES } from "./pricing";

describe("costUsd", () => {
  it("1,400 in / 700 cached / 400 out on gpt-6-luna batch = 0.0001385", () => {
    const c = costUsd("gpt-6-luna", "batch", {
      inputTokens: 1400,
      cachedInputTokens: 700,
      outputTokens: 400,
    });
    expect(c).toBeCloseTo(0.0001385, 10);
    expect(c).toBe((700 * 0.05 + 700 * 0.005 + 400 * 0.25) / 1e6);
  });

  it("standard tier is exactly twice the batch tier for luna", () => {
    const u = { inputTokens: 1400, cachedInputTokens: 700, outputTokens: 400 };
    expect(costUsd("gpt-6-luna", "standard", u)).toBeCloseTo(
      2 * costUsd("gpt-6-luna", "batch", u),
      10,
    );
  });

  it("prices cache-write tokens at the write rate (not the input rate)", () => {
    const withWrite = costUsd("gpt-6-luna", "batch", {
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteTokens: 1000,
      outputTokens: 0,
    });
    expect(withWrite).toBeCloseTo((1000 * 0.0625) / 1e6, 10);
  });

  it("Anthropic 1h cache writes use the 1h rate for that subset", () => {
    const c = costUsd("claude-haiku-5-5", "batch", {
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteTokens: 1000,
      cacheWrite1hTokens: 400,
      outputTokens: 0,
    });
    expect(c).toBeCloseTo((600 * 0.0625 + 400 * 0.1) / 1e6, 10);
  });

  it("clamps negatives / NaN and never goes below zero", () => {
    expect(
      costUsd("gpt-6-luna", "batch", {
        inputTokens: -5,
        cachedInputTokens: Number.NaN,
        outputTokens: -1,
      }),
    ).toBe(0);
    // cached larger than input: uncached floors at 0
    expect(
      costUsd("gpt-6-luna", "batch", { inputTokens: 10, cachedInputTokens: 50, outputTokens: 0 }),
    ).toBeCloseTo((50 * 0.005) / 1e6, 12);
  });

  it("an unknown model throws AiConfigError naming the field, never $0", () => {
    expect(() =>
      costUsd("gpt-9-mystery", "batch", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }),
    ).toThrow(AiConfigError);
    expect(() => assertPriced("gpt-9-mystery", "VISION_MODEL")).toThrow(/VISION_MODEL/);
    expect(hasPrice("gpt-6-luna")).toBe(true);
    expect(hasPrice("toString")).toBe(false);
    expect(hasPrice("__proto__")).toBe(false);
  });

  it("every batch tier is cheaper than standard", () => {
    for (const [model, t] of Object.entries(PRICES)) {
      expect(t.batch.inputPerM, model).toBeLessThan(t.standard.inputPerM);
    }
  });
});
