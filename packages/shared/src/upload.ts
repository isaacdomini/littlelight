import { z } from "zod";
import {
  type DerivativeKind,
  derivativeKindSchema,
  type PhotoMime,
  photoMimeSchema,
} from "./db-enums";

// Upload and storage contracts (docs/plans/step-4.md 2.2, 2.6; PRD "FR-2 Upload", "FR-6 Storage
// and indexing"). Browser-safe: no Node imports. Photo bytes never pass through the API: the
// browser PUTs pre-signed multipart parts straight to MinIO; the worker writes derivatives.

const MIB = 1024 * 1024;

/** Multipart part size (16 MiB): far under Cloudflare's 100 MB request body cap. */
export const UPLOAD_PART_BYTES = 16 * MIB;
/** Largest accepted original (100 MiB = 104857600, the `upload_files.declared_bytes` CHECK). */
export const UPLOAD_MAX_FILE_BYTES = 100 * MIB;
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

/** Accepted original types; the worker sniffs magic bytes, the client's value is a hint only. */
export const ACCEPTED_UPLOAD_MIMES = photoMimeSchema.options;
/** File-picker extensions (lowercase, with the dot). */
export const ACCEPTED_UPLOAD_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".webp",
] as const;
export type AcceptedUploadExtension = (typeof ACCEPTED_UPLOAD_EXTENSIONS)[number];

/** Long edge in px of each derivative (`fit: inside`, never enlarged). */
export const DERIVATIVE_LONG_EDGE = {
  thumb: 320,
  display: 1600,
  analysis: 768,
} as const satisfies Record<DerivativeKind, number>;
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
 * `pending_limit` (the uploader's pending queue in this family is full, `photos_pending_cap`).
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

/** `babies/{babyId}/derivatives/{photoId}/{kind}.jpg` (always JPEG, metadata-free). */
export function derivativeKey(babyId: string, photoId: string, kind: DerivativeKind): string {
  assertUuid(photoId, "photoId");
  const k = derivativeKindSchema.parse(kind);
  return `${babyPrefix(babyId)}derivatives/${photoId}/${k}.jpg`;
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
} as const satisfies Record<PhotoMime, string>;

/**
 * File extension without the dot for a photo mime, e.g. for
 * `Content-Disposition: attachment; filename="<photoId>.<ext>"`.
 */
export function extensionForMime(mime: PhotoMime): (typeof MIME_EXTENSIONS)[PhotoMime] {
  return MIME_EXTENSIONS[photoMimeSchema.parse(mime)];
}
