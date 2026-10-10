/**
 * Step-4 gate (docs/plans/step-4.md 2.13, 4.1): the PRD check "200-photo bulk upload completes;
 * duplicates skipped; HEIC converts; thumbnails visible within 5 s; GPS absent from served
 * derivatives". Run against the running dev stack:
 *
 *   docker compose -f docker-compose.dev.yml up -d --build --wait
 *   pnpm e2e:upload-gate
 *
 * Generates 200 files in a temp dir (removed on exit): 157 unique JPEGs (150 with EXIF GPS),
 * 8 PNG, 5 WebP, the 5 HEIC fixtures, 3 q60 recompressions of earlier JPEGs (near-duplicates),
 * 20 byte-exact copies (duplicates; half carry `clientSha256`) and 2 text files named `.jpg`.
 * Signs in through the API (OTP from Mailpit), uploads through the real API and presigned MinIO
 * multipart, polls the session, and prints a table. Exits 1 on any miss.
 *
 * Env (defaults in brackets): E2E_BASE_URL [http://localhost:$WEB_PORT|8080],
 * E2E_MAILPIT_URL [http://localhost:$MAILPIT_PORT|8025], S3_ENDPOINT [http://localhost:$STORAGE_PORT|9000],
 * S3_ACCESS_KEY/S3_SECRET_KEY [dev/devdevdev, the MinIO root user], S3_BUCKET [tinyglow-dev].
 * Database and worker checks go through `docker compose -f docker-compose.dev.yml exec`
 * (superuser psql in the db container; `run-job purge.trash` in the worker container).
 * GATE_UPLOAD_RATE [3] files handed to the API per second (PRD target is about 1.7/s);
 * GATE_UPLOAD_CONCURRENCY [4] parallel part PUTs; simulates a slower client; GATE_SKIP_EXIFTOOL=1 skips the exiftool-in-Docker pass over the derivatives.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import exifr from "exifr";
import sharp from "sharp";
import { jpegWithExif } from "../../apps/worker/src/testing/exif-writer";
import { rng, sceneJpeg, scenePng, sceneWebp } from "../../apps/worker/src/testing/images";
import { ApiClient, uniqueEmail } from "../helpers/api";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const HEIC_DIR = path.join(ROOT, "e2e/fixtures/heic");
const DC = ["compose", "-f", "docker-compose.dev.yml"];

const S3_ENDPOINT =
  process.env.S3_ENDPOINT ?? `http://localhost:${process.env.STORAGE_PORT ?? 9000}`;
const S3_BUCKET = process.env.S3_BUCKET ?? "tinyglow-dev";

const WALL_LIMIT_MS = 300_000;
const P95_LIMIT_MS = 5_000;
const N_JPEG_UNIQUE = 157;
const N_JPEG_GPS = 150;
const N_PNG = 8;
const N_WEBP = 5;
const N_NEAR = 3;
const N_DUP = 20;
const N_BAD = 2;
const HEIC_FILES = [
  "plain-640x480.heic",
  "portrait-480x640.heic",
  "gps-640x480.heic",
  "datetime-tz.heic",
  "heif-mif1.heif",
];
const HEIC_WITH_GPS = 1; // gps-640x480.heic

type Kind = "jpeg" | "png" | "webp" | "heic" | "near" | "dup" | "bad";
interface Spec {
  clientId: string;
  name: string;
  kind: Kind;
  file: string;
  bytes: number;
  sha: string;
  mime: string;
  sendSha: boolean;
  gps: boolean;
}
interface RegFile {
  id: string;
  clientId: string | null;
  state: string;
  error: string | null;
  duplicateOfPhotoId: string | null;
  parts?: { partNumber: number; url: string }[];
  photo: {
    id: string;
    mime: string | null;
    thumbUrl: string | null;
    duplicateOfPhotoId: string | null;
  } | null;
}
interface SessionBody {
  summary: {
    registered: number;
    completed: number;
    ingested: number;
    duplicates: number;
    failed: number;
    aborted: number;
  };
  files: RegFile[];
}

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  if (!ok) {
    failures.push(what);
    console.error(`  MISS: ${what}`);
  }
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(n: number, items: T[], fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i] as T, i);
      }
    }),
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
}

/** Run superuser SQL in the db container; returns trimmed stdout (-At). */
async function psql(sql: string): Promise<string> {
  const { stdout } = await sh(
    "docker",
    [...DC, "exec", "-T", "db", "psql", "-U", "postgres", "-d", "tinyglow", "-Atc", sql],
    { cwd: ROOT },
  );
  return stdout.trim();
}

// ---------------------------------------------------------------------------------------------
// 1. Generate the 200 files
// ---------------------------------------------------------------------------------------------

const SIZES: [number, number][] = [
  [1200, 900],
  [1600, 1200],
  [2000, 1500],
  [3000, 2000],
  [1200, 1600],
  [4000, 3000],
];

async function generate(dir: string): Promise<Spec[]> {
  const specs: Spec[] = [];
  const add = (
    kind: Kind,
    name: string,
    buf: Buffer,
    mime: string,
    extra: Partial<Pick<Spec, "sendSha" | "gps">> = {},
  ) => {
    const i = specs.length;
    const file = path.join(dir, `${String(i).padStart(3, "0")}-${name}`);
    writeFileSync(file, buf);
    specs.push({
      clientId: `g${i}`,
      name,
      kind,
      file,
      bytes: buf.length,
      sha: sha256(buf),
      mime,
      sendSha: extra.sendSha ?? true,
      gps: extra.gps ?? false,
    });
  };

  const r = rng(20260614);
  // 157 unique JPEGs: the first 7 have no GPS (near-duplicate sources come from them), then 150 with.
  const jpegs: Buffer[] = [];
  for (let i = 0; i < N_JPEG_UNIQUE; i++) {
    const [w, h] = SIZES[i % 20 === 19 ? 5 : i % 5] as [number, number];
    let buf = await sceneJpeg(w, h, 1000 + i, 85);
    const gps = i >= N_JPEG_UNIQUE - N_JPEG_GPS;
    if (gps) {
      buf = jpegWithExif(buf, {
        make: "GateCam",
        model: "G1",
        dateTimeOriginal: `2026:03:${String(1 + (i % 27)).padStart(2, "0")} 10:${String(i % 60).padStart(2, "0")}:00`,
        gps: { lat: 47 + r(), lng: -122 - r() },
      });
    }
    jpegs.push(buf);
    add("jpeg", `photo-${i}.jpg`, buf, "image/jpeg", { gps });
  }
  for (let i = 0; i < N_PNG; i++) {
    add("png", `shot-${i}.png`, await scenePng(800, 600, 5000 + i), "image/png");
  }
  for (let i = 0; i < N_WEBP; i++) {
    add("webp", `web-${i}.webp`, await sceneWebp(1000, 750, 6000 + i), "image/webp");
  }
  for (const f of HEIC_FILES) {
    const buf = readFileSync(path.join(HEIC_DIR, f));
    add("heic", f, buf, f.endsWith(".heif") ? "image/heif" : "image/heic", {
      gps: f.startsWith("gps"),
    });
  }
  // Near-duplicates: q60 recompression of the first three (no-GPS) JPEGs, sharp strips metadata.
  for (let i = 0; i < N_NEAR; i++) {
    const buf = await sharp(jpegs[i] as Buffer)
      .jpeg({ quality: 60 })
      .toBuffer();
    add("near", `near-${i}.jpg`, buf, "image/jpeg");
  }
  // 20 byte-exact copies of earlier JPEGs (spread over the set); half carry clientSha256.
  for (let i = 0; i < N_DUP; i++) {
    add("dup", `copy-${i}.jpg`, jpegs[3 + i * 7] as Buffer, "image/jpeg", { sendSha: i % 2 === 0 });
  }
  for (let i = 0; i < N_BAD; i++) {
    add("bad", `notes-${i}.jpg`, Buffer.from(`not an image ${i}\n`.repeat(50)), "image/jpeg");
  }
  return specs;
}

// ---------------------------------------------------------------------------------------------
// 2. Main
// ---------------------------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const tmp = mkdtempSync(path.join(tmpdir(), "ll-gate-"));
  const derivDir = path.join(tmp, "derivatives");
  mkdirSync(derivDir);
  try {
    await run(tmp, derivDir, startedAt);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function run(tmp: string, derivDir: string, startedAt: number) {
  console.log("generating files ...");
  const specs = await generate(path.join(tmp));
  const byClient = new Map(specs.map((s) => [s.clientId, s]));
  check(specs.length === 200, `generated ${specs.length} files, expected 200`);

  const email = uniqueEmail("gate");
  const api = await ApiClient.create(email);
  await api.onboard("Gate Parent");
  const babyId = await api.createBaby("Gate Baby");
  const created = await api.call<{ id: string }>("POST", `/babies/${babyId}/uploads`, {});
  if (created.status !== 201) throw new Error(`create session answered ${created.status}`);
  const sessionId = created.body.id;
  console.log(`baby ${babyId} session ${sessionId}`);

  const t0 = new Map<string, number>(); // fileId -> complete response time
  const t1 = new Map<string, number>(); // thumbUrl seen in the session
  const t2 = new Map<string, number>(); // GET thumbUrl returned 200
  const fileIdOf = new Map<string, string>(); // clientId -> file id
  const registered: RegFile[] = [];
  const pendingFetches: Promise<void>[] = [];

  // Poller: every 250 ms until stopped.
  let stopPoll = false;
  let last: SessionBody | null = null;
  const poller = (async () => {
    while (!stopPoll) {
      const r = await api.call<SessionBody>("GET", `/uploads/${sessionId}`);
      if (r.status === 200) {
        last = r.body;
        const now = Date.now();
        for (const f of r.body.files) {
          const url = f.photo?.thumbUrl;
          if (url && !t1.has(f.id)) {
            t1.set(f.id, now);
            pendingFetches.push(
              fetch(url).then(async (res) => {
                await res.arrayBuffer();
                if (res.ok) t2.set(f.id, Date.now());
              }),
            );
          }
        }
      }
      await sleep(250);
    }
  })();

  const registerBatch = async (batch: Spec[]) => {
    const r = await api.call<{ files: RegFile[] }>("POST", `/uploads/${sessionId}/files`, {
      files: batch.map((s) => ({
        clientId: s.clientId,
        bytes: s.bytes,
        mime: s.mime,
        ...(s.sendSha ? { clientSha256: s.sha } : {}),
      })),
    });
    if (r.status !== 200) throw new Error(`register answered ${r.status}`);
    for (const f of r.body.files) {
      registered.push(f);
      if (f.clientId) fileIdOf.set(f.clientId, f.id);
    }
    return r.body.files;
  };

  // Pace hand-offs to a realistic client: one file starts every 1000 / UPLOAD_RATE ms (the PRD
  // target is 500 photos in 5 min, about 1.7/s). Parallel part PUTs still overlap within that.
  const UPLOAD_RATE = Number(process.env.GATE_UPLOAD_RATE ?? 3);
  let nextSlot = Date.now();
  const takeSlot = async () => {
    const at = nextSlot;
    nextSlot = Math.max(nextSlot, Date.now()) + 1000 / UPLOAD_RATE;
    const wait = at - Date.now();
    if (wait > 0) await sleep(wait);
  };
  const uploadAndComplete = async (f: RegFile) => {
    if (f.state !== "registered") return; // duplicate/failed at register time: nothing to upload
    await takeSlot();
    const spec = byClient.get(f.clientId ?? "") as Spec;
    const body = readFileSync(spec.file);
    for (const part of f.parts ?? []) {
      const res = await fetch(part.url, { method: "PUT", body: new Uint8Array(body) });
      check(res.ok, `part PUT for ${spec.name} answered ${res.status}`);
      await res.arrayBuffer();
    }
    const c = await api.call<RegFile>("POST", `/uploads/${sessionId}/files/${f.id}/complete`);
    check(c.status === 200, `complete ${spec.name} answered ${c.status}`);
    t0.set(f.id, Date.now());
  };

  console.log("uploading ...");
  const uploadStart = Date.now();
  for (let i = 0; i < specs.length; i += 100) {
    const files = await registerBatch(specs.slice(i, i + 100));
    await pool(Number(process.env.GATE_UPLOAD_CONCURRENCY ?? 4), files, uploadAndComplete);
  }
  console.log(
    `uploads sent in ${((Date.now() - uploadStart) / 1000).toFixed(1)} s; waiting for ingest ...`,
  );

  // Wait until every file is terminal.
  const deadline = startedAt + WALL_LIMIT_MS + 60_000;
  for (;;) {
    const s = (last as SessionBody | null)?.summary;
    if (s && s.registered === 0 && s.completed === 0) break;
    if (Date.now() > deadline) {
      check(false, `ingest did not finish in time (${JSON.stringify(s)})`);
      break;
    }
    await sleep(250);
  }
  const wallMs = Date.now() - startedAt;
  stopPoll = true;
  await poller;
  await Promise.all(pendingFetches);

  const finalRes = await api.call<SessionBody>("GET", `/uploads/${sessionId}`);
  const session = finalRes.body;
  const s = session.summary;

  // ---- counts
  check(s.ingested === 178, `ingested ${s.ingested}, expected 178`);
  check(s.failed === 2, `failed ${s.failed}, expected 2`);
  check(s.duplicates === 20, `duplicates ${s.duplicates}, expected 20`);
  check(s.aborted === 0, `aborted ${s.aborted}, expected 0`);
  check(wallMs < WALL_LIMIT_MS, `wall time ${wallMs} ms >= ${WALL_LIMIT_MS} ms`);

  const failed = session.files.filter((f) => f.state === "failed");
  for (const f of failed) {
    check(
      f.error === "unsupported_media_type",
      `failed file error ${f.error}, expected unsupported_media_type`,
    );
    check(byClient.get(f.clientId ?? "")?.kind === "bad", `unexpected failed file ${f.clientId}`);
  }
  const dupFiles = session.files.filter((f) => f.state === "duplicate");
  for (const f of dupFiles) {
    check(byClient.get(f.clientId ?? "")?.kind === "dup", `unexpected duplicate ${f.clientId}`);
  }

  // ---- near-duplicates are kept, flagged
  const nearFlagged = session.files.filter(
    (f) => byClient.get(f.clientId ?? "")?.kind === "near" && f.state === "ingested",
  );
  const nearWithRef = nearFlagged.filter((f) => f.photo?.duplicateOfPhotoId);
  check(
    nearFlagged.length === N_NEAR,
    `${nearFlagged.length} near-duplicates ingested, expected ${N_NEAR}`,
  );
  check(
    nearWithRef.length === N_NEAR,
    `${nearWithRef.length} near-duplicates flagged, expected ${N_NEAR}`,
  );
  const allFlagged = session.files.filter(
    (f) => f.state === "ingested" && f.photo?.duplicateOfPhotoId,
  );
  // The five HEIC fixtures share one synthetic layout (only the hue differs), so pHash may flag
  // some of them against each other: informational. Any other stray flag is a miss.
  const strayHeic = allFlagged.filter((f) => byClient.get(f.clientId ?? "")?.kind === "heic");
  const strayOther = allFlagged.filter((f) => {
    const k = byClient.get(f.clientId ?? "")?.kind;
    return k !== "heic" && k !== "near";
  });
  check(
    strayOther.length === 0,
    `${strayOther.length} unrelated photos flagged as near-duplicates`,
  );
  const strayFlagged = `${strayHeic.length} HEIC fixtures, ${strayOther.length} others`;

  // ---- HEIC converts: mime recorded, JPEG derivatives
  const ingested = session.files.filter((f) => f.state === "ingested" && f.photo);
  const heicFiles = ingested.filter((f) => byClient.get(f.clientId ?? "")?.kind === "heic");
  check(
    heicFiles.length === HEIC_FILES.length,
    `${heicFiles.length} HEIC ingested, expected ${HEIC_FILES.length}`,
  );
  let heicJpeg = 0;

  // ---- latency
  const lat: number[] = [];
  for (const f of ingested) {
    const a = t0.get(f.id);
    const b = t2.get(f.id);
    if (a === undefined || b === undefined) {
      check(false, `no thumbnail latency for ${f.clientId}`);
      continue;
    }
    lat.push(Math.max(0, b - a));
  }
  lat.sort((x, y) => x - y);
  const p50 = percentile(lat, 0.5);
  const p95 = percentile(lat, 0.95);
  const max = lat[lat.length - 1] ?? Number.NaN;
  check(p95 < P95_LIMIT_MS, `thumb latency p95 ${Math.round(p95)} ms >= ${P95_LIMIT_MS} ms`);

  // ---- the album lists the 178 photos
  const list = await api.call<{ photos: unknown[] }>("GET", `/babies/${babyId}/photos?limit=200`);
  check(
    list.status === 200 && list.body.photos.length === 178,
    `album lists ${list.body.photos?.length} photos, expected 178`,
  );

  // ---- no EXIF/GPS in any served derivative
  console.log("checking served derivatives ...");
  let cleanDerivs = 0;
  let totalDerivs = 0;
  await pool(8, ingested, async (f) => {
    const photoId = (f.photo as NonNullable<RegFile["photo"]>).id;
    const detail = await api.call<{
      thumbUrl: string | null;
      displayUrl: string | null;
      mime: string | null;
    }>("GET", `/photos/${photoId}`);
    const isHeic = byClient.get(f.clientId ?? "")?.kind === "heic";
    if (isHeic)
      check(
        detail.body.mime === "image/heic" || detail.body.mime === "image/heif",
        `HEIC mime ${detail.body.mime}`,
      );
    let heicBothJpeg = true;
    for (const [kind, url] of [
      ["thumb", detail.body.thumbUrl],
      ["display", detail.body.displayUrl],
    ] as const) {
      totalDerivs++;
      if (!url) {
        check(false, `photo ${photoId} has no ${kind} URL`);
        heicBothJpeg = false;
        continue;
      }
      check(!url.includes("analysis"), `${kind} URL names the analysis key`);
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        check(false, `GET ${kind} of ${photoId} answered ${res.status}`);
        heicBothJpeg = false;
        continue;
      }
      writeFileSync(path.join(derivDir, `${photoId}-${kind}.jpg`), buf);
      const jpegMagic = buf[0] === 0xff && buf[1] === 0xd8;
      if (!jpegMagic) heicBothJpeg = false;
      const meta = await sharp(buf).metadata();
      const parsed = (await exifr.parse(buf, true).catch(() => undefined)) as
        | Record<string, unknown>
        | undefined;
      const gps = await exifr.gps(buf).catch(() => undefined);
      const raw = buf.toString("latin1");
      const clean =
        jpegMagic &&
        !meta.exif &&
        !meta.xmp &&
        !meta.icc &&
        gps === undefined &&
        !(parsed && ("latitude" in parsed || "GPSLatitude" in parsed)) &&
        !raw.includes("Exif\0\0") &&
        !raw.includes("http://ns.adobe.com/xap") &&
        !raw.includes("ICC_PROFILE");
      if (clean) cleanDerivs++;
      else check(false, `${kind} derivative of ${photoId} is not metadata-free JPEG`);
    }
    if (isHeic && heicBothJpeg) heicJpeg++;
  });
  check(
    heicJpeg === HEIC_FILES.length,
    `${heicJpeg}/${HEIC_FILES.length} HEIC photos have JPEG derivatives`,
  );
  check(totalDerivs === 356, `fetched ${totalDerivs} derivatives, expected 356`);

  if (process.env.GATE_SKIP_EXIFTOOL !== "1") {
    // exiftool in Docker over everything we downloaded: lists any file with GPS/camera/ICC/XMP.
    try {
      const { stdout } = await sh(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${derivDir}:/w:ro`,
          "-w",
          "/w",
          "alpine:3.22",
          "sh",
          "-c",
          "apk add --no-cache exiftool >/dev/null && exiftool -r -q -q -if '$GPSLatitude or $GPSPosition or $Make or $Model or $DateTimeOriginal or $ProfileDescription or $XMPToolkit' -p '$FileName' .; rc=$?; [ $rc -eq 0 ] || [ $rc -eq 2 ]",
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      check(
        stdout.trim() === "",
        `exiftool found metadata in: ${stdout.trim().split("\n").slice(0, 5).join(", ")}`,
      );
    } catch (e) {
      check(false, `exiftool pass failed to run: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  // ---- originals untouched (5 samples)
  const samples = ingested
    .filter((f) =>
      ["jpeg", "heic", "png", "webp"].includes(byClient.get(f.clientId ?? "")?.kind ?? ""),
    )
    .slice(0, 2);
  for (const k of ["png", "webp", "heic"]) {
    const f = ingested.find((x) => byClient.get(x.clientId ?? "")?.kind === k);
    if (f) samples.push(f);
  }
  for (const f of samples.slice(0, 5)) {
    const photoId = (f.photo as NonNullable<RegFile["photo"]>).id;
    const o = await api.call<{ url: string }>("GET", `/photos/${photoId}/original`);
    check(o.status === 200, `original of ${photoId} answered ${o.status}`);
    if (o.status !== 200) continue;
    const buf = Buffer.from(await (await fetch(o.body.url)).arrayBuffer());
    check(
      sha256(buf) === byClient.get(f.clientId ?? "")?.sha,
      `original of ${f.clientId} differs from the uploaded bytes`,
    );
  }

  // ---- database checks (superuser)
  const gpsRows = Number(
    await psql(
      `SELECT count(*) FROM photo_exif e JOIN photos p ON p.id = e.photo_id WHERE p.baby_id = '${babyId}' AND e.gps_lat_enc IS NOT NULL AND e.gps_lng_enc IS NOT NULL`,
    ),
  );
  const expectedGps = N_JPEG_GPS + HEIC_WITH_GPS;
  check(gpsRows === expectedGps, `gps_rows ${gpsRows}, expected ${expectedGps}`);
  const gpsInJson = Number(
    await psql(
      `SELECT count(*) FROM photo_exif e JOIN photos p ON p.id = e.photo_id WHERE p.baby_id = '${babyId}' AND e.raw_json::text ~* '(gps|latitude|longitude)'`,
    ),
  );
  check(gpsInJson === 0, `${gpsInJson} photo_exif.raw_json rows mention GPS`);
  const dupRows = Number(
    await psql(`SELECT count(*) FROM photos WHERE baby_id = '${babyId}' AND status = 'duplicate'`),
  );
  check(dupRows === 0, `${dupRows} photos rows with status 'duplicate' remain`);
  const photoRows = Number(
    await psql(`SELECT count(*) FROM photos WHERE baby_id = '${babyId}' AND status = 'ingested'`),
  );
  check(photoRows === 178, `${photoRows} ingested photos rows, expected 178`);

  // ---- purge.trash: 3 photos trashed, back-dated, purged with every object version
  const victims = ingested
    .filter((f) => byClient.get(f.clientId ?? "")?.kind === "jpeg")
    .slice(-3)
    .map((f) => (f.photo as NonNullable<RegFile["photo"]>).id);
  const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? "dev",
      secretAccessKey: process.env.S3_SECRET_KEY ?? "devdevdev",
    },
  });
  const countVersions = async (ids: string[]): Promise<number> => {
    let n = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const r = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: S3_BUCKET,
          Prefix: `babies/${babyId}/`,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      );
      for (const v of [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])]) {
        if (ids.some((id) => v.Key?.includes(id))) n++;
      }
      if (!r.IsTruncated) return n;
      keyMarker = r.NextKeyMarker;
      versionMarker = r.NextVersionIdMarker;
    }
  };
  const versionsBefore = await countVersions(victims);
  check(
    versionsBefore >= victims.length * 4,
    `only ${versionsBefore} object versions before purge (expected original + 3 derivatives each)`,
  );
  for (const id of victims) {
    const d = await api.call("DELETE", `/photos/${id}`);
    check(d.status === 204, `trash ${id} answered ${d.status}`);
  }
  const idList = victims.map((id) => `'${id}'`).join(",");
  await psql(`UPDATE photos SET deleted_at = now() - interval '31 days' WHERE id IN (${idList})`);
  const job = await sh(
    "docker",
    [
      ...DC,
      "exec",
      "-T",
      "worker",
      "pnpm",
      "--silent",
      "--filter",
      "@tinyglow/worker",
      "run-job",
      "purge.trash",
    ],
    { cwd: ROOT },
  );
  const rowsAfter = Number(await psql(`SELECT count(*) FROM photos WHERE id IN (${idList})`));
  const versionsAfter = await countVersions(victims);
  check(
    rowsAfter === 0,
    `${rowsAfter} purged photo rows remain (job output: ${job.stdout.trim().slice(0, 200)})`,
  );
  check(versionsAfter === 0, `${versionsAfter} object versions remain after purge`);

  // ---- table
  const rows: [string, string][] = [
    ["ingested", `${s.ingested}`],
    ["failed", `${s.failed}`],
    ["duplicates", `${s.duplicates}`],
    ["near_duplicates", `${nearWithRef.length} (other flags: ${strayFlagged})`],
    ["heic", `${heicJpeg} (jpeg derivatives)`],
    [
      "thumb_latency p50/p95/max",
      `${Math.round(p50)} / ${Math.round(p95)} / ${Math.round(max)} ms (limit p95 < ${P95_LIMIT_MS})`,
    ],
    ["wall", `${(wallMs / 1000).toFixed(1)} s (limit < ${WALL_LIMIT_MS / 1000})`],
    ["derivatives_without_exif", `${cleanDerivs}/${totalDerivs}`],
    ["gps_rows", `${gpsRows} (expected ${expectedGps})`],
    [
      "purge",
      `${victims.length} photos -> ${rowsAfter} rows, ${versionsAfter} object versions (before: ${versionsBefore})`,
    ],
  ];
  console.log(
    `\nUPLOAD GATE (upload rate ${UPLOAD_RATE}/s, concurrency ${process.env.GATE_UPLOAD_CONCURRENCY ?? 4})`,
  );
  for (const [k, v] of rows) console.log(`  ${k.padEnd(26)} ${v}`);
  await api.dispose();

  if (failures.length > 0) {
    console.error(`\nGATE FAILED (${failures.length} miss${failures.length === 1 ? "" : "es"})`);
    process.exit(1);
  }
  console.log("\nGATE PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Keep an unused import honest for the `randomUUID` helper used by future cases.
void randomUUID;
