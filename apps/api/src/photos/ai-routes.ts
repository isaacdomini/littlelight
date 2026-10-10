import {
  AI_CONFLICT_MESSAGES,
  AI_PIPELINE_DEFAULTS,
  aiRetryResponseSchema,
  aiUsageQuerySchema,
  aiUsageResponseSchema,
  idParamsSchema,
  photoAiOverridePatchSchema,
  photoIdParamsSchema,
  photoSchema,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit, requireAuth, requireConsent, withClaims } from "../auth";
import { ApiError, isPgError } from "../lib/errors";
import {
  aiUsage,
  babyAiEnabled,
  clearOverride,
  overrideChanges,
  requestAiRetry,
  setOverride,
} from "./ai-queries";
import { babyAccess, photoEditable, photoWithRole, toAiStatus, visibleToCaller } from "./queries";
import {
  adminOnly,
  babyNotFound,
  detailsForbidden,
  loadPhoto,
  photoNotFound,
  toPhotoResponse,
} from "./routes";

// AI routes of the API (docs/plans/step-6.md 2.8; PRD FR-5.6 overrides, FR-5.8 paid tier only):
// `PATCH /photos/:id/ai` (parent overrides), `POST /photos/:id/ai/retry` (admin retry after
// failed attempts) and `GET /babies/:id/ai/usage` (admin cost/status overview). No model call,
// no provider key, no `withServiceRole`: every write is the caller's own override or retry flag
// under their claims, and RLS decides (`photo_editable` for overrides, the `photos` UPDATE
// policy for the retry flag). The API reads the caller's role only to pick between 404/403/409
// after RLS answered, and to keep the admin-only usage view admin-only. Override values are
// never logged or audited (audit metadata is `{photo_id, field}`; the PATCH body is redacted).

const conflict = (message: string) => new ApiError(409, "conflict", message);

/** First day of a UTC month `YYYY-MM`, or of the current UTC month. Exported for tests. */
export function usageMonth(month: string | undefined, now: Date = new Date()): string {
  return month ?? now.toISOString().slice(0, 7);
}

export function aiRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "PATCH",
    url: "/photos/:id/ai",
    schema: {
      params: photoIdParamsSchema,
      body: photoAiOverridePatchSchema,
      response: { 200: photoSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const changes = overrideChanges(request.body);
      const { loaded, changed } = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const photo = await photoWithRole(client, ctx.uid, id);
        if (!visibleToCaller(photo)) throw photoNotFound();
        // `photo_editable` is the policies' own rule (admins; uploaders of their own pending
        // photos, which never have AI data): asking it first gives a 403 before a 409.
        if (!(await photoEditable(client, id))) throw detailsForbidden(photo);
        // Overrides need a description (`ready` = a `photo_ai` row) of a Plus baby (FR-5.8).
        if (toAiStatus(photo.ai_status) !== "ready") {
          throw conflict(
            (await babyAiEnabled(client, photo.baby_id))
              ? AI_CONFLICT_MESSAGES.noDescription
              : AI_CONFLICT_MESSAGES.notAvailable,
          );
        }
        let any = false;
        try {
          for (const change of changes) {
            if (change.op === "set") {
              await setOverride(client, id, ctx.uid, change.field, change.value);
              await audit(client, "ai.override_updated", {
                babyId: photo.baby_id,
                actorUserId: ctx.uid,
                metadata: { photo_id: id, field: change.field },
              });
              any = true;
            } else if (await clearOverride(client, id, change.field)) {
              await audit(client, "ai.override_cleared", {
                babyId: photo.baby_id,
                actorUserId: ctx.uid,
                metadata: { photo_id: id, field: change.field },
              });
              any = true;
            }
          }
        } catch (err) {
          // RLS refused the write (the photo changed between the check and the write).
          if (isPgError(err) && err.code === "42501") throw detailsForbidden(photo);
          throw err;
        }
        return { loaded: await loadPhoto(client, ctx.uid, id), changed: any };
      });
      // After commit, outside runAs (step-4 rule). Overrides change the search document (FR-5.6).
      if (changed) {
        await app.jobs.enqueueReindex({
          photoId: loaded.photo.id,
          babyId: loaded.photo.baby_id,
          reason: "ai_override",
        });
      }
      return toPhotoResponse(app.signer, loaded);
    },
  });

  r.route({
    method: "POST",
    url: "/photos/:id/ai/retry",
    schema: { params: photoIdParamsSchema, response: { 200: aiRetryResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        // RLS (`photos_authenticated_update`) admits only admins' UPDATE here; the WHERE clause
        // only matches a live `ingested` photo whose derived status is `failed`.
        const babyId = await requestAiRetry(client, id);
        if (!babyId) {
          const photo = await photoWithRole(client, ctx.uid, id);
          if (!visibleToCaller(photo)) throw photoNotFound();
          if (photo.role !== "admin") throw adminOnly();
          throw conflict(
            (await babyAiEnabled(client, photo.baby_id))
              ? AI_CONFLICT_MESSAGES.notFailed
              : AI_CONFLICT_MESSAGES.notAvailable,
          );
        }
        await audit(client, "ai.retry_requested", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { photo_id: id },
        });
      });
      // No job is sent: the next `ai.flush` tick picks the photo up again (plan 2.8).
      return { status: "pending" as const };
    },
  });

  r.route({
    method: "GET",
    url: "/babies/:id/ai/usage",
    schema: {
      params: idParamsSchema,
      querystring: aiUsageQuerySchema,
      response: { 200: aiUsageResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const month = usageMonth(request.query.month);
      const usage = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await babyAccess(client, ctx.uid, babyId);
        if (!access) throw babyNotFound();
        if (access.role !== "admin") throw adminOnly();
        return aiUsage(client, babyId, `${month}-01`);
      });
      return {
        month,
        costUsd: usage.costUsd,
        budgetUsd:
          app.config.AI_BABY_MONTHLY_BUDGET_USD ?? AI_PIPELINE_DEFAULTS.AI_BABY_MONTHLY_BUDGET_USD,
        photos: usage.counts,
        lastCompletedAt: usage.lastCompletedAt?.toISOString() ?? null,
      };
    },
  });
}
