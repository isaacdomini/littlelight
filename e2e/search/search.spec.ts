import { type BrowserContext, expect, test } from "@playwright/test";
import type { ApiClient } from "../helpers/api";
import { demoClient, MAYA } from "../helpers/demo";
import { newContext, tid } from "../helpers/ui";

// Step 7 search bar + filter chips on the seeded demo family (docs/plans/step-7.md 2.12, FR-7.5):
// typing a word narrows the grid to the matching photo; a person chip narrows by who is in it;
// tapping a result opens the viewer. Unrelated words find nothing (relevance floor).

const BATH = "00000000-0000-4000-8000-000000000304";

let mom: ApiClient;
let ctx: BrowserContext;

test.beforeAll(async ({ browser }) => {
  mom = await demoClient("demo-mom");
  ctx = await newContext(browser, mom);
  await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
});
test.afterAll(async () => {
  await ctx?.close();
});

test("search bar: a word finds exactly the matching photo, which opens in the viewer", async () => {
  const page = await ctx.newPage();
  await page.goto("/timeline");
  await tid(page, "search-input").fill("bath");
  await expect(tid(page, "search-count")).toHaveText(/1 photo found/, { timeout: 20_000 });
  const results = tid(page, "search-results");
  await expect(results.getByTestId(`photo-${BATH}`)).toBeVisible();
  await results.getByTestId(`photo-${BATH}`).click();
  await expect(page).toHaveURL(new RegExp(`photo=${BATH}`));
  await expect(tid(page, "viewer-details")).toBeVisible();
  await page.getByTestId("viewer-close").first().click();

  await tid(page, "search-clear").click();
  await expect(tid(page, "search-results")).toHaveCount(0);
  await page.close();
});

test("unrelated words find nothing", async () => {
  const page = await ctx.newPage();
  await page.goto("/timeline");
  await tid(page, "search-input").fill("zebra submarine");
  await expect(tid(page, "search-empty")).toBeVisible({ timeout: 20_000 });
  await expect(tid(page, "search-count")).toHaveText(/0 photos found/);
  await page.close();
});

test("a person chip narrows the grid", async () => {
  const page = await ctx.newPage();
  await page.goto("/timeline");
  await tid(page, "chip-person").click();
  const options = tid(page, "chip-options");
  await expect(options).toBeVisible();
  const first = options.getByRole("button").first();
  const label = (await first.textContent()) ?? "";
  expect(label).toMatch(/\(\d+\)|\d+/);
  await first.click();
  await expect(tid(page, "chip-remove-person")).toBeVisible();
  await expect(tid(page, "search-count")).toHaveText(/\d+ photos? found/, { timeout: 20_000 });
  const n = Number(/(\d+) photo/.exec((await tid(page, "search-count").textContent()) ?? "")?.[1]);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(10);
  await tid(page, "chip-remove-person").click();
  await expect(tid(page, "search-results")).toHaveCount(0);
  await page.close();
});

test("the nanny (contributor) has no search bar", async ({ browser }) => {
  const nanny = await demoClient("demo-nanny");
  const nctx = await newContext(browser, nanny);
  await nctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
  const page = await nctx.newPage();
  await page.goto("/timeline");
  await expect(tid(page, "baby-switcher")).toBeVisible();
  await expect(tid(page, "search-input")).toHaveCount(0);
  await nctx.close();
});

test("on a desktop-width window the timeline shows the chat pane next to the grid", async ({
  browser,
}) => {
  const wide = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`,
    viewport: { width: 1440, height: 900 },
    storageState: await mom.storageState(),
  });
  await wide.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
  const page = await wide.newPage();
  await page.goto("/timeline");
  await expect(tid(page, "chat-panel")).toBeVisible();
  await expect(tid(page, "chat-input")).toBeVisible();
  await wide.close();
});
