import {
  AUTH_COOKIE_REFRESH,
  authConfigResponseSchema,
  idTokenRequestSchema,
  OTP_CAPTCHA_AFTER_ATTEMPTS,
  otpRequestSchema,
  otpResponseSchema,
  PASSKEY_CAPTCHA_AFTER_FAILURES,
  PRIVACY_VERSION,
  passkeyOptionsFromGoTrue,
  passkeyOptionsRequestSchema,
  passkeyOptionsResponseSchema,
  passkeyVerifyRequestSchema,
  pkceExchangeRequestSchema,
  refreshRequestSchema,
  sessionResponseSchema,
  signOutRequestSchema,
  TERMS_VERSION,
  verifyRequestSchema,
} from "@tinyglow/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { passkeysEnabled } from "../config";
import { ApiError, forbidden, rateLimited, safeErrorLog } from "../lib/errors";
import { clientIp, clientKindHeader, upstreamClientHeaders } from "../lib/request";
import { audit, withClaims } from "./context";
import { isSuspendedEmail } from "./family-guards";
import { GoTrueError, type GoTrueSession, hasPasskeys, hasReviewLinks } from "./gotrue";
import { csrfRejected, requireAuth } from "./plugin";
import { countOtherFamilies, isReviewEmail, type ReviewAccount, verifyReviewCode } from "./review";
import type { AuthRuntime } from "./runtime";
import { clearSessionCookies, type IssueOptions, issueSession } from "./session";
import {
  assertionHasUserVerification,
  mapPasskeyError,
  passkeyDisabled,
  passkeyFailed,
  passkeyUpstreamUnavailable,
} from "./webauthn";

// `/auth/*` routes of the API (docs/plans/step-3.md 2.3, 2.4, 2.9). Registered without the
// `/api` prefix (nginx/Vite strip it). Bodies are validated by the shared zod schemas; the
// logger redacts `req.body.{email,code,tokenHash,refreshToken,idToken,captchaToken,…}`.
//
// Generic responses: `POST /auth/otp` is always 202, whatever GoTrue says, so nobody can learn
// whether an email has an account. Rate limits (2.9) are keyed on the normalised email and the
// client IP and answer 429 with `Retry-After`.

const INVALID_CODE_MESSAGE = "That code is wrong or has expired";

function upstreamUnavailable(): ApiError {
  return new ApiError(503, "internal", "Sign-in is temporarily unavailable, try again shortly");
}

/** Map a GoTrue failure on a credential exchange: 4xx = bad credential, else upstream down. */
function mapExchangeError(err: unknown, request: FastifyRequest): ApiError {
  if (err instanceof GoTrueError) {
    if (err.isClientError) return new ApiError(400, "invalid_code", INVALID_CODE_MESSAGE);
    request.log.warn({ status: err.status, code: err.code }, "gotrue unavailable");
    return upstreamUnavailable();
  }
  request.log.error({ err: safeErrorLog(err) }, "gotrue call failed");
  return upstreamUnavailable();
}

/**
 * A re-verification (fresh sign-in) or a sign-in from a device that still holds a session:
 * sign the old session out at GoTrue so it does not linger, and so new-device detection does
 * not count it. Best effort: the cookies/bearer are replaced regardless.
 */
async function logoutPresentedSession(
  request: FastifyRequest,
  runtime: AuthRuntime,
): Promise<void> {
  const old = request.auth;
  if (!old) return;
  try {
    await runtime.gotrue.logout(old.token, "local", upstreamClientHeaders(request));
  } catch (err) {
    if (err instanceof GoTrueError) {
      request.log.debug({ status: err.status, code: err.code }, "old session logout skipped");
    } else {
      request.log.warn({ err: safeErrorLog(err) }, "old session logout failed");
    }
  }
}

/** The OAuth provider GoTrue reports for a session, as a `SignInMethod`; undefined when unknown. */
function oauthMethodOf(session: GoTrueSession): IssueOptions["method"] {
  const p = session.user.provider;
  return p === "apple" || p === "google" ? p : undefined;
}

interface SignInOptions {
  /**
   * Recorded as `method` in the `auth.sign_in` audit metadata: a fixed value (`otp`, `review`,
   * `passkey`, a native id-token provider) or, for the PKCE exchange, a function of the session
   * GoTrue returned (`oauthMethodOf`; undefined when the provider cannot be told).
   */
  method?: IssueOptions["method"] | ((session: GoTrueSession) => IssueOptions["method"]);
  /** The exchange must yield this user (store-review sign-in: the id `generate_link` returned). */
  expectUserId?: string;
  /** How an exchange failure becomes the response; default `mapExchangeError` (OTP/OAuth). */
  mapError?: (err: unknown) => ApiError;
}

async function signIn(
  request: FastifyRequest,
  reply: FastifyReply,
  runtime: AuthRuntime,
  exchange: () => Promise<GoTrueSession>,
  opts: SignInOptions = {},
) {
  let session: GoTrueSession;
  try {
    session = await exchange();
  } catch (err) {
    throw opts.mapError ? opts.mapError(err) : mapExchangeError(err, request);
  }
  if (opts.expectUserId !== undefined && session.user.id.toLowerCase() !== opts.expectUserId) {
    // Cannot happen with a well-behaved GoTrue; never hand out a session for another user.
    request.log.error("sign-in exchange returned an unexpected user");
    try {
      await runtime.gotrue.logout(session.accessToken, "local", upstreamClientHeaders(request));
    } catch {
      // Best effort; the session is not returned either way.
    }
    throw upstreamUnavailable();
  }
  await logoutPresentedSession(request, runtime);
  const method = typeof opts.method === "function" ? opts.method(session) : opts.method;
  return issueSession(request, reply, session, {
    kind: "sign_in",
    ...(method ? { method } : {}),
  });
}

/**
 * Store-review sign-in (docs/plans/step-9.md 2.5, D4; see review.ts). The caller has already
 * counted the attempt against the per-email verify throttle. Wrong code ⇒ the same 400
 * `invalid_code` as a wrong emailed code. Right code ⇒ GoTrue admin `generate_link` (no email;
 * yields the user id and a single-use hashed token) ⇒ guard (no family but the review baby, else
 * 403 before any session exists; the unredeemed token never leaves the API) ⇒ `verify` of the
 * hashed token ⇒ a normal session, audited `auth.sign_in {method:"review"}`.
 * Logs: outcome and user id only; never the code, the hash, the token or the email.
 */
async function reviewSignIn(
  request: FastifyRequest,
  reply: FastifyReply,
  runtime: AuthRuntime,
  review: ReviewAccount,
  code: string,
) {
  if (!(await verifyReviewCode(review, code))) {
    request.log.info({ outcome: "invalid_code" }, "review sign-in refused");
    throw new ApiError(400, "invalid_code", INVALID_CODE_MESSAGE);
  }
  const { gotrue } = runtime;
  if (!hasReviewLinks(gotrue)) throw upstreamUnavailable();
  let link: { userId: string; hashedToken: string };
  try {
    link = await gotrue.adminGenerateMagicLink(review.email);
  } catch (err) {
    // Any failure here is ours or GoTrue's (admin JWT, upstream down), never the caller's code.
    if (err instanceof GoTrueError) {
      request.log.warn(
        { status: err.status, code: err.code },
        "review sign-in: generate_link failed",
      );
    } else {
      request.log.error({ err: safeErrorLog(err) }, "review sign-in: generate_link failed");
    }
    throw upstreamUnavailable();
  }
  const otherFamilies = await countOtherFamilies(request.server, link.userId);
  if (otherFamilies > 0) {
    request.log.warn(
      { userId: link.userId, otherFamilies, outcome: "other_family" },
      "review sign-in refused: the account belongs to a family other than its review family",
    );
    throw forbidden("This account can't use the review sign-in");
  }
  const result = await signIn(
    request,
    reply,
    runtime,
    () =>
      gotrue.verify(
        { kind: "token_hash", tokenHash: link.hashedToken },
        upstreamClientHeaders(request),
      ),
    { method: "review", expectUserId: link.userId },
  );
  request.log.info({ userId: link.userId, outcome: "signed_in" }, "review sign-in");
  return result;
}

// `POST /auth/passkey/options` body: the shared `passkeyOptionsRequestSchema` (the Turnstile
// token, required only after `PASSKEY_CAPTCHA_AFTER_FAILURES` failed verifies from the IP, 403
// `captcha_required` like OTP); an absent body parses as `{}`. An empty-string token is treated
// as absent below.

/** Fastify hands an absent JSON body to the validator as `null`; normalise before validation. */
async function emptyBodyAsObject(request: FastifyRequest): Promise<void> {
  if (request.body === null || request.body === undefined) request.body = {};
}

/** Window-length `Retry-After` for a limit read with `count()` (the throttle exposes no oldest hit). */
function windowRetryAfterSec(windowMs: number): number {
  return Math.max(1, Math.ceil(windowMs / 1000));
}

export function authRoutes(app: FastifyInstance, runtime: AuthRuntime): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { config, gotrue, throttles, turnstile, review } = runtime;
  const passkeys = passkeysEnabled(config);

  /** Runs before body validation so a disabled feature is 404 whatever the body (step 13, 2.4). */
  const requirePasskeysEnabled = async (): Promise<void> => {
    if (!passkeys) throw passkeyDisabled();
  };

  r.route({
    method: "GET",
    url: "/auth/config",
    schema: { response: { 200: authConfigResponseSchema } },
    handler: async () => ({
      providers: { apple: config.AUTH_APPLE_ENABLED, google: config.AUTH_GOOGLE_ENABLED },
      turnstileSiteKey: turnstile ? (config.TURNSTILE_SITE_KEY ?? null) : null,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
      passkeys,
    }),
  });

  // Passkey sign-in (docs/plans/step-13.md 2.1, 2.4; decisions c, d, g). Both routes are public:
  // GoTrue's discoverable-credential ceremony needs no email. Logs carry `{ outcome }` and GoTrue
  // status/code only: never the challenge id, the credential, or any WebAuthn material (the
  // logger also redacts those body fields).
  r.route({
    method: "POST",
    url: "/auth/passkey/options",
    schema: {
      body: passkeyOptionsRequestSchema,
      response: { 200: passkeyOptionsResponseSchema },
    },
    preValidation: [requirePasskeysEnabled, emptyBodyAsObject],
    handler: async (request) => {
      if (!hasPasskeys(gotrue)) throw passkeyUpstreamUnavailable();
      const ip = clientIp(request);
      // Turnstile once this IP has failed `PASSKEY_CAPTCHA_AFTER_FAILURES` verifies in 15 min;
      // inert without the secret (same shape as the OTP threshold).
      if (
        turnstile &&
        throttles.passkeyVerifyFailuresPerIp.count(ip) >= PASSKEY_CAPTCHA_AFTER_FAILURES
      ) {
        const token = request.body.captchaToken;
        if (!token) throw new ApiError(403, "captcha_required", "Please complete the verification");
        if (!(await turnstile.verify(token, ip))) {
          throw new ApiError(403, "captcha_failed", "Verification failed, try again");
        }
      }
      const byIp = throttles.passkeyOptionsPerIp.hit(ip);
      if (!byIp.allowed) {
        request.log.info({ outcome: "rate_limited" }, "passkey options refused");
        throw rateLimited(byIp.retryAfterSec, "Too many attempts, try again later");
      }
      let options: Awaited<ReturnType<typeof gotrue.passkeyAuthOptions>>;
      try {
        // Decision d: the client headers go upstream so GoTrue's own 30 / 5 min limiter keys on
        // the browser IP, not on the api container.
        options = await gotrue.passkeyAuthOptions(upstreamClientHeaders(request));
      } catch (err) {
        throw mapPasskeyError(err, request.log, "sign_in");
      }
      request.log.info({ outcome: "issued" }, "passkey options");
      return passkeyOptionsFromGoTrue(options);
    },
  });

  r.route({
    method: "POST",
    url: "/auth/passkey/verify",
    schema: { body: passkeyVerifyRequestSchema, response: { 200: sessionResponseSchema } },
    preValidation: requirePasskeysEnabled,
    handler: async (request, reply) => {
      if (!hasPasskeys(gotrue)) throw passkeyUpstreamUnavailable();
      const ip = clientIp(request);
      // Decision c: GoTrue has no limiter on this route, so the API caps total attempts per IP
      // per hour and failures per IP per 15 minutes. Both answer 429.
      const total = throttles.passkeyVerifyPerIp.hit(ip);
      if (!total.allowed) {
        request.log.info({ outcome: "rate_limited" }, "passkey verify refused");
        throw rateLimited(total.retryAfterSec, "Too many attempts, try again later");
      }
      const failures = throttles.passkeyVerifyFailuresPerIp;
      if (failures.count(ip) >= failures.limit) {
        request.log.info({ outcome: "rate_limited" }, "passkey verify refused");
        throw rateLimited(
          windowRetryAfterSec(failures.windowMs),
          "Too many failed attempts, use your email code or try again later",
        );
      }
      const { challengeId, credential } = request.body;
      // Decision g: user verification is required by the API, not left to GoTrue's `preferred`.
      // Checked BEFORE any upstream call; the refusal is the same generic `passkey_failed`.
      if (!assertionHasUserVerification(credential)) {
        failures.hit(ip);
        request.log.info({ outcome: "no_user_verification" }, "passkey verify refused");
        throw passkeyFailed();
      }
      const result = await signIn(
        request,
        reply,
        runtime,
        () => gotrue.passkeyAuthVerify({ challengeId, credential }, upstreamClientHeaders(request)),
        {
          method: "passkey",
          mapError: (err) => {
            const mapped = mapPasskeyError(err, request.log, "sign_in");
            // Only a genuine refusal (401 `passkey_failed`) counts towards the failure throttle
            // and the Turnstile threshold; GoTrue 5xx/transport (503), `passkey_disabled` (404)
            // and anything else are not the caller's doing and must not lock an IP out.
            if (mapped.status === 401 && mapped.code === "passkey_failed") failures.hit(ip);
            request.log.info({ outcome: mapped.code }, "passkey verify refused");
            return mapped;
          },
        },
      );
      // GoTrue's own audit row (`login { passkey_id }`) names the passkey; the API's
      // `auth.sign_in` records `method: "passkey"` (the response carries no passkey id).
      request.log.info({ outcome: "signed_in" }, "passkey sign-in");
      return result;
    },
  });

  r.route({
    method: "POST",
    url: "/auth/otp",
    schema: { body: otpRequestSchema, response: { 202: otpResponseSchema } },
    handler: async (request, reply) => {
      const { email, captchaToken } = request.body;
      const ip = clientIp(request);

      // Turnstile after 3 code requests from one IP in the hour; inert without the secret.
      if (turnstile && throttles.otpPerIp.count(ip) >= OTP_CAPTCHA_AFTER_ATTEMPTS) {
        if (!captchaToken) {
          throw new ApiError(403, "captcha_required", "Please complete the verification");
        }
        if (!(await turnstile.verify(captchaToken, ip))) {
          throw new ApiError(403, "captcha_failed", "Verification failed, try again");
        }
      }

      const byEmail = throttles.otpPerEmail.hit(email);
      if (!byEmail.allowed) {
        throw rateLimited(byEmail.retryAfterSec, "Too many codes requested, try again later");
      }
      const byIp = throttles.otpPerIp.hit(ip);
      if (!byIp.allowed) {
        throw rateLimited(byIp.retryAfterSec, "Too many codes requested, try again later");
      }

      // Store-review account (D4): its code is static, so no email goes out (same 202).
      if (isReviewEmail(review, email)) {
        request.log.debug("otp request for the review account: nothing sent");
        return reply.code(202).send({ ok: true });
      }
      // Step 11 (amended): any address may sign in (the abuse checks run when an account starts
      // a family, family-guards.ts). Only a suspended account is special: the same 202, and
      // nothing is sent. Fails open on a database error: suspension is enforced again at verify
      // time (the liveness check, fail closed), and a database blip must not stop sign-in codes
      // for everyone.
      let suspended = false;
      try {
        suspended = await isSuspendedEmail(request.server, email);
      } catch (err) {
        request.log.warn({ err: safeErrorLog(err) }, "otp pre-check failed; sending");
      }
      if (suspended) {
        request.log.info({ outcome: "suspended" }, "otp request: nothing sent");
        return reply.code(202).send({ ok: true });
      }
      try {
        await gotrue.sendOtp(email, upstreamClientHeaders(request));
      } catch (err) {
        // Generic response regardless: log the category only.
        if (err instanceof GoTrueError) {
          request.log.warn({ status: err.status, code: err.code }, "otp request not accepted");
        } else {
          request.log.warn({ err: safeErrorLog(err) }, "otp request failed");
        }
      }
      return reply.code(202).send({ ok: true });
    },
  });

  r.route({
    method: "POST",
    url: "/auth/verify",
    schema: { body: verifyRequestSchema, response: { 200: sessionResponseSchema } },
    handler: async (request, reply) => {
      const body = request.body;
      const upstream = upstreamClientHeaders(request);
      if ("code" in body) {
        const attempt = throttles.verifyPerEmail.hit(body.email);
        if (!attempt.allowed) {
          throw rateLimited(attempt.retryAfterSec, "Too many attempts, request a new code");
        }
        if (review && isReviewEmail(review, body.email)) {
          // Only the static code is accepted for this email (an emailed code never exists).
          const result = await reviewSignIn(request, reply, runtime, review, body.code);
          throttles.verifyPerEmail.reset(body.email);
          return result;
        }
        const result = await signIn(
          request,
          reply,
          runtime,
          () => gotrue.verify({ kind: "code", email: body.email, token: body.code }, upstream),
          { method: "otp" },
        );
        throttles.verifyPerEmail.reset(body.email);
        return result;
      }
      // Magic link (web fallback): the single-use token_hash from the URL fragment. Same
      // `method` as the code: both are the email sign-in (`SIGN_IN_METHODS` has no `magiclink`).
      const attempt = throttles.verifyPerIp.hit(clientIp(request));
      if (!attempt.allowed) {
        throw rateLimited(attempt.retryAfterSec, "Too many attempts, request a new code");
      }
      return signIn(
        request,
        reply,
        runtime,
        () => gotrue.verify({ kind: "token_hash", tokenHash: body.tokenHash }, upstream),
        { method: "otp" },
      );
    },
  });

  r.route({
    method: "POST",
    url: "/auth/pkce",
    schema: { body: pkceExchangeRequestSchema, response: { 200: sessionResponseSchema } },
    handler: async (request, reply) => {
      if (!config.AUTH_APPLE_ENABLED && !config.AUTH_GOOGLE_ENABLED) {
        throw new ApiError(400, "provider_disabled", "Social sign-in is not available");
      }
      const { code, codeVerifier } = request.body;
      // The PKCE body names no provider; GoTrue's session user does (`GoTrueUser.provider`).
      return signIn(
        request,
        reply,
        runtime,
        () => gotrue.exchangePkce({ authCode: code, codeVerifier }, upstreamClientHeaders(request)),
        { method: oauthMethodOf },
      );
    },
  });

  r.route({
    method: "POST",
    url: "/auth/id-token",
    schema: { body: idTokenRequestSchema, response: { 200: sessionResponseSchema } },
    handler: async (request, reply) => {
      const { provider, idToken, nonce, accessToken } = request.body;
      const enabled = provider === "apple" ? config.AUTH_APPLE_ENABLED : config.AUTH_GOOGLE_ENABLED;
      if (!enabled) {
        throw new ApiError(400, "provider_disabled", "That sign-in method is not available");
      }
      return signIn(
        request,
        reply,
        runtime,
        () =>
          gotrue.signInWithIdToken(
            { provider, idToken, nonce, accessToken },
            upstreamClientHeaders(request),
          ),
        { method: provider },
      );
    },
  });

  r.route({
    method: "POST",
    url: "/auth/refresh",
    schema: { body: refreshRequestSchema, response: { 200: sessionResponseSchema } },
    // Web clients POST with no body. Fastify hands an absent body to the validator as `null`,
    // which zod's `.default({})` does not cover, so normalise it first.
    preValidation: async (request) => {
      if (request.body === null || request.body === undefined) request.body = {};
    },
    handler: async (request, reply) => {
      // Native: token in the body. Web: the ll_refresh cookie, which (like any cookie-borne
      // credential on a non-GET request) needs the client header.
      let refreshToken = request.body.refreshToken;
      if (!refreshToken) {
        const cookie = request.cookies[AUTH_COOKIE_REFRESH];
        if (cookie && clientKindHeader(request) !== "web") throw csrfRejected();
        refreshToken = cookie;
      }
      if (!refreshToken) {
        clearSessionCookies(reply, config);
        throw new ApiError(401, "unauthorized", "Sign in to continue");
      }
      let session: GoTrueSession;
      try {
        session = await gotrue.refresh(refreshToken, upstreamClientHeaders(request));
      } catch (err) {
        if (err instanceof GoTrueError && err.isClientError) {
          // Verified on supabase/auth v2.197.0 (refresh-token algorithm v1, the default): the
          // immediately previous token stays redeemable (GoTrue returns the current one) so a
          // client that lost the rotated token recovers; a token two or more generations old,
          // presented more than REUSE_INTERVAL (10 s) after it was rotated, revokes the family
          // (`refresh_token_already_used`) and lands here, as do the inactivity/timebox limits.
          // The access token keeps working until its hour ends; only `auth.sessions` deletion
          // (sign-out, per-device sign-out, account deletion) is immediate via `withClaims`.
          clearSessionCookies(reply, config);
          throw new ApiError(401, "unauthorized", "Sign in to continue");
        }
        throw mapExchangeError(err, request);
      }
      return issueSession(request, reply, session, { kind: "refresh" });
    },
  });

  r.route({
    method: "POST",
    url: "/auth/signout",
    schema: { body: signOutRequestSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
      const { scope } = request.body;
      // Whatever happens next, this browser's session ends.
      if (auth.transport === "cookie") clearSessionCookies(reply, config);
      // Audit first: once GoTrue drops the session, no transaction can run under its claims.
      // Same transaction: this session's push devices go too (docs/plans/step-9.md 2.5, 2.8), so
      // a phone that missed its best-effort `DELETE /me/push-devices/current` keeps no token
      // row. (Other sessions ended by `global` stop receiving pushes anyway: `push_targets`
      // requires a live `auth.sessions` row.)
      await withClaims(request, async (client, ctx) => {
        await client.query("SELECT public.unregister_push_devices_for_session()");
        await audit(client, "auth.sign_out", {
          actorUserId: ctx.uid,
          metadata: { scope, client: auth.clientKind },
        });
      });
      try {
        await gotrue.logout(auth.token, scope, upstreamClientHeaders(request));
      } catch (err) {
        if (err instanceof GoTrueError) {
          request.log.warn({ status: err.status, code: err.code }, "gotrue logout failed");
        } else {
          request.log.warn({ err: safeErrorLog(err) }, "gotrue logout failed");
        }
        throw upstreamUnavailable();
      }
      return reply.code(204).send();
    },
  });
}
