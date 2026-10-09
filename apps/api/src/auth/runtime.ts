import {
  INVITE_LOOKUPS_PER_IP_PER_HOUR,
  OTP_MAX_ATTEMPTS,
  OTP_PER_EMAIL_PER_HOUR,
  OTP_PER_IP_PER_HOUR,
  OTP_TTL_MIN,
} from "@littlelight/shared";
import type { ApiConfig } from "../config";
import type { Mailer } from "../email/mailer";
import type { GoTrueClient } from "./gotrue";
import { loadReviewAccount, type ReviewAccount } from "./review";
import { createThrottle, type Throttle } from "./throttle";
import { createTurnstile, type Turnstile } from "./turnstile";

// Everything the auth routes (and, in 3.5, invites/members/account) share at runtime. Attached
// to the Fastify instance as `app.authRuntime` so later modules reach GoTrue and the throttles
// without re-creating them.

export interface AuthThrottles {
  /** `POST /auth/otp`: 5 per hour per normalised email. */
  otpPerEmail: Throttle;
  /** `POST /auth/otp`: 30 per hour per client IP; also drives the Turnstile threshold. */
  otpPerIp: Throttle;
  /** `POST /auth/verify` with a code: 5 attempts per email per 10 minutes. */
  verifyPerEmail: Throttle;
  /** `POST /auth/verify` with a token_hash: 5 attempts per IP per 10 minutes (links are single-use). */
  verifyPerIp: Throttle;
  /** `GET /invites/:token` (3.5): 60 per hour per IP. */
  inviteLookupPerIp: Throttle;
}

export interface AuthRuntime {
  config: ApiConfig;
  gotrue: GoTrueClient;
  mailer: Mailer;
  /** `null` without `TURNSTILE_SECRET_KEY` (dev, CI): the captcha threshold is inert. */
  turnstile: Turnstile | null;
  throttles: AuthThrottles;
  /**
   * Store-review sign-in (docs/plans/step-9.md 2.5, D4): `null` unless both
   * `REVIEW_ACCOUNT_EMAIL` and `REVIEW_ACCOUNT_CODE_HASH` are set. Holds a hash: never log it.
   */
  review: ReviewAccount | null;
  close(): void;
}

declare module "fastify" {
  interface FastifyInstance {
    authRuntime: AuthRuntime;
  }
}

const HOUR_MS = 60 * 60 * 1000;

export function createAuthThrottles(): AuthThrottles {
  return {
    otpPerEmail: createThrottle({ limit: OTP_PER_EMAIL_PER_HOUR, windowMs: HOUR_MS }),
    otpPerIp: createThrottle({ limit: OTP_PER_IP_PER_HOUR, windowMs: HOUR_MS }),
    verifyPerEmail: createThrottle({ limit: OTP_MAX_ATTEMPTS, windowMs: OTP_TTL_MIN * 60_000 }),
    verifyPerIp: createThrottle({ limit: OTP_MAX_ATTEMPTS, windowMs: OTP_TTL_MIN * 60_000 }),
    inviteLookupPerIp: createThrottle({ limit: INVITE_LOOKUPS_PER_IP_PER_HOUR, windowMs: HOUR_MS }),
  };
}

export function createAuthRuntime(deps: {
  config: ApiConfig;
  gotrue: GoTrueClient;
  mailer: Mailer;
  /** Tests inject the review account; default: from `config` only (`loadReviewAccount`). */
  review?: ReviewAccount | null;
}): AuthRuntime {
  // Before the throttles: a bad review config fails boot without leaving timers behind.
  const review = deps.review !== undefined ? deps.review : loadReviewAccount(deps.config);
  const throttles = createAuthThrottles();
  return {
    config: deps.config,
    gotrue: deps.gotrue,
    mailer: deps.mailer,
    turnstile: createTurnstile(deps.config.TURNSTILE_SECRET_KEY),
    throttles,
    review,
    close() {
      for (const t of Object.values(throttles)) t.close();
    },
  };
}
