import { t } from "../i18n";
import { errorMessage } from "./api";

export interface SignInError {
  message: string;
}

/** "about 5 hours" / "about 40 minutes" from a Retry-After in seconds. */
export function retryWhen(sec: number): string {
  const minutes = Math.max(1, Math.round(sec / 60));
  if (minutes < 90) {
    return t(minutes === 1 ? "signin.when.minutes.one" : "signin.when.minutes.other", {
      n: minutes,
    });
  }
  const hours = Math.round(minutes / 60);
  return t(hours === 1 ? "signin.when.hours.one" : "signin.when.hours.other", { n: hours });
}

/**
 * Sign-in never refuses for the abuse guards (they run when a family starts, see
 * `familyErrors.ts`), so this only passes server messages through.
 */
export function signInError(e: unknown): SignInError {
  return { message: errorMessage(e) };
}
