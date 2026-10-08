import { type SessionResponse, sessionResponseSchema } from "@littlelight/shared";
import { apiFetch } from "./api";

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
  });
}

export function verifyTokenHash(tokenHash: string): Promise<SessionResponse> {
  return apiFetch("/auth/verify", {
    method: "POST",
    body: { tokenHash, type: "email" },
    schema: sessionResponseSchema,
  });
}

export function exchangePkce(code: string, codeVerifier: string): Promise<SessionResponse> {
  return apiFetch("/auth/pkce", {
    method: "POST",
    body: { code, codeVerifier },
    schema: sessionResponseSchema,
  });
}

export function signOutRequest(scope: "local" | "global"): Promise<void> {
  return apiFetch("/auth/signout", { method: "POST", body: { scope } });
}
