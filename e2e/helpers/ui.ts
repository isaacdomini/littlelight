import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import type { ApiClient } from "./api";
import { codeAfter, seenIds, waitForCode } from "./mailpit";

/** Locator scoped to the visible Ionic page (earlier pages stay mounted but hidden). */
export const tid = (page: Page, id: string): Locator =>
  page.locator(`.ion-page:not(.ion-page-hidden) [data-testid="${id}"]`).first();

/** Welcome -> email -> code. Leaves the browser signed in on whatever page comes next. */
export async function signInViaUi(page: Page, email: string, from = "/welcome"): Promise<void> {
  if (from) await page.goto(from);
  await tid(page, "welcome-email").fill(email);
  const seen = await seenIds(email);
  await tid(page, "welcome-continue").click();
  await expect(tid(page, "verify-code")).toBeVisible();
  const code = await waitForCode(email, seen);
  await tid(page, "verify-code").fill(code);
  // 6 digits auto-submit; the button is a fallback if the effect already fired this is a no-op.
}

export async function acceptConsent(page: Page): Promise<void> {
  await expect(tid(page, "consent-adult")).toBeVisible();
  await tid(page, "consent-adult").check();
  await tid(page, "consent-continue").click();
}

export async function fillProfile(page: Page, name: string): Promise<void> {
  await expect(tid(page, "profile-name")).toBeVisible();
  await tid(page, "profile-name").fill(name);
  await tid(page, "profile-continue").click();
}

export async function createBabyViaUi(page: Page, name: string): Promise<void> {
  await expect(tid(page, "baby-name")).toBeVisible();
  await tid(page, "baby-name").fill(name);
  await tid(page, "baby-birthdate").fill("2026-01-15");
  await tid(page, "baby-create").click();
}

/** Re-verify inside the fresh-sign-in modal (only when the 10-minute window has lapsed). */
export async function reverifyInGate(page: Page, email: string, trigger: () => Promise<unknown>) {
  const seen = await seenIds(email);
  await trigger();
  const gate = page.getByTestId("fresh-gate");
  await expect(gate).toBeVisible();
  await gate.getByTestId("verify-code").fill(await waitForCode(email, seen));
}

export { codeAfter };

/** A mobile-sized browser context, optionally already signed in as `as`. */
export async function newContext(browser: Browser, as?: ApiClient): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    viewport: { width: 375, height: 812 },
    ...(as ? { storageState: await as.storageState() } : {}),
  });
}

/** Sign in, accept consent, fill the profile and create the first baby, all through the UI. */
export async function onboardViaUi(
  page: Page,
  email: string,
  parentName: string,
  babyName: string,
): Promise<void> {
  await signInViaUi(page, email);
  await acceptConsent(page);
  await fillProfile(page, parentName);
  await createBabyViaUi(page, babyName);
}

/** Skip the rest of onboarding and settle on the timeline (for tests that only need an album). */
export async function settleOnAlbum(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/(chat|onboarding\/invite)/);
  await page.goto("/timeline");
  await expect(tid(page, "baby-switcher")).toBeVisible();
}
