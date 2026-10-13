import { open } from "node:fs/promises";
import {
  ageDays,
  type IngestJob,
  PHASH_NEAR_DUPLICATE_MAX_DISTANCE,
  type Plan,
  type VideoMime,
  videoLimitsFor,
  videoPosterSeconds,
} from "@tinyglow/shared";
import { errorCategory } from "../clients";
import { isUniqueViolation, runAsPipeline } from "../db";
import {
  BABY_PLAN_SQL,
  capFailureOf,
  deleteObjectsBestEffort,
  FIND_NEAR_DUPLICATE_SQL,
  FINISH_FILE_SQL,
  FINISH_VIDEO_SQL,
  handleExactDuplicate,
  type IngestDeps,
  IngestFailure,
  type IngestResult,
  type PhotoRow,
  putDerivative,
  quarantine,
  UPDATE_HASH_SQL,
  UPSERT_EXIF_SQL,
  type VideoIngestDeps,
} from "../ingest/common";
import { type DecodedSource, DecodeError } from "../ingest/decode";
import { renderDerivative } from "../ingest/derivatives";
import { computePhash } from "../ingest/phash";
import { sniffMediaMime } from "../ingest/sniff";
import { StorageError } from "../storage";
import { FfmpegError } from "./ffmpeg";
import { ProbeError, probeVideo, type VideoProbe } from "./ffprobe";
import { extractFrameOrFirst } from "./frames";
import { extractVideoMetadata, type VideoMetadata } from "./metadata";
import { ensureScratchDir, removeScratch, scratchPaths } from "./scratch";

// Video ingest (docs/plans/step-12.md 2.6 "video/ingest.ts"; PRD FR-2, FR-4.1–4.4, FR-6.1). Runs
// inside the `photo.ingest` job with the semantics of `ingestPhoto`: resolves for every terminal
// outcome, throws only for transient trouble (storage, database, an ffmpeg crash), which pg-boss
// retries. The original is staged to the scratch folder (sha256 streamed), never read whole into
// memory; ffprobe/ffmpeg get local paths only. The poster frame becomes the thumb/display/analysis
// derivatives (metadata-free JPEGs through the image pipeline), the CSAM matcher sees the analysis
// copy before anything is published, and the container's location tag reaches Postgres only as
// `encrypt_coord` bind parameters. The staged file stays for `video.transcode` (deleted there, or
// by the scratch sweep after 6 h). Logs: ids, mime, bytes, duration, codec, dimensions, timings;
// never tags, paths or URLs.

/** The staged original of a video (`stageOriginal`). */
export interface StagedOriginal {
  /** `<scratchRoot>/<photoId>.orig`. */
  path: string;
  scratchRoot: string;
  bytes: number;
  sha256: Buffer;
  /** First bytes for the magic-byte sniff. */
  head: Buffer;
  /** Whole file (image flip only; the caller checked the size first). */
  readAll(): Promise<Buffer>;
}

/** Head bytes read for the sniff (file-type reads at most 4100). */
const HEAD_BYTES = 4100;

/** Video settings, or a non-retryable refusal when the worker has none (pre-step-12 unit tests). */
function videoDeps(deps: IngestDeps): VideoIngestDeps {
  if (!deps.video) throw new IngestFailure("unsupported_media_type");
  return deps.video;
}

/**
 * Stream the original to `<scratch>/<photoId>.orig`, hashing on the way, and read its head.
 * `ObjectTooLarge` (above `UPLOAD_MAX_VIDEO_BYTES`) is a non-retryable `file_too_large`.
 */
export async function stageOriginal(deps: IngestDeps, photo: PhotoRow): Promise<StagedOriginal> {
  const video = videoDeps(deps);
  const getToFile = deps.storage.getObjectToFile;
  if (!getToFile) throw new StorageError("FileStorageUnavailable");
  await ensureScratchDir(video.scratchPath);
  const { orig } = scratchPaths(video.scratchPath, photo.id);
  let staged: { bytes: number; sha256: Buffer };
  try {
    staged = await getToFile.call(deps.storage, photo.storage_key_original, orig);
  } catch (err) {
    if (err instanceof StorageError && err.code === "ObjectTooLarge") {
      throw new IngestFailure("file_too_large");
    }
    throw err;
  }
  const head = await readHead(orig, Math.min(HEAD_BYTES, staged.bytes));
  return {
    path: orig,
    scratchRoot: video.scratchPath,
    bytes: staged.bytes,
    sha256: staged.sha256,
    head,
    readAll: async () => {
      const fh = await open(orig, "r");
      try {
        return await fh.readFile();
      } finally {
        await fh.close();
      }
    },
  };
}

async function readHead(filePath: string, n: number): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

interface BabyPlanRow {
  plan: Plan;
  birth_date: string | null;
}

/**
 * Ingest one staged video. `photo.media_kind` is already `video` (registered so, or flipped by
 * the caller after the sniff). Semantic refusals (`IngestFailure`) propagate to `ingestPhoto`,
 * which marks the row; the scratch file and the objects are removed here first.
 */
export async function ingestVideo(
  deps: IngestDeps,
  photo: PhotoRow,
  payload: IngestJob,
  staged: StagedOriginal,
  started: number = performance.now(),
): Promise<IngestResult> {
  const video = videoDeps(deps);
  const elapsed = () => Math.round(performance.now() - started);
  const now = deps.now ?? (() => new Date());
  const { log } = deps;
  const photoId = photo.id;
  const babyId = photo.baby_id;
  const stagedMs = elapsed();

  // Semantic refusals remove the staged file and the objects before `ingestPhoto` marks the row;
  // transient trouble propagates with the staged file kept for the retry (the scratch sweep
  // removes it after 6 h if none comes).
  const fail = async (error: IngestFailure["error"]): Promise<never> => {
    await removeScratch(staged.scratchRoot, photoId);
    await deleteObjectsBestEffort(deps, babyId, photoId);
    throw new IngestFailure(error);
  };

  // 1. Sniff the head (the api's kind is a hint; the caller already routed on it) and dedupe.
  const sniffed = await sniffMediaMime(staged.head);
  if (sniffed !== "video/mp4" && sniffed !== "video/quicktime") {
    return await fail("unsupported_media_type");
  }
  const mime: VideoMime = sniffed;
  try {
    await runAsPipeline(deps.pool, {}, async (c) => {
      await c.query(UPDATE_HASH_SQL, [staged.sha256, mime, staged.bytes, photoId]);
    });
  } catch (err) {
    if (!isUniqueViolation(err, "photos_baby_id_sha256_key")) throw err;
    await removeScratch(staged.scratchRoot, photoId);
    const duplicateOf = await handleExactDuplicate(deps, photo, staged.sha256);
    log.info(
      { photoId, babyId, mime, bytes: staged.bytes, ms: elapsed() },
      "ingest: exact duplicate removed",
    );
    return { outcome: "duplicate", photoId, duplicateOf, totalMs: elapsed() };
  }

  // 2. Probe (local path only).
  let probe: VideoProbe;
  try {
    probe = await probeVideo(video.ffprobePath, staged.path);
  } catch (err) {
    if (err instanceof ProbeError && err.category === "unsupported_media_type") {
      return await fail("unsupported_media_type");
    }
    // ffprobe missing/crashed: transient (the handler marks storage_error after the retries).
    throw err;
  }
  const probedMs = elapsed();

  // 3. Plan limits (defence in depth: the api refused the declared size and the client's hint).
  const baby = await runAsPipeline(deps.pool, {}, async (c) => {
    return (await c.query<BabyPlanRow>(BABY_PLAN_SQL, [babyId])).rows[0];
  });
  if (!baby) {
    log.warn({ photoId, babyId }, "ingest: skip (album vanished)");
    await removeScratch(staged.scratchRoot, photoId);
    return { outcome: "skipped", photoId, totalMs: elapsed() };
  }
  const limits = videoLimitsFor(baby.plan);
  // Compared on rounded whole seconds, like the api's hint check and `import_book_photo`: a
  // phone clip shown as "1:00" is 60.x s and still fits a 60 s plan.
  if (Math.round(probe.durationMs / 1000) > limits.maxSeconds) return await fail("video_too_long");
  if (staged.bytes > limits.maxBytes) return await fail("file_too_large");

  // 4. Poster frame → analysis (safety first), thumb, display.
  let source: DecodedSource;
  try {
    source = await extractFrameOrFirst(staged.path, videoPosterSeconds(probe.durationMs), {
      ffmpegPath: video.ffmpegPath,
      threads: video.threads,
    });
  } catch (err) {
    if (err instanceof DecodeError) return await fail("decode_failed");
    if (err instanceof FfmpegError && err.category === "exit_nonzero") {
      return await fail("decode_failed");
    }
    throw err;
  }
  let thumbMs: number | undefined;
  let phash: string;
  try {
    const analysis = await renderDerivative(source, "analysis");
    const verdict = await deps.matcher.check({
      sha256: staged.sha256,
      image: analysis.buffer,
      mime: "image/jpeg",
    });
    if (verdict.matched) {
      await removeScratch(staged.scratchRoot, photoId);
      await quarantine(deps, photo);
      log.warn({ photoId, babyId, matcher: deps.matcher.name }, "ingest: quarantined");
      return { outcome: "quarantined", photoId, error: "rejected", totalMs: elapsed() };
    }
    const thumb = await renderDerivative(source, "thumb");
    await putDerivative(deps, babyId, photoId, thumb);
    thumbMs = elapsed();
    phash = await computePhash(thumb.buffer);
    const display = await renderDerivative(source, "display");
    await putDerivative(deps, babyId, photoId, display);
    await putDerivative(deps, babyId, photoId, analysis);
  } catch (err) {
    if (err instanceof DecodeError) return await fail("decode_failed");
    throw err;
  } finally {
    source.release();
  }

  // 5. Metadata from the container tags (GPS non-enumerable; raw_json without location keys).
  const meta: VideoMetadata = extractVideoMetadata(probe.tags, payload.tzHint, now());

  // 6. Near-duplicate flag against other videos only (poster pHash).
  const nearDuplicateOf = await runAsPipeline(deps.pool, {}, async (c) => {
    const { rows } = await c.query<{ id: string }>(FIND_NEAR_DUPLICATE_SQL, [
      babyId,
      photoId,
      phash,
      PHASH_NEAR_DUPLICATE_MAX_DISTANCE,
      "video",
    ]);
    return rows[0]?.id ?? null;
  });

  // 7. Final transaction: the only one carrying the data key.
  const takenAt = meta.takenAt ?? photo.created_at;
  const takenAtEstimated = meta.takenAt === null;
  const tzOffset = meta.takenAt === null ? null : meta.tzOffsetMinutes;
  const gps = meta.gps;
  try {
    await runAsPipeline(deps.pool, { dataKey: deps.dataKey }, async (c) => {
      const age = baby.birth_date ? ageDays(baby.birth_date, takenAt, tzOffset) : null;
      await c.query(UPSERT_EXIF_SQL, [
        photoId,
        meta.takenAt,
        tzOffset,
        gps ? gps.lat : null,
        gps ? gps.lng : null,
        babyId,
        meta.cameraMake,
        meta.cameraModel,
        null,
        JSON.stringify(meta.rawJson),
      ]);
      await c.query(FINISH_VIDEO_SQL, [
        photoId,
        probe.width,
        probe.height,
        phash,
        takenAt,
        takenAtEstimated,
        age,
        nearDuplicateOf,
        probe.durationMs,
        probe.codec,
        probe.hasAudio,
      ]);
      await c.query(FINISH_FILE_SQL, [photoId]);
    });
  } catch (err) {
    // A cap trigger refused the `failed → ingested` transition: semantic failure, objects and the
    // staged file gone.
    const cap = capFailureOf(err);
    if (!cap) throw err;
    return await fail(cap);
  }

  // 8. Hand over to the transcode (the staged original stays for it).
  let transcodeJobId: string | null = null;
  try {
    transcodeJobId = await video.sendVideoTranscode({ photoId, babyId });
  } catch (err) {
    // `ingest.reconcile` re-sends `video.transcode` for pending rows older than 15 minutes.
    log.warn({ photoId, err: errorCategory(err) }, "ingest: video.transcode send failed");
  }

  const totalMs = elapsed();
  log.info(
    {
      photoId,
      babyId,
      mime,
      bytes: staged.bytes,
      durationMs: probe.durationMs,
      codec: probe.codec,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      hdr: probe.hdr,
      estimated: takenAtEstimated,
      nearDuplicate: nearDuplicateOf !== null,
      transcodeQueued: transcodeJobId !== null,
      ms: { stage: stagedMs, probe: probedMs, thumb: thumbMs, total: totalMs },
    },
    "photo ingested",
  );
  return { outcome: "ingested", photoId, nearDuplicateOf, thumbMs, totalMs, mediaKind: "video" };
}
