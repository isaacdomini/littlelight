import { z } from "zod";
import { photoApprovalSchema, photoMimeSchema, photoStatusSchema } from "../db-enums";
import { isoDateTimeSchema } from "./common";

// `/api/babies/:id/photos` and `/api/photos/:id…` contracts (docs/plans/step-4.md 2.4, 2.6, 2.10;
// PRD "FR-6 Storage and indexing", "FR-8 Browsing"). URLs are presigned `GetObject` URLs for
// exactly one `thumb` or `display` key (never `analysis`), valid ≤ `SIGNED_URL_TTL_SEC`;
// `urlExpiresAt` tells the client when to refetch. No schema here carries GPS or `raw_json`.

/** Route params `/photos/:id…`. */
export const photoIdParamsSchema = z.object({ id: z.uuid() });
export type PhotoIdParams = z.infer<typeof photoIdParamsSchema>;

export const photoSummarySchema = z.object({
  id: z.uuid(),
  babyId: z.uuid(),
  status: photoStatusSchema,
  approval: photoApprovalSchema,
  takenAt: isoDateTimeSchema.nullable(),
  /** True when `takenAt` was estimated (no EXIF date: upload time or the client's hint). */
  takenAtEstimated: z.boolean(),
  /** Calendar days since the birth date at the local capture date; negative before birth. */
  ageDays: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Sniffed type of the original (null until ingest). */
  mime: photoMimeSchema.nullable(),
  isSensitive: z.boolean(),
  /** Near-duplicate (pHash) of an earlier live photo; flag only. */
  duplicateOfPhotoId: z.uuid().nullable(),
  uploadedBy: z.uuid().nullable(),
  createdAt: isoDateTimeSchema,
  deletedAt: isoDateTimeSchema.nullable(),
  /** Signed URL of the `thumb` derivative; null until it exists. */
  thumbUrl: z.url().nullable(),
  /** Expiry of the URLs in this object; null when there are none. */
  urlExpiresAt: isoDateTimeSchema.nullable(),
});
export type PhotoSummary = z.infer<typeof photoSummarySchema>;

/** The authenticated-visible columns of `photo_exif`: never GPS, never `raw_json`. */
export const photoExifSchema = z.object({
  takenAt: isoDateTimeSchema.nullable(),
  tzOffsetMinutes: z.number().int().nullable(),
  cameraMake: z.string().nullable(),
  cameraModel: z.string().nullable(),
  placeLabel: z.string().nullable(),
});
export type PhotoExif = z.infer<typeof photoExifSchema>;

/** `photo_details` (parent-supplied, FR-3). */
export const photoDetailsSchema = z.object({
  milestoneId: z.uuid().nullable(),
  note: z.string().nullable(),
  people: z.array(z.string()),
  locationLabel: z.string().nullable(),
});
export type PhotoDetails = z.infer<typeof photoDetailsSchema>;

/** `GET /photos/:id`. */
export const photoSchema = photoSummarySchema.extend({
  /** Signed URL of the `display` derivative; null until it exists. */
  displayUrl: z.url().nullable(),
  exif: photoExifSchema.nullable(),
  details: photoDetailsSchema.nullable(),
});
export type Photo = z.infer<typeof photoSchema>;

/** `album` (default), `pending` (approval queue), `trash` (admin). */
export const photosViewSchema = z.enum(["album", "pending", "trash"]);
export type PhotosView = z.infer<typeof photosViewSchema>;

/**
 * `GET /babies/:id/photos` query. `cursor` is the opaque `nextCursor` of the previous page
 * (base64url); `limit` arrives as a query string and is coerced.
 */
export const photosListQuerySchema = z.object({
  view: photosViewSchema.default("album"),
  cursor: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type PhotosListQuery = z.infer<typeof photosListQuerySchema>;

/** Newest first (`COALESCE(taken_at, created_at) DESC, id DESC`). */
export const photosListResponseSchema = z.object({
  photos: z.array(photoSummarySchema),
  nextCursor: z.string().nullable(),
  /** Pending (unapproved, not trashed) photos visible to the caller: the admin badge. */
  pendingCount: z.number().int().nonnegative(),
});
export type PhotosListResponse = z.infer<typeof photosListResponseSchema>;

/** `GET /photos/:id/original` (admins only): a signed download URL for the untouched original. */
export const originalUrlResponseSchema = z.object({
  url: z.url(),
  expiresAt: isoDateTimeSchema,
});
export type OriginalUrlResponse = z.infer<typeof originalUrlResponseSchema>;
