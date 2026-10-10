import { type AuthenticatedClaims, authenticatedClaimsSchema } from "@tinyglow/shared";
import { errors as joseErrors, jwtVerify } from "jose";
import type { ApiConfig } from "../config";
import { ApiError } from "../lib/errors";
import { jwtIssuer, jwtSecretKey } from "./admin-jwt";

// GoTrue access-token verification (docs/plans/step-3.md 2.7). HS256 only, `JWT_SECRET`,
// issuer `${PUBLIC_URL}/auth`, audience `authenticated`; then the payload must satisfy
// `authenticatedClaimsSchema` (role literal `authenticated`, uuid `sub`, uuid `session_id`).
// Expired tokens are reported separately (401 `token_expired`) so the SPA refreshes once and
// retries; every other failure is 401 `unauthorized`. Nothing about the token is ever logged.

/** Allowed clock skew between GoTrue and the API, seconds. */
export const JWT_CLOCK_TOLERANCE_SEC = 5;

export type JwtConfig = Pick<ApiConfig, "JWT_SECRET" | "PUBLIC_URL">;

export const tokenExpired = () => new ApiError(401, "token_expired", "Your session expired");
export const unauthorized = () => new ApiError(401, "unauthorized", "Sign in to continue");

/** Verify a user access token. Throws `ApiError` 401 (`token_expired` or `unauthorized`). */
export async function verifyAccessToken(
  token: string,
  config: JwtConfig,
  now?: Date,
): Promise<AuthenticatedClaims> {
  let payload: unknown;
  try {
    const result = await jwtVerify(token, jwtSecretKey(config), {
      algorithms: ["HS256"],
      issuer: jwtIssuer(config),
      audience: "authenticated",
      clockTolerance: JWT_CLOCK_TOLERANCE_SEC,
      ...(now ? { currentDate: now } : {}),
    });
    payload = result.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw tokenExpired();
    throw unauthorized();
  }
  const parsed = authenticatedClaimsSchema.safeParse(payload);
  if (!parsed.success) throw unauthorized();
  return parsed.data;
}
