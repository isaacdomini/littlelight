// Visual check for Settings -> About and the live-update states (step 14, task 14.8). Runs the
// real web app in Chromium; the native scenes force Capacitor to "ios"/"android" with a scripted
// `TinyglowUpdater` + secure-storage bridge (no device). The whole API is mocked with Playwright
// routes (no dev stack). Start a Vite dev server whose API origin is itself, so the native
// scenes' absolute API URLs stay same-origin and hit the mocks:
//
//   VITE_API_URL=http://localhost:5199 pnpm --filter @tinyglow/mobile-web exec vite --port 5199
//   E2E_BASE_URL=http://localhost:5199 pnpm exec tsx apps/mobile-web/scripts/screenshots-about.ts [--scheme=dark] [--size=phone] [--scene=a,b]
//
// Output next to the other shots: apps/mobile-web/.vite/screenshots/<scheme>-<size>/about-*.png

import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, expect, type Page, type Route } from "@playwright/test";
import { MAYA } from "../../../e2e/helpers/demo";
import { tid } from "../../../e2e/helpers/ui";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5199";
const OUT = path.resolve(import.meta.dirname, "../.vite/screenshots");
const SIZES = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const schemes = (arg("scheme")?.split(",") ?? ["light", "dark"]) as ("light" | "dark")[];
const only = arg("scene")?.split(",");
const sizes = (arg("size")?.split(",") ?? ["phone", "desktop"]) as (keyof typeof SIZES)[];

const USER = "00000000-0000-4000-8000-000000000001";
const BUILTIN = "8e57d4275c1be184";
const NEXT = "3fa91c0d77e2b5a6";

interface Info {
  nativeVersion: string;
  nativeBuild: number;
  builtinVersion: string;
  currentVersion: string;
  currentSource: "builtin" | "ota";
  stagedVersion: string | null;
  androidPushConfigured: boolean;
}

interface Scene {
  name: string;
  /** `null`: the browser (no Capacitor). */
  platform: "ios" | "android" | null;
  info?: Info;
  /** Server answer: an envelope (then `stage` decides) or a reason. */
  server?: "update" | "up_to_date" | "native_too_old" | "disabled";
  /** `hang`: `stage()` never settles (the "Downloading" state). */
  stage?: string;
  /** Press "Check for updates" before the shot. */
  check?: boolean;
  /** An upload in progress (Restart disabled). */
  busy?: boolean;
  /** Open the reset confirmation. */
  resetSheet?: boolean;
}

const builtin: Info = {
  nativeVersion: "1.0.0",
  nativeBuild: 12,
  builtinVersion: BUILTIN,
  currentVersion: BUILTIN,
  currentSource: "builtin",
  stagedVersion: null,
  androidPushConfigured: true,
};
const staged: Info = { ...builtin, stagedVersion: NEXT };
const ota: Info = { ...builtin, currentVersion: NEXT, currentSource: "ota" };

const SCENES: Scene[] = [
  { name: "web", platform: null },
  { name: "native-builtin", platform: "ios", info: builtin },
  { name: "native-uptodate", platform: "ios", info: builtin, server: "up_to_date", check: true },
  {
    name: "native-downloading",
    platform: "ios",
    info: builtin,
    server: "update",
    stage: "hang",
    check: true,
  },
  {
    name: "native-ready",
    platform: "ios",
    info: builtin,
    server: "update",
    stage: "staged",
    check: true,
  },
  { name: "native-ready-busy", platform: "ios", info: staged, busy: true },
  {
    name: "native-updated-wifi",
    platform: "ios",
    info: ota,
    server: "update",
    stage: "wifi_required",
    check: true,
  },
  {
    name: "native-too-old",
    platform: "android",
    info: builtin,
    server: "native_too_old",
    check: true,
  },
  {
    name: "native-verify-failed",
    platform: "ios",
    info: ota,
    server: "update",
    stage: "verify_failed",
    check: true,
  },
  { name: "native-reset-confirm", platform: "ios", info: ota, resetSheet: true },
];

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64url({ alg: "none" })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 86_400 })}.sig`;

/** A string, not a function: tsx would inject helpers that do not exist in the page. */
function bridgeScript(s: Scene): string {
  return `(() => {
  const S = ${JSON.stringify({ info: s.info, stage: s.stage ?? "up_to_date", next: NEXT })};
  const P = ${JSON.stringify(s.platform)};
  let info = S.info;
  const session = JSON.stringify(JSON.stringify({ accessToken: ${JSON.stringify(JWT)}, refreshToken: "r" }));
  localStorage.setItem("capacitor-storage_ll.session.v1", session);
  const upd = ["info","stage","notifyAppReady","applyNow","reset"];
  const sec = ["internalGetItem","internalSetItem","internalRemoveItem","internalClearItemsWithPrefix","internalGetPrefixedKeys","setSynchronizeKeychain"];
  const mem = {};
  const cap = {
    isNativePlatform: () => true, getPlatform: () => P, convertFileSrc: (x) => x,
    PluginHeaders: [
      { name: "TinyglowUpdater", methods: upd.map((n) => ({ name: n, rtype: "promise" })) },
      { name: "SecureStorage", methods: sec.map((n) => ({ name: n, rtype: "promise" })) },
    ],
    nativePromise: (plugin, method, o) => {
      if (plugin === "SecureStorage") {
        if (method === "internalGetItem") {
          const k = o.prefixedKey;
          if (k.endsWith("ll.session.v1")) return Promise.resolve({ data: session });
          return Promise.resolve({ data: k in mem ? mem[k] : null });
        }
        if (method === "internalSetItem") { mem[o.prefixedKey] = o.data; return Promise.resolve(); }
        if (method === "internalRemoveItem") { delete mem[o.prefixedKey]; return Promise.resolve({ success: true }); }
        return Promise.resolve({ keys: [] });
      }
      if (plugin === "TinyglowUpdater") {
        switch (method) {
          case "info": return Promise.resolve(info);
          case "stage":
            if (S.stage === "hang") return new Promise(() => {});
            if (S.stage === "staged") info = { ...info, stagedVersion: S.next };
            return Promise.resolve({ outcome: S.stage, version: S.next, bytes: 812345 });
          default: return Promise.resolve({});
        }
      }
      return Promise.reject(new Error("not implemented"));
    },
    nativeCallback: () => {},
  };
  for (const k of ["isNativePlatform", "getPlatform", "convertFileSrc", "nativePromise", "nativeCallback", "PluginHeaders"]) {
    const v = cap[k];
    Object.defineProperty(cap, k, { configurable: true, enumerable: true, get: () => v, set: () => {} });
  }
  Object.defineProperty(window, "Capacitor", { configurable: true, get: () => cap, set: () => {} });
})();`;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const baby = {
  id: MAYA,
  name: "Maya",
  nickname: null,
  birthDate: "2026-01-15",
  plan: "plus",
  role: "admin",
};

async function mockApi(page: Page, s: Scene) {
  await page.route(
    (u) => u.pathname.startsWith("/api/"),
    (r) => json(r, { error: "not_found", message: "Not found", requestId: "r" }, 404),
  );
  await page.route("**/api/auth/config", (r) =>
    json(r, {
      providers: { apple: false, google: false },
      turnstileSiteKey: null,
      termsVersion: "1",
      privacyVersion: "1",
      passkeys: false,
    }),
  );
  await page.route("**/api/me", (r) =>
    json(r, {
      user: { id: USER, email: "mom@example.com" },
      profile: {
        userId: USER,
        displayName: "Sam",
        relationshipLabel: "Mom",
        timezone: "America/New_York",
        units: "metric",
        termsVersion: "1",
        privacyVersion: "1",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        notifyPhotosAnalyzed: true,
        notifyShareViewed: true,
      },
      consent: { ok: true, requiredTermsVersion: "1", requiredPrivacyVersion: "1" },
      profileComplete: true,
      babies: [baby],
      session: { createdAt: new Date().toISOString(), isFresh: true },
    }),
  );
  await page.route(`**/api/babies/${MAYA}`, (r) =>
    json(r, {
      ...baby,
      birthDateIsDueDate: false,
      birthWeightG: null,
      birthLengthMm: null,
      avatarPhotoId: null,
      createdAt: "2026-01-15T00:00:00.000Z",
      deletedAt: null,
      freeTier: null,
    }),
  );
  await page.route("**/api/app-update/manifest*", (r) =>
    s.server === "update"
      ? json(r, {
          update: { manifestJson: '{"schema":1}', signature: "MEUCIQDexample==", keyId: "dev" },
        })
      : json(r, { update: null, reason: s.server ?? "up_to_date" }),
  );
}

async function scene(page: Page, s: Scene) {
  await mockApi(page, s);
  await page.goto("/settings/about");
  await expect(tid(page, "about")).toBeVisible({ timeout: 20_000 });
  if (s.platform) await expect(tid(page, "about-app-version")).toBeVisible({ timeout: 10_000 });
  if (s.busy) {
    // An upload on the user lane, injected into the app's own manager instance (Vite serves the
    // same module URL the app imported).
    await page.evaluate(`(async () => {
      // After an HMR edit the app imports it with a "?t=" stamp: reuse its exact URL.
      const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/lib/upload/manager.ts")) ?? "/src/lib/upload/manager.ts";
      const m = await import(url);
      const um = m.uploadManager;
      um.snapshot = [{ clientId: "c1", lane: "user", babyId: "${MAYA}", name: "IMG_0001.jpg", size: 1, kind: "photo", wifiOnly: false, state: "uploading", progress: 0.4, error: null, retryable: false }];
      for (const l of um.listeners) l();
    })()`);
    await expect(tid(page, "about-restart")).toBeDisabled();
  }
  if (s.check) {
    await tid(page, "about-check").click();
    if (s.stage === "hang")
      await expect(tid(page, "about-outcome")).toHaveAttribute("data-outcome", "downloading");
    else if (s.stage === "staged") await expect(tid(page, "about-ready")).toBeVisible();
    else await expect(tid(page, "about-outcome")).toBeVisible();
  }
  if (s.resetSheet) {
    await tid(page, "about-reset").click();
    await expect(page.getByRole("button", { name: "Reset", exact: true })).toBeVisible();
  }
  await page.waitForTimeout(500);
}

async function run(browser: Browser, scheme: "light" | "dark", size: keyof typeof SIZES) {
  const dir = path.join(OUT, `${scheme}-${size}`);
  mkdirSync(dir, { recursive: true });
  console.log(`\n${scheme} ${size}`);
  for (const s of SCENES) {
    if (only && !only.includes(s.name)) continue;
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: SIZES[size],
      colorScheme: scheme,
      reducedMotion: "reduce",
      isMobile: size === "phone",
      hasTouch: size === "phone",
    });
    await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
    if (s.platform) await ctx.addInitScript(bridgeScript(s));
    const page = await ctx.newPage();
    try {
      await scene(page, s);
      await page.screenshot({ path: path.join(dir, `about-${s.name}.png`) });
      console.log("  ", `${scheme}-${size}/about-${s.name}.png`);
    } catch (e) {
      await page.screenshot({ path: path.join(dir, `about-${s.name}-FAILED.png`) });
      console.log(`   !! ${s.name}: ${(e as Error).message.split("\n")[0]}`);
    }
    await ctx.close();
  }
}

const browser = await chromium.launch();
try {
  for (const scheme of schemes) for (const size of sizes) await run(browser, scheme, size);
} finally {
  await browser.close();
}
