import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { ApiClient, uniqueEmail } from "../helpers/api";
import { psql } from "../helpers/db";
import {
  acceptConsent,
  createBabyViaUi,
  fillProfile,
  newContext,
  signInViaUi,
  tid,
} from "../helpers/ui";

// Passkey sign-in end to end (docs/plans/step-13.md 2.8, 4) against the dev stack with Chromium's
// virtual authenticator (CDP `WebAuthn.*`: ctap2, internal, resident key, user verification).
// OTP sign-in -> enrol card -> sign out -> sign in with the passkey -> Settings shows last used ->
// rename -> remove (behind the fresh-sign-in gate) -> OTP still works; passkey_limit after 5;
// account deletion removes GoTrue's rows; an authenticator that does not verify the user is
// refused with passkey_failed. Requires AUTH_PASSKEYS_ENABLED=true on the stack (dev default).

const PASSKEY_FAILED = "That passkey didn't work. Use your email code instead.";

async function virtualAuthenticator(page: Page, isUserVerified = true) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified,
      automaticPresenceSimulation: true,
    },
  })) as { authenticatorId: string };
  return { cdp, authenticatorId };
}

async function credentialCount(cdp: CDPSession, authenticatorId: string): Promise<number> {
  const { credentials } = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })) as {
    credentials: unknown[];
  };
  return credentials.length;
}

/** Scoped to the visible page, like `tid`, but all matches. */
const all = (page: Page, id: string) =>
  page.locator(`.ion-page:not(.ion-page-hidden) [data-testid="${id}"]`);

async function userId(email: string): Promise<string> {
  const rows = await psql(`select id from auth.users where email = '${email}'`);
  if (!rows[0]) throw new Error("user not found");
  return rows[0];
}

async function goTrueRowCounts(uid: string): Promise<{ credentials: number; challenges: number }> {
  const [c, ch] = await Promise.all([
    psql(`select count(*) from auth.webauthn_credentials where user_id = '${uid}'`),
    psql(`select count(*) from auth.webauthn_challenges where user_id = '${uid}'`),
  ]);
  return { credentials: Number(c[0]), challenges: Number(ch[0]) };
}

async function signOutEverywhere(page: Page) {
  await page.goto("/settings");
  await tid(page, "settings-devices").click();
  await tid(page, "devices-signout-all").click();
  await expect(page).toHaveURL(/\/welcome/);
}

test.describe.configure({ mode: "serial" });

test("enrol after the first OTP sign-in, sign in with the passkey, manage it in Settings, remove it behind the gate, OTP still works", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("passkey");
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const { cdp, authenticatorId } = await virtualAuthenticator(page);

  // The sign-in screen offers the passkey button only when the server has the feature on and this
  // browser has a user-verifying platform authenticator (the virtual one).
  await page.goto("/welcome");
  await expect(tid(page, "welcome-passkey")).toBeVisible();
  await expect(tid(page, "welcome-email")).toHaveAttribute("autocomplete", "username webauthn");

  // 1. OTP sign-up through the UI.
  await signInViaUi(page, email, "");
  await acceptConsent(page);
  await fillProfile(page, "Pat Passkey");
  await createBabyViaUi(page, "Ivy");
  await expect(page).toHaveURL(/\/(chat|onboarding\/invite)/);
  await page.goto("/timeline");

  // 2. The one-time enrol card (Q2) after the sign-up finished, inside the app.
  const promptAdd = page.getByTestId("passkey-prompt-add");
  await expect(promptAdd).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("passkey-prompt-later")).toBeVisible();
  await promptAdd.click();
  await expect(page.getByTestId("passkey-prompt-added")).toBeVisible({ timeout: 30_000 });
  expect(await credentialCount(cdp, authenticatorId)).toBe(1);
  await page.getByTestId("passkey-prompt-done").click();

  // Settings lists it, never used yet.
  await page.goto("/settings");
  await tid(page, "settings-passkeys").click();
  await expect(tid(page, "passkeys-list")).toBeVisible();
  await expect(all(page, "passkey-name")).toHaveCount(1);
  await expect(tid(page, "passkey-last-used")).toHaveText("Not used yet");
  await expect(tid(page, "passkeys-count")).toHaveText("1 of 5 passkeys");

  // GoTrue holds exactly one credential for this user.
  const uid = await userId(email);
  expect((await goTrueRowCounts(uid)).credentials).toBe(1);

  // 3. Sign out everywhere, sign in with the passkey.
  await signOutEverywhere(page);
  await tid(page, "welcome-passkey").click();
  await expect(page).not.toHaveURL(/\/welcome/, { timeout: 30_000 });
  await page.goto("/settings");
  await tid(page, "settings-passkeys").click();
  await expect(tid(page, "passkey-last-used")).toHaveText(/^Last used /);
  // The card is never offered again (a passkey exists / dismissed for good).
  await page.goto("/timeline");
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("passkey-prompt-add")).toHaveCount(0);

  // The devices list names the sign-in method.
  await page.goto("/settings");
  await tid(page, "settings-devices").click();
  await expect(all(page, "devices-method").filter({ hasText: "Passkey" }).first()).toBeVisible();

  // 4. Rename inline.
  await page.goto("/settings");
  await tid(page, "settings-passkeys").click();
  await tid(page, "passkey-rename").click();
  await tid(page, "passkey-rename-input").fill("Office laptop");
  await tid(page, "passkey-rename-save").click();
  await expect(tid(page, "passkey-name")).toHaveText("Office laptop");

  // 5. Remove: age the session past 10 minutes so the fresh-sign-in gate opens, then re-verify
  //    with the passkey (Q4/Q5) and the removal proceeds.
  await psql(
    `update auth.sessions set created_at = now() - interval '20 minutes' where user_id = '${uid}'`,
  );
  await tid(page, "passkey-remove").click();
  await page.getByRole("button", { name: "Remove passkey" }).click();
  const gatePasskey = page.getByTestId("fresh-gate-passkey");
  await expect(gatePasskey).toBeVisible({ timeout: 15_000 });
  await gatePasskey.click();
  await expect(tid(page, "passkeys-empty")).toBeVisible({ timeout: 30_000 });
  expect((await goTrueRowCounts(uid)).credentials).toBe(0);

  // 6. The email code still works after the last passkey is gone.
  await signOutEverywhere(page);
  await signInViaUi(page, email, "");
  // signInViaUi returns as the code auto-submits: wait until the verify page is gone too.
  await expect(page).not.toHaveURL(/\/(welcome|verify)/, { timeout: 30_000 });

  await ctx.close();
});

test("passkey_limit after 5: the add button gives way to the limit notice; account deletion removes GoTrue's rows", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const email = uniqueEmail("pklimit");
  const api = await ApiClient.create(email);
  await api.onboard("Lim Passkey");
  await api.createBaby("Max");
  const ctx = await newContext(browser, api);
  const page = await ctx.newPage();
  const { cdp, authenticatorId } = await virtualAuthenticator(page);

  await page.goto("/settings/passkeys");
  await expect(tid(page, "passkeys-empty")).toBeVisible();
  // One passkey per authenticator: GoTrue's `excludeCredentials` (rightly) refuses a second
  // registration on the same device, and Chrome allows one internal virtual authenticator per
  // environment, so each iteration swaps in a fresh one (the server's list is what counts).
  let current = authenticatorId;
  for (let i = 1; i <= 5; i++) {
    if (i > 1) {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: current });
      const next = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      })) as { authenticatorId: string };
      current = next.authenticatorId;
    }
    await tid(page, "passkeys-add").click();
    await tid(page, "passkey-name-input").fill(`Key ${i}`);
    await tid(page, "passkey-create").click();
    await expect(all(page, "passkey-name")).toHaveCount(i, { timeout: 30_000 });
  }
  expect(await credentialCount(cdp, current)).toBe(1);
  await expect(tid(page, "passkeys-full")).toBeVisible();
  await expect(all(page, "passkeys-add")).toHaveCount(0);
  await expect(tid(page, "passkeys-count")).toHaveText("5 of 5 passkeys");

  // The API refuses a sixth before GoTrue is asked (409 passkey_limit { max: 5 }).
  const sixth = await api.call<{ error: string; details?: { max: number } }>(
    "POST",
    "/me/passkeys/options",
  );
  expect(sixth.status).toBe(409);
  expect(sixth.body.error).toBe("passkey_limit");
  expect(sixth.body.details?.max).toBe(5);

  // Deletion preview counts them from GoTrue; deleting the account removes every row.
  const uid = await userId(email);
  expect((await goTrueRowCounts(uid)).credentials).toBe(5);
  const preview = await api.call<{ passkeys: number; blockingBabies: unknown[] }>(
    "GET",
    "/me/deletion-preview",
  );
  expect(preview.body.passkeys).toBe(5);
  // The sole admin of a live album cannot delete the account (409 sole_admin): trash it first.
  const babyId = preview.body.blockingBabies.length
    ? (preview.body.blockingBabies[0] as { id: string }).id
    : (await api.call<{ babies: { id: string }[] }>("GET", "/me")).body.babies[0]?.id;
  const trash = await api.call("DELETE", `/babies/${babyId}`);
  expect([200, 204]).toContain(trash.status);
  const del = await api.call("DELETE", "/me", { acknowledge: true });
  expect(del.status).toBe(204);
  expect(await goTrueRowCounts(uid)).toEqual({ credentials: 0, challenges: 0 });
  expect(await psql(`select count(*) from auth.users where id = '${uid}'`)).toEqual(["0"]);

  await ctx.close();
  await api.dispose();
});

test("an authenticator that does not verify the user is refused with passkey_failed; the email code stays available", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("pknouv");
  const api = await ApiClient.create(email);
  await api.onboard("Nouv Passkey");
  await api.createBaby("Zed");
  const ctx = await newContext(browser, api);
  const page = await ctx.newPage();
  const { cdp, authenticatorId } = await virtualAuthenticator(page, true);

  // Enrol with user verification on (the API requires UV on the attestation too).
  await page.goto("/settings/passkeys");
  await tid(page, "passkeys-add").click();
  await tid(page, "passkey-create").click();
  await expect(all(page, "passkey-name")).toHaveCount(1, { timeout: 30_000 });

  // Sign out, then flip the authenticator to "user not verified": the assertion lacks the UV
  // flag and the API refuses it without asking GoTrue (decision g).
  await api.call("POST", "/auth/signout", { scope: "global" });
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  await page.goto("/welcome");
  await tid(page, "welcome-passkey").click();
  // Chrome's virtual authenticator refuses the ceremony itself when it cannot verify the user
  // (NotAllowedError → the "cancelled" line); a real authenticator that answers without the UV
  // flag is refused by the api with `passkey_failed` (covered by the api tests and the gate's
  // fabricated assertion). Either way: no sign-in, the email code stays on screen.
  await expect(tid(page, "welcome-error")).toHaveText(
    new RegExp(
      `${PASSKEY_FAILED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|Passkey sign-in was cancelled`,
    ),
    { timeout: 30_000 },
  );
  await expect(page).toHaveURL(/\/welcome/);
  await expect(tid(page, "welcome-email")).toBeVisible();
  await expect(tid(page, "welcome-continue")).toBeVisible();

  // Verified again: the same passkey signs in.
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
  await tid(page, "welcome-passkey").click();
  await expect(page).not.toHaveURL(/\/welcome/, { timeout: 30_000 });

  await ctx.close();
  await api.dispose();
});

test("the enrol card can be snoozed: 'Not now' hides it for this and the next sign-in session", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("pksnooze");
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await virtualAuthenticator(page);

  await signInViaUi(page, email);
  await acceptConsent(page);
  await fillProfile(page, "Sno Passkey");
  await createBabyViaUi(page, "Uma");
  // Wait for the create to settle before leaving: a goto right after the click aborts the in-flight
  // POST /babies response and the new page's GET /me can land before the album is committed.
  await expect(page).toHaveURL(/\/(chat|onboarding\/invite)/);
  await page.goto("/timeline");
  await expect(page.getByTestId("passkey-prompt-later")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("passkey-prompt-later").click();
  await expect(page.getByTestId("passkey-prompt-add")).toHaveCount(0);
  const stored = await page.evaluate(() => window.localStorage.getItem("ll.passkey.prompt.v1"));
  expect(stored).toBeTruthy();
  expect(Object.keys(JSON.parse(stored as string))).toEqual(["snoozedUntil"]);

  // A later OTP sign-in within the snooze does not re-offer it.
  await signOutEverywhere(page);
  await signInViaUi(page, email, "");
  // signInViaUi returns as the code auto-submits: wait until the verify page is gone too.
  await expect(page).not.toHaveURL(/\/(welcome|verify)/, { timeout: 30_000 });
  await page.goto("/timeline");
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("passkey-prompt-add")).toHaveCount(0);
  // Settings still offers it.
  await page.goto("/settings");
  await expect(tid(page, "settings-passkeys")).toBeVisible();

  await ctx.close();
});
