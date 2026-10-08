import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { ApiClient } from "../helpers/api";
import { psql } from "../helpers/db";
import { demoClient, MAYA, photoId } from "../helpers/demo";
import { newContext, tid } from "../helpers/ui";

// Step 5 gate, "edits persist" (docs/plans/step-5.md 2.10). Runs on the seeded demo family (Maya,
// demo-mom admin, demo-nanny contributor). The photos used here are seeded without details; the
// spec resets them (and removes what it created) before and after, so repeated runs are stable.

const EDIT = photoId(8); // single-photo edit: approved, no seeded details, no measurements
const BATCH_A = photoId(1);
const BATCH_B = photoId(2); // keeps its seeded First smile milestone; only people/location are reset
const OTHERS = photoId(3); // dad's photo with seeded details, for the contributor checks
const TAG = `E2E ${Date.now().toString(36)}`;
const SWIM = `${TAG} swim`;
const POOL = `${TAG} pool day`;
const MEASURE_NOTE = "e2e-edits";

const q = (page: Page, id: string) => page.getByTestId(id).first();

let mom: ApiClient;
let nanny: ApiClient;
let ctxMom: BrowserContext;
let page: Page;

interface MilestoneRow {
  id: string;
  name: string;
  isPreset: boolean;
}

async function cleanup() {
  await mom.call("PATCH", `/photos/${EDIT}/details`, {
    milestoneId: null,
    people: [],
    locationLabel: null,
    note: null,
  });
  for (const id of [BATCH_A, BATCH_B]) {
    await mom.call("PATCH", `/photos/${id}/details`, { people: [], locationLabel: null });
  }
  const ms = await mom.call<{ measurements: { id: string; note: string | null }[] }>(
    "GET",
    `/babies/${MAYA}/measurements`,
  );
  for (const m of ms.body.measurements) {
    if (m.note === MEASURE_NOTE) await mom.call("DELETE", `/measurements/${m.id}`);
  }
  const list = await mom.call<{ milestones: MilestoneRow[] }>("GET", `/babies/${MAYA}/milestones`);
  for (const m of list.body.milestones) {
    if (!m.isPreset && m.name.startsWith("E2E ")) await mom.call("DELETE", `/milestones/${m.id}`);
  }
  await mom.call("PATCH", "/me/profile", { units: "metric" });
}

async function openPhoto(p: Page, id: string) {
  await p.goto(`/timeline?photo=${id}`);
  await expect(q(p, "viewer-details")).toBeVisible();
}

async function weightRowId(): Promise<string> {
  const r = await mom.call<{ measurements: { id: string; note: string | null }[] }>(
    "GET",
    `/babies/${MAYA}/measurements?kind=weight`,
  );
  const row = r.body.measurements.find((m) => m.note === MEASURE_NOTE);
  if (!row) throw new Error("measurement created by the spec not found");
  return row.id;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mom = await demoClient("demo-mom");
  nanny = await demoClient("demo-nanny");
  await cleanup();
  await mom.call("PATCH", "/me/profile", { units: "imperial" });
  ctxMom = await newContext(browser, mom);
  await ctxMom.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
  page = await ctxMom.newPage();
});

test.afterAll(async () => {
  await ctxMom?.close();
  await cleanup();
  await mom?.dispose();
  await nanny?.dispose();
});

test("admin edits a photo (inline custom milestone, people, location, note) and it persists", async () => {
  await openPhoto(page, EDIT);
  await q(page, "viewer-edit").click();
  await expect(q(page, "details-form")).toBeVisible();

  await q(page, "details-milestone").selectOption("__new__");
  await q(page, "details-milestone-custom").fill(SWIM);
  await q(page, "details-milestone-add").click();
  await expect(q(page, "details-milestone").locator("option:checked")).toHaveText(SWIM);

  for (const name of ["Grandma Rose", "Dad"]) {
    await q(page, "details-people-input").fill(name);
    await q(page, "details-people-input").press("Enter");
    await expect(q(page, `details-person-chip-${name}`)).toBeVisible();
  }
  await q(page, "details-location").fill("Riverside Park");
  await q(page, "details-note").fill("three wobbly steps");
  await q(page, "details-save").click();

  await expect(q(page, "details-milestone-value")).toContainText(SWIM);
  await expect(q(page, "details-people-value")).toContainText("Grandma Rose");

  await page.reload();
  await expect(q(page, "viewer-details")).toBeVisible();
  await expect(q(page, "details-milestone-value")).toContainText(SWIM);
  await expect(q(page, "details-people-value")).toContainText("Grandma Rose");
  await expect(q(page, "details-people-value")).toContainText("Dad");
  await expect(q(page, "details-location-value")).toHaveText(/Riverside Park/);
  await expect(q(page, "details-note-value")).toHaveText(/three wobbly steps/);

  // The badge is on the thumbnail in the grid.
  await q(page, "viewer-close").click();
  await expect(tid(page, `photo-milestone-badge-${EDIT}`)).toBeVisible();

  // Server truth, not just cache: the API echoes the same values.
  const got = await mom.call<{ details: { people: string[]; note: string } }>(
    "GET",
    `/photos/${EDIT}`,
  );
  expect(got.body.details.people).toEqual(["Grandma Rose", "Dad"]);
  expect(got.body.details.note).toBe("three wobbly steps");
});

test("measurement 7 lb 8 oz persists and round-trips between imperial and metric", async () => {
  await openPhoto(page, EDIT);
  await q(page, "viewer-edit").click();
  await q(page, "details-add-measurement").click();
  await expect(q(page, "measurement-form")).toBeVisible();
  await q(page, "measurement-value").fill("7");
  await q(page, "measurement-value-oz").fill("8");
  await q(page, "measurement-note").fill(MEASURE_NOTE);
  await q(page, "measurement-save").click();
  await expect(q(page, "measurement-form")).toBeHidden();

  await page.reload();
  await expect(q(page, "viewer-details")).toBeVisible();
  await expect(q(page, "details-measurements-value")).toContainText("7 lb 8.0 oz");

  const id = await weightRowId();
  const rows = await psql(`select value_metric, unit_entered from measurements where id = '${id}'`);
  expect(rows).toEqual(["3401.943|lb"]);

  // Growth tab, imperial.
  await page.goto("/milestones");
  await q(page, "milestones-segment-growth").click();
  await expect(q(page, `measurement-row-${id}`)).toContainText("7 lb 8.0 oz");

  // Metric.
  expect((await mom.call("PATCH", "/me/profile", { units: "metric" })).status).toBe(200);
  await page.reload();
  await q(page, "milestones-segment-growth").click();
  await expect(q(page, `measurement-row-${id}`)).toContainText("3.40 kg");
  await openPhoto(page, EDIT);
  await expect(q(page, "details-measurements-value")).toContainText("3.40 kg");

  // And back: the stored metric value is untouched by the display round trip.
  expect((await mom.call("PATCH", "/me/profile", { units: "imperial" })).status).toBe(200);
  await page.reload();
  await expect(q(page, "details-measurements-value")).toContainText("7 lb 8.0 oz");
  expect(await psql(`select value_metric from measurements where id = '${id}'`)).toEqual([
    "3401.943",
  ]);
});

test("batch details on several photos persist", async () => {
  await page.goto("/timeline");
  await q(page, "select-mode").click();
  await q(page, `photo-${BATCH_A}`).click();
  await q(page, `photo-${BATCH_B}`).click();
  await q(page, "batch-details").click();
  await q(page, "batch-people-input").fill("Nanny");
  await q(page, "batch-people-input").press("Enter");
  await q(page, "batch-location").fill("Grandma's house");
  await q(page, "batch-save").click();
  await expect(q(page, "batch-details-sheet")).toBeHidden();

  for (const id of [BATCH_A, BATCH_B]) {
    await openPhoto(page, id);
    await expect(q(page, "details-people-value")).toContainText("Nanny");
    await expect(q(page, "details-location-value")).toHaveText(/Grandma's house/);
  }
  // Not applied to a photo outside the selection.
  const other = await mom.call<{ details: { people: string[] } }>("GET", `/photos/${EDIT}`);
  expect(other.body.details.people).not.toContain("Nanny");
});

test("custom milestone rename and delete via the Milestones tab persist", async () => {
  const list = await mom.call<{ milestones: MilestoneRow[] }>("GET", `/babies/${MAYA}/milestones`);
  const swim = list.body.milestones.find((m) => m.name === SWIM);
  if (!swim) throw new Error("custom milestone from the first test is missing");

  await page.goto("/milestones");
  await expect(q(page, `milestone-card-${swim.id}`)).toContainText(SWIM);
  await q(page, `milestone-rename-${swim.id}`).click();
  await q(page, `milestone-rename-input-${swim.id}`).fill(POOL);
  await q(page, `milestone-rename-save-${swim.id}`).click();
  await expect(q(page, `milestone-card-${swim.id}`)).toContainText(POOL);

  await page.reload();
  await expect(q(page, `milestone-card-${swim.id}`)).toContainText(POOL);
  await openPhoto(page, EDIT);
  await expect(q(page, "details-milestone-value")).toContainText(POOL);

  await page.goto("/milestones");
  await q(page, `milestone-delete-${swim.id}`).click();
  await q(page, `milestone-delete-confirm-${swim.id}`).click();
  await expect(q(page, `milestone-card-${swim.id}`)).toHaveCount(0);

  await page.reload();
  await expect(q(page, "milestones-page")).toBeVisible();
  await expect(q(page, `milestone-card-${swim.id}`)).toHaveCount(0);
  // The photo keeps its other details; only the milestone is gone.
  await openPhoto(page, EDIT);
  await expect(q(page, "details-milestone-value")).not.toContainText(POOL);
  await expect(q(page, "details-people-value")).toContainText("Grandma Rose");
  await expect(q(page, "details-location-value")).toHaveText(/Riverside Park/);
  await expect(q(page, "details-note-value")).toHaveText(/three wobbly steps/);
});

test("contributor cannot edit others' photos: no edit control, 403 from the API", async ({
  browser,
}) => {
  const ctx = await newContext(browser, nanny);
  await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), MAYA);
  const p = await ctx.newPage();
  try {
    await openPhoto(p, OTHERS);
    await expect(q(p, "viewer-edit")).toHaveCount(0);
    await expect(q(p, "viewer-delete")).toHaveCount(0);
    await expect(q(p, "details-add-measurement")).toHaveCount(0);

    const patch = await nanny.call("PATCH", `/photos/${OTHERS}/details`, { note: "nope" });
    expect(patch.status).toBe(403);
    const batch = await nanny.call<{ updated: string[]; skipped: string[] }>(
      "POST",
      `/babies/${MAYA}/photos/details`,
      { photoIds: [OTHERS], note: "nope" },
    );
    expect(batch.body.updated ?? []).toEqual([]);
    const m = await nanny.call("POST", `/babies/${MAYA}/measurements`, {
      kind: "weight",
      value: 5,
      unit: "kg",
      measuredAt: "2025-08-01T12:00:00Z",
    });
    expect(m.status).toBe(403);
    const ms = await nanny.call("POST", `/babies/${MAYA}/milestones`, { name: "E2E nanny" });
    expect(ms.status).toBe(403);

    // The refused edit changed nothing.
    const after = await mom.call<{ details: { note: string | null } }>("GET", `/photos/${OTHERS}`);
    expect(after.body.details?.note ?? null).not.toBe("nope");
  } finally {
    await ctx.close();
  }
});
