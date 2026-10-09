import { describe, expect, it } from "vitest";
import { apiErrorCodeSchema } from "./api/errors";
import { CHAT_DEFAULTS, chatEnvSchema, SEARCH_DEFAULTS, searchEnvSchema } from "./env";

describe("searchEnvSchema (step 7)", () => {
  it("applies the documented defaults, treating empty strings as unset", () => {
    const e = searchEnvSchema.parse({ SEARCH_RERANK: "", SEARCH_EXACT_MAX: "" });
    expect(e).toEqual({
      SEARCH_RERANK: "off",
      SEARCH_EXACT_MAX: 2000,
      SEARCH_HNSW_EF_SEARCH: 100,
      SEARCH_RECONCILE_CRON: "17 * * * *",
      SEARCH_EMBED_BATCH: 100,
    });
    expect(SEARCH_DEFAULTS.SEARCH_EMBED_BATCH).toBe(100);
  });

  it("SEARCH_MIN_SIMILARITY is optional (unset/empty = the model default), 0..1", () => {
    expect(searchEnvSchema.parse({}).SEARCH_MIN_SIMILARITY).toBeUndefined();
    expect(
      searchEnvSchema.parse({ SEARCH_MIN_SIMILARITY: "" }).SEARCH_MIN_SIMILARITY,
    ).toBeUndefined();
    expect(searchEnvSchema.parse({ SEARCH_MIN_SIMILARITY: "0.35" }).SEARCH_MIN_SIMILARITY).toBe(
      0.35,
    );
    expect(searchEnvSchema.parse({ SEARCH_MIN_SIMILARITY: "0" }).SEARCH_MIN_SIMILARITY).toBe(0);
    for (const bad of ["-0.1", "1.1", "high"]) {
      expect(searchEnvSchema.safeParse({ SEARCH_MIN_SIMILARITY: bad }).success, bad).toBe(false);
    }
  });

  it("coerces and bounds values", () => {
    expect(searchEnvSchema.parse({ SEARCH_EXACT_MAX: "5000", SEARCH_RERANK: "llm" })).toMatchObject(
      {
        SEARCH_EXACT_MAX: 5000,
        SEARCH_RERANK: "llm",
      },
    );
    for (const bad of [
      { SEARCH_RERANK: "on" },
      { SEARCH_EXACT_MAX: "99" },
      { SEARCH_EXACT_MAX: "20001" },
      { SEARCH_HNSW_EF_SEARCH: "39" },
      { SEARCH_EMBED_BATCH: "0" },
      { SEARCH_EMBED_BATCH: "513" },
      { SEARCH_RECONCILE_CRON: "not a cron" },
    ]) {
      expect(searchEnvSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("chatEnvSchema (step 7)", () => {
  it("applies the documented defaults", () => {
    expect(chatEnvSchema.parse({})).toEqual({
      CHAT_TURNS_PER_DAY: 100,
      CHAT_MAX_TOOL_ROUNDS: 4,
      CHAT_MAX_OUTPUT_TOKENS: 800,
      CHAT_HISTORY_MESSAGES: 20,
      CHAT_MODEL_TIMEOUT_MS: 30_000,
      CHAT_FAST_PATH: true,
    });
    expect(CHAT_DEFAULTS.CHAT_TURNS_PER_DAY).toBe(100);
  });

  it("CHAT_FAST_PATH is a boolean switch, on by default", () => {
    expect(chatEnvSchema.parse({ CHAT_FAST_PATH: "" }).CHAT_FAST_PATH).toBe(true);
    for (const off of ["false", "0", "off", "no"]) {
      expect(chatEnvSchema.parse({ CHAT_FAST_PATH: off }).CHAT_FAST_PATH, off).toBe(false);
    }
    for (const on of ["true", "1", "on", "yes"]) {
      expect(chatEnvSchema.parse({ CHAT_FAST_PATH: on }).CHAT_FAST_PATH, on).toBe(true);
    }
    expect(chatEnvSchema.safeParse({ CHAT_FAST_PATH: "maybe" }).success).toBe(false);
  });

  it("CHAT_FAST_PATH_MIN_SIMILARITY is optional (unset/empty = the model default) and 0..1", () => {
    expect(chatEnvSchema.parse({}).CHAT_FAST_PATH_MIN_SIMILARITY).toBeUndefined();
    expect(
      chatEnvSchema.parse({ CHAT_FAST_PATH_MIN_SIMILARITY: "" }).CHAT_FAST_PATH_MIN_SIMILARITY,
    ).toBeUndefined();
    expect(
      chatEnvSchema.parse({ CHAT_FAST_PATH_MIN_SIMILARITY: "0.45" }).CHAT_FAST_PATH_MIN_SIMILARITY,
    ).toBe(0.45);
    expect(
      chatEnvSchema.parse({ CHAT_FAST_PATH_MIN_SIMILARITY: "0" }).CHAT_FAST_PATH_MIN_SIMILARITY,
    ).toBe(0);
    for (const bad of ["-0.1", "1.5", "high"]) {
      expect(chatEnvSchema.safeParse({ CHAT_FAST_PATH_MIN_SIMILARITY: bad }).success, bad).toBe(
        false,
      );
    }
  });

  it("rejects out-of-range values", () => {
    for (const bad of [
      { CHAT_TURNS_PER_DAY: "0" },
      { CHAT_MAX_TOOL_ROUNDS: "9" },
      { CHAT_MAX_OUTPUT_TOKENS: "100" },
      { CHAT_HISTORY_MESSAGES: "101" },
      { CHAT_MODEL_TIMEOUT_MS: "999" },
    ]) {
      expect(chatEnvSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("step 7 API error codes", () => {
  it("includes plan_required and ai_budget_exceeded", () => {
    expect(apiErrorCodeSchema.safeParse("plan_required").success).toBe(true);
    expect(apiErrorCodeSchema.safeParse("ai_budget_exceeded").success).toBe(true);
  });
});
