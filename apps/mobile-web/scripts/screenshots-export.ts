// Visual check for Settings -> Export your data (docs/plans/review-fixes.md R.11). The export API
// is mocked with Playwright routes (the worker job may not be running); the parent session is
// real (cached sessions from screenshots.ts). Output next to the other shots:
// apps/mobile-web/.vite/screenshots/<scheme>-<size>/export-*.png
//
//   pnpm exec tsx apps/mobile-web/scripts/screenshots-export.ts [--scheme=dark] [--size=phone]

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

const id = (n: number) => `00000000-0000-4000-8000-0000000008${String(n).padStart(2, "0")}`;
const now = Date.now();
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const base = {
  babyId: MAYA,
  includeLocation: true,
  requestedBy: id(90),
  requestedByName: "Maya's mom",
  isMine: true,
  photoCount: null as number | null,
  photosDone: 0,
  bytes: null as number | null,
  error: null as string | null,
  startedAt: null as string | null,
  finishedAt: null as string | null,
  canDownload: false,
  createdAt: iso(now - 600_000),
  expiresAt: iso(now + 7 * DAY),
};
type Item = typeof base & { id: string; status: string };
const queued: Item = { ...base, id: id(1), status: "queued" };
const running: Item = {
  ...base,
  id: id(2),
  status: "running",
  photoCount: 240,
  photosDone: 96,
  startedAt: iso(now - 120_000),
};
const ready: Item = {
  ...base,
  id: id(3),
  status: "ready",
  photoCount: 240,
  photosDone: 240,
  bytes: 1_824_000_000,
  finishedAt: iso(now - 60_000),
  canDownload: true,
  createdAt: iso(now - 2 * DAY),
  expiresAt: iso(now + 5 * DAY),
};
const readyOther: Item = {
  ...ready,
  id: id(4),
  isMine: false,
  canDownload: false,
  requestedByName: "Sam",
  includeLocation: false,
  bytes: 640_000_000,
  createdAt: iso(now - 3 * DAY),
};
const expired: Item = {
  ...ready,
  id: id(5),
  status: "expired",
  canDownload: false,
  createdAt: iso(now - 12 * DAY),
  expiresAt: iso(now - 5 * DAY),
};
const failed: Item = {
  ...base,
  id: id(6),
  status: "failed",
  error: "too_large",
  createdAt: iso(now - 14 * DAY),
  expiresAt: iso(now - 7 * DAY),
};

const SCENES: Record<string, { items: Item[]; post?: [number, string] }> = {
  empty: { items: [] },
  queued: { items: [queued] },
  running: { items: [running, expired] },
  ready: { items: [ready, readyOther, expired, failed] },
  error: { items: [], post: [409, "export_in_progress"] },
  ratelimit: { items: [], post: [429, "rate_limited"] },
};

async function mock(page: Page, scene: string) {
  const s = SCENES[scene];
  if (!s) throw new Error(scene);
  await page.route("**/api/babies/*/exports", (r) => {
    if (r.request().method() === "POST") {
      const [status, error] = s.post ?? [202, ""];
      return status === 202
        ? json(r, { export: queued }, 202)
        : json(r, { error, message: "x", requestId: "r" }, status);
    }
    return json(r, { exports: s.items });
  });
}

async function run(browser: Browser, scheme: "light" | "dark", size: keyof typeof SIZES) {
  const dir = path.join(OUT, `${scheme}-${size}`);
  mkdirSync(dir, { recursive: true });
  const saved = JSON.parse(readFileSync(path.join(OUT, ".auth", "mom.json"), "utf8"));
  const api = await ApiClient.create(saved.email, saved.state);
  console.log(`\n${scheme} ${size}`);
  for (const scene of Object.keys(SCENES)) {
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: SIZES[size],
      colorScheme: scheme,
      reducedMotion: "reduce",
      isMobile: size === "phone",
      hasTouch: size === "phone",
      storageState: await api.storageState(),
    });
    await ctx.addInitScript((b) => localStorage.setItem("ll_current_baby", b), MAYA);
    const page = await ctx.newPage();
    try {
      await mock(page, scene);
      if (scene === "empty") {
        await page.goto("/settings");
        await expect(tid(page, "settings")).toBeVisible({ timeout: 20_000 });
        await page.screenshot({ path: path.join(dir, "export-settings.png") });
      }
      await page.goto("/settings/export");
      await expect(tid(page, "export-page")).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(600);
      if (scene === "error" || scene === "ratelimit") {
        await tid(page, "export-request").click();
        await expect(tid(page, "export-error")).toBeVisible();
      }
      if (scene === "empty") {
        await tid(page, "export-location").uncheck();
        await page.screenshot({ path: path.join(dir, "export-location-off.png") });
        await tid(page, "export-location").check();
      }
      await page.screenshot({ path: path.join(dir, `export-${scene}.png`), fullPage: false });
      if (scene === "ready") {
        await tid(page, "export-list").screenshot({
          path: path.join(dir, "export-ready-list.png"),
        });
      }
      console.log("  ", `${scheme}-${size}/export-${scene}.png`);
    } catch (e) {
      console.log(`   !! ${scene}: ${(e as Error).message.split("\n")[0]}`);
    }
    await ctx.close();
  }
  await api.dispose();
}

const browser = await chromium.launch();
try {
  for (const scheme of schemes) for (const size of sizes) await run(browser, scheme, size);
} finally {
  await browser.close();
}
