import { z } from "zod";
import { mediaKindSchema, mediaMimeSchema } from "../db-enums";
import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES_PER_REQUEST,
  UPLOAD_MAX_VIDEO_BYTES,
  uploadFileErrorSchema,
  uploadFileStateSchema,
} from "../upload";
import { VIDEO_MAX_DURATION_MS } from "../video";
import { isoDateTimeSchema } from "./common";
import { photoSummarySchema } from "./photos";

// `/api/babies/:id/uploads` and `/api/uploads/…` contracts (docs/plans/step-4.md 2.4, 2.6;
// docs/plans/step-12.md 2.3, 2.4; PRD "FR-2 Upload", "FR-3 Parent-supplied details"). The
// client's `clientSha256`, `mime`, `takenAt` and `durationMs` are hints only: the worker
// re-hashes, sniffs, reads EXIF and probes videos. Part URLs are presigned `UploadPart` URLs for
// one key, plain `PUT`s with no custom headers. Videos (step 12) use the same session and parts;
// the api applies the plan's per-clip limits (`videoLimitsFor`) at register.

/** Route params `/uploads/:sessionId…`. */
export const uploadParamsSchema = z.object({ sessionId: z.uuid() });
export type UploadParams = z.infer<typeof uploadParamsSchema>;

/** Route params `/uploads/:sessionId/files/:fileId…`. */
export const uploadFileParamsSchema = z.object({ sessionId: z.uuid(), fileId: z.uuid() });
export type UploadFileParams = z.infer<typeof uploadFileParamsSchema>;

/** Batch details applied to every photo of a session (FR-3.1), stored in `photo_details`. */
export const uploadDetailsSchema = z.object({
  milestoneId: z.uuid().nullish(),
  people: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  note: z.string().trim().max(2000).nullish(),
  locationLabel: z.string().trim().max(120).nullish(),
});
export type UploadDetails = z.infer<typeof uploadDetailsSchema>;

/** `POST /babies/:id/uploads` → 201 `uploadSession`. */
export const uploadSessionCreateSchema = z.object({
  details: uploadDetailsSchema.optional(),
});
export type UploadSessionCreate = z.infer<typeof uploadSessionCreateSchema>;

/**
 * One file in `POST /uploads/:sessionId/files`. `kind` defaults to `photo`; a `video` may declare
 * up to `UPLOAD_MAX_VIDEO_BYTES` (the api then applies the plan's cap: `failed / file_too_large`),
 * a photo up to `UPLOAD_MAX_FILE_BYTES`. `durationMs` is the client's `loadedmetadata` read, a
 * hint for the early `video_too_long` outcome (the worker re-checks after ffprobe).
 */
export const uploadFileRegisterSchema = z
  .object({
    /** The browser's handle for the file, echoed back. */
    clientId: z.string().min(1).max(64),
    kind: mediaKindSchema.default("photo"),
    bytes: z.number().int().min(1).max(UPLOAD_MAX_VIDEO_BYTES),
    /** Lowercase hex SHA-256 for the instant duplicate pre-check; never trusted. */
    clientSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    mime: mediaMimeSchema.optional(),
    /** Capture-time hint from the client's EXIF read. */
    takenAt: isoDateTimeSchema.optional(),
    tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    /** Video duration hint, milliseconds (videos only). */
    durationMs: z.number().int().min(1).max(VIDEO_MAX_DURATION_MS).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.kind === "photo" && f.bytes > UPLOAD_MAX_FILE_BYTES) {
      ctx.addIssue({
        code: "too_big",
        origin: "number",
        maximum: UPLOAD_MAX_FILE_BYTES,
        inclusive: true,
        path: ["bytes"],
        message: `a photo must be at most ${UPLOAD_MAX_FILE_BYTES} bytes`,
      });
    }
    if (f.kind === "photo" && f.durationMs !== undefined) {
      ctx.addIssue({ code: "custom", path: ["durationMs"], message: "only for videos" });
    }
  });
export type UploadFileRegister = z.infer<typeof uploadFileRegisterSchema>;
/** The wire shape (before defaults): `kind` may be omitted. */
export type UploadFileRegisterInput = z.input<typeof uploadFileRegisterSchema>;

export const uploadFilesRegisterRequestSchema = z.object({
  files: z.array(uploadFileRegisterSchema).min(1).max(UPLOAD_MAX_FILES_PER_REQUEST),
});
export type UploadFilesRegisterRequest = z.infer<typeof uploadFilesRegisterRequestSchema>;

/** A presigned `UploadPart` URL (TTL ≤ `SIGNED_URL_TTL_SEC`). */
export const uploadPartSchema = z.object({
  partNumber: z.number().int().min(1),
  url: z.url(),
});
export type UploadPart = z.infer<typeof uploadPartSchema>;

export const uploadFileSchema = z.object({
  /** `upload_files.id`, which becomes `photos.id` on complete. */
  id: z.uuid(),
  clientId: z.string().nullable(),
  /** `upload_files.media_kind`, as registered (the worker's sniff is the truth and may flip the photo row). */
  kind: mediaKindSchema,
  state: uploadFileStateSchema,
  error: uploadFileErrorSchema.nullable(),
  bytes: z.number().int(),
  partSize: z.number().int(),
  partCount: z.number().int(),
  /** Exact duplicate pre-check hit (`null` when the duplicate is earlier in the same session). */
  duplicateOfPhotoId: z.uuid().nullable(),
  photo: photoSummarySchema.nullable(),
  /** Only in register and parts responses: the part URLs still to upload. */
  parts: z.array(uploadPartSchema).optional(),
});
export type UploadFile = z.infer<typeof uploadFileSchema>;

/** Per-state counts of a session's files. */
export const uploadSummarySchema = z.object({
  registered: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  ingested: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  aborted: z.number().int().nonnegative(),
});
export type UploadSummary = z.infer<typeof uploadSummarySchema>;

/** `GET /uploads/:sessionId` (polled while any file is `completed`). */
export const uploadSessionSchema = z.object({
  id: z.uuid(),
  babyId: z.uuid(),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  details: uploadDetailsSchema,
  summary: uploadSummarySchema,
  files: z.array(uploadFileSchema),
});
export type UploadSession = z.infer<typeof uploadSessionSchema>;

export const uploadFilesRegisterResponseSchema = z.object({
  files: z.array(uploadFileSchema),
});
export type UploadFilesRegisterResponse = z.infer<typeof uploadFilesRegisterResponseSchema>;

/** `GET /uploads/:sessionId/files/:fileId/parts` (resume). */
export const uploadPartsResponseSchema = z.object({
  uploadedPartNumbers: z.array(z.number().int().min(1)),
  parts: z.array(uploadPartSchema),
});
export type UploadPartsResponse = z.infer<typeof uploadPartsResponseSchema>;
