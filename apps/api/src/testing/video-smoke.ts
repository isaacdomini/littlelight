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
import type { JobQueue } from "../plugins/jobs";
import { createHarness, type Harness, type TestUser } from "./integration";
import { createS3Stub } from "./s3-stub";

// API video smoke run (docs/plans/step-12.md 12.4 "done when") against the integration harness's
// throwaway Postgres (DATABASE_URL; stubbed S3 and jobs):
//
//   DATABASE_URL=… pnpm --filter @tinyglow/api exec tsx src/testing/video-smoke.ts
//
// Prints one PASS/FAIL line per check; exit 0 when everything passed. Dev tool only.

interface Check {
  name: string;
  ok: boolean;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, info?: unknown) => {
  checks.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${info !== undefined ? ` ${JSON.stringify(info)}` : ""}`,
  );
};
const MIB = 1024 * 1024;

async function main(): Promise<number> {
  const s3 = createS3Stub();
  const enqueued: IngestJob[] = [];
  const jobs: JobQueue = {
    enqueueIngest: async (job) => {
      enqueued.push(job);
      return true;
    },
    enqueueReindex: async () => true,
    close: async () => undefined,
  };
  const h: Harness = await createHarness({ s3, jobs });
  try {
    const mom = await h.user({ displayName: "Mom" });
    const freeBaby = await h.baby(mom, "Free");
    const plusMom = await h.user({ displayName: "PlusMom" });
    const plusBaby = await h.baby(plusMom, "Plus");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [plusBaby]);

    const session = async (user: TestUser, babyId: string) => {
      const res = await h.inject(user, "POST", `/babies/${babyId}/uploads`, {});
      if (res.statusCode !== 201) throw new Error(`session ${res.statusCode} ${res.body}`);
      return uploadSessionSchema.parse(res.json()).id;
    };
    const register = async (user: TestUser, sid: string, file: Record<string, unknown>) => {
      const res = await h.inject(user, "POST", `/uploads/${sid}/files`, {
        files: [{ clientId: `c-${randomUUID().slice(0, 8)}`, ...file }],
      });
      if (res.statusCode !== 200) throw new Error(`register ${res.statusCode} ${res.body}`);
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

    // 1. Free: 300 MiB video ⇒ failed/file_too_large; 90 s hint ⇒ failed/video_too_long.
    {
      const sid = await session(mom, freeBaby);
      const big = await register(mom, sid, { kind: "video", bytes: 300 * MIB });
      check(
        "free: 300 MiB ⇒ failed/file_too_large",
        big.state === "failed" && big.error === "file_too_large" && big.kind === "video",
        big.error,
      );
      const long = await register(mom, sid, { kind: "video", bytes: 10 * MIB, durationMs: 90_000 });
      check(
        "free: 90 s hint ⇒ failed/video_too_long",
        long.state === "failed" && long.error === "video_too_long",
        long.error,
      );
      const ok = await register(mom, sid, { kind: "video", bytes: 40 * MIB, durationMs: 30_000 });
      check(
        "free: 40 MiB / 30 s ⇒ registered, 3 parts",
        ok.state === "registered" && ok.partCount === 3 && ok.parts?.length === 3,
        { state: ok.state, parts: ok.partCount },
      );
      const row = (
        await h.admin.query(
          "SELECT media_kind, declared_duration_ms FROM public.upload_files WHERE id = $1",
          [ok.id],
        )
      ).rows[0];
      check(
        "free: upload_files stores media_kind + duration hint",
        row.media_kind === "video" && row.declared_duration_ms === 30_000,
        row,
      );
      // Photo-kind files keep the 100 MiB cap (schema-level 400).
      const tooBigPhoto = await h.inject(mom, "POST", `/uploads/${sid}/files`, {
        files: [{ clientId: "p", bytes: 200 * MIB }],
      });
      check(
        "photo: 200 MiB is a 400 validation error",
        tooBigPhoto.statusCode === 400,
        tooBigPhoto.statusCode,
      );
    }

    // 2. Plus: 300 MiB / 90 s ⇒ registered with partCount = ceil(bytes / 16 MiB); complete books a video row.
    {
      const sid = await session(plusMom, plusBaby);
      const bytes = 300 * MIB;
      const f = await register(plusMom, sid, {
        kind: "video",
        bytes,
        durationMs: 90_000,
        mime: "video/quicktime",
      });
      check(
        "plus: 300 MiB / 90 s ⇒ registered",
        f.state === "registered" && f.partCount === Math.ceil(bytes / (16 * MIB)),
        { partCount: f.partCount },
      );
      await putAll(f.id, bytes);
      const r = await complete(plusMom, sid, f.id);
      check("plus: complete 200", r.statusCode === 200, r.statusCode);
      const p = (
        await h.admin.query(
          "SELECT media_kind, rendition_status, status, approval FROM public.photos WHERE id = $1",
          [f.id],
        )
      ).rows[0];
      check(
        "plus: photos row media_kind=video, rendition_status=pending",
        p?.media_kind === "video" && p?.rendition_status === "pending" && p?.status === "uploaded",
        p,
      );
      check(
        "plus: ingest enqueued",
        enqueued.some((j) => j.photoId === f.id),
      );
      const detail = await h.inject(plusMom, "GET", `/photos/${f.id}`);
      const d = photoSchema.parse(detail.json());
      check(
        "plus: detail before ingest: mediaKind video, no videoUrl",
        d.mediaKind === "video" &&
          d.renditionStatus === "pending" &&
          d.videoUrl === null &&
          d.durationMs === null,
        { kind: d.mediaKind, rs: d.renditionStatus, url: d.videoUrl },
      );
      // Simulate the worker: ingested + ready with a web derivative ⇒ videoUrl appears.
      await h.admin.query(
        `UPDATE public.photos SET status = 'ingested', duration_ms = 90000, video_codec = 'hevc', has_audio = true,
                width = 1080, height = 1920 WHERE id = $1`,
        [f.id],
      );
      const detail2 = photoSchema.parse((await h.inject(plusMom, "GET", `/photos/${f.id}`)).json());
      check(
        "plus: detail pending: durationMs set, videoUrl still null",
        detail2.durationMs === 90000 &&
          detail2.videoUrl === null &&
          detail2.videoCodec === "hevc" &&
          detail2.hasAudio === true,
      );
      await h.admin.query(
        `INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes) VALUES ($1, 'web', $2, 1080, 1920, 1000)`,
        [f.id, derivativeKey(plusBaby, f.id, "web")],
      );
      await h.admin.query("UPDATE public.photos SET rendition_status = 'ready' WHERE id = $1", [
        f.id,
      ]);
      const detail3 = photoSchema.parse((await h.inject(plusMom, "GET", `/photos/${f.id}`)).json());
      check(
        "plus: detail ready: videoUrl signed (web.mp4, video/mp4)",
        detail3.renditionStatus === "ready" &&
          !!detail3.videoUrl &&
          /web\.mp4/.test(detail3.videoUrl) &&
          /video%2Fmp4|video\/mp4/.test(detail3.videoUrl),
        detail3.videoUrl?.slice(0, 80),
      );
      const urls = (
        await h.inject(plusMom, "POST", `/babies/${plusBaby}/photos/urls`, { photoIds: [f.id] })
      ).json() as { urls: Record<string, { videoUrl: string | null }> };
      check("plus: batch urls carry videoUrl", !!urls.urls[f.id]?.videoUrl);
      // media filter on list + summary.
      const list = photosListResponseSchema.parse(
        (await h.inject(plusMom, "GET", `/babies/${plusBaby}/photos?media=video`)).json(),
      );
      const listPhotos = photosListResponseSchema.parse(
        (await h.inject(plusMom, "GET", `/babies/${plusBaby}/photos?media=photo`)).json(),
      );
      check(
        "plus: ?media=video lists the video, ?media=photo does not",
        list.photos.some(
          (x) => x.id === f.id && x.mediaKind === "video" && x.durationMs === 90000,
        ) && !listPhotos.photos.some((x) => x.id === f.id),
      );
      const sum = photosSummaryResponseSchema.parse(
        (await h.inject(plusMom, "GET", `/babies/${plusBaby}/photos/summary?media=video`)).json(),
      );
      const sumPhotos = photosSummaryResponseSchema.parse(
        (await h.inject(plusMom, "GET", `/babies/${plusBaby}/photos/summary?media=photo`)).json(),
      );
      check("plus: summary respects ?media", sum.total === 1 && sumPhotos.total === 0, {
        video: sum.total,
        photo: sumPhotos.total,
      });
      // Admin original download for a video: extension from the mime.
      await h.admin.query("UPDATE public.photos SET mime = 'video/quicktime' WHERE id = $1", [
        f.id,
      ]);
      s3.putObject(await keyOf(f.id), bytes);
      const orig = await h.inject(plusMom, "GET", `/photos/${f.id}/original`);
      check(
        "plus: original download URL for a video (.mov)",
        orig.statusCode === 200 && /\.mov/.test(JSON.stringify(orig.json())),
        orig.statusCode,
      );
    }

    // 3. Free Q3 cap: 100 approved videos ⇒ the 101st register fails free_tier_limit; a direct
    //    complete past the cap is 409 free_tier_limit with details.kind = 'video'.
    {
      const before = babySchema.parse((await h.inject(mom, "GET", `/babies/${freeBaby}`)).json());
      check(
        "free: freeTier.videos/videoLimit present",
        before.freeTier?.videos === 0 && before.freeTier?.videoLimit === 100,
        before.freeTier,
      );
      await h.admin.query(
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, media_kind, rendition_status, mime)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'babies/' || $1::text || '/originals/' || gen_random_uuid()::text, 1000, 'approved', 'ingested', 'video', 'pending', 'video/mp4'
           FROM generate_series(1, 100)`,
        [freeBaby, mom.id],
      );
      const after = babySchema.parse((await h.inject(mom, "GET", `/babies/${freeBaby}`)).json());
      check(
        "free: freeTier.videos = 100 after 100 videos",
        after.freeTier?.videos === 100 && after.freeTier?.used === 100,
        after.freeTier,
      );
      const sid = await session(mom, freeBaby);
      const f = await register(mom, sid, { kind: "video", bytes: 5 * MIB, durationMs: 5000 });
      check(
        "free: 101st video register ⇒ failed/free_tier_limit",
        f.state === "failed" && f.error === "free_tier_limit",
        f.error,
      );
      const photo = await register(mom, sid, { bytes: 5 * MIB });
      check(
        "free: a photo still registers (pool has room)",
        photo.state === "registered",
        photo.state,
      );
      // Bypass the register pre-check: a registered video file completing at the cap hits the trigger.
      const forced = await register(mom, sid, { bytes: 5 * MIB });
      await h.admin.query("UPDATE public.upload_files SET media_kind = 'video' WHERE id = $1", [
        forced.id,
      ]);
      await putAll(forced.id, 5 * MIB);
      const r = await complete(mom, sid, forced.id);
      const e = r.statusCode === 409 ? apiErrorSchema.parse(r.json()) : null;
      check(
        "free: complete at the cap ⇒ 409 free_tier_limit details.kind=video",
        r.statusCode === 409 &&
          e?.error === "free_tier_limit" &&
          (e?.details as { kind?: string } | undefined)?.kind === "video",
        { status: r.statusCode, body: r.json() },
      );
      const fr = (
        await h.admin.query("SELECT state, error FROM public.upload_files WHERE id = $1", [
          forced.id,
        ])
      ).rows[0];
      check(
        "free: that file is failed/free_tier_limit",
        fr.state === "failed" && fr.error === "free_tier_limit",
        fr,
      );
    }
  } finally {
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
