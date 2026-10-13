import { describe, expect, it } from "vitest";
import { derivativeKindSchema } from "./db-enums";
import { JOBS, videoTranscodeJobSchema } from "./jobs";
import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  ACCEPTED_UPLOAD_MIMES,
  derivativeKey,
  extensionForMime,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_VIDEO_BYTES,
  uploadFileErrorSchema,
} from "./upload";
import {
  describeDuration,
  FREE_TIER_VIDEO_LIMIT,
  formatDuration,
  isVideoMime,
  PLUS_FAIR_USE_BYTES_PER_FAMILY,
  VIDEO_KEYFRAME_KINDS,
  VIDEO_LARGE_FILE_BYTES,
  VIDEO_LIMITS,
  VIDEO_MAX_DIMENSION,
  VIDEO_RENDITION,
  VIDEO_SCRATCH_MIN_FREE_BYTES,
  videoKeyframeTimes,
  videoLimitsFor,
  videoPosterSeconds,
} from "./video";

// Video contracts (docs/plans/step-12.md 0 (Q1–Q4, Q6, Q8), 2.3, 2.11). The limits are the
// user's decisions and are mirrored in SQL / the clients: pin them.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("limits (Q1–Q4, Q6, Q8)", () => {
  it("free: 60 s / 250 MB; plus: 5 min / 2 GB; videoLimitsFor reads them by plan", () => {
    expect(VIDEO_LIMITS.free).toEqual({ maxSeconds: 60, maxBytes: 250 * MIB });
    expect(VIDEO_LIMITS.plus).toEqual({ maxSeconds: 300, maxBytes: 2 * GIB });
    expect(videoLimitsFor("free")).toBe(VIDEO_LIMITS.free);
    expect(videoLimitsFor("plus")).toBe(VIDEO_LIMITS.plus);
    expect(() => videoLimitsFor("gold" as never)).toThrow();
  });

  it("the other decisions: 100 videos per free family, 200 GB fair use, 50 MB Wi-Fi default, 6 GiB scratch floor, 4096 px", () => {
    expect(FREE_TIER_VIDEO_LIMIT).toBe(100);
    expect(PLUS_FAIR_USE_BYTES_PER_FAMILY).toBe(200 * GIB);
    expect(VIDEO_LARGE_FILE_BYTES).toBe(50 * MIB);
    expect(VIDEO_SCRATCH_MIN_FREE_BYTES).toBe(6 * GIB);
    expect(VIDEO_MAX_DIMENSION).toBe(4096);
  });

  it("the upload caps: photos stay at 100 MiB, videos at the Plus cap (the declared_bytes CHECK)", () => {
    expect(UPLOAD_MAX_FILE_BYTES).toBe(100 * MIB);
    expect(UPLOAD_MAX_VIDEO_BYTES).toBe(VIDEO_LIMITS.plus.maxBytes);
    expect(uploadFileErrorSchema.options).toContain("video_too_long");
    expect(uploadFileErrorSchema.options).toContain("transcode_failed");
  });
});

describe("rendition and keyframes", () => {
  it("one H.264/AAC faststart MP4 at ≤ 1080p, three keyframes at 25/50/75 %", () => {
    expect(VIDEO_RENDITION).toMatchObject({
      kind: "web",
      longEdge: 1920,
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      container: "mp4",
      faststart: true,
      maxFps: 60,
    });
    expect([...VIDEO_KEYFRAME_KINDS]).toEqual(["keyframe1", "keyframe2", "keyframe3"]);
    for (const k of ["web", ...VIDEO_KEYFRAME_KINDS]) {
      expect(derivativeKindSchema.safeParse(k).success, k).toBe(true);
    }
  });

  it("videoKeyframeTimes: three for ≥ 3 s, one (midpoint) below, none for a bad duration", () => {
    expect(videoKeyframeTimes(8000)).toEqual([
      { kind: "keyframe1", seconds: 2 },
      { kind: "keyframe2", seconds: 4 },
      { kind: "keyframe3", seconds: 6 },
    ]);
    expect(videoKeyframeTimes(2000)).toEqual([{ kind: "keyframe1", seconds: 1 }]);
    expect(videoKeyframeTimes(0)).toEqual([]);
    expect(videoKeyframeTimes(Number.NaN)).toEqual([]);
    // never two keyframes at the same instant
    const times = videoKeyframeTimes(3000).map((k) => k.seconds);
    expect(new Set(times).size).toBe(times.length);
  });

  it("videoPosterSeconds: min(1 s, 10 %)", () => {
    expect(videoPosterSeconds(60_000)).toBe(1);
    expect(videoPosterSeconds(4000)).toBeCloseTo(0.4);
    expect(videoPosterSeconds(0)).toBe(0);
    expect(videoPosterSeconds(-5)).toBe(0);
  });
});

describe("keys, mimes, extensions", () => {
  const BABY = "11111111-1111-4111-8111-111111111111";
  const PHOTO = "22222222-2222-4222-8222-222222222222";

  it("derivativeKey: web.mp4 for the rendition, .jpg for everything else, all under the derivatives prefix", () => {
    expect(derivativeKey(BABY, PHOTO, "web")).toBe(`babies/${BABY}/derivatives/${PHOTO}/web.mp4`);
    for (const kind of [
      "thumb",
      "display",
      "analysis",
      "keyframe1",
      "keyframe2",
      "keyframe3",
    ] as const) {
      expect(derivativeKey(BABY, PHOTO, kind)).toBe(
        `babies/${BABY}/derivatives/${PHOTO}/${kind}.jpg`,
      );
    }
  });

  it("video mimes and extensions are accepted; isVideoMime narrows", () => {
    expect(ACCEPTED_UPLOAD_MIMES).toContain("video/mp4");
    expect(ACCEPTED_UPLOAD_MIMES).toContain("video/quicktime");
    for (const ext of [".mp4", ".mov", ".m4v"]) expect(ACCEPTED_UPLOAD_EXTENSIONS).toContain(ext);
    expect(extensionForMime("video/mp4")).toBe("mp4");
    expect(extensionForMime("video/quicktime")).toBe("mov");
    expect(isVideoMime("video/mp4")).toBe(true);
    expect(isVideoMime("video/quicktime")).toBe(true);
    expect(isVideoMime("image/jpeg")).toBe(false);
    expect(isVideoMime(null)).toBe(false);
    expect(isVideoMime("video/webm")).toBe(false);
  });
});

describe("durations", () => {
  it("formatDuration: m:ss, h:mm:ss, rounding, bad input", () => {
    expect(formatDuration(42_000)).toBe("0:42");
    expect(formatDuration(725_000)).toBe("12:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(1499)).toBe("0:01");
    expect(formatDuration(1500)).toBe("0:02");
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });

  it("describeDuration: prose for the search document, deterministic", () => {
    expect(describeDuration(42_000)).toBe("42 seconds");
    expect(describeDuration(1000)).toBe("1 second");
    expect(describeDuration(60_000)).toBe("1 minute");
    expect(describeDuration(125_000)).toBe("2 minutes 5 seconds");
    expect(describeDuration(0)).toBe("0 seconds");
  });
});

describe("jobs", () => {
  it("video.transcode is a strict { photoId, babyId } job", () => {
    expect(JOBS.videoTranscode).toBe("video.transcode");
    const ids = {
      photoId: "22222222-2222-4222-8222-222222222222",
      babyId: "11111111-1111-4111-8111-111111111111",
    };
    expect(videoTranscodeJobSchema.parse(ids)).toEqual(ids);
    expect(videoTranscodeJobSchema.safeParse({ ...ids, extra: 1 }).success).toBe(false);
    expect(videoTranscodeJobSchema.safeParse({ photoId: ids.photoId }).success).toBe(false);
  });
});
