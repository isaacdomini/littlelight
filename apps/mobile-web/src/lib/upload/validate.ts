import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  ACCEPTED_UPLOAD_MIMES,
  ACCEPTED_VIDEO_EXTENSIONS,
  type MediaKind,
  type MediaMime,
  type Plan,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_VIDEO_BYTES,
  videoLimitsFor,
} from "@tinyglow/shared";

/**
 * Client-side refusals (UX only; the server and worker re-check): `unsupported` / `too_large`
 * as before, plus `video_too_long` once the duration has been read (docs/plans/step-12.md 2.8).
 */
export type RejectReason = "unsupported" | "too_large" | "video_too_long";

/** `accept` attribute for the file input: photos and MP4/QuickTime videos. */
export const FILE_ACCEPT = [...ACCEPTED_UPLOAD_EXTENSIONS, ...ACCEPTED_UPLOAD_MIMES].join(",");

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

export function acceptedMime(type: string): MediaMime | undefined {
  const t = type.toLowerCase();
  return (ACCEPTED_UPLOAD_MIMES as readonly string[]).includes(t) ? (t as MediaMime) : undefined;
}

/**
 * `video` when the mime says so or the extension is a video one (QuickTime files often arrive
 * with an empty mime), else `photo`.
 */
export function mediaKindOf(file: { name: string; type: string }): MediaKind {
  if (file.type.toLowerCase().startsWith("video/")) return "video";
  return (ACCEPTED_VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(file.name))
    ? "video"
    : "photo";
}

/** The byte cap this client applies to a file: the photo cap, or the plan's video cap. */
export function maxBytesFor(kind: MediaKind, plan: Plan | undefined): number {
  if (kind === "photo") return UPLOAD_MAX_FILE_BYTES;
  return plan ? videoLimitsFor(plan).maxBytes : UPLOAD_MAX_VIDEO_BYTES;
}

/**
 * Client-side gate (UX only; the server and worker re-check). HEIC often arrives with an empty
 * mime, so a known extension or a known mime is enough, but a mime that is neither image nor
 * video is rejected. Photos are capped at 100 MiB; videos at the plan's per-clip cap (the
 * absolute 2 GiB when the plan is unknown; the api then applies the real one).
 */
export function validateFile(
  file: { name: string; size: number; type: string },
  plan?: Plan,
): RejectReason | null {
  const extOk = (ACCEPTED_UPLOAD_EXTENSIONS as readonly string[]).includes(extensionOf(file.name));
  const mimeOk = acceptedMime(file.type) !== undefined;
  const lower = file.type.toLowerCase();
  const nonMedia = file.type !== "" && !lower.startsWith("image/") && !lower.startsWith("video/");
  if (file.size < 1 || nonMedia || !(extOk || mimeOk)) return "unsupported";
  if (file.size > maxBytesFor(mediaKindOf(file), plan)) return "too_large";
  return null;
}

/** `video_too_long` when a read duration exceeds the plan's clip length; null otherwise. */
export function validateDuration(durationMs: number | undefined, plan: Plan | undefined) {
  if (durationMs === undefined || !plan) return null;
  // Whole seconds, rounded, like the server: a clip shown as "1:00" (60.0x s) is within 60 s.
  return Math.round(durationMs / 1000) > videoLimitsFor(plan).maxSeconds ? "video_too_long" : null;
}

/** How long to wait for `loadedmetadata` before giving up on the duration hint. */
const DURATION_TIMEOUT_MS = 8000;

/**
 * Duration of a local video in whole milliseconds, read from a detached `<video
 * preload="metadata">` (no network, no decode of the frames). Resolves `undefined` when the
 * browser cannot demux the file or takes too long: the hint is optional and the worker's ffprobe
 * is the truth. Never throws.
 */
export function readVideoDuration(file: Blob): Promise<number | undefined> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.resolve(undefined);
  }
  let url: string | null = null;
  try {
    url = URL.createObjectURL(file);
  } catch {
    return Promise.resolve(undefined);
  }
  const objectUrl = url;
  return readVideoDurationFromUrl(objectUrl).finally(() => URL.revokeObjectURL(objectUrl));
}

/**
 * Same as `readVideoDuration` for a URL the WebView can stream with range requests (native:
 * `convertFileSrc(path)`, whose media branch never answers a full-file `fetch`). Only the
 * metadata is loaded; the clip is never read into memory. Never throws.
 */
export function readVideoDurationFromUrl(url: string): Promise<number | undefined> {
  if (typeof document === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let video: HTMLVideoElement | null = document.createElement("video");
    const finish = (ms: number | undefined) => {
      clearTimeout(timer);
      if (video) {
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute("src");
        video.load();
        video = null;
      }
      resolve(ms);
    };
    const timer = setTimeout(() => finish(undefined), DURATION_TIMEOUT_MS);
    try {
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = () => {
        const s = video?.duration;
        finish(s !== undefined && Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : undefined);
      };
      video.onerror = () => finish(undefined);
      video.src = url;
    } catch {
      finish(undefined);
    }
  });
}
