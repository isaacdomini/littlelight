import { writeFile } from "node:fs/promises";
import {
  ageDays,
  type IngestJob,
  type MediaMime,
  PHASH_NEAR_DUPLICATE_MAX_DISTANCE,
  type PhotoMime,
  UPLOAD_MAX_FILE_BYTES,
} from "@tinyglow/shared";
import { isUniqueViolation, runAsPipeline } from "../db";
import { StorageError } from "../storage";
import { ingestVideo, type StagedOriginal, stageOriginal } from "../video/ingest";
import { ensureScratchDir, removeScratch, scratchPaths } from "../video/scratch";
import {
  BIRTH_DATE_SQL,
  capFailureOf,
  deleteObjectsBestEffort,
  FIND_NEAR_DUPLICATE_SQL,
  FINISH_FILE_SQL,
  FINISH_PHOTO_SQL,
  FLIP_TO_PHOTO_SQL,
  FLIP_TO_VIDEO_SQL,
  handleExactDuplicate,
  type IngestDeps,
  IngestFailure,
  type IngestResult,
  isFreeTierVideoCap,
  loadPhoto,
  markIngestFailed,
  type PhotoRow,
  putDerivative,
  quarantine,
  RUNNABLE_STATUSES,
  UPDATE_HASH_SQL,
  UPSERT_EXIF_SQL,
} from "./common";
import { type DecodedSource, DecodeError, decodeImage } from "./decode";
import { renderDerivative } from "./derivatives";
import { type ExifData, extractExif } from "./exif";
import { sha256 } from "./hash";
import { computePhash } from "./phash";
import { isVideoMime, sniffMediaMime } from "./sniff";

// `photo.ingest` (docs/plans/step-4.md 2.7; PRD "AI pipeline → 1. Ingest", FR-2.3, FR-2.5,
// FR-4.1–4.4, FR-6.1). Runs as `pipeline` through `runAsPipeline`; idempotent and safe under
// `--scale worker=3`: pg-boss hands a job to one worker, the `exclusive` queue policy keyed by
// `singletonKey = photoId` keeps one queued/active copy per photo, and every write is an upsert
// or a guarded UPDATE.
//
// Step 12 (docs/plans/step-12.md 2.6): a row the api registered as a video is staged to the
// scratch folder (never read whole into memory) and handed to `video/ingest.ts`; a photo-kind row
// whose bytes sniff as a video is flipped and staged too; a video-kind row whose bytes are a still
// image is flipped back and takes the image path. The sniff is the truth either way.
//
// Nothing is sent to any model or external service here. The only outbound call is the CSAM
// matcher, which is a no-op unless the operator enrolled a provider. Logs carry ids, mime, byte
// sizes, durations and error categories only: never buffers, EXIF values, coordinates or URLs.

export * from "./common";

// --- Handler -----------------------------------------------------------------------------------

/**
 * Ingest one photo or video. Resolves for every terminal outcome (ingested, skipped, duplicate,
 * semantic failure, quarantine); throws only for transient errors (storage, database, matcher,
 * ffmpeg crash), which pg-boss retries. The job handler marks `storage_error` after the last
 * attempt.
 */
export async function ingestPhoto(deps: IngestDeps, payload: IngestJob): Promise<IngestResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
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
    if (photo.media_kind === "video")
      return await ingestRegisteredVideo(deps, photo, payload, started);

    // 2. Fetch (photos: whole object, 100 MiB cap).
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
    const mime: MediaMime | null = await sniffMediaMime(original);
    if (!mime) {
      await markIngestFailed(deps.pool, photoId, "unsupported_media_type");
      await deleteObjectsBestEffort(deps, babyId, photoId);
      log.info(
        { photoId, babyId, bytes, error: "unsupported_media_type", ms: elapsed() },
        "ingest: rejected",
      );
      return { outcome: "failed", photoId, error: "unsupported_media_type", totalMs: elapsed() };
    }
    if (isVideoMime(mime)) {
      // Registered as a photo, but the bytes are a clip: stage them and take the video path.
      const staged = await stageBuffer(deps, photo, original);
      original = undefined;
      await flipKind(deps, photo, "video");
      return await ingestVideo(deps, { ...photo, media_kind: "video" }, payload, staged, started);
    }
    return await ingestImage(deps, photo, payload, original, mime, { started, fetchedMs });
  } catch (err) {
    if (err instanceof IngestFailure) {
      await markIngestFailed(deps.pool, photoId, err.error);
      log.info({ photoId, babyId, error: err.error, ms: elapsed() }, "ingest: rejected");
      return { outcome: "failed", photoId, error: err.error, totalMs: elapsed() };
    }
    throw err;
  }
}

/** A row registered as a video: stage, sniff the head, then the video path (or flip to a photo). */
async function ingestRegisteredVideo(
  deps: IngestDeps,
  photo: PhotoRow,
  payload: IngestJob,
  started: number,
): Promise<IngestResult> {
  const elapsed = () => Math.round(performance.now() - started);
  const staged = await stageOriginal(deps, photo);
  const mime = await sniffMediaMime(staged.head);
  if (!mime) {
    await removeScratch(staged.scratchRoot, photo.id);
    await markIngestFailed(deps.pool, photo.id, "unsupported_media_type");
    await deleteObjectsBestEffort(deps, photo.baby_id, photo.id);
    deps.log.info(
      {
        photoId: photo.id,
        babyId: photo.baby_id,
        bytes: staged.bytes,
        error: "unsupported_media_type",
        ms: elapsed(),
      },
      "ingest: rejected",
    );
    return {
      outcome: "failed",
      photoId: photo.id,
      error: "unsupported_media_type",
      totalMs: elapsed(),
    };
  }
  if (isVideoMime(mime)) return ingestVideo(deps, photo, payload, staged, started);
  // Registered as a video, but the bytes are a still image: back to the image path.
  if (staged.bytes > UPLOAD_MAX_FILE_BYTES) {
    await removeScratch(staged.scratchRoot, photo.id);
    throw new IngestFailure("file_too_large");
  }
  const original = await staged.readAll();
  await removeScratch(staged.scratchRoot, photo.id);
  await flipKind(deps, photo, "photo");
  return ingestImage(deps, { ...photo, media_kind: "photo" }, payload, original, mime, {
    started,
    fetchedMs: elapsed(),
    sha256: staged.sha256,
  });
}

/** Write an in-memory original to the scratch folder as a `StagedOriginal` (photo-kind rows that are clips). */
async function stageBuffer(
  deps: IngestDeps,
  photo: PhotoRow,
  buf: Buffer,
): Promise<StagedOriginal> {
  if (!deps.video) throw new IngestFailure("unsupported_media_type");
  const root = deps.video.scratchPath;
  await ensureScratchDir(root);
  const { orig } = scratchPaths(root, photo.id);
  await writeFile(orig, buf, { mode: 0o600 });
  return {
    path: orig,
    scratchRoot: root,
    bytes: buf.byteLength,
    sha256: sha256(buf),
    head: buf.subarray(0, 4100),
    readAll: async () => buf,
  };
}

/** `photos.media_kind` follows the sniff; the Q3 video cap may refuse a flip to `video`. */
async function flipKind(deps: IngestDeps, photo: PhotoRow, to: "photo" | "video"): Promise<void> {
  try {
    await runAsPipeline(deps.pool, {}, async (c) => {
      await c.query(to === "video" ? FLIP_TO_VIDEO_SQL : FLIP_TO_PHOTO_SQL, [photo.id]);
    });
  } catch (err) {
    if (isFreeTierVideoCap(err)) {
      if (deps.video) await removeScratch(deps.video.scratchPath, photo.id);
      await deleteObjectsBestEffort(deps, photo.baby_id, photo.id);
      throw new IngestFailure("free_tier_limit");
    }
    throw err;
  }
  deps.log.info(
    { photoId: photo.id, babyId: photo.baby_id, mediaKind: to },
    "ingest: media kind flipped",
  );
}

/** The image path (steps 4–11 of docs/plans/step-4.md 2.7), from an in-memory original. */
async function ingestImage(
  deps: IngestDeps,
  photo: PhotoRow,
  payload: IngestJob,
  input: Buffer,
  mime: PhotoMime,
  timing: { started: number; fetchedMs: number; sha256?: Buffer },
): Promise<IngestResult> {
  const elapsed = () => Math.round(performance.now() - timing.started);
  const now = deps.now ?? (() => new Date());
  const { log } = deps;
  const photoId = photo.id;
  const babyId = photo.baby_id;
  let original: Buffer | undefined = input;
  const bytes = original.byteLength;

  // 4. Hash + exact dedupe (the unique partial index is the race arbiter).
  const digest = timing.sha256 ?? sha256(original);
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

  // 10. Near-duplicate flag (pHash Hamming distance, flag only; photos against photos).
  const nearDuplicateOf = await runAsPipeline(deps.pool, {}, async (c) => {
    const { rows } = await c.query<{ id: string }>(FIND_NEAR_DUPLICATE_SQL, [
      babyId,
      photoId,
      phash,
      PHASH_NEAR_DUPLICATE_MAX_DISTANCE,
      "photo",
    ]);
    return rows[0]?.id ?? null;
  });

  // 11. Final transaction: the only one carrying the data key.
  const takenAt = exif.takenAt ?? photo.created_at;
  const takenAtEstimated = exif.takenAt === null;
  const tzOffset = exif.takenAt === null ? null : exif.tzOffsetMinutes;
  const gps = exif.gps;
  try {
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
  } catch (err) {
    // A cap trigger refused the `failed → ingested` transition (the family pool, the video count
    // or the uploader's pending queue filled up meanwhile): a semantic failure, derivatives gone.
    const cap = capFailureOf(err);
    if (!cap) throw err;
    await deleteObjectsBestEffort(deps, babyId, photoId);
    throw new IngestFailure(cap);
  }

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
      ms: { fetch: timing.fetchedMs, decode: decodedMs, thumb: thumbMs, total: totalMs },
    },
    "photo ingested",
  );
  return { outcome: "ingested", photoId, nearDuplicateOf, thumbMs, totalMs, mediaKind: "photo" };
}
