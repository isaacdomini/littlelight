import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { sceneJpeg } from "../../apps/worker/src/testing/images";
import { ApiClient, uniqueEmail } from "../helpers/api";
import { newContext, tid } from "../helpers/ui";

// Step 4 UI flows (docs/plans/step-4.md 2.13): pick files through the UI, per-row state, summary
// line, thumbnails in the grid, duplicates reported as skipped, contributor -> pending -> approve.

const HEIC = path.resolve(import.meta.dirname, "../fixtures/heic/gps-640x480.heic");

const jpeg = async (seed: number, name: string) => ({
  name,
  mimeType: "image/jpeg",
  buffer: await sceneJpeg(1200, 900, 7000 + seed),
});

/** Every `<img>` in the visible grid has decoded (a real thumbnail, not the placeholder). */
async function expectThumbsLoaded(page: Page, count: number) {
  const grid = tid(page, "timeline-grid");
  await expect(grid.locator("img")).toHaveCount(count, { timeout: 10_000 });
  await expect
    .poll(
      () =>
        grid
          .locator("img")
          .evaluateAll(
            (imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length,
          ),
      { timeout: 10_000 },
    )
    .toBe(count);
}

test("admin uploads five photos (one HEIC) plus a duplicate: summary, rows, thumbnails", async ({
  browser,
}) => {
  const mom = await ApiClient.create(uniqueEmail("mom"));
  await mom.onboard("Upload Mom");
  await mom.createBaby("Pip");
  const ctx = await newContext(browser, mom);
  const page = await ctx.newPage();

  await page.goto("/upload");
  const four = await Promise.all([1, 2, 3, 4].map((i) => jpeg(i, `pic-${i}.jpg`)));
  const dup = { ...four[0], name: "pic-1-copy.jpg" };
  const heic = { name: "gps.heic", mimeType: "image/heic", buffer: readFileSync(HEIC) };
  await tid(page, "upload-input").setInputFiles([...four, heic, dup]);

  await expect(tid(page, "upload-summary-bar")).toBeVisible();
  await expect(tid(page, "upload-summary")).toHaveText(
    "5 uploaded, 0 failed, 1 duplicate skipped",
    { timeout: 30_000 },
  );
  const rows = page.locator('.ion-page:not(.ion-page-hidden) [data-testid^="upload-row-"]');
  await expect(rows).toHaveCount(6);
  await expect(rows.and(page.locator('[data-state="ingested"]'))).toHaveCount(5);
  await expect(rows.and(page.locator('[data-state="duplicate"]'))).toHaveCount(1);
  await expect(page.locator('[data-filename="gps.heic"]').first()).toHaveAttribute(
    "data-state",
    "ingested",
  );
  await expect(tid(page, "upload-retry-all")).toHaveCount(0);

  await tid(page, "upload-view-timeline").click();
  await expect(page).toHaveURL(/\/timeline/);
  await expectThumbsLoaded(page, 5);
  await ctx.close();
});

test("a text file renamed .jpg ends as a failed row without blocking the others", async ({
  browser,
}) => {
  const mom = await ApiClient.create(uniqueEmail("mom"));
  await mom.onboard("Upload Mom");
  await mom.createBaby("Pip");
  const ctx = await newContext(browser, mom);
  const page = await ctx.newPage();
  await page.goto("/upload");
  await tid(page, "upload-input").setInputFiles([
    await jpeg(11, "good.jpg"),
    { name: "notes.jpg", mimeType: "image/jpeg", buffer: Buffer.from("just text\n".repeat(40)) },
  ]);
  await expect(tid(page, "upload-summary")).toHaveText(
    "1 uploaded, 1 failed, 0 duplicates skipped",
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-filename="notes.jpg"]').first()).toHaveAttribute(
    "data-state",
    "failed",
  );
  await ctx.close();
});

test("contributor upload is pending; the admin approves it from the queue", async ({ browser }) => {
  const mom = await ApiClient.create(uniqueEmail("mom"));
  await mom.onboard("Approving Mom");
  const babyId = await mom.createBaby("Wren");
  const nannyEmail = uniqueEmail("nanny");
  const { token } = await mom.invite(babyId, nannyEmail, "contributor");
  expect(token).toBeTruthy();

  const nanny = await ApiClient.create(nannyEmail);
  await nanny.onboard("Nanny Nell");
  const accept = await nanny.call("POST", `/invites/${token}/accept`);
  expect(accept.status).toBe(200);

  // Nanny uploads one photo through the UI and sees the review note and the pending badge.
  const nctx = await newContext(browser, nanny);
  const npage = await nctx.newPage();
  await npage.goto("/upload");
  await tid(npage, "upload-input").setInputFiles([await jpeg(21, "nanny.jpg")]);
  await expect(tid(npage, "upload-summary")).toHaveText(
    "1 uploaded, 0 failed, 0 duplicates skipped",
    { timeout: 30_000 },
  );
  await tid(npage, "upload-view-timeline").click();
  await expect(tid(npage, "timeline-grid").locator('[data-testid^="photo-pending-"]')).toHaveCount(
    1,
  );
  await expect(tid(npage, "pending-segment")).toHaveCount(0); // contributors have no queue

  // Mom: "Needs approval (1)", approves, the queue empties and the badge is gone from the album.
  const mctx = await newContext(browser, mom);
  const mpage = await mctx.newPage();
  await mpage.goto("/timeline");
  await expect(tid(mpage, "pending-segment")).toContainText("Needs approval (1)");
  await tid(mpage, "pending-segment").click();
  const approve = tid(mpage, "timeline-grid").locator('[data-testid^="approve-"]');
  await expect(approve).toHaveCount(1);
  await approve.click();
  await expect(tid(mpage, "pending-segment")).toContainText("Needs approval (0)");
  await expect(tid(mpage, "timeline-empty")).toBeVisible();
  await tid(mpage, "album-segment").click();
  await expect(tid(mpage, "timeline-grid").locator('[data-testid^="photo-"]')).toHaveCount(1);
  await expect(tid(mpage, "timeline-grid").locator('[data-testid^="photo-pending-"]')).toHaveCount(
    0,
  );

  await nctx.close();
  await mctx.close();
});
