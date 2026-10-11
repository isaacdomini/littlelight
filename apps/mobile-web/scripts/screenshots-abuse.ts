// Visual check for the family free-tier model (step 11, task 11.6b): the create-album refusals
// (disposable email, inbox already has a family, network limit), the parent-elsewhere invite
// refusal, the family usage line (parent / guest, ok / near / over), the guest upload note and
// pending-limit refusal, the approve-into-a-full-family message and the suspended screen. The API
// answers are mocked with Playwright routes; the whole API is mocked (no dev stack needed). Point E2E_BASE_URL at any web build (e.g. a local `vite` on another port) -
// the dev stack itself does not need a restart. Output next to the other shots:
// apps/mobile-web/.vite/screenshots/<scheme>-<size>/abuse-*.png
//
//   E2E_BASE_URL=http://localhost:5199 pnpm exec tsx apps/mobile-web/scripts/screenshots-abuse.ts [--scheme=dark] [--size=phone]

import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, expect, type Page, type Route } from "@playwright/test";
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
const only = arg("scene")?.split(",");
const sizes = (arg("size")?.split(",") ?? ["phone", "desktop"]) as (keyof typeof SIZES)[];

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
const err = (error: string, message: string, details?: unknown) => ({
  error,
  message,
  requestId: "r",
  ...(details ? { details } : {}),
});

const SCENES = [
  "create-email-not-allowed",
  "create-inbox-has-family",
  "create-family-limited",
  "invite-parent-elsewhere",
  "usage-ok",
  "usage-near",
  "usage-over",
  "usage-guest",
  "usage-guest-over",
  "guest-note",
  "guest-pending-limit",
  "approve-full",
  "suspended",
] as const;
type SceneName = (typeof SCENES)[number];

const USER = "00000000-0000-4000-8000-000000000001";
const baby = (role: "admin" | "contributor") => ({
  id: MAYA,
  name: "Maya",
  nickname: null,
  birthDate: "2026-01-15",
  plan: "free",
  role,
});
const photo = (n: number) => ({
  id: `00000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`,
  babyId: MAYA,
  status: "ingested",
  approval: "pending",
  takenAt: "2026-03-01T10:00:00.000Z",
  takenAtEstimated: false,
  ageDays: 45,
  width: 800,
  height: 600,
  mime: "image/jpeg",
  isSensitive: false,
  duplicateOfPhotoId: null,
  uploadedBy: USER,
  createdAt: "2026-03-01T10:00:00.000Z",
  deletedAt: null,
  thumbUrl: null,
  urlExpiresAt: null,
  milestoneId: null,
  caption: null,
  aiStatus: "not_available",
});

/** Mock the session and a free demo album, as parent or guest, with a given family usage. */
async function mockApp(page: Page, role: "admin" | "contributor", used = 420) {
  // Registered first so every more specific route below wins.
  await page.route(
    (u) => u.pathname.startsWith("/api/"),
    (r) => json(r, err("not_found", "Not found"), 404),
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
      babies: [baby(role)],
      session: { createdAt: new Date().toISOString(), isFresh: true },
    }),
  );
  await page.route(`**/api/babies/${MAYA}`, (r) =>
    json(r, {
      ...baby(role),
      birthDateIsDueDate: false,
      birthWeightG: null,
      birthLengthMm: null,
      avatarPhotoId: null,
      createdAt: "2026-01-15T00:00:00.000Z",
      deletedAt: null,
      freeTier: { used, limit: 1000, familyAlbums: 2 },
    }),
  );
}

async function createAlbumRefusal(page: Page, status: number, body: unknown, headers = {}) {
  await mockApp(page, "admin");
  await page.route("**/api/babies", (r) =>
    r.request().method() === "POST" ? json(r, body, status, headers) : r.fallback(),
  );
  await page.goto("/onboarding/baby?another=1");
  await tid(page, "baby-name").fill("Juniper");
  await tid(page, "baby-birthdate").fill("2026-03-02");
  await tid(page, "baby-create").click();
  await expect(tid(page, "baby-error")).toBeVisible({ timeout: 20_000 });
}

async function scene(page: Page, name: SceneName) {
  if (name === "create-email-not-allowed") {
    await createAlbumRefusal(page, 400, err("email_not_allowed", "x"));
  } else if (name === "create-inbox-has-family") {
    await createAlbumRefusal(
      page,
      409,
      err("inbox_has_family", "x", { existingEmailMasked: "m***@gmail.com" }),
    );
  } else if (name === "create-family-limited") {
    await createAlbumRefusal(page, 429, err("family_limited", "x"), { "Retry-After": "18000" });
  } else if (name === "invite-parent-elsewhere") {
    await mockApp(page, "admin");
    await page.route("**/api/invites/screenshot-token", (r) =>
      r.request().method() === "POST"
        ? json(r, err("already_parent_elsewhere", "x"), 409)
        : json(r, {
            status: "valid",
            babyName: "Juniper",
            inviterName: "Sam",
            role: "admin",
            maskedEmail: "m***@gmail.com",
            expiresAt: "2026-12-01T00:00:00.000Z",
          }),
    );
    await page.route("**/api/invites/screenshot-token/accept", (r) =>
      json(r, err("already_parent_elsewhere", "x"), 409),
    );
    await page.goto("/invite/screenshot-token");
    await expect(tid(page, "invite-failed")).toBeVisible({ timeout: 20_000 });
  } else if (name === "suspended") {
    await page.route(
      (u) => u.pathname.startsWith("/api/"),
      (r) => json(r, err("not_found", "Not found"), 404),
    );
    await page.route("**/api/me", (r) =>
      json(r, err("account_suspended", "This account has been suspended."), 403),
    );
    await page.goto("/timeline");
    await expect(tid(page, "suspended")).toBeVisible({ timeout: 20_000 });
  } else if (name === "approve-full") {
    await mockApp(page, "admin", 1000);
    // A pending queue; approving answers 409 free_tier_limit.
    const photos = [1, 2, 3, 4, 5, 6].map(photo);
    await page.route(`**/api/babies/${MAYA}/photos?*`, (r) =>
      json(r, { photos, nextCursor: null, prevCursor: "c", pendingCount: photos.length }),
    );
    await page.route(`**/api/babies/${MAYA}/photos/summary?*`, (r) =>
      json(r, { total: photos.length, groups: [{ key: "1m", count: photos.length, cursor: "c" }] }),
    );
    await page.route("**/api/photos/*/approve", (r) => json(r, err("free_tier_limit", "x"), 409));
    await page.goto("/timeline");
    await tid(page, "pending-segment").click();
    const approve = page.locator('[data-testid^="approve-"]').first();
    await expect(approve).toBeVisible({ timeout: 20_000 });
    await approve.click();
    await expect(tid(page, "action-error")).toBeVisible();
  } else if (name === "guest-pending-limit") {
    await mockApp(page, "contributor");
    await page.route(`**/api/babies/${MAYA}/uploads`, (r) =>
      r.request().method() === "POST"
        ? json(r, err("pending_limit", "x", { pending: 200, limit: 200 }), 409)
        : r.fallback(),
    );
    await page.goto("/upload");
    await tid(page, "upload-input").setInputFiles({
      name: "IMG_0001.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(
        "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
        "base64",
      ),
    });
    const row = page.getByText(/waiting for approval/).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.scrollIntoViewIfNeeded();
  } else {
    const guest = name === "usage-guest" || name === "usage-guest-over" || name === "guest-note";
    const used =
      name === "usage-near"
        ? 940
        : name === "usage-over" || name === "usage-guest-over"
          ? 1000
          : 420;
    await mockApp(page, guest ? "contributor" : "admin", used);
    await page.goto("/upload");
    await expect(tid(page, "free-tier-notice")).toBeVisible({ timeout: 20_000 });
    if (name === "guest-note") await expect(tid(page, "upload-guest-note")).toBeVisible();
  }
  await page.waitForTimeout(500);
}

async function run(browser: Browser, scheme: "light" | "dark", size: keyof typeof SIZES) {
  const dir = path.join(OUT, `${scheme}-${size}`);
  mkdirSync(dir, { recursive: true });
  console.log(`\n${scheme} ${size}`);
  for (const name of SCENES) {
    if (only && !only.includes(name)) continue;
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: SIZES[size],
      colorScheme: scheme,
      reducedMotion: "reduce",
      isMobile: size === "phone",
      hasTouch: size === "phone",
    });
    await ctx.addInitScript((b) => localStorage.setItem("ll_current_baby", b), MAYA);
    const page = await ctx.newPage();
    try {
      await scene(page, name);
      await page.screenshot({ path: path.join(dir, `abuse-${name}.png`) });
      if (name === "usage-near") {
        await page.goto("/settings");
        await expect(tid(page, "free-tier-notice")).toBeVisible();
        await page.screenshot({ path: path.join(dir, "abuse-settings-near.png") });
      }
      console.log("  ", `${scheme}-${size}/abuse-${name}.png`);
    } catch (e) {
      await page.screenshot({ path: path.join(dir, `abuse-${name}-FAILED.png`) });
      console.log(`   !! ${name}: ${(e as Error).message.split("\n")[0]}`);
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
