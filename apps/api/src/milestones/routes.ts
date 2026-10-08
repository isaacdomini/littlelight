import {
  idParamsSchema,
  type MilestoneCreate,
  milestoneCreateSchema,
  milestoneIdParamsSchema,
  milestoneSchema,
  milestonesListResponseSchema,
  milestoneUpdateSchema,
  type ReindexJob,
} from "@littlelight/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit, requireAuth, requireConsent, type Tx, withClaims } from "../auth";
import { forbidden, isPgError, notFound } from "../lib/errors";
import { babyAccess } from "../photos/queries";
import { enqueueReindexAll } from "../plugins/jobs";
import {
  loadMilestones,
  MILESTONE_REINDEX_MAX,
  type MilestoneRow,
  taggedPhotoIds,
  toMilestone,
} from "./queries";

// `/babies/:id/milestones` and `/milestones/:id` (docs/plans/step-5.md 2.4, D7; PRD FR-3.2,
// FR-8.2). Authorization is Postgres RLS: presets (`baby_id IS NULL`) can never be updated or
// deleted by any user role, custom milestones are admin-only to create/rename/delete. A write
// that matched nothing is explained afterwards (404 hidden, 403 preset, 403 admin-only); the role
// is read only to pick the message. Duplicate names (incl. a preset's name, raised by
// `milestones_name_guard` on the same constraint) map to 409 in `lib/errors.ts`; the 200-per-baby
// cap (`milestones_cap`) to 409. Names are never logged or audited. After a rename or delete the
// tagged photos' search documents are stale: `photo.reindex` is sent after commit (<= 500; step
// 7's reconcile covers the rest).

const babyNotFound = () => notFound("That album doesn't exist or you don't have access to it");
const milestoneNotFound = () =>
  notFound("That milestone doesn't exist or you don't have access to it");
const adminOnly = () => forbidden("Only an admin of this album can do that");
const presetImmutable = () => forbidden("Preset milestones can't be changed");

const RETURNING_MILESTONE = "RETURNING id, baby_id";

/** Explain an UPDATE/DELETE on `milestones` that matched no row. */
async function explainNoMilestone(client: Tx, id: string): Promise<never> {
  const { rows } = await client.query<{ baby_id: string | null }>(
    "SELECT baby_id FROM public.milestones WHERE id = $1",
    [id],
  );
  const m = rows[0];
  if (!m) throw milestoneNotFound();
  if (m.baby_id === null) throw presetImmutable();
  throw adminOnly();
}

/** Reindex jobs for photos tagged with a milestone, warning (ids only) above the cap. */
function reindexJobsFor(
  log: FastifyBaseLogger,
  milestoneId: string,
  tagged: ReadonlyArray<{ photo_id: string; baby_id: string }>,
): ReindexJob[] {
  if (tagged.length > MILESTONE_REINDEX_MAX) {
    log.warn(
      { milestoneId, max: MILESTONE_REINDEX_MAX },
      "milestone reindex capped; the search reconcile covers the rest",
    );
  }
  return tagged.slice(0, MILESTONE_REINDEX_MAX).map((t) => ({
    photoId: t.photo_id,
    babyId: t.baby_id,
    reason: "milestone" as const,
  }));
}

export function milestonesRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/babies/:id/milestones",
    schema: { params: idParamsSchema, response: { 200: milestonesListResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const loaded = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        if (!(await babyAccess(client, ctx.uid, babyId))) throw babyNotFound();
        return loadMilestones(client, babyId);
      });
      return {
        milestones: await Promise.all(
          loaded.rows.map((m) => toMilestone(app.signer, m, loaded.covers)),
        ),
      };
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/milestones",
    schema: {
      params: idParamsSchema,
      body: milestoneCreateSchema,
      response: { 201: milestoneSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId } = request.params;
      const body: MilestoneCreate = request.body;
      const row = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        if (!(await babyAccess(client, ctx.uid, babyId))) throw babyNotFound();
        let created: { id: string } | undefined;
        try {
          // RLS INSERT policy: an admin of this baby, created_by = caller.
          const { rows } = await client.query<{ id: string; baby_id: string }>(
            `INSERT INTO public.milestones (baby_id, name, category, created_by)
             VALUES ($1, $2, $3, $4) ${RETURNING_MILESTONE}`,
            [babyId, body.name, body.category, ctx.uid],
          );
          created = rows[0];
        } catch (err) {
          if (isPgError(err) && err.code === "42501") throw adminOnly();
          throw err;
        }
        if (!created) throw adminOnly();
        await audit(client, "milestone.created", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { milestone_id: created.id },
        });
        return loadMilestones(client, babyId, created.id);
      });
      const m = row.rows[0] as MilestoneRow;
      return reply.code(201).send(await toMilestone(app.signer, m, row.covers));
    },
  });

  r.route({
    method: "PATCH",
    url: "/milestones/:id",
    schema: {
      params: milestoneIdParamsSchema,
      body: milestoneUpdateSchema,
      response: { 200: milestoneSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const { name, category } = request.body;
      const result = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const sets: string[] = [];
        const values: unknown[] = [id];
        if (name !== undefined) {
          values.push(name);
          sets.push(`name = $${values.length}`);
        }
        if (category !== undefined) {
          values.push(category);
          sets.push(`category = $${values.length}`);
        }
        let updated: { id: string; baby_id: string | null } | undefined;
        try {
          // RLS UPDATE policy: custom (baby_id IS NOT NULL) and admin of that baby.
          const { rows } = await client.query<{ id: string; baby_id: string | null }>(
            `UPDATE public.milestones SET ${sets.join(", ")} WHERE id = $1 ${RETURNING_MILESTONE}`,
            values,
          );
          updated = rows[0];
        } catch (err) {
          if (isPgError(err) && err.code === "42501") throw adminOnly();
          throw err;
        }
        if (!updated?.baby_id) return explainNoMilestone(client, id);
        const babyId = updated.baby_id;
        await audit(client, "milestone.updated", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { milestone_id: id },
        });
        const loaded = await loadMilestones(client, babyId, id);
        const tagged = await taggedPhotoIds(client, id);
        return { loaded, tagged };
      });
      await enqueueReindexAll(app.jobs, reindexJobsFor(request.log, id, result.tagged));
      const m = result.loaded.rows[0] as MilestoneRow;
      return toMilestone(app.signer, m, result.loaded.covers);
    },
  });

  r.route({
    method: "DELETE",
    url: "/milestones/:id",
    schema: { params: milestoneIdParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id } = request.params;
      const tagged = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        // Collected before the delete: the FK then sets photo_details.milestone_id to NULL.
        const before = await taggedPhotoIds(client, id);
        const { rows } = await client.query<{ id: string; baby_id: string | null }>(
          `DELETE FROM public.milestones WHERE id = $1 ${RETURNING_MILESTONE}`,
          [id],
        );
        const deleted = rows[0];
        if (!deleted?.baby_id) return explainNoMilestone(client, id);
        await audit(client, "milestone.deleted", {
          babyId: deleted.baby_id,
          actorUserId: ctx.uid,
          metadata: { milestone_id: id },
        });
        return before;
      });
      await enqueueReindexAll(app.jobs, reindexJobsFor(request.log, id, tagged));
      return reply.code(204).send();
    },
  });
}
