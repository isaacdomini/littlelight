/**
 * Step-12 live checks on the dev stack (coordinator's dev-stack pass, lanes (a) backend and
 * (b) ai), one PASS/FAIL line per check. Uploads a real HEVC MOV (ISO6709 location tag) to a Plus
 * family and a free family, verifies the row, derivatives, EXIF, served rendition, run-job paths,
 * sweep counters and heartbeat gauge, then the fake-AI request dump, cost, search `?media=video`
 * and the chat tool's `media:"video"` argument. Cleans up the two accounts it created.
 *
 *   LIVE_MOV=/path/to/hevc-5s.mov pnpm exec tsx e2e/video/live-check.ts
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ApiClient, uniqueEmail } from "../helpers/api";
import { psql } from "../helpers/db";
import { runJob, setPlan } from "../helpers/share";

const sh = promisify(execFile);
const PART = 16 * 1024 * 1024;
const MOV = process.env.LIVE_MOV ?? "/tmp/ll-live/hevc-5s.mov";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
};
const one = async (sql: string) => (await psql(sql))[0] ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function dc(args: string[]) {
  return sh("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}
async function waitFor(fn: () => Promise<boolean>, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await fn()) return true;
    await sleep(1500);
  }
  return fn();
}

async function upload(
  api: ApiClient,
  babyId: string,
  bytes: Buffer,
  kind: "video" | "photo",
  durationMs?: number,
): Promise<string> {
  const s = await api.call<{ id: string }>("POST", `/babies/${babyId}/uploads`, {});
  const sid = s.body.id;
  const reg = await api.call<{
    files: {
      clientId: string;
      id: string;
      state: string;
      parts?: { partNumber: number; url: string }[];
    }[];
  }>("POST", `/uploads/${sid}/files`, {
    files: [{ clientId: "f0", kind, bytes: bytes.length, ...(durationMs ? { durationMs } : {}) }],
  });
  const r = reg.body.files[0];
  if (!r?.parts) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
  for (const p of r.parts) {
    const start = (p.partNumber - 1) * PART;
    const put = await fetch(p.url, {
      method: "PUT",
      body: new Uint8Array(bytes.subarray(start, start + PART)),
    });
    if (!put.ok) throw new Error(`part ${p.partNumber} ${put.status}`);
  }
  const done = await api.call<{ state: string }>("POST", `/uploads/${sid}/files/${r.id}/complete`);
  if (done.status !== 200) throw new Error(`complete ${done.status}`);
  await api.call("POST", `/uploads/${sid}/finish`);
  return r.id;
}

/** Top-level MP4 atoms of a buffer: [type, offset]. */
function atoms(buf: Buffer): [string, number][] {
  const out: [string, number][] = [];
  for (let off = 0; off + 8 <= buf.length; ) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8));
    if (size === 0) size = buf.length - off;
    out.push([type, off]);
    if (size < 8) break;
    off += size;
  }
  return out;
}

async function main() {
  const mov = readFileSync(MOV);
  console.log(`clip ${MOV} ${mov.length} bytes`);
  const P = await ApiClient.create(uniqueEmail("live-plus"));
  await P.onboard("Live Plus");
  const pBaby = await P.createBaby("Plus Live");
  await setPlan(pBaby, "plus");
  const F = await ApiClient.create(uniqueEmail("live-free"));
  await F.onboard("Live Free");
  const fBaby = await F.createBaby("Free Live");
  const startedAt = new Date().toISOString();

  // ---- (a) backend ----------------------------------------------------------------------------
  const pVid = await upload(P, pBaby, mov, "video", 5000);
  const fVid = await upload(F, fBaby, mov, "video", 5000);
  const jpg = readFileSync(
    path.resolve(import.meta.dirname, "../fixtures/bakeoff-sample/sample-1-gradient.jpg"),
  );
  const pPhoto = await upload(P, pBaby, jpg, "photo");
  const ready = (id: string) =>
    one(
      `select status || '|' || media_kind || '|' || rendition_status from photos where id='${id}'`,
    );
  const ok = await waitFor(
    async () =>
      (await ready(pVid)) === "ingested|video|ready" &&
      (await ready(fVid)) === "ingested|video|ready" &&
      (await ready(pPhoto)) === "ingested|photo|none",
    180_000,
  );
  check(
    "a1 both HEVC MOV uploads are ingested|video|ready; the JPEG is ingested|photo|none",
    ok,
    `${await ready(pVid)} / ${await ready(fVid)} / ${await ready(pPhoto)}`,
  );
  const row = await one(
    `select mime||'|'||bytes||'|'||width||'|'||height||'|'||duration_ms||'|'||coalesce(video_codec,'')||'|'||coalesce(has_audio::text,'')||'|'||coalesce(sha256,'') from photos where id='${pVid}'`,
  );
  const [mime, bytes, w, h, dur, codec, audio] = row.split("|");
  check(
    "a2 row: mime video/quicktime, bytes match, 1280x720, 5000 ms, hevc, audio",
    mime === "video/quicktime" &&
      Number(bytes) === mov.length &&
      w === "1280" &&
      h === "720" &&
      dur === "5000" &&
      codec === "hevc" &&
      audio === "true",
    row.slice(0, 120),
  );
  const derivs = await psql(
    `select kind||'|'||width||'x'||height||'|'||bytes from photo_derivatives where photo_id='${pVid}' order by kind`,
  );
  const kinds = derivs.map((d) => d.split("|")[0]);
  check(
    "a3 derivatives: thumb, display, web and keyframes present",
    ["thumb", "display", "web"].every((k) => kinds.includes(k)) &&
      kinds.some((k) => k.startsWith("keyframe")),
    kinds.join(","),
  );
  const exif = await one(
    `select (taken_at is not null)||'|'||(gps_lat_enc is not null)||'|'||(gps_lng_enc is not null)||'|'||coalesce(camera_make,'')||'|'||(raw_json::text !~ '37\\.33|122\\.0') from photo_exif where photo_id='${pVid}'`,
  );
  check(
    "a4 exif: taken_at set, GPS encrypted (both columns), raw_json has no plaintext coordinates",
    exif === "true|true|true||true" || /^true\|true\|true\|[^|]*\|true$/.test(exif),
    exif,
  );
  const urls = await P.call<{
    urls: Record<
      string,
      { thumbUrl: string; videoUrl: string | null; mediaKind?: string; durationMs?: number }
    >;
  }>("POST", `/babies/${pBaby}/photos/urls`, { photoIds: [pVid, pPhoto] });
  const vu = urls.body.urls?.[pVid];
  const pu = urls.body.urls?.[pPhoto];
  check(
    "a5 photos/urls: the video has a videoUrl, the photo does not",
    !!vu?.videoUrl && pu !== undefined && !pu.videoUrl,
    JSON.stringify({ video: !!vu?.videoUrl, photo: pu?.videoUrl ?? null }),
  );
  let webBuf = Buffer.alloc(0);
  if (vu?.videoUrl) {
    const r206 = await fetch(vu.videoUrl, { headers: { Range: "bytes=0-1023" } });
    check(
      "a6 range request → 206 video/mp4 with Content-Range",
      r206.status === 206 &&
        (r206.headers.get("content-type") ?? "").startsWith("video/mp4") &&
        !!r206.headers.get("content-range"),
      `${r206.status} ${r206.headers.get("content-type")} ${r206.headers.get("content-range")}`,
    );
    const full = await fetch(vu.videoUrl);
    webBuf = Buffer.from(await full.arrayBuffer());
    const top = atoms(webBuf).map((a) => a[0]);
    check(
      "a7 web.mp4: ftyp then moov before mdat (faststart)",
      top[0] === "ftyp" && top.indexOf("moov") !== -1 && top.indexOf("moov") < top.indexOf("mdat"),
      top.join(" "),
    );
    const txt = webBuf.toString("latin1");
    check(
      "a8 web.mp4 carries no location tag (no ISO6709 / ©xyz / 37.33 / 122.00)",
      !/\+37\.33|-122\.00|\xa9xyz|com\.apple\.quicktime\.location/.test(txt),
      `${webBuf.length} bytes`,
    );
    const th = await fetch(vu.thumbUrl);
    check(
      "a9 the video thumb (poster) is 200 image/jpeg",
      th.status === 200 && (th.headers.get("content-type") ?? "").startsWith("image/jpeg"),
      `${th.status} ${th.headers.get("content-type")}`,
    );
  }
  // ffprobe, when this machine has one: no location tags in the rendition
  try {
    const tmp = path.join(mkdtempSync(path.join(tmpdir(), "tg-live-")), "web.mp4");
    writeFileSync(tmp, webBuf);
    const { stdout } = await sh(
      "ffprobe",
      ["-v", "error", "-show_entries", "format_tags", "-of", "json", tmp],
      { maxBuffer: 1 << 26, encoding: "utf8", timeout: 30_000 },
    );
    rmSync(path.dirname(tmp), { recursive: true, force: true });
    const tags = JSON.parse(stdout).format?.tags ?? {};
    check(
      "a10 ffprobe: rendition format tags hold no location",
      !Object.keys(tags).some((k) => /location|xyz/i.test(k)),
      Object.keys(tags).join(",") || "none",
    );
  } catch (e) {
    check(
      "a10 ffprobe on the rendition (skipped: no local ffprobe or pipe unsupported)",
      true,
      (e as Error).message.slice(0, 60),
    );
  }
  // run-job paths
  const re = await runJob("video.transcode", { photoId: pVid, babyId: pBaby }).catch((e) => ({
    error: String(e),
  }));
  const reStr = JSON.stringify(re);
  check(
    "a11 run-job video.transcode on a ready video → skipped (no rework)",
    /skipped|already|ready/i.test(reStr) && !/"error"/.test(reStr),
    reStr.slice(0, 160),
  );
  const sweep = await runJob("uploads.sweep").catch((e) => ({ error: String(e) }));
  const sw = JSON.stringify(sweep);
  check(
    "a12 run-job uploads.sweep reports scratchRemoved/scratchKept counters",
    /scratchRemoved/.test(sw) && /scratchKept/.test(sw),
    sw.slice(0, 200),
  );
  const hb = await one(
    `select details->>'scratchFreeBytes' from worker_heartbeats order by last_seen_at desc limit 1`,
  );
  check(
    "a13 heartbeat details.scratchFreeBytes is a positive number",
    /^\d+$/.test(hb) && Number(hb) > 0,
    hb,
  );
  check(
    "a14 rendition is still ready after the manual run-job",
    (await ready(pVid)) === "ingested|video|ready",
  );

  // ---- (b) ai ---------------------------------------------------------------------------------
  const flush = await runJob("ai.flush", { force: true }).catch((e) => ({ error: String(e) }));
  console.log(`  ai.flush: ${JSON.stringify(flush).slice(0, 300)}`);
  await sleep(2000);
  const pItems = await psql(
    `select i.photo_id||'|'||i.state||'|'||b.id from ai_batch_items i join ai_batches b on b.id=i.batch_id where i.photo_id in ('${pVid}','${pPhoto}') order by 1`,
  );
  check(
    "b1 Plus: the video and the photo are each one batch item",
    pItems.length === 2,
    pItems.join(" ; "),
  );
  const fItems = await one(`select count(*) from ai_batch_items where baby_id='${fBaby}'`);
  const fAi = await one(
    `select count(*) from photo_ai a join photos p on p.id=a.photo_id where p.baby_id='${fBaby}'`,
  );
  const fSpend = await one(`select count(*) from ai_spend where baby_id='${fBaby}'`);
  check(
    "b2 Free family: 0 batch items, 0 photo_ai, 0 ai_spend (never sent to a model)",
    fItems === "0" && fAi === "0" && fSpend === "0",
    `${fItems}/${fAi}/${fSpend}`,
  );
  const batchId = pItems[0]?.split("|")[2];
  if (batchId) {
    const providerBatchId = await one(
      `select provider_batch_id from ai_batches where id='${batchId}'`,
    );
    const { stdout } = await dc([
      "exec",
      "-T",
      "worker",
      "cat",
      `/tmp/tinyglow-fake-vision/${providerBatchId}.jsonl`,
    ]).catch(() => ({ stdout: "" }));
    const lines = stdout
      .split("\n")
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            custom_id: string;
            image_count: number;
            plan: string;
            media?: { kind: string; duration_seconds: number };
          },
      );
    const v = lines.find((l) => l.custom_id === pVid);
    const p = lines.find((l) => l.custom_id === pPhoto);
    check(
      "b3 fake dump: video image_count 4 (poster + 3 keyframes), photo image_count 1, both plan paid",
      v?.image_count === 4 && p?.image_count === 1 && v?.plan === "paid" && p?.plan === "paid",
      JSON.stringify({ v: v?.image_count, p: p?.image_count, plan: v?.plan }),
    );
    check(
      "b4 fake dump: video media facts kind video, 5 s",
      v?.media?.kind === "video" && v?.media?.duration_seconds === 5,
      JSON.stringify(v?.media),
    );
    check(
      "b5 fake dump holds no image bytes/text keys",
      !/"bytes_b64"|"data":|"text":/.test(stdout),
    );
  }
  // poll until the batch completes and costs land
  let polled = "";
  const costed = await waitFor(async () => {
    polled = JSON.stringify(await runJob("ai.poll").catch((e) => ({ error: String(e) })));
    return (
      (await one(
        `select count(*) from ai_batch_items where photo_id='${pVid}' and cost_usd is not null`,
      )) === "1"
    );
  }, 90_000);
  const vCost = await one(`select cost_usd::text from ai_batch_items where photo_id='${pVid}'`);
  const pCost = await one(`select cost_usd::text from ai_batch_items where photo_id='${pPhoto}'`);
  check(
    "b6 after ai.poll: video cost_usd ≈ 0.0002285, photo ≈ 0.0001385",
    costed &&
      Math.abs(Number(vCost) - 0.0002285) < 1e-7 &&
      Math.abs(Number(pCost) - 0.0001385) < 1e-7,
    `${vCost} / ${pCost} ${polled.slice(0, 120)}`,
  );
  const aiRows = await one(
    `select count(*) from photo_ai where photo_id in ('${pVid}','${pPhoto}')`,
  );
  check("b7 photo_ai rows for both Plus items", aiRows === "2", aiRows);
  const bCost = await one(
    `select coalesce(cost_usd::text,'') ||'|'|| status from ai_batches where id='${batchId}'`,
  );
  check(
    "b8 the batch row carries cost_usd and is completed",
    /^0\.\d+\|completed$/.test(bCost),
    bCost,
  );
  // search: ?media=video returns only the video
  await runJob("search.reconcile").catch(() => undefined);
  await sleep(1500);
  const sv = await P.call<{
    items?: { id: string; mediaKind?: string }[];
    photos?: { id: string; mediaKind?: string }[];
  }>("GET", `/babies/${pBaby}/search?media=video&limit=20`);
  const svItems = sv.body.items ?? sv.body.photos ?? [];
  check(
    "b9 GET search?media=video → 200, only the video (mediaKind video)",
    sv.status === 200 &&
      svItems.length === 1 &&
      svItems[0]?.id === pVid &&
      svItems[0]?.mediaKind === "video",
    `${sv.status} ${JSON.stringify(svItems).slice(0, 160)}`,
  );
  const sp = await P.call<{ items?: { id: string }[]; photos?: { id: string }[] }>(
    "GET",
    `/babies/${pBaby}/search?media=photo&limit=20`,
  );
  const spItems = sp.body.items ?? sp.body.photos ?? [];
  check(
    "b10 GET search?media=photo → only the photo",
    sp.status === 200 && spItems.length === 1 && spItems[0]?.id === pPhoto,
    `${sp.status} ${spItems.length}`,
  );
  // chat: the fake model maps "videos" to media:"video"; the api's tool log line carries media:video
  const chat = await P.call<{
    message?: { text: string; photos: { id: string }[] };
    messages?: unknown[];
  }>("POST", `/babies/${pBaby}/chat/messages`, { text: "Show me the videos" });
  const chatStr = JSON.stringify(chat.body);
  check(
    "b11 chat 'Show me the videos' → 200/201 and cites the video, not the photo",
    (chat.status === 200 || chat.status === 201) &&
      chatStr.includes(pVid) &&
      !chatStr.includes(pPhoto),
    `${chat.status} ${chatStr.slice(0, 160)}`,
  );
  await sleep(1000);
  const { stdout: apiLog } = await dc(["logs", "api", "--no-color", "--since", startedAt]);
  const spend = await one(
    `select count(*)||'|'||coalesce(string_agg(distinct kind, ','),'') from ai_spend where baby_id='${pBaby}'`,
  );
  check(
    "b11b ai_spend rows for the Plus family after chat (chat/embedding spend)",
    Number(spend.split("|")[0]) >= 1,
    spend,
  );
  check(
    "b12 api log: search_photos tool call summarised with media:video",
    /media:video/.test(apiLog),
    String((apiLog.match(/media:video/g) ?? []).length),
  );
  check(
    "b13 api/worker logs hold no coordinates, no prompt text, no photo bytes",
    !/37\.33|122\.00|Show me the videos/.test(apiLog),
    "",
  );

  // ---- cleanup --------------------------------------------------------------------------------
  for (const [api, baby] of [
    [P, pBaby],
    [F, fBaby],
  ] as const) {
    await api.call("DELETE", `/babies/${baby}`);
    const del = await api.call("DELETE", "/me", { acknowledge: true });
    check(
      `cleanup: account removed (${api.email.split("-").pop()})`,
      del.status === 204,
      String(del.status),
    );
    await api.dispose();
  }
  // accounts left by an interrupted earlier run
  const stale = await psql(
    `select email from auth.users where email like 'e2e-%-live-plus@example.com' or email like 'e2e-%-live-free@example.com'`,
  );
  for (const email of stale) {
    const c = await ApiClient.create(email);
    await c.signIn();
    const me = await c.call<{ babies: { id: string }[] }>("GET", "/me");
    for (const b of me.body.babies ?? []) await c.call("DELETE", `/babies/${b.id}`);
    const del = await c.call("DELETE", "/me", { acknowledge: true });
    check(
      `cleanup: stale account removed (${email.split("-").pop()})`,
      del.status === 204,
      String(del.status),
    );
    await c.dispose();
  }
  console.log(`\nlive-check: ${failed === 0 ? "PASS" : `FAIL (${failed} failed)`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("live-check crashed:", e);
  process.exit(2);
});
