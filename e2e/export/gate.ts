/**
 * Data-export gate (docs/plans/review-fixes.md 2.14, 4.3; PRD FR-10.1 "Export all originals + a
 * JSON/CSV of metadata as a ZIP", "Roles and permissions": export data is Admin only).
 *
 *   docker compose -f docker-compose.dev.yml up -d --wait
 *   bash .github/scripts/restart-api.sh      # this gate restarts the api too (OTP throttle)
 *   pnpm e2e:export-gate
 *
 * Keyless, dev stack, fake AI provider (nothing here calls a model). Two parts:
 *
 *  A. A fresh album ("Export Gate"): a fresh admin (requester), a fresh co-admin and a fresh
 *     contributor, three uploaded fixtures (two with EXIF GPS). The requester signs in, requests an
 *     export with locations, a second request at once is 409 export_in_progress, the export is
 *     polled to ready, the email lands in Mailpit without any link, the co-admin sees it but gets
 *     403 not_requester on download, the contributor gets 403 everywhere, the requester downloads
 *     the ZIP, unzips it into its own new empty directory and the gate compares: every original's
 *     sha256 to the database's, photos.csv (3 rows, gps_lat/gps_lng only with location, values
 *     only for the two geotagged photos), photos.json, album.json (no coordinates). A second export
 *     without locations has no gps columns and no coordinate anywhere; a third succeeds, a fourth
 *     is 429 rate_limited. DELETE expires one early, `purge.trash` then removes its object
 *     (every version) and marks it expired. A stale session gets 403 fresh_sign_in_required for
 *     the request and the download.
 *  B. Maya (seeded demo family, plan 4.3): demo-mom exports with locations, demo-dad (co-admin)
 *     sees it and cannot download, demo-nanny (contributor) is refused, and the ZIP holds exactly
 *     the album's exportable photos.
 *
 * Finally the api + worker logs since the start are scanned: no fixture coordinate, no address of
 * the gate's users, no `X-Amz-*`, no JWT, no export object key.
 *
 * `finally` removes every export the gate made, ZIP objects included, deletes its own albums and
 * the audit rows it caused, so Maya's daily quota (3 per rolling 24 h) is back to what it was.
 * Writes e2e/native-results/export-gate.json; exits 1 on any miss.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ApiClient, type Res, uniqueEmail } from "../helpers/api";
import { psql } from "../helpers/db";
import { demoClient, MAYA } from "../helpers/demo";
import { restartApi } from "../helpers/reset";
import { BASE, GPS_COORDS, runJob, uploadPhotos, waitForThumbs } from "../helpers/share";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(ROOT, "e2e/native-results");
const MAILPIT =
  process.env.E2E_MAILPIT_URL ?? `http://localhost:${process.env.MAILPIT_PORT ?? 8025}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check(`${name} (crashed)`, false, e instanceof Error ? e.message : String(e));
  }
}

interface ExportDto {
  id: string;
  status: string;
  isMine: boolean;
  canDownload: boolean;
  includeLocation: boolean;
  photoCount: number | null;
  bytes: number | null;
  error: string | null;
  requestedByName: string | null;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const q = (sql: string) => psql(sql);

async function dc(args: string[]) {
  return sh("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** `mc` inside the storage container with the root credentials, without writing an alias. */
async function mc(args: string): Promise<string> {
  const { stdout } = await dc([
    "exec",
    "-T",
    "storage",
    "sh",
    "-c",
    `MC_HOST_ll="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@localhost:9000" mc ${args}`,
  ]).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
  return stdout;
}
/** Binary stdout of `mc` (object bytes). */
async function mcBuffer(args: string): Promise<Buffer> {
  const { stdout } = await sh(
    "docker",
    [
      "compose",
      "-f",
      "docker-compose.dev.yml",
      "exec",
      "-T",
      "storage",
      "sh",
      "-c",
      `MC_HOST_ll="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@localhost:9000" mc ${args}`,
    ],
    { cwd: ROOT, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  return stdout;
}
let BUCKET = "littlelight-dev";
async function versionLines(prefix: string): Promise<number> {
  const out = await mc(`ls --versions --recursive ll/${BUCKET}/${prefix}`);
  return out.split("\n").filter((l) => l.trim().length > 0).length;
}

async function listExports(api: ApiClient, babyId: string): Promise<Res<{ exports: ExportDto[] }>> {
  return api.call("GET", `/babies/${babyId}/exports`);
}
async function waitReady(api: ApiClient, babyId: string, id: string): Promise<ExportDto> {
  let last: ExportDto | undefined;
  for (const end = Date.now() + 120_000; Date.now() < end; ) {
    last = (await listExports(api, babyId)).body.exports?.find((e) => e.id === id);
    if (last && (last.status === "ready" || last.status === "failed")) return last;
    await sleep(1500);
  }
  throw new Error(`export ${id} not ready in 120 s (last status ${last?.status})`);
}

interface Mail {
  ID: string;
  Subject: string;
}
/** Newest message to `email` whose subject matches, after `seen`. */
async function waitMail(email: string, subject: RegExp, seen: Set<string>) {
  for (const end = Date.now() + 40_000; Date.now() < end; ) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const msgs = ((await r.json()) as { messages?: Mail[] }).messages ?? [];
    for (const m of msgs) {
      if (seen.has(m.ID) || !subject.test(m.Subject)) continue;
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as {
        Text?: string;
        HTML?: string;
        Subject: string;
      };
      return { subject: full.Subject, text: full.Text ?? "", html: full.HTML ?? "" };
    }
    await sleep(800);
  }
  return null;
}
async function mailIds(email: string): Promise<Set<string>> {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  return new Set((((await r.json()) as { messages?: Mail[] }).messages ?? []).map((m) => m.ID));
}

/** Downloads the ZIP of an export through the API and unzips it into a new empty directory. */
async function fetchZip(
  api: ApiClient,
  babyId: string,
  exportId: string,
  work: string,
): Promise<{ dir: string; names: string[]; url: string } | null> {
  const r = await api.call<{ url: string }>(
    "POST",
    `/babies/${babyId}/exports/${exportId}/download-url`,
  );
  if (r.status !== 200) return null;
  const res = await fetch(r.body.url);
  if (!res.ok) throw new Error(`ZIP fetch answered ${res.status}`);
  const zip = path.join(work, `${exportId}.zip`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const dir = path.join(work, `x-${exportId}`);
  mkdirSync(dir);
  await sh("unzip", ["-q", zip, "-d", dir]);
  const names = (await sh("unzip", ["-Z1", zip])).stdout.split("\n").filter(Boolean);
  return { dir, names, url: r.body.url };
}

/** Minimal RFC 4180 parser for the gate's assertions. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && s[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return rows;
}

const exportIdsMade: string[] = [];
const babiesMade: string[] = [];
const emailsUsed: string[] = [];
const signedUrls: string[] = [];
const work = mkdtempSync(path.join(tmpdir(), "ll-export-gate-"));

async function addMember(babyId: string, email: string, role: "admin" | "contributor") {
  await q(
    `insert into baby_members (baby_id, user_id, role) select '${babyId}', id, '${role}' from auth.users where email = '${email}'`,
  );
}

async function partA(): Promise<void> {
  console.log("\n-- A. fresh album: requester, co-admin, contributor, three fixtures --");
  const reqEmail = uniqueEmail("expgate-mom");
  const coEmail = uniqueEmail("expgate-dad");
  const ctEmail = uniqueEmail("expgate-nanny");
  emailsUsed.push(reqEmail, coEmail, ctEmail);
  const mom = await ApiClient.create(reqEmail);
  await mom.onboard("Export Mom");
  const dad = await ApiClient.create(coEmail);
  await dad.onboard("Export Dad");
  const nanny = await ApiClient.create(ctEmail);
  await nanny.onboard("Export Nanny");
  const baby = await mom.createBaby("Export Gate");
  babiesMade.push(baby);
  await addMember(baby, coEmail, "admin");
  await addMember(baby, ctEmail, "contributor");

  const photos = await uploadPhotos(mom, baby, 3, 970_000, { gps: true });
  await waitForThumbs(photos);
  const shaRows = await q(
    `select id || '|' || encode(sha256, 'hex') from photos where baby_id = '${baby}'`,
  );
  const dbSha = new Map(shaRows.map((r) => r.split("|") as [string, string]));
  check("three fixtures uploaded and ingested", photos.length === 3 && dbSha.size === 3);

  // --- request (admin, fresh): 202, then 409 while it is in progress ---
  const seen = await mailIds(reqEmail);
  const first = await mom.call<{ export: ExportDto }>("POST", `/babies/${baby}/exports`, {
    includeLocation: true,
  });
  check(
    "requester: POST exports -> 202 queued, mine, not yet downloadable",
    first.status === 202 &&
      first.body.export?.isMine === true &&
      first.body.export?.canDownload === false &&
      ["queued", "running"].includes(first.body.export?.status),
    `${first.status} ${JSON.stringify(first.body).slice(0, 200)}`,
  );
  const e1 = first.body.export;
  exportIdsMade.push(e1.id);
  const dup = await mom.call<{ error?: string }>("POST", `/babies/${baby}/exports`, {
    includeLocation: true,
  });
  check(
    "a second request while one is queued/running -> 409 export_in_progress",
    dup.status === 409 && dup.body.error === "export_in_progress",
    `${dup.status}`,
  );
  const dupCo = await dad.call<{ error?: string }>("POST", `/babies/${baby}/exports`, {
    includeLocation: false,
  });
  check(
    "the co-admin cannot start another one either (per album) -> 409",
    dupCo.status === 409 && dupCo.body.error === "export_in_progress",
    `${dupCo.status}`,
  );

  // --- contributor: refused everywhere ---
  const ctPost = await nanny.call<{ error?: string }>("POST", `/babies/${baby}/exports`, {
    includeLocation: true,
  });
  const ctGet = await nanny.call("GET", `/babies/${baby}/exports`);
  const ctDl = await nanny.call("POST", `/babies/${baby}/exports/${e1.id}/download-url`);
  check(
    "contributor: POST / GET / download-url -> 403",
    ctPost.status === 403 && ctGet.status === 403 && ctDl.status === 403,
    `${ctPost.status} ${ctGet.status} ${ctDl.status}`,
  );

  // --- ready ---
  const ready = await waitReady(mom, baby, e1.id);
  check(
    "export reaches ready within 120 s with 3 photos and a size",
    ready.status === "ready" &&
      ready.photoCount === 3 &&
      (ready.bytes ?? 0) > 0 &&
      ready.canDownload,
    JSON.stringify(ready),
  );

  // --- email without a link ---
  const mail = await waitMail(reqEmail, /export of Export Gate is ready/i, seen);
  check("the requester got the 'ready' email", mail !== null);
  if (mail) {
    const all = `${mail.subject}\n${mail.text}\n${mail.html}`;
    check(
      "the email carries no link, token or storage key",
      !/https?:\/\/|href=|X-Amz|\.zip|exports\//i.test(all),
      all.match(/https?:\/\/\S{0,40}|href=\S{0,40}/i)?.[0] ?? "",
    );
  }

  // --- co-admin: sees it, cannot download ---
  const coList = (await listExports(dad, baby)).body.exports ?? [];
  const coView = coList.find((e) => e.id === e1.id);
  check(
    "co-admin lists the export: isMine false, canDownload false, requester named",
    !!coView &&
      coView.isMine === false &&
      coView.canDownload === false &&
      coView.requestedByName === "Export Mom",
    JSON.stringify(coView),
  );
  const coDl = await dad.call<{ error?: string }>(
    "POST",
    `/babies/${baby}/exports/${e1.id}/download-url`,
  );
  check(
    "co-admin download-url -> 403 not_requester",
    coDl.status === 403 && coDl.body.error === "not_requester",
    `${coDl.status} ${JSON.stringify(coDl.body)}`,
  );

  // --- the requester downloads, unzips and compares ---
  const z = await fetchZip(mom, baby, e1.id, work);
  check("requester download-url -> ZIP fetched and unzipped", z !== null);
  if (z) {
    signedUrls.push(z.url);
    const u = new URL(z.url);
    check(
      "download URL is a 10-minute attachment of the export ZIP",
      u.searchParams.get("X-Amz-Expires") === "600" &&
        /^attachment/.test(u.searchParams.get("response-content-disposition") ?? "") &&
        u.pathname.endsWith(`/babies/${baby}/exports/${e1.id}.zip`),
      u.search.replace(/X-Amz-Signature=[^&]+/, "X-Amz-Signature=…").slice(0, 200),
    );
    const originals = z.names.filter((n) => n.startsWith("originals/"));
    check(
      "ZIP: 3 originals + photos.csv, photos.json, album.json, milestones.csv, measurements.csv, README.txt",
      originals.length === 3 &&
        [
          "photos.csv",
          "photos.json",
          "album.json",
          "milestones.csv",
          "measurements.csv",
          "README.txt",
        ].every((n) => z.names.includes(n)),
      z.names.join(","),
    );
    let same = true;
    for (const [id, sha] of dbSha) {
      const name = originals.find((n) => n.includes(id));
      same = same && !!name && sha256(readFileSync(path.join(z.dir, name))) === sha;
    }
    check("every original is byte-identical (sha256 equals the stored hash)", same);

    const csv = parseCsv(readFileSync(path.join(z.dir, "photos.csv"), "utf8"));
    const header = csv[0] ?? [];
    const body = csv.slice(1).filter((r) => r.length > 1);
    check(
      "photos.csv: 3 rows, header ends gps_lat,gps_lng",
      body.length === 3 && header.slice(-2).join(",") === "gps_lat,gps_lng",
    );
    const lat = header.indexOf("gps_lat");
    const lng = header.indexOf("gps_lng");
    const withGps = body.filter((r) => (r[lat] ?? "") !== "");
    check(
      "gps_lat/gps_lng filled only for the two geotagged photos, matching the fixtures to 4 decimals",
      withGps.length === 2 &&
        withGps.every(
          (r) =>
            GPS_COORDS.includes(Number(r[lat]).toFixed(4)) &&
            GPS_COORDS.includes(Number(r[lng]).toFixed(4)),
        ),
      withGps.map((r) => `${r[lat]},${r[lng]}`).join(" "),
    );
    const sha = header.indexOf("sha256");
    check(
      "photos.csv sha256 column matches the database",
      body.every((r) => [...dbSha.values()].includes(r[sha] ?? "")),
    );
    const json = JSON.parse(readFileSync(path.join(z.dir, "photos.json"), "utf8")) as {
      exif: { gps: unknown };
    }[];
    check(
      "photos.json: 3 entries, exif.gps present for the two geotagged",
      json.length === 3 && json.filter((j) => j.exif?.gps).length === 2,
    );
    const album = readFileSync(path.join(z.dir, "album.json"), "utf8");
    check(
      "album.json carries no coordinates, emails or user ids",
      !/"lat"|"lng"|latitude|longitude/.test(album) &&
        !album.includes("@") &&
        !/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}.*userId/.test(album),
    );
  }

  // --- second export without locations: no gps columns, no coordinates anywhere ---
  const second = await mom.call<{ export: ExportDto }>("POST", `/babies/${baby}/exports`, {
    includeLocation: false,
  });
  check("second export (no locations) -> 202", second.status === 202, `${second.status}`);
  const e2 = second.body.export;
  exportIdsMade.push(e2.id);
  const r2 = await waitReady(mom, baby, e2.id);
  check("second export reaches ready", r2.status === "ready", JSON.stringify(r2));
  const z2 = await fetchZip(mom, baby, e2.id, work);
  if (z2) {
    signedUrls.push(z2.url);
    const csv2 = readFileSync(path.join(z2.dir, "photos.csv"), "utf8");
    let coordFree = !csv2.includes("gps_");
    for (const f of ["photos.csv", "photos.json", "album.json", "README.txt"]) {
      const t = readFileSync(path.join(z2.dir, f), "utf8");
      coordFree = coordFree && !GPS_COORDS.some((c) => t.includes(c)) && !/"gps"\s*:\s*\{/.test(t);
    }
    check(
      "without include_location: no gps columns and no coordinate in any metadata file",
      coordFree,
    );
  } else check("second export downloadable", false);

  // --- third ok, fourth rate limited ---
  const third = await mom.call<{ export: ExportDto }>("POST", `/babies/${baby}/exports`, {
    includeLocation: false,
  });
  check("third export in 24 h -> 202", third.status === 202, `${third.status}`);
  const e3 = third.body.export;
  if (e3) {
    exportIdsMade.push(e3.id);
    await waitReady(mom, baby, e3.id);
  }
  const fourth = await mom.call<{ error?: string }>("POST", `/babies/${baby}/exports`, {
    includeLocation: false,
  });
  check(
    "fourth export in 24 h -> 429 rate_limited",
    fourth.status === 429 && fourth.body.error === "rate_limited",
    `${fourth.status} ${JSON.stringify(fourth.body)}`,
  );

  // --- DELETE expires early; purge.trash removes the object ---
  const key = `babies/${baby}/exports/${e1.id}.zip`;
  const before = await versionLines(key);
  check("before the purge the ZIP object exists in storage", before >= 1, `${before}`);
  const del = await dad.call("DELETE", `/babies/${baby}/exports/${e1.id}`);
  const afterDel = (await listExports(mom, baby)).body.exports?.find((e) => e.id === e1.id);
  const dl410 = await mom.call<{ error?: string }>(
    "POST",
    `/babies/${baby}/exports/${e1.id}/download-url`,
  );
  check(
    "co-admin DELETE -> 204; the export reads expired and download-url -> 410 export_expired",
    del.status === 204 &&
      afterDel?.status === "expired" &&
      dl410.status === 410 &&
      dl410.body.error === "export_expired",
    `${del.status} ${afterDel?.status} ${dl410.status}`,
  );
  const purge = await runJob("purge.trash");
  const gone = await versionLines(key);
  const [st] = await q(
    `select status || '|' || (purged_at is not null) from data_exports where id = '${e1.id}'`,
  );
  check(
    "purge.trash removes every version of the expired ZIP and marks the row expired/purged",
    gone === 0 && st === "expired|true" && Number(purge.exportsPurged ?? 0) >= 1,
    `${gone} ${st} ${JSON.stringify(purge)}`,
  );
  const other = await versionLines(`babies/${baby}/exports/${e2.id}.zip`);
  check("the still-valid exports were not purged", other >= 1, `${other}`);

  // --- fresh sign-in ---
  await q(
    `update auth.sessions set created_at = now() - interval '30 minutes' where user_id = (select id from auth.users where email = '${reqEmail}')`,
  );
  const stalePost = await mom.call<{ error?: string }>("POST", `/babies/${baby}/exports`, {
    includeLocation: true,
  });
  const staleDl = await mom.call<{ error?: string }>(
    "POST",
    `/babies/${baby}/exports/${e2.id}/download-url`,
  );
  const staleList = await listExports(mom, baby);
  check(
    "stale session: POST / download-url -> 403 fresh_sign_in_required; the list still works",
    stalePost.status === 403 &&
      stalePost.body.error === "fresh_sign_in_required" &&
      staleDl.status === 403 &&
      staleDl.body.error === "fresh_sign_in_required" &&
      staleList.status === 200,
    `${stalePost.status} ${staleDl.status} ${staleList.status}`,
  );

  for (const c of [mom, dad, nanny]) await c.dispose();
}

async function partB(): Promise<void> {
  console.log("\n-- B. Maya (seeded demo family) --");
  const mom = await demoClient("demo-mom");
  const dad = await demoClient("demo-dad");
  const nanny = await demoClient("demo-nanny");
  const [exportable] = await q(
    `select count(*) from photos where baby_id = '${MAYA}' and deleted_at is null and quarantined_at is null
       and status not in ('failed','duplicate') and approval in ('approved','pending')`,
  );
  const seen = await mailIds("demo-mom@littlelight.local");
  const post = await mom.call<{ export: ExportDto }>("POST", `/babies/${MAYA}/exports`, {
    includeLocation: true,
  });
  check(
    "demo-mom: POST exports for Maya -> 202 queued",
    post.status === 202,
    `${post.status} ${JSON.stringify(post.body).slice(0, 160)}`,
  );
  if (post.status !== 202) return;
  const e = post.body.export;
  exportIdsMade.push(e.id);
  const dup = await mom.call<{ error?: string }>("POST", `/babies/${MAYA}/exports`, {
    includeLocation: true,
  });
  check(
    "Maya: a second request at once -> 409 export_in_progress",
    dup.status === 409 && dup.body.error === "export_in_progress",
    `${dup.status}`,
  );
  const nannyPost = await nanny.call("POST", `/babies/${MAYA}/exports`, { includeLocation: true });
  const nannyGet = await nanny.call("GET", `/babies/${MAYA}/exports`);
  check(
    "demo-nanny (contributor): POST and GET -> 403",
    nannyPost.status === 403 && nannyGet.status === 403,
    `${nannyPost.status} ${nannyGet.status}`,
  );
  const ready = await waitReady(mom, MAYA, e.id);
  check(
    `Maya's export is ready with ${exportable} photos`,
    ready.status === "ready" && ready.photoCount === Number(exportable) && ready.canDownload,
    JSON.stringify(ready),
  );
  const mail = await waitMail("demo-mom@littlelight.local", /export of Maya is ready/i, seen);
  check(
    "Mailpit: 'ready' email to demo-mom, no link",
    mail !== null && !/https?:\/\/|href=|X-Amz|\.zip/i.test(`${mail.text}\n${mail.html}`),
  );
  const dadView = (await listExports(dad, MAYA)).body.exports?.find((x) => x.id === e.id);
  const dadDl = await dad.call<{ error?: string }>(
    "POST",
    `/babies/${MAYA}/exports/${e.id}/download-url`,
  );
  check(
    "demo-dad lists it (isMine false, canDownload false) and download-url -> 403 not_requester",
    dadView?.isMine === false &&
      dadView?.canDownload === false &&
      dadDl.status === 403 &&
      dadDl.body.error === "not_requester",
    `${JSON.stringify(dadView)} ${dadDl.status}`,
  );
  const z = await fetchZip(mom, MAYA, e.id, work);
  check("demo-mom downloads Maya's ZIP", z !== null);
  if (z) {
    signedUrls.push(z.url);
    const originals = z.names.filter((n) => n.startsWith("originals/"));
    check(
      `ZIP lists ${exportable} originals`,
      originals.length === Number(exportable),
      `${originals.length}`,
    );
    const csvHead = readFileSync(path.join(z.dir, "photos.csv"), "utf8").split("\r\n")[0] ?? "";
    check("photos.csv header ends gps_lat,gps_lng", csvHead.endsWith("gps_lat,gps_lng"));
    const album = readFileSync(path.join(z.dir, "album.json"), "utf8");
    check('album.json has no "lat"', !album.includes('"lat"'));
    // The demo seed's `sha256` column is a placeholder, not the hash of the demo bytes: compare
    // with the object in storage instead.
    const keys = await q(
      `select id || '|' || storage_key_original from photos where baby_id = '${MAYA}' and deleted_at is null`,
    );
    let ok = true;
    let compared = 0;
    for (const row of keys) {
      const [id, key] = row.split("|") as [string, string];
      const name = originals.find((n) => n.includes(id));
      if (!name) continue;
      const stored = await mcBuffer(`cat ll/${BUCKET}/${key}`);
      compared++;
      ok =
        ok && stored.length > 0 && sha256(stored) === sha256(readFileSync(path.join(z.dir, name)));
    }
    ok = ok && compared === originals.length;
    check(
      "every exported Maya original is byte-identical to the stored object",
      ok,
      `${compared} compared`,
    );
  }
  for (const c of [mom, dad, nanny]) await c.dispose();
}

/** Every export the gate made (and its objects) is removed; quotas and audit rows restored. */
async function cleanup(): Promise<void> {
  console.log("\n-- cleanup --");
  const ids = exportIdsMade.map((i) => `'${i}'`).join(",");
  try {
    if (ids) {
      await q(
        `update data_exports set expires_at = now() - interval '1 minute' where id in (${ids}) and purged_at is null`,
      );
      await runJob("purge.trash").catch(() => ({}));
    }
    for (const b of babiesMade) {
      await mc(`rm --recursive --versions --force ll/${BUCKET}/babies/${b}/`);
    }
    if (ids) {
      await q(`delete from data_exports where id in (${ids})`);
      await q(
        `delete from audit_log where event like 'export.%' and (metadata ->> 'export_id') in (${exportIdsMade.map((i) => `'${i}'`).join(",")})`,
      );
    }
    if (babiesMade.length) {
      const list = babiesMade.map((b) => `'${b}'`).join(",");
      await q(`delete from babies where id in (${list})`);
    }
    const [left] = await q(`select count(*) from data_exports where baby_id = '${MAYA}'`);
    check("cleanup: Maya has no exports left (daily quota restored)", left === "0", `${left}`);
    const objs = await versionLines(`babies/${MAYA}/exports/`);
    check("cleanup: no export object left under Maya", objs === 0, `${objs}`);
  } catch (e) {
    check("cleanup (crashed)", false, e instanceof Error ? e.message : String(e));
  }
}

async function logScan(startedAt: string): Promise<void> {
  console.log("\n-- log scan --");
  const { stdout } = await dc(["logs", "--no-color", "--since", startedAt, "api", "worker"]);
  const hits: string[] = [];
  const must = (name: string, re: RegExp) => {
    if (re.test(stdout)) hits.push(name);
  };
  for (const c of new Set(GPS_COORDS))
    if (stdout.includes(c)) hits.push(`coordinate ${c.length} chars`);
  for (const e of [
    ...emailsUsed,
    "demo-mom@littlelight.local",
    "demo-dad@littlelight.local",
    "demo-nanny@littlelight.local",
  ])
    if (stdout.includes(e)) hits.push("an address of the gate's users");
  for (const url of signedUrls) {
    const sig = new URL(url).searchParams.get("X-Amz-Signature");
    if (sig && stdout.includes(sig)) hits.push("a download signature");
  }
  must("X-Amz parameter", /X-Amz-(Signature|Credential|Security-Token)/i);
  must("JWT", /eyJ[A-Za-z0-9_-]{10,}/);
  must("export object key", /babies\/[0-9a-f-]{36}\/exports\/[0-9a-f-]{36}\.zip/);
  must("coordinate pair", /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/);
  must("lat/lng value", /"(lat|lng|latitude|longitude|gps_lat|gps_lng)"\s*:\s*-?\d/);
  check(
    "api + worker logs: no coordinate, address, signed URL, JWT or export key",
    hits.length === 0,
    hits.join("; "),
  );
  check(
    "the export job ran in the worker log (scan is not vacuous)",
    /export: (ready|started)/.test(stdout),
  );
}

async function main() {
  const startedAt = new Date().toISOString();
  BUCKET = (await dc(["exec", "-T", "api", "printenv", "S3_BUCKET"])).stdout.trim() || BUCKET;
  await restartApi();
  // Maya must start with a clean slate: any export she already has would eat the daily quota.
  const [pre] = await q(`select count(*) from data_exports where baby_id = '${MAYA}'`);
  if (pre !== "0") {
    console.log(`      Maya already has ${pre} export row(s); the gate removes them first`);
    await q(
      `update data_exports set expires_at = now() - interval '1 minute' where baby_id = '${MAYA}' and purged_at is null`,
    );
    await runJob("purge.trash");
    await q(`delete from data_exports where baby_id = '${MAYA}'`);
  }
  try {
    await guarded("part A", partA);
    await guarded("part B", partB);
  } finally {
    await cleanup();
    rmSync(work, { recursive: true, force: true });
  }
  await guarded("log scan", () => logScan(startedAt));

  mkdirSync(OUT_DIR, { recursive: true });
  const failed = results.filter((r) => !r.ok);
  writeFileSync(
    path.join(OUT_DIR, "export-gate.json"),
    `${JSON.stringify({ base: BASE, startedAt, passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`,
  );
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
