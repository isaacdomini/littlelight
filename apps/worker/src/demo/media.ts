import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  DEMO_IDS,
  type DerivativeKind,
  derivativeKey,
  type ImageDerivativeKind,
  type IngestJob,
  originalKey,
  type VideoKeyframeKind,
  videoKeyframeTimes,
  videoPosterSeconds,
} from "@tinyglow/shared";
import exifr from "exifr";
import { errorCategory } from "../clients";
import { type PipelinePool, runAsPipeline } from "../db";
import { CACHE_CONTROL, UPSERT_DERIVATIVE_SQL } from "../ingest";
import { decodeImage } from "../ingest/decode";
import { renderDerivative } from "../ingest/derivatives";
import type { WorkerLog } from "../log-types";
import type { ObjectStorage } from "../storage";
import { runProcess } from "../video/ffmpeg";
import { probeVideo, type VideoProbe } from "../video/ffprobe";
import { extractFrameOrFirst } from "../video/frames";
import { remuxArgs } from "../video/transcode";
import { renderDemoClip } from "./clip";
import { demoScene, renderScene, reviewScene, type Scene } from "./illustrations";

// Demo media (docs/plans/step-9.md 2.11, task 9.12; user decision D5).
//
// * `ensureDemoMedia` (dev family "Maya"): for each of the 12 seeded demo photos, put the scene's
//   JPEG at `photos.storage_key_original` when the object is missing, then make sure the thumb,
//   display and analysis derivatives exist and their `photo_derivatives` rows describe the stored
//   objects (key and byte size), rendering them from the stored original with the ingest
//   pipeline's own `decodeImage` + `renderDerivative` (same sizes, same stripping). The seed writes
//   placeholder sizes on every run, so a re-seed is repaired here without re-uploading anything.
//   `photos.width/height/bytes` are corrected to the real original. Idempotent: a second run reads
//   and HEADs only. No ingest job, no model call.
// * `writeReviewMedia` (store-review baby "Sunny", `db:review-family`): for each of the baby's
//   photos still waiting for ingest (`uploaded`/`failed`) whose original key is exactly
//   `babies/<thatBabyId>/originals/<id>.jpg` (the key `db:review-family` writes; inside the baby's
//   prefix, so photo purge, baby purge and account deletion remove it like any upload), put the
//   scene's JPEG there when missing and enqueue the normal `photo.ingest` job (derivatives,
//   dedupe, EXIF, then AI on Plus through the usual pipeline). Rows with any other key (another
//   baby's prefix, a real upload's extension-less key, anything else) are never touched.
// * `checkDemoMedia`: read-only verification for `pnpm demo:media --check`.
// * Step 12 (docs/plans/step-12.md 2.6): the 13th demo item is a 4-second clip (`DEMO_IDS.video`)
//   rendered in code by ffmpeg (`demo/clip.ts`): the original `.mp4`, the poster frame as
//   thumb/display/analysis, the `web` rendition (a tag-free remux) and `keyframe1..3`, with
//   `photos.duration_ms` / `video_codec` / `has_audio` corrected from ffprobe.
//
// Runs as `pipeline` (the worker's DB role) with the worker's S3 credentials. Logs ids and counts
// only. The JPEGs carry no metadata (checked by `checkDemoMedia` and the unit tests); the clip
// and its rendition carry no container tags (ffprobe-checked the same way).

const KINDS: readonly ImageDerivativeKind[] = ["thumb", "display", "analysis"];
/** Derivatives of the demo clip: poster sizes, the rendition and the three keyframes. */
export const VIDEO_KINDS: readonly DerivativeKind[] = [
  "thumb",
  "display",
  "analysis",
  "web",
  "keyframe1",
  "keyframe2",
  "keyframe3",
];
/** Number of derivative objects the dev demo family has once ensured (12 photos × 3 + the clip's 7). */
export const EXPECTED_DEMO_DERIVATIVES =
  (DEMO_IDS.photos.length - 1) * KINDS.length + VIDEO_KINDS.length;

export interface DemoVideoTools {
  ffmpegPath: string;
  ffprobePath: string;
  threads: number;
}

/** Defaults: the binaries by name (the worker image's), two threads. */
export const DEFAULT_VIDEO_TOOLS: DemoVideoTools = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  threads: 2,
};

export interface DemoMediaDeps {
  pool: PipelinePool;
  /** For HEAD (the `ObjectStorage` interface has no HEAD). */
  s3: Pick<S3Client, "send">;
  bucket: string;
  storage: ObjectStorage;
  log: WorkerLog;
  /** ffmpeg/ffprobe for the demo clip (default `DEFAULT_VIDEO_TOOLS`). */
  video?: DemoVideoTools;
}

/**
 * The dev-only auto-run gate: `SEED_DEMO_FAMILY=true` (the same switch as the seed) and a parsed
 * `NODE_ENV` other than production (the worker config defaults an unset NODE_ENV to production).
 */
export function demoMediaEnabled(
  env: Readonly<Record<string, string | undefined>>,
  nodeEnv: string,
): boolean {
  return env.SEED_DEMO_FAMILY?.trim().toLowerCase() === "true" && nodeEnv !== "production";
}

// --- SQL ---------------------------------------------------------------------------------------

export const DEMO_PHOTOS_SQL = `
SELECT id, baby_id, storage_key_original, width, height, bytes, media_kind, duration_ms
FROM photos
WHERE baby_id = $1 AND id = ANY($2::uuid[])
ORDER BY id`;

export const DERIVATIVE_ROWS_SQL = `
SELECT photo_id, kind, storage_key, bytes
FROM photo_derivatives
WHERE photo_id = ANY($1::uuid[])`;

export const UPDATE_PHOTO_SIZE_SQL = `
UPDATE photos SET width = $2, height = $3, bytes = $4
WHERE id = $1 AND (width IS DISTINCT FROM $2 OR height IS DISTINCT FROM $3 OR bytes IS DISTINCT FROM $4)`;

/** The clip's probed columns (step 12); `media_kind` is the seed's, `rendition_status` stays `ready`. */
export const UPDATE_VIDEO_SIZE_SQL = `
UPDATE photos SET width = $2, height = $3, bytes = $4, duration_ms = $5, video_codec = $6, has_audio = $7
WHERE id = $1 AND media_kind = 'video'
  AND (width IS DISTINCT FROM $2 OR height IS DISTINCT FROM $3 OR bytes IS DISTINCT FROM $4
       OR duration_ms IS DISTINCT FROM $5 OR video_codec IS DISTINCT FROM $6 OR has_audio IS DISTINCT FROM $7)`;

/** Review rows waiting for ingest, oldest first (the order `REVIEW_SCENES` follows). */
export const REVIEW_PHOTOS_SQL = `
SELECT id, baby_id, storage_key_original, status
FROM photos
WHERE baby_id = $1 AND deleted_at IS NULL AND quarantined_at IS NULL
ORDER BY created_at, id`;

interface PhotoRow {
  id: string;
  baby_id: string;
  storage_key_original: string;
  width: number | null;
  height: number | null;
  bytes: number | string | null;
  media_kind?: string;
  duration_ms?: number | null;
}

interface DerivativeRow {
  photo_id: string;
  kind: DerivativeKind;
  storage_key: string;
  bytes: number | string;
}

// --- Object helpers ----------------------------------------------------------------------------

/** Byte size of an object, or null when it does not exist. */
export async function headSize(
  deps: Pick<DemoMediaDeps, "s3" | "bucket">,
  key: string,
): Promise<number | null> {
  try {
    const out = await deps.s3.send(new HeadObjectCommand({ Bucket: deps.bucket, Key: key }));
    return out.ContentLength ?? 0;
  } catch (err) {
    const e = err as { name?: unknown; $metadata?: { httpStatusCode?: number } };
    if (e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404)
      return null;
    throw err;
  }
}

/**
 * Review original key: exactly `babies/<babyId>/originals/<photoId>.jpg`, i.e. the upload key
 * (`originalKey`, which checks both uuids) plus `.jpg`, as `db:review-family` writes it. Real
 * uploads have no extension, so this never equals a real photo's key.
 */
export function reviewOriginalKey(babyId: string, photoId: string): string {
  return `${originalKey(babyId, photoId)}.jpg`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/**
 * JPEG marker segments that can carry metadata (APP1 EXIF/XMP, APP2 ICC, APP13 IPTC, any other
 * APPn but the JFIF APP0, and COM). Walks the header up to SOS. Empty = metadata-free.
 */
export function jpegMetadataSegments(buf: Buffer): string[] {
  const found: string[] = [];
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return ["not-jpeg"];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return [...found, "corrupt"];
    const marker = buf[i + 1] ?? 0;
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xe1 && marker <= 0xef) found.push(`APP${marker - 0xe0}`);
    if (marker === 0xfe) found.push("COM");
    i += 2 + len;
  }
  return found;
}

/** True when neither a segment walk nor exifr finds any metadata in a JPEG. */
export async function isMetadataFree(buf: Buffer): Promise<boolean> {
  if (jpegMetadataSegments(buf).length > 0) return false;
  const tags = (await exifr
    .parse(buf, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: true,
      icc: true,
      iptc: true,
      jfif: false,
      ihdr: false,
    })
    .catch(() => undefined)) as Record<string, unknown> | undefined;
  return !tags || Object.keys(tags).length === 0;
}

// --- Dev demo family ---------------------------------------------------------------------------

export interface EnsureResult {
  photos: number;
  originalsWritten: number;
  /** Derivative objects put into the bucket. */
  derivativesWritten: number;
  /** `photo_derivatives` rows repaired whose object was already right (e.g. after a re-seed). */
  derivativeRowsFixed: number;
  photoRowsUpdated: number;
  unchanged: number;
  failed: number;
}

/** Seed item number (1..13) of a demo photo id, from `DEMO_IDS.photos`; 13 is the clip. */
function demoNumber(photoId: string): number {
  return (DEMO_IDS.photos as readonly string[]).indexOf(photoId) + 1;
}

/** True for the one demo clip (`DEMO_IDS.video`). */
export function isDemoClip(photoId: string): boolean {
  return photoId === DEMO_IDS.video;
}

/** Tag keys the clip and its rendition must not carry (same tripwire as `video/transcode.ts`). */
const FORBIDDEN_TAG = /location|iso6709|creation_time|creationdate|gps|make$|model$/i;

/** True when ffprobe finds no forbidden container tag on a video file. */
export function isVideoMetadataFree(probe: VideoProbe): boolean {
  return Object.keys(probe.tags).every((k) => !FORBIDDEN_TAG.test(k));
}

/** Write bytes to a private temp file and run `fn` on its path; the file is removed afterwards. */
async function withTempFile<T>(
  buf: Buffer,
  ext: string,
  fn: (file: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ll-demo-media-"));
  try {
    const file = path.join(dir, `media.${ext}`);
    await writeFile(file, buf, { mode: 0o600 });
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function loadDemoRows(
  deps: DemoMediaDeps,
): Promise<{ photos: PhotoRow[]; derivs: Map<string, Map<DerivativeKind, DerivativeRow>> }> {
  return runAsPipeline(deps.pool, {}, async (c) => {
    const photos = (await c.query<PhotoRow>(DEMO_PHOTOS_SQL, [DEMO_IDS.baby, [...DEMO_IDS.photos]]))
      .rows;
    const derivRows = (await c.query<DerivativeRow>(DERIVATIVE_ROWS_SQL, [photos.map((p) => p.id)]))
      .rows;
    const derivs = new Map<string, Map<DerivativeKind, DerivativeRow>>();
    for (const d of derivRows) {
      const m = derivs.get(d.photo_id) ?? new Map<DerivativeKind, DerivativeRow>();
      m.set(d.kind, d);
      derivs.set(d.photo_id, m);
    }
    return { photos, derivs };
  });
}

async function ensureOne(
  deps: DemoMediaDeps,
  photo: PhotoRow,
  scene: Scene,
  rows: Map<DerivativeKind, DerivativeRow> | undefined,
  result: EnsureResult,
): Promise<void> {
  const babyId = photo.baby_id;
  // 1. Original.
  let original: Buffer | undefined;
  let originalBytes = await headSize(deps, photo.storage_key_original);
  if (originalBytes === null) {
    const rendered = await renderScene(scene);
    await deps.storage.putObject(photo.storage_key_original, rendered.buffer, "image/jpeg");
    original = rendered.buffer;
    originalBytes = rendered.bytes;
    result.originalsWritten++;
  }

  // 2. Which derivatives (object + row) are missing or out of step with each other. A freshly
  //    written original makes every derivative stale (they may come from an older drawing).
  const stale: ImageDerivativeKind[] = [];
  const sizes = new Map<DerivativeKind, number | null>();
  for (const kind of KINDS) {
    const key = derivativeKey(babyId, photo.id, kind);
    const row = rows?.get(kind);
    const size = await headSize(deps, key);
    sizes.set(kind, size);
    if (
      original !== undefined ||
      !row ||
      row.storage_key !== key ||
      size === null ||
      Number(row.bytes) !== size
    ) {
      stale.push(kind);
    }
  }
  // The size columns are written together below, so `bytes` matching the object means width and
  // height were corrected on an earlier run (the seed's placeholder bytes never match).
  const rowStale =
    photo.bytes === null ||
    Number(photo.bytes) !== originalBytes ||
    photo.width === null ||
    photo.height === null;
  if (stale.length === 0 && !rowStale) {
    result.unchanged++;
    return;
  }

  // 3. Render from the stored original (it is the truth, whoever wrote it).
  const buf = original ?? (await deps.storage.getObject(photo.storage_key_original));
  const source = await decodeImage(buf, "image/jpeg");
  try {
    for (const kind of stale) {
      const d = await renderDerivative(source, kind);
      const key = derivativeKey(babyId, photo.id, kind);
      // Rendering is deterministic: an object of exactly this size is this rendition (only the
      // row was out of step, e.g. the seed rewrote its placeholder sizes). Skip the re-upload.
      if (original !== undefined || sizes.get(kind) !== d.bytes) {
        await deps.storage.putObject(key, d.buffer, "image/jpeg", { cacheControl: CACHE_CONTROL });
        result.derivativesWritten++;
      } else {
        result.derivativeRowsFixed++;
      }
      await runAsPipeline(deps.pool, {}, async (c) => {
        await c.query(UPSERT_DERIVATIVE_SQL, [photo.id, kind, key, d.width, d.height, d.bytes]);
      });
    }
    const updated = await runAsPipeline(deps.pool, {}, async (c) => {
      const r = await c.query(UPDATE_PHOTO_SIZE_SQL, [
        photo.id,
        source.width,
        source.height,
        buf.byteLength,
      ]);
      return r.rowCount ?? 0;
    });
    result.photoRowsUpdated += updated;
  } finally {
    source.release();
  }
}

/** The demo clip (step 12): original `.mp4`, poster derivatives, `web` remux, keyframes, row sizes. */
async function ensureClip(
  deps: DemoMediaDeps,
  photo: PhotoRow,
  rows: Map<DerivativeKind, DerivativeRow> | undefined,
  result: EnsureResult,
): Promise<void> {
  const tools = deps.video ?? DEFAULT_VIDEO_TOOLS;
  const babyId = photo.baby_id;
  // 1. Original.
  let original: Buffer | undefined;
  let originalBytes = await headSize(deps, photo.storage_key_original);
  if (originalBytes === null) {
    const clip = await renderDemoClip({ ffmpegPath: tools.ffmpegPath, threads: tools.threads });
    await deps.storage.putObject(photo.storage_key_original, clip.buffer, "video/mp4");
    original = clip.buffer;
    originalBytes = clip.bytes;
    result.originalsWritten++;
  }

  // 2. Which derivatives are missing or out of step.
  const stale: DerivativeKind[] = [];
  const sizes = new Map<DerivativeKind, number | null>();
  for (const kind of VIDEO_KINDS) {
    const key = derivativeKey(babyId, photo.id, kind);
    const row = rows?.get(kind);
    const size = await headSize(deps, key);
    sizes.set(kind, size);
    if (
      original !== undefined ||
      !row ||
      row.storage_key !== key ||
      size === null ||
      Number(row.bytes) !== size
    ) {
      stale.push(kind);
    }
  }
  const rowStale =
    photo.bytes === null ||
    Number(photo.bytes) !== originalBytes ||
    photo.width === null ||
    photo.height === null ||
    photo.duration_ms === null;
  if (stale.length === 0 && !rowStale) {
    result.unchanged++;
    return;
  }

  // 3. Render from the stored original, staged in a private temp file for ffmpeg/ffprobe.
  const buf = original ?? (await deps.storage.getObject(photo.storage_key_original));
  await withTempFile(buf, "mp4", async (file) => {
    const probe = await probeVideo(tools.ffprobePath, file);
    const frameOpts = { ffmpegPath: tools.ffmpegPath, threads: tools.threads };
    const put = async (
      kind: DerivativeKind,
      buffer: Buffer,
      w: number,
      h: number,
      mime: string,
    ) => {
      const key = derivativeKey(babyId, photo.id, kind);
      if (original !== undefined || sizes.get(kind) !== buffer.byteLength) {
        await deps.storage.putObject(key, buffer, mime, { cacheControl: CACHE_CONTROL });
        result.derivativesWritten++;
      } else {
        result.derivativeRowsFixed++;
      }
      await runAsPipeline(deps.pool, {}, async (c) => {
        await c.query(UPSERT_DERIVATIVE_SQL, [photo.id, kind, key, w, h, buffer.byteLength]);
      });
    };
    const posterKinds = stale.filter((k): k is ImageDerivativeKind =>
      KINDS.includes(k as ImageDerivativeKind),
    );
    if (posterKinds.length > 0) {
      const poster = await extractFrameOrFirst(
        file,
        videoPosterSeconds(probe.durationMs),
        frameOpts,
      );
      try {
        for (const kind of posterKinds) {
          const d = await renderDerivative(poster, kind);
          await put(kind, d.buffer, d.width, d.height, "image/jpeg");
        }
      } finally {
        poster.release();
      }
    }
    if (stale.includes("web")) {
      const out = path.join(path.dirname(file), "web.mp4");
      await runProcess(tools.ffmpegPath, remuxArgs(file, out, probe, tools.threads), {
        timeoutMs: 120_000,
      });
      const web = await readFile(out);
      const webProbe = await probeVideo(tools.ffprobePath, out);
      await put("web", web, webProbe.width, webProbe.height, "video/mp4");
    }
    const keyframes = videoKeyframeTimes(probe.durationMs).filter((k) => stale.includes(k.kind));
    for (const { kind, seconds } of keyframes) {
      const frame = await extractFrameOrFirst(file, seconds, frameOpts);
      try {
        const d = await renderDerivative(frame, "analysis");
        await put(kind as VideoKeyframeKind, d.buffer, d.width, d.height, "image/jpeg");
      } finally {
        frame.release();
      }
    }
    const updated = await runAsPipeline(deps.pool, {}, async (c) => {
      const r = await c.query(UPDATE_VIDEO_SIZE_SQL, [
        photo.id,
        probe.width,
        probe.height,
        buf.byteLength,
        probe.durationMs,
        probe.codec,
        probe.hasAudio,
      ]);
      return r.rowCount ?? 0;
    });
    result.photoRowsUpdated += updated;
  });
}

/**
 * Make the seeded demo photos real (dev only; the caller checks `SEED_DEMO_FAMILY` and
 * `NODE_ENV`). Never throws for one photo: a failure is counted and logged by id, and the next
 * run (worker restart or `pnpm demo:media`) retries.
 */
export async function ensureDemoMedia(deps: DemoMediaDeps): Promise<EnsureResult> {
  const result: EnsureResult = {
    photos: 0,
    originalsWritten: 0,
    derivativesWritten: 0,
    derivativeRowsFixed: 0,
    photoRowsUpdated: 0,
    unchanged: 0,
    failed: 0,
  };
  const { photos, derivs } = await loadDemoRows(deps);
  result.photos = photos.length;
  for (const photo of photos) {
    const nn = demoNumber(photo.id);
    if (nn < 1) continue;
    try {
      if (isDemoClip(photo.id)) await ensureClip(deps, photo, derivs.get(photo.id), result);
      else await ensureOne(deps, photo, demoScene(nn), derivs.get(photo.id), result);
    } catch (err) {
      result.failed++;
      deps.log.warn({ photoId: photo.id, err: errorCategory(err) }, "demo media: photo failed");
    }
  }
  deps.log.info({ ...result }, "demo media: ensured");
  return result;
}

// --- Verification ------------------------------------------------------------------------------

export interface CheckResult {
  photos: number;
  expectedPhotos: number;
  originals: number;
  derivatives: number;
  expectedDerivatives: number;
  rowsMatching: number;
  metadataFree: number;
  objectsChecked: number;
}

/** Read-only: every demo original and derivative exists, matches its row and has no metadata. */
export async function checkDemoMedia(deps: DemoMediaDeps): Promise<CheckResult> {
  const { photos, derivs } = await loadDemoRows(deps);
  const tools = deps.video ?? DEFAULT_VIDEO_TOOLS;
  const out: CheckResult = {
    photos: photos.length,
    expectedPhotos: DEMO_IDS.photos.length,
    originals: 0,
    derivatives: 0,
    expectedDerivatives: EXPECTED_DEMO_DERIVATIVES,
    rowsMatching: 0,
    metadataFree: 0,
    objectsChecked: 0,
  };
  const videoClean = (buf: Buffer) =>
    withTempFile(buf, "mp4", async (file) => {
      const probe = await probeVideo(tools.ffprobePath, file);
      return { probe, clean: isVideoMetadataFree(probe) };
    });
  for (const photo of photos) {
    const clip = isDemoClip(photo.id);
    const size = await headSize(deps, photo.storage_key_original);
    if (size !== null) {
      out.originals++;
      const buf = await deps.storage.getObject(photo.storage_key_original);
      out.objectsChecked++;
      if (clip) {
        const { probe, clean } = await videoClean(buf);
        if (clean) out.metadataFree++;
        if (
          Number(photo.bytes) === size &&
          photo.width === probe.width &&
          photo.height === probe.height &&
          photo.duration_ms === probe.durationMs
        )
          out.rowsMatching++;
      } else {
        if (await isMetadataFree(buf)) out.metadataFree++;
        const meta = await decodeImage(buf, "image/jpeg");
        if (
          Number(photo.bytes) === size &&
          photo.width === meta.width &&
          photo.height === meta.height
        )
          out.rowsMatching++;
        meta.release();
      }
    }
    for (const kind of clip ? VIDEO_KINDS : KINDS) {
      const row = derivs.get(photo.id)?.get(kind);
      const key = derivativeKey(photo.baby_id, photo.id, kind);
      if (!row || row.storage_key !== key) continue;
      const dSize = await headSize(deps, key);
      if (dSize === null || dSize !== Number(row.bytes)) continue;
      out.derivatives++;
      const buf = await deps.storage.getObject(key);
      out.objectsChecked++;
      if (kind === "web") {
        if ((await videoClean(buf)).clean) out.metadataFree++;
      } else if (await isMetadataFree(buf)) out.metadataFree++;
    }
  }
  return out;
}

export function checkPassed(r: CheckResult): boolean {
  return (
    r.photos === r.expectedPhotos &&
    r.originals === r.expectedPhotos &&
    r.derivatives === r.expectedDerivatives &&
    r.rowsMatching === r.expectedPhotos &&
    r.metadataFree === r.objectsChecked
  );
}

// --- Store-review family -----------------------------------------------------------------------

export interface ReviewDeps extends DemoMediaDeps {
  /** `sendIngest(boss, job)`: resolves null when a job for the photo is already queued. */
  sendIngest(job: IngestJob): Promise<string | null>;
}

export interface ReviewResult {
  photos: number;
  waiting: number;
  originalsWritten: number;
  enqueued: number;
  alreadyQueued: number;
  skippedForeignKey: number;
  alreadyIngested: number;
}

const WAITING = new Set(["uploaded", "failed"]);

/**
 * Put the review illustrations at the review baby's `babies/<babyId>/originals/<id>.jpg` keys and
 * enqueue ingest. Only rows whose key is exactly that, for this `babyId`, are touched.
 * Rows are numbered 1..24 by `created_at` (the review-family script spreads them over ten months
 * in its own order), so each scene lands on the row its note describes.
 */
export async function writeReviewMedia(deps: ReviewDeps, babyId: string): Promise<ReviewResult> {
  const rows = await runAsPipeline(deps.pool, {}, async (c) => {
    return (await c.query<PhotoRow & { status: string }>(REVIEW_PHOTOS_SQL, [babyId])).rows;
  });
  const result: ReviewResult = {
    photos: rows.length,
    waiting: 0,
    originalsWritten: 0,
    enqueued: 0,
    alreadyQueued: 0,
    skippedForeignKey: 0,
    alreadyIngested: 0,
  };
  const review = rows.filter(
    (r) => r.baby_id === babyId && r.storage_key_original === reviewOriginalKey(babyId, r.id),
  );
  result.skippedForeignKey = rows.length - review.length;
  for (const [i, row] of review.entries()) {
    if (!WAITING.has(row.status)) {
      result.alreadyIngested++;
      continue;
    }
    result.waiting++;
    const scene = reviewScene((i % 24) + 1);
    if ((await headSize(deps, row.storage_key_original)) === null) {
      const rendered = await renderScene(scene);
      await deps.storage.putObject(row.storage_key_original, rendered.buffer, "image/jpeg");
      result.originalsWritten++;
    }
    const jobId = await deps.sendIngest({ photoId: row.id, babyId: row.baby_id });
    if (jobId) result.enqueued++;
    else result.alreadyQueued++;
  }
  deps.log.info({ babyId, ...result }, "demo media: review photos queued");
  return result;
}
