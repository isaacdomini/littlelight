import {
  extensionForMime,
  FREE_TIER_PHOTO_LIMIT,
  idParamsSchema,
  originalUrlResponseSchema,
  photoIdParamsSchema,
  photoSchema,
  photoSummarySchema,
  photosListQuerySchema,
  photosListResponseSchema,
} from "@littlelight/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit, requireAuth, requireConsent, type Tx, withClaims } from "../auth";
import { ApiError, forbidden, freeTierLimit, isPgError, notFound } from "../lib/errors";
import {
  babyAccess,
  countLivePhotos,
  countPending,
  decodeCursor,
  encodeCursor,
  listPhotoRows,
  type PhotoSummaryRow,
  photoDetails,
  photoExif,
  photoWithRole,
  signDerivative,
  toPhotoSummary,
  visibleToCaller,
} from "./queries";

// `/babies/:id/photos` and `/photos/:id…` (docs/plans/step-4.md 2.4, 2.10; PRD FR-2.7 approval
// queue, FR-6, FR-8, FR-10.2 trash). Authorization is Postgres RLS: every statement runs under
// the caller's claims, writes name only the row and the intended transition, and a write that
// matched nothing is explained afterwards (404 when RLS hides the photo, 403 when it is visible
// but the caller may not change it, 409 when the state does not allow it). The API reads the
// caller's role only to pick between those, never to grant anything. The one narrowing check the
// API adds on top of RLS: non-admins never see trashed photos (D12) and restore is admin-only.
// Signed URLs are thumb/display only (`signDerivative`), TTL <= 1 h; originals only through
// `GET /photos/:id/original` for admins. Nothing here logs URLs, notes or EXIF values.

const photoNotFound = () => notFound("That photo doesn't exist or you don't have access to it");
const babyNotFound = () => notFound("That album doesn't exist or you don't have access to it");
const adminOnly = () => forbidden("Only an admin of this album can do that");

/** Explain a guarded UPDATE that matched no row. */
async function explainNoRow(
  client: Tx,
  uid: string,
  photoId: string,
  conflictMessage: string,
): Promise<never> {
  const photo = await photoWithRole(client, uid, photoId);
  if (!visibleToCaller(photo)) throw photoNotFound();
  if (photo.role !== "admin") throw adminOnly();
  throw new ApiError(409, "conflict", conflictMessage);
}

const RETURNING_SUMMARY = `
  RETURNING p.id, p.baby_id, p.status, p.approval, p.taken_at, p.taken_at_estimated, p.age_days,
            p.width, p.height, p.mime, p.is_sensitive, p.duplicate_of_photo_id, p.uploaded_by,
            p.created_at, p.deleted_at,
            EXISTS (SELECT 1 FROM public.photo_derivatives t
                     WHERE t.photo_id = p.id AND t.kind = 'thumb') AS has_thumb`;

export function photosRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/babies/:id/photos",
    schema: {
      params: idParamsSchema,
      querystring: photosListQuerySchema,
      response: { 200: photosListResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const { view, limit } = request.query;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const page = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await babyAccess(client, ctx.uid, babyId);
        if (!access) throw babyNotFound();
        if (view === "trash" && access.role !== "admin") throw adminOnly();
        const list = await listPhotoRows(client, { babyId, view, cursor, limit });
        const pendingCount = await countPending(client, babyId);
        return { ...list, pendingCount };
      });
      return {
        photos: await Promise.all(page.rows.map((row) => toPhotoSummary(app.signer, row))),
        nextCursor: page.next ? encodeCursor(page.next) : null,
        pendingCount: page.pendingCount,
      };
    },
  });

  r.route({
    method: "GET",
    url: "/photos/:id",
    schema: { params: photoIdParamsSchema, response: { 200: photoSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const loaded = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const photo = await photoWithRole(client, ctx.uid, id);
        if (!visibleToCaller(photo)) {
          throw photoNotFound();
        }
        const [exif, details] = [await photoExif(client, id), await photoDetails(client, id)];
        return { photo, exif, details };
      });
      const { photo } = loaded;
      const [summary, display] = await Promise.all([
        toPhotoSummary(app.signer, photo),
        photo.has_display ? signDerivative(app.signer, photo.baby_id, photo.id, "display") : null,
      ]);
      return {
        ...summary,
        // Both URLs were signed just now with the same TTL; report the earlier expiry.
        urlExpiresAt: summary.urlExpiresAt ?? display?.expiresAt.toISOString() ?? null,
        displayUrl: display?.url ?? null,
        exif: loaded.exif,
        details: loaded.details,
      };
    },
  });

  r.route({
    method: "GET",
    url: "/photos/:id/original",
    schema: { params: photoIdParamsSchema, response: { 200: originalUrlResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const photo = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const p = await photoWithRole(client, ctx.uid, id);
        if (!visibleToCaller(p)) throw photoNotFound();
        // Originals carry GPS by definition: admins only (PRD "Privacy and child safety").
        if (p.role !== "admin") throw adminOnly();
        await audit(client, "photo.original_downloaded", {
          babyId: p.baby_id,
          actorUserId: ctx.uid,
          metadata: { photo_id: p.id, client: request.auth?.clientKind ?? "web" },
        });
        return p;
      });
      const ext = photo.mime ? extensionForMime(photo.mime) : null;
      const signed = await app.signer.signGet(photo.storage_key_original, {
        contentType: photo.mime ?? "application/octet-stream",
        contentDisposition: `attachment; filename="${photo.id}${ext ? `.${ext}` : ""}"`,
      });
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  });

  r.route({
    method: "POST",
    url: "/photos/:id/approve",
    schema: { params: photoIdParamsSchema, response: { 200: photoSummarySchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const row = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        // RLS: only an admin's UPDATE can produce `approval = 'approved'` (a contributor's own
        // pending row fails WITH CHECK ⇒ 42501 ⇒ 403).
        const { rows } = await client.query<PhotoSummaryRow>(
          `UPDATE public.photos p
              SET approval = 'approved', approved_by = $2, approved_at = now()
            WHERE p.id = $1 AND p.approval = 'pending' AND p.deleted_at IS NULL
                  AND p.status NOT IN ('failed', 'duplicate')
           ${RETURNING_SUMMARY}`,
          [id, ctx.uid],
        );
        const updated = rows[0];
        if (!updated) {
          return explainNoRow(client, ctx.uid, id, "This photo isn't waiting for approval");
        }
        await audit(client, "photo.approved", {
          babyId: updated.baby_id,
          actorUserId: ctx.uid,
          metadata: { photo_id: id },
        });
        return updated;
      });
      return toPhotoSummary(app.signer, row);
    },
  });

  r.route({
    method: "POST",
    url: "/photos/:id/reject",
    schema: { params: photoIdParamsSchema, response: { 200: photoSummarySchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const row = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        // Rejected uploads go to the trash and are purged with it after 30 days (D12).
        const { rows } = await client.query<PhotoSummaryRow>(
          `UPDATE public.photos p
              SET approval = 'rejected', deleted_at = now()
            WHERE p.id = $1 AND p.approval = 'pending' AND p.deleted_at IS NULL
                  AND p.status <> 'duplicate'
           ${RETURNING_SUMMARY}`,
          [id],
        );
        const updated = rows[0];
        if (!updated) {
          return explainNoRow(client, ctx.uid, id, "This photo isn't waiting for approval");
        }
        await audit(client, "photo.rejected", {
          babyId: updated.baby_id,
          actorUserId: ctx.uid,
          metadata: { photo_id: id },
        });
        return updated;
      });
      return toPhotoSummary(app.signer, row);
    },
  });

  r.route({
    method: "DELETE",
    url: "/photos/:id",
    schema: { params: photoIdParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        // RLS: admins may trash any photo of their baby, contributors only their own pending ones.
        const { rows } = await client.query<{ baby_id: string }>(
          `UPDATE public.photos SET deleted_at = now()
            WHERE id = $1 AND deleted_at IS NULL AND status <> 'duplicate'
            RETURNING baby_id`,
          [id],
        );
        const updated = rows[0];
        if (!updated) {
          const photo = await photoWithRole(client, ctx.uid, id);
          if (!visibleToCaller(photo)) {
            throw photoNotFound();
          }
          // Already in the trash: idempotent.
          if (photo.deleted_at !== null) return;
          throw forbidden(
            "You can only delete your own photos that are still waiting for approval",
          );
        }
        await audit(client, "photo.trashed", {
          babyId: updated.baby_id,
          actorUserId: ctx.uid,
          metadata: { photo_id: id },
        });
      });
      return reply.code(204).send();
    },
  });

  r.route({
    method: "POST",
    url: "/photos/:id/restore",
    schema: { params: photoIdParamsSchema, response: { 200: photoSummarySchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const row = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const photo = await photoWithRole(client, ctx.uid, id);
        if (!visibleToCaller(photo)) throw photoNotFound();
        if (photo.role !== "admin") throw adminOnly();
        if (photo.deleted_at === null) return photo;
        const access = await babyAccess(client, ctx.uid, photo.baby_id);
        if (access?.deletedAt) {
          throw new ApiError(409, "conflict", "This album is in the trash");
        }
        // The cap trigger only fires on INSERT; restoring past the free limit is checked here.
        if (
          access?.plan === "free" &&
          (await countLivePhotos(client, photo.baby_id)) >= FREE_TIER_PHOTO_LIMIT
        ) {
          throw freeTierLimit();
        }
        let restored: PhotoSummaryRow | undefined;
        try {
          // A rejected upload comes back to the approval queue rather than into the album.
          const { rows } = await client.query<PhotoSummaryRow>(
            `UPDATE public.photos p
                SET deleted_at = NULL,
                    approval = CASE WHEN p.approval = 'rejected' THEN 'pending' ELSE p.approval END
              WHERE p.id = $1 AND p.deleted_at IS NOT NULL
             ${RETURNING_SUMMARY}`,
            [id],
          );
          restored = rows[0];
        } catch (err) {
          // photos_baby_id_sha256_key: the same bytes are live in the album again.
          if (isPgError(err) && err.code === "23505") {
            throw new ApiError(409, "conflict", "The same photo is already in the album");
          }
          throw err;
        }
        if (!restored) return explainNoRow(client, ctx.uid, id, "This photo is not in the trash");
        await audit(client, "photo.restored", {
          babyId: restored.baby_id,
          actorUserId: ctx.uid,
          metadata: { photo_id: id },
        });
        return restored;
      });
      return toPhotoSummary(app.signer, row);
    },
  });
}
