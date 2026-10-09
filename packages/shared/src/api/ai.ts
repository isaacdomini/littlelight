import { z } from "zod";
import {
  aiDescriptionV1Schema,
  aiOverrideFieldSchema,
  aiOverrideValueSchema,
} from "../ai-description";
import { aiFailureKindSchema } from "../db-enums";
import { isoDateTimeSchema } from "./common";

// AI contracts of the API (docs/plans/step-6.md 2.4, 2.8; PRD "FR-5 AI photo understanding
// (batch)", FR-5.6 overrides). The API never calls a model; these describe what the worker
// stored. Override values are user content: never logged, never audited (only the field name).

/**
 * Per-photo AI state, derived (never stored) from the baby's entitlement, `photos.status`,
 * `photo_ai` and `ai_batch_items`:
 * - `not_available`: the baby has no AI entitlement (free tier / expired), or the photo has no
 *   analysis derivative yet. Such photos are never sent to a model.
 * - `pending`: eligible, not yet claimed into a batch.
 * - `queued`: claimed into the building batch (`photos.status = queued`).
 * - `analyzing`: submitted to the provider (`photos.status = analyzing`).
 * - `ready`: a `photo_ai` row exists.
 * - `failed`: `AI_MAX_ATTEMPTS` failed attempts for the current versions since the last admin
 *   retry request (the photo itself stays visible: `photos.status` is never `failed` for AI).
 */
export const AI_STATUSES = [
  "not_available",
  "pending",
  "queued",
  "analyzing",
  "ready",
  "failed",
] as const;
export const aiStatusSchema = z.enum(AI_STATUSES);
export type PhotoAiStatus = z.infer<typeof aiStatusSchema>;

/** Current parent overrides of one photo (`photo_ai_overrides`), keyed by field. */
export const photoAiOverridesSchema = z.partialRecord(
  aiOverrideFieldSchema,
  z.union([z.string(), z.array(z.string())]),
);
export type PhotoAiOverrides = z.infer<typeof photoAiOverridesSchema>;

/**
 * The `ai` block of `GET /photos/:id`.
 * - `description`: model output with overrides applied (`applyAiOverrides`; overrides win).
 *   `null` unless `ready`, and also `null` when an old-version row no longer validates (the UI
 *   shows "being re-analysed"; `schemaVersion` tells which).
 * - `raw`: model output without overrides; admins only (`null` for contributors).
 * - `failure`: the latest failed attempt's category (never a provider message).
 * - `canRetry`: admin AND `status === "failed"`.
 */
export const photoAiSchema = z.object({
  status: aiStatusSchema,
  description: aiDescriptionV1Schema.nullable(),
  raw: aiDescriptionV1Schema.nullable(),
  overrides: photoAiOverridesSchema,
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  schemaVersion: z.string().nullable(),
  analyzedAt: isoDateTimeSchema.nullable(),
  failure: aiFailureKindSchema.nullable(),
  canRetry: z.boolean(),
});
export type PhotoAi = z.infer<typeof photoAiSchema>;

/**
 * `PATCH /photos/:id/ai` → `photo` (FR-5.6; admins). Per provided key: a value sets the
 * override, `null` clears it (the AI value shows again). At least one key. Limits: caption 1..200
 * chars, detailed_description 1..1200, search_tags 1..20 lowercase tags of ≤ 60 chars.
 */
export const photoAiOverridePatchSchema = z
  .object({
    caption: aiOverrideValueSchema("caption").nullable().optional(),
    detailed_description: aiOverrideValueSchema("detailed_description").nullable().optional(),
    search_tags: aiOverrideValueSchema("search_tags").nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nothing to update",
  });
export type PhotoAiOverridePatch = z.infer<typeof photoAiOverridePatchSchema>;

/** `POST /photos/:id/ai/retry` (admins, only when `ai.status === "failed"`) → `{status: "pending"}`. */
export const aiRetryResponseSchema = z.object({ status: aiStatusSchema });
export type AiRetryResponse = z.infer<typeof aiRetryResponseSchema>;

/** A UTC calendar month `YYYY-MM` (usage endpoint, `ai.budget_exceeded` audit metadata). */
export const aiUsageMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be YYYY-MM");

/** `GET /babies/:id/ai/usage?month=YYYY-MM` (admins); default the current UTC month. */
export const aiUsageQuerySchema = z.object({
  month: aiUsageMonthSchema.optional(),
});
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;

const count = z.number().int().nonnegative();

/**
 * `GET /babies/:id/ai/usage` response. `costUsd` = `ai_baby_month_cost_usd` for the month;
 * `budgetUsd` = `AI_BABY_MONTHLY_BUDGET_USD`; `photos` counts live approved photos by
 * `aiStatus` (a free baby has every photo in `not_available` and `costUsd` 0);
 * `lastCompletedAt` = latest succeeded attempt.
 */
export const aiUsageResponseSchema = z.object({
  month: aiUsageMonthSchema,
  costUsd: z.number().nonnegative(),
  budgetUsd: z.number().nonnegative(),
  photos: z.object({
    not_available: count,
    pending: count,
    queued: count,
    analyzing: count,
    ready: count,
    failed: count,
  }),
  lastCompletedAt: isoDateTimeSchema.nullable(),
});
export type AiUsageResponse = z.infer<typeof aiUsageResponseSchema>;

/**
 * User-facing messages of the AI routes' 409 `conflict` responses (docs/plans/step-6.md 2.8).
 * No new error codes: the API uses `conflict` and `validation_failed`.
 */
export const AI_CONFLICT_MESSAGES = {
  notAvailable: "AI descriptions are part of Plus",
  noDescription: "This photo has no AI description yet",
  notFailed: "This photo's analysis has not failed",
} as const;
