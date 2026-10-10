import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  DEMO_IDS,
  type DerivativeKind,
  derivativeKey,
  type IngestJob,
  originalKey,
} from "@tinyglow/shared";
import exifr from "exifr";
import { errorCategory } from "../clients";
import { type PipelinePool, runAsPipeline } from "../db";
import { CACHE_CONTROL, UPSERT_DERIVATIVE_SQL } from "../ingest";
import { decodeImage } from "../ingest/decode";
import { renderDerivative } from "../ingest/derivatives";
import type { WorkerLog } from "../log-types";
import type { ObjectStorage } from "../storage";
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
//
// Runs as `pipeline` (the worker's DB role) with the worker's S3 credentials. Logs ids and counts
// only. The JPEGs carry no metadata (checked by `checkDemoMedia` and the unit tests).

const KINDS: readonly DerivativeKind[] = ["thumb", "display", "analysis"];

export interface DemoMediaDeps {
  pool: PipelinePool;
  /** For HEAD (the `ObjectStorage` interface has no HEAD). */
  s3: Pick<S3Client, "send">;
  bucket: string;
  storage: ObjectStorage;
  log: WorkerLog;
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
SELECT id, baby_id, storage_key_original, width, height, bytes
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

/** Seed photo number (1..12) of a demo photo id, from `DEMO_IDS.photos`. */
function demoNumber(photoId: string): number {
  return (DEMO_IDS.photos as readonly string[]).indexOf(photoId) + 1;
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
  const stale: DerivativeKind[] = [];
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
      await ensureOne(deps, photo, demoScene(nn), derivs.get(photo.id), result);
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
  const out: CheckResult = {
    photos: photos.length,
    expectedPhotos: DEMO_IDS.photos.length,
    originals: 0,
    derivatives: 0,
    expectedDerivatives: DEMO_IDS.photos.length * KINDS.length,
    rowsMatching: 0,
    metadataFree: 0,
    objectsChecked: 0,
  };
  for (const photo of photos) {
    const size = await headSize(deps, photo.storage_key_original);
    if (size !== null) {
      out.originals++;
      const buf = await deps.storage.getObject(photo.storage_key_original);
      out.objectsChecked++;
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
    for (const kind of KINDS) {
      const row = derivs.get(photo.id)?.get(kind);
      const key = derivativeKey(photo.baby_id, photo.id, kind);
      if (!row || row.storage_key !== key) continue;
      const dSize = await headSize(deps, key);
      if (dSize === null || dSize !== Number(row.bytes)) continue;
      out.derivatives++;
      const buf = await deps.storage.getObject(key);
      out.objectsChecked++;
      if (await isMetadataFree(buf)) out.metadataFree++;
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
