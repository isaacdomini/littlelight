import { VIDEO_MAX_DIMENSION, VIDEO_MAX_DURATION_MS, type VideoCodec } from "@tinyglow/shared";
import { z } from "zod";
import { FfmpegError, runProcess } from "./ffmpeg";

// ffprobe (docs/plans/step-12.md 2.6 step 2). `ffprobe -v error -print_format json -show_format
// -show_streams <file>` on a staged local file; the JSON is parsed with a lenient zod schema
// (ffprobe adds fields per build) and reduced to what the pipeline needs. The container tags
// (`format.tags`: QuickTime creation date, make/model, and the location tag) are kept on the
// result as a NON-ENUMERABLE `tags` property, like `ExifData.gps`: a stray `log.info({ probe })`
// or `JSON.stringify(probe)` never prints a tag value. `video/metadata.ts` is the only reader.

const num = z.union([z.number(), z.string()]).transform((v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
});

const tagsSchema = z.record(z.string(), z.unknown()).optional();

const streamSchema = z.looseObject({
  index: num.optional(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  profile: z.string().optional(),
  width: num.optional(),
  height: num.optional(),
  coded_width: num.optional(),
  coded_height: num.optional(),
  pix_fmt: z.string().optional(),
  color_transfer: z.string().optional(),
  color_primaries: z.string().optional(),
  color_space: z.string().optional(),
  r_frame_rate: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  duration: num.optional(),
  nb_frames: num.optional(),
  channels: num.optional(),
  sample_rate: num.optional(),
  bit_rate: num.optional(),
  disposition: z.record(z.string(), z.unknown()).optional(),
  side_data_list: z.array(z.looseObject({ rotation: num.optional() })).optional(),
  tags: tagsSchema,
});

const formatSchema = z.looseObject({
  format_name: z.string().optional(),
  format_long_name: z.string().optional(),
  duration: num.optional(),
  size: num.optional(),
  bit_rate: num.optional(),
  nb_streams: num.optional(),
  tags: tagsSchema,
});

export const ffprobeOutputSchema = z.looseObject({
  streams: z.array(streamSchema).default([]),
  format: formatSchema.optional(),
});
export type FfprobeOutput = z.infer<typeof ffprobeOutputSchema>;

export type ProbeErrorCategory =
  /** Not a playable video of an accepted kind (no/too many video streams, codec, size, duration). */
  | "unsupported_media_type"
  /** ffprobe failed or produced no parseable JSON. */
  | "probe_failed";

export class ProbeError extends Error {
  readonly category: ProbeErrorCategory;
  /** True when ffprobe could not be started at all (binary missing): an operator problem, not the input's. */
  readonly spawnFailed: boolean;
  constructor(category: ProbeErrorCategory, spawnFailed = false) {
    super(`probe: ${category}`);
    this.name = "ProbeError";
    this.category = category;
    this.spawnFailed = spawnFailed;
  }
}

/** What the pipeline needs from a clip. Container tags are non-enumerable (see module comment). */
export interface VideoProbe {
  durationMs: number;
  /** Display dimensions after the rotation side data / `rotate` tag (portrait clips: w < h). */
  width: number;
  height: number;
  /** Stored (pre-rotation) dimensions. */
  codedWidth: number;
  codedHeight: number;
  /** 0, 90, 180 or 270. */
  rotation: number;
  codec: VideoCodec;
  profile: string | null;
  pixelFormat: string | null;
  /** Frames per second from `avg_frame_rate` (else `r_frame_rate`), or null. */
  fps: number | null;
  colorTransfer: string | null;
  /** `smpte2084` (HDR10/PQ) or `arib-std-b67` (HLG): the rendition needs a tone-map. */
  hdr: boolean;
  hasAudio: boolean;
  audioCodec: string | null;
  audioChannels: number | null;
  /** ffprobe `format_name` (e.g. `mov,mp4,m4a,3gp,3g2,mj2`). */
  formatName: string | null;
  /** `format.tags.major_brand`, lower-cased, if present. */
  majorBrand: string | null;
  /** Number of streams besides the one video and one optional audio stream (data, subtitles). */
  otherStreams: number;
  /** Non-enumerable. Container + video stream tags (strings only). Never log, never persist as is. */
  readonly tags: Readonly<Record<string, string>>;
}

/** Parse ffprobe's `avg_frame_rate` / `r_frame_rate` (`30000/1001`, `30/1`, `0/0`). */
export function parseFrameRate(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+)(?:\/(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const d = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n === 0) return null;
  const fps = n / d;
  return fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : null;
}

/** Normalise a rotation value (side data or `rotate` tag) to 0 | 90 | 180 | 270. */
export function normalizeRotation(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  const r = ((Math.round(n) % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

function stringTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tags) return out;
  for (const [k, v] of Object.entries(tags)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

const ACCEPTED_CODECS: ReadonlyMap<string, VideoCodec> = new Map([
  ["h264", "h264"],
  ["hevc", "hevc"],
]);

/** Reduce parsed ffprobe output to a `VideoProbe`; `ProbeError('unsupported_media_type')` when it is not an accepted clip. */
export function reduceProbe(out: FfprobeOutput): VideoProbe {
  const videoStreams = out.streams.filter(
    (s) =>
      s.codec_type === "video" &&
      // Cover art in an audio file is a video stream with `attached_pic`.
      !(s.disposition && Number(s.disposition.attached_pic) === 1),
  );
  const audioStreams = out.streams.filter((s) => s.codec_type === "audio");
  const video = videoStreams[0];
  if (!video || videoStreams.length !== 1) throw new ProbeError("unsupported_media_type");
  const codec = ACCEPTED_CODECS.get((video.codec_name ?? "").toLowerCase());
  if (!codec) throw new ProbeError("unsupported_media_type");

  const durationSec = out.format?.duration ?? video.duration;
  if (durationSec === undefined || !(durationSec > 0))
    throw new ProbeError("unsupported_media_type");
  const durationMs = Math.round(durationSec * 1000);
  if (durationMs < 1 || durationMs > VIDEO_MAX_DURATION_MS) {
    throw new ProbeError("unsupported_media_type");
  }

  const codedWidth = video.width ?? video.coded_width;
  const codedHeight = video.height ?? video.coded_height;
  if (!codedWidth || !codedHeight || codedWidth < 1 || codedHeight < 1) {
    throw new ProbeError("unsupported_media_type");
  }
  const sideRotation = video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
  const rotation = normalizeRotation(sideRotation ?? video.tags?.rotate);
  const swap = rotation === 90 || rotation === 270;
  const width = Math.round(swap ? codedHeight : codedWidth);
  const height = Math.round(swap ? codedWidth : codedHeight);
  if (Math.max(width, height) > VIDEO_MAX_DIMENSION) throw new ProbeError("unsupported_media_type");

  const audio = audioStreams[0];
  const colorTransfer = video.color_transfer?.toLowerCase() ?? null;
  const tags = { ...stringTags(video.tags), ...stringTags(out.format?.tags) };
  const probe: Omit<VideoProbe, "tags"> = {
    durationMs,
    width,
    height,
    codedWidth: Math.round(codedWidth),
    codedHeight: Math.round(codedHeight),
    rotation,
    codec,
    profile: video.profile ?? null,
    pixelFormat: video.pix_fmt ?? null,
    fps: parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate),
    colorTransfer,
    hdr: colorTransfer === "smpte2084" || colorTransfer === "arib-std-b67",
    hasAudio: audio !== undefined,
    audioCodec: audio?.codec_name?.toLowerCase() ?? null,
    audioChannels: audio?.channels ?? null,
    formatName: out.format?.format_name ?? null,
    majorBrand: tags.major_brand?.trim().toLowerCase() ?? null,
    otherStreams: out.streams.length - videoStreams.length - audioStreams.length,
  };
  return Object.defineProperty(probe, "tags", {
    value: Object.freeze(tags),
    enumerable: false,
    writable: false,
  }) as VideoProbe;
}

/** ffprobe argument list for a local file (exported for tests: no URL can appear here). */
export function ffprobeArgs(filePath: string): string[] {
  return [
    "-v",
    "error",
    "-hide_banner",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-i",
    filePath,
  ];
}

/** Probe a staged local file. Throws `ProbeError`; ffprobe crashes/timeouts are `probe_failed`. */
export async function probeVideo(
  ffprobePath: string,
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<VideoProbe> {
  let stdout: Buffer;
  try {
    ({ stdout } = await runProcess(ffprobePath, ffprobeArgs(filePath), {
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxStdoutBytes: 4 * 1024 * 1024,
    }));
  } catch (err) {
    // ffprobe exits 1 on an unreadable/unknown file: that is a bad upload, not a worker fault.
    if (err instanceof FfmpegError && err.category === "exit_nonzero") {
      throw new ProbeError("unsupported_media_type");
    }
    throw new ProbeError(
      "probe_failed",
      err instanceof FfmpegError && err.category === "spawn_failed",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw new ProbeError("probe_failed");
  }
  const parsed = ffprobeOutputSchema.safeParse(json);
  if (!parsed.success) throw new ProbeError("probe_failed");
  return reduceProbe(parsed.data);
}
