import { describe, expect, it } from "vitest";
import { viewerPhotoSchema } from "./share-viewer";

const photo = (over: Record<string, unknown> = {}) => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  // step 12: viewers learn the kind and the duration, never the file or a GPS fix
  mediaKind: "photo",
  durationMs: null,
  takenAt: "2026-06-14",
  takenAtEstimated: false,
  ageDays: 105,
  width: 800,
  height: 600,
  milestone: null,
  hidden: true,
  thumbUrl: null,
  urlExpiresAt: null,
  ...over,
});

describe("viewerPhotoSchema takenAt (date only)", () => {
  it("accepts a calendar date and null", () => {
    expect(viewerPhotoSchema.safeParse(photo()).success).toBe(true);
    expect(viewerPhotoSchema.safeParse(photo({ takenAt: null })).success).toBe(true);
  });

  it.each([
    "2026-06-14T10:00:00Z",
    "2026-06-14T10:00:00.000Z",
    "2026-06-14T23:59:59+14:00",
    "2026-06-14 10:00:00",
    "06/14/2026",
    "2026-6-14",
    "2026-02-30",
    "",
  ])("rejects %j: no time of day reaches a viewer", (takenAt) => {
    expect(viewerPhotoSchema.safeParse(photo({ takenAt })).success).toBe(false);
  });

  it("still rejects a field a viewer must never see", () => {
    expect(viewerPhotoSchema.safeParse(photo({ lat: 1 })).success).toBe(false);
    expect(viewerPhotoSchema.safeParse(photo({ note: "x" })).success).toBe(false);
  });
});
