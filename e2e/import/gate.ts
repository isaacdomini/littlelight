/**
 * Photo-import gate, Google Photos part (docs/plans/step-10.md 4.3, 10.13; PRD FR-2.1-2.7,
 * "Roles and permissions", "Privacy and child safety"). Dev stack, fake AI provider, fake Google
 * (`google-fake`, host port 18099 or GOOGLE_FAKE_PORT). Nothing here needs a credential.
 *
 *   docker compose -f docker-compose.dev.yml up -d --wait
 *   bash .github/scripts/restart-api.sh       # this gate restarts the api too (OTP throttle)
 *   pnpm e2e:import-gate
 *
 * Walkthrough (plan 4.3, steps 1-10), as Maya's parents:
 *  1. connection => available, not connected; connect => the fake's consent URL (Picker scope,
 *     offline access, our callback)
 *  2. Allow in a real browser => connected page => connected; the refresh token is stored
 *     encrypted and the user role cannot read it
 *  3. one photo (G-3) is uploaded first, so the import sees a duplicate
 *  4. create a batch (pickerUri, once); a second one at once is 409 import_in_progress
 *  5. pick G-1..G-6, V-1, X-1 in the fake picker => queued => done: 5 imported, 1 duplicate,
 *     1 skipped (video), 1 failed (oversize)
 *  6. the five photos are approved by their requester, ingested, carry the capture date and
 *     camera, no GPS; exactly five new original objects exist
 *  7. the nanny (contributor) imports two more: pending, no approver, in the approval queue;
 *     mom approves one and becomes its approver
 *  8. cancel => cancelled, exactly one Google session DELETE; Deny => `status=denied`; Google
 *     revoking everything => 409 google_reconnect and needsReconnect, a new connect clears it
 *  9. disconnect => 204, the token was revoked at Google; a contributor's Apple-sync upsert is
 *     403 forbidden
 * 10. api + worker + google-fake logs hold no token, code, media URL, picker URL, signature, JWT
 *     or address; no push delivery and no audit row carries a secret.
 *
 * `finally` removes what the run made (imported photos with their objects, batches, upload
 * sessions, connections, audit rows), resets the fake and restores Maya's seed state, so her
 * 20-per-day import budget is back where it was. Writes e2e/import-gate/results.json; exits 1 on
 * any miss.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { type Browser, chromium } from "@playwright/test";
import type { ApiClient, Res } from "../helpers/api";
import { psql } from "../helpers/db";
import { demoClient, MAYA } from "../helpers/demo";
import { assertDevStack, restartApi, restoreMayaSeedState } from "../helpers/reset";
import { BASE } from "../helpers/share";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(ROOT, "e2e/import-gate");
const G = `http://localhost:${process.env.GOOGLE_FAKE_PORT ?? 18099}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (sql: string) => psql(sql);

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

interface Batch {
  id: string;
  status: string;
  error: string | null;
  itemsTotal: number | null;
  itemsImported: number;
  itemsDuplicate: number;
  itemsFailed: number;
  itemsSkipped: number;
}
interface Connection {
  available: boolean;
  connected: boolean;
  connectedAt: string | null;
  needsReconnect: boolean;
}

async function dc(args: string[]) {
  return sh("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
}
let BUCKET = "littlelight-dev";
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
/** Live object versions under a prefix (one line each). */
async function objectLines(prefix: string): Promise<number> {
  const out = await mc(`ls --versions --recursive ll/${BUCKET}/${prefix}`);
  return out.split("\n").filter((l) => l.trim().length > 0).length;
}

async function fake<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`${G}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return (text ? JSON.parse(text) : null) as T;
}
const fakeRequests = () => fake<{ method: string; path: string }[]>("GET", "/__fake/requests");

async function connection(api: ApiClient): Promise<Connection> {
  return (await api.call<Connection>("GET", "/me/import/google/connection")).body;
}

/** The nanny/mom browser: consent page clicks and the connected page. */
async function consent(
  browser: Browser,
  api: ApiClient,
  url: string,
  button: "Allow" | "Deny",
  expectStatus: string,
): Promise<string> {
  const ctx = await browser.newContext({ baseURL: BASE, storageState: await api.storageState() });
  try {
    const page = await ctx.newPage();
    // The connected page sends the user back after a moment; read where it lands first.
    const landed = page.waitForURL(/\/import\/google\/connected\?/, { timeout: 30_000 });
    await page.goto(url);
    await page.getByRole("button", { name: button, exact: true }).click();
    await landed;
    const u = new URL(page.url());
    if (u.searchParams.get("status") !== expectStatus) {
      throw new Error(`connected page said status=${u.searchParams.get("status")}`);
    }
    return u.search;
  } finally {
    await ctx.close();
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Upload one file through the real upload pipeline (session, register, PUT, complete). */
async function uploadBytes(
  api: ApiClient,
  babyId: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  const created = await api.call<{ id: string }>("POST", `/babies/${babyId}/uploads`, {});
  if (created.status !== 201) throw new Error(`create session answered ${created.status}`);
  const sid = created.body.id;
  const reg = await api.call<{ files: { id: string; parts?: { url: string }[] }[] }>(
    "POST",
    `/uploads/${sid}/files`,
    { files: [{ clientId: "gate-g3", bytes: bytes.length, mime, clientSha256: sha256(bytes) }] },
  );
  if (reg.status !== 200) throw new Error(`register answered ${reg.status}`);
  const f = reg.body.files[0];
  if (!f) throw new Error("no file registered");
  for (const part of f.parts ?? []) {
    const res = await fetch(part.url, { method: "PUT", body: new Uint8Array(bytes) });
    if (!res.ok) throw new Error(`part PUT answered ${res.status}`);
    await res.arrayBuffer();
  }
  const done = await api.call("POST", `/uploads/${sid}/files/${f.id}/complete`);
  if (done.status !== 200) throw new Error(`complete answered ${done.status}`);
  for (const end = Date.now() + 90_000; Date.now() < end; await sleep(700)) {
    const r = await api.call<{ files: { id: string; photo: { id: string } | null }[] }>(
      "GET",
      `/uploads/${sid}`,
    );
    const photo = r.body.files?.[0]?.photo;
    if (photo) {
      for (const e2 = Date.now() + 90_000; Date.now() < e2; await sleep(700)) {
        const [st] = await q(`select status from photos where id = '${photo.id}'`);
        if (st && st !== "uploaded") return photo.id;
      }
    }
  }
  throw new Error("the upload did not ingest in time");
}

async function pollBatch(api: ApiClient, id: string, until: (b: Batch) => boolean, ms = 90_000) {
  let last: Batch | undefined;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) {
    const r = await api.call<{ batch: Batch }>("GET", `/imports/${id}`);
    last = r.body.batch;
    if (last && until(last)) return last;
  }
  throw new Error(`batch ${id} did not reach the expected state (last: ${last?.status})`);
}

// --- state to restore ------------------------------------------------------------------------
let startedAt = "";
let photosBefore = new Set<string>();
let batchesBefore = new Set<string>();
let pushBefore = 0;
let auditBefore = 0;

async function main() {
  await assertDevStack();
  BUCKET = (await dc(["exec", "-T", "api", "printenv", "S3_BUCKET"])).stdout.trim() || BUCKET;
  const provider = (
    await dc(["exec", "-T", "api", "printenv", "GOOGLE_IMPORT_PROVIDER"])
  ).stdout.trim();
  if (provider !== "fake")
    throw new Error(`the api runs GOOGLE_IMPORT_PROVIDER=${provider}, not fake`);
  const health = await fake<{ status: string }>("GET", "/healthz");
  if (health?.status !== "ok") throw new Error(`google-fake is not healthy on ${G}`);
  await restartApi();
  startedAt =
    (await q("select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"))[0] ??
    "";
  photosBefore = new Set(await q(`select id from photos where baby_id = '${MAYA}'`));
  batchesBefore = new Set(await q(`select id from import_batches where baby_id = '${MAYA}'`));
  pushBefore = Number((await q("select count(*) from push_deliveries"))[0]);
  auditBefore = Number((await q("select coalesce(max(id), 0) from audit_log"))[0]);
  await fake("POST", "/__fake/reset");
  await fake("POST", "/__fake/consent", { decision: "ask" });
  // A leftover connection of an earlier run would hide step 1.
  await q(
    "delete from google_accounts where user_id in (select id from auth.users where email in ('demo-mom@littlelight.local','demo-nanny@littlelight.local'))",
  );

  const mom = await demoClient("demo-mom");
  const nanny = await demoClient("demo-nanny");
  const browser = await chromium.launch();
  try {
    await guarded("walkthrough", () => walkthrough(mom, nanny, browser));
  } finally {
    await browser.close();
    await cleanup();
  }
  await guarded("log scan", logScan);

  mkdirSync(OUT_DIR, { recursive: true });
  const failed = results.filter((r) => !r.ok);
  writeFileSync(
    path.join(OUT_DIR, "results.json"),
    `${JSON.stringify({ base: BASE, fake: G, startedAt, passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`,
  );
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await mom.dispose();
  await nanny.dispose();
  if (failed.length) process.exit(1);
}

async function walkthrough(mom: ApiClient, nanny: ApiClient, browser: Browser) {
  const momId =
    (await q("select id from auth.users where email = 'demo-mom@littlelight.local'"))[0] ?? "";
  const nannyId =
    (await q("select id from auth.users where email = 'demo-nanny@littlelight.local'"))[0] ?? "";

  // ---- 1. connection and consent URL --------------------------------------------------------
  const c0 = await connection(mom);
  check(
    "1. mom: available, not connected, no reconnect needed",
    c0.available === true && c0.connected === false && c0.needsReconnect === false,
    JSON.stringify(c0),
  );
  const start = await mom.call<{ url: string }>("POST", "/me/import/google/connect", {
    client: "web",
  });
  const url = new URL(start.body.url ?? "http://invalid.test");
  check(
    "1. connect returns the fake's consent URL: picker scope, offline, our callback, a state",
    start.status === 200 &&
      start.body.url.startsWith(`${G}/o/oauth2/v2/auth?`) &&
      url.searchParams.get("scope")?.endsWith("photospicker.mediaitems.readonly") === true &&
      url.searchParams.get("access_type") === "offline" &&
      url.searchParams.get("redirect_uri") === `${BASE}/api/import/google/callback` &&
      (url.searchParams.get("state") ?? "").split(".").length === 3,
    start.body.url?.replace(/state=[^&]+/, "state=…"),
  );

  // ---- 2. Allow ------------------------------------------------------------------------------
  const search = await consent(browser, mom, start.body.url, "Allow", "ok");
  check(
    "2. Allow lands on /import/google/connected?status=ok&client=web",
    /status=ok/.test(search) && /client=web/.test(search),
    search,
  );
  const c1 = await connection(mom);
  check(
    "2. connection: connected",
    c1.connected === true && c1.needsReconnect === false,
    JSON.stringify(c1),
  );
  const [row] = await q(
    `select (octet_length(refresh_token_enc) > 0)::text || '|' || scope from google_accounts where user_id = '${momId}'`,
  );
  check(
    "2. refresh token stored (ciphertext) with the picker scope only",
    /^true\|.*photospicker\.mediaitems\.readonly$/.test(row ?? "") && !(row ?? "").includes(" "),
    row,
  );
  let denied = "";
  try {
    await q(
      `begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${momId}","role":"authenticated"}', true); select refresh_token_enc from google_accounts;`,
    );
  } catch (e) {
    denied = String((e as { stderr?: string }).stderr ?? e);
  }
  check(
    "2. as mom's claims, refresh_token_enc is permission denied",
    /permission denied/i.test(denied),
    denied.slice(0, 120),
  );
  const [plain] = await q(
    `select position(convert_to('fake-refresh', 'LATIN1') in refresh_token_enc) from google_accounts where user_id = '${momId}'`,
  );
  check("2. the stored bytes do not contain the token", plain === "0", plain);

  // ---- 3. a duplicate to meet --------------------------------------------------------------
  const g3 = Buffer.from(await (await fetch(`${G}/__fake/items/G-3`)).arrayBuffer());
  await uploadBytes(mom, MAYA, g3, "image/jpeg");
  check("3. G-3 uploaded through the upload pipeline (so the import finds a duplicate)", true);
  const originalsBefore = await objectLines(`babies/${MAYA}/originals/`);

  // ---- 4. create + second refused ---------------------------------------------------------
  const created = await mom.call<{ batch: Batch; pickerUri: string }>(
    "POST",
    `/babies/${MAYA}/imports/google`,
    {},
  );
  const picker = created.body.pickerUri ?? "";
  check(
    "4. POST imports/google => 201, status picking, pickerUri on the fake",
    created.status === 201 &&
      created.body.batch?.status === "picking" &&
      picker.startsWith(`${G}/picker/`),
    `${created.status} ${created.body.batch?.status}`,
  );
  const second = await mom.call<{ error?: string }>("POST", `/babies/${MAYA}/imports/google`, {});
  check(
    "4. a second batch at once is 409 import_in_progress",
    second.status === 409 && second.body.error === "import_in_progress",
    `${second.status} ${second.body.error}`,
  );
  const polled = await mom.call("GET", `/imports/${created.body.batch.id}`);
  check(
    "4. the batch GET never returns the pickerUri or the Google session id",
    !/pickerUri|fake-session|\/picker\//i.test(JSON.stringify(polled.body)),
  );

  // ---- 5. pick and import --------------------------------------------------------------------
  const picked = ["G-1", "G-2", "G-3", "G-4", "G-5", "G-6", "V-1", "X-1"];
  await fetch(`${picker}?autopick=${picked.join(",")}`);
  const batchId = created.body.batch.id;
  const queuedAt = Date.now();
  const queued = await pollBatch(mom, batchId, (b) => b.status !== "picking", 30_000);
  check(
    "5. picking is noticed within ~3 s => queued/running/done",
    ["queued", "running", "done"].includes(queued.status) && Date.now() - queuedAt < 15_000,
    `${queued.status} after ${Date.now() - queuedAt} ms`,
  );
  const done = await pollBatch(
    mom,
    batchId,
    (b) => b.status === "done" || b.status === "failed",
    90_000,
  );
  check(
    "5. done: total 8, imported 5, duplicate 1, skipped 1, failed 1",
    done.status === "done" &&
      done.itemsTotal === 8 &&
      done.itemsImported === 5 &&
      done.itemsDuplicate === 1 &&
      done.itemsSkipped === 1 &&
      done.itemsFailed === 1,
    JSON.stringify(done),
  );

  // ---- 6. what was booked --------------------------------------------------------------------
  const booked = await q(
    `select p.id from photos p join import_items i on i.photo_id = p.id where i.batch_id = '${batchId}' and i.status = 'booked'`,
  );
  const list = booked.map((i) => `'${i}'`).join(",");
  for (const end = Date.now() + 90_000; Date.now() < end; await sleep(1000)) {
    const [n] = await q(
      `select count(*) from photos where id in (${list}) and status <> 'uploaded'`,
    );
    if (Number(n) === booked.length) break;
  }
  const rows = await q(
    `select approval || '|' || (approved_by = uploaded_by)::text || '|' || mime || '|' || (status in ('ingested','ready','queued','analyzing')  )::text || '|' || (uploaded_by = '${momId}')::text from photos where id in (${list})`,
  );
  check(
    "6. five photos: approved, approved_by = uploader = mom, image/jpeg, ingested",
    rows.length === 5 && rows.every((r) => r === "approved|true|image/jpeg|true|true"),
    rows.join(" ; "),
  );
  const [withDate] = await q(
    `select count(*) from photo_exif e join import_items i on i.photo_id = e.photo_id where i.batch_id = '${batchId}' and e.taken_at is not null`,
  );
  const [withGps] = await q(
    `select count(*) from photo_exif e join import_items i on i.photo_id = e.photo_id where i.batch_id = '${batchId}' and e.gps_lat_enc is not null`,
  );
  check(
    "6. five have a capture date, none has GPS (Google strips location)",
    withDate === "5" && withGps === "0",
    `${withDate}/${withGps}`,
  );
  const first = booked[0] ?? "";
  const detail = await mom.call<{
    exif: { takenAt: string | null; cameraMake: string | null } | null;
  }>("GET", `/photos/${first}`);
  check(
    "6. a photo shows the EXIF date and camera make 'Fake'",
    detail.body.exif?.cameraMake === "Fake" &&
      /^2026-03-0\dT/.test(detail.body.exif?.takenAt ?? ""),
    JSON.stringify(detail.body.exif),
  );
  const originalsAfter = await objectLines(`babies/${MAYA}/originals/`);
  check(
    "6. exactly five new original objects (none for the duplicate, video or oversize item)",
    originalsAfter - originalsBefore === 5,
    `${originalsAfter - originalsBefore}`,
  );
  const sessions = await fake<{ id: string; deleted: boolean }[]>("GET", "/__fake/sessions");
  check(
    "6. the finished batch's Google session was deleted",
    sessions.length > 0 && sessions.every((s) => s.deleted),
    JSON.stringify(sessions),
  );

  // ---- 7. the nanny --------------------------------------------------------------------------
  const nStart = await nanny.call<{ url: string }>("POST", "/me/import/google/connect", {
    client: "web",
  });
  const nUrl = new URL(nStart.body.url);
  nUrl.searchParams.set("account", "nanny");
  await consent(browser, nanny, nUrl.toString(), "Allow", "ok");
  const nCreated = await nanny.call<{ batch: Batch; pickerUri: string }>(
    "POST",
    `/babies/${MAYA}/imports/google`,
    {},
  );
  check("7. a contributor may start an import", nCreated.status === 201, `${nCreated.status}`);
  await fetch(`${nCreated.body.pickerUri}?autopick=G-7,P-1`);
  const nDone = await pollBatch(
    nanny,
    nCreated.body.batch.id,
    (b) => b.status === "done" || b.status === "failed",
    90_000,
  );
  check(
    "7. the nanny's batch: done, 2 imported",
    nDone.status === "done" && nDone.itemsImported === 2,
    JSON.stringify(nDone),
  );
  const nRows = await q(
    `select p.id || '|' || p.approval || '|' || coalesce(p.approved_by::text, 'null') || '|' || (p.uploaded_by = '${nannyId}')::text from photos p join import_items i on i.photo_id = p.id where i.batch_id = '${nCreated.body.batch.id}'`,
  );
  check(
    "7. both photos are pending with no approver, uploaded by the nanny",
    nRows.length === 2 && nRows.every((r) => /\|pending\|null\|true$/.test(r)),
    nRows.join(" ; "),
  );
  const queue = await mom.call<{ photos: { id: string }[] }>(
    "GET",
    `/babies/${MAYA}/photos?view=pending&limit=100`,
  );
  const pendingIds = nRows.map((r) => r.split("|")[0] as string);
  check(
    "7. the approval queue lists them",
    pendingIds.every((id) => queue.body.photos?.some((p) => p.id === id)),
    `${queue.body.photos?.length}`,
  );
  const approve = await mom.call("POST", `/photos/${pendingIds[0]}/approve`);
  const [apprBy] = await q(`select approved_by from photos where id = '${pendingIds[0]}'`);
  check(
    "7. mom approves one: approved_by = mom",
    approve.status === 200 && apprBy === momId,
    `${approve.status} ${apprBy}`,
  );
  const nanApprove = await nanny.call("POST", `/photos/${pendingIds[1]}/approve`);
  check("7. the nanny cannot approve the other", nanApprove.status === 403, `${nanApprove.status}`);

  // ---- 8. cancel, deny, reconnect -------------------------------------------------------------
  await fake("DELETE", "/__fake/requests");
  const cStart = await mom.call<{ batch: Batch; pickerUri: string }>(
    "POST",
    `/babies/${MAYA}/imports/google`,
    {},
  );
  const cancel = await mom.call<{ batch: Batch }>(
    "POST",
    `/imports/${cStart.body.batch.id}/cancel`,
  );
  check(
    "8. cancel => cancelled",
    cancel.status === 200 && cancel.body.batch.status === "cancelled",
    `${cancel.status} ${cancel.body.batch?.status}`,
  );
  const dels = (await fakeRequests()).filter(
    (r) => r.method === "DELETE" && r.path.startsWith("/v1/sessions/"),
  );
  check(
    "8. exactly one DELETE /v1/sessions/ reached the fake",
    dels.length === 1,
    `${dels.length}`,
  );

  const [connectedAtBefore] = await q(
    `select connected_at from google_accounts where user_id = '${momId}'`,
  );
  const dStart = await mom.call<{ url: string }>("POST", "/me/import/google/connect", {
    client: "web",
  });
  const deniedSearch = await consent(browser, mom, dStart.body.url, "Deny", "denied");
  const [connectedAtAfter] = await q(
    `select connected_at from google_accounts where user_id = '${momId}'`,
  );
  check(
    "8. Deny => status=denied and the existing connection is untouched",
    /status=denied/.test(deniedSearch) && connectedAtBefore === connectedAtAfter,
    deniedSearch,
  );
  const dNew = await q(
    `select count(*) from google_accounts where user_id in ('${momId}', '${nannyId}')`,
  );
  check("8. Deny created no row", Number(dNew[0]) === 2, dNew[0] ?? "");

  await fake("POST", "/__fake/revoke-all");
  const dead = await mom.call<{ error?: string }>("POST", `/babies/${MAYA}/imports/google`, {});
  const needs = await connection(mom);
  check(
    "8. Google revoked everything => 409 google_reconnect and needsReconnect:true",
    dead.status === 409 && dead.body.error === "google_reconnect" && needs.needsReconnect === true,
    `${dead.status} ${dead.body.error} ${JSON.stringify(needs)}`,
  );
  const rStart = await mom.call<{ url: string }>("POST", "/me/import/google/connect", {
    client: "web",
  });
  await consent(browser, mom, rStart.body.url, "Allow", "ok");
  const back = await connection(mom);
  check(
    "8. connecting again clears needsReconnect",
    back.connected === true && back.needsReconnect === false,
    JSON.stringify(back),
  );
  const fresh = await mom.call<{ batch: Batch }>("POST", `/babies/${MAYA}/imports/google`, {});
  check("8. and an import can start again", fresh.status === 201, `${fresh.status}`);
  await mom.call("POST", `/imports/${fresh.body.batch?.id}/cancel`);

  // ---- 9. disconnect + the contributor's Apple sync ----------------------------------------------
  const rev0 = await fake<unknown[]>("GET", "/__fake/revocations");
  const disc = await mom.call("DELETE", "/me/import/google/connection");
  const rev1 = await fake<{ token: string }[]>("GET", "/__fake/revocations");
  const c2 = await connection(mom);
  check(
    "9. disconnect => 204, the token was revoked at Google, connected:false",
    disc.status === 204 && rev1.length === rev0.length + 1 && c2.connected === false,
    `${disc.status} ${rev0.length}->${rev1.length} ${JSON.stringify(c2)}`,
  );
  const apple = await nanny.call<{ error?: string }>("POST", `/babies/${MAYA}/import-sources`, {
    kind: "apple_photos",
    deviceId: "11111111-2222-4333-8444-555555555555",
    deviceLabel: "Gate phone",
    albumTitle: "Gate album",
    wifiOnly: true,
  });
  check(
    "9. a contributor's Apple album-sync upsert is 403 forbidden",
    apple.status === 403 && apple.body.error === "forbidden",
    `${apple.status} ${apple.body.error}`,
  );
  const stranger: Res = await nanny.call(
    "GET",
    "/me/import-sources?babyId=00000000-0000-4000-8000-0000000009ff",
  );
  check(
    "9. and a baby the nanny does not belong to is 404",
    stranger.status === 404,
    `${stranger.status}`,
  );

  // ---- 10 (part). deliveries and audit rows, before cleanup removes Maya's ----------------------
  const pushNow = Number((await q("select count(*) from push_deliveries"))[0]);
  check(
    "10. no push delivery was created by the import path",
    pushNow === pushBefore,
    `${pushBefore} -> ${pushNow}`,
  );
  const events = await q(
    `select distinct event from audit_log where id > ${auditBefore} and event like 'import.%' order by 1`,
  );
  check(
    "10. the import audit events were written (connect, batch created/finished/cancelled, disconnect)",
    [
      "import.batch_cancelled",
      "import.batch_created",
      "import.batch_finished",
      "import.google_connected",
      "import.google_disconnected",
    ].every((e) => events.includes(e)),
    events.join(","),
  );
  const leaked = await q(
    `select count(*) from audit_log where id > ${auditBefore} and metadata::text ~ 'fake-(access|refresh|code|session)-|https?://|ya29\\.|googleusercontent|Gate album|Gate phone'`,
  );
  check(
    "10. no audit row carries a token, URL, album title or device label",
    leaked[0] === "0",
    leaked[0] ?? "",
  );
  const keys = await q(
    `select distinct k from audit_log, jsonb_object_keys(metadata) k where id > ${auditBefore} and event like 'import.%' order by 1`,
  );
  check(
    "10. import audit metadata uses only ids, kind and counts",
    keys.every((k) =>
      ["batch_id", "source_id", "kind", "count", "duplicates", "failed"].includes(k),
    ),
    keys.join(","),
  );
}

/** Everything the run created is removed; Maya's seed state and import budget are restored. */
async function cleanup() {
  console.log("\n-- cleanup --");
  try {
    const photosNow = await q(`select id from photos where baby_id = '${MAYA}'`);
    const added = photosNow.filter((x) => !photosBefore.has(x));
    const batches = (await q(`select id from import_batches where baby_id = '${MAYA}'`)).filter(
      (x) => !batchesBefore.has(x),
    );
    const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");
    if (batches.length) {
      await q(`delete from import_items where batch_id in (${list(batches)})`);
      await q(`delete from import_batches where id in (${list(batches)})`);
    }
    if (added.length) {
      await q(`delete from photos where id in (${list(added)})`);
      const rm = added.map((i) => `originals/${i} derivatives/${i}`).join(" ");
      await dc([
        "exec",
        "-T",
        "storage",
        "sh",
        "-c",
        `cd /data/${BUCKET}/babies/${MAYA} 2>/dev/null && rm -rf ${rm}`,
      ]).catch(() => undefined);
      await mc(
        `rm --recursive --versions --force ll/${BUCKET}/babies/${MAYA}/originals/ --older-than 0d`,
      ).catch(() => "");
    }
    await q(
      `delete from upload_sessions where baby_id = '${MAYA}' and created_at >= '${startedAt}'`,
    );
    await q(
      "delete from google_accounts where user_id in (select id from auth.users where email in ('demo-mom@littlelight.local','demo-nanny@littlelight.local'))",
    );
    await q(`delete from import_sources where baby_id = '${MAYA}' and device_label = 'Gate phone'`);
    await q(
      `delete from audit_log where id > ${auditBefore} and (event like 'import.%' or (baby_id = '${MAYA}' and (event like 'upload.%' or event like 'photo.%')))`,
    );
    await fake("POST", "/__fake/reset");
    await fake("POST", "/__fake/consent", { decision: "ask" });
    await restoreMayaSeedState();
    const [left] = await q(`select count(*) from import_batches where baby_id = '${MAYA}'`);
    check(
      "cleanup: Maya has no import batch of ours left (20/day budget restored)",
      Number(left) === batchesBefore.size,
      `${left}`,
    );
    const photosAfter = new Set(await q(`select id from photos where baby_id = '${MAYA}'`));
    check(
      "cleanup: Maya's photos are exactly what they were",
      photosAfter.size === photosBefore.size && [...photosBefore].every((p) => photosAfter.has(p)),
      `${photosAfter.size} vs ${photosBefore.size}`,
    );
  } catch (e) {
    check("cleanup (crashed)", false, e instanceof Error ? e.message : String(e));
  }
}

async function logScan() {
  console.log("\n-- log scan --");
  const { stdout } = await dc([
    "logs",
    "--no-color",
    "--since",
    startedAt,
    "api",
    "worker",
    "google-fake",
  ]);
  const hits: string[] = [];
  const must = (name: string, re: RegExp) => {
    if (re.test(stdout)) hits.push(name);
  };
  must("fake token or code", /fake-(access|refresh|code)-/);
  must("media path", /\/media\//);
  must("pickerUri", /pickerUri/);
  must("picker URL", /\/picker\/(fake-session-)?[A-Za-z0-9-]{8,}/);
  must("presign signature", /X-Amz-Signature/);
  must("JWT", /eyJ[A-Za-z0-9_-]{10,}/);
  must("demo address", /@littlelight\.local/);
  must("baseUrl", /baseUrl/);
  must("googleusercontent URL", /googleusercontent\.com\/\S/);
  check(
    "10. api + worker + google-fake logs: no token, code, media/picker URL, signature, JWT or address",
    hits.length === 0,
    hits.join("; "),
  );
  check(
    "10. the import ran in the worker log (the scan is not vacuous)",
    /import\.google: batch finished/.test(stdout),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
