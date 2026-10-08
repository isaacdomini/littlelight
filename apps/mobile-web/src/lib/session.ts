// Small client-side state helpers. Only `currentBabyId` persists (localStorage); the pending
// invite token and PKCE verifier live in sessionStorage and are removed after use. Tokens are
// never stored on the web.
const PENDING_INVITE_KEY = "ll_pending_invite";
const PKCE_KEY = "ll_pkce_verifier";
const CURRENT_BABY_KEY = "ll_current_baby";

function ss(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
function ls(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const pendingInvite = {
  get: () => ss()?.getItem(PENDING_INVITE_KEY) ?? null,
  set: (token: string) => ss()?.setItem(PENDING_INVITE_KEY, token),
  clear: () => ss()?.removeItem(PENDING_INVITE_KEY),
};

export const pkceVerifier = {
  get: () => ss()?.getItem(PKCE_KEY) ?? null,
  set: (v: string) => ss()?.setItem(PKCE_KEY, v),
  clear: () => ss()?.removeItem(PKCE_KEY),
};

export const currentBabyStore = {
  get: () => ls()?.getItem(CURRENT_BABY_KEY) ?? null,
  set: (id: string) => ls()?.setItem(CURRENT_BABY_KEY, id),
  clear: () => ls()?.removeItem(CURRENT_BABY_KEY),
};

export function markOnboardingDone(babyId: string): void {
  ls()?.setItem(`onboardingDone:${babyId}`, "1");
}

// The email being verified is kept in memory only (never in the URL or storage); a reload sends
// the user back to /welcome.
let verifyEmail: string | null = null;
export const pendingEmail = {
  get: () => verifyEmail,
  set: (e: string) => {
    verifyEmail = e;
  },
  clear: () => {
    verifyEmail = null;
  },
};

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Creates and stores a PKCE verifier, returns its S256 challenge. */
export async function createPkceChallenge(): Promise<string> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  pkceVerifier.set(verifier);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
