import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ApiClient, uniqueEmail } from "../helpers/api";
import { newContext, tid } from "../helpers/ui";

// Step 12 UI flow (docs/plans/step-12.md 2.8, 12.10): a 5 s MP4 picked through the upload page
// becomes an ingested row, a tile with a duration badge, and a playing <video> in the viewer with
// the signed `web` rendition (never the original) as its source.

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/video");
const MP4 = path.join(FIXTURES, "h264-1080p-5s.mp4");
const MOV = path.join(FIXTURES, "hevc-5s.mov");
const TOO_LONG = path.join(FIXTURES, "h264-70s-tiny.mp4");

test("web upload: a 5 s MP4 ingests, shows a duration badge and plays from the web rendition", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const mom = await ApiClient.create(uniqueEmail("vid"));
  await mom.onboard("Video Mom");
  await mom.createBaby("Vee");
  const ctx = await newContext(browser, mom);
  const page = await ctx.newPage();

  await page.goto("/upload");
  await tid(page, "upload-input").setInputFiles([
    { name: "clip.mp4", mimeType: "video/mp4", buffer: readFileSync(MP4) },
  ]);
  const row = page.locator('.ion-page:not(.ion-page-hidden) [data-testid^="upload-row-"]').first();
  await expect(row).toHaveAttribute("data-state", "ingested", { timeout: 60_000 });
  await expect(tid(page, "upload-summary")).toContainText("1 uploaded");

  // The register call carried the kind and the duration hint, never the file name.
  const photos = await mom.call<{
    photos: { id: string; mediaKind: string; durationMs: number | null; renditionStatus: string }[];
  }>(
    "GET",
    `/babies/${(await mom.call<{ babies: { id: string }[] }>("GET", "/me")).body.babies[0]?.id}/photos?media=video`,
  );
  expect(photos.status).toBe(200);
  expect(photos.body.photos).toHaveLength(1);
  const video = photos.body.photos[0];
  expect(video?.mediaKind).toBe("video");
  expect(Math.abs((video?.durationMs ?? 0) - 5000)).toBeLessThan(300);

  // Timeline tile: thumb + duration badge.
  await tid(page, "upload-view-timeline").click();
  await expect(page).toHaveURL(/\/timeline/);
  const grid = tid(page, "timeline-grid");
  await expect(grid.locator("img")).toHaveCount(1, { timeout: 15_000 });
  await expect(grid.getByText("0:05")).toBeVisible();

  // Viewer: a <video> whose source is the signed web rendition once the transcode is done.
  await grid.locator("img").first().click();
  const player = page.locator("video").first();
  await expect(player).toBeVisible({ timeout: 90_000 });
  await expect
    .poll(async () => player.getAttribute("src"), { timeout: 90_000 })
    .toMatch(/web\.mp4/);
  const src = (await player.getAttribute("src")) ?? "";
  expect(src).not.toMatch(/originals/);
  await expect
    .poll(() => player.evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(1);
  // The rendition is range-served straight from storage (206 on a byte range).
  const ranged = await page.request.get(src, { headers: { Range: "bytes=0-1023" } });
  expect(ranged.status()).toBe(206);

  await ctx.close();
  await mom.dispose();
});

test("a 70 s clip on a free album fails as video_too_long in the upload list; the MOV beside it still ingests", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const mom = await ApiClient.create(uniqueEmail("vidlong"));
  await mom.onboard("Long Mom");
  await mom.createBaby("Ell");
  const ctx = await newContext(browser, mom);
  const page = await ctx.newPage();
  await page.goto("/upload");
  await tid(page, "upload-input").setInputFiles([
    { name: "long.mp4", mimeType: "video/mp4", buffer: readFileSync(TOO_LONG) },
    { name: "short.mov", mimeType: "video/quicktime", buffer: readFileSync(MOV) },
  ]);
  const rows = page.locator('.ion-page:not(.ion-page-hidden) [data-testid^="upload-row-"]');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('[data-filename="long.mp4"]').first()).toHaveAttribute(
    "data-state",
    "failed",
    { timeout: 60_000 },
  );
  await expect(page.locator('[data-filename="short.mov"]').first()).toHaveAttribute(
    "data-state",
    "ingested",
    { timeout: 60_000 },
  );
  await expect(page.locator('[data-filename="long.mp4"]').first()).toContainText(/1 minute/i);
  await ctx.close();
  await mom.dispose();
});
