import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { ApiClient } from "../helpers/api";
import { psql } from "../helpers/db";
import { demoClient, MAYA, photoId } from "../helpers/demo";
import { newContext, tid } from "../helpers/ui";

// Step 6 UI checks (docs/plans/step-6.md 2.11, 6.10) on the seeded demo family: the seeded bath
// photo (…304) carries a stored description with the `bath` flag; no model is called here. The
// failed-photo case builds its state with SQL (two failed attempts + an analysis derivative) and
// removes it afterwards; the free baby is created through the API and deleted afterwards.

const BATH = photoId(4);
// Seeded without AI data. Since step 9 the worker's demo media gives it a real analysis copy; the
// fixture row below is only inserted when that is absent, and cleanup removes only the fixture
// row (its `e2e/` key), never the real one (`pnpm demo:media --check` counts it).
const FAILED = photoId(5);
const OVERRIDE = `Bath time with the yellow duck ${Date.now().toString(36)}`;

let mom: ApiClient;
let nanny: ApiClient;
let ctxMom: BrowserContext;
let page: Page;
let freeBaby: string | undefined;
let freePhoto: string | undefined;

async function clearOverrides() {
  await mom.call("PATCH", `/photos/${BATH}/ai`, {
    caption: null,
    detailed_description: null,
    search_tags: null,
  });
}

async function clearFailedFixture() {
  await psql(
    `delete from ai_batches where id in (select batch_id from ai_batch_items where photo_id = '${FAILED}');
     delete from photo_derivatives where photo_id = '${FAILED}' and kind = 'analysis'
       and storage_key = 'e2e/${FAILED}/analysis.jpg';
     update photos set ai_retry_requested_at = null where id = '${FAILED}'`,
  );
}

async function open(p: Page, id: string) {
  await p.goto(`/timeline?photo=${id}`);
  await expect(tid(p, "viewer-details")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mom = await demoClient("demo-mom");
  nanny = await demoClient("demo-nanny");
  await clearOverrides();
  await clearFailedFixture();
  ctxMom = await newContext(browser, mom);
  await ctxMom.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
  page = await ctxMom.newPage();
});

test.afterAll(async () => {
  await ctxMom?.close();
  await clearOverrides().catch(() => undefined);
  await clearFailedFixture().catch(() => undefined);
  if (freeBaby) await psql(`delete from babies where id = '${freeBaby}'`).catch(() => undefined);
  await mom?.dispose();
  await nanny?.dispose();
});

test("a described photo shows its caption, description, tags and the sensitive badge", async () => {
  await open(page, BATH);
  await expect(tid(page, "details-ai")).toBeVisible();
  await expect(tid(page, "details-ai-caption-text")).not.toBeEmpty();
  await expect(tid(page, "details-ai-description")).not.toBeEmpty();
  await expect(tid(page, "details-ai-tags")).toBeVisible();
  await expect(tid(page, "details-sensitive-badge")).toBeVisible();
  await expect(
    page.locator('.ion-page:not(.ion-page-hidden) [data-testid="details-ai-edited"]'),
  ).toHaveCount(0);
});

test("admin overrides the caption; it persists across reload; reset restores the AI caption", async () => {
  await open(page, BATH);
  const aiCaption = (await tid(page, "details-ai-caption-text").innerText()).trim();

  await tid(page, "details-ai-edit").click();
  await expect(tid(page, "ai-edit-form")).toBeVisible();
  await tid(page, "ai-edit-caption").fill(OVERRIDE);
  await tid(page, "ai-edit-save").click({ force: true });
  await expect(tid(page, "ai-edit-form")).toHaveCount(0);
  await expect(tid(page, "details-ai-caption-text")).toHaveText(OVERRIDE);
  await expect(tid(page, "details-ai-edited")).toBeVisible();

  await page.reload();
  await expect(tid(page, "viewer-details")).toBeVisible();
  await expect(tid(page, "details-ai-caption-text")).toHaveText(OVERRIDE);
  await expect(tid(page, "details-ai-edited")).toBeVisible();
  // the audit trail names the field, never the text
  const audit = await psql(
    "select metadata::text from audit_log where event = 'ai.override_updated' order by id desc limit 1",
  );
  expect(audit[0]).toContain("caption");
  expect(audit[0]).not.toContain("yellow duck");

  await tid(page, "details-ai-edit").click();
  await tid(page, "ai-edit-reset-caption").click();
  await tid(page, "ai-edit-save").click({ force: true });
  await expect(tid(page, "ai-edit-form")).toHaveCount(0);
  await expect(tid(page, "details-ai-caption-text")).toHaveText(aiCaption);
  await page.reload();
  await expect(tid(page, "details-ai-caption-text")).toHaveText(aiCaption);
  await expect(
    page.locator('.ion-page:not(.ion-page-hidden) [data-testid="details-ai-edited"]'),
  ).toHaveCount(0);
});

test("a contributor sees the description but has no edit button", async ({ browser }) => {
  const ctx = await newContext(browser, nanny);
  await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
  const p = await ctx.newPage();
  await open(p, BATH);
  await expect(tid(p, "details-ai-caption-text")).toBeVisible();
  await expect(tid(p, "details-ai-edit")).toHaveCount(0);
  await ctx.close();
});

test("a failed photo offers Retry to an admin; retrying leaves the failed state", async () => {
  await psql(
    `insert into photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
       values ('${FAILED}', 'analysis', 'e2e/${FAILED}/analysis.jpg', 768, 576, 1000)
       on conflict do nothing;
     with b1 as (insert into ai_batches (provider, model, status) values ('fake', 'gpt-6-luna', 'completed') returning id),
          b2 as (insert into ai_batches (provider, model, status) values ('fake', 'gpt-6-luna', 'completed') returning id)
     insert into ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, state, failure_kind)
       select b1.id, '${FAILED}'::uuid, '${MAYA}'::uuid, 1, 'v1', 'v1', 'failed', 'invalid_output' from b1
       union all
       select b2.id, '${FAILED}'::uuid, '${MAYA}'::uuid, 2, 'v1', 'v1', 'failed', 'refusal' from b2`,
  );
  await open(page, FAILED);
  await expect(tid(page, "details-ai-failed")).toBeVisible();
  await tid(page, "details-ai-retry").click();
  await expect(tid(page, "details-ai-failed")).toHaveCount(0);
  await expect(tid(page, "details-ai-pending")).toBeVisible();
  const [flag] = await psql(
    `select ai_retry_requested_at is not null from photos where id = '${FAILED}'`,
  );
  expect(flag).toBe("t");
  await clearFailedFixture();
});

test("a free baby shows the Plus upsell in the viewer and in the usage section", async () => {
  freeBaby = await mom.createBaby(`E2E Free ${Date.now().toString(36)}`);
  freePhoto = crypto.randomUUID();
  await psql(
    `insert into photos (id, baby_id, storage_key_original, status, approval, taken_at)
       values ('${freePhoto}', '${freeBaby}', 'e2e/${freePhoto}/original.jpg', 'ingested', 'approved', now());
     insert into photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
       values ('${freePhoto}', 'thumb', 'e2e/${freePhoto}/thumb.jpg', 10, 10, 10),
              ('${freePhoto}', 'display', 'e2e/${freePhoto}/display.jpg', 10, 10, 10)`,
  );
  const ctx = await newContext(page.context().browser() as never, mom);
  await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), freeBaby as string);
  const p = await ctx.newPage();
  await open(p, freePhoto);
  await expect(tid(p, "details-ai-upgrade")).toBeVisible();
  await expect(tid(p, "details-ai-edit")).toHaveCount(0);
  await p.goto("/family");
  await expect(tid(p, "ai-usage")).toBeVisible();
  await expect(tid(p, "ai-usage")).not.toContainText("$");
  await ctx.close();
});

test("a paid baby's family page shows this month's usage", async () => {
  await page.goto("/family");
  await expect(tid(page, "ai-usage")).toContainText("$");
});
