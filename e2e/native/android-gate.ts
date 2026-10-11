/**
 * Step-9 Android gate (docs/plans/step-9.md 2.15 "Android gate", 4.4). Needs a BOOTED emulator or a
 * device with USB debugging (`adb devices` must list one); without one it exits 2 with these steps.
 * Written without a device in the authoring sandbox (no HVF there): the first run on a real emulator
 * may need selector tweaks, and every step is guarded so one failure does not hide the others.
 *
 * How to run (from the repo root, in a normal terminal, outside any sandbox):
 *
 *   export PATH="$HOME/.cache/littlelight-pnpm/bin:$HOME/Library/Android/sdk/platform-tools:$PATH"
 *   docker compose -f docker-compose.dev.yml up -d --wait                 # dev stack, fake AI
 *   ~/Library/Android/sdk/emulator/emulator -avd ll-api36 -no-snapshot-save &   # wait for the home screen
 *   adb wait-for-device && adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 2; done'
 *   bash .github/scripts/restart-api.sh                                    # resets the sign-in throttle
 *   pnpm e2e:native-android
 *
 * Options (environment): ANDROID_GATE_SKIP_BUILD=1 reuse the existing debug APK;
 * ANDROID_GATE_JAVA_HOME=<JDK 21> (default $HOME/.asdf/installs/java/temurin-21.0.12+101.0.LTS);
 * ANDROID_SERIAL=<serial> when several devices are attached.
 *
 * What it does: builds the debug APK with JDK 21 and CAP_DEV_MIXED_CONTENT=1 set before `cap sync`
 * (the WebView origin is https://localhost and the dev API is http), checks the APK's permissions and
 * backup flag, `adb reverse`s 8080 and 9000, installs, then drives the WebView with Playwright
 * `_android` (CDP): native transport and Keystore storage, relaunch, https and custom-scheme
 * deep-link intents (/s and /invite), a 3-photo background upload through the system Photo Picker
 * (uiautomator taps; the manual fallback is printed), offline photo, push-disabled launch (the debug
 * build has no FCM, so no permission prompt and no device row), sign-out wipe, and a logcat scan.
 * Writes e2e/native-results/android.json and screenshots in e2e/native-results/android/.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _android, type AndroidDevice, type Page } from "@playwright/test";
import exifr from "exifr";
import { jpegWithExif } from "../../apps/worker/src/testing/exif-writer";
import { sceneJpeg } from "../../apps/worker/src/testing/images";
import { uniqueEmail } from "../helpers/api";
import { psql } from "../helpers/db";
import { demoClient, MAYA } from "../helpers/demo";
import { seenIds, waitForCode, waitForInviteToken } from "../helpers/mailpit";
import { NativeClient } from "../helpers/native";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(ROOT, "e2e/native-results");
const SHOTS = path.join(OUT_DIR, "android");
const PKG = "app.tinyglow";
const ACTIVITY = `${PKG}/.MainActivity`;
const APK = path.join(ROOT, "apps/mobile-web/android/app/build/outputs/apk/debug/app-debug.apk");
const SDK = process.env.ANDROID_HOME ?? path.join(os.homedir(), "Library/Android/sdk");
const JAVA_HOME =
  process.env.ANDROID_GATE_JAVA_HOME ??
  path.join(os.homedir(), ".asdf/installs/java/temurin-21.0.12+101.0.LTS");
const SHARE_TOKEN = "demo-grandparents-share-token";
const PROD_HOST = "https://tinyglow.app";
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n==> ${name}`);
  try {
    await fn();
  } catch (e) {
    check(`${name} (crashed)`, false, e instanceof Error ? e.message.split("\n")[0] : String(e));
  }
}

// ---- adb ---------------------------------------------------------------------------------------------
const adbBin = (): string => {
  const p = path.join(SDK, "platform-tools/adb");
  return existsSync(p) ? p : "adb";
};
async function adb(args: string[], opts: { timeout?: number } = {}): Promise<string> {
  const serial = process.env.ANDROID_SERIAL ? ["-s", process.env.ANDROID_SERIAL] : [];
  const { stdout } = await sh(adbBin(), [...serial, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    timeout: opts.timeout ?? 120_000,
  });
  return stdout;
}
const shell = (cmd: string) => adb(["shell", cmd]);

async function attachedDevices(): Promise<string[]> {
  let out = "";
  try {
    out = await sh(adbBin(), ["devices"], { timeout: 20_000 }).then((r) => r.stdout);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === "device")
    .map((p) => p[0] as string);
}

function noDeviceExit(): never {
  console.error(`
ANDROID GATE: no booted emulator or device found ("adb devices" lists none in state "device").
This gate does not boot one (the authoring sandbox has no hardware acceleration). Boot it yourself,
outside any sandbox, then rerun:

  ~/Library/Android/sdk/emulator/emulator -avd ll-api36 -no-snapshot-save &
  adb wait-for-device && adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 2; done'
  bash .github/scripts/restart-api.sh
  pnpm e2e:native-android
`);
  process.exit(2);
}

// ---- build -----------------------------------------------------------------------------------------------
async function buildApk(): Promise<void> {
  if (process.env.ANDROID_GATE_SKIP_BUILD === "1" && existsSync(APK)) {
    console.log("build skipped (ANDROID_GATE_SKIP_BUILD=1)");
    return;
  }
  if (!existsSync(path.join(JAVA_HOME, "bin/java"))) {
    throw new Error(`JDK 21 not found at ${JAVA_HOME} (set ANDROID_GATE_JAVA_HOME)`);
  }
  const env = {
    ...process.env,
    JAVA_HOME,
    ANDROID_HOME: SDK,
    PATH: `${path.join(JAVA_HOME, "bin")}:${process.env.PATH}`,
    // Before `cap sync`: the dev API is http and the WebView origin is https://localhost.
    CAP_DEV_MIXED_CONTENT: "1",
  };
  console.log("cap sync android (CAP_DEV_MIXED_CONTENT=1) ...");
  await sh("pnpm", ["--filter", "@tinyglow/mobile-web", "native:sync:android"], {
    cwd: ROOT,
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  console.log("gradlew assembleDebug (JDK 21) ...");
  await sh("./gradlew", ["assembleDebug"], {
    cwd: path.join(ROOT, "apps/mobile-web/android"),
    env,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 1_200_000,
  });
}

function aaptBin(): string | null {
  const dir = path.join(SDK, "build-tools");
  if (!existsSync(dir)) return null;
  for (const v of readdirSync(dir).sort().reverse()) {
    const p = path.join(dir, v, "aapt");
    if (existsSync(p)) return p;
  }
  return null;
}

function checkApk(): void {
  const aapt = aaptBin();
  if (!aapt) {
    console.log("aapt not found: APK permission/backup checks skipped");
    return;
  }
  const perms = execFileSync(aapt, ["dump", "permissions", APK], { encoding: "utf8" });
  const bad = perms.split("\n").filter((l) => /READ_MEDIA|EXTERNAL_STORAGE|LOCATION/.test(l));
  check("APK declares no media/storage/location permission", bad.length === 0, bad.join("; "));
  const tree = execFileSync(aapt, ["dump", "xmltree", APK, "AndroidManifest.xml"], {
    encoding: "utf8",
  });
  const backup = /allowBackup[^\n]*=\(type 0x12\)(0x\w+)/.exec(tree)?.[1];
  check("android:allowBackup is false", backup === "0x0", `value ${backup ?? "missing"}`);
}

// ---- WebView helpers ----------------------------------------------------------------------------------
let device: AndroidDevice;
const pids = new Set<string>();

async function appPid(): Promise<string | null> {
  const out = (await shell(`pidof ${PKG}`).catch(() => "")).trim();
  const pid = out.split(/\s+/)[0] ?? "";
  if (pid) pids.add(pid);
  return pid || null;
}

/** The app's WebView page (re-acquired after every navigation/relaunch). */
async function page(): Promise<Page> {
  for (const end = Date.now() + 60_000; Date.now() < end; ) {
    try {
      const wv = await device.webView({ pkg: PKG }, { timeout: 5000 });
      const p = await wv.page();
      await appPid();
      return p;
    } catch {
      await sleep(1500);
    }
  }
  throw new Error("no WebView of the app became available in 60 s");
}
const tid = (p: Page, id: string) =>
  p.locator(`.ion-page:not(.ion-page-hidden) [data-testid="${id}"]`).first();

async function launch(): Promise<void> {
  await shell(`am start -W -n ${ACTIVITY}`);
  await sleep(2500);
}
async function relaunch(): Promise<void> {
  await shell(`am force-stop ${PKG}`);
  await sleep(1000);
  await launch();
}
async function startLink(url: string): Promise<void> {
  await shell(`am start -W -a android.intent.action.VIEW -d '${url}' ${PKG}`);
  await sleep(2500);
}
async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const png = await sh(
    adbBin(),
    [
      ...(process.env.ANDROID_SERIAL ? ["-s", process.env.ANDROID_SERIAL] : []),
      "exec-out",
      "screencap",
      "-p",
    ],
    {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    },
  ).then((r) => r.stdout as unknown as Buffer);
  writeFileSync(path.join(SHOTS, `${name}.png`), png);
}

/** Sign in through the app's own UI (welcome -> email -> code), reading the code from Mailpit. */
async function signInInApp(p: Page, email: string): Promise<void> {
  await tid(p, "welcome-email").fill(email, { timeout: 30_000 });
  const seen = await seenIds(email);
  await tid(p, "welcome-continue").click();
  await tid(p, "verify-code").waitFor({ timeout: 30_000 });
  await tid(p, "verify-code").fill(await waitForCode(email, seen));
}

async function jwtShapedStorage(p: Page): Promise<string[]> {
  return p.evaluate(async () => {
    const hits: string[] = [];
    const looks = (s: string) => /eyJ[A-Za-z0-9_-]{10,}/.test(s);
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i) as string;
        if (looks(k) || looks(store.getItem(k) ?? "")) hits.push(`webstorage:${k}`);
      }
    }
    const dbs = (await indexedDB.databases?.()) ?? [];
    for (const d of dbs) if (d.name && looks(d.name)) hits.push(`idb:${d.name}`);
    return hits;
  });
}

async function sharedPrefsHaveSession(): Promise<number | null> {
  try {
    const out = await shell(`run-as ${PKG} sh -c 'cat shared_prefs/*.xml 2>/dev/null'`);
    return (out.match(/ll\.session/g) ?? []).length;
  } catch {
    return null; // not debuggable / run-as unavailable
  }
}

// ---- Photo Picker via uiautomator -------------------------------------------------------------------------
interface Node {
  rid: string;
  text: string;
  desc: string;
  cx: number;
  cy: number;
}
async function uiNodes(): Promise<Node[]> {
  await shell("uiautomator dump /sdcard/ll-ui.xml >/dev/null");
  const xml = await shell("cat /sdcard/ll-ui.xml");
  const nodes: Node[] = [];
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const n = m[0];
    const get = (a: string) => new RegExp(`${a}="([^"]*)"`).exec(n)?.[1] ?? "";
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);
    if (!b) continue;
    nodes.push({
      rid: get("resource-id"),
      text: get("text"),
      desc: get("content-desc"),
      cx: Math.round((Number(b[1]) + Number(b[3])) / 2),
      cy: Math.round((Number(b[2]) + Number(b[4])) / 2),
    });
  }
  return nodes;
}

/** Best effort: select the 3 newest photos in the system Photo Picker and press Add. */
async function pickThreeInPhotoPicker(): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const nodes = await uiNodes();
    const thumbs = nodes.filter((n) => /icon_thumbnail|thumbnail/i.test(n.rid));
    if (thumbs.length >= 3) {
      for (const t of thumbs.slice(0, 3)) {
        await shell(`input tap ${t.cx} ${t.cy}`);
        await sleep(600);
      }
      const after = await uiNodes();
      const add = after.find((n) => /button_add|add/i.test(n.rid) || /^(Add|Done)\b/.test(n.text));
      if (add) {
        await shell(`input tap ${add.cx} ${add.cy}`);
        return true;
      }
      return false;
    }
    await sleep(1500);
  }
  return false;
}

// ---- fixtures ------------------------------------------------------------------------------------------------
const GPS = [] as string[];
async function makeFixtures(): Promise<string[]> {
  const dir = path.join(os.tmpdir(), `ll-android-gate-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < 3; i++) {
    const lat = Number((47.6 + i / 100 + 0.0001).toFixed(4));
    const lng = Number((-122.3 - i / 100 - 0.0001).toFixed(4));
    GPS.push(lat.toFixed(4), lng.toFixed(4));
    const bytes = jpegWithExif(await sceneJpeg(1600, 1200, 985_000 + i, 85), {
      make: "GateCam",
      model: "A1",
      dateTimeOriginal: `2026:05:0${i + 1} 10:00:00`,
      gps: { lat, lng },
    });
    const f = path.join(
      dir,
      `ll-gate-${i}-${createHash("sha1").update(bytes).digest("hex").slice(0, 8)}.jpg`,
    );
    writeFileSync(f, bytes);
    files.push(f);
  }
  return files;
}

// ---- main ------------------------------------------------------------------------------------------------------
async function run(): Promise<void> {
  const email = uniqueEmail("android");
  const secrets: string[] = [SHARE_TOKEN];

  // Prepare the account over the API (native transport) so the app signs in to a ready album.
  const api = new NativeClient(email);
  await api.onboard("Android Gate");
  const babyId = await api.createBaby("Android Gate Baby");
  secrets.push(api.accessToken as string, api.refreshToken as string);

  await guarded("1. native platform, origin", async () => {
    await shell(`pm clear ${PKG}`).catch(() => "");
    await launch();
    await shot("01-launch");
    const p = await page();
    const native = await p.evaluate(
      () =>
        (
          window as unknown as { Capacitor?: { isNativePlatform(): boolean } }
        ).Capacitor?.isNativePlatform() === true,
    );
    check("Capacitor.isNativePlatform() is true", native);
    check(
      "WebView origin is https://localhost",
      new URL(p.url()).origin === "https://localhost",
      p.url(),
    );
  });

  await guarded("2. sign in with a fresh email; storage holds no token", async () => {
    const p = await page();
    await signInInApp(p, email);
    await p.waitForURL((u) => !/\/(welcome|verify)/.test(u.pathname), { timeout: 45_000 });
    await sleep(2000);
    await shot("02-signed-in");
    const cookies = await p.context().cookies();
    check(
      "no ll_ cookie (native uses bearer tokens)",
      !cookies.some((c) => c.name.startsWith("ll_")),
      cookies.map((c) => c.name).join(","),
    );
    check("document.cookie has no ll_", !(await p.evaluate(() => document.cookie)).includes("ll_"));
    const hits = await jwtShapedStorage(p);
    check(
      "localStorage/sessionStorage/IndexedDB names hold no JWT-shaped value",
      hits.length === 0,
      hits.join("; "),
    );
    const stored = await sharedPrefsHaveSession();
    check(
      "the session is in the Keystore-backed secure storage (shared_prefs)",
      stored === null ? true : stored > 0,
      stored === null ? "run-as unavailable: inconclusive" : `${stored} entries`,
    );
    const sessions = await api.call<{ sessions: { label?: string; device?: string }[] }>(
      "GET",
      "/auth/sessions",
    );
    check(
      'Devices list shows "Tinyglow app on Android"',
      JSON.stringify(sessions.body).includes("Tinyglow app on Android"),
      `status ${sessions.status}`,
    );
  });

  await guarded("3. force-stop + relaunch stays signed in (Keystore)", async () => {
    await relaunch();
    const p = await page();
    await sleep(3000);
    await shot("03-relaunch");
    check(
      "still signed in after force-stop",
      !/\/(welcome|verify)/.test(new URL(p.url()).pathname) &&
        (await tid(p, "welcome-email").count()) === 0,
      p.url(),
    );
  });

  await guarded("4. https deep link /s/<token> opens the shared album", async () => {
    await shell(
      `pm set-app-links-user-selection --user 0 --package ${PKG} true tinyglow.app`,
    ).catch(() => "");
    await startLink(`${PROD_HOST}/s/${SHARE_TOKEN}`);
    const p = await page();
    await p.waitForURL(/\/s\//, { timeout: 30_000 });
    check(
      "WebView path is /s/...",
      new URL(p.url()).pathname.startsWith("/s/"),
      new URL(p.url()).pathname.replace(/[^/]{20,}/g, "<id>"),
    );
    await p.locator('[data-testid="share-album"]').first().waitFor({ timeout: 30_000 });
    check("share-album is visible", true);
    check(
      "a hidden tile is present",
      (await p.locator('[data-testid^="share-hidden-"]').count()) > 0,
    );
    const cookies = await p.context().cookies();
    check(
      "no ll_viewer cookie (the viewer token is a bearer, in memory)",
      !cookies.some((c) => c.name === "ll_viewer"),
    );
    await shot("04-share-link");
    // the custom debug scheme as well
    await startLink(`tinyglow://s/${SHARE_TOKEN}`);
    const p2 = await page();
    check(
      "tinyglow://s/<token> reaches the shared album too",
      await p2
        .locator('[data-testid="share-album"]')
        .first()
        .waitFor({ timeout: 30_000 })
        .then(
          () => true,
          () => false,
        ),
    );
  });

  await guarded("5. invite deep link: accept, Maya listed", async () => {
    const mom = await demoClient("demo-mom");
    const seen = await seenIds(email);
    const inv = await mom.call("POST", `/babies/${MAYA}/invites`, { email, role: "contributor" });
    check("demo mom created the invite", inv.status === 201 || inv.status === 200, `${inv.status}`);
    const token = await waitForInviteToken(email, seen);
    secrets.push(token);
    await mom.dispose();
    await relaunch();
    await startLink(`${PROD_HOST}/invite/${token}`);
    const p = await page();
    await p.waitForURL(/\/invite\//, { timeout: 30_000 });
    await tid(p, "invite-accept").click({ timeout: 30_000 });
    await tid(p, "invite-joined")
      .waitFor({ timeout: 30_000 })
      .catch(() => undefined);
    await sleep(3000);
    const me = await api.call<{ babies: { name: string }[] }>("GET", "/me");
    check(
      "Maya is now in the account's albums",
      me.body.babies?.some((b) => b.name === "Maya") === true,
      JSON.stringify(me.body.babies?.map((b) => b.name)),
    );
    await shot("05-invite");
  });

  await guarded("6. background upload of 3 photos (system Photo Picker)", async () => {
    const files = await makeFixtures();
    await shell("mkdir -p /sdcard/Pictures/ll-gate");
    for (const f of files) {
      await adb(["push", f, "/sdcard/Pictures/ll-gate/"]);
      await shell(
        `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/ll-gate/${path.basename(f)} >/dev/null`,
      );
    }
    await relaunch();
    let p = await page();
    // the album the upload goes to is the gate account's own baby: select it if the switcher shows several
    await p.getByRole("button", { name: "Upload" }).first().click({ timeout: 30_000 });
    await tid(p, "upload-choose").click({ timeout: 30_000 });
    const picked = await pickThreeInPhotoPicker();
    if (!picked) {
      console.log(`
      MANUAL STEP: the Photo Picker could not be automated. In the emulator, select the 3 photos from
      Pictures/ll-gate and press Add, then press Enter here within 120 s (or just wait).`);
      await sleep(120_000);
    }
    await shot("06-picked");
    // once uploading, send the app to the background and watch the API from our own session
    await sleep(1500);
    await shell("input keyevent KEYCODE_HOME");
    const before = Date.now();
    let total = 0;
    for (const end = Date.now() + 240_000; Date.now() < end; ) {
      const r = await api.call<{ total: number }>("GET", `/babies/${babyId}/photos/summary`);
      total = r.body?.total ?? 0;
      if (total >= 3) break;
      await sleep(3000);
    }
    const fg = await shell("dumpsys activity activities | grep -m1 mResumedActivity").catch(
      () => "",
    );
    check(
      "3 photos ingested while the app is in the background",
      total >= 3 && !fg.includes(PKG),
      `${total} photos after ${Math.round((Date.now() - before) / 1000)} s; ${fg.trim().slice(0, 80)}`,
    );
    await launch();
    p = await page();
    const summary = await tid(p, "upload-summary")
      .textContent({ timeout: 20_000 })
      .catch(() => "");
    check('relaunch shows "3 uploaded"', /3\s+uploaded/.test(summary ?? ""), summary ?? "");
    await shot("06-uploaded");
    // served derivatives carry no GPS/EXIF
    const list = await api.call<{
      photos: { id: string; displayUrl: string | null; thumbUrl: string | null }[];
    }>("GET", `/babies/${babyId}/photos?limit=10`);
    let clean = list.body.photos?.length >= 3;
    for (const ph of list.body.photos ?? []) {
      for (const url of [ph.displayUrl, ph.thumbUrl]) {
        if (!url) continue;
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        const gps = await exifr.gps(buf).catch(() => undefined);
        const meta = (await exifr.parse(buf, true).catch(() => undefined)) as
          | Record<string, unknown>
          | undefined;
        if (gps || (meta && ("latitude" in meta || "GPSLatitude" in meta || "Make" in meta)))
          clean = false;
      }
    }
    check("served derivatives have no GPS/EXIF", clean);
  });

  await guarded("7. offline: a viewed photo is still shown", async () => {
    const p = await page();
    await p.getByRole("button", { name: "Timeline" }).first().click({ timeout: 20_000 });
    const tile = p
      .locator(
        ".ion-page:not(.ion-page-hidden) [data-testid^='photo-tile'], .ion-page:not(.ion-page-hidden) img",
      )
      .first();
    await tile.click({ timeout: 30_000 });
    await sleep(2500);
    await p.keyboard.press("Escape");
    await adb(["reverse", "--remove-all"]);
    await shell("cmd connectivity airplane-mode enable");
    try {
      await sleep(3000);
      await tile.click({ timeout: 20_000 });
      await sleep(2500);
      const shown = await p.evaluate(() =>
        [...document.images].some(
          (i) => i.complete && i.naturalWidth > 0 && i.offsetParent !== null,
        ),
      );
      await shot("07-offline");
      check("the photo is displayed with the network off", shown);
    } finally {
      await shell("cmd connectivity airplane-mode disable").catch(() => "");
      await adb(["reverse", "tcp:8080", "tcp:8080"]);
      await adb(["reverse", "tcp:9000", "tcp:9000"]);
      await sleep(3000);
    }
  });

  await guarded("8. push-disabled build: no prompt, no device row", async () => {
    const perms = await shell(
      `dumpsys package ${PKG} | grep -A3 "POST_NOTIFICATIONS" | head -6`,
    ).catch(() => "");
    const p = await page();
    const dialog = (await uiNodes()).some((n) => /permission_allow|Allow/.test(n.rid + n.text));
    check("no notification permission dialog is showing", !dialog);
    await p
      .getByRole("button", { name: "Settings" })
      .first()
      .click({ timeout: 20_000 })
      .catch(() => undefined);
    const row = tid(p, "settings-notifications");
    if (await row.count()) {
      await row.click();
      check(
        "Notifications page says it is unavailable in this build",
        await tid(p, "notifications-unavailable")
          .waitFor({ timeout: 15_000 })
          .then(
            () => true,
            () => false,
          ),
      );
    } else {
      check("no Notifications row (push is off in this build)", true);
    }
    const [n] = await psql(
      `select count(*) from push_devices d join auth.users u on u.id = d.user_id where u.email = '${email}'`,
    );
    check(
      "no push device row for the gate user",
      n === "0",
      `count ${n}; ${perms.trim().slice(0, 60)}`,
    );
  });

  await guarded("9. sign out wipes secure storage", async () => {
    let p = await page();
    await p.goto("https://localhost/settings");
    await tid(p, "signout-local").click({ timeout: 30_000 });
    await tid(p, "welcome-email").waitFor({ timeout: 30_000 });
    const stored = await sharedPrefsHaveSession();
    check(
      "no session entry left in shared_prefs",
      stored === null ? true : stored === 0,
      stored === null ? "run-as unavailable: inconclusive" : `${stored} entries`,
    );
    await relaunch();
    p = await page();
    check(
      "relaunch after sign-out shows the welcome page",
      await tid(p, "welcome-email")
        .waitFor({ timeout: 30_000 })
        .then(
          () => true,
          () => false,
        ),
    );
    await shot("09-signed-out");
  });

  await guarded("10. logcat scan", async () => {
    const log = await adb(["logcat", "-d", "-v", "threadtime"], { timeout: 60_000 });
    const mine = log
      .split("\n")
      .filter((l) => {
        const pid = l.trim().split(/\s+/)[2];
        return (pid !== undefined && pids.has(pid)) || /tinyglow/i.test(l);
      })
      .join("\n");
    check(
      "logcat of the app is non-empty (scan is not vacuous)",
      mine.length > 200,
      `${mine.length} bytes`,
    );
    const hits: string[] = [];
    if (/eyJ[A-Za-z0-9_-]{10,}/.test(mine)) hits.push("a JWT-shaped value");
    if (/X-Amz-Signature/i.test(mine)) hits.push("X-Amz-Signature");
    if (/token_hash/.test(mine)) hits.push("token_hash");
    if (/latitude|GPSLatitude/i.test(mine)) hits.push("latitude");
    for (const s of secrets)
      if (s && mine.includes(s)) hits.push(`a gate secret (${s.length} chars)`);
    for (const g of GPS) if (mine.includes(g)) hits.push("a GPS coordinate of a fixture");
    check(
      "logcat has no token, signed URL, share/invite token or GPS",
      hits.length === 0,
      hits.join("; "),
    );
  });

  await api.call("DELETE", `/babies/${babyId}`).catch(() => undefined);
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const startedMs = Date.now();
  const devices = await attachedDevices();
  if (devices.length === 0) noDeviceExit();
  if (devices.length > 1 && !process.env.ANDROID_SERIAL) {
    console.error(`several devices attached (${devices.join(", ")}): set ANDROID_SERIAL`);
    process.exit(2);
  }
  console.log(`device: ${process.env.ANDROID_SERIAL ?? devices[0]}`);
  await fetch(`${BASE}/api/healthz`).then((r) => {
    if (!r.ok) throw new Error(`dev stack unhealthy: ${r.status}`);
  });

  try {
    await buildApk();
    checkApk();
    await adb(["reverse", "tcp:8080", "tcp:8080"]);
    await adb(["reverse", "tcp:9000", "tcp:9000"]);
    await adb(["install", "-r", APK], { timeout: 300_000 });
    check("debug APK installed, adb reverse 8080 and 9000 set", true);
    const [d] = await _android.devices();
    if (!d)
      throw new Error("Playwright _android sees no device (is adb running on 127.0.0.1:5037?)");
    device = d;
    await run();
  } catch (e) {
    check("gate crashed", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    await shell("cmd connectivity airplane-mode disable").catch(() => "");
    await device?.close().catch(() => undefined);
  }
  const failed = results.filter((r) => !r.ok);
  writeFileSync(
    path.join(OUT_DIR, "android.json"),
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
  console.log(`\nandroid gate: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
