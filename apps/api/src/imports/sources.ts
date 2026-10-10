import {
  idParamsSchema,
  importSourceResponseSchema,
  importSourcesListQuerySchema,
  importSourcesListResponseSchema,
  patchImportSourceRequestSchema,
  upsertImportSourceRequestSchema,
} from "@littlelight/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit, requireAuth, requireConsent, withClaims } from "../auth";
import { importSourceExists, isPgError } from "../lib/errors";
import { appleSyncAdminsOnly, requireMember, sourceNotFound } from "./common";
import { deleteSource, listSources, patchSource, toImportSource, upsertSource } from "./queries";

// Apple Photos album sync status rows (`import_sources`; docs/plans/step-10.md 2.2, 2.6, D1–D3).
// The device does the syncing (PhotoKit + the existing upload pipeline); the server keeps per-
// device counters only. Every statement runs under the caller's claims: RLS makes creation
// admin-only (D1), updates owner-only and deletion owner-or-admin. Logs carry ids and counts
// only, never the album title or the device label (parent text). Audit:
// `import.source_created {source_id, kind}`, `import.source_deleted {source_id}`.

export function importSourcesRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/me/import-sources",
    schema: {
      querystring: importSourcesListQuerySchema,
      response: { 200: importSourcesListResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { babyId, deviceId } = request.query;
      return withClaims(request, async (client, ctx) => {
        await requireMember(client, ctx, babyId);
        const rows = await listSources(client, babyId);
        return { sources: rows.map((row) => toImportSource(row, ctx.uid, deviceId)) };
      });
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/import-sources",
    schema: {
      params: idParamsSchema,
      body: upsertImportSourceRequestSchema,
      response: { 200: importSourceResponseSchema, 201: importSourceResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId } = request.params;
      const body = request.body;
      const result = await withClaims(request, async (client, ctx) => {
        const access = await requireMember(client, ctx, babyId, { live: true });
        // The INSERT policy is the authority (D1); this only picks the message first.
        if (access.role !== "admin") throw appleSyncAdminsOnly();
        let upserted: Awaited<ReturnType<typeof upsertSource>>;
        try {
          upserted = await upsertSource(client, babyId, body);
        } catch (err) {
          // RLS WITH CHECK (demoted between the check and the insert) ⇒ 403. Trigger messages
          // (limit, trashed, shape) are mapped by the global handler.
          if (isPgError(err) && err.code === "42501") throw appleSyncAdminsOnly();
          throw err;
        }
        if (!upserted) throw importSourceExists();
        if (upserted.inserted) {
          await audit(client, "import.source_created", {
            babyId,
            actorUserId: ctx.uid,
            metadata: { source_id: upserted.row.id, kind: upserted.row.kind },
          });
        }
        return {
          inserted: upserted.inserted,
          source: toImportSource(upserted.row, ctx.uid, body.deviceId),
        };
      });
      request.log.info(
        { sourceId: result.source.id, babyId, inserted: result.inserted },
        "album sync enabled",
      );
      return reply.code(result.inserted ? 201 : 200).send({ source: result.source });
    },
  });

  r.route({
    method: "PATCH",
    url: "/import-sources/:id",
    schema: {
      params: idParamsSchema,
      body: patchImportSourceRequestSchema,
      response: { 200: importSourceResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const row = await patchSource(client, id, request.body);
        if (!row) throw sourceNotFound();
        // `isThisDevice` is only known from the list's `deviceId` query; PATCH answers false.
        return { source: toImportSource(row, ctx.uid, null) };
      });
    },
  });

  r.route({
    method: "DELETE",
    url: "/import-sources/:id",
    schema: { params: idParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id } = request.params;
      const deleted = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const gone = await deleteSource(client, id);
        if (!gone) throw sourceNotFound();
        await audit(client, "import.source_deleted", {
          babyId: gone.babyId,
          actorUserId: ctx.uid,
          metadata: { source_id: id },
        });
        return gone;
      });
      request.log.info({ sourceId: id, babyId: deleted.babyId }, "album sync removed");
      return reply.code(204).send();
    },
  });
}
