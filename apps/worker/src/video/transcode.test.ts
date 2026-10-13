import { describe, expect, it } from "vitest";
import { assertLocalArgs } from "./ffmpeg";
import type { VideoProbe } from "./ffprobe";
import {
  canRemux,
  HDR_TONEMAP_FILTER,
  moovBeforeMdat,
  remuxArgs,
  transcodeArgs,
  videoFilter,
} from "./transcode";

// The transcode decision table and argument builders (docs/plans/step-12.md 2.6 steps 3–5):
// pure functions over a probe. ffmpeg never sees a URL; every output drops metadata and chapters
// and is written faststart.

function probe(over: Partial<VideoProbe> = {}): VideoProbe {
  const p: VideoProbe = {
    durationMs: 5000,
    width: 1920,
    height: 1080,
    codedWidth: 1920,
    codedHeight: 1080,
    rotation: 0,
    codec: "h264",
    profile: "High",
    pixelFormat: "yuv420p",
    fps: 30,
    colorTransfer: "bt709",
    hdr: false,
    hasAudio: true,
    audioCodec: "aac",
    audioChannels: 2,
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    majorBrand: "isom",
    otherStreams: 0,
    tags: {},
    ...over,
  };
  return p;
}

describe("canRemux (the fast path)", () => {
  it("MP4 + h264 + yuv420p + ≤ 1080p + ≤ 60 fps + no rotation + aac/no audio ⇒ remux", () => {
    expect(canRemux(probe(), "video/mp4")).toBe(true);
    expect(canRemux(probe({ hasAudio: false, audioCodec: null }), "video/mp4")).toBe(true);
    expect(canRemux(probe({ fps: null }), "video/mp4")).toBe(true);
    expect(canRemux(probe({ width: 1080, height: 1920 }), "video/mp4")).toBe(true);
  });

  it.each([
    ["QuickTime container", probe(), "video/quicktime"],
    ["hevc", probe({ codec: "hevc" }), "video/mp4"],
    ["10-bit", probe({ pixelFormat: "yuv420p10le" }), "video/mp4"],
    ["HDR", probe({ hdr: true, colorTransfer: "smpte2084" }), "video/mp4"],
    ["rotation side data", probe({ rotation: 90, width: 1080, height: 1920 }), "video/mp4"],
    ["4K", probe({ width: 3840, height: 2160 }), "video/mp4"],
    ["120 fps", probe({ fps: 120 }), "video/mp4"],
    ["non-AAC audio", probe({ audioCodec: "pcm_s16le" }), "video/mp4"],
  ])("%s ⇒ transcode", (_n, p, mime) => {
    expect(canRemux(p, mime)).toBe(false);
  });
});

describe("videoFilter", () => {
  it("downscales by the longer edge (never enlarges), caps fps, keeps yuv420p", () => {
    expect(videoFilter(probe(), { tonemap: false })).toBe("format=yuv420p");
    expect(videoFilter(probe({ width: 3840, height: 2160 }), { tonemap: false })).toBe(
      "scale=1920:-2:flags=lanczos,format=yuv420p",
    );
    expect(videoFilter(probe({ width: 2160, height: 3840 }), { tonemap: false })).toBe(
      "scale=-2:1920:flags=lanczos,format=yuv420p",
    );
    expect(videoFilter(probe({ fps: 120 }), { tonemap: false })).toBe("fps=60,format=yuv420p");
    expect(videoFilter(probe({ width: 640, height: 360 }), { tonemap: false })).toBe(
      "format=yuv420p",
    );
  });

  it("HDR: the zscale tone-map chain with libzimg, the plain format fallback without", () => {
    const hdr = probe({ hdr: true, colorTransfer: "smpte2084", pixelFormat: "yuv420p10le" });
    expect(videoFilter(hdr, { tonemap: true })).toBe(HDR_TONEMAP_FILTER);
    expect(HDR_TONEMAP_FILTER).toMatch(/^zscale=.*tonemap=hable.*format=yuv420p$/);
    expect(videoFilter(hdr, { tonemap: false })).toBe("format=yuv420p");
  });
});

describe("remuxArgs / transcodeArgs", () => {
  const IN = "/scratch/abc.orig";
  const OUT = "/scratch/abc.web.mp4";

  it("remux: stream copy of video (+ audio), metadata and chapters dropped, faststart, paths only", () => {
    const args = remuxArgs(IN, OUT, probe(), 2);
    expect(args).toEqual(
      expect.arrayContaining(["-i", IN, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", OUT]),
    );
    expect(args.join(" ")).toContain("-map_metadata -1");
    expect(args.join(" ")).toContain("-map_chapters -1");
    expect(args.join(" ")).toContain("+faststart");
    expect(args.indexOf("-c")).toBeGreaterThan(args.indexOf("-i"));
    expect(args.at(-1)).toBe(OUT);
    expect(() => assertLocalArgs(args)).not.toThrow();
    const silent = remuxArgs(IN, OUT, probe({ hasAudio: false, audioCodec: null }), 2);
    expect(silent).toContain("-an");
    expect(silent).not.toContain("0:a:0");
  });

  it("transcode: libx264 veryfast crf 23 high yuv420p, the filter, AAC 128k stereo, -t at the plan limit, no URL anywhere", () => {
    const args = transcodeArgs(IN, OUT, probe({ codec: "hevc", width: 3840, height: 2160 }), {
      threads: 2,
      tonemap: false,
      maxSeconds: 300,
    });
    const s = args.join(" ");
    expect(s).toContain("-c:v libx264");
    expect(s).toContain("-preset veryfast");
    expect(s).toContain("-crf 23");
    expect(s).toContain("-profile:v high");
    expect(s).toContain("-pix_fmt yuv420p");
    expect(s).toContain("-vf scale=1920:-2:flags=lanczos,format=yuv420p");
    expect(s).toContain("-c:a aac -b:a 128k -ac 2");
    expect(s).toContain("-t 300");
    expect(s).toContain("-map_metadata -1");
    expect(s).toContain("+faststart");
    expect(args.at(-1)).toBe(OUT);
    expect(s).not.toMatch(/https?:\/\//);
    expect(() => assertLocalArgs(args)).not.toThrow();
  });

  it("transcode of an HDR clip with tone-map tags the output bt709; silent clips get -an", () => {
    const hdr = probe({
      codec: "hevc",
      hdr: true,
      colorTransfer: "smpte2084",
      hasAudio: false,
      audioCodec: null,
    });
    const s = transcodeArgs(IN, OUT, hdr, { threads: 1, tonemap: true, maxSeconds: 60 }).join(" ");
    expect(s).toContain(HDR_TONEMAP_FILTER);
    expect(s).toContain("-color_primaries bt709 -color_trc bt709 -colorspace bt709");
    expect(s).toContain("-an");
    expect(s).not.toContain("-c:a");
    const fallback = transcodeArgs(IN, OUT, hdr, {
      threads: 1,
      tonemap: false,
      maxSeconds: 60,
    }).join(" ");
    expect(fallback).not.toContain("zscale");
    expect(fallback).not.toContain("-color_trc");
  });

  it("assertLocalArgs refuses URLs and protocol prefixes an attacker could smuggle into a file name", () => {
    for (const bad of [
      "http://evil/x.mp4",
      "https://evil/x",
      "rtsp://cam",
      "concat:a|b",
      "tcp://1.2.3.4:1",
      "data:text/plain,x",
    ]) {
      expect(() => assertLocalArgs(["-i", bad]), bad).toThrow();
    }
    expect(() => assertLocalArgs(["-i", "/scratch/abc.orig", "-f", "mp4"])).not.toThrow();
  });
});

describe("moovBeforeMdat", () => {
  const box = (type: string, size: number) => {
    const b = Buffer.alloc(size);
    b.writeUInt32BE(size, 0);
    b.write(type, 4, "ascii");
    return b;
  };

  it("true when moov precedes mdat (faststart), false otherwise, false on junk", () => {
    const ftyp = box("ftyp", 24);
    expect(moovBeforeMdat(Buffer.concat([ftyp, box("moov", 64), box("mdat", 32)]))).toBe(true);
    expect(moovBeforeMdat(Buffer.concat([ftyp, box("mdat", 32), box("moov", 64)]))).toBe(false);
    // moov present and no mdat in the head: faststart holds
    expect(moovBeforeMdat(Buffer.concat([ftyp, box("free", 8), box("moov", 16)]))).toBe(true);
    expect(moovBeforeMdat(Buffer.concat([ftyp, box("free", 8), box("mdat", 16)]))).toBe(false);
    expect(moovBeforeMdat(Buffer.from("not an mp4 at all"))).toBe(false);
    expect(moovBeforeMdat(Buffer.alloc(0))).toBe(false);
  });

  it("honours a 64-bit (largesize) mdat box and stops cleanly at a truncated head", () => {
    const ftyp = box("ftyp", 24);
    const large = Buffer.alloc(16);
    large.writeUInt32BE(1, 0);
    large.write("mdat", 4, "ascii");
    large.writeBigUInt64BE(1n << 40n, 8);
    expect(moovBeforeMdat(Buffer.concat([ftyp, box("moov", 32), large]))).toBe(true);
    expect(moovBeforeMdat(Buffer.concat([ftyp, large, box("moov", 32)]))).toBe(false);
    const zero = Buffer.alloc(8); // size 0 = "to end of file"
    zero.write("mdat", 4, "ascii");
    expect(moovBeforeMdat(Buffer.concat([ftyp, zero, box("moov", 32)]))).toBe(false);
  });
});
