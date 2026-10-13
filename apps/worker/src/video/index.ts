// Video pipeline (docs/plans/step-12.md 2.6): ingest (inside `photo.ingest`) and `video.transcode`.
export { assertLocalArgs, FfmpegError, runProcess } from "./ffmpeg";
export { ProbeError, probeVideo, type VideoProbe } from "./ffprobe";
export { ingestVideo, type StagedOriginal, stageOriginal } from "./ingest";
export { extractVideoMetadata, parseIso6709, type VideoMetadata } from "./metadata";
export {
  assertScratchRoom,
  ensureScratchDir,
  removeScratch,
  ScratchLowError,
  scratchFreeBytes,
  scratchPaths,
  scratchPhotoId,
  sweepScratch,
} from "./scratch";
export {
  markTranscodeFailed,
  type TranscodeDeps,
  TranscodeFailure,
  type TranscodeResult,
  transcodeVideo,
} from "./transcode";
