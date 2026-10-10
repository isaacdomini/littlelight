import {
  IMPORT_PICKER_POLL_MIN_SEC,
  IMPORT_PICKING_TTL_MIN,
  idParamsSchema,
  importBatchCreateRequestSchema,
  importBatchCreateResponseSchema,
  importBatchesListQuerySchema,
  importBatchesListResponseSchema,
  importBatchParamsSchema,
  importBatchResponseSchema,
  type PickerSession,
  parseGoogleDuration,
} from "@littlelight/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit, requireAuth, requireConsent, type Throttle, withClaims } from "../auth";
import {
  ApiError,
  featureUnavailable,
  googleNotConnected,
  googleReconnect,
  importInProgress,
  rateLimited,
} from "../lib/errors";
import { batchNotFound, notBatchRequester, requireMember, rethrowGoogle } from "./common";
import { type GoogleClient, isGoogleError } from "./google/client";
import { mintAccessToken } from "./google/connection";
import {
  claimPoll,
  finishPicking,
  hasVisibleActiveBatch,
  insertBatch,
  listBatches,
  loadBatch,
  loadConnection,
  requestCancel,
  toImportBatch,
} from "./queries";

// Google Photos Picker batches (`import_batches`; docs/plans/step-10.md 2.2, 2.6, D1, D11, D19).
// Admins and contributors may import (D1); the worker books a contributor's photos `pending`.
//
// - Create: an access token minted from the stored refresh token (request memory only), a Picker
//   session at Google, then under the caller's claims the `picking` row with the session id and
//   the clamped poll interval ([IMPORT_PICKER_POLL_MIN_SEC, 60]) and picker expiry (≤ 30 min).
//   The response carries `pickerUri` once; it is never stored or logged.
// - Get: the requester's client polls; while `picking`, the api asks Google at most once per
//   poll interval (`claimPoll`); `mediaItemsSet` ⇒ `queued`, then (after commit) `import.google`.
//   A failed enqueue leaves the batch `queued` for `import.sweep` to re-send.
// - Cancel: `picking` ⇒ `cancelled` and the Google session deleted (best effort);
//   `queued`/`running` ⇒ `cancel_requested_at` for the worker.
// - The Google session id is read under service_role (never granted to `authenticated`), bound to
//   the requester (google/connection.ts). Logs: batch/baby ids, statuses, Google categories.

const PICKING_TTL_MS = IMPORT_PICKING_TTL_MIN * 60_000;
const POLL_MAX_SEC = 60;
const DEFAULT_POLL_SEC = 5;

/** Google's poll interval, clamped to [IMPORT_PICKER_POLL_MIN_SEC, 60] whole seconds. */
export function clampPollInterval(pollInterval: string | undefined): number {
  let sec = DEFAULT_POLL_SEC;
  if (pollInterval !== undefined) {
    try {
      sec = parseGoogleDuration(pollInterval);
    } catch {
      sec = DEFAULT_POLL_SEC;
    }
  }
  return Math.min(POLL_MAX_SEC, Math.max(IMPORT_PICKER_POLL_MIN_SEC, Math.ceil(sec)));
}

/** `min(Google's expireTime, now + IMPORT_PICKING_TTL_MIN)`. */
export function pickerExpiry(session: Pick<PickerSession, "expireTime">, now = new Date()): Date {
  const cap = now.getTime() + PICKING_TTL_MS;
  const google = session.expireTime ? Date.parse(session.expireTime) : Number.NaN;
  return new Date(Number.isFinite(google) ? Math.min(google, cap) : cap);
}

export interface BatchRoutesOptions {
  createThrottle: Throttle;
}

export function importBatchRoutes(app: FastifyInstance, opts: BatchRoutesOptions): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Delete a batch's Google session, best effort (never throws). */
  async function dropGoogleSession(
    google: GoogleClient,
    uid: string,
    batchId: string,
    log: Pick<FastifyBaseLogger, "info">,
  ): Promise<void> {
    try {
      const grant = await mintAccessToken(app, google, uid, batchId);
      const deleted = grant.sessionId
        ? await google.deleteSession(grant.accessToken, grant.sessionId)
        : false;
      log.info({ batchId, deleted }, "picker session closed");
    } catch {
      log.info({ batchId, deleted: false }, "picker session closed");
    }
  }

  r.route({
    method: "POST",
    url: "/babies/:id/imports/google",
    schema: {
      params: idParamsSchema,
      body: importBatchCreateRequestSchema,
      response: { 201: importBatchCreateResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const google = app.googleImport;
      if (!google) throw featureUnavailable();
      const auth = request.auth;
      if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
      const { id: babyId } = request.params;

      // Checks the caller can see before spending a Google call (the triggers decide anyway).
      await withClaims(request, async (client, ctx) => {
        await requireMember(client, ctx, babyId, { live: true });
        const conn = await loadConnection(client, ctx.uid);
        if (!conn) throw googleNotConnected();
        if (conn.needs_reconnect) throw googleReconnect();
        if (await hasVisibleActiveBatch(client, babyId)) throw importInProgress();
      });
      const hit = opts.createThrottle.hit(auth.uid);
      if (!hit.allowed) throw rateLimited(hit.retryAfterSec);

      let accessToken: string;
      let session: PickerSession;
      try {
        ({ accessToken } = await mintAccessToken(app, google, auth.uid));
        session = await google.createSession(accessToken);
      } catch (err) {
        rethrowGoogle(err, request.log, "picker session create");
      }

      let batch: ReturnType<typeof toImportBatch>;
      try {
        batch = await withClaims(request, async (client, ctx) => {
          const batchId = await insertBatch(client, {
            babyId,
            sessionId: session.id,
            pollIntervalSec: clampPollInterval(session.pollingConfig?.pollInterval),
            pickerExpiresAt: pickerExpiry(session),
          });
          await audit(client, "import.batch_created", {
            babyId,
            actorUserId: ctx.uid,
            metadata: { batch_id: batchId, kind: "google_picker" },
          });
          const row = await loadBatch(client, ctx.uid, batchId);
          if (!row) throw batchNotFound();
          return toImportBatch(row);
        });
      } catch (err) {
        // In progress / rate limit / trashed / no longer a member: do not leave a session open.
        await google.deleteSession(accessToken, session.id);
        throw err;
      }
      request.log.info({ batchId: batch.id, babyId }, "google import started");
      return reply.code(201).send({ batch, pickerUri: session.pickerUri });
    },
  });

  r.route({
    method: "GET",
    url: "/imports/:batchId",
    logLevel: "warn",
    schema: { params: importBatchParamsSchema, response: { 200: importBatchResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { batchId } = request.params;
      const auth = request.auth;
      if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
      const google = app.googleImport;

      const step = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const row = await loadBatch(client, ctx.uid, batchId);
        if (!row) throw batchNotFound();
        // Only the requester's polls drive the batch (the token is theirs).
        if (row.stored_status !== "picking" || !row.is_mine)
          return { row, action: "none" as const };
        if (row.status === "expired") {
          await finishPicking(client, batchId, "expired");
          return { row, action: "expired" as const };
        }
        if (!google || !row.poll_due) return { row, action: "none" as const };
        return {
          row,
          action: (await claimPoll(client, batchId)) ? ("poll" as const) : ("none" as const),
        };
      });

      let changed = step.action === "expired";
      if (step.action === "expired" && google) {
        request.log.info({ batchId, status: "expired" }, "google import picker expired");
        void dropGoogleSession(google, auth.uid, batchId, request.log);
      }
      if (step.action === "poll" && google) {
        try {
          const grant = await mintAccessToken(app, google, auth.uid, batchId);
          if (grant.sessionId) {
            const session = await google.getSession(grant.accessToken, grant.sessionId);
            if (session.mediaItemsSet) {
              const queued = await withClaims(request, (client) =>
                finishPicking(client, batchId, "queued"),
              );
              if (queued) {
                changed = true;
                const accepted = await app.jobs.enqueueImportGoogle({
                  batchId,
                  babyId: step.row.baby_id,
                });
                request.log.info(
                  { batchId, babyId: step.row.baby_id, enqueued: accepted },
                  "google import queued",
                );
              }
            }
          }
        } catch (err) {
          if (err instanceof ApiError && err.code === "google_reconnect") throw err;
          if (isGoogleError(err) && err.category === "not_found") {
            // The session is gone at Google (deleted or timed out): the pick cannot finish.
            changed = await withClaims(request, (client) =>
              finishPicking(client, batchId, "expired"),
            );
            request.log.info({ batchId, status: "expired" }, "google import session gone");
          } else if (isGoogleError(err)) {
            // Transient: answer with the stored state; the next poll asks again.
            request.log.warn({ batchId, category: err.category }, "google picker poll failed");
          } else {
            throw err;
          }
        }
      }

      if (!changed) return { batch: toImportBatch(step.row) };
      const row = await withClaims(request, (client, ctx) => loadBatch(client, ctx.uid, batchId));
      if (!row) throw batchNotFound();
      return { batch: toImportBatch(row) };
    },
  });

  r.route({
    method: "POST",
    url: "/imports/:batchId/cancel",
    schema: { params: importBatchParamsSchema, response: { 200: importBatchResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { batchId } = request.params;
      const auth = request.auth;
      if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
      const result = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const row = await loadBatch(client, ctx.uid, batchId);
        if (!row) throw batchNotFound();
        if (!row.is_mine) throw notBatchRequester();
        let cancelled = false;
        let dropSession = false;
        if (row.stored_status === "picking") {
          cancelled = await finishPicking(client, batchId, "cancelled");
          dropSession = cancelled;
        } else if (row.stored_status === "queued" || row.stored_status === "running") {
          cancelled = await requestCancel(client, batchId);
        }
        if (cancelled) {
          await audit(client, "import.batch_cancelled", {
            babyId: row.baby_id,
            actorUserId: ctx.uid,
            metadata: { batch_id: batchId },
          });
        }
        const after = await loadBatch(client, ctx.uid, batchId);
        if (!after) throw batchNotFound();
        return { batch: toImportBatch(after), cancelled, dropSession };
      });
      const google = app.googleImport;
      if (result.dropSession && google) {
        await dropGoogleSession(google, auth.uid, batchId, request.log);
      }
      if (result.cancelled) {
        request.log.info(
          { batchId, babyId: result.batch.babyId, status: result.batch.status },
          "google import cancelled",
        );
      }
      return { batch: result.batch };
    },
  });

  r.route({
    method: "GET",
    url: "/babies/:id/imports",
    schema: {
      params: idParamsSchema,
      querystring: importBatchesListQuerySchema,
      response: { 200: importBatchesListResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const { limit } = request.query;
      return withClaims(request, async (client, ctx) => {
        await requireMember(client, ctx, babyId);
        const rows = await listBatches(client, ctx.uid, babyId, limit);
        return { batches: rows.map(toImportBatch) };
      });
    },
  });
}
