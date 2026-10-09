/**
 * Step-9 push gate (docs/plans/step-9.md 2.15 "Push gate"; no device needed).
 *
 *   docker compose -f docker-compose.dev.yml up -d --wait
 *   bash .github/scripts/restart-api.sh      # optional: this gate recreates the api anyway
 *   pnpm e2e:push-gate
 *
 * Keyless and always on the fake providers. It recreates api and worker with
 *   PUSH_PHOTOS_DEBOUNCE_SEC=0 PUSH_SHARE_DEBOUNCE_SEC=0 PUSH_MIN_GAP_MIN=0
 *   VISION_PROVIDER=fake AI_BATCH_FLUSH_MINUTES=0
 * and restores the stack defaults (ending on the fake provider) in `finally`.
 *
 * A fresh admin signs in with the native client kind (bearer tokens, no Set-Cookie), registers a
 * fake APNs device, and:
 *  - a Plus baby with 3 new photos  => `fake` photos_analyzed deliveries summing to item_count 3;
 *  - a Free baby with 3 photos      => no delivery, no photo_ai, no ai_batch_items, no push.notify
 *    job ever enqueued for it;
 *  - a share link exchanged by a fresh native viewer => exactly one share_viewed delivery; the same
 *    viewer re-exchanging with its bearer token (a reused session) => none;
 *  - DELETE /me/push-devices/current + sign-out => the next share view => none.
 * "No delivery" always means no row with id > the max(id) captured just before the trigger (the
 * ledger keeps rows when a device is deleted, so total counts prove nothing). ai.flush is scoped to the
 * gate's own babies (`babyId`): the seeded demo photos must never be analysed by a gate. Global AI counts are
 * never asserted: the 12 demo photos have real media and may join AI batches.
 * Finally the api/worker logs since the start are scanned for tokens, `eyJ` and signed-URL parts.
 * Writes e2e/native-results/push-gate.json; exits 1 on any miss. The test babies are trashed.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { uniqueEmail } from "../helpers/api";
import { psql } from "../helpers/db";
import { NativeClient } from "../helpers/native";
import { restoreMayaSeedState } from "../helpers/reset";
import { BASE, runJob, setPlan, tokenOf, uploadPhotos, waitForThumbs } from "../helpers/share";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(ROOT, "e2e/native-results");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long "nothing happens" is observed for. The jobs run with no debounce; the worker polls ~2 s. */
const QUIET_MS = 12_000;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}

const GATE_ENV = {
  PUSH_PHOTOS_DEBOUNCE_SEC: "0",
  PUSH_SHARE_DEBOUNCE_SEC: "0",
  PUSH_MIN_GAP_MIN: "0",
  VISION_PROVIDER: "fake",
  AI_BATCH_FLUSH_MINUTES: "0",
};

async function dc(args: string[], env: Record<string, string> = {}) {
  // Variables of the gate must not leak in from the caller's shell; the next block sets them.
  const inherited = { ...process.env };
  for (const k of [...Object.keys(GATE_ENV), "PUSH_PROVIDER"]) delete inherited[k];
  return sh("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: ROOT,
    env: { ...inherited, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function healthyService(name: string): Promise<boolean> {
  const { stdout } = await dc(["ps", name, "--format", "json"]);
  const t = stdout.trim();
  if (!t) return false;
  const row = t.startsWith("[") ? JSON.parse(t)[0] : JSON.parse(t.split("\n")[0] ?? "{}");
  return row?.Health === "healthy";
}

/** `up -d --no-deps api worker` with `env`, then wait for both to be healthy and reachable. */
async function recreateBoth(env: Record<string, string>): Promise<void> {
  await dc(["up", "-d", "--no-deps", "api", "worker"], env);
  for (const end = Date.now() + 180_000; Date.now() < end; ) {
    const ok =
      (await healthyService("api")) &&
      (await healthyService("worker")) &&
      (await fetch(`${BASE}/api/healthz`).then(
        (r) => r.ok,
        () => false,
      ));
    if (ok) return;
    await sleep(2000);
  }
  throw new Error("api/worker did not become healthy");
}

const q = (sql: string) => psql(sql);
const num = async (sql: string) => Number((await q(sql))[0] ?? "0");

interface Delivery {
  id: number;
  kind: string;
  status: string;
  itemCount: number | null;
  babyId: string;
}

async function maxDeliveryId(): Promise<number> {
  return num("select coalesce(max(id), 0) from push_deliveries");
}

/** Rows newer than `afterId` for `userId` (the ledger survives device deletion, so scope by id). */
async function deliveriesAfter(afterId: number, userId: string): Promise<Delivery[]> {
  const rows = await q(
    `select id||'|'||kind||'|'||status||'|'||coalesce(item_count::text,'')||'|'||baby_id
       from push_deliveries where id > ${afterId} and user_id='${userId}' order by id`,
  );
  return rows.map((r) => {
    const [id, kind, status, count, babyId] = r.split("|");
    return {
      id: Number(id),
      kind: kind as string,
      status: status as string,
      itemCount: count ? Number(count) : null,
      babyId: babyId as string,
    };
  });
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | false>,
  timeoutMs = 180_000,
  everyMs = 1500,
): Promise<T> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Force flush + poll until the baby's photos all have a photo_ai row. */
async function analyse(babyId: string, count: number): Promise<void> {
  console.log(
    `      ai.flush: ${JSON.stringify(await runJob("ai.flush", { force: true, babyId }))}`,
  );
  for (const end = Date.now() + 300_000; Date.now() < end; ) {
    await runJob("ai.poll");
    const done = await num(
      `select count(*) from photo_ai a join photos p on p.id=a.photo_id where p.baby_id='${babyId}'`,
    );
    if (done === count) return;
    const open = await num(
      `select count(*) from ai_batch_items where baby_id='${babyId}' and state in ('pending','submitted')`,
    );
    if (open === 0) await runJob("ai.flush", { force: true, babyId });
    await sleep(2500);
  }
  throw new Error("photos were not analysed in 300 s");
}

async function run(startedAt: string): Promise<Record<string, unknown>> {
  const admin = new NativeClient(uniqueEmail("pushgate"));
  await admin.onboard("Push Gate Admin");
  const [userRow] = await q(`select id from auth.users where email='${admin.email}'`);
  const userId = userRow as string;
  check(
    "native sign-in answered tokens in the body and set no cookie",
    !!admin.accessToken && !admin.sawSetCookie,
  );

  const secrets: string[] = [admin.accessToken as string, admin.refreshToken as string];

  // ---- device ------------------------------------------------------------------------------
  const deviceToken = randomBytes(32).toString("hex");
  secrets.push(deviceToken);
  const web = await fetch(`${BASE}/api/me/push-devices`, {
    method: "POST",
    headers: {
      "x-littlelight-client": "web",
      authorization: `Bearer ${admin.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      platform: "ios",
      provider: "apns",
      token: randomBytes(32).toString("hex"),
      appVersion: "1.0.0",
    }),
  });
  check(
    "registering a push device without the native client header is 400",
    web.status === 400,
    `${web.status}`,
  );
  const fcmOnIos = await admin.call("POST", "/me/push-devices", {
    platform: "ios",
    provider: "fcm",
    token: randomBytes(32).toString("hex"),
    appVersion: "1.0.0",
  });
  check(
    "an iOS device cannot register with fcm (400)",
    fcmOnIos.status === 400,
    `${fcmOnIos.status}`,
  );
  const reg = await admin.call<{ device: { id: string } }>("POST", "/me/push-devices", {
    platform: "ios",
    provider: "apns",
    token: deviceToken,
    appVersion: "1.0.0",
  });
  check(
    "registering a fake APNs device answered 201",
    reg.status === 201 && !!reg.body.device?.id,
    `${reg.status}`,
  );
  check(
    "the device row exists, enabled, for this user",
    (await num(
      `select count(*) from push_devices where user_id='${userId}' and disabled_at is null`,
    )) === 1,
  );

  // ---- Plus baby: photos_analyzed ---------------------------------------------------------
  const paid = await admin.createBaby("Push Gate Plus");
  await setPlan(paid, "plus");
  const before = await maxDeliveryId();
  const ids = await uploadPhotos(admin, paid, 3, 970_000);
  await waitForThumbs(ids);
  await analyse(paid, 3);
  const photosDeliveries = await waitFor(
    "a photos_analyzed delivery",
    async () => {
      const d = (await deliveriesAfter(before, userId)).filter((x) => x.kind === "photos_analyzed");
      return d.length > 0 && d.reduce((n, x) => n + (x.itemCount ?? 0), 0) >= 3 ? d : null;
    },
    120_000,
  );
  const total = photosDeliveries.reduce((n, x) => n + (x.itemCount ?? 0), 0);
  check(
    "Plus baby, 3 photos: fake photos_analyzed delivery with item_count 3",
    photosDeliveries.every((d) => d.status === "fake" && d.babyId === paid) && total === 3,
    JSON.stringify(photosDeliveries),
  );
  check(
    "the Plus baby's delivery count is 1 row (one coalesced push)",
    photosDeliveries.length === 1,
    `${photosDeliveries.length} rows (counts ${photosDeliveries.map((d) => d.itemCount).join(",")})`,
  );

  // ---- Free baby: nothing is analysed, nothing is pushed -----------------------------------
  const free = await admin.createBaby("Push Gate Free");
  const beforeFree = await maxDeliveryId();
  const freeIds = await uploadPhotos(admin, free, 3, 971_000);
  await waitForThumbs(freeIds);
  await runJob("ai.flush", { force: true, babyId: free });
  await runJob("ai.poll");
  await sleep(QUIET_MS);
  await runJob("ai.poll");
  const freeNew = await deliveriesAfter(beforeFree, userId);
  check(
    "Free baby, 3 photos: no new delivery row (id > max(id) before)",
    freeNew.length === 0,
    JSON.stringify(freeNew),
  );
  check(
    "Free baby: no ai_batch_items, no photo_ai",
    (await num(`select count(*) from ai_batch_items where baby_id='${free}'`)) === 0 &&
      (await num(
        `select count(*) from photo_ai a join photos p on p.id=a.photo_id where p.baby_id='${free}'`,
      )) === 0,
  );
  check(
    "Free baby: no push.notify job was ever enqueued for it",
    (await num(
      `select count(*) from pgboss.job where name='push.notify' and data->>'babyId'='${free}'`,
    )) === 0,
  );

  // ---- share_viewed -------------------------------------------------------------------------
  const link = await admin.call<{ url: string; link?: { id?: string } }>(
    "POST",
    `/babies/${paid}/share-links`,
    {
      name: "push gate",
    },
  );
  check("share link created", link.status === 201, `${link.status}`);
  const shareToken = tokenOf(link.body.url);
  const shareLinkId = link.body.link?.id ?? "";
  check("share link id returned", /^[0-9a-f-]{36}$/.test(shareLinkId), shareLinkId);
  secrets.push(shareToken);
  const exchange = async (bearer?: string) => {
    const res = await fetch(`${BASE}/api/share/session`, {
      method: "POST",
      headers: {
        "x-littlelight-client": "native",
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ token: shareToken }),
    });
    const body = (await res.json().catch(() => ({}))) as { viewerToken?: string };
    return {
      status: res.status,
      viewerToken: body.viewerToken,
      setCookie: res.headers.has("set-cookie"),
    };
  };

  const beforeShare = await maxDeliveryId();
  const v1 = await exchange();
  check(
    "fresh native viewer exchange: 200, bearer viewerToken, no Set-Cookie",
    v1.status === 200 && !!v1.viewerToken && !v1.setCookie,
    `${v1.status}`,
  );
  if (v1.viewerToken) secrets.push(v1.viewerToken);
  const shareDeliveries = await waitFor(
    "a share_viewed delivery",
    async () => {
      const d = (await deliveriesAfter(beforeShare, userId)).filter(
        (x) => x.kind === "share_viewed",
      );
      return d.length > 0 ? d : null;
    },
    60_000,
  );
  await sleep(QUIET_MS / 2);
  const shareAll = (await deliveriesAfter(beforeShare, userId)).filter(
    (x) => x.kind === "share_viewed",
  );
  check(
    "new viewer session: exactly one fake share_viewed delivery",
    shareAll.length === 1 &&
      shareDeliveries[0]?.status === "fake" &&
      shareDeliveries[0]?.babyId === paid,
    JSON.stringify(shareAll),
  );

  const beforeReuse = await maxDeliveryId();
  const v2 = await exchange(v1.viewerToken);
  await sleep(QUIET_MS);
  const reuseNew = await deliveriesAfter(beforeReuse, userId);
  check(
    "reused viewer session: 200 and no new delivery row",
    v2.status === 200 && reuseNew.length === 0,
    `${v2.status} ${JSON.stringify(reuseNew)}`,
  );
  check(
    "a reused session enqueues no second share_viewed job (this link: exactly 1 total)",
    (await num(
      `select count(*) from pgboss.job where name='push.notify' and data->>'kind'='share_viewed' and data->>'shareLinkId'='${shareLinkId}'`,
    )) === 1,
  );

  // ---- unregister + sign-out ----------------------------------------------------------------
  const del = await admin.call("DELETE", "/me/push-devices/current");
  check("DELETE /me/push-devices/current answered 204", del.status === 204, `${del.status}`);
  check(
    "the device row is gone",
    (await num(`select count(*) from push_devices where user_id='${userId}'`)) === 0,
  );
  const out = await admin.call("POST", "/auth/signout", { scope: "local" });
  check("native sign-out answered 204", out.status === 204, `${out.status}`);
  const beforeOut = await maxDeliveryId();
  const v3 = await exchange();
  await sleep(QUIET_MS);
  const outNew = await deliveriesAfter(beforeOut, userId);
  check(
    "after unregister + sign-out, a new viewer session: no delivery row",
    v3.status === 200 && outNew.length === 0,
    `${v3.status} ${JSON.stringify(outNew)}`,
  );
  check("no response of the native admin client set a cookie", !admin.sawSetCookie);

  // ---- logs ----------------------------------------------------------------------------------
  const { stdout } = await dc(["logs", "--no-color", "--since", startedAt, "api", "worker"]);
  const hits: string[] = [];
  for (const s of secrets) if (s && stdout.includes(s)) hits.push(`a secret of length ${s.length}`);
  if (/eyJ[A-Za-z0-9_-]{10,}/.test(stdout)) hits.push("a JWT-shaped value (eyJ...)");
  if (/X-Amz-Signature/i.test(stdout)) hits.push("X-Amz-Signature");
  check(
    "api/worker logs hold no device token, bearer/viewer token, share token, eyJ or X-Amz-Signature",
    hits.length === 0,
    hits.join("; "),
  );
  check(
    "the gate produced a worker log (non-vacuous scan)",
    /push\.notify|queues|worker/i.test(stdout) && stdout.length > 500,
  );

  // ---- cleanup -------------------------------------------------------------------------------
  await admin.signIn().catch(() => undefined);
  for (const b of [paid, free]) await admin.call("DELETE", `/babies/${b}`).catch(() => undefined);

  return { userId: "redacted", paidDeliveries: photosDeliveries.length };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const startedMs = Date.now();
  const startedAt = new Date(startedMs - 5000).toISOString();
  let extra: Record<string, unknown> = {};
  try {
    console.log("recreating api and worker with no push debounce, fake AI ...");
    await recreateBoth(GATE_ENV);
    extra = await run(startedAt);
  } catch (e) {
    check("gate crashed", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    console.log("restoring api and worker to the stack default (fake provider) ...");
    await recreateBoth({ VISION_PROVIDER: "fake" }).catch((e) =>
      console.error(`restore failed: ${e}`),
    );
    // The flush-0 worker analysed Maya's seeded (ingested) photos too: put her back to the seed.
    await restoreMayaSeedState().catch((e) => console.error(`maya restore failed: ${e}`));
  }
  const failed = results.filter((r) => !r.ok);
  writeFileSync(
    path.join(OUT_DIR, "push-gate.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        seconds: Math.round((Date.now() - startedMs) / 1000),
        passed: results.length - failed.length,
        failed: failed.length,
        ...extra,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\npush gate: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
