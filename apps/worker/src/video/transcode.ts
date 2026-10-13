import { open, rm, utimes } from "node:fs/promises";
import {
  derivativeKey,
  type Plan,
  VIDEO_RENDITION,
  VIDEO_SCRATCH_MIN_FREE_BYTES,
  type VideoTranscodeJob,
  videoKeyframeTimes,
  videoLimitsFor,
} from "@tinyglow/shared";
import { errorCategory } from "../clients";
import { type PipelinePool, runAsPipeline } from "../db";
import { CACHE_CONTROL, UPSERT_DERIVATIVE_SQL } from "../ingest/common";
import { DecodeError } from "../ingest/decode";
import { renderDerivative } from "../ingest/derivatives";
import type { WorkerLog } from "../log-types";
import type { FileStorage, ObjectStorage } from "../storage";
import { FfmpegError, runProcess } from "./ffmpeg";
import { ProbeError, probeVideo, type VideoProbe } from "./ffprobe";
import { extractFrameOrFirst } from "./frames";
import {
  assertScratchRoom,
  ensureScratchDir,
  fileSize,
  removeScratch,
  ScratchLowError,
  type StatfsFn,
  scratchPaths,
} from "./scratch";

// `video.transcode` (docs/plans/step-12.md 2.6 "video/transcode.ts"; PRD FR-4.4, FR-6.1, FR-8.4).
// One job per ingested video: the staged original (or a fresh download) → one H.264 High /
// yuv420p ≤ 1080p ≤ 60 fps AAC MP4 with `faststart`, every container tag and chapter dropped
// (`-map_metadata -1 -map_chapters -1`) → `derivatives/<id>/web.mp4` → three keyframes (768 px,
// metadata-free JPEGs) → `rendition_status = 'ready'`. An original that already is a browser-safe
// MP4 is remuxed (`-c copy`) instead of re-encoded. HDR sources are tone-mapped to BT.709 with
// zscale/tonemap; if that filter chain fails on this build or input, the rendition is made with a
// plain `format=yuv420p` and `hdrTonemap: false` is logged. ffmpeg only ever sees local paths.
// Logs: ids, remux/hdr flags, byte sizes and timings; never paths, tags or URLs.

export interface TranscodeDeps {
  pool: PipelinePool;
  storage: ObjectStorage & FileStorage;
  log: WorkerLog;
  ffmpegPath: string;
  ffprobePath: string;
  /** `WORKER_SCRATCH_PATH`. */
  scratchPath: string;
  /** `VIDEO_FFMPEG_THREADS`. */
  threads: number;
  /** `VIDEO_TRANSCODE_TIMEOUT_SEC`. */
  timeoutSec: number;
  /** Free bytes the scratch folder must have before a job runs (default `VIDEO_SCRATCH_MIN_FREE_BYTES`). */
  minFreeBytes?: number;
  statfs?: StatfsFn;
}

export type TranscodeOutcome = "ready" | "skipped" | "failed";

export interface TranscodeResult {
  outcome: TranscodeOutcome;
  photoId: string;
  remux?: boolean;
  hdr?: boolean;
  hdrTonemap?: boolean;
  inBytes?: number;
  outBytes?: number;
  keyframes?: number;
  ms: number;
}

/** A non-retryable transcode failure (bad source, verification failed): `rendition_status = 'failed'`. */
export class TranscodeFailure extends Error {
  constructor(readonly reason: string) {
    super(`transcode failed: ${reason}`);
    this.name = "TranscodeFailure";
  }
}

// --- SQL -----------------------------------------------------------------------------------------

export const LOAD_VIDEO_SQL = `
SELECT p.id, p.baby_id, p.media_kind, p.rendition_status, p.status, p.deleted_at, p.quarantined_at,
       p.storage_key_original, p.sha256, p.bytes::text AS bytes, p.duration_ms, b.plan
FROM photos p
JOIN babies b ON b.id = p.baby_id
WHERE p.id = $1`;

export const MARK_RENDITION_SQL = `
UPDATE photos SET rendition_status = $2
WHERE id = $1 AND media_kind = 'video' AND rendition_status <> $2`;

/** The upload file (same id as the photo) records the failure; the row itself stays live. */
export const MARK_TRANSCODE_FAILED_FILE_SQL = `
UPDATE upload_files SET error = 'transcode_failed' WHERE id = $1`;

export const CLEAR_TRANSCODE_FAILED_FILE_SQL = `
UPDATE upload_files SET error = NULL WHERE id = $1 AND error = 'transcode_failed'`;

interface VideoRow {
  id: string;
  baby_id: string;
  media_kind: string;
  rendition_status: string;
  status: string;
  deleted_at: Date | null;
  quarantined_at: Date | null;
  storage_key_original: string;
  sha256: Buffer | null;
  /** `photos.bytes` (bigint as text): a reused staged file must have exactly this size. */
  bytes: string | null;
  duration_ms: number | null;
  plan: Plan;
}

/**
 * Whether a thrown transcode error is a deferral (the row must stay `pending`; `ingest.reconcile`
 * re-sends `video.transcode` after `VIDEO_TRANSCODE_STUCK_MINUTES`) rather than a genuine failure
 * (`rendition_status = 'failed'`, `upload_files.error = 'transcode_failed'` on the last attempt).
 *
 * Genuine (deterministic for this input): `TranscodeFailure` (bad source, failed verification,
 * any ffmpeg exit/crash/kill/oversized output on the remux, transcode, tone-map fallback or
 * verification run — `runFfmpeg` converts those), an ffmpeg `timeout` (the clip cannot be encoded
 * within `VIDEO_TRANSCODE_TIMEOUT_SEC` however often we retry) and ffprobe failing on the input.
 * Deferrable (the environment, not the clip): `ScratchLowError`, storage/database/transport
 * errors, ffmpeg or ffprobe not startable (`spawn_failed`, i.e. the binary is missing) and
 * anything unknown.
 */
export function isDeferrableTranscodeError(err: unknown): boolean {
  if (err instanceof TranscodeFailure) return false;
  if (err instanceof FfmpegError) return err.category === "spawn_failed";
  if (err instanceof ProbeError) return err.spawnFailed;
  return true;
}

/**
 * Run ffmpeg for the rendition: a non-zero exit, a crash/kill (SIGSEGV, OOM on this input) or an
 * oversized stdout is deterministic for this clip and becomes a `TranscodeFailure`
 * (`ffmpeg_<category>`); `timeout` and `spawn_failed` propagate (retry; see
 * `isDeferrableTranscodeError`).
 */
async function runFfmpeg(deps: TranscodeDeps, args: string[], timeoutMs: number): Promise<void> {
  try {
    await runProcess(deps.ffmpegPath, args, { timeoutMs });
  } catch (err) {
    if (
      err instanceof FfmpegError &&
      err.category !== "timeout" &&
      err.category !== "spawn_failed"
    ) {
      throw new TranscodeFailure(`ffmpeg_${err.category}`);
    }
    throw err;
  }
}

// --- ffmpeg argument builders (exported for tests; local paths only) ----------------------------

const COMMON_OUT = [
  "-map_metadata",
  "-1",
  "-map_chapters",
  "-1",
  "-sn",
  "-dn",
  "-movflags",
  "+faststart",
  "-f",
  "mp4",
  "-y",
] as const;

function commonIn(threads: number): string[] {
  return [
    "-v",
    "error",
    "-hide_banner",
    "-nostdin",
    "-threads",
    String(Math.max(1, Math.min(8, Math.round(threads)))),
  ];
}

/**
 * The remux fast path applies when the original already is what the rendition would be: MP4
 * container, H.264 in yuv420p (8-bit SDR), ≤ 1080p, ≤ 60 fps, no rotation to bake in, AAC or no
 * audio. The copy keeps the bitstream but drops every tag.
 */
export function canRemux(
  probe: VideoProbe,
  mime: "video/mp4" | "video/quicktime" | string,
): boolean {
  return (
    mime === "video/mp4" &&
    probe.codec === "h264" &&
    probe.pixelFormat === VIDEO_RENDITION.pixelFormat &&
    !probe.hdr &&
    probe.rotation === 0 &&
    Math.max(probe.width, probe.height) <= VIDEO_RENDITION.longEdge &&
    (probe.fps === null || probe.fps <= VIDEO_RENDITION.maxFps) &&
    (!probe.hasAudio || probe.audioCodec === VIDEO_RENDITION.audioCodec)
  );
}

export function remuxArgs(
  input: string,
  output: string,
  probe: VideoProbe,
  threads: number,
): string[] {
  return [
    ...commonIn(threads),
    "-i",
    input,
    "-map",
    "0:v:0",
    ...(probe.hasAudio ? ["-map", "0:a:0"] : ["-an"]),
    "-c",
    "copy",
    ...COMMON_OUT,
    output,
  ];
}

/** HDR → SDR tone-map chain (needs libzimg); the plain fallback is `format=yuv420p`. */
export const HDR_TONEMAP_FILTER =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

/** Video filter chain: downscale to the long edge (never enlarge), cap fps, pixel format / tone-map. */
export function videoFilter(probe: VideoProbe, opts: { tonemap: boolean }): string {
  const edge = VIDEO_RENDITION.longEdge;
  const parts: string[] = [];
  // Scale by the longer display edge; `-2` keeps the aspect and an even size for yuv420p.
  if (Math.max(probe.width, probe.height) > edge) {
    parts.push(
      probe.width >= probe.height
        ? `scale=${edge}:-2:flags=lanczos`
        : `scale=-2:${edge}:flags=lanczos`,
    );
  }
  if (probe.fps !== null && probe.fps > VIDEO_RENDITION.maxFps)
    parts.push(`fps=${VIDEO_RENDITION.maxFps}`);
  if (probe.hdr && opts.tonemap) parts.push(HDR_TONEMAP_FILTER);
  else parts.push(`format=${VIDEO_RENDITION.pixelFormat}`);
  return parts.join(",");
}

export function transcodeArgs(
  input: string,
  output: string,
  probe: VideoProbe,
  /** `maxSeconds`: the `-t` cap (the plan limit + 1 s, see `transcodeVideo`). */
  opts: { threads: number; tonemap: boolean; maxSeconds: number },
): string[] {
  return [
    ...commonIn(opts.threads),
    "-i",
    input,
    "-map",
    "0:v:0",
    ...(probe.hasAudio ? ["-map", "0:a:0"] : ["-an"]),
    "-c:v",
    "libx264",
    "-preset",
    VIDEO_RENDITION.preset,
    "-crf",
    String(VIDEO_RENDITION.crf),
    "-profile:v",
    VIDEO_RENDITION.profile,
    "-pix_fmt",
    VIDEO_RENDITION.pixelFormat,
    "-vf",
    videoFilter(probe, { tonemap: opts.tonemap }),
    ...(probe.hdr && opts.tonemap
      ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
      : []),
    ...(probe.hasAudio
      ? [
          "-c:a",
          VIDEO_RENDITION.audioCodec,
          "-b:a",
          `${VIDEO_RENDITION.audioBitrateKbps}k`,
          "-ac",
          "2",
        ]
      : []),
    "-t",
    String(opts.maxSeconds),
    ...COMMON_OUT,
    output,
  ];
}

// --- Verification --------------------------------------------------------------------------------

/**
 * Top-level ISO-BMFF box walk over the first bytes of the file: true when `moov` comes before
 * `mdat` (faststart). Boxes with a 64-bit size are honoured; an unparsable head is `false`.
 */
export function moovBeforeMdat(head: Buffer): boolean {
  let off = 0;
  let moov = -1;
  let mdat = -1;
  while (off + 8 <= head.byteLength) {
    let size = head.readUInt32BE(off);
    const type = head.toString("latin1", off + 4, off + 8);
    if (size === 1) {
      if (off + 16 > head.byteLength) break;
      const big = head.readBigUInt64BE(off + 8);
      size = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
    } else if (size === 0) {
      size = head.byteLength - off;
    }
    if (type === "moov" && moov < 0) moov = off;
    if (type === "mdat" && mdat < 0) mdat = off;
    if (moov >= 0 && mdat >= 0) break;
    if (size < 8) return false;
    off += size;
  }
  return moov >= 0 && (mdat < 0 || moov < mdat);
}

/** Tag keys the rendition must not carry (`-map_metadata -1` drops them; this is the tripwire). */
const FORBIDDEN_OUTPUT_TAG = /location|iso6709|creation_time|creationdate|gps|make$|model$/i;

async function verifyRendition(deps: TranscodeDeps, output: string): Promise<VideoProbe> {
  let probe: VideoProbe;
  try {
    probe = await probeVideo(deps.ffprobePath, output);
  } catch (err) {
    throw new TranscodeFailure(err instanceof ProbeError ? err.category : "verify_probe");
  }
  if (probe.codec !== "h264") throw new TranscodeFailure("verify_codec");
  if (Math.max(probe.width, probe.height) > VIDEO_RENDITION.longEdge) {
    throw new TranscodeFailure("verify_size");
  }
  for (const key of Object.keys(probe.tags)) {
    if (FORBIDDEN_OUTPUT_TAG.test(key)) throw new TranscodeFailure("verify_tags");
  }
  const fh = await open(output, "r");
  try {
    const head = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await fh.read(head, 0, head.byteLength, 0);
    if (!moovBeforeMdat(head.subarray(0, bytesRead)))
      throw new TranscodeFailure("verify_faststart");
  } finally {
    await fh.close();
  }
  return probe;
}

// --- Handler -------------------------------------------------------------------------------------

/** Mark the rendition failed (row stays live with its poster) and the upload file `transcode_failed`. */
export async function markTranscodeFailed(pool: PipelinePool, photoId: string): Promise<void> {
  await runAsPipeline(pool, {}, async (c) => {
    await c.query(MARK_RENDITION_SQL, [photoId, "failed"]);
    await c.query(MARK_TRANSCODE_FAILED_FILE_SQL, [photoId]);
  });
}

/**
 * Build the rendition and keyframes of one video. Resolves `ready` / `skipped` / `failed`
 * (non-retryable: bad source or failed verification, marked here). Throws for transient trouble
 * (low scratch space, storage, database, ffmpeg crash or timeout) so pg-boss retries; the job
 * handler marks `failed` after the last attempt.
 */
export async function transcodeVideo(
  deps: TranscodeDeps,
  job: VideoTranscodeJob,
): Promise<TranscodeResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const { log } = deps;
  const photoId = job.photoId;

  // 1. Load; skip anything that is not a live, un-quarantined video waiting for a rendition.
  const row = await runAsPipeline(deps.pool, {}, async (c) => {
    return (await c.query<VideoRow>(LOAD_VIDEO_SQL, [photoId])).rows[0];
  });
  if (
    !row ||
    row.baby_id !== job.babyId ||
    row.media_kind !== "video" ||
    row.deleted_at ||
    row.quarantined_at ||
    !(row.rendition_status === "pending" || row.rendition_status === "failed") ||
    row.status !== "ingested" ||
    !row.sha256
  ) {
    log.debug({ photoId, reason: row ? "not_runnable" : "missing" }, "transcode: skip");
    return { outcome: "skipped", photoId, ms: ms() };
  }
  const babyId = row.baby_id;

  const paths = scratchPaths(deps.scratchPath, photoId);
  try {
    // 2. Scratch room (a 2 GB original + its rendition + headroom).
    await ensureScratchDir(deps.scratchPath);
    await assertScratchRoom(
      deps.scratchPath,
      deps.minFreeBytes ?? VIDEO_SCRATCH_MIN_FREE_BYTES,
      deps.statfs,
    );

    // 3. Source: the staged original from ingest when it is whole (exactly `photos.bytes`; a
    //    crash mid-stage leaves a truncated file), else a fresh download whose hash must match.
    //    Its mtime is bumped first: the scratch sweep reads mtime as "active", and a staged
    //    original's mtime is its staging time, which may be long before this run starts.
    const now = new Date();
    await utimes(paths.orig, now, now).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    const expectedBytes = row.bytes === null ? null : Number(row.bytes);
    let inBytes = await fileSize(paths.orig);
    if (inBytes === null || expectedBytes === null || inBytes !== expectedBytes) {
      await rm(paths.orig, { force: true }).catch(() => undefined);
      const got = await deps.storage.getObjectToFile(row.storage_key_original, paths.orig);
      if (!got.sha256.equals(row.sha256)) throw new TranscodeFailure("source_hash_mismatch");
      inBytes = got.bytes;
    }
    const source = paths.orig;

    // 4. Probe (the ingest already validated; the row's duration is the truth for limits).
    let probe: VideoProbe;
    try {
      probe = await probeVideo(deps.ffprobePath, source);
    } catch (err) {
      if (err instanceof ProbeError && !err.spawnFailed) {
        throw new TranscodeFailure(
          err.category === "unsupported_media_type" ? "source_unsupported" : "probe_failed",
        );
      }
      throw err;
    }
    // Both containers probe as `mov,mp4,m4a,3gp,3g2,mj2`; the major brand tells them apart.
    const mime = probe.majorBrand === "qt" ? "video/quicktime" : "video/mp4";
    // `-t` cap: the plan limit is compared on rounded whole seconds (a "1:00" phone clip is
    // 60.x s), so the rendition keeps up to `maxSeconds + 1` and never cuts an accepted clip.
    const maxSeconds = videoLimitsFor(row.plan).maxSeconds + 1;
    const timeoutMs = deps.timeoutSec * 1000;

    // 5. Remux or transcode (HDR: tone-map, fall back to a plain format conversion).
    const remux = canRemux(probe, mime);
    let hdrTonemap = probe.hdr;
    if (remux) {
      await runFfmpeg(deps, remuxArgs(source, paths.web, probe, deps.threads), timeoutMs);
    } else {
      try {
        await runFfmpeg(
          deps,
          transcodeArgs(source, paths.web, probe, {
            threads: deps.threads,
            tonemap: hdrTonemap,
            maxSeconds,
          }),
          timeoutMs,
        );
      } catch (err) {
        if (
          probe.hdr &&
          hdrTonemap &&
          err instanceof TranscodeFailure &&
          err.reason === "ffmpeg_exit_nonzero"
        ) {
          // zscale "no path between colorspaces" on untagged input, or no libzimg: plain yuv420p.
          // A failure of this second run is a `TranscodeFailure` too (never retried forever).
          hdrTonemap = false;
          await runFfmpeg(
            deps,
            transcodeArgs(source, paths.web, probe, {
              threads: deps.threads,
              tonemap: false,
              maxSeconds,
            }),
            timeoutMs,
          );
        } else {
          throw err;
        }
      }
    }

    // 6. Verify, then publish the rendition.
    const out = await verifyRendition(deps, paths.web);
    const outBytes = (await fileSize(paths.web)) ?? 0;
    const webKey = derivativeKey(babyId, photoId, "web");
    await deps.storage.putObjectFromFile(webKey, paths.web, "video/mp4", {
      cacheControl: CACHE_CONTROL,
    });
    await runAsPipeline(deps.pool, {}, async (c) => {
      await c.query(UPSERT_DERIVATIVE_SQL, [
        photoId,
        "web",
        webKey,
        out.width,
        out.height,
        outBytes,
      ]);
    });

    // 7. Keyframes (768 px, metadata-free JPEGs) for the AI request; a short clip gets one.
    const durationMs = row.duration_ms ?? probe.durationMs;
    // If a sweep removed the original mid-run anyway, frames come from the published rendition.
    const frameSource = (await fileSize(source)) === null ? paths.web : source;
    let keyframes = 0;
    for (const { kind, seconds } of videoKeyframeTimes(durationMs)) {
      let frame: Awaited<ReturnType<typeof extractFrameOrFirst>>;
      try {
        frame = await extractFrameOrFirst(frameSource, seconds, {
          ffmpegPath: deps.ffmpegPath,
          threads: deps.threads,
        });
      } catch (err) {
        // A frame that cannot be decoded or an ffmpeg exit/crash/kill on this seek is skipped
        // (the rendition is already published); `timeout` and `spawn_failed` propagate.
        if (
          err instanceof DecodeError ||
          (err instanceof FfmpegError &&
            err.category !== "timeout" &&
            err.category !== "spawn_failed")
        ) {
          log.warn({ photoId, kind, err: errorCategory(err) }, "transcode: keyframe skipped");
          continue;
        }
        throw err;
      }
      try {
        let rendered: Awaited<ReturnType<typeof renderDerivative>>;
        try {
          rendered = await renderDerivative(frame, "analysis");
        } catch (err) {
          // Same as extraction: an unrenderable frame is skipped, never deferred forever.
          if (err instanceof DecodeError) {
            log.warn({ photoId, kind, err: errorCategory(err) }, "transcode: keyframe skipped");
            continue;
          }
          throw err;
        }
        const key = derivativeKey(babyId, photoId, kind);
        await deps.storage.putObject(key, rendered.buffer, "image/jpeg", {
          cacheControl: CACHE_CONTROL,
        });
        await runAsPipeline(deps.pool, {}, async (c) => {
          await c.query(UPSERT_DERIVATIVE_SQL, [
            photoId,
            kind,
            key,
            rendered.width,
            rendered.height,
            rendered.bytes,
          ]);
        });
        keyframes++;
      } finally {
        frame.release();
      }
    }

    // 8. Ready; scratch files go.
    await runAsPipeline(deps.pool, {}, async (c) => {
      await c.query(MARK_RENDITION_SQL, [photoId, "ready"]);
      await c.query(CLEAR_TRANSCODE_FAILED_FILE_SQL, [photoId]);
    });
    await removeScratch(deps.scratchPath, photoId);
    const result: TranscodeResult = {
      outcome: "ready",
      photoId,
      remux,
      hdr: probe.hdr,
      hdrTonemap: probe.hdr ? hdrTonemap : undefined,
      inBytes: inBytes ?? undefined,
      outBytes,
      keyframes,
      ms: ms(),
    };
    log.info(
      {
        photoId,
        babyId,
        remux,
        hdr: probe.hdr,
        ...(probe.hdr ? { hdrTonemap } : {}),
        inBytes,
        outBytes,
        width: out.width,
        height: out.height,
        keyframes,
        ms: result.ms,
      },
      "video transcoded",
    );
    return result;
  } catch (err) {
    if (err instanceof TranscodeFailure) {
      await markTranscodeFailed(deps.pool, photoId);
      await removeScratch(deps.scratchPath, photoId);
      log.warn({ photoId, babyId, reason: err.reason, ms: ms() }, "transcode: failed");
      return { outcome: "failed", photoId, ms: ms() };
    }
    if (err instanceof ScratchLowError) {
      // Self-healing: give the space back. The staged original is re-downloadable (and
      // size/sha-checked on reuse), so this job's own scratch files go before it defers.
      await removeScratch(deps.scratchPath, photoId);
      log.warn(
        { photoId, freeBytes: err.freeBytes, minFreeBytes: err.minFreeBytes },
        "transcode: scratch low, deferred (staged files released)",
      );
      throw err;
    }
    // Transient (storage, database, ffmpeg timeout): the partial rendition goes, the staged
    // original stays for the retry (the scratch sweep removes it after 6 h, or sooner when scratch
    // is low).
    await rm(paths.web, { force: true }).catch(() => undefined);
    throw err;
  }
}
