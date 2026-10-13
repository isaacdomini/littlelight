import { randomUUID } from "node:crypto";
import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { derivativeKey, photoPrefixes } from "@tinyglow/shared";
import { ingestPhoto } from "../ingest";
import { createHarness, type Harness } from "../testing/harness";
import { recordingLog } from "../testing/stubs";
import { runProcess } from "../video/ffmpeg";
import { probeVideo } from "../video/ffprobe";
import { moovBeforeMdat, transcodeVideo } from "../video/transcode";

// Video pipeline smoke run (docs/plans/step-12.md 12.5 "done when"), against the integration
// harness's throwaway Postgres + MinIO (DATABASE_URL, S3_ENDPOINT, …; see testing/harness.ts):
//
//   DATABASE_URL=… S3_ENDPOINT=… pnpm --filter @tinyglow/worker exec tsx src/tools/video-smoke.ts
//
// Generates clips with ffmpeg (`testsrc`/`sine`; an HEVC MOV carries a QuickTime location tag),
// runs `ingestPhoto` + `transcodeVideo` in-process with this machine's ffmpeg/ffprobe and a temp
// scratch folder, and prints one PASS/FAIL line per check. Exit 0 when everything passed. Dev
// tool: never run against production; coordinates below are synthetic.

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const LAT = 37.3349;
const LNG = -122.009;

interface Check {
  name: string;
  ok: boolean;
  info?: unknown;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, info?: unknown) => {
  checks.push({ name, ok, info });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${info !== undefined ? ` ${JSON.stringify(info)}` : ""}`,
  );
};

async function gen(dir: string, name: string, args: string[]): Promise<Buffer> {
  const out = path.join(dir, name);
  await runProcess(FFMPEG, ["-v", "error", "-hide_banner", "-nostdin", ...args, "-y", out], {
    timeoutMs: 300_000,
  });
  return readFile(out);
}

async function clips(dir: string) {
  const hevcMov = await gen(dir, "hevc-5s.mov", [
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
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
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1920x1080:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000",
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
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x120:rate=5",
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
  // Rotation side data (a phone's display matrix): remux the plain clip with `-display_rotation`.
  await gen(dir, "plain-360.mp4", [
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30",
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
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30",
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
  return {
    hevcMov,
    h264Mp4,
    tiny70,
    rotated,
    hdr,
    fake: Buffer.from("not a video at all, really", "utf8"),
  };
}

async function main(): Promise<number> {
  const h: Harness = await createHarness();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "ll-scratch-smoke-"));
  const clipDir = await mkdtemp(path.join(os.tmpdir(), "ll-clips-"));
  const log = recordingLog();
  const sent: { photoId: string; babyId: string }[] = [];
  const deps = h.deps({
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
  const tdeps = {
    pool: h.workerPool,
    storage: h.storage as typeof h.storage & {
      getObjectToFile: NonNullable<typeof deps.storage.getObjectToFile>;
      putObjectFromFile: NonNullable<typeof deps.storage.putObjectFromFile>;
    },
    log,
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    scratchPath: scratch,
    threads: 2,
    timeoutSec: 600,
    minFreeBytes: 1,
  };
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

  try {
    const c = await clips(clipDir);
    const plus = await h.baby({ plan: "plus", home: { lat: LAT + 0.001, lng: LNG } });
    const free = await h.baby({ plan: "free" });

    // 1. HEVC MOV with a QuickTime location tag, on Plus.
    {
      const s = await h.seedUpload({ baby: plus, bytes: c.hevcMov });
      await asVideo(s.id);
      const t0 = Date.now();
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: plus.id });
      const ingestMs = Date.now() - t0;
      check("hevc: ingested", r.outcome === "ingested" && r.mediaKind === "video", {
        ms: ingestMs,
        thumbMs: r.thumbMs,
      });
      check("hevc: thumb within 5 s", (r.thumbMs ?? 99_999) < 5000, r.thumbMs);
      const p = await row(s.id);
      check(
        "hevc: row",
        p?.status === "ingested" &&
          p.media_kind === "video" &&
          p.rendition_status === "pending" &&
          p.video_codec === "hevc" &&
          p.has_audio === true &&
          p.mime === "video/quicktime",
        p,
      );
      check("hevc: duration ~5000", Math.abs(Number(p?.duration_ms) - 5000) < 200, p?.duration_ms);
      check("hevc: taken_at from creationdate (not estimated)", p?.taken_at_estimated === false);
      check(
        "hevc: derivatives after ingest",
        JSON.stringify(await kinds(s.id)) === JSON.stringify(["analysis", "display", "thumb"]),
        await kinds(s.id),
      );
      const exif = await h.one<{
        raw: Record<string, unknown>;
        enc: boolean;
        make: string | null;
        place: string | null;
      }>(
        "SELECT raw_json AS raw, gps_lat_enc IS NOT NULL AS enc, camera_make AS make, place_label AS place FROM photo_exif WHERE photo_id = $1",
        [s.id],
      );
      check("hevc: gps encrypted", exif?.enc === true);
      check(
        "hevc: raw_json has no location keys",
        !!exif && !Object.keys(exif.raw).some((k) => /location|iso6709/i.test(k)),
        Object.keys(exif?.raw ?? {}),
      );
      check("hevc: camera make", exif?.make === "Apple", exif?.make);
      check("hevc: home label from GPS", exif?.place === "Home", exif?.place);
      const dec = await h.decrypt("photo_exif", s.id);
      check(
        "hevc: decrypted gps matches",
        Math.abs((dec.lat ?? 0) - LAT) < 0.001 && Math.abs((dec.lng ?? 0) - LNG) < 0.001,
      );
      check(
        "hevc: transcode job sent",
        sent.some((j) => j.photoId === s.id),
      );
      check(
        "hevc: staged original kept for transcode",
        (await readdir(scratch)).some((f) => f.startsWith(s.id)),
      );

      const t = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      check("hevc: transcoded", t.outcome === "ready" && t.remux === false, t);
      const p2 = await row(s.id);
      check("hevc: rendition ready", p2?.rendition_status === "ready");
      check(
        "hevc: derivatives after transcode",
        JSON.stringify(await kinds(s.id)) ===
          JSON.stringify([
            "analysis",
            "display",
            "keyframe1",
            "keyframe2",
            "keyframe3",
            "thumb",
            "web",
          ]),
        await kinds(s.id),
      );
      const web = await h.storage.getObject(derivativeKey(plus.id, s.id, "web"));
      check("hevc: web.mp4 faststart", moovBeforeMdat(web.subarray(0, 1024 * 1024)));
      const webFile = path.join(clipDir, "web-check.mp4");
      const fh = await open(webFile, "w");
      await fh.writeFile(web);
      await fh.close();
      const wp = await probeVideo(FFPROBE, webFile);
      check(
        "hevc: web is h264/aac ≤1080p",
        wp.codec === "h264" && wp.audioCodec === "aac" && Math.max(wp.width, wp.height) <= 1920,
        { codec: wp.codec, audio: wp.audioCodec, w: wp.width, h: wp.height },
      );
      check(
        "hevc: web has no location/creation tags",
        !Object.keys(wp.tags).some((k) => /location|iso6709|creation|make|model/i.test(k)),
        Object.keys(wp.tags),
      );
      check("hevc: scratch cleaned", !(await readdir(scratch)).some((f) => f.startsWith(s.id)));
      // Re-run is a no-op.
      const again = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      check("hevc: second transcode skipped", again.outcome === "skipped");
    }

    // 2. H.264 1080p MP4: remux path.
    {
      const s = await h.seedUpload({ baby: plus, bytes: c.h264Mp4 });
      await asVideo(s.id);
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: plus.id });
      check("h264: ingested", r.outcome === "ingested");
      const t = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      check("h264: remux path", t.outcome === "ready" && t.remux === true, t);
      const p = await row(s.id);
      check(
        "h264: codec/mime",
        p?.video_codec === "h264" && p.mime === "video/mp4" && p.taken_at_estimated === false,
        p,
      );
    }

    // 3. Rotated 90°: width < height.
    {
      const s = await h.seedUpload({ baby: plus, bytes: c.rotated });
      await asVideo(s.id);
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: plus.id });
      const p = await row(s.id);
      check(
        "rotated: portrait dims",
        r.outcome === "ingested" && Number(p?.width) < Number(p?.height),
        { w: p?.width, h: p?.height },
      );
      const t = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      check("rotated: transcoded (no remux)", t.outcome === "ready" && t.remux === false, t);
    }

    // 4. HDR HEVC: ready, tone-map flag logged (this machine's ffmpeg may lack libzimg ⇒ fallback).
    {
      const s = await h.seedUpload({ baby: plus, bytes: c.hdr });
      await asVideo(s.id);
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: plus.id });
      check("hdr: ingested", r.outcome === "ingested");
      const t = await transcodeVideo(tdeps, { photoId: s.id, babyId: plus.id });
      check("hdr: ready with hdr flag", t.outcome === "ready" && t.hdr === true, t);
    }

    // 5. 70 s clip on free: video_too_long, objects deleted, scratch clean.
    {
      const s = await h.seedUpload({ baby: free, bytes: c.tiny70 });
      await asVideo(s.id);
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: free.id });
      check("free 70s: video_too_long", r.outcome === "failed" && r.error === "video_too_long", r);
      const f = await h.one<{ state: string; error: string }>(
        "SELECT state, error FROM upload_files WHERE id = $1",
        [s.id],
      );
      check(
        "free 70s: upload file failed/video_too_long",
        f?.state === "failed" && f.error === "video_too_long",
        f,
      );
      let versions = 0;
      for (const prefix of photoPrefixes(free.id, s.id)) versions += await h.versionCount(prefix);
      check("free 70s: objects deleted", versions === 0, versions);
      check("free 70s: scratch cleaned", !(await readdir(scratch)).some((x) => x.startsWith(s.id)));
    }

    // 6. Same 5 s HEVC clip on free: accepted (≤ 60 s, ≤ 250 MB), counts as a video.
    {
      const s = await h.seedUpload({ baby: free, bytes: c.hevcMov });
      await asVideo(s.id);
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: free.id });
      check("free 5s: ingested", r.outcome === "ingested");
      const pool = await h.one<{ used: number; videos: number }>(
        "SELECT public.free_tier_pool_used($1) AS used, public.free_tier_pool_videos($1) AS videos",
        [free.id],
      );
      check("free: pool counts the video", pool?.used === 1 && pool?.videos === 1, pool);
    }

    // 7. Garbage bytes registered as a video: unsupported_media_type.
    {
      const s = await h.seedUpload({ baby: plus, bytes: c.fake });
      await asVideo(s.id);
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: plus.id });
      check(
        "fake: unsupported_media_type",
        r.outcome === "failed" && r.error === "unsupported_media_type",
        r,
      );
    }

    // 8. A video registered as a photo: the sniff flips the kind.
    {
      const s = await h.seedUpload({ baby: plus, bytes: c.h264Mp4 });
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: plus.id });
      const p = await row(s.id);
      check(
        "flip: photo-kind row became a duplicate or video",
        r.outcome === "duplicate" || (r.outcome === "ingested" && p?.media_kind === "video"),
        { outcome: r.outcome, kind: p?.media_kind },
      );
    }

    // 9. Log hygiene: no coordinates, scratch paths or tag values in any log line.
    {
      const lines = JSON.stringify(log.lines);
      check("logs: no coordinates", !lines.includes(LAT.toFixed(4)) && !lines.includes("122.009"));
      check("logs: no scratch paths", !lines.includes(scratch));
      check("logs: no QuickTime tag values", !/iPhone 16|ISO6709|creationdate/i.test(lines));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await rm(clipDir, { recursive: true, force: true }).catch(() => undefined);
    await h.close();
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`${failed === 0 ? "PASS" : "FAIL"} ${checks.length - failed}/${checks.length}`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
