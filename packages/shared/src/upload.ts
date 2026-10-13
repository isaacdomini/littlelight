import { z } from "zod";
import {
  type DerivativeKind,
  derivativeKindSchema,
  type ImageDerivativeKind,
  type MediaKind,
  type MediaMime,
  mediaMimeSchema,
} from "./db-enums";
import { VIDEO_LIMITS } from "./video";

// Upload and storage contracts (docs/plans/step-4.md 2.2, 2.6; docs/plans/step-12.md 2.3; PRD
// "FR-2 Upload", "FR-6 Storage and indexing"). Browser-safe: no Node imports. Photo and video
// bytes never pass through the API: the browser PUTs pre-signed multipart parts straight to
// MinIO; the worker writes derivatives and renditions.

const MIB = 1024 * 1024;

/** Multipart part size (16 MiB): far under Cloudflare's 100 MB request body cap. */
export const UPLOAD_PART_BYTES = 16 * MIB;
/** Largest accepted **photo** original (100 MiB = 104857600; the `import_items.bytes` photo cap). */
export const UPLOAD_MAX_FILE_BYTES = 100 * MIB;
/**
 * Largest accepted **video** original (2 GiB = 2147483648, the Plus per-clip cap and the
 * `upload_files.declared_bytes` CHECK since migration 22). The per-plan video cap
 * (`videoLimitsFor(plan).maxBytes`) is enforced by the api at register and by the worker after
 * ffprobe, not by a CHECK.
 */
export const UPLOAD_MAX_VIDEO_BYTES: number = VIDEO_LIMITS.plus.maxBytes;

/** The largest original accepted for a media kind (`UPLOAD_MAX_FILE_BYTES` / `UPLOAD_MAX_VIDEO_BYTES`). */
export function uploadMaxBytesFor(kind: MediaKind): number {
  return kind === "video" ? UPLOAD_MAX_VIDEO_BYTES : UPLOAD_MAX_FILE_BYTES;
}
/** Files per upload session (FR-2.1; `upload_files_session_owner` trigger). */
export const UPLOAD_MAX_FILES_PER_SESSION = 500;
/** Files per `POST /uploads/:sessionId/files` request. */
export const UPLOAD_MAX_FILES_PER_REQUEST = 100;
/** Upload sessions expire this long after creation (`upload_sessions.expires_at` default). */
export const UPLOAD_SESSION_TTL_HOURS = 24;
/** Files in flight per client (parts of one file are sent sequentially). */
export const UPLOAD_CONCURRENCY = 4;
/** Lifetime of every signed URL (PRD "valid ≤ 1 hour", one object per URL). */
export const SIGNED_URL_TTL_SEC = 3600;

/**
 * Accepted original types (photos, then videos: `mediaMimeSchema.options`); the worker sniffs
 * magic bytes, the client's value is a hint only.
 */
export const ACCEPTED_UPLOAD_MIMES = mediaMimeSchema.options;
/** File-picker extensions (lowercase, with the dot); `.mp4`, `.mov`, `.m4v` are videos. */
export const ACCEPTED_UPLOAD_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".webp",
  ".mp4",
  ".mov",
  ".m4v",
] as const;
export type AcceptedUploadExtension = (typeof ACCEPTED_UPLOAD_EXTENSIONS)[number];
/** The video members of `ACCEPTED_UPLOAD_EXTENSIONS`. */
export const ACCEPTED_VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
] as const satisfies readonly AcceptedUploadExtension[];

/**
 * Long edge in px of each JPEG derivative (`fit: inside`, never enlarged). For a video these are
 * rendered from its poster frame; the `web` rendition's long edge is `VIDEO_RENDITION.longEdge`
 * and the keyframes' `VIDEO_KEYFRAME_LONG_EDGE` (video.ts).
 */
export const DERIVATIVE_LONG_EDGE = {
  thumb: 320,
  display: 1600,
  analysis: 768,
} as const satisfies Record<ImageDerivativeKind, number>;
/** JPEG quality of every derivative (mozjpeg, progressive, no metadata). */
export const DERIVATIVE_JPEG_QUALITY = 75;
/** Max Hamming distance (of 64 bits) between pHashes for a near-duplicate flag. */
export const PHASH_NEAR_DUPLICATE_MAX_DISTANCE = 10;

/**
 * `upload_files.state`. Values match the migration CHECK literally and in order.
 * `registered` → `completed` (api) → `ingested` | `duplicate` | `failed` (worker); `aborted` by
 * the user or the sweep.
 */
export const uploadFileStateSchema = z.enum([
  "registered",
  "completed",
  "ingested",
  "duplicate",
  "failed",
  "aborted",
]);
export type UploadFileState = z.infer<typeof uploadFileStateSchema>;

/**
 * `upload_files.error`. Values match the migration CHECK literally and in order; step 11 appends
 * `pending_limit` (the uploader's pending queue in this family is full, `photos_pending_cap`);
 * step 12 appends `video_too_long` (over the plan's `maxSeconds`, at register from the client's
 * hint or at ingest from ffprobe) and `transcode_failed` (the `web` rendition could not be built
 * after every retry; the row stays live with its poster).
 */
export const uploadFileErrorSchema = z.enum([
  "unsupported_media_type",
  "file_too_large",
  "decode_failed",
  "free_tier_limit",
  "rejected",
  "expired",
  "storage_error",
  "upload_incomplete",
  "pending_limit",
  "video_too_long",
  "transcode_failed",
]);
export type UploadFileError = z.infer<typeof uploadFileErrorSchema>;

/**
 * Number of `UPLOAD_PART_BYTES` parts for a file of `bytes` bytes (the last part may be
 * smaller). Throws `RangeError` unless `bytes` is a positive safe integer.
 */
export function partCount(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new RangeError("bytes must be a positive integer");
  }
  return Math.ceil(bytes / UPLOAD_PART_BYTES);
}

// Object keys are built only from uuids (and a derivative kind), so no caller-supplied string
// can introduce `/`, `..` or another baby's prefix.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) throw new TypeError(`${name} must be a uuid`);
}

/** `babies/{babyId}/` — everything stored for one baby (baby purge is a prefix delete). */
export function babyPrefix(babyId: string): string {
  assertUuid(babyId, "babyId");
  return `babies/${babyId}/`;
}

/** `babies/{babyId}/originals/{photoId}` (no extension; `photos.mime` is the sniffed type). */
export function originalKey(babyId: string, photoId: string): string {
  assertUuid(photoId, "photoId");
  return `${babyPrefix(babyId)}originals/${photoId}`;
}

/** File extension of a derivative kind: the `web` rendition is an MP4, everything else a JPEG. */
export function derivativeExtension(kind: DerivativeKind): "jpg" | "mp4" {
  return derivativeKindSchema.parse(kind) === "web" ? "mp4" : "jpg";
}

/**
 * `babies/{babyId}/derivatives/{photoId}/{kind}.jpg` (metadata-free JPEG), or
 * `…/derivatives/{photoId}/web.mp4` for a video's rendition. All under the photo's derivatives
 * prefix, so `photoPrefixes` deletion covers every kind.
 */
export function derivativeKey(babyId: string, photoId: string, kind: DerivativeKind): string {
  assertUuid(photoId, "photoId");
  const k = derivativeKindSchema.parse(kind);
  return `${babyPrefix(babyId)}derivatives/${photoId}/${k}.${derivativeExtension(k)}`;
}

/**
 * The two prefixes that hold every object of one photo, for version-aware deletion:
 * `[originalKey, "babies/{babyId}/derivatives/{photoId}/"]`. Uuids are fixed length, so the
 * original key matches no other photo's key as a prefix.
 */
export function photoPrefixes(babyId: string, photoId: string): readonly [string, string] {
  assertUuid(photoId, "photoId");
  return [originalKey(babyId, photoId), `${babyPrefix(babyId)}derivatives/${photoId}/`] as const;
}

/**
 * `babies/{babyId}/exports/{exportId}.zip`: the ZIP of one data export (FR-10.1). Equals the
 * generated `data_exports.storage_key` column, so the api can sign a download URL without
 * selecting that column (`authenticated` has no grant on it). Under `babyPrefix`, so a baby
 * purge deletes it with everything else.
 */
export function exportKey(babyId: string, exportId: string): string {
  assertUuid(exportId, "exportId");
  return `${babyPrefix(babyId)}exports/${exportId}.zip`;
}

const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
} as const satisfies Record<MediaMime, string>;

/**
 * File extension without the dot for a photo or video mime, e.g. for
 * `Content-Disposition: attachment; filename="<photoId>.<ext>"`.
 */
export function extensionForMime(mime: MediaMime): (typeof MIME_EXTENSIONS)[MediaMime] {
  return MIME_EXTENSIONS[mediaMimeSchema.parse(mime)];
}
