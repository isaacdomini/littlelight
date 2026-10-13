import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { VIDEO_SCRATCH_MIN_FREE_BYTES, VIDEO_SCRATCH_TTL_HOURS } from "@tinyglow/shared";

// The scratch folder (docs/plans/step-12.md Q8, 2.6): `WORKER_SCRATCH_PATH` (`/scratch`, a
// disk-backed mount; dev a named volume) holds each video's staged original while it is probed,
// postered and transcoded, and the rendition before it is uploaded. File names are built from the
// photo id only (`<photoId>.orig`, `<photoId>.web.mp4`, `<photoId>.<kind>.jpg`): no user text, no
// traversal. Paths never reach a log line (the Sentry scrubber also drops `/scratch/…`).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScratchPaths {
  /** The staged original (`<photoId>.orig`). */
  orig: string;
  /** The `web` rendition before upload (`<photoId>.web.mp4`). */
  web: string;
}

/** The staged file paths of one photo under `root`. Throws for a non-uuid id. */
export function scratchPaths(root: string, photoId: string): ScratchPaths {
  if (!UUID_RE.test(photoId)) throw new TypeError("photoId must be a uuid");
  const id = photoId.toLowerCase();
  return { orig: path.join(root, `${id}.orig`), web: path.join(root, `${id}.web.mp4`) };
}

/** Photo id of a scratch file name (`<uuid>.orig`, `<uuid>.web.mp4`, …), or null for anything else. */
export function scratchPhotoId(fileName: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i.exec(fileName);
  return m ? (m[1] as string).toLowerCase() : null;
}

/** Create the scratch root (mode 0700) if missing. */
export async function ensureScratchDir(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
}

/** Byte size of a file, or null when it does not exist. */
export async function fileSize(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return null;
  }
}

/** Remove every scratch file of a photo; never throws. */
export async function removeScratch(root: string, photoId: string): Promise<void> {
  const p = scratchPaths(root, photoId);
  await Promise.all([p.orig, p.web].map((f) => rm(f, { force: true }).catch(() => undefined)));
}

export type StatfsFn = (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/** Free bytes available to this process on the file system holding `root`. */
export async function scratchFreeBytes(root: string, fn: StatfsFn = statfs): Promise<number> {
  const s = await fn(root);
  return Number(s.bavail) * Number(s.bsize);
}

/** Thrown by the transcode when the scratch folder is too full to stage a clip (pg-boss retries). */
export class ScratchLowError extends Error {
  readonly freeBytes: number;
  readonly minFreeBytes: number;
  constructor(freeBytes: number, minFreeBytes: number) {
    super("scratch: not enough free space");
    this.name = "ScratchLowError";
    this.freeBytes = freeBytes;
    this.minFreeBytes = minFreeBytes;
  }
}

/** Throw `ScratchLowError` unless at least `minFree` bytes are available under `root`. */
export async function assertScratchRoom(
  root: string,
  minFree: number = VIDEO_SCRATCH_MIN_FREE_BYTES,
  fn: StatfsFn = statfs,
): Promise<number> {
  const free = await scratchFreeBytes(root, fn);
  if (free < minFree) throw new ScratchLowError(free, minFree);
  return free;
}

export interface ScratchSweepResult {
  scanned: number;
  /** Files older than the TTL, removed (pending or not: originals are re-downloadable). */
  removed: number;
  /** Files younger than the TTL left alone (after any low-space pass). */
  kept: number;
  /** Files removed by the low-space pass (scratch under `minFreeBytes`). */
  lowSpaceRemoved: number;
  /** Free bytes after the sweep (undefined when statfs failed or no threshold was given). */
  freeBytes?: number;
  errors: number;
}

export interface ScratchSweepOptions {
  /** Age after which every scratch file goes (default `VIDEO_SCRATCH_TTL_HOURS`). */
  ttlHours?: number;
  now?: () => Date;
  /**
   * Low-space pass: when free space under `root` is below `minFreeBytes`, files older than
   * `activeMs` (default 1 h: longer than any single transcode run, so a file an active ffmpeg is
   * reading is left alone) are removed oldest-first until the space is back over the threshold.
   * Omitted = no low-space pass.
   */
  minFreeBytes?: number;
  activeMs?: number;
  statfs?: StatfsFn;
}

/** Default age a scratch file must have before the low-space pass may take it (one transcode timeout). */
export const SCRATCH_ACTIVE_MS_DEFAULT = 3_600_000;

/**
 * Scratch sweep (docs/plans/step-12.md 2.6; review fix M2). Two passes, never throws:
 * 1. TTL: every scratch file older than `ttlHours` is deleted, whether or not its video is still
 *    `pending` — a staged original is re-downloadable and the transcode re-downloads whenever the
 *    file is missing or not exactly `photos.bytes`.
 * 2. Low space: while free space is under `minFreeBytes`, the oldest files older than `activeMs`
 *    are deleted one by one until the threshold is met (or none is left). Files that are not ours
 *    (no uuid prefix) are left alone.
 */
export async function sweepScratch(
  root: string,
  opts: ScratchSweepOptions = {},
): Promise<ScratchSweepResult> {
  const result: ScratchSweepResult = {
    scanned: 0,
    removed: 0,
    kept: 0,
    lowSpaceRemoved: 0,
    errors: 0,
  };
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return result;
  }
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const ttlCutoff = nowMs - (opts.ttlHours ?? VIDEO_SCRATCH_TTL_HOURS) * 3_600_000;
  const activeCutoff = nowMs - (opts.activeMs ?? SCRATCH_ACTIVE_MS_DEFAULT);
  const files: { name: string; mtimeMs: number; size: number }[] = [];
  for (const name of names) {
    if (!scratchPhotoId(name)) continue;
    result.scanned++;
    try {
      const s = await stat(path.join(root, name));
      if (s.isFile()) files.push({ name, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      result.errors++;
    }
  }
  const remove = async (name: string): Promise<boolean> => {
    try {
      await rm(path.join(root, name), { force: true });
      return true;
    } catch {
      result.errors++;
      return false;
    }
  };
  // 1. TTL.
  const young: typeof files = [];
  for (const f of files) {
    if (f.mtimeMs < ttlCutoff) {
      if (await remove(f.name)) result.removed++;
    } else young.push(f);
  }
  // 2. Low space.
  if (opts.minFreeBytes !== undefined) {
    const fn = opts.statfs ?? statfs;
    let free: number | undefined;
    try {
      free = await scratchFreeBytes(root, fn);
    } catch {
      result.errors++;
    }
    if (free !== undefined) {
      const candidates = young
        .filter((f) => f.mtimeMs < activeCutoff)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of candidates) {
        if (free >= opts.minFreeBytes) break;
        if (await remove(f.name)) {
          result.lowSpaceRemoved++;
          young.splice(young.indexOf(f), 1);
          try {
            free = await scratchFreeBytes(root, fn);
          } catch {
            free += f.size;
          }
        }
      }
      result.freeBytes = free;
    }
  }
  result.kept = young.length;
  return result;
}
