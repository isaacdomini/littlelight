import { expect, test } from "@playwright/test";
import { ApiClient, masked, uniqueEmail } from "../helpers/api";
import { acceptConsent, createBabyViaUi, fillProfile, signInViaUi, tid } from "../helpers/ui";

// Step 11 (docs/plans/step-11.md, amended family model; task 11.8b): sign-in is never refused for
// abuse reasons. The checks run when an account starts a family, i.e. creates its first album:
// - another live account with the same canonical inbox (the "+twin" address) already runs a
//   family: 409 inbox_has_family, shown inline with the masked address of the holder;
// - a disposable domain: 400 email_not_allowed, shown inline; joining a family as a guest still
//   works for that account.

test("a +twin address signs in fine, but creating its own album is refused with the masked holder", async ({
  page,
}) => {
  const holder = await ApiClient.create(uniqueEmail("holder"));
  await holder.onboard("Hannah Holder");
  const holderBaby = await holder.createBaby("Holder Album");
  expect(holderBaby).toBeTruthy();

  const twin = holder.email.replace("@", "+twin@");
  await signInViaUi(page, twin); // not refused at sign-in
  await acceptConsent(page);
  await fillProfile(page, "Tamsin Twin");
  await createBabyViaUi(page, "Twin Album");

  await expect(tid(page, "baby-error")).toContainText("already has a family");
  await expect(tid(page, "baby-error")).toContainText(masked(holder.email));
  await expect(tid(page, "baby-error")).not.toContainText(holder.email);
  await expect(page).toHaveURL(/\/onboarding\/baby/);

  // The API agrees, and the twin has no album and no way to learn more than the masked address.
  const res = await page.request.post("/api/babies", {
    headers: { "X-Tinyglow-Client": "web" },
    data: { name: "Twin Album", birthDate: "2026-01-15" },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.error).toBe("inbox_has_family");
  expect(body.details).toEqual({ existingEmailMasked: masked(holder.email) });
  expect(JSON.stringify(body)).not.toContain(holder.email);
  const list = (await (await page.request.get("/api/babies")).json()) as
    | { babies?: unknown[] }
    | unknown[];
  expect(Array.isArray(list) ? list : (list.babies ?? [])).toHaveLength(0);

  await holder.dispose();
});

test("a disposable address signs in fine, cannot start a family, and can join one as a guest", async ({
  page,
}) => {
  const owner = await ApiClient.create(uniqueEmail("host"));
  await owner.onboard("Olive Owner");
  const babyId = await owner.createBaby("Host Album");

  const disposable = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-disp@mailinator.com`;
  await signInViaUi(page, disposable); // not refused at sign-in
  await acceptConsent(page);
  await fillProfile(page, "Dee Posable");
  await createBabyViaUi(page, "Nope Album");
  await expect(tid(page, "baby-error")).toContainText(/disposable/i);
  await expect(tid(page, "baby-error")).toContainText(/guest/i);
  await expect(page).toHaveURL(/\/onboarding\/baby/);

  // Joining as a guest (a contributor invite) is never blocked.
  const { token } = await owner.invite(babyId, disposable, "contributor");
  expect(token).toBeTruthy();
  await page.goto(`/invite/${token}`);
  await expect(tid(page, "invite-joined")).toBeVisible();
  const me = await page.request.get("/api/babies");
  expect(me.status()).toBe(200);
  const listed = (await me.json()) as { babies?: { role: string }[] } | { role: string }[];
  const babies = Array.isArray(listed) ? listed : (listed.babies ?? []);
  expect(babies).toHaveLength(1);
  expect(babies[0]?.role).toBe("contributor");
  await owner.dispose();
});
