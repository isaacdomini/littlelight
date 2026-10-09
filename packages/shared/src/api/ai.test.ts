import { describe, expect, it } from "vitest";
import {
  AI_CONFLICT_MESSAGES,
  AI_STATUSES,
  aiRetryResponseSchema,
  aiStatusSchema,
  aiUsageMonthSchema,
  aiUsageQuerySchema,
  aiUsageResponseSchema,
  photoAiOverridePatchSchema,
  photoAiSchema,
} from "./ai";

describe("aiStatusSchema", () => {
  it("has the six states", () => {
    expect([...AI_STATUSES]).toEqual([
      "not_available",
      "pending",
      "queued",
      "analyzing",
      "ready",
      "failed",
    ]);
    expect(aiStatusSchema.safeParse("running").success).toBe(false);
    expect(aiRetryResponseSchema.parse({ status: "pending" })).toEqual({ status: "pending" });
  });
});

describe("photoAiOverridePatchSchema", () => {
  it("accepts a value, null (clear) and several keys", () => {
    expect(photoAiOverridePatchSchema.parse({ caption: "Hi" })).toEqual({ caption: "Hi" });
    expect(photoAiOverridePatchSchema.parse({ caption: null })).toEqual({ caption: null });
    expect(
      photoAiOverridePatchSchema.parse({ search_tags: ["A", "a"], detailed_description: null }),
    ).toEqual({ search_tags: ["a"], detailed_description: null });
  });

  it("rejects an empty patch, bad values and unknown fields", () => {
    expect(photoAiOverridePatchSchema.safeParse({}).success).toBe(false);
    expect(photoAiOverridePatchSchema.safeParse({ caption: undefined }).success).toBe(false);
    expect(photoAiOverridePatchSchema.safeParse({ caption: "" }).success).toBe(false);
    expect(photoAiOverridePatchSchema.safeParse({ caption: "x".repeat(201) }).success).toBe(false);
    expect(photoAiOverridePatchSchema.safeParse({ search_tags: [] }).success).toBe(false);
    expect(photoAiOverridePatchSchema.safeParse({ caption: 5 }).success).toBe(false);
  });
});

describe("usage schemas", () => {
  it.each(["2026-10", "2026-01", "2026-12"])("accepts month %s", (m) => {
    expect(aiUsageMonthSchema.safeParse(m).success).toBe(true);
  });
  it.each(["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", ""])("rejects month %j", (m) => {
    expect(aiUsageMonthSchema.safeParse(m).success).toBe(false);
  });
  it("query month is optional", () => {
    expect(aiUsageQuerySchema.parse({})).toEqual({});
  });
  it("response requires all six photo counters", () => {
    const base = {
      month: "2026-10",
      costUsd: 0,
      budgetUsd: 3,
      photos: { not_available: 0, pending: 0, queued: 0, analyzing: 0, ready: 0, failed: 0 },
      lastCompletedAt: null,
    };
    expect(aiUsageResponseSchema.safeParse(base).success).toBe(true);
    const { failed: _f, ...rest } = base.photos;
    expect(aiUsageResponseSchema.safeParse({ ...base, photos: rest }).success).toBe(false);
    expect(aiUsageResponseSchema.safeParse({ ...base, costUsd: -1 }).success).toBe(false);
  });
});

describe("photoAiSchema", () => {
  it("accepts a not_available block with nothing else", () => {
    const block = {
      status: "not_available",
      description: null,
      raw: null,
      overrides: {},
      model: null,
      promptVersion: null,
      schemaVersion: null,
      analyzedAt: null,
      failure: null,
      canRetry: false,
    };
    expect(photoAiSchema.safeParse(block).success).toBe(true);
    expect(photoAiSchema.safeParse({ ...block, failure: "boom" }).success).toBe(false);
    expect(photoAiSchema.safeParse({ ...block, failure: "budget" }).success).toBe(true);
  });
});

describe("conflict messages", () => {
  it("are fixed user-facing strings", () => {
    expect(Object.keys(AI_CONFLICT_MESSAGES).sort()).toEqual([
      "noDescription",
      "notAvailable",
      "notFailed",
    ]);
  });
});
