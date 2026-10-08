import { expect, test } from "@playwright/test";
import { ApiClient, masked, uniqueEmail } from "../helpers/api";
import { seenIds, waitForInviteToken } from "../helpers/mailpit";
import {
  acceptConsent,
  fillProfile,
  newContext,
  onboardViaUi,
  signInViaUi,
  tid,
} from "../helpers/ui";

// Step 3 gate (PRD build order step 3): "e2e test signs up, creates a baby, invites a co-admin,
// and the invitee accepts with the matching email; mismatched email is rejected."
test("parent signs up, creates a baby, invites a co-admin who accepts with the matching email", async ({
  page,
  browser,
}) => {
  const owner = uniqueEmail("owner");
  const invitee = uniqueEmail("coadmin");

  // Owner: UI sign-up, baby, co-admin invite.
  await onboardViaUi(page, owner, "Olive Owner", "Willow");
  // Onboarding "Invite co-parent" step: send the co-admin invite.
  await expect(page).toHaveURL(/\/onboarding\/invite/);
  const seen = await seenIds(invitee);
  await tid(page, "invite-email").fill(invitee);
  await tid(page, "invite-send").click();
  await expect(tid(page, "invite-sent")).toContainText(invitee);
  const token = await waitForInviteToken(invitee, seen);
  await tid(page, "invite-next").click();
  await tid(page, "plan-skip").click();
  await tid(page, "primer-later").click();
  await expect(page).toHaveURL(/\/timeline/);
  await expect(tid(page, "baby-switcher")).toContainText("Willow");

  // Invitee: fresh browser context follows the emailed link, signs in with the invited email.
  const ctx = await newContext(browser);
  const p2 = await ctx.newPage();
  await p2.goto(`/invite/${token}`);
  await expect(p2).toHaveURL(/\/welcome/); // signed out: token remembered, sent to sign in
  await signInViaUi(p2, invitee, "");
  await acceptConsent(p2);
  await fillProfile(p2, "Cory Coadmin");
  // Accept is automatic; the success card is shown, then the invitee opens the album.
  await expect(tid(p2, "invite-accept")).toBeVisible();
  await expect(tid(p2, "invite-mismatch")).toHaveCount(0);
  await tid(p2, "invite-accept").click();
  await expect(p2).toHaveURL(/\/timeline/);
  await expect(tid(p2, "baby-switcher")).toContainText("Willow");

  // The members list shows two admins, from both sides.
  await p2.goto("/family");
  await expect(
    p2.locator('.ion-page:not(.ion-page-hidden) [data-testid="member-admin"]'),
  ).toHaveCount(2);
  await page.goto("/family");
  await expect(
    page.locator('.ion-page:not(.ion-page-hidden) [data-testid="member-admin"]'),
  ).toHaveCount(2);
  await ctx.close();

  // The link is single-use: a lookup now reports it as accepted.
  const lookup = await page.request.get(`/api/invites/${token}`);
  expect((await lookup.json()).status).toBe("accepted");
});

test("an invite opened with a different email is rejected with the masked address", async ({
  page,
}) => {
  const owner = await ApiClient.create(uniqueEmail("own"));
  await owner.onboard("Olive Owner");
  const babyId = await owner.createBaby("Hazel");
  const invited = uniqueEmail("invited");
  const wrong = uniqueEmail("wrong");
  const { token } = await owner.invite(babyId, invited, "admin");
  expect(token).toBeTruthy();

  await page.goto(`/invite/${token}`);
  await signInViaUi(page, wrong, "");
  await acceptConsent(page);
  await fillProfile(page, "Wendy Wrong");

  await expect(tid(page, "invite-mismatch")).toHaveText(
    `This invite was sent to ${masked(invited)}`,
  );
  await expect(tid(page, "invite-accept")).toHaveCount(0);

  // The API agrees: 403 invite_email_mismatch with the same message, and the wrong user has no album.
  const res = await page.request.post(`/api/invites/${token}/accept`, {
    headers: { "X-Littlelight-Client": "web" },
  });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.error).toBe("invite_email_mismatch");
  expect(body.message).toBe(`This invite was sent to ${masked(invited)}`);
  const babies = await page.request.get("/api/babies");
  const list = (await babies.json()) as { babies?: unknown[] } | unknown[];
  expect(Array.isArray(list) ? list : (list.babies ?? [])).toHaveLength(0);

  // Switching accounts signs the wrong user out and returns to the welcome screen.
  await tid(page, "invite-switch-account").click();
  await expect(page).toHaveURL(/\/welcome/);
  expect((await page.request.get("/api/me")).status()).toBe(401);
  await owner.dispose();
});

test("a third admin invite is refused: admins_full at invite creation and at accept time", async ({
  page,
}) => {
  const owner = await ApiClient.create(uniqueEmail("own"));
  await owner.onboard("Olive Owner");
  const babyId = await owner.createBaby("Rowan");

  // Both admin invites go out while only one admin exists, so only accept-time enforcement helps.
  const second = await ApiClient.create(uniqueEmail("second"));
  const third = uniqueEmail("third");
  const inviteSecond = await owner.invite(babyId, second.email, "admin");
  const inviteThird = await owner.invite(babyId, third, "admin");
  expect(inviteSecond.token).toBeTruthy();
  expect(inviteThird.token).toBeTruthy();

  await second.onboard("Sam Second");
  const ok = await second.call("POST", `/invites/${inviteSecond.token}/accept`);
  expect(ok.status).toBe(200);

  // Creating a further admin invite now fails at once.
  const direct = await owner.invite(babyId, uniqueEmail("fourth"), "admin");
  expect(direct.status).toBe(409);
  expect(direct.body.error).toBe("admins_full");

  // The third invitee accepts in the UI and is told the album is full; no membership is created.
  await page.goto(`/invite/${inviteThird.token}`);
  await signInViaUi(page, third, "");
  await acceptConsent(page);
  await fillProfile(page, "Theo Third");
  await expect(tid(page, "invite-failed")).toHaveText("This album already has two admins");
  const mine = await page.request.get("/api/babies");
  const list = (await mine.json()) as { babies?: unknown[] } | unknown[];
  expect(Array.isArray(list) ? list : (list.babies ?? [])).toHaveLength(0);

  await owner.dispose();
  await second.dispose();
});
