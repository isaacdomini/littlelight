import { z } from "zod";
import { babyRoleSchema, planSchema } from "../db-enums";
import { isoDateSchema, isoDateTimeSchema } from "./common";

// `/api/babies` contracts (docs/plans/step-3.md 2.4, 2.6; PRD FR-1.2). Weights are grams and
// lengths millimetres (storage is always metric; `profiles.units` is display only). Billing
// columns (`plan`, owner, entitlement) are never writable through these schemas.

const babyNameSchema = z.string().trim().min(1).max(80);

/**
 * `POST /babies` → 201 `baby`. `birthDate` is the due date when `birthDateIsDueDate` is true.
 * Optional fields also accept `null` (meaning "none"), so `babyUpdateSchema` can clear them.
 */
export const babyCreateSchema = z.object({
  name: babyNameSchema,
  nickname: z.string().trim().min(1).max(80).nullish(),
  birthDate: isoDateSchema,
  birthDateIsDueDate: z.boolean().optional(),
  birthWeightG: z.number().int().positive().max(15_000).nullish(),
  birthLengthMm: z.number().int().positive().max(1_000).nullish(),
});
export type BabyCreate = z.infer<typeof babyCreateSchema>;

/** `PATCH /babies/:id` (admin) → `baby`. Any subset of the create fields, at least one. */
export const babyUpdateSchema = babyCreateSchema
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "at least one field is required",
  });
export type BabyUpdate = z.infer<typeof babyUpdateSchema>;

export const babySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nickname: z.string().nullable(),
  birthDate: isoDateSchema,
  birthDateIsDueDate: z.boolean(),
  birthWeightG: z.number().int().nullable(),
  birthLengthMm: z.number().int().nullable(),
  avatarPhotoId: z.uuid().nullable(),
  plan: planSchema,
  /** The caller's role in this baby. */
  role: babyRoleSchema,
  createdAt: isoDateTimeSchema,
  /** Set when trashed (soft delete); only admins ever see trashed babies. */
  deletedAt: isoDateTimeSchema.nullable(),
});
export type Baby = z.infer<typeof babySchema>;

/** Compact form for `GET /me` and the header baby switcher (live babies only). */
export const babySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nickname: z.string().nullable(),
  birthDate: isoDateSchema,
  plan: planSchema,
  role: babyRoleSchema,
});
export type BabySummary = z.infer<typeof babySummarySchema>;

/** `GET /babies`. */
export const babiesListResponseSchema = z.object({ babies: z.array(babySchema) });
export type BabiesListResponse = z.infer<typeof babiesListResponseSchema>;
