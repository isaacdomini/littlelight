import { z } from "zod";
import { EXPORT_LIST_LIMIT } from "../constants";
import { isoDateTimeSchema } from "./common";

// Data export contracts (`/babies/:id/exports*`; PRD FR-10.1 "Export all originals + a JSON/CSV
// of metadata as a ZIP", "Roles and permissions": export data is Admin only;
// docs/plans/review-fixes.md 2.2, 2.5, D1–D5). Browser-safe.
//
// Rules:
// - Admins only (the `data_exports` RLS policies); both admins see every export of their album
//   (D3), only the requester can mint a download URL, after a fresh sign-in (D2).
// - Schemas are **strict**: a row mapper that adds `storage_key`, an email or a URL to an export
//   fails to parse (500) instead of leaking it. The storage key never appears on the wire; the
//   signed URL appears only in `exportDownloadUrlResponseSchema`, minted on demand.
// - Values of `exportStatusSchema` / `exportErrorSchema` match the migration CHECKs literally
//   and in order.

/**
 * Columns step 12 appends to `photos.csv` (and keys to each `photos.json` element), after the
 * existing metadata columns and before the optional `gps_lat`/`gps_lng`: `media_kind`
 * (`photo`/`video`), `duration_ms` (videos), `video_codec` (`h264`/`hevc`, videos). The worker's
 * `PHOTOS_CSV_COLUMNS` spreads this list; `originals/` includes videos (`.mov`/`.mp4`) as uploaded.
 */
export const EXPORT_PHOTOS_CSV_VIDEO_COLUMNS = [
  "media_kind",
  "duration_ms",
  "video_codec",
] as const;

/** `data_exports.status`: `queued` → `running` → `ready` | `failed`; `ready` → `expired` (sweep). */
export const EXPORT_STATUSES = ["queued", "running", "ready", "failed", "expired"] as const;
export const exportStatusSchema = z.enum(EXPORT_STATUSES);
export type ExportStatus = z.infer<typeof exportStatusSchema>;

/**
 * `data_exports.error` (set with `status = failed`): `storage_error` (MinIO; retried once),
 * `too_large` (selected originals exceed `EXPORT_MAX_BYTES`), `requester_not_admin` (the
 * requester lost admin rights before the job ran), `internal`.
 */
export const EXPORT_ERRORS = [
  "storage_error",
  "too_large",
  "requester_not_admin",
  "internal",
] as const;
export const exportErrorSchema = z.enum(EXPORT_ERRORS);
export type ExportError = z.infer<typeof exportErrorSchema>;

/** Route params `/babies/:id/exports/:exportId`. */
export const exportParamsSchema = z.object({ id: z.uuid(), exportId: z.uuid() });
export type ExportParams = z.infer<typeof exportParamsSchema>;

/**
 * One export as an admin of the baby sees it.
 * - `requestedBy` is null once the requester's account was deleted; `requestedByName` is their
 *   display name from `member_profiles` (null when unknown).
 * - `isMine` = requested by the caller.
 * - `photoCount` is null until the worker counted the selection; `photosDone` is progress.
 * - `bytes` is the ZIP size once ready (null before).
 * - `canDownload` = `isMine` and `ready` and not expired and not purged.
 */
export const dataExportSchema = z
  .strictObject({
    id: z.uuid(),
    babyId: z.uuid(),
    status: exportStatusSchema,
    includeLocation: z.boolean(),
    requestedBy: z.uuid().nullable(),
    requestedByName: z.string().nullable(),
    isMine: z.boolean(),
    photoCount: z.number().int().nonnegative().nullable(),
    photosDone: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().nullable(),
    error: exportErrorSchema.nullable(),
    createdAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(),
    expiresAt: isoDateTimeSchema,
    canDownload: z.boolean(),
  })
  .refine((e) => !e.canDownload || (e.isMine && e.status === "ready"), {
    path: ["canDownload"],
    message: "only the requester can download a ready export",
  });
export type DataExport = z.infer<typeof dataExportSchema>;

/**
 * `POST /babies/:id/exports` body (admin, fresh sign-in). `includeLocation` adds the decrypted
 * `gps_lat`/`gps_lng` columns to `photos.csv`/`photos.json` (D1: the UI toggle defaults on).
 * Responses: 202 `exportResponseSchema`; 403 `forbidden` (not an admin) /
 * `fresh_sign_in_required`; 409 `export_in_progress` / `baby_trashed`; 429 `rate_limited`;
 * 503 when the job could not be enqueued.
 */
export const createExportRequestSchema = z.strictObject({
  includeLocation: z.boolean(),
});
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;

/** `POST /babies/:id/exports` 202 response. */
export const exportResponseSchema = z.strictObject({ export: dataExportSchema });
export type ExportResponse = z.infer<typeof exportResponseSchema>;

/** `GET /babies/:id/exports`: the last `EXPORT_LIST_LIMIT` exports, newest first. */
export const exportsListResponseSchema = z.strictObject({
  exports: z.array(dataExportSchema).max(EXPORT_LIST_LIMIT),
});
export type ExportsListResponse = z.infer<typeof exportsListResponseSchema>;

/** Path tail of an export object: `/babies/{babyId}/exports/{exportId}.zip` (`exportKey`). */
const EXPORT_URL_PATH_RE = /\/babies\/[0-9a-f-]{36}\/exports\/[0-9a-f-]{36}\.zip$/;

/**
 * `POST /babies/:id/exports/:exportId/download-url` (requester only, fresh sign-in): a presigned
 * GET of the ZIP valid `EXPORT_URL_TTL_SEC`, as an attachment. The URL must name an export object
 * (`exportKey`), so a signer bug can never hand out an original or another key. The client opens
 * it at once and keeps it nowhere; the API never logs it. 403 `not_requester`; 410
 * `export_expired` unless ready, unexpired and unpurged.
 */
export const exportDownloadUrlResponseSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).refine((u) => {
    try {
      return EXPORT_URL_PATH_RE.test(new URL(u).pathname);
    } catch {
      return false;
    }
  }, "must be an export ZIP URL"),
  expiresAt: isoDateTimeSchema,
});
export type ExportDownloadUrlResponse = z.infer<typeof exportDownloadUrlResponseSchema>;
