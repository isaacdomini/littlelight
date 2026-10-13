import { describe, expect, it } from "vitest";
import {
  ffprobeArgs,
  ffprobeOutputSchema,
  normalizeRotation,
  ProbeError,
  parseFrameRate,
  reduceProbe,
} from "./ffprobe";

// ffprobe output → `VideoProbe` (docs/plans/step-12.md 2.6 step 2): exactly one h264/hevc video
// stream, optional audio, rotation from the display matrix or the `rotate` tag swaps the display
// dimensions, HDR from the transfer, tags kept non-enumerable (never logged or persisted as is).

const base = {
  format: {
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    duration: "5.000000",
    tags: {
      major_brand: "qt  ",
      "com.apple.quicktime.location.ISO6709": "+37.3349-122.0090+012.345/",
      "com.apple.quicktime.creationdate": "2026-07-12T10:30:00+0200",
      "com.apple.quicktime.make": "Apple",
    },
  },
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "hevc",
      profile: "Main",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      avg_frame_rate: "30000/1001",
      r_frame_rate: "30000/1001",
      color_transfer: "bt709",
      nb_frames: "150",
      tags: { rotate: "0", handler_name: "Core Media Video" },
    },
    { index: 1, codec_type: "audio", codec_name: "aac", channels: 2 },
  ],
};

describe("parseFrameRate / normalizeRotation", () => {
  it("parses fractional and integer rates; 0/0 and junk are null", () => {
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("60")).toBe(60);
    expect(parseFrameRate("0/0")).toBeNull();
    expect(parseFrameRate("")).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
    expect(parseFrameRate("abc")).toBeNull();
  });

  it("normalises rotations to 0/90/180/270 (negative and over-rotated values included)", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(270)).toBe(270);
    expect(normalizeRotation(-270)).toBe(90);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation("180")).toBe(180);
    expect(normalizeRotation("junk")).toBe(0);
    expect(normalizeRotation(undefined)).toBe(0);
    expect(normalizeRotation(45)).toBe(0);
  });
});

describe("reduceProbe", () => {
  it("reduces a landscape HEVC/AAC MOV: codec, duration, dims, fps, audio, brand, non-enumerable tags", () => {
    const p = reduceProbe(ffprobeOutputSchema.parse(base));
    expect(p).toMatchObject({
      durationMs: 5000,
      width: 1920,
      height: 1080,
      codedWidth: 1920,
      codedHeight: 1080,
      rotation: 0,
      codec: "hevc",
      pixelFormat: "yuv420p",
      hdr: false,
      hasAudio: true,
      audioCodec: "aac",
      audioChannels: 2,
      majorBrand: "qt",
      otherStreams: 0,
    });
    expect(p.fps).toBeCloseTo(29.97, 2);
    expect(p.tags["com.apple.quicktime.make"]).toBe("Apple");
    expect(p.tags["com.apple.quicktime.location.ISO6709"]).toContain("37.3349");
    // tags never leak through enumeration (JSON.stringify, object spread, pino serialisation)
    expect(Object.keys(p)).not.toContain("tags");
    expect(JSON.stringify(p)).not.toContain("37.3349");
    expect(JSON.stringify({ ...p })).not.toContain("ISO6709");
  });

  it("swaps the display dimensions for a 90/270° rotation (side data or the rotate tag) and keeps the coded ones", () => {
    const sideData = structuredClone(base);
    (sideData.streams[0] as Record<string, unknown>).side_data_list = [
      { side_data_type: "Display Matrix", rotation: -90 },
    ];
    const a = reduceProbe(ffprobeOutputSchema.parse(sideData));
    expect([a.width, a.height]).toEqual([1080, 1920]);
    expect([a.codedWidth, a.codedHeight]).toEqual([1920, 1080]);
    expect(a.rotation).toBe(270);

    const tag = structuredClone(base);
    (tag.streams[0] as { tags: Record<string, string> }).tags.rotate = "90";
    const b = reduceProbe(ffprobeOutputSchema.parse(tag));
    expect([b.width, b.height]).toEqual([1080, 1920]);
    expect(b.rotation).toBe(90);

    const half = structuredClone(base);
    (half.streams[0] as { tags: Record<string, string> }).tags.rotate = "180";
    const c = reduceProbe(ffprobeOutputSchema.parse(half));
    expect([c.width, c.height]).toEqual([1920, 1080]);
    expect(c.rotation).toBe(180);
  });

  it("flags HDR for smpte2084 (PQ) and arib-std-b67 (HLG) transfers only", () => {
    for (const [trc, hdr] of [
      ["smpte2084", true],
      ["arib-std-b67", true],
      ["bt709", false],
      [undefined, false],
    ] as const) {
      const o = structuredClone(base);
      (o.streams[0] as Record<string, unknown>).color_transfer = trc;
      expect(reduceProbe(ffprobeOutputSchema.parse(o)).hdr, String(trc)).toBe(hdr);
    }
  });

  it("silent clips: hasAudio false; extra data/subtitle streams are counted, not refused", () => {
    const silent = structuredClone(base);
    silent.streams = [
      silent.streams[0] as never,
      { index: 1, codec_type: "data", codec_name: "none" } as never,
    ];
    const p = reduceProbe(ffprobeOutputSchema.parse(silent));
    expect(p.hasAudio).toBe(false);
    expect(p.audioCodec).toBeNull();
    expect(p.otherStreams).toBe(1);
  });

  it.each([
    [
      "no video stream (audio-only .m4a)",
      (o: typeof base) => {
        o.streams = [o.streams[1] as never];
      },
    ],
    [
      "two video streams",
      (o: typeof base) => {
        o.streams.push(structuredClone(o.streams[0]) as never);
      },
    ],
    [
      "an unsupported codec (vp9)",
      (o: typeof base) => {
        (o.streams[0] as Record<string, unknown>).codec_name = "vp9";
      },
    ],
    [
      "no duration and no frame count",
      (o: typeof base) => {
        (o.format as Record<string, unknown>).duration = undefined;
        (o.streams[0] as Record<string, unknown>).nb_frames = undefined;
        (o.streams[0] as Record<string, unknown>).duration = undefined;
      },
    ],
    [
      "zero dimensions",
      (o: typeof base) => {
        (o.streams[0] as Record<string, unknown>).width = 0;
      },
    ],
  ])("refuses %s with a ProbeError", (_n, mutate) => {
    const o = structuredClone(base);
    mutate(o);
    expect(() => reduceProbe(ffprobeOutputSchema.parse(o))).toThrow(ProbeError);
  });

  it("the duration falls back to the video stream's when the container has none", () => {
    const o = structuredClone(base);
    (o.format as Record<string, unknown>).duration = undefined;
    (o.streams[0] as Record<string, unknown>).duration = "4.5";
    expect(reduceProbe(ffprobeOutputSchema.parse(o)).durationMs).toBe(4500);
  });
});

describe("ffprobeArgs", () => {
  it("is JSON format+streams over a local path, quiet, never a URL", () => {
    const args = ffprobeArgs("/scratch/abc.orig");
    expect(args).toEqual(
      expect.arrayContaining([
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "/scratch/abc.orig",
      ]),
    );
    expect(args.join(" ")).toContain("-v error");
    expect(args.at(-1)).toBe("/scratch/abc.orig");
    expect(args.join(" ")).not.toMatch(/https?:/);
  });
});
