import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Passkey,
  type PasskeysListResponse,
  type PublicKeyCredentialJsonInput,
  passkeyOptionsResponseSchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeySchema,
  passkeysListResponseSchema,
  type SessionResponse,
  sessionResponseSchema,
} from "@tinyglow/shared";
import { useEffect, useState } from "react";
import { type GetOptions, passkeyPlatform } from "../platform/passkeys";
import { isNative } from "../platform/platform";
import { getTokenStore } from "../platform/tokenStore";
import { apiFetch } from "./api";
import { useAuthConfig } from "./queries/account";

// Passkey flows (docs/plans/step-13.md 2.1, 2.5): the API fronts GoTrue; this file joins the API
// calls to the platform ceremony. Nothing here logs options, challenge ids or credentials.

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

// ---- sign-in (public) --------------------------------------------------------------------------

/** `POST /auth/passkey/options`; 403 `captcha_required` after repeated failures from this IP. */
export function passkeySignInOptions(captchaToken?: string) {
  return apiFetch("/auth/passkey/options", {
    method: "POST",
    body: captchaToken ? { captchaToken } : {},
    schema: passkeyOptionsResponseSchema,
  });
}

/** `POST /auth/passkey/verify` -> session (cookies on the web, tokens kept on native). */
export function passkeySignInVerify(
  challengeId: string,
  credential: PublicKeyCredentialJsonInput,
): Promise<SessionResponse> {
  return apiFetch("/auth/passkey/verify", {
    method: "POST",
    body: { challengeId, credential },
    schema: sessionResponseSchema,
  }).then(keepTokens);
}

/**
 * The whole sign-in ceremony: options -> platform `get` -> verify. Throws `ApiError`
 * (`captcha_required`, `passkey_failed`, `rate_limited`, ...) or `PasskeyError` (`cancelled`, ...).
 * With `conditional`, the promise stays pending until the user picks a passkey from the email
 * field's suggestions (or the signal aborts).
 */
export async function passkeySignIn(
  opts: GetOptions & { captchaToken?: string } = {},
): Promise<SessionResponse> {
  const { challengeId, options } = await passkeySignInOptions(opts.captchaToken);
  const credential = await passkeyPlatform().get(options, {
    ...(opts.conditional ? { conditional: true } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return passkeySignInVerify(challengeId, credential);
}

// ---- management (signed in) -------------------------------------------------------------------

export const PASSKEYS_KEY = ["me", "passkeys"] as const;

export function listPasskeys(): Promise<PasskeysListResponse> {
  return apiFetch("/me/passkeys", { schema: passkeysListResponseSchema });
}

/** `POST /me/passkeys/options` -> platform `create` -> `POST /me/passkeys` (201). */
export async function registerPasskey(name?: string): Promise<Passkey> {
  const { challengeId, options } = await apiFetch("/me/passkeys/options", {
    method: "POST",
    schema: passkeyRegistrationOptionsResponseSchema,
  });
  const credential = await passkeyPlatform().create(options);
  const trimmed = name?.trim();
  return apiFetch("/me/passkeys", {
    method: "POST",
    body: { challengeId, credential, ...(trimmed ? { name: trimmed } : {}) },
    schema: passkeySchema,
  });
}

export function renamePasskey(id: string, name: string): Promise<Passkey> {
  return apiFetch(`/me/passkeys/${id}`, {
    method: "PATCH",
    body: { name: name.trim() },
    schema: passkeySchema,
  });
}

/** 403 `fresh_sign_in_required` when the sign-in is older than 10 minutes (wrap in `withFresh`). */
export function removePasskey(id: string): Promise<void> {
  return apiFetch(`/me/passkeys/${id}`, { method: "DELETE" });
}

// ---- hooks -------------------------------------------------------------------------------------

/**
 * Whether passkey UI may render: the server flag (`/auth/config.passkeys`) and the platform's
 * support, both required. `undefined` while either is unknown. Feature off or unsupported
 * browser/device: nothing passkey-related renders anywhere.
 */
export function usePasskeySupport(): {
  enabled: boolean | undefined;
  conditionalUi: boolean;
} {
  const config = useAuthConfig();
  const flag = config.data?.passkeys;
  const [platform, setPlatform] = useState<{ supported: boolean; conditional: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (flag !== true) return;
    let cancelled = false;
    const p = passkeyPlatform();
    void Promise.all([p.supported(), p.conditionalUiSupported()])
      .then(([supported, conditional]) => {
        if (!cancelled) setPlatform({ supported, conditional: supported && conditional });
      })
      .catch(() => {
        if (!cancelled) setPlatform({ supported: false, conditional: false });
      });
    return () => {
      cancelled = true;
    };
  }, [flag]);
  if (flag === undefined && config.isPending) return { enabled: undefined, conditionalUi: false };
  if (flag !== true) return { enabled: false, conditionalUi: false };
  if (!platform) return { enabled: undefined, conditionalUi: false };
  return { enabled: platform.supported, conditionalUi: platform.conditional };
}

/** The signed-in user's passkeys; only fetched when `enabled` (the feature is on and supported). */
export function usePasskeys(enabled: boolean) {
  return useQuery({
    queryKey: PASSKEYS_KEY,
    queryFn: listPasskeys,
    enabled,
    staleTime: 30_000,
  });
}

export function useInvalidatePasskeys() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: PASSKEYS_KEY });
}
