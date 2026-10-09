import {
  claimsToSql,
  VIEWER_COOKIE,
  VIEWER_COOKIE_PATH,
  type ViewerSessionClaims,
} from "@littlelight/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type pg from "pg";
import { accessCookieOptions, csrfRejected, needsCsrfHeader } from "../auth";
import type { ApiConfig } from "../config";
import { ApiError, shareLinkExpired } from "../lib/errors";
import { clientKindHeader } from "../lib/request";
import { runAs } from "../plugins/db";
import { mintViewerJwt, ViewerJwtError, verifyViewerJwt } from "./crypto";

// Viewer authentication for `/share/*` (docs/plans/step-8.md 2.2, 2.6; PRD "Share-link viewers
// (no account)", "Security": share-link access through a separate narrowly scoped role).
//
// - Credential: the `ll_viewer` cookie (`HttpOnly; SameSite=Lax; Path=/api/share`, `Secure` in
//   production) holding a viewer JWT, or `Authorization: Bearer <viewer JWT>` when the request
//   says `X-Littlelight-Client: native` (step-9 seam). Never `ll_access` and never a GoTrue
//   token: those are verified with a different key, issuer and audience and fail here, and a
//   viewer JWT fails the parent hook (`auth/jwt.ts`) the same way. The cookie's path keeps it away
//   from every parent route (`/api/babies/*`, chat, search) in the first place.
// - The hook only verifies the signature and claims (no database); `withViewer` then runs every
//   viewer unit of work as the Postgres `viewer` role with the JWT's claims, and its first
//   statement is `viewer_session_check(jti)`: a revoked/regenerated/expired link, an ended session
//   or a deleted baby is one 410 `share_link_expired`, the cookie is cleared, nothing else runs.
// - Cookie-transport non-GET requests need `X-Littlelight-Client: web` (403 `csrf_rejected`,
//   the step-3 rule). Every `/share/*` response is `Cache-Control: no-store` and `noindex`.
// - Nothing here logs the JWT, the cookie or a claim.

export type ViewerTransport = "cookie" | "bearer";

export interface ViewerAuth {
  claims: ViewerSessionClaims;
  /** The presented JWT (for re-use on the token exchange). Never log it. */
  token: string;
  transport: ViewerTransport;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Verified viewer JWT on `/share/*`, else null. Set by `registerViewerAuth`. */
    viewer: ViewerAuth | null;
    /** Why `viewer` is null although a credential was presented; null when none was. */
    viewerError: ApiError | null;
  }
}

/** 401 for a missing, malformed or expired viewer credential: the SPA re-runs the exchange once. */
export const viewerUnauthorized = () => new ApiError(401, "unauthorized", "Open the link again");

/** Browser-facing prefix handled here (nginx/Vite strip `/api`; the API serves `/share/*`). */
const VIEWER_URL_PREFIX = "/share/";

export function isViewerUrl(url: string): boolean {
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  return path.startsWith(VIEWER_URL_PREFIX);
}

/** The viewer credential as presented: native bearer, else the `ll_viewer` cookie. */
export function extractViewerToken(
  request: Pick<FastifyRequest, "headers" | "cookies" | "ip">,
): { token: string; transport: ViewerTransport } | null {
  if (clientKindHeader(request) === "native") {
    const header = request.headers.authorization;
    const h = Array.isArray(header) ? header[0] : header;
    const m = h ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
    if (m?.[1]) return { token: m[1], transport: "bearer" };
  }
  const cookie = request.cookies?.[VIEWER_COOKIE];
  if (cookie) return { token: cookie, transport: "cookie" };
  return null;
}

type CookieConfig = Pick<ApiConfig, "NODE_ENV">;

/** `ll_viewer` attributes (Max-Age added per JWT). `Secure` follows the parent cookie's rule. */
export function viewerCookieOptions(config: CookieConfig) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: VIEWER_COOKIE_PATH,
    secure: accessCookieOptions(config).secure,
  };
}

/** Set `ll_viewer` to `token`, living until the JWT's `exp` (seconds). */
export function setViewerCookie(
  reply: FastifyReply,
  config: CookieConfig,
  token: string,
  exp: number,
  nowMs: number = Date.now(),
): void {
  const maxAge = Math.max(1, exp - Math.floor(nowMs / 1000));
  reply.setCookie(VIEWER_COOKIE, token, { ...viewerCookieOptions(config), maxAge });
}

export function clearViewerCookie(reply: FastifyReply, config: CookieConfig): void {
  reply.clearCookie(VIEWER_COOKIE, viewerCookieOptions(config));
}

/**
 * Install the `onRequest` hook for `/share/*`: sets `request.viewer` / `request.viewerError`
 * from the viewer credential, plus `Cache-Control: no-store` and `X-Robots-Tag: noindex` on every
 * viewer response. Never rejects by itself (the exchange and the manifest are public);
 * `requireViewer` / `withViewer` turn a missing credential into the response.
 */
export function registerViewerAuth(app: FastifyInstance, config: ApiConfig): void {
  app.decorateRequest("viewer", null);
  app.decorateRequest("viewerError", null);

  app.addHook("onRequest", async (request, reply) => {
    request.viewer = null;
    request.viewerError = null;
    if (!isViewerUrl(request.url)) return;
    reply.header("cache-control", "no-store");
    reply.header("x-robots-tag", "noindex, nofollow");
    const presented = extractViewerToken(request);
    if (!presented) return;
    if (needsCsrfHeader(request, presented.transport)) {
      request.viewerError = csrfRejected();
      return;
    }
    try {
      const claims = await verifyViewerJwt(presented.token, config);
      request.viewer = { claims, token: presented.token, transport: presented.transport };
    } catch (err) {
      if (!(err instanceof ViewerJwtError)) throw err;
      request.viewerError = viewerUnauthorized();
    }
  });
}

/** Route guard for viewer routes: 401 `unauthorized` / 403 `csrf_rejected`. */
export const requireViewer: preHandlerHookHandler = async (request) => {
  if (request.viewer) return;
  throw request.viewerError ?? viewerUnauthorized();
};

/** One row of `viewer_session_check(jti)`: what the viewer's link is, right now. */
export interface ViewerSession {
  shareLinkId: string;
  babyId: string;
  linkName: string;
  babyName: string;
  babyNickname: string | null;
  /** The link's expiry (renew moves it; the cookie is re-minted to follow). */
  expiresAt: Date;
  allowDownload: boolean;
  /** The session id (`jti`). */
  sessionId: string;
}

interface SessionCheckRow {
  share_link_id: string;
  baby_id: string;
  link_name: string;
  baby_name: string;
  baby_nickname: string | null;
  expires_at: Date;
  allow_download: boolean;
}

/** Re-mint the cookie once the link's expiry is this much later than the JWT's `exp` (renew). */
const REMINT_SLACK_SEC = 60;

/**
 * `viewer_session_check(jti)` under the current (viewer) transaction. Null when the session or
 * the link is no longer live.
 */
export async function checkViewerSession(
  client: pg.PoolClient,
  claims: ViewerSessionClaims,
): Promise<ViewerSession | null> {
  const { rows } = await client.query<SessionCheckRow>(
    `SELECT share_link_id, baby_id, link_name, baby_name, baby_nickname, expires_at, allow_download
       FROM public.viewer_session_check($1)`,
    [claims.jti],
  );
  const r = rows[0];
  if (!r || r.share_link_id !== claims.share_link_id) return null;
  return {
    shareLinkId: r.share_link_id,
    babyId: r.baby_id,
    linkName: r.link_name,
    babyName: r.baby_name,
    babyNickname: r.baby_nickname,
    expiresAt: r.expires_at,
    allowDownload: r.allow_download,
    sessionId: claims.jti,
  };
}

/**
 * Run `fn` as the Postgres `viewer` role under `claims` after `viewer_session_check`. Throws 410
 * `share_link_expired` (and clears the cookie) when the check returns nothing.
 */
export async function withViewerClaims<T>(
  app: Pick<FastifyInstance, "db" | "config">,
  reply: FastifyReply,
  claims: ViewerSessionClaims,
  fn: (client: pg.PoolClient, session: ViewerSession) => Promise<T>,
): Promise<{ session: ViewerSession; result: T }> {
  const out = await runAs(app.db, "viewer", { claimsJson: claimsToSql(claims) }, async (client) => {
    const session = await checkViewerSession(client, claims);
    if (!session) return null;
    return { session, result: await fn(client, session) };
  });
  if (!out) {
    clearViewerCookie(reply, app.config);
    throw shareLinkExpired();
  }
  return out;
}

/**
 * `withViewerClaims` for the request's verified viewer (`requireViewer` first; fails closed with
 * 401 if it was skipped). When the link was renewed since the JWT was minted, a fresh cookie
 * with the new `exp` and the same `jti` is set, so open tabs keep working (web transport only;
 * a native client re-runs the exchange).
 */
export async function withViewer<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (client: pg.PoolClient, session: ViewerSession) => Promise<T>,
): Promise<{ session: ViewerSession; result: T }> {
  const viewer = request.viewer;
  if (!viewer) throw request.viewerError ?? viewerUnauthorized();
  const app = request.server;
  const out = await withViewerClaims(app, reply, viewer.claims, fn);
  const linkExp = Math.floor(out.session.expiresAt.getTime() / 1000);
  if (viewer.transport === "cookie" && linkExp > viewer.claims.exp + REMINT_SLACK_SEC) {
    const minted = await mintViewerJwt(app.config, {
      shareLinkId: out.session.shareLinkId,
      sessionId: out.session.sessionId,
      linkExpiresAt: out.session.expiresAt,
    });
    setViewerCookie(reply, app.config, minted.token, minted.exp);
  }
  return out;
}
