import { ApiClient } from "./api";

export const MAYA = "00000000-0000-4000-8000-000000000100";
export const PERF_BABY = "00000000-0000-4000-8000-000000000900";
export const photoId = (nn: number) =>
  `00000000-0000-4000-8000-0000000003${String(nn).padStart(2, "0")}`;

export type DemoUser = "demo-mom" | "demo-dad" | "demo-nanny";

/** Sign a seeded demo user in through the API (code from Mailpit) and accept consent if pending. */
export async function demoClient(user: DemoUser): Promise<ApiClient> {
  const api = await ApiClient.create(`${user}@littlelight.local`);
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
  return api;
}
