// Visual check for the brand mark in the app (welcome/sign-in lockup, app header mark, suspended
// screen, share viewer lockup). Every API call is mocked with Playwright routes (no dev stack, no
// data changes); point E2E_BASE_URL at any web build, e.g. a local `vite --port 5199`.
// Output: apps/mobile-web/.vite/screenshots/<scheme>-<size>/logo-*.png
//
//   E2E_BASE_URL=http://localhost:5199 pnpm exec tsx apps/mobile-web/scripts/screenshots-logo.ts

import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, expect, type Page, type Route } from "@playwright/test";
import sharp from "sharp";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5199";
const OUT = path.resolve(import.meta.dirname, "../.vite/screenshots");
const SIZES = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;
const MAYA = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-000000000001";
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const notFound = { error: "not_found", message: "Not found", requestId: "r" };
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

async function base(page: Page) {
  // Nothing reaches a real backend: all API and auth calls are answered here.
  await page.route(
    (u) => u.pathname.startsWith("/api/") || u.pathname.startsWith("/auth/"),
    (r) => json(r, notFound, 404),
  );
}

async function signedIn(page: Page) {
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
      babies: [
        {
          id: MAYA,
          name: "Maya",
          nickname: null,
          birthDate: "2026-01-15",
          plan: "free",
          role: "admin",
        },
      ],
      session: { createdAt: new Date().toISOString(), isFresh: true },
    }),
  );
  await page.route(`**/api/babies/${MAYA}`, (r) =>
    json(r, {
      id: MAYA,
      name: "Maya",
      nickname: null,
      birthDate: "2026-01-15",
      plan: "free",
      role: "admin",
      birthDateIsDueDate: false,
      birthWeightG: null,
      birthLengthMm: null,
      avatarPhotoId: null,
      createdAt: "2026-01-15T00:00:00.000Z",
      deletedAt: null,
      freeTier: { used: 120, limit: 1000, familyAlbums: 1 },
    }),
  );
}

async function viewer(page: Page) {
  const jpeg = await sharp({
    create: { width: 600, height: 450, channels: 3, background: "#D9B99B" },
  })
    .jpeg()
    .toBuffer();
  await page.route("http://localhost:9000/**", (r) =>
    r.fulfill({ status: 200, contentType: "image/jpeg", body: jpeg }),
  );
  const photos = Array.from({ length: 12 }, (_, i) => {
    const id = `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;
    return {
      id,
      takenAt: iso(now - i * 36 * 3600_000),
      takenAtEstimated: false,
      ageDays: 300 - i * 9,
      width: 1200,
      height: 900,
      milestone: null,
      hidden: false,
      thumbUrl: `http://localhost:9000/x/${id}/thumb.jpg`,
      urlExpiresAt: iso(now + 300_000),
    };
  });
  await page.route("**/api/share/session", (r) =>
    json(r, {
      album: {
        linkName: "Grandparents",
        babyName: "Maya Rose",
        babyNickname: "Mimi",
        allowDownload: true,
        expiresAt: iso(now + 5 * 3600_000),
        photoCount: 12,
        hiddenCount: 0,
      },
    }),
  );
  await page.route("**/api/share/photos?*", (r) => json(r, { photos, nextCursor: null }));
}

const SCENES: Record<string, (p: Page) => Promise<void>> = {
  welcome: async (page) => {
    await base(page);
    await page.route("**/api/me", (r) =>
      json(r, { error: "unauthorized", message: "Sign in", requestId: "r" }, 401),
    );
    await page.goto("/");
    await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 20_000 });
  },
  header: async (page) => {
    await base(page);
    await signedIn(page);
    await page.goto("/timeline");
    await expect(page.getByTestId("logo-mark").first()).toBeVisible({ timeout: 20_000 });
  },
  suspended: async (page) => {
    await base(page);
    await page.route("**/api/me", (r) =>
      json(r, { error: "account_suspended", message: "Suspended.", requestId: "r" }, 403),
    );
    await page.goto("/timeline");
    await expect(page.getByTestId("suspended")).toBeVisible({ timeout: 20_000 });
  },
  share: async (page) => {
    await base(page);
    await viewer(page);
    await page.goto("/s/demo-grandparents-share-token");
    await expect(page.getByTestId("share-album")).toBeVisible({ timeout: 20_000 });
  },
};

async function run(browser: Browser, scheme: "light" | "dark", size: keyof typeof SIZES) {
  const dir = path.join(OUT, `${scheme}-${size}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, scene] of Object.entries(SCENES)) {
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: SIZES[size],
      colorScheme: scheme,
      reducedMotion: "reduce",
      isMobile: size === "phone",
      hasTouch: size === "phone",
      deviceScaleFactor: 2,
    });
    await ctx.addInitScript((b) => localStorage.setItem("ll_current_baby", b), MAYA);
    const page = await ctx.newPage();
    const file = path.join(dir, `logo-${name}.png`);
    try {
      await scene(page);
      await page.waitForTimeout(600);
      await page.screenshot({ path: file });
      console.log("  ", `${scheme}-${size}/logo-${name}.png`);
    } catch (e) {
      await page.screenshot({ path: file.replace(".png", "-FAILED.png") });
      console.log(`   !! ${scheme}-${size} ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
    await ctx.close();
  }
}

const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const)
    for (const size of ["phone", "desktop"] as const) await run(browser, scheme, size);
} finally {
  await browser.close();
}
