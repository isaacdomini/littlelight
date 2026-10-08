import { z } from "zod";
import { photoApprovalSchema, photoMimeSchema, photoStatusSchema } from "../db-enums";
import { isoDateTimeSchema } from "./common";
import { measurementSchema } from "./measurements";

// `/api/babies/:id/photos` and `/api/photos/:id…` contracts (docs/plans/step-4.md 2.4, 2.6, 2.10;
// PRD "FR-6 Storage and indexing", "FR-8 Browsing"). URLs are presigned `GetObject` URLs for
// exactly one `thumb` or `display` key (never `analysis`), valid ≤ `SIGNED_URL_TTL_SEC`;
// `urlExpiresAt` tells the client when to refetch. No schema here carries GPS or `raw_json`.
// Step 5 (docs/plans/step-5.md 2.4, 2.6; PRD "FR-3", "FR-8") adds the milestone and the
// override-aware AI caption to every summary, the timeline summary (age groups + jump cursors),
// bidirectional keyset paging, batch URL refresh and parent-details editing (one or many photos).

/** Limits of parent-supplied details (`photo_details`), trimmed; the DB enforces the caps too. */
export const PHOTO_DETAILS_LIMITS = {
  /** Chips per photo (`CHECK (cardinality(people) <= 20)`). */
  people: 20,
  /** Characters per person chip. */
  personName: 60,
  note: 2000,
  /** `CHECK (length(location_label) <= 120)`. */
  locationLabel: 120,
} as const;

/** Max photo ids per `…/photos/urls` or `…/photos/details` request. */
export const PHOTO_BATCH_MAX = 500;

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
  /** `photo_details.milestone_id` (preset or a custom milestone of this baby). */
  milestoneId: z.uuid().nullable(),
  /**
   * The parent's caption override, else the AI caption (`photo_ai_overrides` field `caption`,
   * then `photo_ai.description.caption`); null when neither exists. Alt text and the details
   * panel; render as text, never HTML.
   */
  caption: z.string().nullable(),
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
  /** Measurements linked to this photo (`measurements.photo_id`), by `measuredAt` ascending. */
  measurements: z.array(measurementSchema),
  /**
   * Whether the caller may edit details / delete: admin, or the uploader of a live photo still
   * `pending` (the DB's `photo_editable` rule; RLS enforces it, this only drives the UI).
   */
  canEdit: z.boolean(),
});
export type Photo = z.infer<typeof photoSchema>;

/** `album` (default), `pending` (approval queue), `trash` (admin). */
export const photosViewSchema = z.enum(["album", "pending", "trash"]);
export type PhotosView = z.infer<typeof photosViewSchema>;

/** Opaque keyset cursor (base64url). */
const cursorSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Paging direction from `cursor`: `older` (default) returns items after it in timeline order,
 * `newer` the items just before it (loading upwards after a scrubber jump). Both return items
 * newest first.
 */
export const photosListDirSchema = z.enum(["older", "newer"]);
export type PhotosListDir = z.infer<typeof photosListDirSchema>;

/**
 * `GET /babies/:id/photos` query. `cursor` is the opaque `nextCursor` (with `dir=older`) or
 * `prevCursor` (with `dir=newer`) of a page, or a group `cursor` from the summary; `limit`
 * arrives as a query string and is coerced. `milestoneId` keeps only photos tagged with it.
 */
export const photosListQuerySchema = z.object({
  view: photosViewSchema.default("album"),
  cursor: cursorSchema.optional(),
  dir: photosListDirSchema.default("older"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  milestoneId: z.uuid().optional(),
});
export type PhotosListQuery = z.infer<typeof photosListQuerySchema>;

/** Newest first (`COALESCE(taken_at, created_at) DESC, id DESC`). */
export const photosListResponseSchema = z.object({
  photos: z.array(photoSummarySchema),
  /** Cursor of the last item (fetch with `dir=older`); null when there is nothing older. */
  nextCursor: z.string().nullable(),
  /** Cursor of the first item (fetch with `dir=newer`); null when the page is empty. */
  prevCursor: z.string().nullable(),
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

/** `GET /babies/:id/photos/summary` query. */
export const photosSummaryQuerySchema = z.object({
  view: photosViewSchema.default("album"),
});
export type PhotosSummaryQuery = z.infer<typeof photosSummaryQuerySchema>;

/**
 * One age group of the timeline (`ageGroupKey`, e.g. `m4`). `cursor` starts a
 * `GET …/photos?cursor=` stream exactly at the group's newest item.
 */
export const photoGroupSchema = z.object({
  key: z.string(),
  count: z.number().int().nonnegative(),
  cursor: z.string(),
});
export type PhotoGroup = z.infer<typeof photoGroupSchema>;

/** Groups newest first (descending `ageGroupSortValue`); counts sum to `total`. */
export const photosSummaryResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  groups: z.array(photoGroupSchema),
});
export type PhotosSummaryResponse = z.infer<typeof photosSummaryResponseSchema>;

/** `POST /babies/:id/photos/urls`: fresh signed URLs for these photos. */
export const photoUrlsRequestSchema = z.object({
  photoIds: z.array(z.uuid()).min(1).max(PHOTO_BATCH_MAX),
});
export type PhotoUrlsRequest = z.infer<typeof photoUrlsRequestSchema>;

/** Fresh URLs of one photo (same meaning as in `photoSchema`). */
export const photoUrlSetSchema = z.object({
  thumbUrl: z.url().nullable(),
  displayUrl: z.url().nullable(),
  urlExpiresAt: isoDateTimeSchema.nullable(),
});
export type PhotoUrlSet = z.infer<typeof photoUrlSetSchema>;

/** Keyed by photo id; ids the caller cannot see (or that do not exist) are absent. */
export const photoUrlsResponseSchema = z.object({
  urls: z.record(z.uuid(), photoUrlSetSchema),
});
export type PhotoUrlsResponse = z.infer<typeof photoUrlsResponseSchema>;

const personSchema = z.string().trim().min(1).max(PHOTO_DETAILS_LIMITS.personName);
const noteSchema = z.string().trim().max(PHOTO_DETAILS_LIMITS.note).nullable();
const locationLabelSchema = z.string().trim().max(PHOTO_DETAILS_LIMITS.locationLabel).nullable();

/**
 * `PATCH /photos/:id/details` → `photo`. Only provided keys change: `people` replaces the
 * array, `null` clears a scalar. At least one key.
 */
export const photoDetailsPatchSchema = z
  .object({
    milestoneId: z.uuid().nullable().optional(),
    people: z.array(personSchema).max(PHOTO_DETAILS_LIMITS.people).optional(),
    note: noteSchema.optional(),
    locationLabel: locationLabelSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nothing to update",
  });
export type PhotoDetailsPatch = z.infer<typeof photoDetailsPatchSchema>;

/**
 * `POST /babies/:id/photos/details` (FR-3.1 batch). Scalars as in the PATCH; `addPeople` is
 * merged into each photo's people (union; a photo that would exceed 20 is skipped). At least
 * one change.
 */
export const photosBatchDetailsRequestSchema = z
  .object({
    photoIds: z.array(z.uuid()).min(1).max(PHOTO_BATCH_MAX),
    milestoneId: z.uuid().nullable().optional(),
    addPeople: z.array(personSchema).max(PHOTO_DETAILS_LIMITS.people).optional(),
    locationLabel: locationLabelSchema.optional(),
    note: noteSchema.optional(),
  })
  .refine(
    (v) =>
      v.milestoneId !== undefined ||
      (v.addPeople !== undefined && v.addPeople.length > 0) ||
      v.locationLabel !== undefined ||
      v.note !== undefined,
    { message: "Nothing to update" },
  );
export type PhotosBatchDetailsRequest = z.infer<typeof photosBatchDetailsRequestSchema>;

/** `skipped`: ids hidden by RLS, not editable by the caller, or over the people cap. */
export const photosBatchDetailsResponseSchema = z.object({
  updated: z.array(z.uuid()),
  skipped: z.array(z.uuid()),
});
export type PhotosBatchDetailsResponse = z.infer<typeof photosBatchDetailsResponseSchema>;
