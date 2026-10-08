import { SignJWT } from "jose";
import type { ApiConfig } from "../config";

// Short-lived `service_role` JWT for GoTrue's admin API (docs/plans/step-3.md 2.3 "Account
// delete", 3.4). GoTrue accepts any HS256 token signed with its secret whose `role` claim is in
// `GOTRUE_JWT_ADMIN_ROLES` (= service_role). Minted per call, 60 s expiry, never persisted or
// logged. It has no `sub`, so it can never pass `authenticatedClaimsSchema` (role literal
// `authenticated`) and therefore can never be mistaken for a user session by our own hook.

export const ADMIN_JWT_TTL_SEC = 60;

export function jwtIssuer(config: Pick<ApiConfig, "PUBLIC_URL">): string {
  return `${config.PUBLIC_URL}/auth`;
}

export function jwtSecretKey(config: Pick<ApiConfig, "JWT_SECRET">): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

export async function mintAdminJwt(
  config: Pick<ApiConfig, "JWT_SECRET" | "PUBLIC_URL">,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ role: "service_role" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(jwtIssuer(config))
    .setAudience("authenticated")
    .setIssuedAt(iat)
    .setExpirationTime(iat + ADMIN_JWT_TTL_SEC)
    .sign(jwtSecretKey(config));
}
