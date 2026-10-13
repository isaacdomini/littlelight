import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { type DecodedSource, DecodeError, decodeImage } from "../ingest/decode";
import { FfmpegError, runProcess } from "./ffmpeg";

// Still frames from a staged clip (docs/plans/step-12.md 2.6 steps 4 and 7): one PNG frame
// written next to the staged file (`<file>.<random>.frame.png`, removed right after it is read;
// no stdio pipes, see `assertLocalArgs`), auto-rotated by ffmpeg (display orientation), scaled so
// its long edge is at most `FRAME_MAX_EDGE` (the `display` derivative is 1600 px; nothing is
// enlarged), then decoded by the ingest pipeline's own `decodeImage` so `renderDerivative`
// produces the usual metadata-free JPEGs. PNG output carries no container tags, and sharp strips
// everything anyway.

/** Long edge of an extracted frame (≥ the largest JPEG derivative, never enlarged). */
export const FRAME_MAX_EDGE = 2048;

/** ffmpeg argument list for one frame at `seconds` into `outPath` (exported for tests: paths only). */
export function frameArgs(
  filePath: string,
  seconds: number,
  threads: number,
  outPath: string,
): string[] {
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return [
    "-v",
    "error",
    "-hide_banner",
    "-nostdin",
    "-threads",
    String(Math.max(1, Math.min(8, Math.round(threads)))),
    "-ss",
    t.toFixed(3),
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-vf",
    `scale='min(${FRAME_MAX_EDGE},iw)':'min(${FRAME_MAX_EDGE},ih)':force_original_aspect_ratio=decrease:flags=bicubic`,
    "-f",
    "image2",
    "-update",
    "1",
    "-c:v",
    "png",
    "-y",
    outPath,
  ];
}

/** Sibling path for the frame of `filePath` (same folder, so it lives on the scratch disk). */
function framePath(filePath: string): string {
  return path.join(path.dirname(filePath), `${path.basename(filePath)}.${randomUUID()}.frame.png`);
}

export interface FrameOptions {
  ffmpegPath: string;
  threads: number;
  timeoutMs?: number;
}

/**
 * Extract the frame at `seconds` as a decoded source for `renderDerivative`. A seek past the
 * end yields no frame: the caller retries at 0 (`extractFrameOrFirst`). Decode failures are
 * `DecodeError` (non-retryable `decode_failed`); ffmpeg failures are `FfmpegError`.
 */
export async function extractFrame(
  filePath: string,
  seconds: number,
  opts: FrameOptions,
): Promise<DecodedSource> {
  const out = framePath(filePath);
  let png: Buffer;
  try {
    await runProcess(opts.ffmpegPath, frameArgs(filePath, seconds, opts.threads, out), {
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    try {
      png = await readFile(out);
    } catch {
      // A seek past the end writes nothing.
      throw new DecodeError("no_frame");
    }
  } finally {
    await rm(out, { force: true }).catch(() => undefined);
  }
  if (png.byteLength === 0) throw new DecodeError("no_frame");
  return decodeImage(png, "image/png");
}

/** `extractFrame` at `seconds`, falling back to the first frame when the seek produced none. */
export async function extractFrameOrFirst(
  filePath: string,
  seconds: number,
  opts: FrameOptions,
): Promise<DecodedSource> {
  try {
    return await extractFrame(filePath, seconds, opts);
  } catch (err) {
    const noFrame =
      (err instanceof DecodeError && err.reason === "no_frame") ||
      (err instanceof FfmpegError && err.category === "exit_nonzero");
    if (!noFrame || seconds === 0) throw err;
    return extractFrame(filePath, 0, opts);
  }
}
