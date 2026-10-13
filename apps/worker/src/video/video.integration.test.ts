import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { derivativeKey, photoPrefixes } from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestPhoto } from "../ingest";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import { recordingLog } from "../testing/stubs";
import { runProcess } from "./ffmpeg";
import { probeVideo } from "./ffprobe";
import { moovBeforeMdat, transcodeVideo } from "./transcode";

// Video ingest + transcode against real Postgres + MinIO + this machine's ffmpeg (the port of
// `tools/video-smoke.ts`; docs/plans/step-12.md 2.6, 12.10). Clips are generated here with the
// same ffmpeg commands as the smoke tool (`testsrc`/`sine`; an HEVC MOV carries a QuickTime
// location tag with SYNTHETIC coordinates). Skips without the integration env or ffmpeg. HDR
// tone-map colour assertions are skipped when ffmpeg lacks libzimg (the fallback chain is still
// exercised: the rendition must be ready and flagged `hdr`).

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const LAT = 37.3349;
const LNG = -122.009;

function ffmpegInfo(): { present: boolean; zimg: boolean; x265: boolean } {
  try {
    const conf = execFileSync(FFMPEG, ["-hide_banner", "-buildconf"], { encoding: "utf8" });
    return { present: true, zimg: /libzimg/.test(conf), x265: /libx265/.test(conf) };
  } catch {
    return { present: false, zimg: false, x265: false };
  }
}
const FF = ffmpegInfo();
/** An "ffmpeg" that always exits 1 (a deterministic remux/transcode failure). */
const FALSE_BIN = existsSync("/usr/bin/false") ? "/usr/bin/false" : "/bin/false";

async function gen(dir: string, name: string, args: string[]): Promise<Buffer> {
  const out = path.join(dir, name);
  await runProcess(FFMPEG, ["-v", "error", "-hide_banner", "-nostdin", ...args, "-y", out], {
    timeoutMs: 300_000,
  });
  return readFile(out);
}

const lavfi = (src: string) => ["-f", "lavfi", "-i", src];

async function clips(dir: string) {
  const hevcMov = await gen(dir, "hevc-5s.mov", [
    ...lavfi("testsrc=size=1280x720:rate=30"),
    ...lavfi("sine=frequency=440:sample_rate=48000"),
    "-t",
    "5",
    "-c:v",
    "libx265",
    "-tag:v",
    "hvc1",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-metadata",
    `com.apple.quicktime.location.ISO6709=+${LAT.toFixed(4)}${LNG.toFixed(4)}+000.000/`,
    "-metadata",
    "com.apple.quicktime.creationdate=2026-07-12T10:30:00+0200",
    "-metadata",
    "com.apple.quicktime.make=Apple",
    "-metadata",
    "com.apple.quicktime.model=iPhone 16",
    "-movflags",
    "+use_metadata_tags",
    "-f",
    "mov",
  ]);
  const h264Mp4 = await gen(dir, "h264-1080p-5s.mp4", [
    ...lavfi("testsrc=size=1920x1080:rate=30"),
    ...lavfi("sine=frequency=330:sample_rate=48000"),
    "-t",
    "5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-metadata",
    "creation_time=2026-06-01T08:00:00.000000Z",
    "-f",
    "mp4",
  ]);
  const tiny70 = await gen(dir, "h264-70s-tiny.mp4", [
    ...lavfi("testsrc=size=160x120:rate=5"),
    "-t",
    "70",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-an",
    "-f",
    "mp4",
  ]);
  await gen(dir, "plain-360.mp4", [
    ...lavfi("testsrc=size=640x360:rate=30"),
    "-t",
    "3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-an",
    "-f",
    "mp4",
  ]);
  const rotated = await gen(dir, "rotated-90.mp4", [
    "-display_rotation",
    "90",
    "-i",
    path.join(dir, "plain-360.mp4"),
    "-c",
    "copy",
    "-f",
    "mp4",
  ]);
  const hdr = await gen(dir, "hevc-hdr-3s.mov", [
    ...lavfi("testsrc=size=640x360:rate=30"),
    "-t",
    "3",
    "-c:v",
    "libx265",
    "-tag:v",
    "hvc1",
    "-pix_fmt",
    "yuv420p10le",
    "-preset",
    "ultrafast",
    "-an",
    "-color_primaries",
    "bt2020",
    "-color_trc",
    "smpte2084",
    "-colorspace",
    "bt2020nc",
    "-x265-params",
    "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:log-level=none",
    "-f",
    "mov",
  ]);
  // Rounding rule fixtures (review fix): 60.4 s rounds to 60 (accepted on free), 60.6 s to 61.
  const tiny604 = await gen(dir, "h264-60p4s-tiny.mp4", [
    ...lavfi("testsrc=size=160x120:rate=5"),
    "-t",
    "60.4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-an",
    "-f",
    "mp4",
  ]);
  const tiny606 = await gen(dir, "h264-60p6s-tiny.mp4", [
    ...lavfi("testsrc=size=160x120:rate=5"),
    "-t",
    "60.6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-an",
    "-f",
    "mp4",
  ]);
  const audioOnly = await gen(dir, "audio-only.m4a", [
    ...lavfi("sine=frequency=440:sample_rate=48000"),
    "-t",
    "2",
    "-c:a",
    "aac",
    "-f",
    "ipod",
  ]);
  return {
    hevcMov,
    h264Mp4,
    tiny70,
    rotated,
    hdr,
    tiny604,
    tiny606,
    audioOnly,
    fake: Buffer.from("not a video at all, really", "utf8"),
  };
}

describe.skipIf(!integrationEnv || !FF.present || !FF.x265)(
  "video ingest + transcode (ffmpeg)",
  () => {
    let h: Harness;
    let scratch: string;
    let clipDir: string;
    let c: Awaited<ReturnType<typeof clips>>;
    const log = recordingLog();
    const sent: { photoId: string; babyId: string }[] = [];
    let deps: ReturnType<Harness["deps"]>;
    let tdeps: Parameters<typeof transcodeVideo>[0];
    let plus: Awaited<ReturnType<Harness["baby"]>>;
    let free: Awaited<ReturnType<Harness["baby"]>>;

    beforeAll(async () => {
      h = await createHarness();
      scratch = await mkdtemp(path.join(os.tmpdir(), "ll-scratch-it-"));
      clipDir = await mkdtemp(path.join(os.tmpdir(), "ll-clips-it-"));
      c = await clips(clipDir);
      deps = h.deps({
        log,
        video: {
          ffmpegPath: FFMPEG,
          ffprobePath: FFPROBE,
          scratchPath: scratch,
          threads: 2,
          sendVideoTranscode: async (job) => {
            sent.push(job);
            return randomUUID();
          },
        },
      });
      tdeps = {
        pool: h.workerPool,
        storage: h.storage as never,
        log,
        ffmpegPath: FFMPEG,
        ffprobePath: FFPROBE,
        scratchPath: scratch,
        threads: 2,
        timeoutSec: 600,
        minFreeBytes: 1,
      } as never;
      plus = await h.baby({ plan: "plus", home: { lat: LAT + 0.001, lng: LNG } });
      free = await h.baby({ plan: "free" });
    }, 300_000);

    afterAll(async () => {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      await rm(clipDir, { recursive: true, force: true }).catch(() => undefined);
      await h?.close();
    });

    const asVideo = (id: string) =>
      h.admin.query(
        "UPDATE photos SET media_kind = 'video', rendition_status = 'pending' WHERE id = $1",
        [id],
      );
    const row = (id: string) =>
      h.one<Record<string, unknown>>(
        `SELECT status, media_kind, rendition_status, duration_ms, video_codec, has_audio, width, height, mime,
              taken_at_estimated, encode(sha256,'hex') AS sha
         FROM photos WHERE id = $1`,
        [id],
      );
    const kinds = async (id: string) =>
      (
        await h.admin.query<{ kind: string }>(
          "SELECT kind FROM photo_derivatives WHERE photo_id = $1 ORDER BY kind",
          [id],
        )
      ).rows.map((r) => r.kind);
    const scratchHas = async (id: string) => (await readdir(scratch)).some((f) => f.startsWith(id));

    it("HEVC MOV on Plus: ingested with poster derivatives, metadata from the QuickTime tags, GPS encrypted, transcode queued", async () => {
      const s = await h.seedUpload({ baby: plus, bytes: c.hevcMov });
      await asVideo(s.id);
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: plus.id });
      expect(r.outcome).toBe("ingested");
      expect(r.mediaKind).toBe("video");
      expect(r.thumbMs ?? 99_999).toBeLessThan(5000);
      const p = await row(s.id);
      expect(p).toMatchObject({
        status: "ingested",
        media_kind: "video",
        rendition_status: "pending",
        video_codec: "hevc",
        has_audio: true,
        mime: "video/quicktime",
        taken_at_estimated: false,
      });
      expect(Math.abs(Number(p?.duration_ms) - 5000)).toBeLessThan(200);
      expect(await kinds(s.id)).toEqual(["analysis", "display", "thumb"]);
      const exif = await h.one<{
        raw: Record<string, unknown>;
        enc: boolean;
        make: string | null;
        place: string | null;
      }>(
        "SELECT raw_json AS raw, gps_lat_enc IS NOT NULL AS enc, camera_make AS make, place_label AS place FROM photo_exif WHERE photo_id = $1",
        [s.id],
      );
      expect(exif?.enc).toBe(true);
      expect(Object.keys(exif?.raw ?? {}).some((k) => /location|iso6709/i.test(k))).toBe(false);
      expect(JSON.stringify(exif?.raw)).not.toContain("37.33");
      expect(exif?.make).toBe("Apple");
      expect(exif?.place).toBe("Home");
      const dec = await h.decrypt("photo_exif", s.id);
      expect(Math.abs((dec.lat ?? 0) - LAT)).toBeLessThan(0.001);
      expect(Math.abs((dec.lng ?? 0) - LNG)).toBeLessThan(0.001);
      expect(sent.some((j) => j.photoId === s.id)).toBe(true);
      expect(await scratchHas(s.id)).toBe(true);

      // transcode: full encode (hevc → h264), keyframes, faststart, no tags, scratch cleaned, idempotent
      const t = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      expect(t.outcome).toBe("ready");
      expect(t.remux).toBe(false);
      expect((await row(s.id))?.rendition_status).toBe("ready");
      expect(await kinds(s.id)).toEqual([
        "analysis",
        "display",
        "keyframe1",
        "keyframe2",
        "keyframe3",
        "thumb",
        "web",
      ]);
      const web = await h.storage.getObject(derivativeKey(plus.id, s.id, "web"));
      expect(moovBeforeMdat(web.subarray(0, 1024 * 1024))).toBe(true);
      const webFile = path.join(clipDir, `web-${s.id}.mp4`);
      const fh = await open(webFile, "w");
      await fh.writeFile(web);
      await fh.close();
      const wp = await probeVideo(FFPROBE, webFile);
      expect(wp.codec).toBe("h264");
      expect(wp.audioCodec).toBe("aac");
      expect(Math.max(wp.width, wp.height)).toBeLessThanOrEqual(1920);
      expect(
        Object.keys(wp.tags).some((k) => /location|iso6709|creation|make|model/i.test(k)),
      ).toBe(false);
      expect(await scratchHas(s.id)).toBe(false);
      const again = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      expect(again.outcome).toBe("skipped");
    }, 240_000);

    it("H.264 1080p MP4 on Plus: the remux path, creation_time honoured", async () => {
      const s = await h.seedUpload({ baby: plus, bytes: c.h264Mp4 });
      await asVideo(s.id);
      expect((await ingestPhoto(deps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      const t = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      expect(t.outcome).toBe("ready");
      expect(t.remux).toBe(true);
      expect(await row(s.id)).toMatchObject({
        video_codec: "h264",
        mime: "video/mp4",
        taken_at_estimated: false,
      });
    }, 120_000);

    it("a 90° rotated clip stores portrait display dimensions and is transcoded (no remux)", async () => {
      const s = await h.seedUpload({ baby: plus, bytes: c.rotated });
      await asVideo(s.id);
      expect((await ingestPhoto(deps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      const p = await row(s.id);
      expect(Number(p?.width)).toBeLessThan(Number(p?.height));
      const t = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      expect(t.outcome).toBe("ready");
      expect(t.remux).toBe(false);
    }, 120_000);

    it("an HDR HEVC clip is ready and flagged hdr (tone-map with libzimg, plain fallback without)", async () => {
      const s = await h.seedUpload({ baby: plus, bytes: c.hdr });
      await asVideo(s.id);
      expect((await ingestPhoto(deps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      const t = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      expect(t.outcome).toBe("ready");
      expect(t.hdr).toBe(true);
      if (FF.zimg) {
        const web = await h.storage.getObject(derivativeKey(plus.id, s.id, "web"));
        const webFile = path.join(clipDir, `hdr-${s.id}.mp4`);
        const fh = await open(webFile, "w");
        await fh.writeFile(web);
        await fh.close();
        const wp = await probeVideo(FFPROBE, webFile);
        expect(wp.hdr).toBe(false);
        expect(wp.pixelFormat).toBe("yuv420p");
      }
    }, 120_000);

    it("a 70 s clip on a free album fails video_too_long: objects deleted, scratch clean, upload file failed", async () => {
      const s = await h.seedUpload({ baby: free, bytes: c.tiny70 });
      await asVideo(s.id);
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: free.id });
      expect(r.outcome).toBe("failed");
      expect(r.error).toBe("video_too_long");
      expect(
        await h.one("SELECT state, error FROM upload_files WHERE id = $1", [s.id]),
      ).toMatchObject({
        state: "failed",
        error: "video_too_long",
      });
      let versions = 0;
      for (const prefix of photoPrefixes(free.id, s.id)) versions += await h.versionCount(prefix);
      expect(versions).toBe(0);
      expect(await scratchHas(s.id)).toBe(false);
      expect(sent.some((j) => j.photoId === s.id)).toBe(false);
    }, 120_000);

    it("the same 5 s clip on free is accepted and counts as one item and one video in the pool", async () => {
      const s = await h.seedUpload({ baby: free, bytes: c.hevcMov });
      await asVideo(s.id);
      expect((await ingestPhoto(deps, { photoId: s.id, babyId: free.id })).outcome).toBe(
        "ingested",
      );
      const pool = await h.one<{ used: number; videos: number }>(
        "SELECT public.free_tier_pool_used($1) AS used, public.free_tier_pool_videos($1) AS videos",
        [free.id],
      );
      expect(pool).toEqual({ used: 1, videos: 1 });
    }, 120_000);

    it("garbage bytes and an audio-only .m4a registered as videos fail unsupported_media_type", async () => {
      for (const bytes of [c.fake, c.audioOnly]) {
        const s = await h.seedUpload({ baby: plus, bytes });
        await asVideo(s.id);
        const r = await ingestPhoto(deps, { photoId: s.id, babyId: plus.id });
        expect(r.outcome).toBe("failed");
        expect(r.error).toBe("unsupported_media_type");
        expect(await scratchHas(s.id)).toBe(false);
      }
    }, 120_000);

    it("a video registered as a photo: the sniff flips the kind (or dedupes against the earlier upload)", async () => {
      const s = await h.seedUpload({ baby: plus, bytes: c.h264Mp4 });
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: plus.id });
      const p = await row(s.id);
      expect(
        r.outcome === "duplicate" || (r.outcome === "ingested" && p?.media_kind === "video"),
      ).toBe(true);
    }, 120_000);

    it("(8) duration rule on free: 60.4 s rounds to 60 and ingests; 60.6 s rounds to 61 and fails video_too_long; the rendition keeps the full 60.4 s (-t = limit + 1)", async () => {
      const ok = await h.seedUpload({ baby: free, bytes: c.tiny604 });
      await asVideo(ok.id);
      const r1 = await ingestPhoto(deps, { photoId: ok.id, babyId: free.id });
      expect(r1.outcome).toBe("ingested");
      expect(Math.round(Number((await row(ok.id))?.duration_ms) / 1000)).toBe(60);
      const t = await transcodeVideo(tdeps, { photoId: ok.id, babyId: free.id });
      expect(t.outcome).toBe("ready");
      const web = await h.storage.getObject(derivativeKey(free.id, ok.id, "web"));
      const webFile = path.join(clipDir, `web-${ok.id}.mp4`);
      const fh = await open(webFile, "w");
      await fh.writeFile(web);
      await fh.close();
      const wp = await probeVideo(FFPROBE, webFile);
      expect(wp.durationMs).toBeGreaterThan(60_200); // not cut at 60 s
      expect(wp.durationMs).toBeLessThan(61_200);

      const long = await h.seedUpload({ baby: free, bytes: c.tiny606 });
      await asVideo(long.id);
      const r2 = await ingestPhoto(deps, { photoId: long.id, babyId: free.id });
      expect(r2.outcome).toBe("failed");
      expect(r2.error).toBe("video_too_long");
      // the same 60.6 s clip is fine on Plus
      const onPlus = await h.seedUpload({
        baby: plus,
        bytes: Buffer.concat([c.tiny606, Buffer.from([1])]),
      });
      await asVideo(onPlus.id);
      expect((await ingestPhoto(deps, { photoId: onPlus.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
    }, 240_000);

    it("(9) staged original reuse: a whole .orig is used without a download; a truncated one is re-downloaded; a corrupt object fails source_hash_mismatch", async () => {
      const seen: string[] = [];
      const spyStorage = Object.create(h.storage) as typeof h.storage & {
        getObjectToFile: (key: string, file: string) => Promise<unknown>;
      };
      spyStorage.getObjectToFile = async (key: string, file: string) => {
        seen.push(key);
        return (h.storage as typeof spyStorage).getObjectToFile(key, file);
      };
      const spyDeps = { ...(tdeps as object), storage: spyStorage } as typeof tdeps;

      // whole staged file: no download at all
      const a = await h.seedUpload({
        baby: plus,
        bytes: Buffer.concat([c.h264Mp4, Buffer.from([2])]),
      });
      await asVideo(a.id);
      expect((await ingestPhoto(deps, { photoId: a.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      expect(await scratchHas(a.id)).toBe(true);
      expect((await transcodeVideo(spyDeps, { photoId: a.id, babyId: plus.id })).outcome).toBe(
        "ready",
      );
      expect(seen).toEqual([]);

      // truncated staged file (a crash mid-stage): re-downloaded, then success
      const b = await h.seedUpload({
        baby: plus,
        bytes: Buffer.concat([c.h264Mp4, Buffer.from([3])]),
      });
      await asVideo(b.id);
      expect((await ingestPhoto(deps, { photoId: b.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      const orig = path.join(scratch, `${b.id}.orig`);
      await (await open(orig, "r+")).close();
      const { truncate } = await import("node:fs/promises");
      await truncate(orig, 1000);
      const tb = await transcodeVideo(spyDeps, { photoId: b.id, babyId: plus.id });
      expect(tb.outcome).toBe("ready");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(b.id);

      // the object in storage no longer matches the row's sha256: genuine failure, row stays live
      const cc = await h.seedUpload({
        baby: plus,
        bytes: Buffer.concat([c.h264Mp4, Buffer.from([4])]),
      });
      await asVideo(cc.id);
      expect((await ingestPhoto(deps, { photoId: cc.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      await rm(path.join(scratch, `${cc.id}.orig`), { force: true });
      const keyRow = await h.one<{ key: string }>(
        "SELECT storage_key_original AS key FROM photos WHERE id = $1",
        [cc.id],
      );
      await h.putObject(keyRow?.key as string, Buffer.concat([c.h264Mp4, Buffer.from([9, 9, 9])]));
      const tc = await transcodeVideo(spyDeps, { photoId: cc.id, babyId: plus.id });
      expect(tc.outcome).toBe("failed");
      expect(
        await h.one("SELECT rendition_status, status FROM photos WHERE id = $1", [cc.id]),
      ).toEqual({
        rendition_status: "failed",
        status: "ingested",
      });
      expect(await h.one("SELECT error FROM upload_files WHERE id = $1", [cc.id])).toEqual({
        error: "transcode_failed",
      });
      expect(await scratchHas(cc.id)).toBe(false);
      expect(JSON.stringify(log.lines)).not.toContain(scratch);
    }, 300_000);

    it("(10) ingest.reconcile re-sends video.transcode for a pending rendition older than 15 min (a deferred last attempt)", async () => {
      const { reconcileIngest } = await import("../reconcile");
      const s = await h.seedUpload({
        baby: plus,
        bytes: Buffer.concat([c.h264Mp4, Buffer.from([5])]),
      });
      await asVideo(s.id);
      expect((await ingestPhoto(deps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      expect((await row(s.id))?.rendition_status).toBe("pending");
      const sentIds: string[] = [];
      const run = () =>
        reconcileIngest({
          pool: h.workerPool,
          log,
          send: async () => "x",
          sendTranscode: async (job) => {
            sentIds.push(job.photoId);
            return "job";
          },
        });
      await run();
      expect(sentIds).not.toContain(s.id); // fresh: not stuck yet
      await h.admin.query("BEGIN");
      try {
        await h.admin.query("SET LOCAL session_replication_role = replica");
        await h.admin.query(
          "UPDATE photos SET updated_at = now() - interval '16 minutes' WHERE id = $1",
          [s.id],
        );
        await h.admin.query("COMMIT");
      } catch (e) {
        await h.admin.query("ROLLBACK");
        throw e;
      }
      const r = await run();
      expect(sentIds).toContain(s.id);
      expect(r.videosStuck ?? 0).toBeGreaterThanOrEqual(1);
      // a transcode now completes it, and it is not re-sent afterwards
      expect((await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ready",
      );
      sentIds.length = 0;
      await run();
      expect(sentIds).not.toContain(s.id);
    }, 240_000);

    it("(S1) video path: FINISH_VIDEO_SQL refused by a cap trigger (23514, each message) → failed/free_tier_limit|pending_limit, objects and scratch gone, no transcode sent", async () => {
      const { FINISH_VIDEO_SQL } = await import("../ingest/common");
      const { CAP_MESSAGES, refusingPool } = await import("../testing/cap-refusal");
      const { originalKey, photoPrefixes } = await import("@tinyglow/shared");
      const cases: [string, string][] = [
        [CAP_MESSAGES.photo, "free_tier_limit"],
        [CAP_MESSAGES.video, "free_tier_limit"],
        [CAP_MESSAGES.pending, "pending_limit"],
      ];
      for (const [i, [message, error]] of cases.entries()) {
        const s = await h.seedUpload({
          baby: plus,
          bytes: Buffer.concat([c.h264Mp4, Buffer.from([40 + i])]),
        });
        await asVideo(s.id);
        const before = sent.length;
        const hits: string[] = [];
        const capDeps = {
          ...deps,
          pool: refusingPool(h.workerPool, { [FINISH_VIDEO_SQL]: message }, hits),
        };
        const r = await ingestPhoto(capDeps, { photoId: s.id, babyId: plus.id });
        expect(r, message).toMatchObject({ outcome: "failed", error });
        expect(hits).toEqual([FINISH_VIDEO_SQL]);
        expect(await h.one("SELECT state, error FROM upload_files WHERE id = $1", [s.id])).toEqual({
          state: "failed",
          error,
        });
        expect((await row(s.id))?.status).toBe("failed");
        expect(await scratchHas(s.id)).toBe(false);
        expect(await h.versionCount(originalKey(plus.id, s.id))).toBe(0);
        for (const prefix of photoPrefixes(plus.id, s.id)) {
          expect(await h.versionCount(prefix), prefix).toBe(0);
        }
        expect(sent.length).toBe(before);
      }
    }, 300_000);

    it("(M2) ScratchLowError: the transcode releases its own staged .orig and partial .web.mp4 before deferring (rethrow, row stays pending)", async () => {
      const s = await h.seedUpload({
        baby: plus,
        bytes: Buffer.concat([c.h264Mp4, Buffer.from([50])]),
      });
      await asVideo(s.id);
      expect((await ingestPhoto(deps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      expect(await scratchHas(s.id)).toBe(true); // the staged original from ingest
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path.join(scratch, `${s.id}.web.mp4`), "partial"); // a leftover rendition
      const lowDeps = {
        ...(tdeps as object),
        minFreeBytes: 10,
        statfs: async () => ({ bavail: 1, bsize: 1 }),
      } as unknown as typeof tdeps;
      await expect(transcodeVideo(lowDeps, { photoId: s.id, babyId: plus.id })).rejects.toThrow(
        "scratch: not enough free space",
      );
      expect(await scratchHas(s.id)).toBe(false);
      expect(await row(s.id)).toMatchObject({ status: "ingested", rendition_status: "pending" });
      expect(await h.one("SELECT error FROM upload_files WHERE id = $1", [s.id])).toEqual({
        error: null,
      });
      const line = log.lines.find((l) => /scratch low, deferred/.test(String(l.msg)));
      expect(line?.level).toBe("warn");
      expect(line?.obj).toMatchObject({ photoId: s.id, freeBytes: 1, minFreeBytes: 10 });
      // with room again the clip is re-downloaded (size/sha checked) and transcoded
      expect((await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ready",
      );
    }, 240_000);

    it("a failing remux (-c copy exits 1) ends rendition_status='failed' + transcode_failed on the FIRST attempt; the row stays live", async () => {
      const s = await h.seedUpload({
        baby: plus,
        bytes: Buffer.concat([c.h264Mp4, Buffer.from([51])]),
      });
      await asVideo(s.id);
      expect((await ingestPhoto(deps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      // the remux path applies to this clip (checked by canRemux's unit tests); ffmpeg = `false`
      const brokenDeps = { ...(tdeps as object), ffmpegPath: FALSE_BIN } as typeof tdeps;
      const r = await transcodeVideo(brokenDeps, { photoId: s.id, babyId: plus.id });
      expect(r.outcome).toBe("failed");
      expect(await row(s.id)).toMatchObject({ status: "ingested", rendition_status: "failed" });
      expect(await h.one("SELECT error FROM upload_files WHERE id = $1", [s.id])).toEqual({
        error: "transcode_failed",
      });
      expect(await scratchHas(s.id)).toBe(false);
      const line = log.lines.find(
        (l) =>
          /transcode: failed/.test(String(l.msg)) &&
          (l.obj as { photoId: string }).photoId === s.id,
      );
      expect(line?.obj).toMatchObject({ reason: "ffmpeg_exit_nonzero" });
      // a later run with a working ffmpeg recovers it (failed rows are runnable)
      expect((await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ready",
      );
    }, 240_000);

    it("an HDR clip whose tone-map AND plain fallback both fail ends rendition_status='failed' on the first attempt", async () => {
      const s = await h.seedUpload({
        baby: plus,
        bytes: Buffer.concat([c.hdr, Buffer.from([52])]),
      });
      await asVideo(s.id);
      expect((await ingestPhoto(deps, { photoId: s.id, babyId: plus.id })).outcome).toBe(
        "ingested",
      );
      const brokenDeps = { ...(tdeps as object), ffmpegPath: FALSE_BIN } as typeof tdeps;
      const r = await transcodeVideo(brokenDeps, { photoId: s.id, babyId: plus.id });
      expect(r.outcome).toBe("failed");
      expect(await row(s.id)).toMatchObject({ rendition_status: "failed", status: "ingested" });
      expect(await h.one("SELECT error FROM upload_files WHERE id = $1", [s.id])).toEqual({
        error: "transcode_failed",
      });
      expect(await scratchHas(s.id)).toBe(false);
    }, 240_000);

    it("log hygiene: no coordinates, scratch paths or QuickTime tag values in any log line", () => {
      const lines = JSON.stringify(log.lines);
      expect(lines).not.toContain(LAT.toFixed(4));
      expect(lines).not.toContain("122.009");
      expect(lines).not.toContain(scratch);
      expect(lines).not.toMatch(/iPhone 16|ISO6709|creationdate/i);
      expect(lines).not.toMatch(/https?:\/\//);
    });
  },
);
