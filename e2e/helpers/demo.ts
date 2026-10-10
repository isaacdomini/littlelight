import { ApiClient } from "./api";

export const MAYA = "00000000-0000-4000-8000-000000000100";
export const PERF_BABY = "00000000-0000-4000-8000-000000000900";
export const photoId = (nn: number) =>
  `00000000-0000-4000-8000-0000000003${String(nn).padStart(2, "0")}`;

export type DemoUser = "demo-mom" | "demo-dad" | "demo-nanny";

// Sign-in codes are throttled (5 per email and 30 per IP per hour, in API memory), and a full
// `pnpm e2e` run signs the same demo users in from several spec files. The first sign-in's cookies
// are kept for the rest of the run (one Playwright worker process) and reused while they work.
const sessions = new Map<DemoUser, Awaited<ReturnType<ApiClient["storageState"]>>>();

/** Sign a seeded demo user in through the API (code from Mailpit) and accept consent if pending. */
export async function demoClient(user: DemoUser): Promise<ApiClient> {
  const email = `${user}@tinyglow.local`;
  const saved = sessions.get(user);
  if (saved) {
    const reused = await ApiClient.create(email, saved);
    if ((await reused.call("GET", "/me")).status === 200) return reused;
    await reused.dispose();
    sessions.delete(user);
  }
  const api = await ApiClient.create(email);
  await api.signIn();
  const me = await api.call<{
    consent: { ok: boolean; requiredTermsVersion: string; requiredPrivacyVersion: string };
  }>("GET", "/me");
  if (!me.body.consent.ok) {
    const r = await api.call("POST", "/me/consent", {
      termsVersion: me.body.consent.requiredTermsVersion,
      privacyVersion: me.body.consent.requiredPrivacyVersion,
      isAdult: true,
    });
    if (r.status !== 200) throw new Error(`consent answered ${r.status}`);
  }
  sessions.set(user, await api.storageState());
  return api;
}
