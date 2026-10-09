import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS, auditEventSchema, auditMetadataSchema } from "./auth";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("audit events (step 4 additions)", () => {
  it("lists the upload, moderation, purge and safety events", () => {
    for (const e of [
      "upload.session_created",
      "upload.session_finished",
      "photo.approved",
      "photo.rejected",
      "photo.trashed",
      "photo.restored",
      "photo.original_downloaded",
      "photo.purged",
      "safety.hash_match",
    ]) {
      expect(auditEventSchema.safeParse(e).success, e).toBe(true);
    }
    expect(new Set(AUDIT_EVENTS).size).toBe(AUDIT_EVENTS.length);
    expect(auditEventSchema.safeParse("photo.deleted").success).toBe(false);
  });
});

describe("audit metadata (strict allow-list)", () => {
  it("accepts the step 4 keys", () => {
    expect(
      auditMetadataSchema.parse({
        photo_id: UUID,
        session_id: UUID,
        count: 3,
        duplicates: 1,
        failed: 0,
        error: "decode_failed",
        client: "web",
      }),
    ).toMatchObject({ count: 3, duplicates: 1, error: "decode_failed" });
  });

  it.each([
    ["a note", { note: "private" }],
    ["GPS", { lat: 1, lng: 2 }],
    ["an email", { email: "a@b.co" }],
    ["a storage key", { storage_key: "babies/x" }],
    ["a negative count", { count: -1 }],
    ["an unknown upload error", { error: "disk_on_fire" }],
    ["a non-uuid photo id", { photo_id: "p1" }],
  ])("rejects %s", (_n, md) => {
    expect(auditMetadataSchema.safeParse(md).success).toBe(false);
  });
});

describe("audit additions (step 6)", () => {
  it("lists the AI events", () => {
    for (const e of [
      "ai.override_updated",
      "ai.override_cleared",
      "ai.retry_requested",
      "baby.plan_changed",
      "ai.budget_exceeded",
    ]) {
      expect(auditEventSchema.safeParse(e).success, e).toBe(true);
    }
  });

  it("metadata accepts field, plan and month but never a value", () => {
    expect(auditMetadataSchema.parse({ photo_id: UUID, field: "caption" })).toEqual({
      photo_id: UUID,
      field: "caption",
    });
    expect(auditMetadataSchema.parse({ plan: "plus" })).toEqual({ plan: "plus" });
    expect(auditMetadataSchema.parse({ month: "2026-10" })).toEqual({ month: "2026-10" });
  });

  it.each([
    ["an unknown field", { field: "objects" }],
    ["a value", { field: "caption", value: "Mia's first bath" }],
    ["an unknown plan", { plan: "gold" }],
    ["a bad month", { month: "2026-13" }],
  ])("rejects %s", (_n, md) => {
    expect(auditMetadataSchema.safeParse(md).success).toBe(false);
  });
});
