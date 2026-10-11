import type { FastifyInstance } from "fastify";
import type { ApiConfig } from "../config";
import type { Mailer } from "../email/mailer";
import { accountRoutes } from "./account";
import type { GoTrueClient } from "./gotrue";
import { inviteRoutes } from "./invites";
import { memberRoutes } from "./members";
import { registerAuthHook } from "./plugin";
import type { ReviewAccount } from "./review";
import { authRoutes } from "./routes";
import { createAuthRuntime } from "./runtime";
import { sessionRoutes } from "./sessions";

// Public surface of `apps/api/src/auth` (docs/plans/step-3.md 2.7). Other modules import from
// here: `withClaims` / `withServiceRole` / `requireAuth` / `requireConsent` /
// `requireFreshSignIn` / `audit` for route handlers (3.5, 3.6), `createGoTrueClient` for
// `buildApp`, and the types.

export { mintAdminJwt } from "./admin-jwt";
export {
  type AuditInput,
  type AuthContext,
  audit,
  isFreshSignIn,
  requireConsent,
  requireFreshSignIn,
  type ServiceRoleOptions,
  sessionRevoked,
  type Tx,
  type TxContext,
  withClaims,
  withClaimsOf,
  withServiceRole,
} from "./context";
export {
  createGoTrueClient,
  type GeneratedMagicLink,
  type GoTrueClient,
  GoTrueError,
  type GoTrueReviewLinks,
  type GoTrueSession,
  type GoTrueUser,
  hasReviewLinks,
  type IdTokenInput,
  type LogoutScope,
  type PkceInput,
  type UpstreamHeaders,
  type VerifyInput,
} from "./gotrue";
export { hashInviteToken, inviteAcceptUrl, newInviteToken, toInvite } from "./invites";
export { verifyAccessToken } from "./jwt";
export { removalRequestLive, toMember } from "./members";
export { csrfRejected, extractToken, needsCsrfHeader, requireAuth } from "./plugin";
export {
  countOtherFamilies,
  isReviewEmail,
  loadReviewAccount,
  type ReviewAccount,
  verifyReviewCode,
} from "./review";
export { type AuthRuntime, type AuthThrottles, createAuthThrottles } from "./runtime";
export {
  accessCookieOptions,
  clearSessionCookies,
  issueSession,
  refreshCookieOptions,
  setSessionCookies,
} from "./session";
export { createThrottle, type Throttle, type ThrottleResult } from "./throttle";
export { createTurnstile, type Turnstile } from "./turnstile";

export interface RegisterAuthDeps {
  gotrue: GoTrueClient;
  mailer: Mailer;
  config: ApiConfig;
  /** Store-review account override (tests); default from the config / environment. */
  review?: ReviewAccount | null;
}

/**
 * Install the auth hook (`request.auth`), the shared runtime (`app.authRuntime`: GoTrue
 * client, mailer, Turnstile, throttles) and the `/auth/*` routes. Call before any route module
 * so the hook covers them all. Throttle timers are stopped on `app.close()`.
 */
export function registerAuth(app: FastifyInstance, deps: RegisterAuthDeps): void {
  registerAuthHook(app, deps.config);
  const runtime = createAuthRuntime({ ...deps, log: app.log });
  app.decorate("authRuntime", runtime);
  app.addHook("onClose", async () => {
    runtime.close();
  });
  authRoutes(app, runtime);
  sessionRoutes(app, runtime);
  // Task 3.5: invites, members, account deletion (all under the same hook and runtime).
  inviteRoutes(app, runtime);
  memberRoutes(app, runtime);
  accountRoutes(app, runtime);
}
