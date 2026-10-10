// Visual check for Google Photos import (step 10, task 10.12). The real web app in Chromium with
// the import API mocked by Playwright routes (the live path is scripts/live-google-import.ts);
// parent sessions are the cached demo ones from screenshots.ts. Output next to the other shots:
// apps/mobile-web/.vite/screenshots/<scheme>-<size>/google-*.png
//
//   pnpm exec tsx apps/mobile-web/scripts/screenshots-google.ts [--scheme=dark] [--size=phone]

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

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const bid = (n: number) => `00000000-0000-4000-8000-0000000007${String(n).padStart(2, "0")}`;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function batch(n: number, over: Record<string, unknown> = {}) {
  return {
    id: bid(n),
    babyId: MAYA,
    kind: "google_picker",
    status: "done",
    error: null,
    requestedBy: "00000000-0000-4000-8000-000000000b01",
    requestedByName: "Maya's mom",
    isMine: true,
    itemsTotal: 1240,
    itemsImported: 1180,
    itemsDuplicate: 41,
    itemsFailed: 2,
    itemsSkipped: 17,
    pollIntervalSec: 3,
    pickerExpiresAt: null,
    createdAt: iso(now - 3_600_000),
    startedAt: iso(now - 3_500_000),
    finishedAt: iso(now - 3_000_000),
    ...over,
  };
}

interface Scene {
  connection: Record<string, unknown> | null; // null: provider off
  recent: unknown[];
  /** Batch returned by POST create and GET poll. */
  current?: unknown;
  createError?: [number, string];
}
const conn = (over: Record<string, unknown> = {}) => ({
  available: true,
  connected: true,
  connectedAt: iso(now - 2 * 86_400_000),
  needsReconnect: false,
  ...over,
});

async function mock(page: Page, s: Scene) {
  await page.route("**/api/me/import/google/connection", (r) =>
    s.connection
      ? json(r, s.connection)
      : json(r, { error: "feature_unavailable", message: "off", requestId: "r" }, 404),
  );
  await page.route(/\/api\/babies\/[^/]+\/imports(\?.*)?$/, (r) => json(r, { batches: s.recent }));
  await page.route("**/api/babies/*/imports/google", (r) =>
    s.createError
      ? json(r, { error: s.createError[1], message: "x", requestId: "r" }, s.createError[0])
      : json(r, { batch: s.current, pickerUri: "http://localhost:18099/picker/fake" }, 201),
  );
  await page.route("**/api/imports/*", (r) => json(r, { batch: s.current }));
  // The picker / consent tab the app opens: nothing to show here.
  await page.context().route("http://localhost:18099/**", (r) => r.abort());
}

async function run(browser: Browser, scheme: "light" | "dark", size: keyof typeof SIZES) {
  const dir = path.join(OUT, `${scheme}-${size}`);
  mkdirSync(dir, { recursive: true });
  const clients = new Map<string, ApiClient>();
  const client = async (who: "mom" | "nanny") => {
    let c = clients.get(who);
    if (!c) {
      const saved = JSON.parse(readFileSync(path.join(OUT, ".auth", `${who}.json`), "utf8"));
      c = await ApiClient.create(saved.email, saved.state);
      clients.set(who, c);
    }
    return c;
  };
  console.log(`\n${scheme} ${size}`);

  const open = async (who: "mom" | "nanny", s: Scene | null, url: string, ready: string) => {
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: SIZES[size],
      colorScheme: scheme,
      reducedMotion: "reduce",
      isMobile: size === "phone",
      hasTouch: size === "phone",
      storageState: await (await client(who)).storageState(),
    });
    await ctx.addInitScript((b) => localStorage.setItem("ll_current_baby", b), MAYA);
    const page = await ctx.newPage();
    if (s) await mock(page, s);
    await page.goto(url);
    await expect(tid(page, ready)).toBeVisible({ timeout: 20_000 });
    return { ctx, page };
  };
  const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(dir, `google-${name}.png`) });
    console.log("  ", `${scheme}-${size}/google-${name}.png`);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.log(`   !! ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
  };

  const recent = [
    batch(1, {
      status: "running",
      itemsTotal: 240,
      itemsImported: 96,
      itemsDuplicate: 4,
      itemsFailed: 0,
      itemsSkipped: 0,
      finishedAt: null,
    }),
    batch(2),
    batch(3, {
      status: "cancelled",
      itemsTotal: 20,
      itemsImported: 3,
      itemsDuplicate: 0,
      itemsFailed: 0,
      itemsSkipped: 0,
      createdAt: iso(now - 3 * 86_400_000),
      startedAt: null,
    }),
    batch(4, {
      status: "failed",
      error: "google_reconnect",
      itemsTotal: null,
      itemsImported: 0,
      itemsDuplicate: 0,
      itemsFailed: 0,
      itemsSkipped: 0,
      requestedByName: "Maya's dad",
      isMine: false,
      createdAt: iso(now - 5 * 86_400_000),
      startedAt: null,
    }),
  ];
  const doneRecent = recent.slice(1);

  // ---- settings ------------------------------------------------------------------------------
  await step("settings-row", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn(), recent: doneRecent },
      "/settings",
      "settings",
    );
    await expect(tid(page, "settings-import")).toBeVisible();
    await shot(page, "settings-row");
    await ctx.close();
  });
  await step("settings-connect", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn({ connected: false, connectedAt: null }), recent: [] },
      "/settings/import",
      "google-connect",
    );
    await shot(page, "settings-connect");
    await ctx.close();
  });
  await step("settings-connect-waiting", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn({ connected: false, connectedAt: null }), recent: [] },
      "/settings/import",
      "google-connect",
    );
    await tid(page, "google-connect").click();
    await expect(tid(page, "google-connect-wait")).toBeVisible();
    await shot(page, "settings-connect-waiting");
    await ctx.close();
  });
  await step("settings-connected", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn(), recent: doneRecent },
      "/settings/import",
      "google-import",
    );
    await expect(tid(page, "google-recent-row").first()).toBeVisible();
    await shot(page, "settings-connected");
    await ctx.close();
  });
  await step("settings-active", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn(), recent },
      "/settings/import",
      "google-import",
    );
    await expect(tid(page, "google-active")).toBeVisible();
    await shot(page, "settings-active");
    await ctx.close();
  });
  await step("settings-empty", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn(), recent: [] },
      "/settings/import",
      "google-import",
    );
    await expect(tid(page, "google-recent-empty")).toBeVisible();
    await shot(page, "settings-empty");
    await ctx.close();
  });
  await step("settings-reconnect", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn({ needsReconnect: true }), recent: [] },
      "/settings/import",
      "google-reconnect-note",
    );
    await shot(page, "settings-reconnect");
    await ctx.close();
  });
  await step("settings-off", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: null, recent: [] },
      "/settings/import",
      "import-apple",
    );
    await expect(tid(page, "google-card")).toHaveCount(0);
    await shot(page, "settings-off");
    await ctx.close();
  });
  await step("disconnect-confirm", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn(), recent: doneRecent },
      "/settings/import",
      "google-disconnect",
    );
    await tid(page, "google-disconnect").click();
    await page.waitForTimeout(500);
    await shot(page, "disconnect-confirm");
    await ctx.close();
  });
  await step("contributor-settings", async () => {
    const { ctx, page } = await open(
      "nanny",
      {
        connection: conn(),
        recent: doneRecent.map((b) => ({ ...b, requestedByName: "Maya's nanny" })),
      },
      "/settings/import",
      "google-contributor-note",
    );
    await shot(page, "contributor-settings");
    await ctx.close();
  });

  // ---- upload entry --------------------------------------------------------------------------
  await step("upload-entry", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn(), recent: doneRecent },
      "/upload",
      "google-card",
    );
    await shot(page, "upload-entry");
    await ctx.close();
  });
  await step("upload-entry-connect", async () => {
    const { ctx, page } = await open(
      "mom",
      { connection: conn({ connected: false, connectedAt: null }), recent: [] },
      "/upload",
      "google-card",
    );
    await shot(page, "upload-entry-connect");
    await ctx.close();
  });

  // ---- sheet states (opened from the Upload entry) -------------------------------------------
  const sheetScenes: [string, "mom" | "nanny", Scene, RegExp | null][] = [
    [
      "sheet-picking",
      "mom",
      {
        connection: conn(),
        recent: [],
        current: batch(10, {
          status: "picking",
          itemsTotal: null,
          itemsImported: 0,
          itemsDuplicate: 0,
          itemsFailed: 0,
          itemsSkipped: 0,
          startedAt: null,
          finishedAt: null,
        }),
      },
      /Choose your photos/,
    ],
    [
      "sheet-running",
      "mom",
      {
        connection: conn(),
        recent: [],
        current: batch(11, {
          status: "running",
          itemsTotal: 1240,
          itemsImported: 480,
          itemsDuplicate: 12,
          itemsFailed: 0,
          itemsSkipped: 3,
          finishedAt: null,
        }),
      },
      /Importing your photos/,
    ],
    [
      "sheet-done",
      "mom",
      { connection: conn(), recent: [], current: batch(12) },
      /Import finished/,
    ],
    [
      "sheet-done-contributor",
      "nanny",
      {
        connection: conn(),
        recent: [],
        current: batch(13, {
          itemsTotal: 12,
          itemsImported: 10,
          itemsDuplicate: 1,
          itemsFailed: 0,
          itemsSkipped: 1,
        }),
      },
      /Import finished/,
    ],
    [
      "sheet-empty",
      "mom",
      {
        connection: conn(),
        recent: [],
        current: batch(14, {
          itemsTotal: 3,
          itemsImported: 0,
          itemsDuplicate: 3,
          itemsFailed: 0,
          itemsSkipped: 0,
        }),
      },
      /Nothing was imported/,
    ],
    [
      "sheet-failed",
      "mom",
      {
        connection: conn(),
        recent: [],
        current: batch(15, {
          status: "failed",
          error: "storage_error",
          itemsImported: 5,
          itemsDuplicate: 0,
          itemsFailed: 7,
          itemsSkipped: 0,
          itemsTotal: 12,
        }),
      },
      /didn't finish/,
    ],
    [
      "sheet-cancelled",
      "mom",
      {
        connection: conn(),
        recent: [],
        current: batch(16, {
          status: "cancelled",
          itemsTotal: null,
          itemsImported: 0,
          itemsDuplicate: 0,
          itemsFailed: 0,
          itemsSkipped: 0,
        }),
      },
      /cancelled/,
    ],
    [
      "sheet-expired",
      "mom",
      {
        connection: conn(),
        recent: [],
        current: batch(17, {
          status: "expired",
          itemsTotal: null,
          itemsImported: 0,
          itemsDuplicate: 0,
          itemsFailed: 0,
          itemsSkipped: 0,
        }),
      },
      /too long/,
    ],
    [
      "sheet-error",
      "mom",
      { connection: conn(), recent: [], createError: [409, "import_in_progress"], current: null },
      null,
    ],
    [
      "sheet-ratelimit",
      "mom",
      { connection: conn(), recent: [], createError: [429, "rate_limited"], current: null },
      null,
    ],
  ];
  for (const [name, who, scene, text] of sheetScenes) {
    await step(name, async () => {
      const { ctx, page } = await open(who, scene, "/upload", "google-import");
      await tid(page, "google-import").click();
      if (text) await expect(tid(page, "google-sheet")).toContainText(text, { timeout: 10_000 });
      else await expect(tid(page, "google-start-error")).toBeVisible({ timeout: 10_000 });
      await shot(page, name);
      await ctx.close();
    });
  }

  // ---- connected page ------------------------------------------------------------------------
  for (const [name, q] of [
    ["connected-ok-native", "status=ok&client=native&returnTo=/upload"],
    ["connected-denied", "status=denied&client=web&returnTo=/settings/import"],
    ["connected-scope", "status=scope_missing&client=web&returnTo=/settings/import"],
    ["connected-expired", "status=expired&client=native"],
    ["connected-error", "status=error&client=web"],
    ["connected-ok-web", "status=ok&client=web&returnTo=/settings/import"],
  ] as const) {
    await step(name, async () => {
      const ctx = await browser.newContext({
        baseURL: BASE,
        viewport: SIZES[size],
        colorScheme: scheme,
        reducedMotion: "reduce",
        isMobile: size === "phone",
        hasTouch: size === "phone",
      });
      const page = await ctx.newPage();
      await page.goto(`/import/google/connected?${q}`);
      await expect(tid(page, "google-connected-page")).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: path.join(dir, `google-${name}.png`) });
      console.log("  ", `${scheme}-${size}/google-${name}.png`);
      await ctx.close();
    });
  }

  // ---- deletion screen -----------------------------------------------------------------------
  await step("account-delete", async () => {
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: SIZES[size],
      colorScheme: scheme,
      reducedMotion: "reduce",
      isMobile: size === "phone",
      hasTouch: size === "phone",
      storageState: await (await client("mom")).storageState(),
    });
    await ctx.addInitScript((b) => localStorage.setItem("ll_current_baby", b), MAYA);
    const page = await ctx.newPage();
    await page.route("**/api/me/deletion-preview", (r) =>
      json(r, {
        blockingBabies: [],
        babiesKept: [],
        freshSignIn: true,
        googlePhotosConnected: true,
      }),
    );
    await page.goto("/settings/account");
    await tid(page, "account-continue").click();
    await expect(tid(page, "account-google")).toBeVisible();
    await shot(page, "account-delete");
    await ctx.close();
  });

  for (const c of clients.values()) await c.dispose();
}

const browser = await chromium.launch();
try {
  for (const scheme of schemes) for (const size of sizes) await run(browser, scheme, size);
} finally {
  await browser.close();
}
