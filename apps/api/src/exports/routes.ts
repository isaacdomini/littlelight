import {
  type CreateExportRequest,
  createExportRequestSchema,
  EXPORT_URL_TTL_SEC,
  exportDownloadUrlResponseSchema,
  exportKey,
  exportParamsSchema,
  exportResponseSchema,
  exportsListResponseSchema,
  idParamsSchema,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  audit,
  requireAuth,
  requireConsent,
  requireFreshSignIn,
  type Tx,
  type TxContext,
  withClaims,
  withServiceRole,
} from "../auth";
import {
  ApiError,
  babyTrashed,
  exportExpired,
  forbidden,
  isPgError,
  notFound,
  notRequester,
} from "../lib/errors";
import { babyAccess } from "../photos/queries";
import {
  babyName,
  expireExport,
  exportFileName,
  insertExport,
  listExports,
  loadExport,
  recordDownload,
  toDataExport,
} from "./queries";

// `/babies/:id/exports*` (docs/plans/review-fixes.md 2.5, D1–D5; PRD FR-10.1 "Export all
// originals + a JSON/CSV of metadata as a ZIP", "Roles and permissions": export data is Admin
// only).
//
// - Every statement runs under the caller's claims (`withClaims`); `data_exports` RLS is the
//   authorization (admins of the baby see, request and expire; `requested_by = auth_uid()` on
//   insert). The role read first only picks the message (404 stranger, 403 contributor), so a
//   contributor never sees `fresh_sign_in_required` for something they can't do anyway.
// - Requesting and minting a download URL need a fresh sign-in (≤ 10 min, D2); only the
//   requester can download (D3), through a 10-minute presigned GET of `exportKey()` (the
//   `storage_key` column is not readable by `authenticated`), as an attachment.
// - Audit: `export.requested {export_id, include_location}`, `export.downloaded {export_id}`,
//   `export.expired {export_id}`. Never the key, a URL, a size or a name.
// - The job (`data.export {exportId, babyId}`) is sent after commit, outside `runAs`. A failed
//   send marks the row `failed/internal` (service_role: `authenticated` cannot write `status`)
//   and answers 503, so the in-progress guard does not block a retry.
// - Logs carry ids and outcomes only; the signed URL is returned once and never logged.

const babyNotFound = () => notFound("That album doesn't exist or you don't have access to it");
const exportNotFound = () => notFound("That export doesn't exist or you don't have access to it");
const adminOnly = () => forbidden("Only an admin of this album can export its data");
const enqueueFailed = () =>
  new ApiError(503, "internal", "We couldn't start the export, try again shortly");

/** Consent, then 404 for strangers and 403 for contributors. Returns whether the baby is trashed. */
async function requireExportAdmin(
  client: Tx,
  ctx: TxContext,
  babyId: string,
): Promise<{ trashed: boolean }> {
  await requireConsent(client, ctx);
  const access = await babyAccess(client, ctx.uid, babyId);
  if (!access) throw babyNotFound();
  if (access.role !== "admin") throw adminOnly();
  return { trashed: access.deletedAt !== null };
}

export function exportsRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "POST",
    url: "/babies/:id/exports",
    schema: {
      params: idParamsSchema,
      body: createExportRequestSchema,
      response: { 202: exportResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId } = request.params;
      const body: CreateExportRequest = request.body;
      const row = await withClaims(request, async (client, ctx) => {
        const { trashed } = await requireExportAdmin(client, ctx, babyId);
        if (trashed) throw babyTrashed();
        requireFreshSignIn(ctx);
        let exportId: string | undefined;
        try {
          exportId = await insertExport(client, babyId, ctx.uid, body.includeLocation);
        } catch (err) {
          // RLS WITH CHECK (no longer an admin: a race with a demotion) ⇒ 403; trigger messages
          // (in progress, rate limit, trashed) are mapped by the global handler.
          if (isPgError(err) && err.code === "42501") throw adminOnly();
          throw err;
        }
        if (!exportId) throw adminOnly();
        await audit(client, "export.requested", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { export_id: exportId, include_location: body.includeLocation },
        });
        const created = await loadExport(client, babyId, ctx.uid, exportId);
        if (!created) throw adminOnly();
        return created;
      });

      const accepted = await app.jobs.enqueueDataExport({ exportId: row.id, babyId });
      if (!accepted) {
        await withServiceRole(app, "mark an export failed after its job could not be sent", (c) =>
          c.query(
            `UPDATE public.data_exports
                SET status = 'failed', error = 'internal', finished_at = now()
              WHERE id = $1 AND status = 'queued'`,
            [row.id],
          ),
        );
        request.log.warn({ exportId: row.id }, "export marked failed: job not enqueued");
        throw enqueueFailed();
      }
      request.log.info(
        { exportId: row.id, babyId, includeLocation: row.include_location },
        "export requested",
      );
      return reply.code(202).send({ export: toDataExport(row) });
    },
  });

  r.route({
    method: "GET",
    url: "/babies/:id/exports",
    schema: { params: idParamsSchema, response: { 200: exportsListResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const rows = await withClaims(request, async (client, ctx) => {
        await requireExportAdmin(client, ctx, babyId);
        return listExports(client, babyId, ctx.uid);
      });
      return { exports: rows.map(toDataExport) };
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/exports/:exportId/download-url",
    schema: {
      params: exportParamsSchema,
      response: { 200: exportDownloadUrlResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId, exportId } = request.params;
      const signed = await withClaims(request, async (client, ctx) => {
        await requireExportAdmin(client, ctx, babyId);
        const row = await loadExport(client, babyId, ctx.uid, exportId);
        if (!row) throw exportNotFound();
        if (!row.is_mine) throw notRequester();
        if (!row.can_download) {
          throw exportExpired(row.status === "queued" || row.status === "running");
        }
        requireFreshSignIn(ctx);
        if (!(await recordDownload(client, babyId, ctx.uid, exportId))) throw exportExpired();
        await audit(client, "export.downloaded", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { export_id: exportId },
        });
        // Signing is local (no request to storage); doing it inside the transaction means a
        // signer failure rolls the counter and the audit row back.
        return app.signer.signGet(exportKey(babyId, exportId), {
          ttlSec: EXPORT_URL_TTL_SEC,
          contentType: "application/zip",
          contentDisposition: `attachment; filename="${exportFileName(
            await babyName(client, babyId),
            row.created_at,
          )}"`,
          cacheControl: "private, no-store",
        });
      });
      request.log.info({ exportId, babyId }, "export download url issued");
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  });

  r.route({
    method: "DELETE",
    url: "/babies/:id/exports/:exportId",
    schema: { params: exportParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId, exportId } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireExportAdmin(client, ctx, babyId);
        if (await expireExport(client, babyId, exportId)) {
          await audit(client, "export.expired", {
            babyId,
            actorUserId: ctx.uid,
            metadata: { export_id: exportId },
          });
          return;
        }
        // Nothing shortened: already expired (idempotent 204, no second audit row) or unknown.
        if (!(await loadExport(client, babyId, ctx.uid, exportId))) throw exportNotFound();
      });
      request.log.info({ exportId, babyId }, "export expired early");
      return reply.code(204).send();
    },
  });
}
