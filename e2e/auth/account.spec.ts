import { expect, test } from "@playwright/test";
import { ApiClient, uniqueEmail } from "../helpers/api";
import { newContext, onboardViaUi, settleOnAlbum, tid } from "../helpers/ui";

test("a sole admin must delete the album before deleting the account", async ({ page }) => {
  const email = uniqueEmail("sole");
  await onboardViaUi(page, email, "Sole Parent", "Fern");
  await settleOnAlbum(page);
  await expect(tid(page, "baby-switcher")).toContainText("Fern");

  await tid(page, "open-settings").click();
  await tid(page, "settings-account").click();

  // Blocked: the album has no other admin.
  await expect(tid(page, "account-blocking")).toContainText("Fern");
  await expect(tid(page, "account-continue")).toBeDisabled();

  await tid(page, "blocking-delete-album").click();
  await tid(page, "blocking-delete-confirm").click();
  await expect(tid(page, "account-blocking")).toHaveCount(0);
  const babies = await (await page.request.get("/api/babies")).json();
  const list = (Array.isArray(babies) ? babies : (babies.babies ?? [])) as {
    deletedAt: string | null;
  }[];
  // Albums are soft-deleted: any row still listed carries a deletedAt.
  expect(list.filter((b) => !b.deletedAt)).toHaveLength(0);

  // With no album left the page stays on /settings/account; finish the deletion in the UI.
  await expect(page).toHaveURL(/\/settings\/account/);
  await expect(tid(page, "account-continue")).toBeEnabled();
  await tid(page, "account-continue").click();
  await expect(tid(page, "account-delete")).toBeDisabled(); // needs the acknowledgement
  await tid(page, "account-ack").check();
  await tid(page, "account-delete").click();
  await expect(page).toHaveURL(/\/welcome/);
  expect((await page.request.get("/api/me")).status()).toBe(401);
});

test("a co-admin can delete their account; the album stays for the other admin", async ({
  browser,
}) => {
  const owner = await ApiClient.create(uniqueEmail("keep-own"));
  await owner.onboard("Olive Owner");
  const babyId = await owner.createBaby("Sage");
  const co = await ApiClient.create(uniqueEmail("keep-co"));
  const invite = await owner.invite(babyId, co.email, "admin");
  await co.onboard("Cory Coadmin");
  expect((await co.call("POST", `/invites/${invite.token}/accept`)).status).toBe(200);

  const ctx = await newContext(browser, co);
  const page = await ctx.newPage();
  await page.goto("/settings");
  await tid(page, "settings-account").click();
  await expect(tid(page, "account-continue")).toBeEnabled();
  await expect(tid(page, "account-blocking")).toHaveCount(0);
  await tid(page, "account-continue").click();
  await tid(page, "account-ack").check();
  await tid(page, "account-delete").click();
  await expect(page).toHaveURL(/\/welcome/);
  expect((await page.request.get("/api/me")).status()).toBe(401);
  await ctx.close();

  // The owner still has the album, now with a single member.
  const members = await owner.call<{ members: unknown[] }>("GET", `/babies/${babyId}/members`);
  expect(members.status).toBe(200);
  expect(members.body.members).toHaveLength(1);
  expect((await owner.call("GET", `/babies/${babyId}`)).status).toBe(200);
  await owner.dispose();
  await co.dispose();
});
