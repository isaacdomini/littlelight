import { describe, expect, it } from "vitest";
import {
  AI_BACKFILL_REASONS,
  aiBackfillJobSchema,
  aiFlushJobSchema,
  aiPollJobSchema,
  ingestJobSchema,
  JOBS,
  REINDEX_REASONS,
  reindexJobSchema,
  SEARCH_BACKFILL_REASONS,
  searchBackfillJobSchema,
  searchReconcileJobSchema,
} from "./jobs";

const ids = {
  photoId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  babyId: "11111111-1111-4111-8111-111111111111",
};

describe("JOBS", () => {
  it("uses the documented queue names, all unique", () => {
    expect(JOBS).toEqual({
      ingest: "photo.ingest",
      ingestReconcile: "ingest.reconcile",
      purgeTrash: "purge.trash",
      uploadsSweep: "uploads.sweep",
      reindex: "photo.reindex",
      aiFlush: "ai.flush",
      aiPoll: "ai.poll",
      aiBackfill: "ai.backfill",
      searchReconcile: "search.reconcile",
      searchBackfill: "search.backfill",
    });
    expect(new Set(Object.values(JOBS)).size).toBe(10);
  });
});

describe("ingestJobSchema (strict: ids and a time zone name only)", () => {
  it("accepts the minimal and full payloads", () => {
    expect(ingestJobSchema.parse(ids)).toEqual(ids);
    const full = { ...ids, uploadFileId: ids.photoId, tzHint: "America/New_York" };
    expect(ingestJobSchema.parse(full)).toEqual(full);
    expect(ingestJobSchema.parse({ ...ids, tzHint: "UTC" }).tzHint).toBe("UTC");
  });

  it.each([
    ["an unexpected key (note)", { ...ids, note: "Mia's first bath" }],
    ["GPS", { ...ids, lat: 47.6, lng: -122.3 }],
    ["a storage key", { ...ids, key: "babies/x/originals/y?X-Amz-Signature=abc" }],
    ["a non-uuid photo id", { ...ids, photoId: "photo-1" }],
    ["a missing baby id", { photoId: ids.photoId }],
    ["an unknown time zone", { ...ids, tzHint: "Mars/Olympus" }],
    ["an empty time zone", { ...ids, tzHint: "" }],
    ["an over-long time zone", { ...ids, tzHint: "A".repeat(65) }],
    ["null", null],
  ])("rejects %s", (_n, data) => {
    expect(ingestJobSchema.safeParse(data).success).toBe(false);
  });
});

describe("reindexJobSchema (strict: ids and a reason only)", () => {
  it.each(REINDEX_REASONS)("accepts reason %s", (reason) => {
    const p = { ...ids, reason };
    expect(reindexJobSchema.parse(p)).toEqual(p);
  });

  it("lists the six documented reasons", () => {
    expect([...REINDEX_REASONS]).toEqual([
      "details",
      "milestone",
      "measurement",
      "ai_override",
      "backfill",
      "ai",
    ]);
  });

  it.each([
    ["a note", { ...ids, reason: "details", note: "first steps" }],
    ["people", { ...ids, reason: "details", people: ["Grandma"] }],
    ["GPS", { ...ids, reason: "details", lat: 1, lng: 2 }],
    ["an unknown reason", { ...ids, reason: "because" }],
    ["a missing reason", ids],
    ["a missing baby", { photoId: ids.photoId, reason: "details" }],
    ["a non-uuid photo", { ...ids, photoId: "p1", reason: "details" }],
    ["null", null],
  ])("rejects %s", (_n, data) => {
    expect(reindexJobSchema.safeParse(data).success).toBe(false);
  });
});

describe("aiFlushJobSchema (ids and a flag only)", () => {
  it("accepts empty, force and babyId", () => {
    expect(aiFlushJobSchema.parse({})).toEqual({});
    expect(aiFlushJobSchema.parse({ force: true, babyId: ids.babyId })).toEqual({
      force: true,
      babyId: ids.babyId,
    });
  });
  it.each([
    ["an extra key", { force: true, note: "x" }],
    ["a non-uuid baby", { babyId: "b" }],
    ["a string force", { force: "yes" }],
    ["null", null],
  ])("rejects %s", (_n, data) => {
    expect(aiFlushJobSchema.safeParse(data).success).toBe(false);
  });
});

describe("aiPollJobSchema", () => {
  it("accepts only an empty object", () => {
    expect(aiPollJobSchema.safeParse({}).success).toBe(true);
    expect(aiPollJobSchema.safeParse({ force: true }).success).toBe(false);
  });
});

describe("aiBackfillJobSchema", () => {
  it("lists the reasons", () => {
    expect([...AI_BACKFILL_REASONS]).toEqual(["upgrade", "version", "manual"]);
  });

  it("an upgrade needs a babyId; version and manual do not", () => {
    expect(aiBackfillJobSchema.safeParse({ reason: "upgrade" }).success).toBe(false);
    expect(aiBackfillJobSchema.safeParse({ reason: "upgrade", babyId: ids.babyId }).success).toBe(
      true,
    );
    expect(aiBackfillJobSchema.safeParse({ reason: "version" }).success).toBe(true);
    expect(aiBackfillJobSchema.safeParse({ reason: "manual" }).success).toBe(true);
  });

  it("accepts version tags and rejects odd ones", () => {
    expect(
      aiBackfillJobSchema.safeParse({
        reason: "version",
        promptVersion: "v1",
        schemaVersion: "v2.1-a",
      }).success,
    ).toBe(true);
    expect(aiBackfillJobSchema.safeParse({ reason: "version", promptVersion: "v 1" }).success).toBe(
      false,
    );
    expect(aiBackfillJobSchema.safeParse({ reason: "version", promptVersion: "" }).success).toBe(
      false,
    );
    expect(
      aiBackfillJobSchema.safeParse({ reason: "version", schemaVersion: "x".repeat(33) }).success,
    ).toBe(false);
  });

  it.each([
    ["an unknown reason", { reason: "because" }],
    ["a missing reason", {}],
    ["an extra key", { reason: "manual", note: "x" }],
    ["a non-uuid baby", { reason: "manual", babyId: "b" }],
  ])("rejects %s", (_n, data) => {
    expect(aiBackfillJobSchema.safeParse(data).success).toBe(false);
  });
});

describe("searchReconcileJobSchema", () => {
  it("accepts only an empty object", () => {
    expect(searchReconcileJobSchema.safeParse({}).success).toBe(true);
    expect(searchReconcileJobSchema.safeParse({ babyId: ids.babyId }).success).toBe(false);
  });
});

describe("searchBackfillJobSchema", () => {
  it("lists the reasons", () => {
    expect([...SEARCH_BACKFILL_REASONS]).toEqual(["upgrade", "model", "manual"]);
  });

  it("an upgrade needs a babyId; model and manual do not", () => {
    expect(searchBackfillJobSchema.safeParse({ reason: "upgrade" }).success).toBe(false);
    expect(
      searchBackfillJobSchema.safeParse({ reason: "upgrade", babyId: ids.babyId }).success,
    ).toBe(true);
    expect(searchBackfillJobSchema.safeParse({ reason: "model" }).success).toBe(true);
    expect(
      searchBackfillJobSchema.safeParse({ reason: "manual", babyId: ids.babyId }).success,
    ).toBe(true);
  });

  it.each([
    ["an unknown reason", { reason: "because" }],
    ["a missing reason", {}],
    ["an extra key", { reason: "manual", note: "x" }],
    ["a non-uuid baby", { reason: "manual", babyId: "b" }],
    ["null", null],
  ])("rejects %s", (_n, data) => {
    expect(searchBackfillJobSchema.safeParse(data).success).toBe(false);
  });
});
