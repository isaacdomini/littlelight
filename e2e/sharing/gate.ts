/**
 * Step-8 gate (docs/plans/step-8.md 2.12 and 4.1): the PRD check "expired or revoked link returns
 * the expired page; sensitive photos never auto-share".
 *
 *   docker compose -f docker-compose.dev.yml up -d --build --wait
 *   pnpm e2e:share-gate [--keep]
 *
 * Keyless: recreates the worker with the fake provider (AI_BATCH_FLUSH_MINUTES=0) and the api
 * with SHARE_MEDIA_URL_TTL_SEC=30, and restores both to the stack default in `finally`.
 * A fresh parent gets a Plus baby "Share Gate" (>= 32 uploaded photos, half with EXIF GPS, >= 3
 * the fake provider flags as sensitive) and a Free baby "Share Free"; five links (L-all,
 * L-ms, L-tags, L-manual, L-dl) plus L-lock for the passcode lockout. Prints PASS/FAIL per check,
 * writes e2e/share-gate/results.json, exits 1 on any miss; trashes both babies unless --keep.
 * Sign-in codes are throttled per IP in api memory: CI restarts the api first
 * (.github/scripts/restart-api.sh); this gate recreates it anyway, which also resets the limit.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import exifr from "exifr";
import {
  type AiDescriptionV1,
  aiDescriptionV1Schema,
  applyAiOverrides,
  searchTagsFor,
  shareRuleMatches,
} from "../../packages/shared/src/index";
import { ApiClient, uniqueEmail } from "../helpers/api";
import { psql } from "../helpers/db";
import {
  BASE,
  type Created,
  GPS_COORDS,
  runJob,
  setPlan,
  tokenOf,
  uploadPhotos,
  viewerClient,
  waitForThumbs,
} from "../helpers/share";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(ROOT, "e2e/share-gate");
const KEEP = process.argv.includes("--keep");
const PASSCODE = "482913";
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

async function dc(args: string[], env: Record<string, string> = {}) {
  // The caller's provider/TTL variables must not leak into compose.
  const { VISION_PROVIDER: _v, SHARE_MEDIA_URL_TTL_SEC: _t, ...inherited } = process.env;
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

async function recreate(service: "api" | "worker", env: Record<string, string>, log?: RegExp) {
  await dc(["up", "-d", "--no-deps", service], env);
  for (const end = Date.now() + 150_000; Date.now() < end; ) {
    const ok =
      (await healthyService(service)) &&
      (service === "worker"
        ? log
          ? log.test((await dc(["logs", "--no-color", "worker"])).stdout)
          : true
        : await fetch(`${BASE}/api/healthz`).then(
            (r) => r.ok,
            () => false,
          ));
    if (ok) return;
    await sleep(2000);
  }
  throw new Error(`${service} did not come up`);
}

const q = async (sql: string) => psql(sql);
const hasKey = (o: unknown, keys: string[]): string | null => {
  const s = JSON.stringify(o);
  return keys.find((k) => s.includes(`"${k}"`)) ?? null;
};

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const api = await ApiClient.create(uniqueEmail("sharegate"));
  await api.onboard("Share Gate Parent");
  const paid = await api.createBaby("Share Gate");
  const free = await api.createBaby("Share Free");
  await setPlan(paid, "plus");
  check(
    "paid baby is plus and free baby is free",
    (await q(`select plan from babies where id='${paid}'`))[0] === "plus" &&
      (await q(`select plan from babies where id='${free}'`))[0] === "free",
  );

  const mk = async (
    babyId: string,
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<Created> => {
    const r = await api.call<Created>("POST", `/babies/${babyId}/share-links`, { name, ...extra });
    if (r.status !== 201)
      throw new Error(`create ${name} answered ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const rule = (mode: "all" | "milestones" | "tags", inc: string[] = [], exc: string[] = []) => ({
    rule: { mode, includeTags: inc, excludeTags: exc },
  });

  // ---- 3. links ---------------------------------------------------------------------------
  const before = Date.now();
  const lAll = await mk(paid, "L-all", rule("all"));
  const lMs = await mk(paid, "L-ms", rule("milestones"));
  const lTags = await mk(paid, "L-tags", rule("tags", ["outdoor"], ["bath"]));
  const lManual = await mk(paid, "L-manual", { passcode: PASSCODE });
  const lDl = await mk(paid, "L-dl", { allowDownload: true });
  const lLock = await mk(paid, "L-lock", { passcode: PASSCODE });
  const tokens = [lAll, lMs, lTags, lManual, lDl, lLock].map((l) => tokenOf(l.url));
  const exp = new Date(lAll.link.expiresAt).getTime();
  check(
    "default expiry of a fresh link is now + 24 h (+/- 2 min)",
    Math.abs(exp - (before + 24 * 3_600_000)) < 150_000,
    lAll.link.expiresAt,
  );

  // ---- 4. uploads (Plus, in rounds of 16) -----------------------------------------------------
  const photos: string[] = [];
  const gpsIds = new Set<string>();
  let rounds = 0;
  while (
    photos.length < 160 &&
    (photos.length < 32 || photos.filter((i) => i.startsWith("0")).length < 3)
  ) {
    const seed = 940_000 + rounds * 100;
    const ids = await uploadPhotos(api, paid, 16, seed, { gps: true });
    photos.push(...ids);
    rounds++;
    console.log(`      uploaded round ${rounds}: ${photos.length} photos`);
  }
  const zeros = photos.filter((i) => i.startsWith("0"));
  check(
    `uploaded >= 32 photos with >= 3 fake-sensitive ids (${photos.length}, ${zeros.length})`,
    photos.length >= 32 && zeros.length >= 3,
  );
  const gpsRows = await q(
    `select p.id from photos p join photo_exif e on e.photo_id = p.id where p.baby_id='${paid}' and e.gps_lat_enc is not null`,
  ).catch(() => [] as string[]);
  for (const g of gpsRows) gpsIds.add(g);
  await waitForThumbs(photos);

  // milestone on 4 non-flagged photos
  const preset = await api.call<{ milestones: { id: string }[] }>(
    "GET",
    `/babies/${paid}/milestones`,
  );
  const milestoneId = preset.body.milestones?.[0]?.id;
  const msPhotos = photos.filter((i) => !i.startsWith("0")).slice(0, 4);
  const tag = await api.call("POST", `/babies/${paid}/photos/details`, {
    photoIds: msPhotos,
    milestoneId,
  });
  check(
    "batch details tag 4 photos with a milestone",
    tag.status === 200 && !!milestoneId,
    `status ${tag.status}`,
  );

  // analysis derivative ready, then force flush/poll until everything is analysed
  for (const end = Date.now() + 180_000; Date.now() < end; ) {
    const [n] = await q(
      `select count(*) from photos p where p.baby_id='${paid}' and p.status in ('ingested','ready') and exists (select 1 from photo_derivatives d where d.photo_id=p.id and d.kind='analysis')`,
    );
    if (Number(n) === photos.length) break;
    await sleep(1000);
  }
  console.log(`      ai.flush: ${JSON.stringify(await runJob("ai.flush", { force: true }))}`);
  for (const end = Date.now() + 600_000; Date.now() < end; ) {
    await runJob("ai.poll");
    const [open] = await q(
      `select count(*) from ai_batch_items where baby_id='${paid}' and state in ('pending','submitted')`,
    );
    const [done] = await q(
      `select count(*) from photo_ai a join photos p on p.id=a.photo_id where p.baby_id='${paid}'`,
    );
    if (Number(open) === 0 && Number(done) === photos.length) break;
    if (Number(open) === 0) await runJob("ai.flush", { force: true });
    await sleep(3000);
  }
  const [analysed] = await q(
    `select count(*) from photo_ai a join photos p on p.id=a.photo_id where p.baby_id='${paid}'`,
  );
  check(
    "every paid photo is analysed",
    Number(analysed) === photos.length,
    `${analysed}/${photos.length}`,
  );
  for (const end = Date.now() + 120_000; Date.now() < end; ) {
    const [n] = await q(
      `select count(*) from pgboss.job where name='photo.reindex' and state in ('created','retry','active') and data->>'babyId'='${paid}'`,
    );
    if (Number(n) === 0) break;
    await sleep(1500);
  }
  console.log(`      share.reconcile: ${JSON.stringify(await runJob("share.reconcile"))}`);

  // ---- 5. sensitive never auto-shares; rule sets are exact --------------------------------
  const [badRule] = await q(
    `select count(*) from shared_photos sp join photos p on p.id = sp.photo_id where sp.added_by = 'rule' and p.is_sensitive`,
  );
  check("rule rows of sensitive photos = 0", badRule === "0", `count ${badRule}`);
  const sensitive = await q(`select id from photos where baby_id='${paid}' and is_sensitive`);
  check(
    "the fake provider flagged >= 3 photos sensitive (non-vacuous)",
    sensitive.length >= 3,
    `${sensitive.length}`,
  );
  const ruleRows = async (id: string) =>
    await q(
      `select photo_id from shared_photos where share_link_id='${id}' and added_by='rule' order by 1`,
    );
  const facts = JSON.parse(
    (
      await q(
        `select coalesce(jsonb_agg(t), '[]'::jsonb) from (select p.id, p.is_sensitive as sens, a.description, m.name as ms
         from photos p join photo_ai a on a.photo_id = p.id
         left join photo_details d on d.photo_id = p.id left join milestones m on m.id = d.milestone_id
        where p.baby_id='${paid}' and p.deleted_at is null) t`,
      )
    )[0] ?? "[]",
  ) as { id: string; sens: boolean; description: unknown; ms: string | null }[];
  const expected = (r: {
    mode: "all" | "milestones" | "tags";
    includeTags: string[];
    excludeTags: string[];
  }) =>
    facts
      .filter((f) => {
        const d = aiDescriptionV1Schema.parse(f.description) as AiDescriptionV1;
        return shareRuleMatches(r, {
          analyzed: true,
          isSensitive: f.sens,
          hasMilestone: f.ms !== null,
          tags: searchTagsFor(applyAiOverrides(d, null), f.ms),
        });
      })
      .map((f) => f.id)
      .sort();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const gotAll = await ruleRows(lAll.link.id);
  const expAll = expected({ mode: "all", includeTags: [], excludeTags: [] });
  check(
    "L-all = every non-sensitive analysed photo",
    same(gotAll, expAll) && expAll.length >= 29,
    `${gotAll.length} vs ${expAll.length}`,
  );
  const gotMs = await ruleRows(lMs.link.id);
  const expMs = expected({ mode: "milestones", includeTags: [], excludeTags: [] });
  check(
    "L-ms = exactly the milestone photos",
    same(gotMs, expMs) && expMs.length === 4,
    `${gotMs.length} vs ${expMs.length}`,
  );
  const gotTags = await ruleRows(lTags.link.id);
  const expTags = expected({ mode: "tags", includeTags: ["outdoor"], excludeTags: ["bath"] });
  check(
    "L-tags = matcher result (outdoor minus bath)",
    same(gotTags, expTags),
    `${gotTags.length} vs ${expTags.length}`,
  );
  console.log(
    `      L-all ${gotAll.length}, L-ms ${gotMs.length}, L-tags ${gotTags.length}, sensitive ${sensitive.length}`,
  );

  const vAll = await viewerClient();
  await vAll.exchange(tokens[0] as string);
  const seen: string[] = [];
  let cursor: string | null = null;
  let leaked: string | null = null;
  do {
    const r: { body: { photos: { id: string }[]; nextCursor: string | null } } = await vAll.call(
      "GET",
      `/share/photos?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    seen.push(...(r.body.photos ?? []).map((p) => p.id));
    leaked =
      leaked ??
      hasKey(r.body, ["babyId", "caption", "isSensitive", "latitude", "longitude", "displayUrl"]);
    cursor = r.body.nextCursor ?? null;
  } while (cursor);
  check(
    "viewer of L-all sees no sensitive id and exactly the rule set",
    !seen.some((i) => sensitive.includes(i)) && same([...seen].sort(), expAll),
    `${seen.length}`,
  );
  check(
    "viewer API carries no babyId, caption, isSensitive, GPS or displayUrl key",
    leaked === null,
    String(leaked),
  );

  // free baby
  const freeIds = await uploadPhotos(api, free, 2, 960_000);
  const freeRule = await api.call<{ error?: string }>("POST", `/babies/${free}/share-links`, {
    name: "x",
    ...rule("all"),
  });
  check(
    "free baby rule -> 403 plan_required",
    freeRule.status === 403 && freeRule.body.error === "plan_required",
    `${freeRule.status}`,
  );
  const freeLink = await mk(free, "Share Free link");
  const freeAdd = await api.call("POST", `/share-links/${freeLink.link.id}/photos`, {
    photoIds: freeIds,
  });
  check("free baby manual add works", freeAdd.status === 200, `status ${freeAdd.status}`);
  const [freeAi] = await q(
    `select count(*) from photo_ai a join photos p on p.id=a.photo_id where p.baby_id='${free}'`,
  );
  check("free baby has no photo_ai rows", freeAi === "0");

  // ---- 6. manual sensitive stays hidden until released --------------------------------------
  const sens = sensitive[0] as string;
  const plain = seen[0] as string;
  await api.call("POST", `/share-links/${lManual.link.id}/photos`, { photoIds: [sens, plain] });
  const vMan = await viewerClient();
  const manTok = tokens[3] as string;
  check(
    "L-manual asks for the passcode",
    (await vMan.exchange(manTok)).body.error === "passcode_required",
  );
  check(
    "L-manual opens with the right passcode",
    (await vMan.exchange(manTok, PASSCODE)).status === 200,
  );
  const listMan = async () =>
    (
      await vMan.call<{ photos: { id: string; hidden: boolean; thumbUrl: string | null }[] }>(
        "GET",
        "/share/photos",
      )
    ).body.photos;
  const hiddenTile = (await listMan()).find((p) => p.id === sens);
  check(
    "manual sensitive photo: hidden true, thumbUrl null",
    !!hiddenTile && hiddenTile.hidden && hiddenTile.thumbUrl === null,
  );
  const omitted = await vMan.call<{ urls: { id: string }[] }>("POST", "/share/photos/urls", {
    ids: [sens, plain],
    kind: "thumb",
  });
  check(
    "/share/photos/urls omits the hidden photo and serves the other",
    omitted.body.urls?.length === 1 && omitted.body.urls[0]?.id === plain,
  );
  const rel = await api.call("PATCH", `/share-links/${lManual.link.id}/photos/${sens}`, {
    showSensitive: true,
  });
  check("PATCH showSensitive answers 200", rel.status === 200, `status ${rel.status}`);
  const released = (await listMan()).find((p) => p.id === sens);
  check(
    "released sensitive photo is visible",
    !!released && !released.hidden && !!released.thumbUrl,
  );

  // ---- 7. media: no EXIF/GPS, not the original, Cache-Control private ---------------------------
  const gpsPhotos = [...gpsIds].filter((i) => !sensitive.includes(i)).slice(0, 3);
  const pick = gpsPhotos.length > 0 ? gpsPhotos : [plain];
  check(
    "the media sample includes GPS-tagged originals",
    gpsPhotos.length > 0,
    "photo_exif lookup found none",
  );
  await api.call("POST", `/share-links/${lDl.link.id}/photos`, { photoIds: pick });
  const vDl = await viewerClient();
  await vDl.exchange(tokens[4] as string);
  const origSha = async (id: string) =>
    (await q(`select encode(sha256,'hex') from photos where id='${id}'`))[0];
  let mediaOk = true;
  let mediaWhy = "";
  let issuedUrl = "";
  let issuedAt = 0;
  for (const kind of ["thumb", "display"] as const) {
    const u = await vDl.call<{ urls: { id: string; url: string }[] }>(
      "POST",
      "/share/photos/urls",
      { ids: pick, kind },
    );
    for (const item of u.body.urls ?? []) {
      if (!issuedUrl) {
        issuedUrl = item.url;
        issuedAt = Date.now();
      }
      const res = await fetch(item.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const exif = ((await exifr.parse(buf, true).catch(() => undefined)) ?? {}) as Record<
        string,
        unknown
      >;
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(buf).digest("hex");
      const gps =
        exif.latitude !== undefined ||
        exif.longitude !== undefined ||
        exif.GPSLatitude !== undefined;
      const cam = exif.Make !== undefined || exif.Model !== undefined;
      const priv = /\bprivate\b/.test(res.headers.get("cache-control") ?? "");
      if (res.status !== 200 || gps || cam || sha === (await origSha(item.id)) || !priv) {
        mediaOk = false;
        mediaWhy += ` ${kind}:${res.status}${gps ? ":gps" : ""}${cam ? ":cam" : ""}${priv ? "" : ":cache"}`;
      }
    }
    if ((u.body.urls ?? []).length !== pick.length) {
      mediaOk = false;
      mediaWhy += ` ${kind}:count`;
    }
  }
  check(
    "viewer thumb/display: 200, no EXIF GPS or camera tags, not the original, Cache-Control private",
    mediaOk,
    mediaWhy,
  );
  const dl = await vDl.call<{ url: string }>("POST", `/share/photos/${pick[0]}/download`);
  const dlRes = dl.body.url ? await fetch(dl.body.url) : null;
  const dlBuf = dlRes ? Buffer.from(await dlRes.arrayBuffer()) : Buffer.alloc(0);
  const dlExif = ((await exifr.parse(dlBuf, true).catch(() => undefined)) ?? {}) as Record<
    string,
    unknown
  >;
  check(
    "L-dl download: 200, attachment, no GPS/camera tags",
    dl.status === 200 &&
      dlRes?.status === 200 &&
      /attachment/.test(dlRes.headers.get("content-disposition") ?? "") &&
      dlExif.latitude === undefined &&
      dlExif.Make === undefined,
    `${dl.status} ${dlRes?.status}`,
  );
  const dlAll = await vAll.call("POST", `/share/photos/${seen[0]}/download`);
  check("L-all download -> 403", dlAll.status === 403, `status ${dlAll.status}`);

  const browser = await chromium.launch();
  const pageExpired = async (token: string): Promise<boolean> => {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 375, height: 812 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`/s/${token}`);
      await page
        .locator(
          '[data-testid="share-expired"],[data-testid="share-album"],[data-testid="share-passcode"]',
        )
        .first()
        .waitFor({ timeout: 20_000 });
      return (await page.locator('[data-testid="share-expired"]').count()) > 0;
    } finally {
      await ctx.close();
    }
  };
  try {
    // ---- 8. expired ------------------------------------------------------------------------
    const vMs = await viewerClient();
    const msTok = tokens[1] as string;
    check("L-ms exchanges 200 before expiry", (await vMs.exchange(msTok)).status === 200);
    await q(
      `update share_links set expires_at = now() - interval '1 minute' where id='${lMs.link.id}'`,
    );
    const exMs = await (await viewerClient()).exchange(msTok);
    check(
      "expired: exchange 410 share_link_expired",
      exMs.status === 410 && exMs.body.error === "share_link_expired",
      `${exMs.status} ${exMs.body.error}`,
    );
    const openMs = await vMs.call<{ error?: string }>("GET", "/share/album");
    check(
      "expired: open viewer cookie -> 410",
      openMs.status === 410 && openMs.body.error === "share_link_expired",
      `${openMs.status}`,
    );
    check("expired: /s/<token> shows the expired page", await pageExpired(msTok));
    const renew = await api.call("POST", `/share-links/${lMs.link.id}/renew`, {});
    check("renew -> 200", renew.status === 200, `status ${renew.status}`);
    check(
      "renewed link (same token) exchanges 200 again",
      (await (await viewerClient()).exchange(msTok)).status === 200,
    );

    // ---- 9. revoked ------------------------------------------------------------------------
    const dlTok = tokens[4] as string;
    const rev = await api.call("POST", `/share-links/${lDl.link.id}/revoke`, {});
    check("revoke -> 200", rev.status === 200, `status ${rev.status}`);
    const exDl = await (await viewerClient()).exchange(dlTok);
    check(
      "revoked: exchange 410",
      exDl.status === 410 && exDl.body.error === "share_link_expired",
      `${exDl.status} ${exDl.body.error}`,
    );
    check("revoked: open cookie -> 410", (await vDl.call("GET", "/share/album")).status === 410);
    check("revoked: /s/<token> shows the expired page", await pageExpired(dlTok));
    check(
      "revoked: renew -> 409",
      (await api.call("POST", `/share-links/${lDl.link.id}/renew`, {})).status === 409,
    );

    // ---- 10. regenerated -------------------------------------------------------------------
    const regen = await api.call<Created>("POST", `/share-links/${lManual.link.id}/regenerate`, {});
    check("regenerate -> 200 with a new URL", regen.status === 200 && !!regen.body.url);
    const newTok = tokenOf(regen.body.url);
    tokens.push(newTok);
    const oldEx = await (await viewerClient()).exchange(manTok, PASSCODE);
    check(
      "regenerated: old token 410",
      oldEx.status === 410 && oldEx.body.error === "share_link_expired",
      `${oldEx.status}`,
    );
    check("regenerated: old cookie 410", (await vMan.call("GET", "/share/album")).status === 410);
    check("regenerated: old /s/<token> shows the expired page", await pageExpired(manTok));
    check(
      "regenerated: new token -> passcode_required",
      (await (await viewerClient()).exchange(newTok)).body.error === "passcode_required",
    );

    // ---- 11. passcode lockout --------------------------------------------------------------
    const lockTok = tokens[5] as string;
    const ip = (n: number) => `203.0.113.${n}`;
    const wrong: number[] = [];
    for (let i = 0; i < 5; i++)
      wrong.push((await (await viewerClient()).exchange(lockTok, "000000", ip(1))).status);
    check(
      "5 wrong passcodes answer 401",
      wrong.every((s) => s === 401),
      wrong.join(","),
    );
    const sixth = await (await viewerClient()).exchange(lockTok, PASSCODE, ip(1));
    check(
      "6th try (right code, same IP) -> 429 rate_limited",
      sixth.status === 429 && sixth.body.error === "rate_limited",
      `${sixth.status} ${sixth.body.error}`,
    );
    for (const n of [2, 3, 4])
      for (let i = 0; i < 5; i++) await (await viewerClient()).exchange(lockTok, "000000", ip(n));
    const locked = await (await viewerClient()).exchange(lockTok, PASSCODE, ip(5));
    check(
      "20 failures across 4 IPs: right code from a 5th IP -> 429 passcode_locked",
      locked.status === 429 && locked.body.error === "passcode_locked",
      `${locked.status} ${locked.body.error}`,
    );
    const regenLock = await api.call<Created>(
      "POST",
      `/share-links/${lLock.link.id}/regenerate`,
      {},
    );
    tokens.push(tokenOf(regenLock.body.url));
    const afterRegen = await (await viewerClient()).exchange(
      tokenOf(regenLock.body.url),
      PASSCODE,
      ip(6),
    );
    check("regenerate clears the lock", afterRegen.status === 200, `status ${afterRegen.status}`);

    // ---- 12. scope -------------------------------------------------------------------------
    const parentRoutes = [
      ["GET", `/babies/${paid}/photos`],
      ["GET", `/babies/${paid}/share-links`],
      ["POST", `/babies/${paid}/chat/messages`, { text: "hi" }],
      ["GET", `/photos/${seen[0]}/original`],
      ["GET", "/me"],
    ] as const;
    const codes: number[] = [];
    for (const [m, p, body] of parentRoutes) codes.push((await vAll.call(m, p, body)).status);
    check(
      "viewer cookie on parent routes -> 401",
      codes.every((c) => c === 401),
      codes.join(","),
    );
    const html = await fetch(`${BASE}/s/${tokens[0]}`);
    const text = await html.text();
    // The meta is added by the page's own script (useShareHead), so the raw shell has none; the
    // rendered DOM is asserted in share.spec.ts and the header in smoke (nginx).
    check(
      "/s/<token> serves the app shell",
      html.status === 200 && text.includes('<div id="root">'),
    );
    if (/nginx/i.test(html.headers.get("server") ?? "")) {
      check(
        "/s/<token> sends Referrer-Policy: no-referrer",
        html.headers.get("referrer-policy") === "no-referrer",
      );
    } else {
      console.log(
        "      (dev Vite serves the shell: Referrer-Policy header is checked against nginx in e2e/smoke/dev-stack.sh)",
      );
    }

    // ---- 9b. a media URL issued before the revoke dies with the 30 s TTL ----------------------
    if (issuedUrl) {
      await sleep(Math.max(0, issuedAt + 35_000 - Date.now()));
      const late = await fetch(issuedUrl);
      await late.arrayBuffer();
      check(
        "revoked: a media URL issued before the revoke -> 403 after 35 s",
        late.status === 403,
        `status ${late.status}`,
      );
    }

    // ---- 13. logs ---------------------------------------------------------------------------
    const logs = (await dc(["logs", "--no-color", "--since", startedAt, "api", "worker"])).stdout;
    const hits: string[] = [];
    for (const t of tokens) if (logs.includes(t)) hits.push("token");
    if (new RegExp(`\\b${PASSCODE}\\b`).test(logs)) hits.push("passcode");
    if (/X-Amz-Signature/i.test(logs)) hits.push("X-Amz-Signature");
    if (/"?latitude"?|GPSLatitude/i.test(logs)) hits.push("latitude");
    for (const c of new Set(GPS_COORDS)) if (logs.includes(c)) hits.push(`coordinate ${c}`);
    check(
      "no token, passcode, X-Amz-Signature or GPS in api/worker logs",
      hits.length === 0,
      hits.join(","),
    );
  } finally {
    await browser.close().catch(() => undefined);
    await vAll.ctx.dispose();
  }

  if (!KEEP) {
    await api.signIn().catch(() => undefined); // trashing needs a fresh sign-in
    for (const b of [paid, free]) await api.call("DELETE", `/babies/${b}`).catch(() => undefined);
  }
  await api.dispose();
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "recreating api (SHARE_MEDIA_URL_TTL_SEC=30) and worker (fake provider, flush 0) ...",
  );
  const startedMs = Date.now();
  try {
    await recreate("api", { SHARE_MEDIA_URL_TTL_SEC: "30" });
    await recreate(
      "worker",
      { VISION_PROVIDER: "fake", AI_BATCH_FLUSH_MINUTES: "0" },
      /AI enabled: provider=fake vision=/,
    );
    await guarded("gate", run);
  } finally {
    console.log("restoring api and worker to the stack default ...");
    await dc(["up", "-d", "--no-deps", "api", "worker"]).catch((e) =>
      console.error(`restore failed: ${e}`),
    );
    await recreate("api", {}).catch(() => undefined);
  }
  const failed = results.filter((r) => !r.ok);
  writeFileSync(
    path.join(OUT_DIR, "results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        seconds: Math.round((Date.now() - startedMs) / 1000),
        passed: results.length - failed.length,
        failed: failed.length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
    process.exit(1);
  }
  console.log("SHARE GATE PASSED");
}

main().catch((e) => {
  console.error("gate crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
