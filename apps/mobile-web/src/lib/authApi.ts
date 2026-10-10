import { type SessionResponse, sessionResponseSchema } from "@tinyglow/shared";
import { isNative } from "../platform/platform";
import { getTokenStore } from "../platform/tokenStore";
import { apiFetch } from "./api";

/** Native: the API returns tokens in the body (no cookies); keep them in the Keychain/Keystore. */
async function keepTokens(res: SessionResponse): Promise<SessionResponse> {
  if (isNative() && res.tokens) {
    await getTokenStore().set({
      accessToken: res.tokens.accessToken,
      refreshToken: res.tokens.refreshToken,
    });
  }
  return res;
}

export function requestCode(email: string, captchaToken?: string): Promise<void> {
  return apiFetch("/auth/otp", {
    method: "POST",
    body: captchaToken ? { email, captchaToken } : { email },
  });
}

export function verifyCode(email: string, code: string): Promise<SessionResponse> {
  return apiFetch("/auth/verify", {
    method: "POST",
    body: { email, code },
    schema: sessionResponseSchema,
  }).then(keepTokens);
}

export function verifyTokenHash(tokenHash: string): Promise<SessionResponse> {
  return apiFetch("/auth/verify", {
    method: "POST",
    body: { tokenHash, type: "email" },
    schema: sessionResponseSchema,
  }).then(keepTokens);
}

export function exchangePkce(code: string, codeVerifier: string): Promise<SessionResponse> {
  return apiFetch("/auth/pkce", {
    method: "POST",
    body: { code, codeVerifier },
    schema: sessionResponseSchema,
  }).then(keepTokens);
}

/**
 * Signs out. On native, the push device is unregistered first (needs the bearer token), and the
 * Keychain/Keystore copy is wiped afterwards whether or not the request succeeded.
 */
export async function signOutRequest(scope: "local" | "global"): Promise<void> {
  if (!isNative()) {
    await apiFetch("/auth/signout", { method: "POST", body: { scope } });
    return;
  }
  const { beforeNativeSignOut } = await import("../platform/native/cleanup");
  try {
    await beforeNativeSignOut();
    await apiFetch("/auth/signout", { method: "POST", body: { scope } });
  } finally {
    await getTokenStore().clear();
  }
}
