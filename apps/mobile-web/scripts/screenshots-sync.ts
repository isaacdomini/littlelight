// Visual check for Apple Photos album sync (step 10, task 10.11). Runs the real web app in
// Chromium with Capacitor forced to "ios" and a scripted `TinyglowPhotoSync` + secure-storage
// bridge (no device needed); the import API is mocked with Playwright routes, the parent session
// is the cached demo one from screenshots.ts. Output next to the other shots:
// apps/mobile-web/.vite/screenshots/<scheme>-<size>/sync-*.png
//
//   pnpm exec tsx apps/mobile-web/scripts/screenshots-sync.ts [--scheme=dark] [--size=phone]

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, expect, type Page, type Route } from "@playwright/test";
import { ApiClient } from "../../../e2e/helpers/api";
import { MAYA } from "../../../e2e/helpers/demo";
import { tid } from "../../../e2e/helpers/ui";

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const OUT = path.resolve(import.meta.dirname, "../.vite/screenshots");
const SIZES = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const schemes = (arg("scheme")?.split(",") ?? ["light", "dark"]) as ("light" | "dark")[];
const sizes = (arg("size")?.split(",") ?? ["phone", "desktop"]) as (keyof typeof SIZES)[];

const SOURCE_ID = "00000000-0000-4000-8000-000000000a01";
const now = Date.now();

interface Mock {
  auth: string;
  wifi: boolean;
  lowPower: boolean;
  /** `idle`: nothing pending. `hang`: 50 pending, the export never finishes (shows "Syncing"). */
  pending: "idle" | "hang";
  config: boolean;
  paused?: boolean;
}

function serverSource(over: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    babyId: MAYA,
    userId: "00000000-0000-4000-8000-000000000b01",
    userName: "Maya's mom",
    kind: "apple_photos",
    deviceId: "00000000-0000-4000-8000-000000000c01",
    deviceLabel: "iPhone",
    albumTitle: "Maya 2026",
    wifiOnly: true,
    paused: false,
    isMine: true,
    isThisDevice: true,
    lastSyncAt: new Date(now - 12 * 60_000).toISOString(),
    lastTrigger: "resume",
    importedCount: 1240,
    duplicateCount: 18,
    failedCount: 2,
    skippedCount: 3,
    lastError: null,
    createdAt: new Date(now - 30 * 86_400_000).toISOString(),
    ...over,
  };
}

/** A string, not a function: tsx would inject helpers that do not exist in the page. */
function bridgeScript(m: Mock, token: string): string {
  const cfg = {
    sourceId: SOURCE_ID,
    babyId: MAYA,
    albumId: "ALBUM-1",
    albumTitle: "Maya 2026",
    wifiOnly: true,
    paused: m.paused === true,
  };
  return `(() => {
  const M = ${JSON.stringify(m)};
  const CFG = ${JSON.stringify(cfg)};
  // Capacitor core picks its internal platform from the native bridge globals, so in Chromium the
  // secure-storage plugin falls back to its web implementation (localStorage, "capacitor-storage_").
  localStorage.setItem("capacitor-storage_ll.session.v1", JSON.stringify(JSON.stringify({ accessToken: ${JSON.stringify(token)}, refreshToken: "r" })));
  localStorage.removeItem("capacitor-storage_ll.sync.v1");
  if (M.config) {
    localStorage.setItem("ll.sync.on", "1");
    localStorage.setItem("capacitor-storage_ll.sync.v1", JSON.stringify(JSON.stringify(CFG)));
  } else localStorage.removeItem("ll.sync.on");
  const mem = {};
  const names = ["authorizationStatus","requestAuthorization","listAlbums","listPendingAssets","exportAssets","discardFiles","recordOutcomes","ledgerSummary","resetLedger","conditions","scheduleBackgroundRefresh","completeBackgroundTask","addListener","removeListener"];
  const sec = ["internalGetItem","internalSetItem","internalRemoveItem","internalClearItemsWithPrefix","internalGetPrefixedKeys","setSynchronizeKeychain"];
  const albums = [["Maya 2026", 1240],["Hospital", 86],["Grandma visit", 212],["Park days", 64],["Bath time", 31]].map((a, i) => ({ id: "ALBUM-" + (i + 1), title: a[0], count: a[1] }));
  const cap = {
    isNativePlatform: () => true, getPlatform: () => "ios", convertFileSrc: (x) => x,
    PluginHeaders: [
      { name: "TinyglowPhotoSync", methods: names.map((n) => ({ name: n, rtype: "promise" })) },
      { name: "SecureStorage", methods: sec.map((n) => ({ name: n, rtype: "promise" })) },
    ],
    nativePromise: (plugin, method, o) => {
      if (plugin === "SecureStorage") {
        if (method === "internalGetItem") {
          const k = o.prefixedKey;
          if (!(k in mem) && k.endsWith("ll.sync.v1") && M.config) mem[k] = JSON.stringify(JSON.stringify(CFG));
          return Promise.resolve({ data: k in mem ? mem[k] : null });
        }
        if (method === "internalSetItem") { mem[o.prefixedKey] = o.data; return Promise.resolve(); }
        if (method === "internalRemoveItem") { delete mem[o.prefixedKey]; return Promise.resolve({ success: true }); }
        return Promise.resolve({ keys: [] });
      }
      switch (method) {
        case "authorizationStatus": return Promise.resolve({ status: M.auth });
        case "requestAuthorization": M.auth = "authorized"; return Promise.resolve({ status: "authorized" });
        case "listAlbums": return Promise.resolve({ albums });
        case "listPendingAssets":
          return M.pending === "hang"
            ? Promise.resolve({ assets: Array.from({ length: 50 }, (_, i) => ({ id: "A" + i, createdAt: null })), remaining: 1190, albumExists: true })
            : Promise.resolve({ assets: [], remaining: 0, albumExists: true });
        case "exportAssets": return new Promise(() => {});
        case "conditions": return Promise.resolve({ wifi: M.wifi, expensive: !M.wifi, lowPowerMode: M.lowPower, thermalState: "nominal" });
        case "addListener": return Promise.resolve("cb-" + Math.random());
        default: return Promise.resolve({});
      }
    },
    nativeCallback: () => {},
  };
  // @capacitor/core assigns its own getPlatform/isNativePlatform/nativePromise onto this object;
  // accessors with no-op setters keep ours.
  for (const k of ["isNativePlatform", "getPlatform", "convertFileSrc", "nativePromise", "nativeCallback", "PluginHeaders"]) {
    const v = cap[k];
    Object.defineProperty(cap, k, { configurable: true, enumerable: true, get: () => v, set: () => {} });
  }
  Object.defineProperty(window, "Capacitor", { configurable: true, get: () => cap, set: () => {} });
})();`;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page: Page, source: Record<string, unknown> | null) {
  await page.route("**/api/me/import-sources*", (r) =>
    json(r, { sources: source ? [source] : [] }),
  );
  await page.route("**/api/babies/*/import-sources", (r) =>
    json(r, { source: serverSource() }, 201),
  );
  await page.route("**/api/import-sources/*", (r) =>
    r.request().method() === "DELETE"
      ? r.fulfill({ status: 204 })
      : json(r, { source: source ?? serverSource() }),
  );
}

async function run(browser: Browser, scheme: "light" | "dark", size: keyof typeof SIZES) {
  const dir = path.join(OUT, `${scheme}-${size}`);
  mkdirSync(dir, { recursive: true });
  const saved = JSON.parse(readFileSync(path.join(OUT, ".auth", "mom.json"), "utf8"));
  const api = await ApiClient.create(saved.email, saved.state);
  await api.call("GET", "/me");
  const token = (await api.storageState()).cookies.find((x) => x.name === "ll_access")?.value;
  console.log(`\n${scheme} ${size}`);

  const open = async (
    m: Mock,
    source: Record<string, unknown> | null,
    url: string,
    ready: string,
  ) => {
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: SIZES[size],
      colorScheme: scheme,
      reducedMotion: "reduce",
      isMobile: size === "phone",
      hasTouch: size === "phone",
    });
    await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
    await ctx.addInitScript(bridgeScript(m, token ?? ""));
    if (token) {
      await ctx.route("**/api/**", (route) =>
        route.continue({
          headers: { ...route.request().headers(), authorization: `Bearer ${token}` },
        }),
      );
    }
    const page = await ctx.newPage();
    page.on("console", (m) => console.log("   console:", m.text().slice(0, 160)));
    await mockApi(page, source);
    await page.goto(url);
    try {
      await expect(tid(page, ready)).toBeVisible({ timeout: 20_000 });
    } catch (e) {
      await page.screenshot({ path: path.join(dir, "sync-debug.png") });
      console.log(
        "   debug:",
        await page
          .evaluate(
            `(async () => { try { const k = await import("/src/platform/native/secureKv.ts"); const ss = await import("@aparajita/capacitor-secure-storage"); let raw; try { raw = await ss.SecureStorage.get("ll.sync.v1", false, false); } catch (e) { raw = "ERR " + String(e) + " " + (e && e.message); } const m = await import("/src/platform/native/photoSync.ts"); await m.photoSync.load(); return JSON.stringify({ flag: localStorage.getItem("ll.sync.on"), raw, st: m.photoSync.getStatus() }); } catch (e) { return "ERR " + String(e); } })()`,
          )
          .catch((x) => String(x)),
      );
      throw e;
    }
    return { ctx, page };
  };
  const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(dir, `sync-${name}.png`) });
    console.log("  ", `${scheme}-${size}/sync-${name}.png`);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.log(`   !! ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  const base: Mock = {
    auth: "authorized",
    wifi: true,
    lowPower: false,
    pending: "idle",
    config: true,
  };

  await step("upload-empty+sheet", async () => {
    const { ctx, page } = await open(
      { ...base, config: false, auth: "notDetermined" },
      null,
      "/upload",
      "sync-card",
    );
    await shot(page, "upload-empty");
    await tid(page, "sync-setup-open").click();
    await expect(tid(page, "sync-allow")).toBeVisible();
    await shot(page, "sheet-access");
    await tid(page, "sync-allow").click();
    await expect(tid(page, "sync-albums")).toBeVisible();
    await tid(page, "sync-albums").locator("label").first().click();
    await shot(page, "sheet-albums");
    await ctx.close();
  });
  await step("sheet-limited", async () => {
    const { ctx, page } = await open(
      { ...base, config: false, auth: "limited" },
      null,
      "/upload",
      "sync-card",
    );
    await tid(page, "sync-setup-open").click();
    await expect(tid(page, "sync-recheck")).toBeVisible();
    await shot(page, "sheet-limited");
    await ctx.close();
  });
  await step("upload-active", async () => {
    const { ctx, page } = await open(base, serverSource(), "/upload", "sync-status");
    await expect(tid(page, "sync-status")).toContainText("Up to date");
    await shot(page, "upload-active");
    await ctx.close();
  });
  const states: [string, Partial<Mock>, Record<string, unknown>, RegExp][] = [
    ["settings-uptodate", {}, {}, /Up to date/],
    ["settings-syncing", { pending: "hang" }, {}, /Syncing 0 of 1,?240|Syncing/],
    ["settings-wifi", { wifi: false }, {}, /Wi-Fi/],
    ["settings-lowpower", { lowPower: true }, {}, /Low Power/],
    ["settings-paused", { paused: true }, { paused: true }, /Paused/],
    ["settings-free-limit", {}, { lastError: "free_tier_limit" }, /Free album is full/],
    ["settings-permission", { auth: "denied" }, {}, /Allow full photo access/],
  ];
  for (const [name, over, src, text] of states) {
    await step(name, async () => {
      const { ctx, page } = await open(
        { ...base, ...over },
        serverSource(src),
        "/settings/import",
        "sync-status",
      );
      await expect(tid(page, "sync-status")).toContainText(text, { timeout: 10_000 });
      await shot(page, name);
      await ctx.close();
    });
  }
  await step("settings-list", async () => {
    const { ctx, page } = await open(base, serverSource(), "/settings", "settings");
    await expect(tid(page, "settings-import")).toBeVisible();
    await shot(page, "settings-list");
    await ctx.close();
  });
  await step("stop-confirm", async () => {
    const { ctx, page } = await open(base, serverSource(), "/settings/import", "sync-stop");
    await tid(page, "sync-stop").click();
    await page.waitForTimeout(600);
    await shot(page, "stop-confirm");
    await ctx.close();
  });
  await api.dispose();
}

const browser = await chromium.launch();
for (const scheme of schemes) for (const size of sizes) await run(browser, scheme, size);
await browser.close();
