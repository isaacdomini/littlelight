import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  babySchema,
  derivativeKey,
  type IngestJob,
  photoSchema,
  photosListResponseSchema,
  photosSummaryResponseSchema,
  UPLOAD_PART_BYTES,
  uploadFileSchema,
  uploadSessionSchema,
} from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobQueue } from "../plugins/jobs";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { createS3Stub } from "../testing/s3-stub";

// Video uploads through the API against a real database (the port of `testing/video-smoke.ts`;
// docs/plans/step-12.md 2.4, 12.10): the register matrix (kind × plan × size × duration), the
// photos row a complete books, the detail/list/summary `media` surfaces, the admin original
// download and the Q3 cap (register pre-check and the trigger at complete). S3 and jobs stubbed.

const MIB = 1024 * 1024;

describe.skipIf(!databaseUrl)("video uploads (api)", () => {
  let h: Harness;
  const s3 = createS3Stub();
  const enqueued: IngestJob[] = [];
  let mom: TestUser;
  let freeBaby: string;
  let plusMom: TestUser;
  let plusBaby: string;

  const jobs: JobQueue = {
    enqueueIngest: async (job) => {
      enqueued.push(job);
      return true;
    },
    enqueueReindex: async () => true,
    close: async () => undefined,
  };

  beforeAll(async () => {
    h = await createHarness({ s3, jobs });
    mom = await h.user({ displayName: "Mom" });
    freeBaby = await h.baby(mom, "Free");
    plusMom = await h.user({ displayName: "PlusMom" });
    plusBaby = await h.baby(plusMom, "Plus");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [plusBaby]);
  });
  afterAll(async () => {
    await h?.close();
  });

  const session = async (user: TestUser, babyId: string) => {
    const res = await h.inject(user, "POST", `/babies/${babyId}/uploads`, {});
    expect(res.statusCode, res.body).toBe(201);
    return uploadSessionSchema.parse(res.json()).id;
  };
  const register = async (user: TestUser, sid: string, file: Record<string, unknown>) => {
    const res = await h.inject(user, "POST", `/uploads/${sid}/files`, {
      files: [{ clientId: `c-${randomUUID().slice(0, 8)}`, ...file }],
    });
    expect(res.statusCode, res.body).toBe(200);
    return uploadFileSchema.parse(res.json().files[0]);
  };
  const keyOf = async (fileId: string) =>
    (await h.admin.query("SELECT storage_key FROM public.upload_files WHERE id = $1", [fileId]))
      .rows[0].storage_key as string;
  const putAll = async (fileId: string, bytes: number) => {
    const key = await keyOf(fileId);
    const n = Math.ceil(bytes / UPLOAD_PART_BYTES);
    for (let i = 1; i <= n; i++) {
      s3.putPart(key, i, i < n ? UPLOAD_PART_BYTES : bytes - (n - 1) * UPLOAD_PART_BYTES);
    }
  };
  const complete = (user: TestUser, sid: string, fileId: string) =>
    h.inject(user, "POST", `/uploads/${sid}/files/${fileId}/complete`);

  describe("register matrix (free)", () => {
    it("300 MiB video ⇒ failed/file_too_large; 90 s hint ⇒ failed/video_too_long; 40 MiB / 30 s ⇒ 3 parts with the hints stored", async () => {
      const sid = await session(mom, freeBaby);
      const big = await register(mom, sid, { kind: "video", bytes: 300 * MIB });
      expect(big).toMatchObject({ state: "failed", error: "file_too_large", kind: "video" });
      const long = await register(mom, sid, { kind: "video", bytes: 10 * MIB, durationMs: 90_000 });
      expect(long).toMatchObject({ state: "failed", error: "video_too_long" });
      const ok = await register(mom, sid, { kind: "video", bytes: 40 * MIB, durationMs: 30_000 });
      expect(ok.state).toBe("registered");
      expect(ok.partCount).toBe(3);
      expect(ok.parts).toHaveLength(3);
      const rowv = (
        await h.admin.query(
          "SELECT media_kind, declared_duration_ms FROM public.upload_files WHERE id = $1",
          [ok.id],
        )
      ).rows[0];
      expect(rowv).toEqual({ media_kind: "video", declared_duration_ms: 30_000 });
      // exactly at the free caps: accepted
      const edge = await register(mom, sid, {
        kind: "video",
        bytes: 250 * MIB,
        durationMs: 60_000,
      });
      expect(edge.state).toBe("registered");
      expect(edge.partCount).toBe(Math.ceil((250 * MIB) / UPLOAD_PART_BYTES));
    });

    it("duration hints round to whole seconds: 60 400 ms registers on free, 60 600 ms is video_too_long; 300 400 / 300 600 on Plus", async () => {
      const sid = await session(mom, freeBaby);
      expect(
        (await register(mom, sid, { kind: "video", bytes: MIB, durationMs: 60_400 })).state,
      ).toBe("registered");
      expect(
        await register(mom, sid, { kind: "video", bytes: MIB, durationMs: 60_600 }),
      ).toMatchObject({
        state: "failed",
        error: "video_too_long",
      });
      const psid = await session(plusMom, plusBaby);
      expect(
        (await register(plusMom, psid, { kind: "video", bytes: MIB, durationMs: 300_400 })).state,
      ).toBe("registered");
      expect(
        await register(plusMom, psid, { kind: "video", bytes: MIB, durationMs: 300_600 }),
      ).toMatchObject({
        state: "failed",
        error: "video_too_long",
      });
    });

    it("photo-kind files keep the 100 MiB cap (schema-level 400), and the default kind is photo", async () => {
      const sid = await session(mom, freeBaby);
      const tooBig = await h.inject(mom, "POST", `/uploads/${sid}/files`, {
        files: [{ clientId: "p", bytes: 200 * MIB }],
      });
      expect(tooBig.statusCode).toBe(400);
      const photo = await register(mom, sid, { bytes: 5 * MIB });
      expect(photo.kind).toBe("photo");
      // a video mime on a photo-kind file is not a video
      const bad = await h.inject(mom, "POST", `/uploads/${sid}/files`, {
        files: [{ clientId: "q", bytes: 200 * MIB, mime: "video/mp4" }],
      });
      expect(bad.statusCode).toBe(400);
    });

    it("validation: a 2 GiB + 1 video, a zero duration and an unknown kind are 400", async () => {
      const sid = await session(mom, freeBaby);
      for (const file of [
        { kind: "video", bytes: 2 * 1024 * MIB + 1 },
        { kind: "video", bytes: 10 * MIB, durationMs: 0 },
        { kind: "clip", bytes: 10 * MIB },
      ]) {
        const res = await h.inject(mom, "POST", `/uploads/${sid}/files`, {
          files: [{ clientId: "x", ...file }],
        });
        expect(res.statusCode, JSON.stringify(file)).toBe(400);
      }
    });
  });

  describe("Plus: register, complete, detail, filters, original", () => {
    it("300 MiB / 90 s registers with ceil(bytes / 16 MiB) parts; complete books a pending video row and enqueues ingest", async () => {
      const sid = await session(plusMom, plusBaby);
      const bytes = 300 * MIB;
      const f = await register(plusMom, sid, {
        kind: "video",
        bytes,
        durationMs: 90_000,
        mime: "video/quicktime",
      });
      expect(f.state).toBe("registered");
      expect(f.partCount).toBe(Math.ceil(bytes / (16 * MIB)));
      await putAll(f.id, bytes);
      const r = await complete(plusMom, sid, f.id);
      expect(r.statusCode, r.body).toBe(200);
      const p = (
        await h.admin.query(
          "SELECT media_kind, rendition_status, status, approval FROM public.photos WHERE id = $1",
          [f.id],
        )
      ).rows[0];
      expect(p).toMatchObject({
        media_kind: "video",
        rendition_status: "pending",
        status: "uploaded",
      });
      expect(enqueued.some((j) => j.photoId === f.id)).toBe(true);

      // detail before ingest
      const d = photoSchema.parse((await h.inject(plusMom, "GET", `/photos/${f.id}`)).json());
      expect(d).toMatchObject({
        mediaKind: "video",
        renditionStatus: "pending",
        videoUrl: null,
        durationMs: null,
      });

      // the worker's ingest: metadata set, still pending ⇒ no videoUrl
      await h.admin.query(
        `UPDATE public.photos SET status = 'ingested', duration_ms = 90000, video_codec = 'hevc', has_audio = true,
                width = 1080, height = 1920 WHERE id = $1`,
        [f.id],
      );
      const d2 = photoSchema.parse((await h.inject(plusMom, "GET", `/photos/${f.id}`)).json());
      expect(d2).toMatchObject({
        durationMs: 90000,
        videoUrl: null,
        videoCodec: "hevc",
        hasAudio: true,
      });

      // the worker's transcode: web derivative + ready ⇒ a signed web.mp4 URL, video/mp4
      await h.admin.query(
        "INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes) VALUES ($1, 'web', $2, 1080, 1920, 1000)",
        [f.id, derivativeKey(plusBaby, f.id, "web")],
      );
      await h.admin.query("UPDATE public.photos SET rendition_status = 'ready' WHERE id = $1", [
        f.id,
      ]);
      const d3 = photoSchema.parse((await h.inject(plusMom, "GET", `/photos/${f.id}`)).json());
      expect(d3.renditionStatus).toBe("ready");
      expect(d3.videoUrl).toMatch(/web\.mp4/);
      expect(d3.videoUrl).toMatch(/video%2Fmp4|video\/mp4/);
      // never the original's key
      expect(d3.videoUrl).not.toMatch(/originals/);
      const urls = (
        await h.inject(plusMom, "POST", `/babies/${plusBaby}/photos/urls`, { photoIds: [f.id] })
      ).json() as {
        urls: Record<string, { videoUrl: string | null }>;
      };
      expect(urls.urls[f.id]?.videoUrl).toMatch(/web\.mp4/);

      // media filter on list + summary
      const vids = photosListResponseSchema.parse(
        (await h.inject(plusMom, "GET", `/babies/${plusBaby}/photos?media=video`)).json(),
      );
      const pics = photosListResponseSchema.parse(
        (await h.inject(plusMom, "GET", `/babies/${plusBaby}/photos?media=photo`)).json(),
      );
      expect(
        vids.photos.some((x) => x.id === f.id && x.mediaKind === "video" && x.durationMs === 90000),
      ).toBe(true);
      expect(pics.photos.some((x) => x.id === f.id)).toBe(false);
      const sum = photosSummaryResponseSchema.parse(
        (await h.inject(plusMom, "GET", `/babies/${plusBaby}/photos/summary?media=video`)).json(),
      );
      const sumPics = photosSummaryResponseSchema.parse(
        (await h.inject(plusMom, "GET", `/babies/${plusBaby}/photos/summary?media=photo`)).json(),
      );
      expect(sum.total).toBe(1);
      expect(sumPics.total).toBe(0);
      expect(
        (await h.inject(plusMom, "GET", `/babies/${plusBaby}/photos?media=gif`)).statusCode,
      ).toBe(400);

      // admin original download for a video: extension from the mime
      await h.admin.query("UPDATE public.photos SET mime = 'video/quicktime' WHERE id = $1", [
        f.id,
      ]);
      s3.putObject(await keyOf(f.id), bytes);
      const orig = await h.inject(plusMom, "GET", `/photos/${f.id}/original`);
      expect(orig.statusCode).toBe(200);
      expect(JSON.stringify(orig.json())).toMatch(/\.mov/);

      // a stranger sees none of it
      const stranger = await h.user();
      expect((await h.inject(stranger, "GET", `/photos/${f.id}`)).statusCode).toBe(404);
      expect((await h.inject(stranger, "GET", `/photos/${f.id}/original`)).statusCode).toBe(404);
    });

    it("Plus limits: 2 GiB registers, 2 GiB + 1 is a 400, a 6-minute hint is failed/video_too_long", async () => {
      const sid = await session(plusMom, plusBaby);
      const max = await register(plusMom, sid, {
        kind: "video",
        bytes: 2 * 1024 * MIB,
        durationMs: 300_000,
      });
      expect(max.state).toBe("registered");
      expect(max.partCount).toBe(128);
      const long = await register(plusMom, sid, {
        kind: "video",
        bytes: 10 * MIB,
        durationMs: 360_000,
      });
      expect(long).toMatchObject({ state: "failed", error: "video_too_long" });
    });
  });

  describe("Q3: 100 videos per free family", () => {
    it("freeTier shows videos/videoLimit; the 101st video register fails free_tier_limit while a photo still registers; complete at the cap is 409 free_tier_limit kind=video", async () => {
      const before = babySchema.parse((await h.inject(mom, "GET", `/babies/${freeBaby}`)).json());
      expect(before.freeTier).toMatchObject({ videos: 0, videoLimit: 100 });
      await h.admin.query(
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, media_kind, rendition_status, mime)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'babies/' || $1::text || '/originals/' || gen_random_uuid()::text, 1000, 'approved', 'ingested', 'video', 'pending', 'video/mp4'
           FROM generate_series(1, 100)`,
        [freeBaby, mom.id],
      );
      const after = babySchema.parse((await h.inject(mom, "GET", `/babies/${freeBaby}`)).json());
      expect(after.freeTier).toMatchObject({ videos: 100, used: 100 });
      const sid = await session(mom, freeBaby);
      const f = await register(mom, sid, { kind: "video", bytes: 5 * MIB, durationMs: 5000 });
      expect(f).toMatchObject({ state: "failed", error: "free_tier_limit" });
      const photo = await register(mom, sid, { bytes: 5 * MIB });
      expect(photo.state).toBe("registered");
      // bypass the register pre-check: a registered file flipped to video completes against the trigger
      const forced = await register(mom, sid, { bytes: 5 * MIB });
      await h.admin.query("UPDATE public.upload_files SET media_kind = 'video' WHERE id = $1", [
        forced.id,
      ]);
      await putAll(forced.id, 5 * MIB);
      const r = await complete(mom, sid, forced.id);
      expect(r.statusCode).toBe(409);
      const e = apiErrorSchema.parse(r.json());
      expect(e.error).toBe("free_tier_limit");
      expect((e.details as { kind?: string } | undefined)?.kind).toBe("video");
      const fr = (
        await h.admin.query("SELECT state, error FROM public.upload_files WHERE id = $1", [
          forced.id,
        ])
      ).rows[0];
      expect(fr).toEqual({ state: "failed", error: "free_tier_limit" });
      // no photos row was left behind for the refused file
      const left = await h.admin.query("SELECT 1 FROM public.photos WHERE id = $1", [forced.id]);
      expect(left.rows).toHaveLength(0);
    });
  });
});
