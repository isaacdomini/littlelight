import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { ApiClient } from "../helpers/api";
import { demoClient, MAYA } from "../helpers/demo";
import { newContext, tid } from "../helpers/ui";

// Step 7 chat on the seeded demo family (docs/plans/step-7.md 2.12): the fake stack answers
// deterministically. Mom (admin of paid Maya) asks a suggested question, sees the streamed answer
// with a photo grid and opens the viewer; clears the history; the nanny (contributor) sees a
// notice and no input; a free baby shows the upsell.

const FIRST_STEPS = "00000000-0000-4000-8000-000000000309";

let mom: ApiClient;
let nanny: ApiClient;
let ctxMom: BrowserContext;
let ctxNanny: BrowserContext;
let ctxFree: BrowserContext;
let freeBaby: string;

async function openChat(ctx: BrowserContext, babyId: string): Promise<Page> {
  await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), babyId);
  const page = await ctx.newPage();
  await page.goto("/chat");
  return page;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mom = await demoClient("demo-mom");
  nanny = await demoClient("demo-nanny");
  await mom.call("DELETE", `/babies/${MAYA}/chat/thread`);
  const created = await mom.call<{ id: string }>("POST", "/babies", {
    name: `E2E Free ${Date.now().toString(36)}`,
    birthDate: "2026-01-15",
  });
  expect(created.status).toBeLessThan(300);
  freeBaby = created.body.id;
  ctxMom = await newContext(browser, mom);
  ctxNanny = await newContext(browser, nanny);
  ctxFree = await newContext(browser, mom);
});

test.afterAll(async () => {
  await mom.call("DELETE", `/babies/${MAYA}/chat/thread`);
  if (freeBaby) await mom.call("DELETE", `/babies/${freeBaby}`);
  await ctxMom?.close();
  await ctxNanny?.close();
  await ctxFree?.close();
});

test("a suggested question streams an answer with a photo grid; a tap opens the viewer", async () => {
  const page = await openChat(ctxMom, MAYA);
  await expect(tid(page, "chat-intro")).toBeVisible();

  await tid(page, "chat-suggestion-0").click(); // "Show first steps"
  await expect(tid(page, "chat-user-message")).toContainText("Show first steps");
  // the assistant message arrives with a grid of photos and no citation markers in the text
  const answer = tid(page, "chat-assistant-message");
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(answer).not.toContainText("[photo:");
  const grid = tid(page, "chat-photo-grid");
  await expect(grid).toBeVisible({ timeout: 30_000 });
  const thumb = grid.getByTestId(`photo-${FIRST_STEPS}`);
  await expect(thumb).toBeVisible();
  await expect(tid(page, "chat-ungrounded")).toHaveCount(0);

  // tap -> the viewer opens on that photo (URL carries it)
  await thumb.click();
  await expect(page).toHaveURL(new RegExp(`photo=${FIRST_STEPS}`));
  await expect(
    page.getByTestId("photo-viewer-body").or(page.getByTestId("photo-viewer")).first(),
  ).toBeVisible();
  await page.getByTestId("viewer-close").first().click();
  await expect(page).not.toHaveURL(/photo=/);
  await page.close();

  // the turn is stored: the thread API has both messages and one turn less today
  const t = await mom.call<{ messages: unknown[]; turnsLeftToday: number }>(
    "GET",
    `/babies/${MAYA}/chat/thread`,
  );
  expect(t.body.messages).toHaveLength(2);
  expect(t.body.turnsLeftToday).toBeLessThan(100);
});

test("the conversation is still there after a reload, then clear history empties it", async () => {
  const page = await openChat(ctxMom, MAYA);
  await expect(tid(page, "chat-user-message")).toContainText("Show first steps");
  await expect(tid(page, "chat-assistant-message")).toBeVisible();

  await tid(page, "chat-clear").click();
  await page.getByRole("button", { name: "Clear history" }).last().click();
  await expect(tid(page, "chat-intro")).toBeVisible();
  await expect(tid(page, "chat-user-message")).toHaveCount(0);

  const t = await mom.call<{ threadId: string | null; messages: unknown[] }>(
    "GET",
    `/babies/${MAYA}/chat/thread`,
  );
  expect(t.body.threadId).toBeNull();
  expect(t.body.messages).toEqual([]);
  await page.close();
});

test("a typed question that matches nothing is answered honestly, with no photos", async () => {
  const page = await openChat(ctxMom, MAYA);
  await tid(page, "chat-input").fill("zebra submarine");
  await tid(page, "chat-send").click();
  const answer = tid(page, "chat-assistant-message");
  await expect(answer).toContainText("couldn't find anything", { timeout: 30_000 });
  await expect(tid(page, "chat-photo-grid")).toHaveCount(0);
  await page.close();
});

test("the nanny (contributor) sees the parents-only notice and no input", async () => {
  const page = await openChat(ctxNanny, MAYA);
  await expect(tid(page, "chat-contributor-notice")).toBeVisible();
  await expect(tid(page, "chat-input")).toHaveCount(0);
  await expect(tid(page, "chat-send")).toHaveCount(0);
  // and the API agrees
  const res = await nanny.call("GET", `/babies/${MAYA}/chat/thread`);
  expect(res.status).toBe(403);
  await page.close();
});

test("a free baby shows the upsell instead of the chat", async () => {
  const page = await openChat(ctxFree, freeBaby);
  await expect(tid(page, "chat-upsell")).toBeVisible();
  await expect(tid(page, "chat-input")).toHaveCount(0);
  await page.close();
});
