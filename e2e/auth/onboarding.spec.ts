import { expect, test } from "@playwright/test";
import { uniqueEmail } from "../helpers/api";
import {
  acceptConsent,
  createBabyViaUi,
  fillProfile,
  settleOnAlbum,
  signInViaUi,
  tid,
} from "../helpers/ui";

test("new parent signs up, consents and creates a baby, and reaches the album", async ({
  page,
}) => {
  const email = uniqueEmail("onb");
  await signInViaUi(page, email);

  await expect(page).toHaveURL(/\/onboarding\/consent/);
  // The adult checkbox gates the button: an unchecked box cannot submit.
  await expect(tid(page, "consent-continue")).toBeDisabled();
  await acceptConsent(page);

  await expect(page).toHaveURL(/\/onboarding\/profile/);
  await fillProfile(page, "Olive Onboard");

  await expect(page).toHaveURL(/\/onboarding\/baby/);
  await createBabyViaUi(page, "Juniper");
  await settleOnAlbum(page);
  await expect(tid(page, "baby-switcher")).toContainText("Juniper");

  // Family tab: invite a contributor from the admin section.
  const guest = uniqueEmail("guest");
  await page.goto("/family");
  await tid(page, "family-invite-email").fill(guest);
  await page.locator("#invite-role").selectOption("contributor");
  await tid(page, "family-invite-send").click();
  await expect(tid(page, "family-notice")).toContainText(guest);
  await expect(tid(page, "invites-list")).toContainText(guest);
  await page.goto("/timeline");

  // The session survives a reload (httpOnly cookies) and signed-in users skip /welcome.
  await page.reload();
  await expect(tid(page, "baby-switcher")).toContainText("Juniper");
  await page.goto("/welcome");
  await expect(page).not.toHaveURL(/\/welcome/);

  const me = await page.request.get("/api/me");
  expect(me.status()).toBe(200);
  expect((await me.json()).user.email).toBe(email);
});

// The PRD sign-up flow: invite co-parent -> plan -> primer -> album.
test("onboarding walks invite -> plan -> primer after the first baby", async ({ page }) => {
  await signInViaUi(page, uniqueEmail("flow"));
  await acceptConsent(page);
  await fillProfile(page, "Flo Flow");
  await createBabyViaUi(page, "Poppy");
  await expect(page).toHaveURL(/\/onboarding\/invite/, { timeout: 5_000 });
  await tid(page, "invite-skip").click();
  await expect(page).toHaveURL(/\/onboarding\/plan/);
  await tid(page, "plan-skip").click();
  await expect(page).toHaveURL(/\/onboarding\/first-upload/);
  await tid(page, "primer-later").click();
  await expect(page).toHaveURL(/\/timeline/);
});

test("a wrong sign-in code is rejected and the user stays on the code screen", async ({ page }) => {
  const email = uniqueEmail("badcode");
  await page.goto("/welcome");
  await tid(page, "welcome-email").fill(email);
  await tid(page, "welcome-continue").click();
  await expect(tid(page, "verify-code")).toBeVisible();
  await tid(page, "verify-code").fill("000000");
  await expect(tid(page, "verify-error")).toBeVisible();
  await expect(page).toHaveURL(/\/verify/);
  expect((await page.request.get("/api/me")).status()).toBe(401);
});

test("signed-out visitors cannot reach the app", async ({ page }) => {
  await page.goto("/timeline");
  await expect(page).toHaveURL(/\/welcome/);
  expect((await page.request.get("/api/babies")).status()).toBe(401);
});
