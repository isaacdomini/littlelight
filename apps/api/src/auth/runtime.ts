import type { AbuseEnv } from "@tinyglow/shared";
import {
  INVITE_LOOKUPS_PER_IP_PER_HOUR,
  OTP_MAX_ATTEMPTS,
  OTP_PER_EMAIL_PER_HOUR,
  OTP_PER_IP_PER_HOUR,
  OTP_TTL_MIN,
  PASSKEY_OPTIONS_PER_IP_PER_HOUR,
  PASSKEY_VERIFY_FAILURES_PER_IP_PER_15_MIN,
  PASSKEY_VERIFY_PER_IP_PER_HOUR,
} from "@tinyglow/shared";
import type { FastifyBaseLogger } from "fastify";
import { type ApiConfig, abuseSettings } from "../config";
import type { Mailer } from "../email/mailer";
import { createDomainBlocklist, type DomainBlocklist } from "./disposable";
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
  /** `POST /auth/passkey/options` (step 13): 60 per hour per client IP. */
  passkeyOptionsPerIp: Throttle;
  /** `POST /auth/passkey/verify`: 60 attempts per hour per IP, success or failure (GoTrue has no limiter there). */
  passkeyVerifyPerIp: Throttle;
  /** `POST /auth/passkey/verify` failures: 10 per 15 minutes per IP; also drives the Turnstile threshold on `options`. */
  passkeyVerifyFailuresPerIp: Throttle;
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
  /** Family-start safeguard settings with defaults filled (step 11: `abuseSettings`). */
  abuse: AbuseEnv;
  /** Disposable-domain check for family starts (step 11, `disposable/index.ts`). */
  blocklist: DomainBlocklist;
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
    passkeyOptionsPerIp: createThrottle({
      limit: PASSKEY_OPTIONS_PER_IP_PER_HOUR,
      windowMs: HOUR_MS,
    }),
    passkeyVerifyPerIp: createThrottle({
      limit: PASSKEY_VERIFY_PER_IP_PER_HOUR,
      windowMs: HOUR_MS,
    }),
    passkeyVerifyFailuresPerIp: createThrottle({
      limit: PASSKEY_VERIFY_FAILURES_PER_IP_PER_15_MIN,
      windowMs: 15 * 60_000,
    }),
  };
}

/** Logged once at boot in production when Turnstile is off (docs/plans/step-11.md 2.9, D12). */
export const TURNSTILE_OFF_WARNING =
  "turnstile is off: set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (recommended in production)";

export function createAuthRuntime(deps: {
  config: ApiConfig;
  gotrue: GoTrueClient;
  mailer: Mailer;
  /** Tests inject the review account; default: from `config` only (`loadReviewAccount`). */
  review?: ReviewAccount | null;
  /** Boot-time warnings (the Turnstile recommendation); `app.log` in `registerAuth`. */
  log?: Pick<FastifyBaseLogger, "warn">;
}): AuthRuntime {
  // Before the throttles: a bad review config fails boot without leaving timers behind.
  const review = deps.review !== undefined ? deps.review : loadReviewAccount(deps.config);
  const abuse = abuseSettings(deps.config);
  const blocklist = createDomainBlocklist(abuse);
  const turnstile = createTurnstile(deps.config.TURNSTILE_SECRET_KEY);
  // The site key alone does nothing (the secret verifies); either missing means no captcha.
  if (deps.config.NODE_ENV === "production" && (!turnstile || !deps.config.TURNSTILE_SITE_KEY)) {
    deps.log?.warn(TURNSTILE_OFF_WARNING);
  }
  const throttles = createAuthThrottles();
  return {
    config: deps.config,
    gotrue: deps.gotrue,
    mailer: deps.mailer,
    turnstile,
    throttles,
    review,
    abuse,
    blocklist,
    close() {
      for (const t of Object.values(throttles)) t.close();
    },
  };
}
