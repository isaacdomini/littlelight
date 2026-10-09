import { refreshSession } from "../../lib/api";
import { getTokenStore } from "../tokenStore";

// Native session upkeep (docs/plans/step-9.md 2.5). The access token's `exp` is decoded locally
// (never logged) so a refresh happens before the first request fails.

const REFRESH_WINDOW_SEC = 5 * 60;

function expiresInSec(accessToken: string): number | null {
  try {
    const part = accessToken.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp - Date.now() / 1000 : null;
  } catch {
    return null;
  }
}

/** At launch and on app resume: refresh when the stored access token is within 5 minutes of expiry. */
export async function refreshIfNeeded(): Promise<void> {
  const tokens = await getTokenStore().get();
  if (!tokens) return;
  const left = expiresInSec(tokens.accessToken);
  if (left === null || left <= REFRESH_WINDOW_SEC) await refreshSession();
}

/** True when a session is stored on this device (cheap "maybe signed in" hint; the API decides). */
export async function hasStoredSession(): Promise<boolean> {
  return (await getTokenStore().get()) !== null;
}
