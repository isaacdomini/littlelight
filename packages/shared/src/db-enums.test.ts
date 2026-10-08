import { describe, expect, it } from "vitest";
import {
  aiBatchStatusSchema,
  babyRoleSchema,
  chatRoleSchema,
  derivativeKindSchema,
  measurementKindSchema,
  measurementUnitSchema,
  milestoneCategorySchema,
  photoApprovalSchema,
  photoMimeSchema,
  photoStatusSchema,
  planSchema,
  sharedPhotoAddedBySchema,
  shareRuleModeSchema,
  unitsSchema,
} from "./db-enums";

// Values must match the CHECK constraints in packages/db/migrations literally and in order.
const CASES = [
  ["babyRole", babyRoleSchema, ["admin", "contributor"]],
  ["plan", planSchema, ["free", "plus"]],
  ["units", unitsSchema, ["metric", "imperial"]],
  [
    "photoStatus",
    photoStatusSchema,
    ["uploaded", "ingested", "queued", "analyzing", "ready", "failed"],
  ],
  ["photoApproval", photoApprovalSchema, ["pending", "approved", "rejected"]],
  [
    "photoMime",
    photoMimeSchema,
    ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"],
  ],
  ["derivativeKind", derivativeKindSchema, ["thumb", "display", "analysis"]],
  ["measurementKind", measurementKindSchema, ["weight", "height", "head"]],
  ["measurementUnit", measurementUnitSchema, ["g", "kg", "oz", "lb", "mm", "cm", "in"]],
  [
    "milestoneCategory",
    milestoneCategorySchema,
    ["social", "motor", "feeding", "growth", "speech", "event", "custom"],
  ],
  [
    "aiBatchStatus",
    aiBatchStatusSchema,
    ["building", "submitted", "in_progress", "completed", "failed", "expired", "cancelled"],
  ],
  ["shareRuleMode", shareRuleModeSchema, ["all", "milestones", "tags"]],
  ["sharedPhotoAddedBy", sharedPhotoAddedBySchema, ["user", "rule"]],
  ["chatRole", chatRoleSchema, ["user", "assistant", "tool", "system"]],
] as const;

describe("db enums", () => {
  it.each(CASES)(
    "%s has exactly the CHECK-constraint values, in order",
    (_name, schema, values) => {
      expect([...schema.options]).toEqual([...values]);
      for (const v of values) expect(schema.safeParse(v).success).toBe(true);
    },
  );

  it.each(CASES)("%s rejects unknown, empty and wrongly cased values", (_name, schema) => {
    for (const bad of ["", "owner", "viewer", "ADMIN", null, undefined, 1]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });

  it("viewer is not a baby_members role (viewers have no account)", () => {
    expect(babyRoleSchema.safeParse("viewer").success).toBe(false);
  });

  it("free-tier gate: only free and plus plans exist", () => {
    expect(planSchema.options).toEqual(["free", "plus"]);
  });
});
