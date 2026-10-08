import { expect, test } from "@playwright/test";
import { ApiClient, uniqueEmail } from "../helpers/api";
import { newContext, tid } from "../helpers/ui";

const items = (page: import("@playwright/test").Page) =>
  page.locator('.ion-page:not(.ion-page-hidden) [data-testid="devices-list"] li');

test("devices list shows every session; signing one out ends only that session", async ({
  browser,
}) => {
  const user = await ApiClient.create(uniqueEmail("dev"));
  await user.onboard("Dana Devices");
  await user.createBaby("Ivy");
  // A second device signs in with a fresh code.
  const other = await ApiClient.create(user.email);
  await other.signIn();
  expect((await other.call("GET", "/me")).status).toBe(200);

  const ctx = await newContext(browser, user);
  const page = await ctx.newPage();
  await page.goto("/settings");
  await tid(page, "settings-devices").click();
  await expect(items(page)).toHaveCount(2);
  await expect(
    page.locator('.ion-page:not(.ion-page-hidden) [data-testid="devices-signout-current"]'),
  ).toHaveCount(1);

  // Sign out the other device (the only non-current row).
  await tid(page, "devices-signout").click();
  await expect(items(page)).toHaveCount(1);
  expect((await other.call("GET", "/me")).status).toBe(401);
  expect((await user.call("GET", "/me")).status).toBe(200);

  await ctx.close();
  await user.dispose();
  await other.dispose();
});

test("sign out everywhere revokes every session", async ({ browser }) => {
  const user = await ApiClient.create(uniqueEmail("all"));
  await user.onboard("Dana Devices");
  await user.createBaby("Ivy");
  const other = await ApiClient.create(user.email);
  await other.signIn();

  const ctx = await newContext(browser, user);
  const page = await ctx.newPage();
  await page.goto("/settings");
  await tid(page, "settings-devices").click();
  await expect(items(page)).toHaveCount(2);
  await tid(page, "devices-signout-all").click();
  await expect(page).toHaveURL(/\/welcome/);

  expect((await page.request.get("/api/me")).status()).toBe(401);
  expect((await other.call("GET", "/me")).status).toBe(401);
  expect((await user.call("GET", "/me")).status).toBe(401);
  await ctx.close();
  await user.dispose();
  await other.dispose();
});
