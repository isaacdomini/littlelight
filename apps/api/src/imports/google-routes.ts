import {
  GOOGLE_CONNECTED_PATH,
  type GoogleConnectReturnPath,
  type GoogleConnectStatus,
  googleConnectionSchema,
  googleConnectRequestSchema,
  googleConnectResponseSchema,
  scopeIncludesPicker,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  audit,
  requireAuth,
  requireConsent,
  type Throttle,
  withClaims,
  withClaimsOf,
} from "../auth";
import { ApiError, featureUnavailable, rateLimited } from "../lib/errors";
import { isGoogleError } from "./google/client";
import {
  closeBatchSession,
  forgetAccessToken,
  revokeGoogleConnection,
  storeConnection,
} from "./google/connection";
import { createConsumedGoogleStates, mintGoogleState, verifyGoogleState } from "./google/state";
import { loadConnection, myPickingBatches } from "./queries";

// Google Photos connection (docs/plans/step-10.md 2.6, D6, D14, D15, D18): server-side OAuth with
// one "Web application" client; the api owns the redirect URI. The refresh token is encrypted at
// rest (`encrypt_secret`, service_role); access tokens exist in request memory only.
//
// - `POST /me/import/google/connect` mints the `state` (google/state.ts) and returns Google's
//   consent URL, which the client opens (system browser on native).
// - `GET /import/google/callback` needs no session (the native flow lands in SFSafariViewController
//   / Custom Tabs without app credentials): the `state` is the credential, single use (its `jti`
//   is consumed before the code exchange; a replay answers `expired` and changes nothing), and its
//   GoTrue session must still be live. It always answers 302 to the SPA's connected page with a
//   status.
// - Never logged: the code, the state, tokens, the consent URL (the request serializer drops query
//   strings; pino redacts `req.query.code` / `req.query.state`; log lines carry statuses only).

/** Lenient callback query: anything malformed becomes "absent" (a browser lands here, not an app). */
const callbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional().catch(undefined),
  state: z.string().min(1).max(4096).optional().catch(undefined),
  error: z.string().min(1).max(256).optional().catch(undefined),
});

export interface GoogleRoutesOptions {
  connectThrottle: Throttle;
}

export function googleImportRoutes(app: FastifyInstance, opts: GoogleRoutesOptions): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const publicUrl = app.config.PUBLIC_URL.replace(/\/+$/, "");
  const redirectUri = `${publicUrl}/api/import/google/callback`;
  /** Used connect states (`jti`), in memory: the api runs as one instance. */
  const consumedStates = createConsumedGoogleStates();

  function connectedUrl(
    status: GoogleConnectStatus,
    client: "web" | "native" = "web",
    returnTo?: GoogleConnectReturnPath,
  ): string {
    const url = new URL(GOOGLE_CONNECTED_PATH, `${publicUrl}/`);
    url.searchParams.set("status", status);
    url.searchParams.set("client", client);
    if (returnTo) url.searchParams.set("returnTo", returnTo);
    return url.href;
  }

  r.route({
    method: "GET",
    url: "/me/import/google/connection",
    schema: { response: { 200: googleConnectionSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const row = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        return loadConnection(client, ctx.uid);
      });
      return {
        available: app.googleImport !== null,
        connected: row !== null,
        connectedAt: row?.connected_at.toISOString() ?? null,
        needsReconnect: row?.needs_reconnect ?? false,
      };
    },
  });

  r.route({
    method: "POST",
    url: "/me/import/google/connect",
    schema: { body: googleConnectRequestSchema, response: { 200: googleConnectResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const google = app.googleImport;
      if (!google) throw featureUnavailable();
      const auth = request.auth;
      if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
      const hit = opts.connectThrottle.hit(auth.uid);
      if (!hit.allowed) throw rateLimited(hit.retryAfterSec);
      const { client, returnTo } = request.body;
      const sessionId = await withClaims(request, async (tx, ctx) => {
        await requireConsent(tx, ctx);
        return ctx.sessionId;
      });
      const state = await mintGoogleState(app.config, {
        uid: auth.uid,
        sessionId,
        client,
        returnTo,
      });
      request.log.info({ client }, "google connect started");
      return { url: google.authUrl({ state, redirectUri }) };
    },
  });

  r.route({
    method: "GET",
    url: "/import/google/callback",
    schema: { querystring: callbackQuerySchema },
    handler: async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      const done = (
        status: GoogleConnectStatus,
        client?: "web" | "native",
        returnTo?: GoogleConnectReturnPath,
      ) => {
        request.log.info({ status }, "google connect callback");
        return reply.redirect(connectedUrl(status, client, returnTo), 302);
      };

      const { code, state, error } = request.query;
      const verified = await verifyGoogleState(app.config, state);
      if (!verified.ok) return done("expired");
      const { sub: uid, sid, client, returnTo, exp } = verified.claims;

      // Single use, decided before anything else (and synchronously, so of two parallel
      // callbacks with one state only the first proceeds): a leaked consent URL cannot be
      // completed a second time to swap in another Google account.
      if (!consumedStates.consume(verified.claims)) {
        request.log.warn({ status: "expired" }, "google connect state already used");
        return done("expired", client);
      }

      // The GoTrue session that started the flow must still be live (sign-out anywhere, account
      // deletion or an idle timeout ends it). Same check as every authenticated request.
      try {
        await withClaimsOf(
          app,
          { sub: uid, role: "authenticated", session_id: sid, aud: "authenticated", exp },
          async () => undefined,
        );
      } catch {
        return done("expired", client);
      }

      if (error !== undefined) return done(error === "access_denied" ? "denied" : "error", client);
      const google = app.googleImport;
      if (!google || code === undefined) return done("error", client);

      let refreshToken: string | undefined;
      let accessToken: string | undefined;
      let scope: string | undefined;
      try {
        const token = await google.exchangeCode(code, redirectUri);
        refreshToken = token.refresh_token;
        accessToken = token.access_token;
        scope = token.scope;
      } catch (err) {
        request.log.warn(
          { category: isGoogleError(err) ? err.category : "internal" },
          "google code exchange failed",
        );
        return done("error", client);
      }
      if (!refreshToken || !scope || !scopeIncludesPicker(scope)) {
        // Do not keep a grant we cannot use (best effort; revoking any token ends the grant).
        const grant = refreshToken ?? accessToken;
        if (grant) await google.revoke(grant);
        return done("scope_missing", client);
      }
      try {
        await storeConnection(app, uid, refreshToken, scope);
        // A new grant: an access token of the previous one must not be used any more.
        forgetAccessToken(google, uid);
      } catch {
        request.log.warn({ status: "error" }, "google connection could not be stored");
        await google.revoke(refreshToken);
        return done("error", client);
      }
      return done("ok", client, returnTo);
    },
  });

  r.route({
    method: "DELETE",
    url: "/me/import/google/connection",
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
      // Cancel this user's picking batches first (their Google sessions need the token).
      const picking = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const batches = await myPickingBatches(client, ctx.uid);
        const cancelled: { id: string; baby_id: string }[] = [];
        for (const b of batches) {
          const { rowCount } = await client.query(
            `UPDATE public.import_batches SET status = 'cancelled', finished_at = now()
              WHERE id = $1 AND status = 'picking'`,
            [b.id],
          );
          if ((rowCount ?? 0) > 0) {
            cancelled.push(b);
            await audit(client, "import.batch_cancelled", {
              babyId: b.baby_id,
              actorUserId: ctx.uid,
              metadata: { batch_id: b.id },
            });
          }
        }
        return cancelled;
      });
      const google = app.googleImport;
      if (google) {
        for (const b of picking) {
          // best effort (never throws): the session expires at Google on its own
          await closeBatchSession(app, google, auth.uid, b.id);
        }
      }
      // Evicts the cached access token before and after the revoke.
      const { existed, revoked } = await revokeGoogleConnection(app, auth.uid, request.log);
      if (existed) {
        await withClaims(request, (client, ctx) =>
          audit(client, "import.google_disconnected", { actorUserId: ctx.uid }),
        );
      }
      request.log.info({ existed, revoked, cancelled: picking.length }, "google disconnected");
      return reply.code(204).send();
    },
  });
}
