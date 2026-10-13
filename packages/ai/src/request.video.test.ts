import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION, AI_VIDEO_MAX_FRAMES } from "@tinyglow/shared";
import { describe, expect, it } from "vitest";
import { analysisImage } from "../../../e2e/fixtures/ai-images";
import { AiRequestError } from "./errors";
import { checkVisionRequest, visionImages } from "./request";
import type { AnalysisImage, VisionRequest } from "./types";

// Video items in a vision request (docs/plans/step-12.md 2.7): the poster plus up to three
// keyframes travel as up to four images; every image passes the per-image refusals on its own;
// `context.media.frameCount` must match; a photo may not carry extra frames; nothing bypasses
// the paid-only rule.

const PHOTO = "22222222-2222-4222-8222-222222222222";
const jpeg = (bytes = 4000): AnalysisImage => {
  const base = analysisImage();
  if (bytes === 4000) return base;
  // a copy padded to `bytes` (oversize cases), same decodable JPEG head
  const padded = new Uint8Array(bytes);
  padded.set(base.bytes.subarray(0, Math.min(base.bytes.length, bytes)));
  return { ...base, bytes: padded };
};

function request(over: Partial<VisionRequest> = {}): VisionRequest {
  return {
    photoId: PHOTO,
    plan: "paid",
    promptVersion: AI_PROMPT_VERSION,
    schemaVersion: AI_SCHEMA_VERSION,
    image: jpeg(),
    context: {
      babyAgeDays: 300,
      takenAt: null,
      placeLabel: null,
      people: [],
      milestone: null,
      parentNotes: null,
    },
    ...over,
  } as VisionRequest;
}

const video = (frameCount: number, durationSeconds = 42) => ({
  media: { kind: "video" as const, durationSeconds, frameCount },
});

describe("visionImages", () => {
  it("poster first, then the keyframes; a photo is one image", () => {
    const r = request({ frames: [jpeg(1), jpeg(2), jpeg(3)] });
    const imgs = visionImages(r);
    expect(imgs).toHaveLength(4);
    expect(imgs[0]).toBe(r.image);
    expect(visionImages(request())).toHaveLength(1);
  });
});

describe("checkVisionRequest for videos", () => {
  it("accepts poster + 3 keyframes with media.frameCount 4 and rounds the duration to whole seconds", () => {
    const r = request({
      frames: [jpeg(), jpeg(), jpeg()],
      context: { ...request().context, ...video(4, 41.6) },
    });
    const { request: checked } = checkVisionRequest(r);
    expect(checked.frames).toHaveLength(3);
    expect(checked.context.media).toEqual({ kind: "video", durationSeconds: 42, frameCount: 4 });
  });

  it("a short clip with one keyframe (frameCount 2) is fine; a single poster with media (frameCount 1) too", () => {
    expect(() =>
      checkVisionRequest(
        request({ frames: [jpeg()], context: { ...request().context, ...video(2) } }),
      ),
    ).not.toThrow();
    const { request: one } = checkVisionRequest(
      request({ context: { ...request().context, ...video(1) } }),
    );
    expect(one.frames).toBeUndefined();
  });

  it("refuses a frameCount that disagrees with the images attached (invalid_context: media)", () => {
    const r = request({ frames: [jpeg(), jpeg()], context: { ...request().context, ...video(4) } });
    expect(() => checkVisionRequest(r)).toThrow(AiRequestError);
    try {
      checkVisionRequest(r);
    } catch (e) {
      expect((e as AiRequestError).code).toBe("invalid_context");
      expect((e as AiRequestError).fields).toEqual(["media"]);
    }
  });

  it("refuses a photo (no media) that carries keyframes", () => {
    expect(() => checkVisionRequest(request({ frames: [jpeg()] }))).toThrow(
      /invalid_context|media/,
    );
  });

  it("refuses more than AI_VIDEO_MAX_FRAMES images", () => {
    expect(AI_VIDEO_MAX_FRAMES).toBe(4);
    const r = request({
      frames: [jpeg(), jpeg(), jpeg(), jpeg()],
      context: { ...request().context, ...video(5) },
    });
    try {
      checkVisionRequest(r);
      expect.unreachable();
    } catch (e) {
      expect((e as AiRequestError).code).toBe("too_many_images");
    }
  });

  it("a single oversized keyframe refuses the whole item (per-image check)", () => {
    const big = jpeg(401 * 1024);
    const r = request({
      frames: [jpeg(), big, jpeg()],
      context: { ...request().context, ...video(4) },
    });
    expect(() => checkVisionRequest(r)).toThrow(AiRequestError);
    const wide = { ...jpeg(), width: 1024 } as AnalysisImage;
    const r2 = request({ frames: [wide], context: { ...request().context, ...video(2) } });
    expect(() => checkVisionRequest(r2)).toThrow(AiRequestError);
  });

  it("a free-plan video is refused before anything else (not_paid), frames or not", () => {
    const r = request({
      plan: "free" as never,
      frames: [jpeg()],
      context: { ...request().context, ...video(2) },
    });
    try {
      checkVisionRequest(r);
      expect.unreachable();
    } catch (e) {
      expect((e as AiRequestError).code).toBe("not_paid");
    }
  });

  it("a coordinate-like place label on a video item is blanked like on a photo", () => {
    const r = request({
      frames: [jpeg()],
      context: { ...request().context, ...video(2), placeLabel: "37.3349, -122.0090" },
    });
    const { request: checked, warnings } = checkVisionRequest(r);
    expect(checked.context.placeLabel).toBeNull();
    expect(warnings).toContain("context_coordinates_blanked");
  });
});
