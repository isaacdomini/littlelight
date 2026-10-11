import {
  extensionForMime,
  FREE_TIER_PHOTO_LIMIT,
  idParamsSchema,
  originalUrlResponseSchema,
  type Photo,
  type PhotoUrlSet,
  photoDetailsPatchSchema,
  photoIdParamsSchema,
  photoSchema,
  photoSummarySchema,
  photosBatchDetailsRequestSchema,
  photosBatchDetailsResponseSchema,
  photosListQuerySchema,
  photosListResponseSchema,
  photosSummaryQuerySchema,
  photosSummaryResponseSchema,
  photoUrlsRequestSchema,
  photoUrlsResponseSchema,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit, requireAuth, requireConsent, type Tx, withClaims } from "../auth";
import { ApiError, forbidden, freeTierLimit, isPgError, notFound } from "../lib/errors";
import { photoMeasurements } from "../measurements/queries";
import { enqueueReindexAll } from "../plugins/jobs";
import { objectExists } from "../storage/multipart";
import type { UrlSigner } from "../storage/sign";
import { loadPhotoAi } from "./ai-queries";
import {
  assertMilestoneUsable,
  babyAccess,
  batchDetailsSql,
  countPending,
  countPoolPhotos,
  decodeCursor,
  detailsUpsertSql,
  groupCounts,
  listPhotoRows,
  PHOTO_SUMMARY_EXTRA_COLUMNS,
  type PhotoSummaryRow,
  pageCursors,
  photoDetails,
  photoEditable,
  photoExif,
  photoUrlRows,
  photoWithRole,
  signDerivative,
  signPhotoUrls,
  toPhotoGroups,
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
//
// Step 5 (docs/plans/step-5.md 2.4, 2.4a, 2.5; PRD FR-3, FR-8): bidirectional keyset paging and
// the milestone filter, the age-group summary with jump cursors, batch URL refresh, and
// parent-details editing for one photo or a batch. Details writes run under the caller's claims
// (`photo_details` policies = `photo_editable`: admins, or the uploader of a live pending photo);
// people, notes and location labels are never logged or audited (audit rows carry ids/counts).
// `photo.reindex` is sent after commit, outside `runAs`, through `app.jobs`.

export const photoNotFound = () =>
  notFound("That photo doesn't exist or you don't have access to it");
export const babyNotFound = () =>
  notFound("That album doesn't exist or you don't have access to it");
export const adminOnly = () => forbidden("Only an admin of this album can do that");

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

/** `photos_free_tier_cap` refused the write (the family's free pool is full). */
function isFreeTierCap(err: unknown): boolean {
  return isPgError(err) && err.code === "23514" && err.message.startsWith("free tier photo limit");
}

const RETURNING_SUMMARY = `
  RETURNING p.id, p.baby_id, p.status, p.approval, p.taken_at, p.taken_at_estimated, p.age_days,
            p.width, p.height, p.mime, p.is_sensitive, p.duplicate_of_photo_id, p.uploaded_by,
            p.created_at, p.deleted_at,
            EXISTS (SELECT 1 FROM public.photo_derivatives t
                     WHERE t.photo_id = p.id AND t.kind = 'thumb') AS has_thumb,
            ${PHOTO_SUMMARY_EXTRA_COLUMNS}`;

/** Everything `GET /photos/:id` returns, read in one claims transaction (signing happens after). */
export interface LoadedPhoto {
  photo: NonNullable<Awaited<ReturnType<typeof photoWithRole>>>;
  exif: Photo["exif"];
  details: Photo["details"];
  measurements: Photo["measurements"];
  canEdit: boolean;
  ai: Photo["ai"];
}

/** Load a photo the caller may see, or throw 404. */
export async function loadPhoto(client: Tx, uid: string, id: string): Promise<LoadedPhoto> {
  const photo = await photoWithRole(client, uid, id);
  if (!visibleToCaller(photo)) throw photoNotFound();
  const exif = await photoExif(client, id);
  const details = await photoDetails(client, id);
  const measurements = await photoMeasurements(client, id);
  const canEdit = await photoEditable(client, id);
  // Step 6: status, override-merged description, raw output for admins only (plan 2.8).
  const ai = await loadPhotoAi(client, {
    photoId: id,
    aiStatus: photo.ai_status,
    isAdmin: photo.role === "admin",
  });
  return { photo, exif, details, measurements, canEdit, ai };
}

/** `photoSchema` body: sign thumb + display after the transaction. */
export async function toPhotoResponse(signer: UrlSigner, loaded: LoadedPhoto): Promise<Photo> {
  const { photo } = loaded;
  const [summary, display] = await Promise.all([
    toPhotoSummary(signer, photo),
    photo.has_display ? signDerivative(signer, photo.baby_id, photo.id, "display") : null,
  ]);
  return {
    ...summary,
    // Both URLs were signed just now with the same TTL; report the earlier expiry.
    urlExpiresAt: summary.urlExpiresAt ?? display?.expiresAt.toISOString() ?? null,
    displayUrl: display?.url ?? null,
    exif: loaded.exif,
    details: loaded.details,
    measurements: loaded.measurements,
    canEdit: loaded.canEdit,
    ai: loaded.ai,
  };
}

/** 403 for a visible photo whose details the caller may not edit (RLS refused the write). */
export function detailsForbidden(photo: {
  role: string | null;
  deleted_at: Date | null;
}): ApiError {
  if (photo.role === "admin") {
    return forbidden(
      photo.deleted_at
        ? "Restore this photo from the trash before editing its details"
        : "This photo's details can't be edited",
    );
  }
  return forbidden(
    "You can only edit details of your own photos that are still waiting for approval",
  );
}

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
      const { view, limit, dir, milestoneId } = request.query;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const page = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await babyAccess(client, ctx.uid, babyId);
        if (!access) throw babyNotFound();
        if (view === "trash" && access.role !== "admin") throw adminOnly();
        const list = await listPhotoRows(client, {
          babyId,
          view,
          cursor,
          limit,
          dir,
          milestoneId: milestoneId ?? null,
        });
        const pendingCount = await countPending(client, babyId);
        return { ...list, pendingCount };
      });
      return {
        photos: await Promise.all(page.rows.map((row) => toPhotoSummary(app.signer, row))),
        ...pageCursors(page, dir, cursor !== null),
        pendingCount: page.pendingCount,
      };
    },
  });

  r.route({
    method: "GET",
    url: "/babies/:id/photos/summary",
    schema: {
      params: idParamsSchema,
      querystring: photosSummaryQuerySchema,
      response: { 200: photosSummaryResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const { view } = request.query;
      const rows = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await babyAccess(client, ctx.uid, babyId);
        if (!access) throw babyNotFound();
        if (view === "trash" && access.role !== "admin") throw adminOnly();
        return groupCounts(client, babyId, view);
      });
      return toPhotoGroups(rows);
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/photos/urls",
    schema: {
      params: idParamsSchema,
      body: photoUrlsRequestSchema,
      response: { 200: photoUrlsResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const ids = [...new Set(request.body.photoIds.map((x) => x.toLowerCase()))];
      const rows = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await babyAccess(client, ctx.uid, babyId);
        if (!access) throw babyNotFound();
        const found = await photoUrlRows(client, babyId, ids);
        // Same narrowing as everywhere: non-admins never see trashed or failed photos (D12).
        return found.filter((r) => visibleToCaller({ ...r, role: access.role }));
      });
      const urls: Record<string, PhotoUrlSet> = {};
      const signed = await Promise.all(rows.map((r) => signPhotoUrls(app.signer, r)));
      rows.forEach((r, i) => {
        const set = signed[i];
        if (set) urls[r.id] = set;
      });
      return { urls };
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
        return loadPhoto(client, ctx.uid, id);
      });
      return toPhotoResponse(app.signer, loaded);
    },
  });

  r.route({
    method: "PATCH",
    url: "/photos/:id/details",
    schema: {
      params: photoIdParamsSchema,
      body: photoDetailsPatchSchema,
      response: { 200: photoSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const patch = request.body;
      const loaded = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const photo = await photoWithRole(client, ctx.uid, id);
        if (!visibleToCaller(photo)) throw photoNotFound();
        if (patch.milestoneId)
          await assertMilestoneUsable(client, patch.milestoneId, photo.baby_id);
        // RLS decides: the INSERT … ON CONFLICT DO UPDATE is checked against `photo_editable`
        // (INSERT WITH CHECK and UPDATE USING); a refusal is 42501 and aborts the transaction.
        const { text, values } = detailsUpsertSql(id, ctx.uid, patch);
        try {
          await client.query(text, values);
        } catch (err) {
          if (isPgError(err) && err.code === "42501") throw detailsForbidden(photo);
          throw err;
        }
        await audit(client, "photo.details_updated", {
          babyId: photo.baby_id,
          actorUserId: ctx.uid,
          metadata: { photo_id: id },
        });
        return loadPhoto(client, ctx.uid, id);
      });
      // After commit, outside runAs (step-4 rule).
      await app.jobs.enqueueReindex({
        photoId: loaded.photo.id,
        babyId: loaded.photo.baby_id,
        reason: "details",
      });
      return toPhotoResponse(app.signer, loaded);
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/photos/details",
    schema: {
      params: idParamsSchema,
      body: photosBatchDetailsRequestSchema,
      response: { 200: photosBatchDetailsResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const body = request.body;
      const ids = [...new Set(body.photoIds.map((x) => x.toLowerCase()))];
      const updated = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await babyAccess(client, ctx.uid, babyId);
        if (!access) throw babyNotFound();
        if (body.milestoneId) await assertMilestoneUsable(client, body.milestoneId, babyId);
        // One set-based upsert: only ids that are photos of this baby the caller may edit
        // (`photo_editable`, the policies' own rule) and whose merged people stay within the cap;
        // RLS checks every written row again. Everything else is reported as skipped.
        const { text, values } = batchDetailsSql(babyId, ctx.uid, ids, body);
        const { rows } = await client.query<{ photo_id: string }>(text, values);
        const done = rows.map((r) => r.photo_id);
        if (done.length > 0) {
          await audit(client, "photos.details_batch_updated", {
            babyId,
            actorUserId: ctx.uid,
            metadata: { count: done.length },
          });
        }
        return done;
      });
      const done = new Set(updated);
      await enqueueReindexAll(
        app.jobs,
        updated.map((photoId) => ({ photoId, babyId, reason: "details" as const })),
      );
      return { updated: ids.filter((x) => done.has(x)), skipped: ids.filter((x) => !done.has(x)) };
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
        // A row can outlive its object (dev perf seed, a failed or purged upload): answer 404
        // before signing a URL that would fail, and before auditing a download that can't happen.
        if (!(await objectExists(app.s3, app.config.S3_BUCKET, p.storage_key_original))) {
          throw notFound("The original of this photo isn't available");
        }
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
        // pending row fails WITH CHECK ⇒ 42501 ⇒ 403). No pool pre-check (step 11, 2.5): the
        // `photos_free_tier_cap` trigger counts approved photos only and raises inside this
        // UPDATE when the family is full, so a refusal is a thrown 23514, never "0 rows": it is
        // mapped here and `explainNoRow` below is only reached for a genuinely unmatched row.
        let rows: PhotoSummaryRow[];
        try {
          ({ rows } = await client.query<PhotoSummaryRow>(
            `UPDATE public.photos p
                SET approval = 'approved', approved_by = $2, approved_at = now()
              WHERE p.id = $1 AND p.approval = 'pending' AND p.deleted_at IS NULL
                    AND p.status NOT IN ('failed', 'duplicate')
             ${RETURNING_SUMMARY}`,
            [id, ctx.uid],
          ));
        } catch (err) {
          if (isFreeTierCap(err)) throw freeTierLimit();
          throw err;
        }
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
        // Friendly pre-check (step 11, 2.5): only an approved photo comes back into the family's
        // pool (approved photos only count); a rejected one returns to the approval queue and
        // draws nothing from it. The `photos_free_tier_cap` / `photos_pending_cap` triggers
        // (BEFORE UPDATE OF deleted_at) are the hard stops and are mapped below.
        if (
          access?.plan === "free" &&
          photo.approval === "approved" &&
          (await countPoolPhotos(client, photo.baby_id)) >= FREE_TIER_PHOTO_LIMIT
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
          if (isFreeTierCap(err)) throw freeTierLimit();
          // A rejected photo returns to the queue, but its uploader's pending queue in this
          // family is full (`photos_pending_cap`). The admin is not the uploader, so the
          // generic "you have …" wording would be wrong here.
          if (
            isPgError(err) &&
            err.code === "23514" &&
            err.message.startsWith("pending photo limit")
          ) {
            throw new ApiError(
              409,
              "pending_limit",
              "The person who added this photo already has the most photos waiting for approval in this family. Review some of them first.",
            );
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
