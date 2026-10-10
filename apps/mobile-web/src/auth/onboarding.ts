import type { MeResponse } from "@tinyglow/shared";
import { INVITE_PATH } from "@tinyglow/shared";

/**
 * Where a signed-in user must go before the app is usable, or null when onboarded
 * (consent accepted, profile named, at least one baby or a pending invite to accept).
 */
export function onboardingGate(me: MeResponse, pendingInviteToken: string | null): string | null {
  if (!me.consent.ok) return "/onboarding/consent";
  if (!me.profileComplete) return "/onboarding/profile";
  if (me.babies.length === 0) {
    return pendingInviteToken ? `${INVITE_PATH}/${pendingInviteToken}` : "/onboarding/baby";
  }
  return null;
}

/** Landing route after sign-in / `/`: the next onboarding step, a pending invite, or the app. */
export function nextOnboardingRoute(
  me: MeResponse | null,
  pendingInviteToken: string | null,
): string {
  if (!me) return "/welcome";
  const gate = onboardingGate(me, pendingInviteToken);
  if (gate) return gate;
  return pendingInviteToken ? `${INVITE_PATH}/${pendingInviteToken}` : "/chat";
}
