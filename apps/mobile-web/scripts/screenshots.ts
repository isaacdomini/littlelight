// Visual check for the design system (docs/DESIGN.md): signs in as the seeded demo users, walks
// every main screen and saves PNGs in light and dark mode at phone (375x812) and desktop
// (1440x900) sizes. Not a test: nothing asserts on pixels, a human (or agent) looks at the files.
//
//   export PATH="$HOME/.cache/littlelight-pnpm/bin:$PATH"
//   docker compose -f docker-compose.dev.yml restart api   # clears the in-memory OTP throttles
//   pnpm exec tsx apps/mobile-web/scripts/screenshots.ts [--only=timeline,viewer] [--scheme=dark] [--size=phone]
//
// Output: apps/mobile-web/.vite/screenshots/<scheme>-<size>/<NN>-<screen>.png (git-ignored).
// Sessions are cached in <out>/.auth so repeated runs do not spend OTP codes.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, expect, type Page } from "@playwright/test";
import { ApiClient, uniqueEmail } from "../../../e2e/helpers/api";
import { demoClient, MAYA } from "../../../e2e/helpers/demo";
import { tid } from "../../../e2e/helpers/ui";
import { sceneJpeg } from "../../worker/src/testing/images";

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const OUT = path.resolve(import.meta.dirname, "../.vite/screenshots");
const AUTH = path.join(OUT, ".auth");

const SIZES = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;
type Size = keyof typeof SIZES;
type Scheme = "light" | "dark";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = arg("only")?.split(",");
const schemes = (arg("scheme")?.split(",") ?? ["light", "dark"]) as Scheme[];
const sizes = (arg("size")?.split(",") ?? ["phone", "desktop"]) as Size[];

type State = Awaited<ReturnType<ApiClient["storageState"]>>;

async function cachedClient(key: string, make: () => Promise<ApiClient>): Promise<ApiClient> {
  mkdirSync(AUTH, { recursive: true });
  const file = path.join(AUTH, `${key}.json`);
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { email: string; state: State };
    const api = await ApiClient.create(saved.email, saved.state);
    if ((await api.call("GET", "/me")).status === 200) return api;
    await api.dispose();
  } catch {
    /* no cache yet */
  }
  const api = await make();
  writeFileSync(file, JSON.stringify({ email: api.email, state: await api.storageState() }));
  return api;
}

interface Ctx {
  mom: ApiClient;
  nanny: ApiClient;
  /** A throwaway admin of a free-tier baby with no photos (empty and upsell states). */
  fresh: ApiClient;
  freshBabyId: string;
  /** A second, always-empty free-tier album of the same user. */
  emptyBabyId: string;
  inviteToken: string;
}

async function setup(): Promise<Ctx> {
  const mom = await cachedClient("mom", () => demoClient("demo-mom"));
  const nanny = await cachedClient("nanny", () => demoClient("demo-nanny"));
  let freshBabyId = "";
  const fresh = await cachedClient("fresh", async () => {
    const api = await ApiClient.create(uniqueEmail("visual"));
    await api.onboard("Visual Tester");
    freshBabyId = await api.createBaby("Juniper");
    return api;
  });
  if (!freshBabyId) {
    const me = await fresh.call<{ babies: { id: string }[] }>("GET", "/me");
    freshBabyId =
      me.body.babies.find((b) => b.name === "Juniper")?.id ?? me.body.babies[0]?.id ?? "";
  }
  const invited = await fresh.invite(freshBabyId, uniqueEmail("guest"), "contributor");
  const me = await fresh.call<{ babies: { id: string; name: string }[] }>("GET", "/me");
  const emptyBabyId =
    me.body.babies.find((b) => b.name === "Echo")?.id ?? (await fresh.createBaby("Echo"));
  return { mom, nanny, fresh, freshBabyId, emptyBabyId, inviteToken: invited.token ?? "x" };
}

let counter = 0;

class Shooter {
  constructor(
    private readonly dir: string,
    private readonly page: Page,
  ) {}

  async shot(name: string, opts: { fullPage?: boolean } = {}) {
    if (only && !only.some((o) => name.includes(o))) return;
    // let fonts, images and the quiet 180 ms transitions settle
    await this.page.waitForTimeout(500);
    counter += 1;
    const prefix = only ? "" : `${String(counter).padStart(2, "0")}-`;
    const file = path.join(this.dir, `${prefix}${name}.png`);
    await this.page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
    console.log("  ", path.relative(OUT, file));
  }

  async step(name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      console.log(`   !! ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

async function context(
  browser: Browser,
  scheme: Scheme,
  size: Size,
  as?: ApiClient,
  baby?: string,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    baseURL: BASE,
    viewport: SIZES[size],
    colorScheme: scheme,
    reducedMotion: "reduce",
    isMobile: size === "phone",
    hasTouch: size === "phone",
    ...(as ? { storageState: await as.storageState() } : {}),
  });
  if (baby) await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), baby);
  return ctx;
}

const goto = async (page: Page, url: string, ready: string) => {
  await page.goto(url);
  await expect(tid(page, ready)).toBeVisible({ timeout: 20_000 });
};

async function run(browser: Browser, c: Ctx, scheme: Scheme, size: Size) {
  const dir = path.join(OUT, `${scheme}-${size}`);
  if (!only) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  counter = 0;
  console.log(`\n${scheme} ${size}`);

  // ---- signed out -----------------------------------------------------------------------
  {
    const ctx = await context(browser, scheme, size);
    const page = await ctx.newPage();
    const s = new Shooter(dir, page);
    await s.step("welcome", async () => {
      await goto(page, "/welcome", "welcome-email");
      await s.shot("welcome");
      await tid(page, "welcome-email").fill("not-an-email");
      await tid(page, "welcome-continue").click();
      await s.shot("welcome-error");
    });
    await s.step("verify", async () => {
      const email = uniqueEmail("verify");
      await page.goto("/welcome");
      await tid(page, "welcome-email").fill(email);
      await tid(page, "welcome-continue").click();
      await expect(tid(page, "verify-code")).toBeVisible();
      await s.shot("verify");
      await tid(page, "verify-code").fill("000000");
      await expect(tid(page, "verify-error")).toBeVisible({ timeout: 15_000 });
      await s.shot("verify-error");
    });
    await ctx.close();
  }

  // ---- onboarding screens (any signed-in user can open them) ------------------------------
  {
    const ctx = await context(browser, scheme, size, c.fresh, c.emptyBabyId);
    const page = await ctx.newPage();
    const s = new Shooter(dir, page);
    for (const [route, ready, name] of [
      ["/onboarding/consent", "consent-adult", "onboarding-consent"],
      ["/onboarding/profile", "profile-name", "onboarding-profile"],
      ["/onboarding/baby", "baby-name", "onboarding-baby"],
      ["/onboarding/invite", "onboarding-invite", "onboarding-invite"],
      ["/onboarding/plan", "plan", "onboarding-plan"],
      ["/onboarding/first-upload", "primer", "onboarding-primer"],
    ] as const) {
      await s.step(name, async () => {
        await goto(page, route, ready);
        await s.shot(name);
      });
    }
    await s.step("invite-accept", async () => {
      await page.goto(`/invite/${c.inviteToken}`);
      await page.waitForTimeout(1500);
      await s.shot("invite-accept");
    });
    await s.step("legal", async () => {
      await page.goto("/legal/terms");
      await page.waitForTimeout(600);
      await s.shot("legal");
    });

    // free tier, empty album: empty states and upsells
    await s.step("fresh-timeline", async () => {
      await goto(page, "/timeline", "timeline-empty");
      await s.shot("empty-timeline");
    });
    await s.step("fresh-chat", async () => {
      await goto(page, "/chat", "chat-upsell");
      await s.shot("chat-upsell");
    });
    await s.step("fresh-upload", async () => {
      await goto(page, "/upload", "upload-choose");
      await s.shot("upload-empty");
    });
    await s.step("fresh-milestones", async () => {
      await goto(page, "/milestones", "milestones-page");
      await s.shot("milestones-empty");
      await tid(page, "milestones-segment-growth").click();
      await expect(tid(page, "growth-empty")).toBeVisible();
      await s.shot("growth-empty");
    });
    await s.step("fresh-family", async () => {
      await goto(page, "/family", "family");
      await page.waitForTimeout(500);
      await s.shot("family-free");
    });
    await ctx.close();
  }

  // ---- free-tier album with real photos (upload flow, select mode, viewer) -----------------
  {
    const ctx = await context(browser, scheme, size, c.fresh, c.freshBabyId);
    const page = await ctx.newPage();
    const s = new Shooter(dir, page);
    await s.step("upload-flow", async () => {
      await goto(page, "/upload", "upload-input");
      await s.shot("upload");
      await tid(page, "upload-details-toggle").click();
      await s.shot("upload-details");
      await tid(page, "upload-details-toggle").click();
      const files = await Promise.all(
        [1, 2, 3, 4].map(async (i) => ({
          name: `visual-${Date.now()}-${i}.jpg`,
          mimeType: "image/jpeg",
          buffer: await sceneJpeg(1200, 900, 91000 + i + Math.floor(Math.random() * 5000)),
        })),
      );
      await page
        .locator('.ion-page:not(.ion-page-hidden) [data-testid="upload-input"]')
        .setInputFiles([
          ...files,
          { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a photo") },
        ]);
      await expect(tid(page, "upload-summary")).toBeVisible();
      await page.waitForTimeout(3500);
      await s.shot("upload-rows");
    });

    await s.step("juniper-timeline", async () => {
      await goto(page, "/timeline", "timeline-grid");
      await expect(
        page.locator('.ion-page:not(.ion-page-hidden) button[data-testid^="photo-"] img').first(),
      ).toBeVisible();
      await s.shot("timeline-free");
    });
    await s.step("select-mode", async () => {
      await tid(page, "select-mode").click();
      const thumbs = page.locator('.ion-page:not(.ion-page-hidden) button[data-testid^="photo-"]');
      await thumbs.nth(0).click();
      await thumbs.nth(2).click();
      await s.shot("timeline-select");
      await tid(page, "batch-details").click();
      await expect(page.getByTestId("batch-details-sheet")).toBeVisible();
      await s.shot("batch-sheet");
      await page.getByTestId("batch-cancel").click();
      await tid(page, "select-mode").click();
    });

    await s.step("viewer", async () => {
      await goto(page, "/timeline", "timeline-grid");
      // a photo that has a real image (the seeded demo photos have none in storage)
      await page
        .locator('.ion-page:not(.ion-page-hidden) button[data-testid^="photo-"]:has(img)')
        .first()
        .click();
      await expect(tid(page, "viewer-details")).toBeVisible();
      await page
        .locator('[data-testid^="viewer-slide-"] img')
        .first()
        .evaluate(
          (img) =>
            (img as HTMLImageElement).decode?.() ??
            new Promise((r) => img.addEventListener("load", r)),
        )
        .catch(() => undefined);
      await page.mouse.move(120, 120);
      await s.shot("viewer");
      await page.waitForTimeout(2600);
      await s.shot("viewer-controls-faded");
      await page.mouse.move(100, 100);
      await tid(page, "viewer-edit").click();
      await expect(tid(page, "details-form")).toBeVisible();
      await s.shot("viewer-edit");
      await tid(page, "details-add-measurement").click();
      await expect(page.getByTestId("measurement-form")).toBeVisible();
      await s.shot("measurement-sheet");
      await page.getByTestId("measurement-cancel").click();
      await tid(page, "details-cancel").click();
      await tid(page, "viewer-details-toggle").click();
      await page.mouse.move(110, 110);
      await s.shot("viewer-details-collapsed");
    });

    await ctx.close();
  }

  // ---- demo-mom (admin of Maya, plus) ------------------------------------------------------
  {
    const ctx = await context(browser, scheme, size, c.mom, MAYA);
    const page = await ctx.newPage();
    const s = new Shooter(dir, page);

    await s.step("chat", async () => {
      await c.mom.call("DELETE", `/babies/${MAYA}/chat/thread`);
      await goto(page, "/chat", "chat-panel");
      await expect(tid(page, "chat-intro")).toBeVisible();
      await s.shot("chat-empty");
      await tid(page, "chat-suggestion-0").click();
      await expect(tid(page, "chat-photo-grid")).toBeVisible({ timeout: 30_000 });
      await expect(tid(page, "chat-send")).toBeVisible({ timeout: 30_000 });
      await s.shot("chat-answer");
    });

    await s.step("timeline", async () => {
      await goto(page, "/timeline", "timeline-grid");
      await s.shot("timeline");
    });

    await s.step("search-chips", async () => {
      await tid(page, "chip-milestone").click();
      await s.shot("timeline-filter-chips");
      await tid(page, "chip-milestone").click();
    });

    await s.step("pending-view", async () => {
      await tid(page, "pending-segment").click();
      await s.shot("timeline-pending");
      await tid(page, "album-segment").click();
    });

    await s.step("milestones", async () => {
      await goto(page, "/milestones", "milestones-recorded");
      await s.shot("milestones");
      await tid(page, "milestone-add").click();
      await s.shot("milestones-add-form");
    });

    await s.step("growth", async () => {
      await goto(page, "/milestones", "milestones-page");
      await tid(page, "milestones-segment-growth").click();
      await page.waitForTimeout(800);
      await s.shot("growth");
    });

    await s.step("family", async () => {
      await goto(page, "/family", "family");
      await expect(tid(page, "members-list")).toBeVisible();
      await page.waitForTimeout(600);
      await s.shot("family", { fullPage: false });
    });

    await s.step("settings", async () => {
      await goto(page, "/settings", "settings");
      await s.shot("settings");
      await goto(page, "/settings/devices", "devices-list");
      await s.shot("settings-devices");
      await goto(page, "/settings/account", "account");
      await page.waitForTimeout(800);
      await s.shot("settings-account");
    });
    await ctx.close();
  }

  // ---- demo-nanny (contributor) -------------------------------------------------------------
  {
    const ctx = await context(browser, scheme, size, c.nanny, MAYA);
    const page = await ctx.newPage();
    const s = new Shooter(dir, page);
    await s.step("nanny-chat", async () => {
      await goto(page, "/chat", "chat-contributor-notice");
      await s.shot("chat-contributor");
    });
    await ctx.close();
  }
}

async function main() {
  const c = await setup();
  const browser = await chromium.launch();
  try {
    for (const scheme of schemes) for (const size of sizes) await run(browser, c, scheme, size);
  } finally {
    await browser.close();
  }
  console.log(`\nScreenshots in ${OUT}`);
}

await main();
