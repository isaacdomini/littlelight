import {
  ageDays,
  derivativeKey,
  type IngestJob,
  PHASH_NEAR_DUPLICATE_MAX_DISTANCE,
  type PhotoMime,
  photoPrefixes,
  type UploadFileError,
} from "@littlelight/shared";
import { errorCategory } from "../clients";
import { isUniqueViolation, type PipelinePool, runAsPipeline } from "../db";
import type { WorkerLog } from "../log-types";
import { type ObjectStorage, StorageError } from "../storage";
import { type DecodedSource, DecodeError, decodeImage } from "./decode";
import { type RenderedDerivative, renderDerivative } from "./derivatives";
import { type ExifData, extractExif } from "./exif";
import { sha256 } from "./hash";
import { computePhash } from "./phash";
import type { CsamMatcher } from "./safety";
import { sniffPhotoMime } from "./sniff";

// `photo.ingest` (docs/plans/step-4.md 2.7; PRD "AI pipeline → 1. Ingest", FR-2.3, FR-2.5,
// FR-4.1–4.4, FR-6.1). Runs as `pipeline` through `runAsPipeline`; idempotent and safe under
// `--scale worker=3`: pg-boss hands a job to one worker, the `exclusive` queue policy keyed by
// `singletonKey = photoId` keeps one queued/active copy per photo, and every write is an upsert
// or a guarded UPDATE.
//
// Nothing is sent to any model or external service here. The only outbound call is the CSAM
// matcher, which is a no-op unless the operator enrolled a provider. Logs carry ids, mime, byte
// sizes, durations and error categories only: never buffers, EXIF values, coordinates or URLs.

export interface IngestDeps {
  pool: PipelinePool;
  storage: ObjectStorage;
  matcher: CsamMatcher;
  /** `DATA_ENCRYPTION_KEY`, bound only in the final (photo_exif) transaction. */
  dataKey: string;
  log: WorkerLog;
  now?: () => Date;
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
}

/** A semantic failure: marked immediately, never retried. */
class IngestFailure extends Error {
  constructor(readonly error: UploadFileError) {
    super(`ingest failed: ${error}`);
    this.name = "IngestFailure";
  }
}

const CACHE_CONTROL = "private, max-age=3600";

// --- SQL (exported for unit tests; every statement names its columns) -------------------------

export const LOAD_PHOTO_SQL = `
SELECT id, baby_id, status, approval, storage_key_original, created_at, deleted_at, quarantined_at
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

export const FIND_NEAR_DUPLICATE_SQL = `
SELECT id
FROM photos
WHERE baby_id = $1 AND id <> $2 AND deleted_at IS NULL AND quarantined_at IS NULL
  AND status <> 'duplicate' AND phash IS NOT NULL
  AND bit_count(phash # $3::bit(64)) <= $4
ORDER BY created_at, id
LIMIT 1`;

export const BIRTH_DATE_SQL = `SELECT birth_date::text AS birth_date FROM babies WHERE id = $1`;

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

export const FINISH_FILE_SQL = `
UPDATE upload_files SET state = 'ingested', error = NULL
WHERE id = $1 AND state IN ('completed', 'failed')`;

// --- Helpers -----------------------------------------------------------------------------------

interface PhotoRow {
  id: string;
  baby_id: string;
  status: string;
  approval: string;
  storage_key_original: string;
  created_at: Date;
  deleted_at: Date | null;
  quarantined_at: Date | null;
}

const RUNNABLE_STATUSES = new Set(["uploaded", "failed"]);

async function loadPhoto(deps: IngestDeps, photoId: string): Promise<PhotoRow | undefined> {
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

async function deleteObjectsBestEffort(
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

async function putDerivative(
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
async function handleExactDuplicate(
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

async function quarantine(deps: IngestDeps, photo: PhotoRow): Promise<void> {
  await runAsPipeline(deps.pool, {}, async (c) => {
    await c.query(QUARANTINE_PHOTO_SQL, [photo.id]);
    await c.query(QUARANTINE_FILE_SQL, [photo.id]);
    await c.query(AUDIT_HASH_MATCH_SQL, [photo.baby_id, JSON.stringify({ photo_id: photo.id })]);
  });
}

// --- Handler -----------------------------------------------------------------------------------

/**
 * Ingest one photo. Resolves for every terminal outcome (ingested, skipped, duplicate, semantic
 * failure, quarantine); throws only for transient errors (storage, database, matcher), which
 * pg-boss retries. The job handler marks `storage_error` after the last attempt.
 */
export async function ingestPhoto(deps: IngestDeps, payload: IngestJob): Promise<IngestResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const now = deps.now ?? (() => new Date());
  const photoId = payload.photoId;
  const log = deps.log;

  // 1. Load.
  const photo = await loadPhoto(deps, photoId);
  if (!photo || photo.deleted_at || photo.quarantined_at || !RUNNABLE_STATUSES.has(photo.status)) {
    // Only "photo ingested" may contain that word (the gate counts it in the logs).
    log.debug({ photoId, reason: photo ? "not_runnable" : "missing" }, "ingest: skip");
    return { outcome: "skipped", photoId, totalMs: elapsed() };
  }
  if (photo.baby_id !== payload.babyId) {
    // The payload is advisory; the row is the truth. Never act on a mismatched pair.
    log.warn({ photoId }, "ingest: skip (payload baby does not match the photo)");
    return { outcome: "skipped", photoId, totalMs: elapsed() };
  }
  const babyId = photo.baby_id;

  try {
    // 2. Fetch.
    let original: Buffer | undefined;
    try {
      original = await deps.storage.getObject(photo.storage_key_original);
    } catch (err) {
      if (err instanceof StorageError && err.code === "ObjectTooLarge") {
        throw new IngestFailure("file_too_large");
      }
      throw err;
    }
    const fetchedMs = elapsed();
    const bytes = original.byteLength;

    // 3. Sniff (magic bytes only).
    const mime: PhotoMime | null = await sniffPhotoMime(original);
    if (!mime) {
      await markIngestFailed(deps.pool, photoId, "unsupported_media_type");
      await deleteObjectsBestEffort(deps, babyId, photoId);
      log.info(
        { photoId, babyId, bytes, error: "unsupported_media_type", ms: elapsed() },
        "ingest: rejected",
      );
      return { outcome: "failed", photoId, error: "unsupported_media_type", totalMs: elapsed() };
    }

    // 4. Hash + exact dedupe (the unique partial index is the race arbiter).
    const digest = sha256(original);
    try {
      await runAsPipeline(deps.pool, {}, async (c) => {
        await c.query(UPDATE_HASH_SQL, [digest, mime, bytes, photoId]);
      });
    } catch (err) {
      if (!isUniqueViolation(err, "photos_baby_id_sha256_key")) throw err;
      original = undefined;
      const duplicateOf = await handleExactDuplicate(deps, photo, digest);
      log.info({ photoId, babyId, mime, bytes, ms: elapsed() }, "ingest: exact duplicate removed");
      return { outcome: "duplicate", photoId, duplicateOf, totalMs: elapsed() };
    }

    // 5. EXIF (GPS stays a non-enumerable local, see exif.ts).
    const exif: ExifData = await extractExif(original, mime, payload.tzHint, now());

    // 6. Decode (HEIC via heic-decode; JPEG/PNG/WebP auto-oriented by sharp).
    let source: DecodedSource;
    try {
      source = await decodeImage(original, mime);
    } catch (err) {
      if (err instanceof DecodeError) throw new IngestFailure("decode_failed");
      throw err;
    }
    // HEIC: the decoded RGBA is all we need from here on.
    if (mime === "image/heic" || mime === "image/heif") original = undefined;
    const decodedMs = elapsed();

    let thumbMs: number | undefined;
    let phash: string;
    try {
      // 7–8. Analysis copy first: the safety check runs on it before anything is published.
      const analysis = await renderDerivative(source, "analysis");
      const verdict = await deps.matcher.check({
        sha256: digest,
        image: analysis.buffer,
        mime: "image/jpeg",
      });
      if (verdict.matched) {
        await quarantine(deps, photo);
        log.warn({ photoId, babyId, matcher: deps.matcher.name }, "ingest: quarantined");
        return { outcome: "quarantined", photoId, error: "rejected", totalMs: elapsed() };
      }

      // 9. Thumb first, so the grid can show it before display/analysis exist.
      const thumb = await renderDerivative(source, "thumb");
      await putDerivative(deps, babyId, photoId, thumb);
      thumbMs = elapsed();
      phash = await computePhash(thumb.buffer);

      const display = await renderDerivative(source, "display");
      await putDerivative(deps, babyId, photoId, display);
      // The analysis copy never leaves the bucket in this step (step 6 reads it server-side,
      // approved photos of paid babies only).
      await putDerivative(deps, babyId, photoId, analysis);
    } catch (err) {
      if (err instanceof DecodeError) throw new IngestFailure("decode_failed");
      throw err;
    } finally {
      source.release();
      original = undefined;
    }

    // 10. Near-duplicate flag (pHash Hamming distance, flag only).
    const nearDuplicateOf = await runAsPipeline(deps.pool, {}, async (c) => {
      const { rows } = await c.query<{ id: string }>(FIND_NEAR_DUPLICATE_SQL, [
        babyId,
        photoId,
        phash,
        PHASH_NEAR_DUPLICATE_MAX_DISTANCE,
      ]);
      return rows[0]?.id ?? null;
    });

    // 11. Final transaction: the only one carrying the data key.
    const takenAt = exif.takenAt ?? photo.created_at;
    const takenAtEstimated = exif.takenAt === null;
    const tzOffset = exif.takenAt === null ? null : exif.tzOffsetMinutes;
    const gps = exif.gps;
    await runAsPipeline(deps.pool, { dataKey: deps.dataKey }, async (c) => {
      const { rows } = await c.query<{ birth_date: string }>(BIRTH_DATE_SQL, [babyId]);
      const birthDate = rows[0]?.birth_date;
      const age = birthDate ? ageDays(birthDate, takenAt, tzOffset) : null;
      await c.query(UPSERT_EXIF_SQL, [
        photoId,
        exif.takenAt,
        tzOffset,
        gps ? gps.lat : null,
        gps ? gps.lng : null,
        babyId,
        exif.cameraMake,
        exif.cameraModel,
        exif.orientation,
        JSON.stringify(exif.rawJson),
      ]);
      await c.query(FINISH_PHOTO_SQL, [
        photoId,
        source.width,
        source.height,
        phash,
        takenAt,
        takenAtEstimated,
        age,
        nearDuplicateOf,
      ]);
      await c.query(FINISH_FILE_SQL, [photoId]);
    });

    const totalMs = elapsed();
    log.info(
      {
        photoId,
        babyId,
        mime,
        bytes,
        width: source.width,
        height: source.height,
        estimated: takenAtEstimated,
        nearDuplicate: nearDuplicateOf !== null,
        ms: { fetch: fetchedMs, decode: decodedMs, thumb: thumbMs, total: totalMs },
      },
      "photo ingested",
    );
    return { outcome: "ingested", photoId, nearDuplicateOf, thumbMs, totalMs };
  } catch (err) {
    if (err instanceof IngestFailure) {
      await markIngestFailed(deps.pool, photoId, err.error);
      log.info({ photoId, babyId, error: err.error, ms: elapsed() }, "ingest: rejected");
      return { outcome: "failed", photoId, error: err.error, totalMs: elapsed() };
    }
    throw err;
  }
}
