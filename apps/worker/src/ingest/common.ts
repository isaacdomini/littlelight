import {
  derivativeKey,
  photoPrefixes,
  type UploadFileError,
  type VideoTranscodeJob,
} from "@tinyglow/shared";
import { errorCategory } from "../clients";
import { type PipelinePool, runAsPipeline } from "../db";
import type { WorkerLog } from "../log-types";
import type { FileStorage, ObjectStorage } from "../storage";
import type { RenderedDerivative } from "./derivatives";
import type { CsamMatcher } from "./safety";

// Shared state, SQL and helpers of the `photo.ingest` job (docs/plans/step-4.md 2.7; step 12:
// docs/plans/step-12.md 2.6), used by the image path (`ingest/index.ts`) and the video path
// (`video/ingest.ts`). Every statement names its columns; logs carry ids, mime, byte sizes,
// durations and error categories only: never buffers, tag values, coordinates, paths or URLs.

/** ffmpeg/ffprobe and scratch settings of the video path (`videoEnvSchema`). */
export interface VideoIngestDeps {
  ffmpegPath: string;
  ffprobePath: string;
  /** `WORKER_SCRATCH_PATH`. */
  scratchPath: string;
  /** `VIDEO_FFMPEG_THREADS`. */
  threads: number;
  /** Enqueue `video.transcode` after a video was ingested (null = one is already queued). */
  sendVideoTranscode: (job: VideoTranscodeJob) => Promise<string | null>;
}

export interface IngestDeps {
  pool: PipelinePool;
  /** File-backed methods are needed for videos only (the real `createStorage` has them). */
  storage: ObjectStorage & Partial<FileStorage>;
  matcher: CsamMatcher;
  /** `DATA_ENCRYPTION_KEY`, bound only in the final (photo_exif) transaction. */
  dataKey: string;
  log: WorkerLog;
  now?: () => Date;
  /**
   * Video settings (step 12). `main.ts` and run-job always pass them; without them a video upload
   * is a non-retryable `unsupported_media_type` (unit tests written before step 12).
   */
  video?: VideoIngestDeps;
}

export type IngestOutcome = "ingested" | "skipped" | "duplicate" | "failed" | "quarantined";

export interface IngestResult {
  outcome: IngestOutcome;
  photoId: string;
  /** For `failed`: the `upload_files.error` written. */
  error?: UploadFileError;
  /** For `duplicate`: the surviving photo (null when it is not visible to users). */
  duplicateOf?: string | null;
  /** For `ingested`: near-duplicate flag written to `photos.duplicate_of_photo_id`. */
  nearDuplicateOf?: string | null;
  /** Milliseconds from handler start until the thumb row was committed. */
  thumbMs?: number;
  totalMs: number;
  /** For `ingested`: the row's kind after the sniff (`video` rows continue in `video.transcode`). */
  mediaKind?: "photo" | "video";
}

/** A semantic failure: marked immediately, never retried. */
export class IngestFailure extends Error {
  constructor(readonly error: UploadFileError) {
    super(`ingest failed: ${error}`);
    this.name = "IngestFailure";
  }
}

/** Cache-Control of every derivative object (also used by the perf seed's base images). */
export const CACHE_CONTROL = "private, max-age=3600";

// --- SQL (exported for unit tests; every statement names its columns) -------------------------

export const LOAD_PHOTO_SQL = `
SELECT id, baby_id, status, approval, storage_key_original, created_at, deleted_at, quarantined_at,
       media_kind, rendition_status
FROM photos WHERE id = $1`;

export const MARK_FAILED_PHOTO_SQL = `
UPDATE photos SET status = 'failed' WHERE id = $1 AND status IN ('uploaded', 'failed')`;

export const MARK_FAILED_FILE_SQL = `
UPDATE upload_files SET state = 'failed', error = $2 WHERE id = $1 AND state IN ('completed', 'failed')`;

export const UPDATE_HASH_SQL = `
UPDATE photos SET sha256 = $1, mime = $2, bytes = $3 WHERE id = $4`;

export const FIND_EXACT_DUPLICATE_SQL = `
SELECT id, quarantined_at IS NOT NULL AS quarantined
FROM photos
WHERE baby_id = $1 AND sha256 = $2 AND deleted_at IS NULL AND id <> $3
ORDER BY created_at, id
LIMIT 1`;

export const MARK_DUPLICATE_PHOTO_SQL = `
UPDATE photos SET status = 'duplicate', duplicate_of_photo_id = $2 WHERE id = $1`;

export const MARK_DUPLICATE_FILE_SQL = `
UPDATE upload_files SET state = 'duplicate', duplicate_of_photo_id = $2, error = NULL WHERE id = $1`;

export const DELETE_DUPLICATE_SQL = `
DELETE FROM photos WHERE id = $1 AND status = 'duplicate'`;

export const QUARANTINE_PHOTO_SQL = `
UPDATE photos SET quarantined_at = now(), status = 'failed' WHERE id = $1`;

export const QUARANTINE_FILE_SQL = `
UPDATE upload_files SET state = 'failed', error = 'rejected' WHERE id = $1`;

export const AUDIT_HASH_MATCH_SQL = `
INSERT INTO audit_log (baby_id, event, metadata) VALUES ($1, 'safety.hash_match', $2::jsonb)`;

export const UPSERT_DERIVATIVE_SQL = `
INSERT INTO photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (photo_id, kind) DO UPDATE SET
  storage_key = EXCLUDED.storage_key,
  width = EXCLUDED.width,
  height = EXCLUDED.height,
  bytes = EXCLUDED.bytes`;

/** Near-duplicate candidates of the same kind only (a poster pHash is compared with videos; step 12). */
export const FIND_NEAR_DUPLICATE_SQL = `
SELECT id
FROM photos
WHERE baby_id = $1 AND id <> $2 AND deleted_at IS NULL AND quarantined_at IS NULL
  AND status <> 'duplicate' AND phash IS NOT NULL AND media_kind = $5
  AND bit_count(phash # $3::bit(64)) <= $4
ORDER BY created_at, id
LIMIT 1`;

export const BIRTH_DATE_SQL = `SELECT birth_date::text AS birth_date FROM babies WHERE id = $1`;

/** Plan + birth date of the album (the video path's limits and age). */
export const BABY_PLAN_SQL = `
SELECT plan, birth_date::text AS birth_date FROM babies WHERE id = $1`;

/**
 * GPS reaches Postgres only as bind parameters $4/$5, consumed by `encrypt_coord` and
 * `home_place_label` (distance computed in SQL against the encrypted home, so plaintext never
 * comes back to Node). Both functions are STRICT: NULL coordinates store NULLs.
 */
export const UPSERT_EXIF_SQL = `
INSERT INTO photo_exif
  (photo_id, taken_at, tz_offset_minutes, gps_lat_enc, gps_lng_enc, place_label,
   camera_make, camera_model, orientation, raw_json)
VALUES
  ($1, $2, $3,
   encrypt_coord($4::double precision), encrypt_coord($5::double precision),
   home_place_label($6::uuid, $4::double precision, $5::double precision),
   $7, $8, $9, $10::jsonb)
ON CONFLICT (photo_id) DO UPDATE SET
  taken_at = EXCLUDED.taken_at,
  tz_offset_minutes = EXCLUDED.tz_offset_minutes,
  gps_lat_enc = EXCLUDED.gps_lat_enc,
  gps_lng_enc = EXCLUDED.gps_lng_enc,
  place_label = EXCLUDED.place_label,
  camera_make = EXCLUDED.camera_make,
  camera_model = EXCLUDED.camera_model,
  orientation = EXCLUDED.orientation,
  raw_json = EXCLUDED.raw_json`;

export const FINISH_PHOTO_SQL = `
UPDATE photos SET
  width = $2, height = $3, phash = $4::bit(64), taken_at = $5, taken_at_estimated = $6,
  age_days = $7, duplicate_of_photo_id = $8, status = 'ingested'
WHERE id = $1 AND status IN ('uploaded', 'failed')`;

/**
 * Video finish (step 12): the probed columns plus `rendition_status = 'pending'` (kept `ready`
 * when a rendition already exists, e.g. a re-run after a transient failure past the transcode).
 */
export const FINISH_VIDEO_SQL = `
UPDATE photos SET
  width = $2, height = $3, phash = $4::bit(64), taken_at = $5, taken_at_estimated = $6,
  age_days = $7, duplicate_of_photo_id = $8, duration_ms = $9, video_codec = $10, has_audio = $11,
  status = 'ingested',
  rendition_status = CASE WHEN rendition_status = 'ready' THEN 'ready' ELSE 'pending' END
WHERE id = $1 AND status IN ('uploaded', 'failed') AND media_kind = 'video'`;

export const FINISH_FILE_SQL = `
UPDATE upload_files SET state = 'ingested', error = NULL
WHERE id = $1 AND state IN ('completed', 'failed')`;

/** The sniff is the truth (step 12): a row registered as a photo whose bytes are a video. */
export const FLIP_TO_VIDEO_SQL = `
UPDATE photos SET media_kind = 'video', rendition_status = 'pending'
WHERE id = $1 AND media_kind = 'photo'`;

/** The sniff is the truth: a row registered as a video whose bytes are a still image. */
export const FLIP_TO_PHOTO_SQL = `
UPDATE photos SET media_kind = 'photo', rendition_status = 'none',
  duration_ms = NULL, video_codec = NULL, has_audio = NULL
WHERE id = $1 AND media_kind = 'video'`;

// --- Helpers -----------------------------------------------------------------------------------

export interface PhotoRow {
  id: string;
  baby_id: string;
  status: string;
  approval: string;
  storage_key_original: string;
  created_at: Date;
  deleted_at: Date | null;
  quarantined_at: Date | null;
  media_kind: "photo" | "video";
  rendition_status: string;
}

export const RUNNABLE_STATUSES: ReadonlySet<string> = new Set(["uploaded", "failed"]);

export async function loadPhoto(deps: IngestDeps, photoId: string): Promise<PhotoRow | undefined> {
  return runAsPipeline(deps.pool, {}, async (c) => {
    const { rows } = await c.query<PhotoRow>(LOAD_PHOTO_SQL, [photoId]);
    return rows[0];
  });
}

/** Mark the photo `failed` and its upload file `failed/<error>`. Idempotent. */
export async function markIngestFailed(
  pool: PipelinePool,
  photoId: string,
  error: UploadFileError,
): Promise<void> {
  await runAsPipeline(pool, {}, async (c) => {
    await c.query(MARK_FAILED_PHOTO_SQL, [photoId]);
    await c.query(MARK_FAILED_FILE_SQL, [photoId, error]);
  });
}

export async function deleteObjectsBestEffort(
  deps: IngestDeps,
  babyId: string,
  photoId: string,
): Promise<void> {
  for (const prefix of photoPrefixes(babyId, photoId)) {
    try {
      await deps.storage.deleteAllVersions(prefix);
    } catch (err) {
      // purge.trash (orphaned upload objects) retries later.
      deps.log.warn({ photoId, err: errorCategory(err) }, "ingest: object cleanup deferred");
    }
  }
}

export async function putDerivative(
  deps: IngestDeps,
  babyId: string,
  photoId: string,
  d: RenderedDerivative,
): Promise<void> {
  const key = derivativeKey(babyId, photoId, d.kind);
  await deps.storage.putObject(key, d.buffer, "image/jpeg", { cacheControl: CACHE_CONTROL });
  await runAsPipeline(deps.pool, {}, async (c) => {
    await c.query(UPSERT_DERIVATIVE_SQL, [photoId, d.kind, key, d.width, d.height, d.bytes]);
  });
}

/** Exact-duplicate path (D3): marker → file state → commit → objects → row. */
export async function handleExactDuplicate(
  deps: IngestDeps,
  photo: PhotoRow,
  digest: Buffer,
): Promise<string | null> {
  const duplicateOf = await runAsPipeline(deps.pool, {}, async (c) => {
    const { rows } = await c.query<{ id: string; quarantined: boolean }>(FIND_EXACT_DUPLICATE_SQL, [
      photo.baby_id,
      digest,
      photo.id,
    ]);
    const survivor = rows[0];
    // The other row vanished between our unique violation and this read: retry the job.
    if (!survivor) throw new Error("duplicate survivor not found");
    // Never point a user at a quarantined photo (it does not exist for them).
    const linkTo = survivor.quarantined ? null : survivor.id;
    await c.query(MARK_DUPLICATE_PHOTO_SQL, [photo.id, linkTo]);
    await c.query(MARK_DUPLICATE_FILE_SQL, [photo.id, linkTo]);
    return linkTo;
  });
  // Object versions first (a crash here leaves the marker row; purge.trash finishes it).
  for (const prefix of photoPrefixes(photo.baby_id, photo.id)) {
    await deps.storage.deleteAllVersions(prefix);
  }
  await runAsPipeline(deps.pool, {}, async (c) => {
    await c.query(DELETE_DUPLICATE_SQL, [photo.id]);
  });
  return duplicateOf;
}

export async function quarantine(deps: IngestDeps, photo: PhotoRow): Promise<void> {
  await runAsPipeline(deps.pool, {}, async (c) => {
    await c.query(QUARANTINE_PHOTO_SQL, [photo.id]);
    await c.query(QUARANTINE_FILE_SQL, [photo.id]);
    await c.query(AUDIT_HASH_MATCH_SQL, [photo.baby_id, JSON.stringify({ photo_id: photo.id })]);
  });
}

/**
 * The `upload_files.error` for a cap trigger that refused a write (23514 with a fixed message):
 * `photos_free_tier_cap` / `photos_free_tier_video_cap` ⇒ `free_tier_limit`, `photos_pending_cap`
 * ⇒ `pending_limit`; null for anything else. The finish statements (`failed → ingested` re-runs
 * change the counted status) and the kind flips can all hit them.
 */
export function capFailureOf(
  err: unknown,
): Extract<UploadFileError, "free_tier_limit" | "pending_limit"> | null {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code !== "23514" || typeof e.message !== "string") return null;
  if (
    e.message.startsWith("free tier photo limit") ||
    e.message.startsWith("free tier video limit")
  ) {
    return "free_tier_limit";
  }
  if (e.message.startsWith("pending photo limit")) return "pending_limit";
  return null;
}

/** `photos_free_tier_video_cap` refused a kind flip (23514 with the Q3 message). */
export function isFreeTierVideoCap(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return (
    !!e &&
    e.code === "23514" &&
    typeof e.message === "string" &&
    e.message.startsWith("free tier video limit")
  );
}
