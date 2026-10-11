// Google Play store assets: phone screenshots (1080x2400) and the feature graphic (1024x500).
// The emulator cannot run on every dev machine, so this renders the real web app in Chromium at a
// 360x800 viewport with device scale 3 (exactly 1080x2400), forcing the Capacitor "android" shell
// checks the way scripts/screenshots.ts does. Demo family only (Maya's illustrations).
//
//   export PATH="$HOME/.cache/littlelight-pnpm/bin:$PATH"
//   docker compose -f docker-compose.dev.yml restart api   # clears the in-memory OTP throttles
//   pnpm exec tsx apps/mobile-web/scripts/store-screenshots-android.ts
//
// Output: fastlane/metadata/android/en-US/images/{phoneScreenshots,featureGraphic.png}
// and store/captioned/android/ (framed copies with a caption).
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import { demoClient, MAYA } from "../../../e2e/helpers/demo";
import { tid } from "../../../e2e/helpers/ui";
import { captionFrame, featureGraphic } from "./store-frames";
import { prepDemo } from "./store-prep";

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const ROOT = path.resolve(import.meta.dirname, "..");
const FIRST_STEPS_PHOTO = "00000000-0000-4000-8000-000000000309"; // demo seed: milestone, note, people, place
const IMAGES = path.join(ROOT, "fastlane/metadata/android/en-US/images");
const PHONE = path.join(IMAGES, "phoneScreenshots");
const CAPTIONED = path.join(ROOT, "store/captioned/android");

async function main() {
  rmSync(PHONE, { recursive: true, force: true });
  rmSync(CAPTIONED, { recursive: true, force: true });
  mkdirSync(PHONE, { recursive: true });
  mkdirSync(CAPTIONED, { recursive: true });

  const mom = await demoClient("demo-mom");
  await prepDemo(mom);
  await mom.call("GET", "/me");
  const token = (await mom.storageState()).cookies.find((x) => x.name === "ll_access")?.value;
  if (!token) throw new Error("no access token");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 360, height: 800 },
    deviceScaleFactor: 3,
    colorScheme: "light",
    reducedMotion: "reduce",
    isMobile: true,
    hasTouch: true,
    storageState: await mom.storageState(),
  });
  await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
  await ctx.addInitScript(
    `Object.defineProperty(window, "Capacitor", { configurable: true, get: () => ({ isNativePlatform: () => true, getPlatform: () => "android", convertFileSrc: (x) => x }), set: () => {} });`,
  );
  await ctx.route("**/api/**", (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }),
  );
  const page = await ctx.newPage();

  const goto = async (url: string, ready: string) => {
    await page.goto(url);
    await expect(tid(page, ready)).toBeVisible({ timeout: 20_000 });
  };
  const imagesLoaded = () =>
    page.waitForFunction(
      () =>
        [...document.querySelectorAll(".ion-page:not(.ion-page-hidden) img")].every(
          (i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0,
        ),
      undefined,
      { timeout: 20_000 },
    );

  const shots: { file: string; caption: string }[] = [];
  const shot = async (file: string, caption: string) => {
    await page.waitForTimeout(700);
    const out = path.join(PHONE, file);
    await page.screenshot({ path: out });
    shots.push({ file, caption });
    console.log("  ", path.relative(ROOT, out));
  };

  await goto("/timeline", "timeline-grid");
  await imagesLoaded();
  await page.waitForTimeout(2500); // let the header refresh indicator finish
  await shot("01-timeline.png", "Every moment, in order");

  await page
    .locator(`.ion-page:not(.ion-page-hidden) button[data-testid="photo-${FIRST_STEPS_PHOTO}"]`)
    .click();
  await expect(tid(page, "viewer-details")).toBeVisible();
  await page.waitForTimeout(800);
  // real AI description is shown (one-off real-provider run); no scrolling past it
  await page.mouse.move(120, 120);
  await shot("02-viewer.png", "Details saved with every photo");

  await goto("/milestones", "milestones-recorded");
  await shot("03-milestones.png", "Milestones, remembered");

  await goto("/family", "family");
  await expect(tid(page, "members-list")).toBeVisible();
  await shot("04-family.png", "Share with the people you choose");

  await goto("/upload", "upload-camera");
  await shot("05-upload.png", "Add photos in a tap");

  await goto("/chat", "chat-panel");
  await mom.call("DELETE", `/babies/${MAYA}/chat/thread`);
  await page.reload();
  await expect(tid(page, "chat-intro")).toBeVisible();
  await tid(page, "chat-input").fill("Show me her first steps");
  await tid(page, "chat-send").click();
  await expect(tid(page, "chat-photo-grid")).toBeVisible({ timeout: 30_000 });
  await expect(tid(page, "chat-send")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/June 14, 2026/)).toBeVisible({ timeout: 60_000 });
  await tid(page, "chat-input").blur();
  await imagesLoaded();
  await shot("06-chat.png", "Ask about any memory");

  await goto("/milestones", "milestones-page");
  await tid(page, "milestones-segment-growth").click();
  await expect(tid(page, "growth-chart")).toBeVisible();
  await shot("07-growth.png", "Watch them grow");

  await browser.close();

  for (const s of shots) {
    const framed = await captionFrame(
      readFileSync(path.join(PHONE, s.file)),
      s.caption,
      1080,
      2400,
    );
    await sharp(framed).toFile(path.join(CAPTIONED, s.file));
  }

  const feature = path.join(IMAGES, "featureGraphic.png");
  await sharp(await featureGraphic()).toFile(feature);
  console.log("  ", path.relative(ROOT, feature));
}

await main();
