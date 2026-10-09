import { expect, test } from "@playwright/test";
import { ApiClient, uniqueEmail } from "../helpers/api";
import { psql } from "../helpers/db";
import { type Created, type FreshAlbum, freshAlbum, tokenOf, viewerClient } from "../helpers/share";
import { newContext, tid } from "../helpers/ui";

// Step 8 UI flows (docs/plans/step-8.md 2.8-2.9, 4.1): the parent creates a link on the Family
// screen and sees the URL once; the viewer opens /s/:token (passcode, album, photo, hidden tile);
// expired, revoked and unknown links show the expired page; the page carries no-referrer.

let album: FreshAlbum;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  album = await freshAlbum(await ApiClient.create(uniqueEmail("sharespec")), "Willow", 770_000);
});

test.afterAll(async () => {
  await album?.api.dispose();
});

async function mk(name: string, extra: Record<string, unknown> = {}): Promise<Created> {
  const r = await album.api.call<Created>("POST", `/babies/${album.babyId}/share-links`, {
    name,
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body;
}

test("parent creates a link from the Family screen and sees the URL exactly once", async ({
  browser,
}) => {
  const ctx = await newContext(browser, album.api);
  const page = await ctx.newPage();
  await page.goto("/family");
  await expect(tid(page, "share-links-section")).toBeVisible();
  await tid(page, "share-create-open").click();
  await page.getByTestId("share-name").fill("Grandma and Grandpa");
  await page.getByTestId("share-create-submit").click();

  // The URL sheet: the full link, the "only time" notice.
  const urlInput = page.getByTestId("share-url-value");
  await expect(urlInput).toBeVisible();
  const url = await urlInput.inputValue();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{22,}$/);
  await expect(page.getByTestId("share-url-once")).toBeVisible();
  await page.getByTestId("share-url-done").click();
  await expect(page.getByTestId("share-url")).toHaveCount(0);

  // The card is listed, but nothing on the page (or in the API) shows the token again.
  const token = tokenOf(url);
  await expect(
    tid(page, "share-link-name").filter({ hasText: "Grandma and Grandpa" }),
  ).toBeVisible();
  expect(await page.content()).not.toContain(token);
  await page.reload();
  await expect(
    tid(page, "share-link-name").filter({ hasText: "Grandma and Grandpa" }),
  ).toBeVisible();
  expect(await page.content()).not.toContain(token);
  const list = await album.api.call("GET", `/babies/${album.babyId}/share-links`);
  expect(JSON.stringify(list.body)).not.toContain(token);
  await ctx.close();
});

test("viewer: passcode prompt, wrong code message, album, photo and hidden tile", async ({
  browser,
}) => {
  const [visible, sensitive] = album.photos;
  const link = await mk("Passcode gate", { passcode: "246810" });
  const add = await album.api.call("POST", `/share-links/${link.link.id}/photos`, {
    photoIds: [visible, sensitive],
  });
  expect(add.status).toBe(200);

  // A viewer context: a clean browser with no parent session.
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await page.goto(`/s/${tokenOf(link.url)}`);
  await expect(page.getByTestId("share-passcode")).toBeVisible();

  await page.getByTestId("share-passcode-field").fill("000000");
  await expect(page.getByTestId("share-passcode-error")).toBeVisible();
  await expect(page.getByTestId("share-album")).toHaveCount(0);

  await page.getByTestId("share-passcode-field").fill("246810");
  await expect(page.getByTestId("share-album")).toBeVisible();
  await expect(page.getByTestId("share-album-title")).toContainText("Willow");

  // The visible photo renders a real image; the sensitive one is a tile with no image.
  const thumb = page.getByTestId(`share-thumb-${visible}`);
  await expect(thumb).toBeVisible();
  await expect
    .poll(() =>
      thumb
        .locator("img")
        .evaluateAll((imgs) => imgs.some((i) => (i as HTMLImageElement).naturalWidth > 0)),
    )
    .toBe(true);
  const hidden = page.getByTestId(`share-hidden-${sensitive}`);
  await expect(hidden).toBeVisible();
  await expect(hidden.locator("img")).toHaveCount(0);

  // Opening the photo shows the viewer.
  await thumb.click();
  await expect(page.getByTestId("share-viewer")).toBeVisible();
  await page.getByTestId("share-viewer-close").click();

  // Viewer pages reach no parent route: the parent API answers 401 to this context.
  expect((await page.request.get("/api/me")).status()).toBe(401);
  await ctx.close();
});

test("an expired link shows the expired page", async ({ browser }) => {
  const link = await mk("Soon expired");
  const token = tokenOf(link.url);
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await page.goto(`/s/${token}`);
  await expect(page.getByTestId("share-album")).toBeVisible();

  await psql(
    `update share_links set expires_at = now() - interval '1 hour' where id = '${link.link.id}'`,
  );
  await page.reload();
  await expect(page.getByTestId("share-expired")).toBeVisible();
  await expect(page.getByTestId("share-album")).toHaveCount(0);
  // Nothing about the baby leaks on the expired page.
  await expect(page.locator("body")).not.toContainText("Willow");
  await ctx.close();
});

test("a revoked link shows the expired page, on reload and for a session already open", async ({
  browser,
}) => {
  const link = await mk("Soon revoked");
  const token = tokenOf(link.url);
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await page.goto(`/s/${token}`);
  await expect(page.getByTestId("share-album")).toBeVisible();

  const rev = await album.api.call("POST", `/share-links/${link.link.id}/revoke`, {});
  expect(rev.status).toBe(200);
  await page.reload();
  await expect(page.getByTestId("share-expired")).toBeVisible();

  // The open cookie session is dead too (API level, same context).
  const open = await page.request.get("/api/share/album");
  expect(open.status()).toBe(410);
  await ctx.close();
});

test("an unknown token shows the expired page, never a different error", async ({ browser }) => {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await page.goto("/s/not-a-real-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByTestId("share-expired")).toBeVisible();
  await ctx.close();
});

test("the viewer page carries no-referrer (meta, and nginx headers when nginx serves it)", async ({
  page,
}) => {
  const res = await page.goto("/s/whatever-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.locator('meta[name="referrer"][content="no-referrer"]')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);

  // The response headers come from production nginx (docker/nginx/default.conf); the dev stack
  // serves the SPA from Vite, which sets none of them. e2e/smoke/dev-stack.sh checks the nginx
  // config itself against a throwaway nginx container.
  const h = res?.headers() ?? {};
  if (/nginx/i.test(h.server ?? "") || process.env.E2E_EXPECT_NGINX === "1") {
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cache-control"]).toContain("no-store");
    expect(h["x-robots-tag"]).toContain("noindex");
  } else {
    test.info().annotations.push({
      type: "note",
      description: "not served by nginx (dev Vite): header assertions skipped",
    });
  }

  // A viewer-side exchange of an unknown token answers 410 (the expired page), nothing else.
  const v = await viewerClient();
  expect((await v.exchange("not-a-real-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(410);
  await v.ctx.dispose();
});
