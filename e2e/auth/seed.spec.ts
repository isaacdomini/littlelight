import { expect, test } from "@playwright/test";
import { acceptConsent, fillProfile, signInViaUi, tid } from "../helpers/ui";

// Step-2 risk R1: the seeded demo family can sign in with the normal email-code flow.
test("seeded demo-mom signs in with a code and sees Maya's album as admin", async ({ page }) => {
  await signInViaUi(page, "demo-mom@littlelight.local");

  // Seeded profiles may or may not carry consent; accept whichever gates appear.
  await page.waitForURL(/\/(onboarding\/(consent|profile)|chat|timeline)/);
  if (/onboarding\/consent/.test(page.url())) await acceptConsent(page);
  if (/onboarding\/profile/.test(page.url())) await fillProfile(page, "Demo Mom");

  await expect(tid(page, "baby-switcher")).toContainText("Mimi"); // seeded nickname for Maya
  const me = await (await page.request.get("/api/me")).json();
  expect(me.user.email).toBe("demo-mom@littlelight.local");
  expect(
    me.babies.some(
      (b: { name: string; role: string }) => /Maya/.test(b.name) && b.role === "admin",
    ),
  ).toBe(true);

  await page.goto("/family");
  await expect(tid(page, "members-list")).toBeVisible();
  await expect(tid(page, "family-invite-email")).toBeVisible(); // admin-only section
});
