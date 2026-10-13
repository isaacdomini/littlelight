import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VIDEO_RENDITION } from "@tinyglow/shared";
import sharp from "sharp";
import { runProcess } from "../video/ffmpeg";
import { DEMO_CLIP_SCENES, ILLUSTRATION_HEIGHT, ILLUSTRATION_WIDTH } from "./illustrations";

// The demo clip (step 12, docs/plans/step-12.md 2.6 "demo/"): a 4-second portrait H.264 MP4
// rendered in code from two SVG frames (`DEMO_CLIP_SCENES`) that ffmpeg cross-fades, so the dev
// family and the store-review screenshots show a video tile without any real footage in the
// repository. No audio, no container tags (`-map_metadata -1`), bit-exact flags (the same ffmpeg
// build gives the same bytes), `faststart`. ffmpeg reads and writes a private temp dir only.

/** Output size (portrait phone clip, same 3:4 as the illustrations, even dimensions for yuv420p). */
export const DEMO_CLIP_WIDTH = 1080;
export const DEMO_CLIP_HEIGHT = 1440;
/** Clip length in seconds (the seed's `duration_ms` 4000). */
export const DEMO_CLIP_SECONDS = 4;
const FPS = 30;
/** Each still is shown this long; the cross-fade overlaps them by `FADE_SECONDS`. */
const STILL_SECONDS = 2.5;
const FADE_SECONDS = 1;

export interface RenderedClip {
  buffer: Buffer;
  bytes: number;
  width: number;
  height: number;
  durationMs: number;
}

async function renderFramePng(draw: () => string): Promise<Buffer> {
  return sharp(Buffer.from(draw(), "utf8"), { density: 72 })
    .resize(ILLUSTRATION_WIDTH, ILLUSTRATION_HEIGHT, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .resize(DEMO_CLIP_WIDTH, DEMO_CLIP_HEIGHT, { fit: "fill" })
    .toColourspace("srgb")
    .png()
    .toBuffer();
}

/** ffmpeg argument list of the clip (exported for tests: local paths only, no tags kept). */
export function demoClipArgs(
  frameA: string,
  frameB: string,
  out: string,
  threads: number,
): string[] {
  const offset = STILL_SECONDS - FADE_SECONDS;
  const still = String(STILL_SECONDS);
  return [
    "-v",
    "error",
    "-hide_banner",
    "-nostdin",
    "-threads",
    String(Math.max(1, Math.min(8, threads))),
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-t",
    still,
    "-i",
    frameA,
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-t",
    still,
    "-i",
    frameB,
    "-filter_complex",
    `[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]xfade=transition=fade:duration=${FADE_SECONDS}:offset=${offset},format=yuv420p`,
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
    "-r",
    String(FPS),
    "-t",
    String(DEMO_CLIP_SECONDS),
    "-an",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "-y",
    out,
  ];
}

/** Render the demo clip with ffmpeg (needs `ffmpeg` with libx264; the worker image has it). */
export async function renderDemoClip(opts: {
  ffmpegPath: string;
  threads: number;
}): Promise<RenderedClip> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ll-demo-clip-"));
  try {
    const [a, b] = DEMO_CLIP_SCENES;
    const frameA = path.join(dir, "a.png");
    const frameB = path.join(dir, "b.png");
    const out = path.join(dir, "clip.mp4");
    await writeFile(frameA, await renderFramePng(a.draw), { mode: 0o600 });
    await writeFile(frameB, await renderFramePng(b.draw), { mode: 0o600 });
    await runProcess(opts.ffmpegPath, demoClipArgs(frameA, frameB, out, opts.threads), {
      timeoutMs: 300_000,
    });
    const buffer = await readFile(out);
    return {
      buffer,
      bytes: buffer.byteLength,
      width: DEMO_CLIP_WIDTH,
      height: DEMO_CLIP_HEIGHT,
      durationMs: DEMO_CLIP_SECONDS * 1000,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
