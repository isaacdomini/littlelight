import {
  SHARE_EXCHANGES_PER_IP_PER_HOUR,
  SHARE_PASSCODE_FAILURES_PER_IP,
  SHARE_PASSCODE_FAILURES_PER_LINK,
  type ShareSessionResponse,
  shareSessionRequestSchema,
  shareSessionResponseSchema,
} from "@littlelight/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import * as auth from "../auth";
import {
  type ApiError,
  isPgError,
  passcodeInvalid,
  passcodeLocked,
  passcodeRequired,
  rateLimited,
  shareLinkExpired,
} from "../lib/errors";
import { clientIp, clientKindHeader, clientUserAgent } from "../lib/request";
import {
  hashClientIp,
  hashShareToken,
  hashUserAgent,
  mintViewerJwt,
  verifyPasscode,
} from "./crypto";
import { loadViewerAlbum, strictViewerBody, type Tx } from "./queries";
import { clearViewerCookie, setViewerCookie, withViewerClaims } from "./viewer-auth";

// The share-token exchange (docs/plans/step-8.md 2.6; PRD "Share-link viewers (no account)",
// "Security": passcode attempts 5 / 15 min per IP + token; D8, D12).
//
// `POST /share/session {token, passcode?}` is the only place a share token is accepted (in the
// body, never a path segment a proxy could log) and, with viewer sign-out, the only service_role
// transaction of the sharing module: users cannot read `share_links.token_hash` /
// `passcode_hash`, so the lookup by `sha256(token)` and the passcode ledger need it. Everything
// the viewer reads afterwards (the album in this response included) runs as the `viewer` role.
//
// - Every dead or unknown link is the same 410 `share_link_expired` (unknown, revoked, expired,
//   regenerated away, trashed baby).
// - Passcode: both limits are checked before verifying (a locked caller learns nothing): >= 20
//   failures on the link in 60 min ⇒ 429 `passcode_locked`; >= 5 for (link, IP) in 15 min ⇒ 429
//   `rate_limited`; both with `Retry-After`. No passcode sent ⇒ 401 `passcode_required` (not a
//   failure). Wrong ⇒ a failure row is committed, 401 `passcode_invalid {attemptsLeft}`. Windows
//   count only failures after the last regenerate. IPs are stored and compared as keyed hashes.
// - A browser that already holds a live viewer session for this link reuses it (no passcode
//   prompt on reload, no new session, no extra visit). One viewer session per browser (D12): a
//   session of another link is ended when this one starts.
// - Web: `ll_viewer` httpOnly cookie, nothing secret in the body. Native: the viewer JWT in the
//   body (`viewerToken`), no cookie.
// - Logs: link id and outcome only; never the token, its hash, the passcode, the IP or its hash.

const HOUR_MS = 60 * 60 * 1000;
/** `viewer_sessions_guard`'s message (packages/db/migrations/1792100000100_sharing-v1.sql). */
const LINK_NOT_ACTIVE = "share link is not active";

interface LinkRow {
  id: string;
  baby_id: string;
  passcode_hash: string | null;
  expires_at: Date;
}

interface LockStateRow {
  ip_failures: number;
  ip_retry_at: Date | null;
  link_failures: number;
  link_retry_at: Date | null;
}

type ExchangeOutcome =
  | { kind: "session"; linkId: string; sessionId: string; expiresAt: Date; reused: boolean }
  | { kind: "error"; error: ApiError };

function secondsUntil(at: Date | null, fallbackSec: number): number {
  if (!at) return fallbackSec;
  return Math.max(1, Math.ceil((at.getTime() - Date.now()) / 1000));
}

/** Look up a live link by token hash (service_role); null for every dead or unknown link. */
async function liveLinkByToken(client: Tx, tokenHash: Buffer): Promise<LinkRow | null> {
  const { rows } = await client.query<LinkRow>(
    `SELECT l.id, l.baby_id, l.passcode_hash, l.expires_at
       FROM public.share_links l
       JOIN public.babies b ON b.id = l.baby_id
      WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now()
        AND b.deleted_at IS NULL`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export function viewerSessionRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const exchangesPerIp = auth.createThrottle({
    limit: SHARE_EXCHANGES_PER_IP_PER_HOUR,
    windowMs: HOUR_MS,
  });
  app.addHook("onClose", async () => {
    exchangesPerIp.close();
  });

  r.route({
    method: "POST",
    url: "/share/session",
    schema: { body: shareSessionRequestSchema },
    handler: async (request, reply) => {
      const kind = clientKindHeader(request);
      if (!kind) throw auth.csrfRejected();
      const ip = clientIp(request);
      const throttled = exchangesPerIp.hit(`share-exchange:${ip}`);
      if (!throttled.allowed) throw rateLimited(throttled.retryAfterSec);

      const { token, passcode } = request.body;
      const tokenHash = hashShareToken(token);
      const ipHash = hashClientIp(app.config, ip);
      const uaHash = hashUserAgent(app.config, clientUserAgent(request));
      // A live session this browser already holds (verified JWT; liveness checked below).
      const held = request.viewer?.claims ?? null;

      let outcome: ExchangeOutcome;
      try {
        outcome = await auth.withServiceRole(app, "share token exchange", async (client) =>
          exchange(client, { tokenHash, passcode, ipHash, uaHash, held }),
        );
      } catch (err) {
        // `viewer_sessions_guard`: the link died between the lookup and the session insert.
        if (isPgError(err) && err.code === "23514" && err.message.startsWith(LINK_NOT_ACTIVE)) {
          throw shareLinkExpired();
        }
        throw err;
      }
      if (outcome.kind === "error") {
        request.log.info({ outcome: outcome.error.code }, "share exchange refused");
        throw outcome.error;
      }
      request.log.info(
        { shareLinkId: outcome.linkId, sessionId: outcome.sessionId, reused: outcome.reused },
        "share session opened",
      );
      return sendSession(request, reply, kind, outcome);
    },
  });

  r.route({
    method: "DELETE",
    url: "/share/session",
    handler: async (request, reply) => {
      if (request.viewerError?.code === "csrf_rejected") throw request.viewerError;
      clearViewerCookie(reply, app.config);
      const viewer = request.viewer;
      if (viewer) {
        const { claims } = viewer;
        await auth.withServiceRole(app, "viewer sign-out", async (client) => {
          await client.query(
            `UPDATE public.viewer_sessions SET revoked_at = now()
              WHERE id = $1 AND share_link_id = $2 AND revoked_at IS NULL`,
            [claims.jti, claims.share_link_id],
          );
        });
        request.log.info({ sessionId: claims.jti }, "viewer signed out");
      }
      return reply.code(204).send();
    },
  });
}

interface ExchangeInput {
  tokenHash: Buffer;
  passcode: string | undefined;
  ipHash: Buffer;
  uaHash: Buffer;
  held: { share_link_id: string; jti: string } | null;
}

/**
 * The exchange inside one service_role transaction. Returns (never throws) the refusals that must
 * still commit (a recorded passcode failure); throws only for "nothing to commit" cases.
 */
async function exchange(client: Tx, input: ExchangeInput): Promise<ExchangeOutcome> {
  const link = await liveLinkByToken(client, input.tokenHash);
  if (!link) return { kind: "error", error: shareLinkExpired() };

  if (input.held?.share_link_id === link.id) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM public.viewer_sessions
        WHERE id = $1 AND share_link_id = $2 AND revoked_at IS NULL`,
      [input.held.jti, link.id],
    );
    if (rows[0]) {
      return {
        kind: "session",
        linkId: link.id,
        sessionId: rows[0].id,
        expiresAt: link.expires_at,
        reused: true,
      };
    }
  }

  if (link.passcode_hash !== null) {
    // Serialises attempts on this link for the rest of the transaction (advisory lock).
    const { rows } = await client.query<LockStateRow>(
      `SELECT ip_failures, ip_retry_at, link_failures, link_retry_at
         FROM public.share_passcode_lock_state($1, $2)`,
      [link.id, input.ipHash],
    );
    const state = rows[0] ?? {
      ip_failures: 0,
      ip_retry_at: null,
      link_failures: 0,
      link_retry_at: null,
    };
    if (state.link_failures >= SHARE_PASSCODE_FAILURES_PER_LINK) {
      return { kind: "error", error: passcodeLocked(secondsUntil(state.link_retry_at, 3600)) };
    }
    if (state.ip_failures >= SHARE_PASSCODE_FAILURES_PER_IP) {
      return {
        kind: "error",
        error: rateLimited(
          secondsUntil(state.ip_retry_at, 900),
          "Too many wrong passcodes. Try again later.",
        ),
      };
    }
    if (input.passcode === undefined) return { kind: "error", error: passcodeRequired() };
    if (!(await verifyPasscode(input.passcode, link.passcode_hash))) {
      await client.query(
        "INSERT INTO public.share_passcode_failures (share_link_id, ip_hash) VALUES ($1, $2)",
        [link.id, input.ipHash],
      );
      await client.query(
        `DELETE FROM public.share_passcode_failures
          WHERE share_link_id = $1 AND created_at < now() - interval '24 hours'`,
        [link.id],
      );
      if (state.link_failures + 1 === SHARE_PASSCODE_FAILURES_PER_LINK) {
        await auth.audit(client, "share_link.passcode_locked", {
          babyId: link.baby_id,
          actorUserId: null,
          shareLinkId: link.id,
        });
      }
      return {
        kind: "error",
        error: passcodeInvalid(SHARE_PASSCODE_FAILURES_PER_IP - (state.ip_failures + 1)),
      };
    }
  }

  // One viewer session per browser (D12): end the session of another link this browser held.
  if (input.held && input.held.share_link_id !== link.id) {
    await client.query(
      `UPDATE public.viewer_sessions SET revoked_at = now()
        WHERE id = $1 AND share_link_id = $2 AND revoked_at IS NULL`,
      [input.held.jti, input.held.share_link_id],
    );
  }
  // `viewer_sessions_guard` refuses a session on a link that died since the lookup (410 below)
  // and clamps the expiry to the link's.
  const { rows: created } = await client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO public.viewer_sessions (share_link_id, expires_at, ip_hash, user_agent_hash, last_seen_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING id, expires_at`,
    [link.id, link.expires_at, input.ipHash, input.uaHash],
  );
  const session = created[0];
  if (!session) return { kind: "error", error: shareLinkExpired() };
  await client.query(
    "UPDATE public.share_links SET view_count = view_count + 1, last_viewed_at = now() WHERE id = $1",
    [link.id],
  );
  return {
    kind: "session",
    linkId: link.id,
    sessionId: session.id,
    expiresAt: link.expires_at,
    reused: false,
  };
}

/** Mint the viewer JWT, read the album as `viewer`, set the cookie (web) or return the JWT (native). */
async function sendSession(
  request: FastifyRequest,
  reply: FastifyReply,
  kind: "web" | "native",
  outcome: Extract<ExchangeOutcome, { kind: "session" }>,
): Promise<ShareSessionResponse> {
  const app = request.server;
  const minted = await mintViewerJwt(app.config, {
    shareLinkId: outcome.linkId,
    sessionId: outcome.sessionId,
    linkExpiresAt: outcome.expiresAt,
  });
  const claims = {
    role: "viewer" as const,
    share_link_id: outcome.linkId,
    jti: outcome.sessionId,
    exp: minted.exp,
    iat: Math.floor(Date.now() / 1000),
  };
  const { result: album } = await withViewerClaims(app, reply, claims, (client, session) =>
    loadViewerAlbum(client, session),
  );
  const body = strictViewerBody(
    shareSessionResponseSchema,
    kind === "native" ? { album, viewerToken: minted.token } : { album },
    request.log,
  );
  if (kind === "web") setViewerCookie(reply, app.config, minted.token, minted.exp);
  return body;
}
