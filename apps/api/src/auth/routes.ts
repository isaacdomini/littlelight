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
} from "@littlelight/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError, rateLimited, safeErrorLog } from "../lib/errors";
import { clientIp, clientKindHeader, upstreamClientHeaders } from "../lib/request";
import { audit, withClaims } from "./context";
import { GoTrueError, type GoTrueSession } from "./gotrue";
import { csrfRejected, requireAuth } from "./plugin";
import type { AuthRuntime } from "./runtime";
import { clearSessionCookies, issueSession } from "./session";

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

async function signIn(
  request: FastifyRequest,
  reply: FastifyReply,
  runtime: AuthRuntime,
  exchange: () => Promise<GoTrueSession>,
) {
  let session: GoTrueSession;
  try {
    session = await exchange();
  } catch (err) {
    throw mapExchangeError(err, request);
  }
  await logoutPresentedSession(request, runtime);
  return issueSession(request, reply, session, { kind: "sign_in" });
}

export function authRoutes(app: FastifyInstance, runtime: AuthRuntime): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { config, gotrue, throttles, turnstile } = runtime;

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
      await withClaims(request, (client, ctx) =>
        audit(client, "auth.sign_out", {
          actorUserId: ctx.uid,
          metadata: { scope, client: auth.clientKind },
        }),
      );
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
