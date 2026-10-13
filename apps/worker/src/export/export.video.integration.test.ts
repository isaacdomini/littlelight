import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportKey } from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerStorage } from "../storage";
import { listZip, readZipEntry, sha256 } from "../testing/export";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import { handleDataExportJob } from "./handler";

// Album export with a video (docs/plans/step-12.md 2.6 export, 4.4 item 7): the original MOV is
// in the ZIP byte-identical as `originals/<date>_<id>.mov` (never the rendition), and
// `photos.csv` / `photos.json` carry `media_kind`, `duration_ms`, `video_codec`.

describe.skipIf(!integrationEnv)("data.export with a video (real stack)", () => {
  let h: Harness;
  let storage: WorkerStorage;
  let tmp: string;

  beforeAll(async () => {
    h = await createHarness();
    storage = h.storage as WorkerStorage;
    tmp = await mkdtemp(join(tmpdir(), "ll-exp-video-"));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
    await h?.close();
  });

  it("exports the .mov original with its sha256 and the video columns; the web rendition stays out", async () => {
    const baby = await h.baby({ plan: "plus" });
    const photoBytes = Buffer.from(`photo-${randomUUID()}-`.repeat(40));
    const photo = await h.seedUpload({ baby, bytes: photoBytes });
    await h.admin.query(
      `UPDATE public.photos SET status = 'ingested', mime = 'image/jpeg', sha256 = decode($2, 'hex'),
              taken_at = '2026-06-10T22:30:00Z', approved_by = $3, approved_at = now() WHERE id = $1`,
      [photo.id, sha256(photoBytes), baby.ownerId],
    );
    const movBytes = Buffer.from(`original-mov-${randomUUID()}-`.repeat(40));
    const video = await h.seedUpload({ baby, bytes: movBytes });
    await h.admin.query(
      `UPDATE public.photos SET status = 'ingested', mime = 'video/quicktime', sha256 = decode($2, 'hex'),
              taken_at = '2026-06-12T22:30:00Z', approved_by = $3, approved_at = now(),
              media_kind = 'video', rendition_status = 'ready', duration_ms = 4200, video_codec = 'hevc', has_audio = true
        WHERE id = $1`,
      [video.id, sha256(movBytes), baby.ownerId],
    );
    // the web rendition exists in storage and as a derivative row: it must not be exported
    const webKey = `babies/${baby.id}/derivatives/${video.id}/web.mp4`;
    await h.putObject(webKey, Buffer.from("rendition-bytes"));
    await h.admin.query(
      "INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes) VALUES ($1, 'web', $2, 1080, 1920, 15)",
      [video.id, webKey],
    );

    const req = await h.admin.query(
      "INSERT INTO public.data_exports (baby_id, requested_by, include_location) VALUES ($1, $2, false) RETURNING id",
      [baby.id, baby.ownerId],
    );
    const exportId = req.rows[0].id as string;
    const res = await handleDataExportJob(
      {
        pool: h.workerPool,
        storage,
        dataKey: h.dataKey,
        maxBytes: 2 ** 40,
        mailer: null,
        log: h.log,
      } as never,
      { id: "j", data: { exportId, babyId: baby.id } },
    );
    expect(res).toMatchObject({ outcome: "ready", photos: 2 });

    const zipPath = join(tmp, `${exportId}.zip`);
    await writeFile(zipPath, await storage.getObject(exportKey(baby.id, exportId)));
    const entries = await listZip(zipPath);
    const names = entries.map((e) => e.name);
    const movName = names.find((n) => n.includes(video.id)) as string;
    expect(movName).toMatch(new RegExp(`^originals/2026-06-1\\d_${video.id}\\.mov$`));
    expect(names.find((n) => n.includes(photo.id))).toMatch(/\.jpg$/);
    expect(names.some((n) => /web\.mp4|derivatives/.test(n))).toBe(false);
    expect(sha256(await readZipEntry(zipPath, movName))).toBe(sha256(movBytes));
    expect(entries.find((e) => e.name === movName)?.method).toBe("stor");

    const csv = (await readZipEntry(zipPath, "photos.csv")).toString("utf8");
    const [header, ...rows] = csv.trimEnd().split("\r\n");
    const cols = (header as string).split(",");
    for (const c of ["media_kind", "duration_ms", "video_codec"]) expect(cols).toContain(c);
    const at = (name: string) => cols.indexOf(name);
    const videoRow = rows.find((r) => r.includes(video.id))?.split(",") as string[];
    const photoRow = rows.find((r) => r.includes(photo.id))?.split(",") as string[];
    expect(videoRow[at("media_kind")]).toBe("video");
    expect(videoRow[at("duration_ms")]).toBe("4200");
    expect(videoRow[at("video_codec")]).toBe("hevc");
    expect(photoRow[at("media_kind")]).toBe("photo");
    expect(photoRow[at("duration_ms")]).toBe("");
    expect(photoRow[at("video_codec")]).toBe("");

    const json = JSON.parse(
      (await readZipEntry(zipPath, "photos.json")).toString("utf8"),
    ) as Record<string, unknown>[];
    const v = json.find((j) => j.photoId === video.id);
    expect(v).toMatchObject({ mediaKind: "video", durationMs: 4200, videoCodec: "hevc" });
    expect(json.find((j) => j.photoId === photo.id)).toMatchObject({
      mediaKind: "photo",
      durationMs: null,
      videoCodec: null,
    });
    const readme = (await readZipEntry(zipPath, "README.txt")).toString("utf8");
    expect(readme).toMatch(/video/i);
    expect(readme).toMatch(/media_kind/);
  }, 120_000);
});
