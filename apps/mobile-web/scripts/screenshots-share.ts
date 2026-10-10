// Visual check for the sharing screens (step 8). The share API calls are mocked with Playwright
// routes so the screens can be reviewed before / without the live API; the parent session and
// photo list are real (cached sessions from screenshots.ts). Output next to the other shots:
// apps/mobile-web/.vite/screenshots/<scheme>-<size>/share-*.png
//
//   pnpm exec tsx apps/mobile-web/scripts/screenshots-share.ts [--scheme=dark] [--size=phone]

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, expect, type Page, type Route } from "@playwright/test";
import { ApiClient } from "../../../e2e/helpers/api";
import { MAYA } from "../../../e2e/helpers/demo";
import { tid } from "../../../e2e/helpers/ui";
import { sceneJpeg } from "../../worker/src/testing/images";

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const OUT = path.resolve(import.meta.dirname, "../.vite/screenshots");
const SIZES = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const schemes = (arg("scheme")?.split(",") ?? ["light", "dark"]) as ("light" | "dark")[];
const sizes = (arg("size")?.split(",") ?? ["phone", "desktop"]) as (keyof typeof SIZES)[];

const cached = async (key: string) => {
  const saved = JSON.parse(readFileSync(path.join(OUT, ".auth", `${key}.json`), "utf8"));
  return { saved, api: await ApiClient.create(saved.email, saved.state) };
};

const id = (n: number) => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

const base = {
  babyId: MAYA,
  revokedAt: null,
  ttlHours: 24,
  allowDownload: false,
  hasPasscode: false,
  passcodeLocked: false,
  rule: null,
  hiddenCount: 0,
  viewCount: 0,
  lastViewedAt: null,
  activeViewers: 0,
  createdAt: iso(now - 30 * HOUR),
  createdBy: null,
};
const LINKS = [
  {
    ...base,
    id: id(1),
    name: "Grandparents",
    status: "active",
    expiresAt: iso(now + 5 * HOUR),
    photoCount: 14,
    hiddenCount: 1,
    viewCount: 12,
    lastViewedAt: iso(now - 2 * HOUR),
    activeViewers: 1,
    hasPasscode: true,
    allowDownload: true,
  },
  {
    ...base,
    id: id(2),
    name: "Close friends",
    status: "active",
    expiresAt: iso(now + 70 * HOUR),
    photoCount: 40,
    rule: {
      mode: "tags",
      includeTags: ["outdoor", "smile"],
      excludeTags: ["crying"],
      updatedAt: iso(now),
      evaluatedAt: iso(now),
    },
    viewCount: 3,
    lastViewedAt: iso(now - 26 * HOUR),
  },
  {
    ...base,
    id: id(3),
    name: "Aunt Rosa",
    status: "expired",
    expiresAt: iso(now - 4 * HOUR),
    photoCount: 6,
    viewCount: 1,
    lastViewedAt: iso(now - 50 * HOUR),
    hasPasscode: true,
    passcodeLocked: true,
  },
  {
    ...base,
    id: id(4),
    name: "Old neighbours",
    status: "revoked",
    revokedAt: iso(now - HOUR),
    expiresAt: iso(now + 10 * HOUR),
    photoCount: 3,
  },
];
const URL_ONCE = "http://localhost:8080/s/Qm9nd2luZ0V4YW1wbGVUb2tlbg";

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });

/** Real photo summaries of a baby (so thumbs render), reshaped as shared-album rows. */
async function realPhotos(api: ApiClient, babyId: string) {
  const r = await api.call<{ photos: Record<string, unknown>[] }>(
    "GET",
    `/babies/${babyId}/photos?limit=12`,
  );
  return r.body.photos.map((p, i) => ({
    ...p,
    sharedBy: i % 4 === 1 ? "rule" : "user",
    hiddenFromViewers: i === 2,
    isSensitive: i === 2,
    addedAt: iso(now - i * HOUR),
  }));
}

async function mockParent(page: Page, photos: unknown[]) {
  await page.route("**/api/babies/*/share-links", (r) =>
    r.request().method() === "POST"
      ? json(r, { link: LINKS[0], url: URL_ONCE }, 201)
      : json(r, { links: LINKS }),
  );
  await page.route("**/api/share-links/*/photos*", (r) => json(r, { photos, nextCursor: null }));
  await page.route("**/api/share-links/*/regenerate", (r) =>
    json(r, { link: LINKS[0], url: URL_ONCE }),
  );
  await page.route("**/api/photos/*/share-links", (r) =>
    json(r, {
      links: LINKS.map((l, i) => ({
        shareLinkId: l.id,
        name: l.name,
        status: l.status,
        shared: i === 0,
        sharedBy: i === 0 ? "user" : null,
        hiddenFromViewers: false,
        excluded: false,
      })),
    }),
  );
}

// ---- viewer mocks ----------------------------------------------------------------------
const VIEWER_PHOTOS = Array.from({ length: 30 }, (_, i) => {
  const hidden = i === 4;
  const pid = id(20 + i);
  return {
    id: pid,
    takenAt: iso(now - i * 36 * HOUR),
    takenAtEstimated: false,
    ageDays: 400 - i * 12,
    width: 1200,
    height: 900,
    milestone: i === 1 ? { id: id(90), name: "First steps" } : null,
    hidden,
    thumbUrl: hidden
      ? null
      : `http://localhost:9000/tinyglow-dev/derivatives/${pid.replace(/^0{8}/, "0000000a")}/thumb.jpg`,
    urlExpiresAt: hidden ? null : iso(now + 5 * 60_000),
  };
});
const ALBUM = {
  linkName: "Grandparents",
  babyName: "Maya Rose",
  babyNickname: "Mimi",
  allowDownload: true,
  expiresAt: iso(now + 5 * HOUR),
  photoCount: 30,
  hiddenCount: 1,
};

async function mockViewer(page: Page, mode: "album" | "passcode" | "wrong" | "locked" | "expired") {
  const jpeg = await sceneJpeg(900, 900, 4242);
  await page.route("http://localhost:9000/**", (r) =>
    r.fulfill({ status: 200, contentType: "image/jpeg", body: jpeg }),
  );
  await page.route("**/api/share/session", (r) => {
    if (mode === "expired")
      return json(
        r,
        {
          error: "share_link_expired",
          message: "This link has expired. Ask the parents for a new link.",
        },
        410,
      );
    if (mode === "passcode")
      return json(r, { error: "passcode_required", message: "Enter the passcode." }, 401);
    if (mode === "wrong") {
      const sent = r.request().postDataJSON() as { passcode?: string };
      return sent.passcode
        ? json(
            r,
            { error: "passcode_invalid", message: "Wrong passcode.", details: { attemptsLeft: 3 } },
            401,
          )
        : json(r, { error: "passcode_required", message: "Enter the passcode." }, 401);
    }
    if (mode === "locked") {
      const sent = r.request().postDataJSON() as { passcode?: string };
      return sent.passcode
        ? json(r, { error: "passcode_locked", message: "Too many tries." }, 429, {
            "Retry-After": "2400",
          })
        : json(r, { error: "passcode_required", message: "Enter the passcode." }, 401);
    }
    return json(r, { album: ALBUM });
  });
  await page.route("**/api/share/photos?*", (r) =>
    json(r, { photos: VIEWER_PHOTOS, nextCursor: null }),
  );
  await page.route("**/api/share/photos/urls", (r) => {
    const { ids } = r.request().postDataJSON() as { ids: string[] };
    return json(r, {
      urls: ids.map((i) => ({
        id: i,
        url: `http://localhost:9000/tinyglow-dev/derivatives/${i.replace(/^0{8}/, "0000000a")}/display.jpg`,
        expiresAt: iso(now + 5 * 60_000),
      })),
    });
  });
  await page.route("**/api/share/photos/*/download", (r) =>
    json(r, {
      url: "http://localhost:9000/tinyglow-dev/derivatives/00000000-0000-4000-8000-000000000001/display.jpg",
      expiresAt: iso(now + 60_000),
    }),
  );
}

async function run(browser: Browser, scheme: "light" | "dark", size: keyof typeof SIZES) {
  const dir = path.join(OUT, `${scheme}-${size}`);
  mkdirSync(dir, { recursive: true });
  const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(dir, `share-${name}.png`) });
    console.log("  ", `${scheme}-${size}/share-${name}.png`);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.log(`   !! ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  const mk = async (api?: ApiClient, baby?: string) => {
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: SIZES[size],
      colorScheme: scheme,
      reducedMotion: "reduce",
      isMobile: size === "phone",
      hasTouch: size === "phone",
      ...(api ? { storageState: await api.storageState() } : {}),
    });
    if (baby) await ctx.addInitScript((b) => localStorage.setItem("ll_current_baby", b), baby);
    return ctx;
  };
  console.log(`\n${scheme} ${size}`);

  // ---- parent: Maya (plus) ----
  {
    const { api } = await cached("mom");
    const photos = await realPhotos(api, MAYA);
    const ctx = await mk(api, MAYA);
    const page = await ctx.newPage();
    await mockParent(page, photos);
    await step("family", async () => {
      await page.goto("/family");
      await expect(tid(page, "share-links-list")).toBeVisible({ timeout: 20_000 });
      await shot(page, "family-links");
    });
    await step("create", async () => {
      await tid(page, "share-create-open").click();
      await expect(page.getByTestId("share-create")).toBeVisible();
      await page.getByTestId("share-name").fill("Grandparents");
      await page.getByTestId("share-rule-mode-tags").click();
      await page.getByTestId("share-rule-include").fill("outdoor");
      await page.getByTestId("share-rule-include").press("Enter");
      await shot(page, "create-sheet");
      await page.getByTestId("share-create-submit").click();
      await expect(page.getByTestId("share-url")).toBeVisible();
      await shot(page, "url-sheet");
      await page.getByTestId("share-url-done").click();
    });
    await step("settings", async () => {
      await tid(page, "share-settings-open").first().click();
      await expect(page.getByTestId("share-settings")).toBeVisible();
      await shot(page, "settings-sheet");
      await page.getByTestId("share-settings-cancel").click();
    });
    await step("confirm", async () => {
      await tid(page, "share-regenerate").first().click();
      await page.waitForTimeout(600);
      await shot(page, "confirm-regenerate");
      await page.getByRole("button", { name: "Cancel" }).last().click();
    });
    await step("manage", async () => {
      await page.goto(`/family/share/${id(1)}`);
      await expect(tid(page, "share-photos-page")).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      await shot(page, "manage-photos");
      await tid(page, "share-photos-select").click();
      await shot(page, "manage-photos-select");
    });
    await step("add-sheet", async () => {
      await page.goto("/timeline");
      await expect(tid(page, "timeline-grid")).toBeVisible({ timeout: 20_000 });
      await tid(page, "select-mode").click();
      const thumbs = page.locator('.ion-page:not(.ion-page-hidden) button[data-testid^="photo-"]');
      await thumbs.nth(0).click();
      await thumbs.nth(1).click();
      await tid(page, "batch-share").click();
      await expect(page.getByTestId("share-add-sheet")).toBeVisible();
      await shot(page, "add-sheet");
    });
    await ctx.close();
  }

  // ---- parent in the app (forced isNative): the link sheet offers the OS share sheet ----
  {
    const { api } = await cached("mom");
    const photos = await realPhotos(api, MAYA);
    const ctx = await mk(api, MAYA);
    await ctx.addInitScript(
      'Object.defineProperty(window, "Capacitor", { configurable: true, get: () => ({ isNativePlatform: () => true, getPlatform: () => "ios", convertFileSrc: (x) => x }), set: () => {} });',
    );
    const page = await ctx.newPage();
    await mockParent(page, photos);
    await step("native-url-sheet", async () => {
      await page.goto("/family");
      await expect(tid(page, "share-links-list")).toBeVisible({ timeout: 20_000 });
      await tid(page, "share-create-open").click();
      await expect(page.getByTestId("share-create")).toBeVisible();
      await page.getByTestId("share-name").fill("Grandparents");
      await page.getByTestId("share-create-submit").click();
      await expect(page.getByTestId("share-url")).toBeVisible();
      await expect(page.getByTestId("share-native")).toBeVisible();
      await shot(page, "native-url-sheet");
    });
    await ctx.close();
  }

  // ---- parent: Juniper (free) ----
  {
    const { api, saved } = await cached("fresh");
    void saved;
    const me = await api.call<{ babies: { id: string; name: string }[] }>("GET", "/me");
    const juniper = me.body.babies.find((b) => b.name === "Juniper")?.id ?? "";
    const ctx = await mk(api, juniper);
    const page = await ctx.newPage();
    await mockParent(page, await realPhotos(api, juniper));
    await step("free-create", async () => {
      await page.goto("/family");
      await expect(tid(page, "share-links-list")).toBeVisible({ timeout: 20_000 });
      await tid(page, "share-create-open").click();
      await expect(page.getByTestId("share-rule-upsell")).toBeVisible();
      await shot(page, "create-sheet-free");
    });
    await step("viewer-share", async () => {
      await page.goto("/timeline");
      await expect(tid(page, "timeline-grid")).toBeVisible({ timeout: 20_000 });
      await page
        .locator('.ion-page:not(.ion-page-hidden) button[data-testid^="photo-"]:has(img)')
        .first()
        .click();
      await expect(tid(page, "viewer-details")).toBeVisible();
      await page.mouse.move(100, 100);
      await tid(page, "viewer-share").click();
      await expect(page.getByTestId("share-add-sheet")).toBeVisible();
      await shot(page, "viewer-add-sheet");
    });
    await ctx.close();
  }

  // ---- viewer (no session) ----
  const TOKEN = "demo-grandparents-share-token";
  for (const mode of ["album", "passcode", "wrong", "locked", "expired"] as const) {
    const ctx = await mk();
    const page = await ctx.newPage();
    await mockViewer(page, mode);
    await step(`viewer-${mode}`, async () => {
      await page.goto(`/s/${TOKEN}`);
      if (mode === "album") {
        await expect(page.getByTestId("share-album")).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(800);
        await shot(page, "album");
        await page.getByTestId(`share-thumb-${VIEWER_PHOTOS[1]?.id}`).click();
        await expect(page.getByTestId("share-viewer")).toBeVisible();
        await page.mouse.move(120, 120);
        await page.waitForTimeout(800);
        await shot(page, "photo");
      } else if (mode === "passcode") {
        await expect(page.getByTestId("share-passcode")).toBeVisible();
        await shot(page, "passcode");
      } else if (mode === "wrong") {
        await page.getByTestId("share-passcode-field").fill("123456");
        await expect(page.getByTestId("share-passcode-error")).toBeVisible();
        await shot(page, "passcode-wrong");
      } else if (mode === "locked") {
        await page.getByTestId("share-passcode-field").fill("123456");
        await expect(page.getByTestId("share-passcode-error")).toBeVisible();
        await shot(page, "passcode-locked");
      } else {
        await expect(page.getByTestId("share-expired")).toBeVisible();
        await shot(page, "expired");
      }
    });
    await ctx.close();
  }

  // ---- viewer inside the app (forced isNative): "Done" returns to the parent app ----
  for (const mode of ["album", "passcode", "expired"] as const) {
    const ctx = await mk();
    await ctx.addInitScript(
      'Object.defineProperty(window, "Capacitor", { configurable: true, get: () => ({ isNativePlatform: () => true, getPlatform: () => "ios", convertFileSrc: (x) => x }), set: () => {} });',
    );
    const page = await ctx.newPage();
    await mockViewer(page, mode);
    await step(`native-viewer-${mode}`, async () => {
      await page.goto(`/s/${TOKEN}`);
      if (mode === "album") {
        await expect(page.getByTestId("share-album")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("share-done")).toBeVisible();
        await page.waitForTimeout(800);
        await shot(page, "native-album");
      } else if (mode === "passcode") {
        await expect(page.getByTestId("share-passcode")).toBeVisible();
        await shot(page, "native-passcode");
      } else {
        await expect(page.getByTestId("share-expired")).toBeVisible();
        await shot(page, "native-expired");
      }
    });
    await ctx.close();
  }
}

const browser = await chromium.launch();
try {
  for (const scheme of schemes) for (const size of sizes) await run(browser, scheme, size);
} finally {
  await browser.close();
}
