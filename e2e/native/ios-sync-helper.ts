/**
 * Helper for the iOS album-sync gate (e2e/native/ios-sync-gate.sh, docs/plans/step-10.md 4.4):
 * the parts of the gate that are API or database work, kept out of bash.
 *
 *   tsx e2e/native/ios-sync-helper.ts prepare          # record Maya's baseline (photos, sources)
 *   tsx e2e/native/ios-sync-helper.ts upload <file> <mime>
 *   tsx e2e/native/ios-sync-helper.ts expected-exif <file>   # "<ISO instant>|<offset minutes>"
 *   tsx e2e/native/ios-sync-helper.ts derivatives-clean <photoId>...   # exit 1 if a derivative has EXIF
 *   tsx e2e/native/ios-sync-helper.ts restore          # delete what the gate imported, restore Maya
 *
 * Dev stack only (assertDevStack). Nothing here calls a model.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import exifr from "exifr";
import { psql } from "../helpers/db";
import { demoClient, MAYA } from "../helpers/demo";
import { assertDevStack, restoreMayaSeedState } from "../helpers/reset";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "e2e/native-results/ios-sync");
const BASELINE = path.join(OUT, "baseline.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Baseline {
  photos: string[];
  sources: string[];
  sessions: string[];
  auditMax: number;
}

async function prepare(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const b: Baseline = {
    photos: await psql(`select id from photos where baby_id = '${MAYA}'`),
    sources: await psql(`select id from import_sources where baby_id = '${MAYA}'`),
    sessions: await psql(`select id from upload_sessions where baby_id = '${MAYA}'`),
    auditMax: Number((await psql("select coalesce(max(id), 0) from audit_log"))[0]),
  };
  writeFileSync(BASELINE, JSON.stringify(b));
  console.log(`baseline: ${b.photos.length} photos, ${b.sources.length} sources`);
}

async function upload(file: string, mime: string): Promise<void> {
  const bytes = readFileSync(file);
  const api = await demoClient("demo-mom");
  try {
    const created = await api.call<{ id: string }>("POST", `/babies/${MAYA}/uploads`, {});
    if (created.status !== 201) throw new Error(`create session answered ${created.status}`);
    const sid = created.body.id;
    const reg = await api.call<{ files: { id: string; parts?: { url: string }[] }[] }>(
      "POST",
      `/uploads/${sid}/files`,
      {
        files: [
          {
            clientId: "ios-sync-pre",
            bytes: bytes.length,
            mime,
            clientSha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      },
    );
    const f = reg.body.files?.[0];
    if (reg.status !== 200 || !f) throw new Error(`register answered ${reg.status}`);
    for (const part of f.parts ?? []) {
      const res = await fetch(part.url, { method: "PUT", body: new Uint8Array(bytes) });
      if (!res.ok) throw new Error(`part PUT answered ${res.status}`);
      await res.arrayBuffer();
    }
    const done = await api.call("POST", `/uploads/${sid}/files/${f.id}/complete`);
    if (done.status !== 200) throw new Error(`complete answered ${done.status}`);
    for (const end = Date.now() + 90_000; Date.now() < end; await sleep(700)) {
      const r = await api.call<{ files: { photo: { id: string } | null }[] }>(
        "GET",
        `/uploads/${sid}`,
      );
      const id = r.body.files?.[0]?.photo?.id;
      if (id) {
        const [st] = await psql(`select status from photos where id = '${id}'`);
        if (st && st !== "uploaded") {
          console.log(id);
          return;
        }
      }
    }
    throw new Error("the upload did not ingest in time");
  } finally {
    await api.dispose();
  }
}

async function expectedExif(file: string): Promise<void> {
  const x = await exifr.parse(readFileSync(file), { tiff: true, exif: true, gps: false });
  const dt = x?.DateTimeOriginal as Date | undefined;
  const off = String(x?.OffsetTimeOriginal ?? "");
  const m = /^([+-])(\d\d):(\d\d)$/.exec(off);
  if (!dt || !m) throw new Error("fixture has no DateTimeOriginal/OffsetTimeOriginal");
  const minutes = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  // exifr reads the wall clock as if it were local time; rebuild the instant from the wall clock fields.
  const wall = Date.UTC(
    dt.getFullYear(),
    dt.getMonth(),
    dt.getDate(),
    dt.getHours(),
    dt.getMinutes(),
    dt.getSeconds(),
  );
  console.log(`${new Date(wall - minutes * 60_000).toISOString()}|${minutes}`);
}

async function derivativesClean(ids: string[]): Promise<void> {
  const api = await demoClient("demo-mom");
  try {
    const r = await api.call<{
      urls: Record<string, { thumbUrl?: string | null; displayUrl?: string | null }>;
    }>("POST", `/babies/${MAYA}/photos/urls`, { photoIds: ids });
    let checked = 0;
    for (const set of Object.values(r.body.urls ?? {})) {
      for (const url of [set.thumbUrl, set.displayUrl]) {
        if (!url) continue;
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        const exif = await exifr
          .parse(buf, { gps: true, tiff: true, exif: true })
          .catch(() => undefined);
        const hasGps = exif && (exif.latitude !== undefined || exif.GPSLatitude !== undefined);
        if (hasGps || buf.includes(Buffer.from("Exif\0\0"))) {
          console.error("a derivative carries EXIF/GPS");
          process.exit(1);
        }
        checked++;
      }
    }
    if (checked === 0) throw new Error("no derivative was fetched");
    console.log(`${checked} derivatives checked`);
  } finally {
    await api.dispose();
  }
}

async function restore(): Promise<void> {
  await assertDevStack();
  const b = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
  const now = await psql(`select id from photos where baby_id = '${MAYA}'`);
  const added = now.filter((x) => !b.photos.includes(x));
  const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");
  if (added.length) {
    await psql(`delete from photos where id in (${list(added)})`);
    const rm = added.map((i) => `originals/${i} derivatives/${i}`).join(" ");
    const bucket = (
      await sh(
        "docker",
        ["compose", "-f", "docker-compose.dev.yml", "exec", "-T", "api", "printenv", "S3_BUCKET"],
        { cwd: ROOT },
      )
    ).stdout.trim();
    await sh(
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
        `cd /data/${bucket}/babies/${MAYA} 2>/dev/null && rm -rf ${rm}`,
      ],
      { cwd: ROOT },
    ).catch(() => undefined);
  }
  await psql(
    `delete from import_sources where baby_id = '${MAYA}'${b.sources.length ? ` and id not in (${list(b.sources)})` : ""}`,
  );
  await psql(
    `delete from upload_sessions where baby_id = '${MAYA}'${b.sessions.length ? ` and id not in (${list(b.sessions)})` : ""}`,
  );
  await psql(
    `delete from audit_log where id > ${b.auditMax} and baby_id = '${MAYA}' and (event like 'import.%' or event like 'upload.%' or event like 'photo.%')`,
  );
  await restoreMayaSeedState();
  console.log(`restored: removed ${added.length} photos`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case "prepare":
      await prepare();
      break;
    case "upload":
      await upload(args[0] ?? "", args[1] ?? "image/heic");
      break;
    case "expected-exif":
      await expectedExif(args[0] ?? "");
      break;
    case "derivatives-clean":
      await derivativesClean(args);
      break;
    case "restore":
      await restore();
      break;
    default:
      console.error(
        "usage: ios-sync-helper.ts prepare|upload|expected-exif|derivatives-clean|restore",
      );
      process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
