import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_COOKIE_ACCESS,
  AUTH_COOKIE_REFRESH,
  type AuditMetadata,
  type ClientKind,
  type SessionResponse,
  WEB_SESSION_IDLE_DAYS,
} from "@tinyglow/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiConfig } from "../config";
import { newDeviceEmail } from "../email/templates";
import { ApiError, safeErrorLog } from "../lib/errors";
import {
  clientCountry,
  clientDeviceLabel,
  clientKind,
  upstreamClientHeaders,
} from "../lib/request";
import { audit, type Tx, type TxContext, withClaimsOf } from "./context";
import { GoTrueError, type GoTrueSession } from "./gotrue";
import { verifyAccessToken } from "./jwt";

// Session transport (docs/plans/step-3.md 2.2, 2.3 "On every session-issuing response").
// Web: httpOnly cookies set here, tokens never in a body. Native (`X-Tinyglow-Client:
// native`): tokens in the body, no cookies. Cookie paths are the browser-facing ones (`/api`,
// `/api/auth`): nginx/Vite strip the prefix before the request reaches this process.

export const ACCESS_COOKIE_PATH = "/api";
export const REFRESH_COOKIE_PATH = "/api/auth";
export const REFRESH_COOKIE_MAX_AGE_SEC = WEB_SESSION_IDLE_DAYS * 24 * 60 * 60;

type CookieConfig = Pick<ApiConfig, "NODE_ENV">;

function secure(config: CookieConfig): boolean {
  return config.NODE_ENV === "production";
}

export function accessCookieOptions(config: CookieConfig) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: ACCESS_COOKIE_PATH,
    maxAge: ACCESS_TOKEN_TTL_SEC,
    secure: secure(config),
  };
}

export function refreshCookieOptions(config: CookieConfig) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_COOKIE_MAX_AGE_SEC,
    secure: secure(config),
  };
}

/** Set both session cookies (web). The refresh cookie is re-issued on every refresh (sliding 30 d). */
export function setSessionCookies(
  reply: FastifyReply,
  config: CookieConfig,
  tokens: { accessToken: string; refreshToken: string },
): void {
  reply.setCookie(AUTH_COOKIE_ACCESS, tokens.accessToken, accessCookieOptions(config));
  reply.setCookie(AUTH_COOKIE_REFRESH, tokens.refreshToken, refreshCookieOptions(config));
}

/** Clear both cookies (`Max-Age=0`, same Path/attributes so browsers match them). */
export function clearSessionCookies(reply: FastifyReply, config: CookieConfig): void {
  const { maxAge: _a, ...access } = accessCookieOptions(config);
  const { maxAge: _r, ...refresh } = refreshCookieOptions(config);
  reply.clearCookie(AUTH_COOKIE_ACCESS, access);
  reply.clearCookie(AUTH_COOKIE_REFRESH, refresh);
}

export type IssueKind = "sign_in" | "refresh";

export interface IssueOptions {
  /** `sign_in`: profile upsert, audit `auth.sign_in`, new-device detection. `refresh`: liveness only. */
  kind: IssueKind;
  /** Sign-in method recorded in the audit metadata; only the store-review sign-in sets it (D4). */
  method?: "review";
}

type SessionTxResult = { ctx: TxContext; newDevice: boolean };

/** `auth.sign_in` (+ `auth.new_device` when another live session exists), inside the claims tx. */
async function signInBookkeeping(
  client: Tx,
  ctx: TxContext,
  metadata: AuditMetadata,
): Promise<SessionTxResult> {
  const { rows } = await client.query<{ n: number }>("SELECT public.count_user_sessions() AS n");
  const liveSessions = rows[0]?.n ?? 1;
  await audit(client, "auth.sign_in", { actorUserId: ctx.uid, metadata });
  const newDevice = liveSessions > 1;
  if (newDevice) await audit(client, "auth.new_device", { actorUserId: ctx.uid, metadata });
  return { ctx, newDevice };
}

/**
 * A suspended account (D13) reached a session-issuing route: GoTrue just minted a session
 * for it, so end every session of the account at GoTrue (best effort; `admin:suspend` already
 * deleted the older ones) and drop this browser's cookies. The caller rethrows the 403.
 */
async function endSuspendedSession(
  request: FastifyRequest,
  reply: FastifyReply,
  session: GoTrueSession,
): Promise<void> {
  request.log.info({ outcome: "suspended" }, "session refused");
  if (clientKind(request) === "web") clearSessionCookies(reply, request.server.config);
  try {
    await request.server.authRuntime.gotrue.logout(
      session.accessToken,
      "global",
      upstreamClientHeaders(request),
    );
  } catch (err) {
    if (err instanceof GoTrueError) {
      request.log.warn({ status: err.status, code: err.code }, "suspended session logout failed");
    } else {
      request.log.warn({ err: safeErrorLog(err) }, "suspended session logout failed");
    }
  }
}

/**
 * Turn a GoTrue session into the API's response: verifies the new access token with our own
 * verifier (never trust the upstream body blindly), runs the liveness check under the new
 * claims (401 when the session is gone, 403 `account_suspended` for a suspended account, which
 * also ends the GoTrue session it was just given), and on sign-in creates the `profiles` row if
 * missing (needed before any `audit_log` row: `actor_user_id` references `profiles`), writes
 * `auth.sign_in`, and if another live session already existed writes `auth.new_device` and sends
 * the alert email (best effort). Sign-up is never refused here (step 11, amended: the abuse
 * checks run when an account starts a family, `family-guards.ts`). Then sets cookies (web) or
 * returns tokens (native).
 */
export async function issueSession(
  request: FastifyRequest,
  reply: FastifyReply,
  session: GoTrueSession,
  opts: IssueOptions,
): Promise<SessionResponse> {
  const app = request.server;
  const config = app.config;
  const claims = await verifyAccessToken(session.accessToken, config);
  const kind: ClientKind = clientKind(request);
  const country = clientCountry(request);
  const deviceLabel = clientDeviceLabel(request);
  const metadata: AuditMetadata = {
    client: kind,
    user_agent_label: deviceLabel,
    ...(country ? { ip_country: country } : {}),
    ...(opts.method === "review" ? { method: "review" as const } : {}),
  };

  let result: SessionTxResult;
  try {
    result = await withClaimsOf(app, claims, async (client, ctx) => {
      if (opts.kind !== "sign_in") return { ctx, newDevice: false };
      await client.query(
        "INSERT INTO public.profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
        [ctx.uid],
      );
      return signInBookkeeping(client, ctx, metadata);
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === "account_suspended") {
      await endSuspendedSession(request, reply, session);
    }
    throw err;
  }

  if (result.newDevice && result.ctx.email) {
    const content = newDeviceEmail({
      when: new Date(),
      deviceLabel,
      country,
      devicesUrl: `${config.PUBLIC_URL}/settings/devices`,
    });
    try {
      await app.mailer.send({ to: result.ctx.email, ...content });
    } catch (err) {
      // A failed alert must not fail the sign-in; the mailer logged its own safe category.
      request.log.warn({ err: safeErrorLog(err) }, "new-device alert not sent");
    }
  }

  const body: SessionResponse = {
    user: { id: result.ctx.uid, email: result.ctx.email },
    session: {
      createdAt: result.ctx.sessionCreatedAt.toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      isFresh: result.ctx.isFresh,
    },
  };

  if (kind === "native") {
    return {
      ...body,
      tokens: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
      },
    };
  }
  setSessionCookies(reply, config, session);
  return body;
}
