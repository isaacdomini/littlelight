import {
  type DerivativeKind,
  type MediaMime,
  type Plan,
  planSchema,
  type VideoMime,
  videoMimeSchema,
} from "./db-enums";

// Video limits and rendition settings (docs/plans/step-12.md 0 (Q1–Q4, Q6, Q8), 2.3, 2.6, 2.11;
// PRD FR-2, FR-4, FR-6.1, "Pricing": storage is the cost driver). Browser-safe: no Node imports.
// The api enforces the per-plan limits at register, the worker re-validates after ffprobe, the
// web and native clients use them for the pre-flight check and copy. SQL mirrors are named
// where they exist; change both together.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface VideoLimits {
  /** Longest clip accepted, seconds (`video_too_long` above it). */
  readonly maxSeconds: number;
  /** Largest original accepted, bytes (`file_too_large` above it). */
  readonly maxBytes: number;
}

/**
 * Per-clip limits by plan. Free (Q1): 60 s and 250 MB (original kept + 1080p web rendition; one
 * video is one item of the family's 1,000). Plus (Q2): 5 minutes and 2 GB (original at full
 * resolution, 4K ok, one 1080p rendition). `plus.maxBytes` is also the `upload_files.declared_bytes`
 * CHECK (`UPLOAD_MAX_VIDEO_BYTES`).
 */
export const VIDEO_LIMITS = {
  free: { maxSeconds: 60, maxBytes: 250 * MIB },
  plus: { maxSeconds: 300, maxBytes: 2 * GIB },
} as const satisfies Record<Plan, VideoLimits>;

/** The per-clip limits of a plan (`babies.plan`); throws on an unknown plan. */
export function videoLimitsFor(plan: Plan): VideoLimits {
  return VIDEO_LIMITS[planSchema.parse(plan)];
}

/**
 * Most live videos across one family's free albums (Q3; inside the 1,000-item pool). Mirror of the
 * SQL default in `public.free_tier_video_limit()` (`photos_free_tier_video_cap` trigger, advisory
 * lock class 1016, GUC `app.free_tier_video_limit`); the api reads the effective limit from the
 * database, this constant is for copy.
 */
export const FREE_TIER_VIDEO_LIMIT = 100;

/**
 * Plus fair-use soft cap per family (Q4): original + rendition bytes of all its videos. Operator
 * report (`abuse-report.ts`) only; no user-facing enforcement.
 */
export const PLUS_FAIR_USE_BYTES_PER_FAMILY = 200 * GIB;

/**
 * The one playable rendition of every video (`photo_derivatives.kind = 'web'`,
 * `derivatives/{id}/web.mp4`): H.264 High / yuv420p at ≤ 1080p (long edge 1920, never
 * enlarged), ≤ 60 fps, AAC stereo 128 kbps, MP4 with `faststart` so every browser and both
 * WebViews play it with range requests straight from MinIO. Metadata and chapters are dropped
 * (`-map_metadata -1 -map_chapters -1`): no QuickTime location or creation tag survives.
 */
export const VIDEO_RENDITION = {
  kind: "web",
  longEdge: 1920,
  videoCodec: "h264",
  profile: "high",
  pixelFormat: "yuv420p",
  crf: 23,
  preset: "veryfast",
  maxFps: 60,
  audioCodec: "aac",
  audioBitrateKbps: 128,
  container: "mp4",
  faststart: true,
} as const satisfies { kind: DerivativeKind } & Record<string, string | number | boolean>;

/**
 * The AI keyframes of a video, sampled at 25 / 50 / 75 % of its duration (768 px JPEG, q75,
 * metadata-free, ≤ 400 KB). A clip shorter than 3 s gets `keyframe1` only. Sent with the
 * poster (`analysis`) as up to four images of one vision request (paid albums only).
 */
export const VIDEO_KEYFRAME_KINDS = [
  "keyframe1",
  "keyframe2",
  "keyframe3",
] as const satisfies readonly DerivativeKind[];
export type VideoKeyframeKind = (typeof VIDEO_KEYFRAME_KINDS)[number];
/** Fractions of the duration at which `VIDEO_KEYFRAME_KINDS[i]` is sampled. */
export const VIDEO_KEYFRAME_POSITIONS = [0.25, 0.5, 0.75] as const;
/** Clips shorter than this get one keyframe (`keyframe1`), never duplicates. */
export const VIDEO_KEYFRAME_MIN_SECONDS = 3;
/** Long edge of a keyframe JPEG (same as the `analysis` derivative: the adapters' cap). */
export const VIDEO_KEYFRAME_LONG_EDGE = 768;

/** Poster frame time: `min(VIDEO_POSTER_SECONDS, 10 % of the duration)` seconds into the clip. */
export const VIDEO_POSTER_SECONDS = 1;

/** Longest edge (px) accepted after rotation; 8K is refused (`unsupported_media_type`). */
export const VIDEO_MAX_DIMENSION = 4096;

/** Q6: on native, uploads larger than this default to Wi-Fi only (per-upload "Use cellular" switch). */
export const VIDEO_LARGE_FILE_BYTES = 50 * MIB;

/**
 * Q8: `video.transcode` defers (throws, pg-boss retries) when the scratch folder
 * (`WORKER_SCRATCH_PATH`) has less free space than this: a 2 GB original plus a ~1 GB rendition
 * and headroom.
 */
export const VIDEO_SCRATCH_MIN_FREE_BYTES = 6 * GIB;

/** Scratch files of a video whose photo is no longer `pending` are deleted after this many hours (`uploads.sweep`). */
export const VIDEO_SCRATCH_TTL_HOURS = 6;

/** `ingest.reconcile` re-sends `video.transcode` for `rendition_status = 'pending'` rows older than this. */
export const VIDEO_TRANSCODE_STUCK_MINUTES = 15;

/** Upper bound of a declared/probed duration (24 h), far above any plan's limit. */
export const VIDEO_MAX_DURATION_MS = 86_400_000;

/** True for `video/mp4` and `video/quicktime` (narrowing helper for `photos.mime` values). */
export function isVideoMime(mime: MediaMime | string | null | undefined): mime is VideoMime {
  return videoMimeSchema.safeParse(mime).success;
}

/** The poster time in seconds for a clip of `durationMs` (`min(1 s, 10 %)`, never negative). */
export function videoPosterSeconds(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(VIDEO_POSTER_SECONDS, (durationMs / 1000) * 0.1);
}

/**
 * Keyframe sample times (seconds) for a clip of `durationMs`, paired with their kinds: three for
 * clips of `VIDEO_KEYFRAME_MIN_SECONDS` or longer, one (`keyframe1` at the midpoint) for shorter
 * clips, none for a non-positive duration.
 */
export function videoKeyframeTimes(
  durationMs: number,
): ReadonlyArray<{ kind: VideoKeyframeKind; seconds: number }> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const seconds = durationMs / 1000;
  if (seconds < VIDEO_KEYFRAME_MIN_SECONDS) return [{ kind: "keyframe1", seconds: seconds / 2 }];
  return VIDEO_KEYFRAME_KINDS.map((kind, i) => ({
    kind,
    seconds: seconds * (VIDEO_KEYFRAME_POSITIONS[i] as number),
  }));
}

/**
 * Duration badge text: `"0:42"`, `"12:05"`, `"1:02:05"` (hours only when ≥ 1 h). Rounds to the
 * nearest second; a non-finite or negative input renders `"0:00"`.
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * Plain-language duration for prose (the search document, chat): `"42 seconds"`, `"1 minute"`,
 * `"2 minutes 5 seconds"`. Deterministic: same input ⇒ same text.
 */
export function describeDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (m === 0) return unit(s, "second");
  return s === 0 ? unit(m, "minute") : `${unit(m, "minute")} ${unit(s, "second")}`;
}
