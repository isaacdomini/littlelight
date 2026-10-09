import { describe, expect, it } from "vitest";
import { SEARCH_PAGE_DEFAULT, SEARCH_PAGE_MAX } from "../constants";
import { searchFacetsResponseSchema, searchQuerySchema, searchResponseSchema } from "./search";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("searchQuerySchema", () => {
  it("accepts a query alone and defaults the limit", () => {
    const q = searchQuerySchema.parse({ q: "  bath  " });
    expect(q.q).toBe("bath");
    expect(q.limit).toBe(SEARCH_PAGE_DEFAULT);
  });

  it("accepts a filter without a query", () => {
    expect(searchQuerySchema.safeParse({ person: "Grandma" }).success).toBe(true);
    expect(searchQuerySchema.safeParse({ milestoneId: UUID }).success).toBe(true);
    expect(searchQuerySchema.safeParse({ ageFrom: "30" }).success).toBe(true);
  });

  it("rejects an empty search (no q, no filter), also q made of spaces", () => {
    expect(searchQuerySchema.safeParse({}).success).toBe(false);
    expect(searchQuerySchema.safeParse({ limit: "10" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "   " }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "" }).success).toBe(false);
  });

  it("coerces numbers from the query string and lower-cases the tag", () => {
    const q = searchQuerySchema.parse({ tag: "BATH", ageFrom: "10", ageTo: "20", limit: "5" });
    expect(q).toMatchObject({ tag: "bath", ageFrom: 10, ageTo: 20, limit: 5 });
  });

  it("enforces limits", () => {
    expect(searchQuerySchema.safeParse({ q: "x".repeat(201) }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "x".repeat(200) }).success).toBe(true);
    expect(searchQuerySchema.safeParse({ person: "x".repeat(61) }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ place: "x".repeat(121) }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "a", limit: "0" }).success).toBe(false);
    expect(
      searchQuerySchema.safeParse({ q: "a", limit: String(SEARCH_PAGE_MAX + 1) }).success,
    ).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "a", ageFrom: "-301" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "a", ageTo: "7301" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "a", ageFrom: "1.5" }).success).toBe(false);
  });

  it("rejects reversed ranges and bad dates / ids", () => {
    expect(
      searchQuerySchema.safeParse({ dateFrom: "2026-06-10", dateTo: "2026-06-01" }).success,
    ).toBe(false);
    expect(
      searchQuerySchema.safeParse({ dateFrom: "2026-06-01", dateTo: "2026-06-01" }).success,
    ).toBe(true);
    expect(searchQuerySchema.safeParse({ ageFrom: "50", ageTo: "10" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ dateFrom: "June" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ milestoneId: "nope" }).success).toBe(false);
  });
});

describe("search responses", () => {
  it("a result has photos, tookMs and a degraded reason", () => {
    expect(searchResponseSchema.safeParse({ photos: [], tookMs: 3, degraded: null }).success).toBe(
      true,
    );
    expect(
      searchResponseSchema.safeParse({ photos: [], tookMs: 3, degraded: "no_embeddings" }).success,
    ).toBe(true);
    expect(
      searchResponseSchema.safeParse({ photos: [], tookMs: 3, degraded: "other" }).success,
    ).toBe(false);
  });

  it("facets cap tags at 30 and allow an empty date range", () => {
    const base = { people: [], milestones: [], places: [], dateRange: null };
    expect(searchFacetsResponseSchema.safeParse({ ...base, tags: [] }).success).toBe(true);
    const tags = Array.from({ length: 31 }, (_, i) => ({ tag: `t${i}`, count: 1 }));
    expect(searchFacetsResponseSchema.safeParse({ ...base, tags }).success).toBe(false);
  });
});
