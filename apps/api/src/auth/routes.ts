import {
  AUTH_COOKIE_REFRESH,
  authConfigResponseSchema,
  idTokenRequestSchema,
  OTP_CAPTCHA_AFTER_ATTEMPTS,
  otpRequestSchema,
  otpResponseSchema,
  PRIVACY_VERSION,
  pkceExchangeRequestSchema,
  refreshRequestSchema,
  sessionResponseSchema,
  signOutRequestSchema,
  TERMS_VERSION,
  verifyRequestSchema,
} from "@tinyglow/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError, forbidden, rateLimited, safeErrorLog } from "../lib/errors";
import { clientIp, clientKindHeader, upstreamClientHeaders } from "../lib/request";
import { audit, withClaims } from "./context";
import { isSuspendedEmail } from "./family-guards";
import { GoTrueError, type GoTrueSession, hasReviewLinks } from "./gotrue";
import { csrfRejected, requireAuth } from "./plugin";
import { countOtherFamilies, isReviewEmail, type ReviewAccount, verifyReviewCode } from "./review";
import type { AuthRuntime } from "./runtime";
import { clearSessionCookies, type IssueOptions, issueSession } from "./session";

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

interface SignInOptions {
  /** `review`: the store-review sign-in, recorded in the audit metadata (D4). */
  method?: IssueOptions["method"];
  /** The exchange must yield this user (store-review sign-in: the id `generate_link` returned). */
  expectUserId?: string;
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
    throw mapExchangeError(err, request);
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
  return issueSession(request, reply, session, {
    kind: "sign_in",
    ...(opts.method ? { method: opts.method } : {}),
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

export function authRoutes(app: FastifyInstance, runtime: AuthRuntime): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { config, gotrue, throttles, turnstile, review } = runtime;

  r.route({
    method: "GET",
    url: "/auth/config",
    schema: { response: { 200: authConfigResponseSchema } },
    handler: async () => ({
      providers: { apple: config.AUTH_APPLE_ENABLED, google: config.AUTH_GOOGLE_ENABLED },
      turnstileSiteKey: turnstile ? (config.TURNSTILE_SITE_KEY ?? null) : null,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    }),
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
        const result = await signIn(request, reply, runtime, () =>
          gotrue.verify({ kind: "code", email: body.email, token: body.code }, upstream),
        );
        throttles.verifyPerEmail.reset(body.email);
        return result;
      }
      // Magic link (web fallback): the single-use token_hash from the URL fragment.
      const attempt = throttles.verifyPerIp.hit(clientIp(request));
      if (!attempt.allowed) {
        throw rateLimited(attempt.retryAfterSec, "Too many attempts, request a new code");
      }
      return signIn(request, reply, runtime, () =>
        gotrue.verify({ kind: "token_hash", tokenHash: body.tokenHash }, upstream),
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
      return signIn(request, reply, runtime, () =>
        gotrue.exchangePkce({ authCode: code, codeVerifier }, upstreamClientHeaders(request)),
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
      return signIn(request, reply, runtime, () =>
        gotrue.signInWithIdToken(
          { provider, idToken, nonce, accessToken },
          upstreamClientHeaders(request),
        ),
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
