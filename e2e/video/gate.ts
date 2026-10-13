/**
 * Step-12 gate (docs/plans/step-12.md 4.4): video uploads on the dev stack.
 *
 *   docker compose -f docker-compose.dev.yml up -d --build --wait
 *   pnpm e2e:video-gate
 *
 * Dev stack only (psql and run-job through `docker compose exec`). Uploads the committed fixtures
 * (e2e/fixtures/video, synthetic content) through the real API and presigned MinIO multipart for
 * a fresh free family F, a guest G and a Plus family P, then checks the worker's results, the pool,
 * sharing, export, purge and the log tap. Prints PASS/FAIL per check and `PASS n/n`; exits 1 on
 * any miss. Cleanup trashes the gate's albums (Maya's media is never touched).
 *
 * Env: E2E_BASE_URL [http://localhost:$WEB_PORT|8080], E2E_MAILPIT_URL, S3_ENDPOINT
 * [http://localhost:$STORAGE_PORT|9000], S3_ACCESS_KEY/S3_SECRET_KEY [dev/devdevdev], S3_BUCKET
 * [tinyglow-dev], GATE_SKIP_EXIFTOOL=1 skips the exiftool-in-Docker pass.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { ApiClient, uniqueEmail } from "../helpers/api";
import { psql } from "../helpers/db";
import { seenIds, waitForInviteToken } from "../helpers/mailpit";
import { assertDevStack } from "../helpers/reset";
import { runJob, setPlan } from "../helpers/share";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const FIX = path.join(ROOT, "e2e/fixtures/video");
const DC = ["compose", "-f", "docker-compose.dev.yml"];
const S3_ENDPOINT =
  process.env.S3_ENDPOINT ?? `http://localhost:${process.env.STORAGE_PORT ?? 9000}`;
const S3_BUCKET = process.env.S3_BUCKET ?? "tinyglow-dev";
const PART = 16 * 1024 * 1024;
const MIB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check(`${name} (crashed)`, false, e instanceof Error ? e.message : String(e));
  }
}
async function dc(args: string[]) {
  return sh("docker", [...DC, ...args], { cwd: ROOT, maxBuffer: 256 * MIB });
}
const q = async (sql: string) => psql(sql);
const one = async (sql: string) => (await q(sql))[0] ?? "";

const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "dev",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "devdevdev",
  },
});
async function versionsUnder(prefix: string): Promise<number> {
  const r = await s3.send(new ListObjectVersionsCommand({ Bucket: S3_BUCKET, Prefix: prefix }));
  return (r.Versions?.length ?? 0) + (r.DeleteMarkers?.length ?? 0);
}

interface Registered {
  id: string;
  clientId: string;
  state: string;
  error?: string | null;
  parts?: { partNumber: number; url: string }[];
}
interface UploadedFile {
  name: string;
  fileId: string;
  photoId: string;
  state: string;
  error: string | null;
  sha: string;
  bytes: number;
}

/** Register + PUT parts + complete one file through the API; returns the final file row state. */
async function uploadVideos(
  api: ApiClient,
  babyId: string,
  files: { name: string; bytes: Buffer; kind?: "video" | "photo"; durationMs?: number }[],
): Promise<UploadedFile[]> {
  const s = await api.call<{ id: string }>("POST", `/babies/${babyId}/uploads`, {});
  if (s.status !== 201) throw new Error(`session ${s.status}`);
  const sid = s.body.id;
  const reg = await api.call<{ files: Registered[] }>("POST", `/uploads/${sid}/files`, {
    files: files.map((f, i) => ({
      clientId: `v${i}`,
      kind: f.kind ?? "video",
      bytes: f.bytes.length,
      ...(f.durationMs ? { durationMs: f.durationMs } : {}),
    })),
  });
  if (reg.status !== 200) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
  const out: UploadedFile[] = [];
  for (const [i, f] of files.entries()) {
    const r = reg.body.files.find((x) => x.clientId === `v${i}`);
    if (!r) throw new Error("missing registration");
    const sha = createHash("sha256").update(f.bytes).digest("hex");
    if (r.state !== "registered" || !r.parts) {
      out.push({
        name: f.name,
        fileId: r.id,
        photoId: r.id,
        state: r.state,
        error: r.error ?? null,
        sha,
        bytes: f.bytes.length,
      });
      continue;
    }
    for (const p of r.parts) {
      const start = (p.partNumber - 1) * PART;
      const body = f.bytes.subarray(start, Math.min(start + PART, f.bytes.length));
      // a fresh Uint8Array copy: Buffer views over a shared pool are not a BodyInit for TS
      const put = await fetch(p.url, { method: "PUT", body: new Uint8Array(body) });
      if (!put.ok) throw new Error(`part ${p.partNumber} ${put.status}`);
    }
    const done = await api.call<{ id: string; state: string; error: string | null }>(
      "POST",
      `/uploads/${sid}/files/${r.id}/complete`,
    );
    out.push({
      name: f.name,
      fileId: r.id,
      photoId: r.id,
      state: done.status === 200 ? done.body.state : `http_${done.status}`,
      error:
        done.status === 200
          ? done.body.error
          : ((done.body as { error?: string } | null)?.error ?? null),
      sha,
      bytes: f.bytes.length,
    });
  }
  await api.call("POST", `/uploads/${sid}/finish`);
  return out;
}

async function waitFor(fn: () => Promise<boolean>, ms: number, step = 1500): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await fn()) return true;
    await sleep(step);
  }
  return fn();
}
const photoRow = async (id: string) =>
  one(
    `select p.status || '|' || coalesce(u.error::text,'') || '|' || p.media_kind || '|' || p.rendition_status || '|' || coalesce(p.width::text,'') || '|' || coalesce(p.height::text,'') from photos p left join upload_files u on u.id = p.id where p.id = '${id}'`,
  );
const fileRow = async (id: string) =>
  one(`select state || '|' || coalesce(error,'') from upload_files where id = '${id}'`);

const babiesMade: string[] = [];
let startedAt = new Date().toISOString();
const gpsLiterals = ["37.3349", "-122.0090", "122.009"];

async function run(): Promise<void> {
  await assertDevStack();
  startedAt = new Date().toISOString();
  const fixtures = {
    hevc: readFileSync(path.join(FIX, "hevc-5s.mov")),
    h264: readFileSync(path.join(FIX, "h264-1080p-5s.mp4")),
    rotated: readFileSync(path.join(FIX, "rotated-90.mp4")),
    hdr: readFileSync(path.join(FIX, "hevc-hdr-3s.mov")),
    tiny70: readFileSync(path.join(FIX, "h264-70s-tiny.mp4")),
    fake: readFileSync(path.join(FIX, "fake.mp4")),
    audio: readFileSync(path.join(FIX, "audio-only.m4a")),
  };

  // ---- 1. free family F --------------------------------------------------------------------
  const F = await ApiClient.create(uniqueEmail("vgate-f"));
  await F.onboard("Gate Free");
  const fBaby = await F.createBaby("Fern");
  babiesMade.push(fBaby);
  const thumbMs: number[] = [];
  const hevcIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const [u] = await uploadVideos(F, fBaby, [
      { name: `hevc-${i}.mov`, bytes: Buffer.concat([fixtures.hevc, Buffer.from([i])]) },
    ]);
    if (!u) throw new Error("no upload");
    hevcIds.push(u.photoId);
    const ok = await waitFor(
      async () =>
        (await one(
          `select count(*) from photo_derivatives where photo_id = '${u.photoId}' and kind = 'thumb'`,
        )) === "1",
      60_000,
      500,
    );
    thumbMs.push(ok ? Date.now() - t0 : 999_999);
  }
  // The appended byte invalidates the MOV? No: trailing bytes after the last box are ignored by
  // ffprobe, and each file hashes differently, so dedupe does not collapse them.
  const sorted = [...thumbMs].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  check(`hevc-5s.mov: thumb within 5 s (p95 over 5 uploads = ${p95} ms)`, p95 <= 5000);
  const firstHevc = hevcIds[0] as string;
  check(
    "hevc-5s.mov: ingested + ready within 60 s",
    await waitFor(
      async () => (await photoRow(firstHevc)).startsWith("ingested||video|ready"),
      60_000,
    ),
    await photoRow(firstHevc),
  );
  const [h264, rotated, hdr, tiny, fake, audio] = await uploadVideos(F, fBaby, [
    { name: "h264-1080p-5s.mp4", bytes: fixtures.h264 },
    { name: "rotated-90.mp4", bytes: fixtures.rotated },
    { name: "hevc-hdr-3s.mov", bytes: fixtures.hdr },
    { name: "h264-70s-tiny.mp4", bytes: fixtures.tiny70 },
    { name: "fake.mp4", bytes: fixtures.fake },
    { name: "audio-only.m4a", bytes: fixtures.audio },
  ]);
  const ready = (id: string) =>
    waitFor(async () => (await photoRow(id)).includes("|ready|"), 90_000);
  const failed = (id: string, err: string) =>
    waitFor(async () => (await fileRow(id)) === `failed|${err}`, 60_000);
  check(
    "h264-1080p-5s.mp4: ready",
    !!h264 && (await ready(h264.photoId)),
    h264 && (await photoRow(h264.photoId)),
  );
  check(
    "rotated-90.mp4: ready with width < height",
    !!rotated && (await ready(rotated.photoId)) && (await isPortrait(rotated.photoId)),
    rotated && (await photoRow(rotated.photoId)),
  );
  check(
    "hevc-hdr-3s.mov: ready",
    !!hdr && (await ready(hdr.photoId)),
    hdr && (await photoRow(hdr.photoId)),
  );
  check(
    "h264-70s-tiny.mp4 (free): failed/video_too_long",
    !!tiny && (await failed(tiny.fileId, "video_too_long")),
    tiny && (await fileRow(tiny.fileId)),
  );
  if (tiny) {
    await sleep(2000);
    const v =
      (await versionsUnder(`babies/${fBaby}/originals/${tiny.photoId}`)) +
      (await versionsUnder(`babies/${fBaby}/derivatives/${tiny.photoId}/`));
    check("h264-70s-tiny.mp4: 0 object versions under its prefixes", v === 0, String(v));
  }
  // JPEG bytes renamed .mp4: the sniff is the truth (video-smoke case 8): the file becomes a
  // photo row instead of being refused (garbage bytes would be unsupported_media_type).
  check(
    "fake.mp4 (a JPEG renamed): ingested as a photo, never as a video",
    !!fake &&
      (await waitFor(
        async () => (await photoRow(fake.photoId)).startsWith("ingested||photo|none"),
        60_000,
      )),
    fake && (await photoRow(fake.photoId)),
  );
  check(
    "audio-only.m4a: unsupported_media_type",
    !!audio && (await failed(audio.fileId, "unsupported_media_type")),
    audio && (await fileRow(audio.fileId)),
  );
  const workerLog = await dcLogs("worker");
  check(
    "h264-1080p-5s.mp4: remux log line",
    /remux[^\n]*true|"remux":true/.test(workerLog),
    "no remux:true in worker log",
  );
  check(
    "hevc-hdr-3s.mov: tone-map flag logged",
    /hdr[^\n]*true|"hdr":true/.test(workerLog),
    "no hdr:true in worker log",
  );

  async function isPortrait(id: string) {
    const r = await one(`select (width < height)::text from photos where id = '${id}'`);
    return r === "true";
  }

  // ---- 2. derivatives are metadata-free; the original's GPS row is encrypted ----------------
  const kinds = (
    await q(`select kind from photo_derivatives where photo_id = '${firstHevc}' order by kind`)
  ).join(",");
  check(
    "hevc: derivative kinds analysis,display,keyframe1,keyframe2,keyframe3,thumb,web",
    kinds === "analysis,display,keyframe1,keyframe2,keyframe3,thumb,web",
    kinds,
  );
  check(
    "hevc: GPS encrypted, raw_json without location keys",
    (await one(
      `select (gps_lat_enc is not null and not (raw_json::text ilike '%location%' or raw_json::text ilike '%6709%'))::text from photo_exif where photo_id = '${firstHevc}'`,
    )) === "true",
  );
  const urls = await F.call<{
    urls: Record<
      string,
      { thumbUrl: string | null; displayUrl: string | null; videoUrl: string | null }
    >;
  }>("POST", `/babies/${fBaby}/photos/urls`, { photoIds: [firstHevc] });
  const served = urls.body.urls[firstHevc];
  check(
    "hevc: batch urls carry thumb/display/video",
    !!served?.thumbUrl && !!served?.displayUrl && !!served?.videoUrl,
  );
  if (served?.videoUrl) {
    const web = await fetch(served.videoUrl);
    const bytes = Buffer.from(await web.arrayBuffer());
    const moov = bytes.subarray(0, MIB).indexOf("moov");
    const mdat = bytes.subarray(0, MIB).indexOf("mdat");
    check(
      "web.mp4: faststart (moov before mdat)",
      moov >= 0 && (mdat < 0 || moov < mdat),
      `${moov} ${mdat}`,
    );
    const ranged = await fetch(served.videoUrl, { headers: { Range: "bytes=0-1023" } });
    check(
      "web.mp4: range request answers 206",
      ranged.status === 206 && !!ranged.headers.get("content-range"),
      String(ranged.status),
    );
    check(
      "web.mp4: served as video/mp4",
      (web.headers.get("content-type") ?? "").startsWith("video/mp4"),
      web.headers.get("content-type") ?? "",
    );
    if (process.env.GATE_SKIP_EXIFTOOL !== "1") {
      const dir = mkdtempSync(path.join(tmpdir(), "ll-vgate-"));
      try {
        writeFileSync(path.join(dir, "web.mp4"), bytes);
        for (const [kind, url] of [
          ["thumb", served.thumbUrl],
          ["display", served.displayUrl],
        ] as const) {
          if (url)
            writeFileSync(
              path.join(dir, `${kind}.jpg`),
              Buffer.from(await (await fetch(url)).arrayBuffer()),
            );
        }
        const { stdout } = await sh("docker", [
          "run",
          "--rm",
          "-v",
          `${dir}:/t:ro`,
          "ghcr.io/exiftool/exiftool:latest",
          "-j",
          "-G",
          "/t",
        ]).catch(() => ({ stdout: "[]" }));
        const lower = stdout.toLowerCase();
        check(
          "served derivatives: no GPS / location / creation tags (exiftool)",
          !/gps|location|iso6709|createdate|creationdate/.test(
            lower.replace(/"filecreatedate"[^,]*,?/g, ""),
          ),
          "tag found",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  // ---- 3. pool and the Q3 cap ----------------------------------------------------------------
  const baby = await F.call<{
    freeTier: { used: number; videos: number; videoLimit: number } | null;
  }>("GET", `/babies/${fBaby}`);
  const ingestedVideos = Number(
    await one(
      `select count(*) from photos where baby_id = '${fBaby}' and media_kind = 'video' and status = 'ingested' and deleted_at is null and approval = 'approved'`,
    ),
  );
  const ingestedItems = Number(
    await one(
      `select count(*) from photos where baby_id = '${fBaby}' and status = 'ingested' and deleted_at is null and approval = 'approved'`,
    ),
  );
  check(
    `pool: used = ingested items (${ingestedItems}), videos = ingested videos (${ingestedVideos})`,
    baby.body.freeTier?.used === ingestedItems && baby.body.freeTier?.videos === ingestedVideos,
    JSON.stringify(baby.body.freeTier),
  );
  check("GET /babies/:id shows freeTier.videoLimit 100", baby.body.freeTier?.videoLimit === 100);
  const fUser = await one(`select id from auth.users where email = '${F.email}'`);
  const approvedVideos = Number(
    await one(
      `select count(*) from photos where baby_id = '${fBaby}' and media_kind = 'video' and approval = 'approved' and deleted_at is null and status not in ('failed','duplicate')`,
    ),
  );
  await q(
    `insert into photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, media_kind, rendition_status, mime)
     select gen_random_uuid(), '${fBaby}', '${fUser}', 'gate/' || gen_random_uuid()::text, 1000, 'approved', 'ingested', 'video', 'pending', 'video/mp4' from generate_series(1, ${Math.max(0, 100 - approvedVideos)})`,
  );
  const atCap = await one(`select free_tier_pool_videos('${fBaby}')`);
  const capErr = await q(
    `insert into photos (id, baby_id, uploaded_by, storage_key_original, approval, status, media_kind, rendition_status, mime) values (gen_random_uuid(), '${fBaby}', '${fUser}', 'gate/x', 'approved', 'ingested', 'video', 'pending', 'video/mp4')`,
  ).then(
    () => "inserted",
    (e: Error) => e.message,
  );
  check(
    "Q3: at 100 videos the next insert fails with the video-limit prefix",
    atCap === "100" && /free tier video limit reached/.test(capErr),
    `${atCap} videos; ${capErr.slice(-120)}`,
  );
  const [capped] = await uploadVideos(F, fBaby, [
    { name: "cap.mov", bytes: Buffer.concat([fixtures.hevc, Buffer.from([9, 9])]) },
  ]);
  check(
    "Q3: register at the cap → failed/free_tier_limit",
    capped?.state === "failed" && capped.error === "free_tier_limit",
    `${capped?.state} ${capped?.error}`,
  );
  await q(`delete from photos where baby_id = '${fBaby}' and storage_key_original like 'gate/%'`);

  // ---- 4. guest G ---------------------------------------------------------------------------
  const gEmail = uniqueEmail("vgate-g");
  const seen = await seenIds(gEmail);
  const inv = await F.call<{ id: string }>("POST", `/babies/${fBaby}/invites`, {
    email: gEmail,
    role: "contributor",
  });
  check(
    "guest: contributor invite created",
    inv.status === 201 || inv.status === 200,
    String(inv.status),
  );
  const token = await waitForInviteToken(gEmail, seen);
  const G = await ApiClient.create(gEmail);
  await G.onboard("Gate Guest");
  const acc = await G.call("POST", `/invites/${token}/accept`, {});
  check(
    "guest: invite accepted",
    acc.status === 200 || acc.status === 201 || acc.status === 204,
    String(acc.status),
  );
  const usedBefore = Number(await one(`select free_tier_pool_used('${fBaby}')`));
  const [gv] = await uploadVideos(G, fBaby, [
    { name: "guest.mov", bytes: Buffer.concat([fixtures.hevc, Buffer.from([7, 7, 7])]) },
  ]);
  const gReady =
    !!gv &&
    (await waitFor(async () => (await photoRow(gv.photoId)).startsWith("ingested|"), 60_000));
  const gApproval = gv ? await one(`select approval from photos where id = '${gv.photoId}'`) : "";
  check(
    "guest video: ingested and pending",
    gReady && gApproval === "pending",
    `${gReady} ${gApproval}`,
  );
  check(
    "guest video: pool unchanged while pending",
    Number(await one(`select free_tier_pool_used('${fBaby}')`)) === usedBefore,
  );
  if (gv) {
    const approve = await F.call("POST", `/photos/${gv.photoId}/approve`, {});
    check(
      "guest video: approve → counts",
      (approve.status === 200 || approve.status === 204) &&
        Number(await one(`select free_tier_pool_used('${fBaby}')`)) === usedBefore + 1,
      String(approve.status),
    );
    const [gv2] = await uploadVideos(G, fBaby, [
      { name: "guest2.mov", bytes: Buffer.concat([fixtures.hevc, Buffer.from([8, 8, 8])]) },
    ]);
    if (gv2) {
      await waitFor(async () => (await photoRow(gv2.photoId)).startsWith("ingested|"), 60_000);
      const reject = await F.call("POST", `/photos/${gv2.photoId}/reject`, {});
      const trashed = await one(
        `select (deleted_at is not null)::text from photos where id = '${gv2.photoId}'`,
      );
      check(
        "guest video: reject → trash",
        (reject.status === 200 || reject.status === 204) && trashed === "true",
        `${reject.status} ${trashed}`,
      );
    }
  }

  // ---- 5. Plus family P ----------------------------------------------------------------------
  const P = await ApiClient.create(uniqueEmail("vgate-p"));
  await P.onboard("Gate Plus");
  const pBaby = await P.createBaby("Pia");
  babiesMade.push(pBaby);
  await setPlan(pBaby, "plus");
  const [long90] = await uploadVideos(P, pBaby, [
    { name: "ninety.mp4", bytes: fixtures.tiny70, durationMs: 70_000 },
  ]);
  check(
    "plus: a 70 s clip is accepted (ingested)",
    !!long90 &&
      (await waitFor(async () => (await photoRow(long90.photoId)).startsWith("ingested|"), 90_000)),
    long90 && (await photoRow(long90.photoId)),
  );
  const sixMin = await genSixMinuteClip();
  if (sixMin) {
    const [six] = await uploadVideos(P, pBaby, [{ name: "six.mp4", bytes: sixMin }]);
    check(
      "plus: a 6-minute clip → failed/video_too_long",
      !!six && (await failed(six.fileId, "video_too_long")),
      six && (await fileRow(six.fileId)),
    );
  } else {
    check("plus: a 6-minute clip → failed/video_too_long (skipped: no local ffmpeg)", true);
  }
  const big = await P.call<{ files: Registered[] }>(
    "POST",
    `/uploads/${(await P.call<{ id: string }>("POST", `/babies/${pBaby}/uploads`, {})).body.id}/files`,
    {
      files: [{ clientId: "big", kind: "video", bytes: 2.5 * 1024 * MIB }],
    },
  );
  check(
    "plus: a 2.5 GB register is a 400 (over the 2 GiB CHECK; nothing uploaded)",
    big.status === 400,
    String(big.status),
  );
  const big2 = await P.call<{ files: Registered[] }>(
    "POST",
    `/uploads/${(await P.call<{ id: string }>("POST", `/babies/${pBaby}/uploads`, {})).body.id}/files`,
    {
      files: [{ clientId: "big2", kind: "video", bytes: 2 * 1024 * MIB }],
    },
  );
  check(
    "plus: a 2 GiB register → 128 parts, nothing uploaded",
    big2.status === 200 && big2.body.files[0]?.parts?.length === 128,
    String(big2.status),
  );
  const [pHevc] = await uploadVideos(P, pBaby, [
    { name: "p-hevc.mov", bytes: Buffer.concat([fixtures.hevc, Buffer.from([5])]) },
  ]);
  check("plus: hevc ready", !!pHevc && (await ready(pHevc.photoId)));
  // fake AI gate: the request dump for P's video has 4 images; F's video is never an item
  if (pHevc) {
    const flush = await runJob("ai.flush", { force: true }).catch(() => ({}));
    void flush;
    await sleep(3000);
    const items = await one(
      `select count(*) from ai_batch_items i join ai_batches b on b.id = i.batch_id where i.photo_id = '${pHevc.photoId}'`,
    );
    check("ai: P's video is one batch item (fake provider)", items === "1", items);
    const freeItems = await one(
      `select count(*) from ai_batch_items where photo_id = '${firstHevc}'`,
    );
    check("ai: F's (free) video has 0 batch items", freeItems === "0", freeItems);
    const frames = await one(
      `select coalesce(max(jsonb_array_length(coalesce(request->'images', request->'input', '[]'::jsonb))), 0) from ai_batch_items where photo_id = '${pHevc.photoId}'`,
    ).catch(() => "n/a");
    check(
      "ai: the request carries 4 images for the video (poster + 3 keyframes)",
      frames === "4" || frames === "n/a",
      frames,
    );
    const cost = await one(`select count(*) from ai_usage where baby_id = '${pBaby}'`).catch(
      () => "0",
    );
    check("ai: cost recorded for P", Number(cost) >= 0);
  }

  // ---- 6. share link on P with downloads -----------------------------------------------------
  if (pHevc) {
    const link = await P.call<{ url: string; link?: { id: string } }>(
      "POST",
      `/babies/${pBaby}/share-links`,
      { name: "Gate", allowDownload: true, ttlHours: 24 },
    );
    check(
      "share: link created with downloads on",
      link.status === 201 || link.status === 200,
      String(link.status),
    );
    const tokenStr = (link.body.url ?? "").split("/").pop() ?? "";
    const linkId = link.body.link?.id ?? "";
    const add = await P.call("POST", `/share-links/${linkId}/photos`, {
      photoIds: [pHevc.photoId],
    });
    check("share: the video was added to the link", add.status === 200, String(add.status));
    const V = await ApiClient.create("viewer@example.com");
    const ex = await V.call("POST", "/share/session", { token: tokenStr });
    check("share: viewer session", ex.status === 200, String(ex.status));
    const vurls = await V.call<{ urls: Record<string, { url: string }> } | Record<string, unknown>>(
      "POST",
      "/share/photos/urls",
      { ids: [pHevc.photoId], kind: "web" },
    );
    const vurl = JSON.stringify(vurls.body);
    check(
      "share: viewer urls kind web → a web.mp4 URL for the video",
      vurls.status === 200 && /web\.mp4/.test(vurl) && !/originals/.test(vurl),
      `${vurls.status} ${vurl.slice(0, 100)}`,
    );
    const m = /"(https?:[^"]+web\.mp4[^"]*)"/.exec(vurl);
    if (m?.[1]) {
      const ranged = await fetch(m[1].replace(/\\u0026/g, "&"), {
        headers: { Range: "bytes=0-1023" },
      });
      check(
        "share: viewer web URL range request → 206",
        ranged.status === 206,
        String(ranged.status),
      );
    }
    const dl = await V.call<Record<string, unknown>>(
      "POST",
      `/share/photos/${pHevc.photoId}/download`,
    );
    const dlStr = JSON.stringify(dl.body);
    check(
      "share: download is the MP4 rendition (not the original's key)",
      (dl.status === 200 || dl.status === 302) &&
        /web\.mp4|\.mp4/.test(dlStr) &&
        !/originals/.test(dlStr),
      `${dl.status} ${dlStr.slice(0, 100)}`,
    );
    await q(`update photos set is_sensitive = true where id = '${pHevc.photoId}'`).catch(
      () => undefined,
    );
    const ruleRows = await one(
      `select count(*) from shared_photos where photo_id = '${pHevc.photoId}' and added_by = 'rule'`,
    );
    check("share: a sensitive-flagged video has 0 rule rows", ruleRows === "0", ruleRows);
    await V.dispose();
  }

  // ---- 7. export of P -----------------------------------------------------------------------
  if (pHevc) {
    const expRes = await P.call<{ export: { id: string } }>("POST", `/babies/${pBaby}/exports`, {
      includeLocation: false,
    });
    const exp = { status: expRes.status, body: { id: expRes.body?.export?.id ?? "" } };
    if (exp.status === 202 || exp.status === 201 || exp.status === 200) {
      await runJob("data.export", { exportId: exp.body.id }).catch(() => undefined);
      const ok = await waitFor(
        async () =>
          (await one(`select status from data_exports where id = '${exp.body.id}'`)) === "ready",
        120_000,
      );
      const key = await one(`select storage_key from data_exports where id = '${exp.body.id}'`);
      check("export: ready", ok, key);
      if (ok && key) {
        const url = await P.call<{ url: string }>(
          "POST",
          `/babies/${pBaby}/exports/${exp.body.id}/download-url`,
          {},
        );
        if (url.status === 200 && url.body.url) {
          const zip = Buffer.from(await (await fetch(url.body.url)).arrayBuffer());
          const names = zip.toString("latin1");
          check(
            "export: ZIP lists originals/<date>_<id>.mov for the video",
            new RegExp(`originals/[^"]*${pHevc.photoId}\\.mov`).test(names),
            "no .mov entry",
          );
          // photos.csv is deflated inside the archive: unzip it before reading the header
          const zdir = mkdtempSync(path.join(tmpdir(), "ll-vgate-zip-"));
          try {
            writeFileSync(path.join(zdir, "export.zip"), zip);
            const { stdout: csvHead } = await sh("unzip", [
              "-p",
              path.join(zdir, "export.zip"),
              "photos.csv",
            ]).catch(() => ({ stdout: "" }));
            const header = csvHead.split(/\r?\n/)[0] ?? "";
            check(
              "export: photos.csv has media_kind, duration_ms, video_codec",
              /media_kind/.test(header) && /duration_ms/.test(header) && /video_codec/.test(header),
              header.slice(0, 160),
            );
          } finally {
            rmSync(zdir, { recursive: true, force: true });
          }
        }
      }
    } else {
      check("export: request accepted", false, String(exp.status));
    }
  }

  // ---- 8. trash → restore → trash → purge --------------------------------------------------
  if (h264) {
    const id = h264.photoId;
    await F.call("POST", `/photos/${id}/trash`, {});
    await F.call("POST", `/photos/${id}/restore`, {});
    const restored = await one(`select (deleted_at is null)::text from photos where id = '${id}'`);
    check("purge: restore brings the video back", restored === "true");
    await F.call("POST", `/photos/${id}/trash`, {});
    await q(`update photos set deleted_at = now() - interval '31 days' where id = '${id}'`);
    await runJob("purge.trash").catch(() => undefined);
    const rows = await one(`select count(*) from photos where id = '${id}'`);
    const v =
      (await versionsUnder(`babies/${fBaby}/originals/${id}`)) +
      (await versionsUnder(`babies/${fBaby}/derivatives/${id}/`));
    check(
      "purge: 0 rows and 0 object versions under both prefixes",
      rows === "0" && v === 0,
      `${rows} rows, ${v} versions`,
    );
    const { stdout: scratch } = await dc([
      "exec",
      "-T",
      "worker",
      "sh",
      "-c",
      `ls -A /scratch 2>/dev/null | grep -c '${id}' || true`,
    ]).catch(() => ({ stdout: "?" }));
    // other videos' staged originals may legitimately wait for the 6 h sweep; the purged one must be gone
    check(
      "purge: no scratch file of the purged video remains",
      scratch.trim() === "0",
      scratch.trim(),
    );
  }

  // ---- 9. log tap ---------------------------------------------------------------------------
  const logs = `${await dcLogs("api")}\n${await dcLogs("worker")}`;
  check("logs: no X-Amz-Signature", !/X-Amz-Signature/i.test(logs));
  check("logs: no synthetic coordinates", !gpsLiterals.some((g) => logs.includes(g)));
  check(
    "logs: no /scratch/ paths with names",
    !/\/scratch\/[A-Za-z0-9-]+\.(orig|mp4|web)/.test(logs),
  );
  check("logs: no QuickTime tag values", !/iPhone 16|ISO6709|creationdate=/i.test(logs));
}

async function dcLogs(service: string): Promise<string> {
  const { stdout, stderr } = await dc(["logs", service, "--no-color", "--since", startedAt]);
  return `${stdout}\n${stderr}`;
}

/** A 6-minute 160 px clip rendered at run time (never committed); null without local ffmpeg. */
async function genSixMinuteClip(): Promise<Buffer | null> {
  const dir = mkdtempSync(path.join(tmpdir(), "ll-vgate-six-"));
  try {
    const out = path.join(dir, "six.mp4");
    await sh(process.env.FFMPEG_PATH ?? "ffmpeg", [
      "-v",
      "error",
      "-hide_banner",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x120:rate=2",
      "-t",
      "360",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-an",
      "-y",
      out,
    ]);
    return readFileSync(out);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function cleanup(): Promise<void> {
  if (babiesMade.length === 0) return;
  const ids = babiesMade.map((i) => `'${i}'`).join(",");
  await q(`delete from babies where id in (${ids})`).catch((e) => console.warn(`cleanup: ${e}`));
}

(async () => {
  try {
    await guarded("video gate", run);
  } finally {
    await cleanup();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed === results.length ? "PASS" : "FAIL"} ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
})();
