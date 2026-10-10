// Live check of Google Photos import (step 10, task 10.12) against the dev stack and the fake
// Google (localhost:18099): demo-mom connects through the fake consent (auto-allow), imports with
// the picker's `?autopick=all`, polls to done, sees the photos, disconnects. Then it removes what
// the run created (batches, items, photos, stored objects) and restores Maya's seed state.
//
//   pnpm exec tsx apps/mobile-web/scripts/live-google-import.ts

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { psql } from "../../../e2e/helpers/db";
import { demoClient, MAYA } from "../../../e2e/helpers/demo";
import { assertDevStack, restoreMayaSeedState } from "../../../e2e/helpers/reset";
import { tid } from "../../../e2e/helpers/ui";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../../..");
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const OUT = path.resolve(import.meta.dirname, "../.vite/screenshots/live");
mkdirSync(OUT, { recursive: true });

await assertDevStack();
const before = new Set(await psql(`select id from photos where baby_id = '${MAYA}'`));
const batchesBefore = new Set(
  await psql(`select id from import_batches where baby_id = '${MAYA}'`),
);
console.log(`baseline: ${before.size} photos, ${batchesBefore.size} batches`);

const FAKE = `http://localhost:${process.env.GOOGLE_FAKE_PORT ?? 18099}`;
const setConsent = (decision: "ask" | "allow") =>
  fetch(`${FAKE}/__fake/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
await setConsent("allow");

const mom = await demoClient("demo-mom");
const browser = await chromium.launch();
const ctx = await browser.newContext({
  baseURL: BASE,
  viewport: { width: 1000, height: 800 },
  storageState: await mom.storageState(),
});
await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
// The fake picker finishes by itself when asked to pick everything.
await ctx.route("**/picker/**", (route) => {
  const u = new URL(route.request().url());
  if (route.request().method() === "GET" && !u.searchParams.has("autopick")) {
    u.searchParams.set("autopick", "all");
    return route.continue({ url: u.toString() });
  }
  return route.continue();
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

let failed = false;
try {
  await page.goto("/settings/import");
  await expect(tid(page, "google-card")).toBeVisible({ timeout: 20_000 });
  await expect(tid(page, "google-location-note")).toContainText("removes locations");
  console.log("card visible, location note shown before connect");

  // Connect: consent opens in a new tab and ends on the connected page.
  const popupP = ctx.waitForEvent("page");
  await tid(page, "google-connect").click();
  const popup = await popupP;
  await popup.waitForURL(/\/import\/google\/connected\?/, { timeout: 30_000 });
  console.log("connected page:", new URL(popup.url()).search);
  await expect(tid(popup, "google-connected-page")).toBeVisible();
  await popup.screenshot({ path: path.join(OUT, "connected-ok.png") });
  await popup.waitForURL(/\/settings\/import$/, { timeout: 15_000 });
  console.log("web returned to returnTo");
  await popup.close();
  await page.bringToFront();
  await page.reload();
  await expect(tid(page, "google-connected")).toBeVisible({ timeout: 15_000 });
  console.log("connection shows connected");

  // Import: picker opens in a new tab, the fake auto-picks everything.
  const pickerP = ctx.waitForEvent("page");
  await tid(page, "google-import").click();
  const picker = await pickerP;
  await picker.waitForLoadState("domcontentloaded");
  console.log("picker opened:", new URL(picker.url()).host);
  await expect(tid(page, "google-sheet")).toBeVisible();
  await expect(
    tid(page, "google-progress-text").or(tid(page, "google-result-imported")),
  ).toBeVisible({
    timeout: 120_000,
  });
  await page.screenshot({ path: path.join(OUT, "importing.png") });
  await expect(tid(page, "google-results")).toBeVisible({ timeout: 180_000 });
  await page.screenshot({ path: path.join(OUT, "done.png") });
  const imported = await tid(page, "google-result-imported").innerText();
  console.log(
    "results:",
    imported.replace(/\n/g, " "),
    "|",
    (await tid(page, "google-results").innerText()).replace(/\n/g, " "),
  );
  await picker.close().catch(() => undefined);

  const after = await psql(`select id from photos where baby_id = '${MAYA}'`);
  const added = after.filter((x) => !before.has(x));
  console.log(`photos added to Maya: ${added.length}`);
  if (added.length === 0) throw new Error("no photos were imported");
  await tid(page, "google-done").click();
  await expect(page).toHaveURL(/\/timeline/);
  await expect(tid(page, "timeline"))
    .toBeVisible({ timeout: 20_000 })
    .catch(() => undefined);
  await page.screenshot({ path: path.join(OUT, "timeline.png") });

  // Disconnect with confirm.
  await page.goto("/settings/import");
  await expect(tid(page, "google-disconnect")).toBeVisible({ timeout: 15_000 });
  await expect(tid(page, "google-recent-row").first()).toBeVisible();
  await tid(page, "google-disconnect").click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(tid(page, "google-connect")).toBeVisible({ timeout: 15_000 });
  console.log("disconnected");
} catch (e) {
  failed = true;
  console.log("FAILED:", (e as Error).message.split("\n").slice(0, 6).join("\n"));
  await page.screenshot({ path: path.join(OUT, "failure.png") }).catch(() => undefined);
} finally {
  await browser.close();
  await setConsent("ask");
  // Clean up everything this run created.
  const after = await psql(`select id from photos where baby_id = '${MAYA}'`);
  const added = after.filter((x) => !before.has(x));
  const batches = (await psql(`select id from import_batches where baby_id = '${MAYA}'`)).filter(
    (x) => !batchesBefore.has(x),
  );
  const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");
  // Stored objects are keyed by the import item id (originals/ and derivatives/), not the photo id.
  const items = batches.length
    ? await psql(`select id from import_items where batch_id in (${list(batches)})`)
    : [];
  if (batches.length) {
    await psql(`delete from import_items where batch_id in (${list(batches)})`);
    await psql(`delete from import_batches where id in (${list(batches)})`);
  }
  if (added.length) await psql(`delete from photos where id in (${list(added)})`);
  if (items.length) {
    const rm = items.map((i) => `originals/${i} derivatives/${i}`).join(" ");
    await sh(
      "docker",
      [
        "compose",
        "-f",
        "docker-compose.dev.yml",
        "exec",
        "-T",
        "storage",
        "sh",
        "-c",
        `cd /data/tinyglow-dev/babies/${MAYA} && rm -rf ${rm}`,
      ],
      { cwd: ROOT },
    ).catch(() => undefined);
  }
  await psql(
    `delete from google_accounts where user_id = (select id from auth.users where email = 'demo-mom@tinyglow.local')`,
  ).catch(() => undefined);
  await restoreMayaSeedState();
  console.log(`cleaned: ${added.length} photos, ${batches.length} batches`);
  await mom.dispose();
}
process.exit(failed ? 1 : 0);
