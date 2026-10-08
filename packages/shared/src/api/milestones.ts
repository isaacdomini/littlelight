import { z } from "zod";
import { milestoneCategorySchema } from "../db-enums";
import { isoDateTimeSchema } from "./common";
import { photoSummarySchema } from "./photos";

// `/api/babies/:id/milestones` and `/api/milestones/:id` contracts (docs/plans/step-5.md 2.4,
// 2.6; PRD "FR-3 Parent-supplied details", "FR-8 Browsing", "Data model" → `milestones`).
// Presets (`babyId: null`, `MILESTONE_PRESETS`) are readable by everyone in the album and never
// writable; custom milestones are admin-only to create/rename/delete (RLS), at most
// `MAX_CUSTOM_MILESTONES_PER_BABY` per baby, names unique per baby case-insensitively and never
// equal to a preset's name (409). Names are never audited or logged.

/** Max length of a milestone name (trimmed). */
export const MILESTONE_NAME_MAX = 80;

/** Route params `/milestones/:id`. */
export const milestoneIdParamsSchema = z.object({ id: z.uuid() });
export type MilestoneIdParams = z.infer<typeof milestoneIdParamsSchema>;

export const milestoneSchema = z.object({
  id: z.uuid(),
  /** `null` for a preset. */
  babyId: z.uuid().nullable(),
  name: z.string(),
  category: milestoneCategorySchema,
  isPreset: z.boolean(),
  sortOrder: z.number().int(),
  /** Live approved photos of this baby tagged with the milestone. */
  photoCount: z.number().int().nonnegative(),
  /** Earliest `COALESCE(taken_at, created_at)` among those photos. */
  firstTakenAt: isoDateTimeSchema.nullable(),
  /** That earliest photo (signed thumb), or null when there is none. */
  coverPhoto: photoSummarySchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type Milestone = z.infer<typeof milestoneSchema>;

const milestoneNameSchema = z.string().trim().min(1).max(MILESTONE_NAME_MAX);

/** `POST /babies/:id/milestones` → 201 `milestone`. */
export const milestoneCreateSchema = z.object({
  name: milestoneNameSchema,
  category: milestoneCategorySchema.default("custom"),
});
export type MilestoneCreate = z.infer<typeof milestoneCreateSchema>;

/** `PATCH /milestones/:id` → `milestone` (custom only). At least one key. */
export const milestoneUpdateSchema = z
  .object({
    name: milestoneNameSchema.optional(),
    category: milestoneCategorySchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.category !== undefined, {
    message: "Nothing to update",
  });
export type MilestoneUpdate = z.infer<typeof milestoneUpdateSchema>;

/** `GET /babies/:id/milestones`: presets by `sortOrder`, then custom ones by `createdAt`. */
export const milestonesListResponseSchema = z.object({
  milestones: z.array(milestoneSchema),
});
export type MilestonesListResponse = z.infer<typeof milestonesListResponseSchema>;
