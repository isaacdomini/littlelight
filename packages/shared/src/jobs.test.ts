import { describe, expect, it } from "vitest";
import { ingestJobSchema, JOBS } from "./jobs";

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
    });
    expect(new Set(Object.values(JOBS)).size).toBe(4);
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
