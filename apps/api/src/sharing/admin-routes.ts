import {
  type AuditMetadata,
  idParamsSchema,
  photoShareLinksResponseSchema,
  type ShareLinkAuditField,
  type ShareLinkPhoto,
  type ShareLinkSkipReason,
  shareLinkCreatedResponseSchema,
  shareLinkCreateRequestSchema,
  shareLinkPatchRequestSchema,
  shareLinkPhotoParamsSchema,
  shareLinkPhotoPatchRequestSchema,
  shareLinkPhotoSchema,
  shareLinkPhotosAddRequestSchema,
  shareLinkPhotosAddResponseSchema,
  shareLinkPhotosQuerySchema,
  shareLinkPhotosRemoveRequestSchema,
  shareLinkPhotosRemoveResponseSchema,
  shareLinkPhotosResponseSchema,
  shareLinkRenewRequestSchema,
  shareLinkSchema,
  shareLinksResponseSchema,
  shareRuleInputSchema,
  shareRuleSchema,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit, requireAuth, requireConsent, withClaims } from "../auth";
import { ApiError, shareRulePlanRequired } from "../lib/errors";
import {
  decodeCursor,
  encodeCursor,
  PHOTO_SUMMARY_COLUMNS,
  PHOTO_THUMB_JOIN,
  type PhotoSummaryRow,
  toPhotoSummary,
} from "../photos/queries";
import { hashPasscode, newShareToken, shareLinkUrl } from "./crypto";
import {
  babyAiEnabled,
  keysetClause,
  loadShareLink,
  loadShareLinks,
  requireLinkAdmin,
  requireShareAdmin,
  SHARE_SORT_KEY_SQL,
  sharedBy,
  shareLinkNotFound,
  type Tx,
  toShareLink,
  toShareRule,
} from "./queries";

// Admin share-link routes (docs/plans/step-8.md 2.5; PRD "FR-9 Sharing" 9.1-9.5, 9.7, 9.8,
// "Roles and permissions": creating, renewing and revoking links is admin-only; "Auth security
// requirements": share link created/renewed/revoked are audited).
//
// - Every route: `requireAuth` + `withClaims` (role `authenticated`, session liveness) +
//   `requireConsent` + an admin check on the link's baby (stranger 404, contributor 403). No
//   service_role anywhere here: admins write the hash columns through their own column grants,
//   and RLS (`is_baby_admin` on every sharing policy) is the backstop for the API's check.
// - The token is minted per create/regenerate, stored only as SHA-256 and returned once inside
//   the URL (D1). Passcodes are scrypt-hashed before the transaction (D7). Neither, nor any hash,
//   name or tag, reaches a log line, an error or an audit row (metadata: ids, counts, flags).
// - Auto-share rules are Plus-only (D3): 403 `plan_required` here and `share_rules_shape` in the
//   database. `share.apply` is enqueued after commit, outside `runAs`.
// - Manual album writes are hand-picked rows (`added_by = 'user'`) attributed to the caller;
//   sensitive photos are added hidden unless the admin explicitly shows them (D4, audited per
//   photo); removals leave an exclusion so a rule never re-adds the photo (D5).

const RELEASED_AUDIT_ROWS_MAX = 20;

/**
 * A JSON body that may be absent (`curl -X POST` without one): a missing/null body parses as `{}`.
 */
function optionalBody<S extends z.ZodType>(schema: S) {
  return z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);
}

/** `POST …/regenerate`, `…/revoke`: no fields. */
const emptyBodySchema = optionalBody(z.strictObject({}));

const revokedConflict = () =>
  new ApiError(409, "conflict", "This link was revoked. Regenerate it to share again.");
const notInAlbum = () => new ApiError(404, "not_found", "That photo isn't in this shared album");

/** Read one album row as the admin sees it (signed thumb). */
interface AlbumPhotoRow extends PhotoSummaryRow {
  added_by: string;
  added_at: Date;
  hidden_from_viewers: boolean;
  sort_key: string;
}

const ALBUM_PHOTO_COLUMNS = `${PHOTO_SUMMARY_COLUMNS}, sp.added_by, sp.added_at,
  (p.is_sensitive AND NOT (sp.added_by = 'user' AND sp.sensitive_released_at IS NOT NULL))
    AS hidden_from_viewers,
  ${SHARE_SORT_KEY_SQL} AS sort_key`;

async function toAlbumPhoto(
  signer: FastifyInstance["signer"],
  r: AlbumPhotoRow,
): Promise<ShareLinkPhoto> {
  return {
    ...(await toPhotoSummary(signer, r)),
    sharedBy: sharedBy(r.added_by),
    hiddenFromViewers: r.hidden_from_viewers,
    addedAt: r.added_at.toISOString(),
  };
}

/** Audit `share_link.sensitive_shown` per newly released photo (capped, then one `count` row). */
async function auditReleases(
  client: Tx,
  input: { babyId: string; uid: string; linkId: string },
  photoIds: readonly string[],
): Promise<void> {
  const base = { babyId: input.babyId, actorUserId: input.uid, shareLinkId: input.linkId };
  for (const photoId of photoIds.slice(0, RELEASED_AUDIT_ROWS_MAX)) {
    await audit(client, "share_link.sensitive_shown", { ...base, metadata: { photo_id: photoId } });
  }
  const rest = photoIds.length - RELEASED_AUDIT_ROWS_MAX;
  if (rest > 0) {
    await audit(client, "share_link.sensitive_shown", { ...base, metadata: { count: rest } });
  }
}

export function adminShareRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- list / create ------------------------------------------------------------------------------

  r.route({
    method: "GET",
    url: "/babies/:id/share-links",
    schema: { params: idParamsSchema, response: { 200: shareLinksResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const rows = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        await requireShareAdmin(client, ctx.uid, babyId, { allowTrashed: true });
        return loadShareLinks(client, babyId);
      });
      return { links: rows.map(toShareLink) };
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/share-links",
    schema: {
      params: idParamsSchema,
      body: shareLinkCreateRequestSchema,
      response: { 201: shareLinkCreatedResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId } = request.params;
      const body = request.body;
      const passcodeHash = body.passcode ? await hashPasscode(body.passcode) : null;
      const minted = newShareToken();
      const rule = body.rule ?? null;
      const link = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        await requireShareAdmin(client, ctx.uid, babyId);
        if (rule && !(await babyAiEnabled(client, babyId))) throw shareRulePlanRequired();
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO public.share_links
             (baby_id, name, token_hash, passcode_hash, expires_at, ttl_hours, allow_download, created_by)
           VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5::int), $5::int, $6, $7)
           RETURNING id`,
          [
            babyId,
            body.name,
            minted.hash,
            passcodeHash,
            body.ttlHours,
            body.allowDownload,
            ctx.uid,
          ],
        );
        const id = rows[0]?.id;
        if (!id) throw shareLinkNotFound();
        if (rule) {
          await client.query(
            `INSERT INTO public.share_rules (share_link_id, mode, include_tags, exclude_tags)
             VALUES ($1, $2, $3::text[], $4::text[])`,
            [id, rule.mode, rule.includeTags, rule.excludeTags],
          );
        }
        await audit(client, "share_link.created", {
          babyId,
          actorUserId: ctx.uid,
          shareLinkId: id,
          metadata: {
            hours: body.ttlHours,
            has_passcode: passcodeHash !== null,
            allow_download: body.allowDownload,
            ...(rule ? { mode: rule.mode } : {}),
          },
        });
        return loadShareLink(client, babyId, id);
      });
      if (rule) await app.jobs.enqueueShareApply({ shareLinkId: link.id, reason: "rule_changed" });
      request.log.info({ shareLinkId: link.id }, "share link created");
      return reply.code(201).send({ link, url: shareLinkUrl(app.config.PUBLIC_URL, minted.token) });
    },
  });

  // ---- settings, renew, regenerate, revoke, delete ------------------------------------------------

  r.route({
    method: "PATCH",
    url: "/share-links/:id",
    schema: {
      params: idParamsSchema,
      body: shareLinkPatchRequestSchema,
      response: { 200: shareLinkSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const body = request.body;
      const passcodeHash =
        body.passcode === undefined || body.passcode === null
          ? body.passcode
          : await hashPasscode(body.passcode);
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id, { allowTrashed: true });
        // Fixed column names only; values are bind parameters.
        const sets: string[] = [];
        const values: unknown[] = [id];
        const fields: ShareLinkAuditField[] = [];
        const set = (column: string, value: unknown, field: ShareLinkAuditField) => {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
          fields.push(field);
        };
        if (body.name !== undefined) set("name", body.name, "name");
        if (body.allowDownload !== undefined)
          set("allow_download", body.allowDownload, "allow_download");
        if (passcodeHash !== undefined) set("passcode_hash", passcodeHash, "passcode");
        if (body.ttlHours !== undefined) set("ttl_hours", body.ttlHours, "ttl_hours");
        const { rowCount } = await client.query(
          `UPDATE public.share_links SET ${sets.join(", ")} WHERE id = $1`,
          values,
        );
        if (!rowCount) throw shareLinkNotFound();
        await audit(client, "share_link.updated", {
          babyId: access.babyId,
          actorUserId: ctx.uid,
          shareLinkId: id,
          metadata: { fields },
        });
        return loadShareLink(client, access.babyId, id);
      });
    },
  });

  r.route({
    method: "POST",
    url: "/share-links/:id/renew",
    schema: {
      params: idParamsSchema,
      body: optionalBody(shareLinkRenewRequestSchema),
      response: { 200: shareLinkSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const requested = request.body.ttlHours;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id);
        const { rows } = await client.query<{ revoked: boolean; ttl_hours: number }>(
          `SELECT revoked_at IS NOT NULL AS revoked, ttl_hours
             FROM public.share_links WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const current = rows[0];
        if (!current) throw shareLinkNotFound();
        if (current.revoked) throw revokedConflict();
        const hours = requested ?? current.ttl_hours;
        await client.query(
          `UPDATE public.share_links
              SET expires_at = now() + make_interval(hours => $2::int), ttl_hours = $2::int
            WHERE id = $1`,
          [id, hours],
        );
        await audit(client, "share_link.renewed", {
          babyId: access.babyId,
          actorUserId: ctx.uid,
          shareLinkId: id,
          metadata: { hours },
        });
        return loadShareLink(client, access.babyId, id);
      });
    },
  });

  r.route({
    method: "POST",
    url: "/share-links/:id/regenerate",
    schema: {
      params: idParamsSchema,
      body: emptyBodySchema,
      response: { 200: shareLinkCreatedResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const minted = newShareToken();
      const link = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id);
        // New token (old one dead, every open viewer session ended by `share_links_end_sessions`,
        // passcode-failure windows restart at `token_rotated_at`), un-revoked, fresh expiry;
        // the passcode is kept.
        const { rowCount } = await client.query(
          `UPDATE public.share_links
              SET token_hash = $2, revoked_at = NULL,
                  expires_at = now() + make_interval(hours => ttl_hours)
            WHERE id = $1`,
          [id, minted.hash],
        );
        if (!rowCount) throw shareLinkNotFound();
        await audit(client, "share_link.regenerated", {
          babyId: access.babyId,
          actorUserId: ctx.uid,
          shareLinkId: id,
        });
        return loadShareLink(client, access.babyId, id);
      });
      request.log.info({ shareLinkId: id }, "share link regenerated");
      return { link, url: shareLinkUrl(app.config.PUBLIC_URL, minted.token) };
    },
  });

  r.route({
    method: "POST",
    url: "/share-links/:id/revoke",
    schema: { params: idParamsSchema, body: emptyBodySchema, response: { 200: shareLinkSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id, { allowTrashed: true });
        // Idempotent: an already revoked link is returned unchanged, without a second audit row.
        const { rowCount } = await client.query(
          "UPDATE public.share_links SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
          [id],
        );
        if (rowCount) {
          await audit(client, "share_link.revoked", {
            babyId: access.babyId,
            actorUserId: ctx.uid,
            shareLinkId: id,
          });
        }
        return loadShareLink(client, access.babyId, id);
      });
    },
  });

  r.route({
    method: "DELETE",
    url: "/share-links/:id",
    schema: { params: idParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id, { allowTrashed: true });
        // Audit first so the row names the link; the FK then sets `share_link_id` NULL.
        await audit(client, "share_link.deleted", {
          babyId: access.babyId,
          actorUserId: ctx.uid,
          shareLinkId: id,
        });
        const { rowCount } = await client.query("DELETE FROM public.share_links WHERE id = $1", [
          id,
        ]);
        if (!rowCount) throw shareLinkNotFound();
      });
      return reply.code(204).send();
    },
  });

  // ---- auto-share rule (Plus only, D3) ------------------------------------------------------------

  r.route({
    method: "PUT",
    url: "/share-links/:id/rule",
    schema: {
      params: idParamsSchema,
      body: shareRuleInputSchema,
      response: { 200: shareRuleSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const rule = request.body;
      const saved = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id);
        if (!(await babyAiEnabled(client, access.babyId))) throw shareRulePlanRequired();
        const { rows } = await client.query<{
          mode: typeof rule.mode;
          include_tags: string[];
          exclude_tags: string[];
          updated_at: Date;
          evaluated_at: Date | null;
        }>(
          `INSERT INTO public.share_rules (share_link_id, mode, include_tags, exclude_tags)
           VALUES ($1, $2, $3::text[], $4::text[])
           ON CONFLICT (share_link_id) DO UPDATE
             SET mode = EXCLUDED.mode, include_tags = EXCLUDED.include_tags,
                 exclude_tags = EXCLUDED.exclude_tags
           RETURNING mode, include_tags, exclude_tags, updated_at, evaluated_at`,
          [id, rule.mode, rule.includeTags, rule.excludeTags],
        );
        const row = rows[0];
        if (!row) throw shareLinkNotFound();
        await audit(client, "share_link.rule_updated", {
          babyId: access.babyId,
          actorUserId: ctx.uid,
          shareLinkId: id,
          metadata: { mode: rule.mode },
        });
        return toShareRule(row);
      });
      await app.jobs.enqueueShareApply({ shareLinkId: id, reason: "rule_changed" });
      return saved;
    },
  });

  r.route({
    method: "DELETE",
    url: "/share-links/:id/rule",
    schema: { params: idParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id, { allowTrashed: true });
        // Photos the rule added stay (D5); always allowed, also after a downgrade.
        const { rowCount } = await client.query(
          "DELETE FROM public.share_rules WHERE share_link_id = $1",
          [id],
        );
        if (rowCount) {
          await audit(client, "share_link.rule_removed", {
            babyId: access.babyId,
            actorUserId: ctx.uid,
            shareLinkId: id,
          });
        }
      });
      return reply.code(204).send();
    },
  });

  // ---- album membership (FR-9.3, FR-8.4, FR-9.5) --------------------------------------------------

  r.route({
    method: "GET",
    url: "/share-links/:id/photos",
    schema: {
      params: idParamsSchema,
      querystring: shareLinkPhotosQuerySchema,
      response: { 200: shareLinkPhotosResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const { limit } = request.query;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const rows = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id, { allowTrashed: true });
        const keyset = keysetClause(cursor, 4);
        const { rows } = await client.query<AlbumPhotoRow>(
          `SELECT ${ALBUM_PHOTO_COLUMNS}
             FROM public.shared_photos sp
             JOIN public.photos p ON p.id = sp.photo_id
             ${PHOTO_THUMB_JOIN}
            WHERE sp.share_link_id = $1 AND p.baby_id = $2
              AND p.deleted_at IS NULL AND p.status <> 'duplicate'
              ${keyset.sql}
            ORDER BY p.sort_at DESC, p.id DESC
            LIMIT $3`,
          [id, access.babyId, limit + 1, ...keyset.values],
        );
        return rows;
      });
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        photos: await Promise.all(page.map((row) => toAlbumPhoto(app.signer, row))),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ sortKey: last.sort_key, id: last.id })
            : null,
      };
    },
  });

  r.route({
    method: "POST",
    url: "/share-links/:id/photos",
    schema: {
      params: idParamsSchema,
      body: shareLinkPhotosAddRequestSchema,
      response: { 200: shareLinkPhotosAddResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const { photoIds, showSensitive } = request.body;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id);
        // Pre-filter (the `shared_photos_gate` trigger is the backstop): approved, live photos of
        // the link's baby. Quarantined photos are invisible to users, hence `not_found`.
        const { rows: found } = await client.query<{
          id: string;
          approval: string;
          status: string;
          trashed: boolean;
        }>(
          `SELECT p.id, p.approval, p.status, p.deleted_at IS NOT NULL AS trashed
             FROM public.photos p
            WHERE p.id = ANY($1::uuid[]) AND p.baby_id = $2`,
          [photoIds, access.babyId],
        );
        const byId = new Map(found.map((p) => [p.id, p]));
        const skipped: Array<{ photoId: string; reason: ShareLinkSkipReason }> = [];
        const eligible: string[] = [];
        for (const photoId of photoIds) {
          const p = byId.get(photoId);
          if (!p || p.status === "failed" || p.status === "duplicate") {
            skipped.push({ photoId, reason: "not_found" });
          } else if (p.trashed) {
            skipped.push({ photoId, reason: "trashed" });
          } else if (p.approval !== "approved") {
            skipped.push({ photoId, reason: "not_approved" });
          } else {
            eligible.push(photoId);
          }
        }
        if (eligible.length === 0) return { added: 0, alreadyShared: 0, hidden: 0, skipped };

        // Adding by hand lifts an earlier removal (exclusion).
        await client.query(
          `DELETE FROM public.shared_photo_exclusions
            WHERE share_link_id = $1 AND photo_id = ANY($2::uuid[])`,
          [id, eligible],
        );
        // New rows are hand-picked by the caller; a sensitive photo is released only when the
        // admin asked (`showSensitive`). An existing rule row becomes hand-picked; an existing
        // hand-picked row is touched only to release it. `sensitive_released_at = now()` marks
        // releases made by this statement (transaction timestamp).
        const { rows: written } = await client.query<{
          photo_id: string;
          inserted: boolean;
          released_now: boolean;
        }>(
          `INSERT INTO public.shared_photos AS sp
             (share_link_id, photo_id, added_by, added_by_user_id, sensitive_released_at, sensitive_released_by)
           SELECT $1, p.id, 'user', $2::uuid,
                  CASE WHEN $4::boolean AND p.is_sensitive THEN now() END,
                  CASE WHEN $4::boolean AND p.is_sensitive THEN $2::uuid END
             FROM public.photos p
            WHERE p.id = ANY($3::uuid[])
           ON CONFLICT (share_link_id, photo_id) DO UPDATE
             SET added_by = 'user',
                 added_by_user_id = EXCLUDED.added_by_user_id,
                 sensitive_released_at = COALESCE(sp.sensitive_released_at, EXCLUDED.sensitive_released_at),
                 sensitive_released_by = CASE WHEN sp.sensitive_released_at IS NOT NULL
                                              THEN sp.sensitive_released_by
                                              ELSE EXCLUDED.sensitive_released_by END
             WHERE sp.added_by = 'rule'
                OR (sp.sensitive_released_at IS NULL AND EXCLUDED.sensitive_released_at IS NOT NULL)
           RETURNING sp.photo_id, (sp.xmax = 0) AS inserted,
                     COALESCE(sp.sensitive_released_at = now(), false) AS released_now`,
          [id, ctx.uid, eligible, showSensitive],
        );
        const added = written.filter((w) => w.inserted).length;
        const released = written.filter((w) => w.released_now).map((w) => w.photo_id);
        const { rows: hiddenRows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM public.shared_photos sp JOIN public.photos p ON p.id = sp.photo_id
            WHERE sp.share_link_id = $1 AND sp.photo_id = ANY($2::uuid[])
              AND p.is_sensitive AND sp.sensitive_released_at IS NULL`,
          [id, eligible],
        );
        const base = { babyId: access.babyId, actorUserId: ctx.uid, shareLinkId: id };
        if (written.length > 0) {
          await audit(client, "share_link.photos_added", {
            ...base,
            metadata: { count: written.length } satisfies AuditMetadata,
          });
        }
        await auditReleases(client, { babyId: access.babyId, uid: ctx.uid, linkId: id }, released);
        return {
          added,
          alreadyShared: eligible.length - added,
          hidden: hiddenRows[0]?.n ?? 0,
          skipped,
        };
      });
    },
  });

  r.route({
    method: "POST",
    url: "/share-links/:id/photos/remove",
    schema: {
      params: idParamsSchema,
      body: shareLinkPhotosRemoveRequestSchema,
      response: { 200: shareLinkPhotosRemoveResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const { photoIds } = request.body;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id, { allowTrashed: true });
        const { rowCount } = await client.query(
          "DELETE FROM public.shared_photos WHERE share_link_id = $1 AND photo_id = ANY($2::uuid[])",
          [id, photoIds],
        );
        // Remember the removal for every requested photo of this baby, so the link's rule never
        // re-adds it (D5); ids of other babies are ignored rather than refused.
        await client.query(
          `INSERT INTO public.shared_photo_exclusions (share_link_id, photo_id, excluded_by)
           SELECT $1, p.id, $3::uuid FROM public.photos p
            WHERE p.id = ANY($2::uuid[]) AND p.baby_id = $4
           ON CONFLICT (share_link_id, photo_id) DO NOTHING`,
          [id, photoIds, ctx.uid, access.babyId],
        );
        const removed = rowCount ?? 0;
        if (removed > 0) {
          await audit(client, "share_link.photos_removed", {
            babyId: access.babyId,
            actorUserId: ctx.uid,
            shareLinkId: id,
            metadata: { count: removed },
          });
        }
        return { removed };
      });
    },
  });

  r.route({
    method: "PATCH",
    url: "/share-links/:id/photos/:photoId",
    schema: {
      params: shareLinkPhotoParamsSchema,
      body: shareLinkPhotoPatchRequestSchema,
      response: { 200: shareLinkPhotoSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id, photoId } = request.params;
      const { showSensitive } = request.body;
      const row = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireLinkAdmin(client, ctx.uid, id);
        const { rows: before } = await client.query<{ released: boolean; sensitive: boolean }>(
          `SELECT sp.sensitive_released_at IS NOT NULL AS released, p.is_sensitive AS sensitive
             FROM public.shared_photos sp JOIN public.photos p ON p.id = sp.photo_id
            WHERE sp.share_link_id = $1 AND sp.photo_id = $2 AND p.deleted_at IS NULL
            FOR UPDATE OF sp`,
          [id, photoId],
        );
        const current = before[0];
        if (!current) throw notInAlbum();
        // "Show to family" releases a sensitive photo for this link (attributed to the caller);
        // "Hide" withdraws the release. Either way the row becomes hand-picked. A non-sensitive
        // photo has nothing to release (the gate forces the pair to NULL).
        const changed = current.sensitive && current.released !== showSensitive;
        if (changed) {
          await client.query(
            `UPDATE public.shared_photos
                SET added_by = 'user', added_by_user_id = $3::uuid,
                    sensitive_released_at = CASE WHEN $4::boolean THEN now() END,
                    sensitive_released_by = CASE WHEN $4::boolean THEN $3::uuid END
              WHERE share_link_id = $1 AND photo_id = $2`,
            [id, photoId, ctx.uid, showSensitive],
          );
          await audit(
            client,
            showSensitive ? "share_link.sensitive_shown" : "share_link.sensitive_hidden",
            {
              babyId: access.babyId,
              actorUserId: ctx.uid,
              shareLinkId: id,
              metadata: { photo_id: photoId },
            },
          );
        }
        const { rows } = await client.query<AlbumPhotoRow>(
          `SELECT ${ALBUM_PHOTO_COLUMNS}
             FROM public.shared_photos sp
             JOIN public.photos p ON p.id = sp.photo_id
             ${PHOTO_THUMB_JOIN}
            WHERE sp.share_link_id = $1 AND sp.photo_id = $2`,
          [id, photoId],
        );
        const r0 = rows[0];
        if (!r0) throw notInAlbum();
        return r0;
      });
      return toAlbumPhoto(app.signer, row);
    },
  });

  r.route({
    method: "GET",
    url: "/photos/:id/share-links",
    schema: { params: idParamsSchema, response: { 200: photoShareLinksResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: photoId } = request.params;
      const links = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const { rows: photo } = await client.query<{ baby_id: string; is_sensitive: boolean }>(
          "SELECT baby_id, is_sensitive FROM public.photos WHERE id = $1 AND status <> 'duplicate'",
          [photoId],
        );
        const p = photo[0];
        if (!p) {
          throw new ApiError(
            404,
            "not_found",
            "That photo doesn't exist or you don't have access to it",
          );
        }
        await requireShareAdmin(client, ctx.uid, p.baby_id, { allowTrashed: true });
        const { rows } = await client.query<{
          id: string;
          name: string;
          status: "active" | "expired" | "revoked";
          added_by: string | null;
          released: boolean;
          excluded: boolean;
        }>(
          `SELECT l.id, l.name,
                  CASE WHEN l.revoked_at IS NOT NULL THEN 'revoked'
                       WHEN l.expires_at <= now() THEN 'expired' ELSE 'active' END AS status,
                  sp.added_by, (sp.sensitive_released_at IS NOT NULL) AS released,
                  (x.photo_id IS NOT NULL) AS excluded
             FROM public.share_links l
             LEFT JOIN public.shared_photos sp ON sp.share_link_id = l.id AND sp.photo_id = $1
             LEFT JOIN public.shared_photo_exclusions x ON x.share_link_id = l.id AND x.photo_id = $1
            WHERE l.baby_id = $2
            ORDER BY l.created_at DESC, l.id DESC`,
          [photoId, p.baby_id],
        );
        return rows.map((l) => {
          const shared = l.added_by !== null;
          const by = l.added_by === null ? null : sharedBy(l.added_by);
          return {
            shareLinkId: l.id,
            name: l.name,
            status: l.status,
            shared,
            sharedBy: by,
            hiddenFromViewers: shared && p.is_sensitive && !(by === "user" && l.released),
            excluded: l.excluded,
          };
        });
      });
      return { links };
    },
  });
}
