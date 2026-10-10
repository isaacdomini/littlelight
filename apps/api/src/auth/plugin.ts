import { AUTH_COOKIE_ACCESS } from "@tinyglow/shared";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { ApiConfig } from "../config";
import { ApiError } from "../lib/errors";
import { clientKind, clientKindHeader } from "../lib/request";
import type { AuthContext } from "./context";
import { verifyAccessToken } from "./jwt";

// The `onRequest` hook that establishes `request.auth` (docs/plans/step-3.md 2.2, 2.7). Bearer
// header first (native), else the `ll_access` cookie (web). The hook never rejects by itself:
// public routes (`/auth/otp`, `/auth/refresh` with an expired access cookie, `/healthz`) must
// keep working. It records the failure as `request.authError`, and `requireAuth` (or
// `withClaims`) turns it into the response: 401 `token_expired` (SPA refreshes once and
// retries), 401 `unauthorized`, or 403 `csrf_rejected` for a cookie-authenticated non-GET
// request without `X-Tinyglow-Client: web` (custom-header CSRF guard on top of SameSite).

declare module "fastify" {
  interface FastifyRequest {
    /** Verified user session, or null. Set by the auth hook before any handler runs. */
    auth: AuthContext | null;
    /** Why `auth` is null although credentials were presented; null when none were. */
    authError: ApiError | null;
  }
}

export const csrfRejected = () =>
  new ApiError(403, "csrf_rejected", "Missing client header on a cookie-authenticated request");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Credentials as presented: the bearer header wins over the cookie. */
export function extractToken(
  request: Pick<FastifyRequest, "headers" | "cookies">,
): { token: string; transport: "cookie" | "bearer" } | null {
  const header = request.headers.authorization;
  const h = Array.isArray(header) ? header[0] : header;
  if (h) {
    const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
    if (m?.[1]) return { token: m[1], transport: "bearer" };
    return null;
  }
  const cookie = request.cookies?.[AUTH_COOKIE_ACCESS];
  if (cookie) return { token: cookie, transport: "cookie" };
  return null;
}

/** True when a cookie-authenticated request needs (and lacks) the CSRF header. */
export function needsCsrfHeader(
  request: Pick<FastifyRequest, "method" | "headers" | "ip">,
  transport: "cookie" | "bearer",
): boolean {
  if (transport !== "cookie") return false;
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  return clientKindHeader(request) !== "web";
}

export function registerAuthHook(
  app: FastifyInstance,
  config: Pick<ApiConfig, "JWT_SECRET" | "PUBLIC_URL">,
): void {
  app.decorateRequest("auth", null);
  app.decorateRequest("authError", null);

  app.addHook("onRequest", async (request) => {
    request.auth = null;
    request.authError = null;
    const presented = extractToken(request);
    if (!presented) return;
    if (needsCsrfHeader(request, presented.transport)) {
      request.authError = csrfRejected();
      return;
    }
    try {
      const claims = await verifyAccessToken(presented.token, config);
      request.auth = {
        claims,
        uid: claims.sub,
        email: claims.email ?? null,
        token: presented.token,
        transport: presented.transport,
        clientKind: clientKind(request),
        sessionId: claims.session_id,
      };
    } catch (err) {
      request.authError =
        err instanceof ApiError ? err : new ApiError(401, "unauthorized", "Sign in to continue");
    }
  });
}

/** Route guard: 401 `unauthorized` / `token_expired` or 403 `csrf_rejected`. */
export const requireAuth: preHandlerHookHandler = async (request) => {
  if (request.auth) return;
  throw request.authError ?? new ApiError(401, "unauthorized", "Sign in to continue");
};
