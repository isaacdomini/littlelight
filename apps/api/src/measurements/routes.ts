import {
  idParamsSchema,
  type MeasurementKind,
  type MeasurementUnit,
  measurementCreateSchema,
  measurementIdParamsSchema,
  measurementSchema,
  measurementsListQuerySchema,
  measurementsListResponseSchema,
  measurementUpdateSchema,
  measurementValueIssue,
  type ReindexJob,
  toMetric,
} from "@littlelight/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit, requireAuth, requireConsent, withClaims } from "../auth";
import { ApiError, forbidden, isPgError, notFound } from "../lib/errors";
import { babyAccess } from "../photos/queries";
import { enqueueReindexAll } from "../plugins/jobs";
import { MEASUREMENT_COLUMNS, type MeasurementRow, toMeasurement } from "./queries";

// `/babies/:id/measurements` and `/measurements/:id` (docs/plans/step-5.md 2.4, 2.7; PRD FR-3.3,
// FR-8.3). Storage is metric: the server normalizes `{value, unit}` with `toMetric` (grams or
// millimetres, 3 dp) and keeps what the parent typed in `value_entered`/`unit_entered`; clients
// never send a metric value. Authorization is Postgres RLS (members read; admins write); a write
// refused by RLS is explained as 404 (hidden) or 403 (admin-only). A linked photo must be a live
// photo of the same baby (`measurements_photo_same_baby` trigger ⇒ 409). Values and notes are
// never logged or audited (audit: id + kind). Changes to a linked photo's measurements send
// `photo.reindex` for it after commit.

const LIST_MAX = 2000;

const babyNotFound = () => notFound("That album doesn't exist or you don't have access to it");
const measurementNotFound = () =>
  notFound("That measurement doesn't exist or you don't have access to it");
const adminOnly = () => forbidden("Only an admin of this album can do that");

/** 400 `validation_failed` with a field path only (never the value). */
const invalidField = (path: string) =>
  new ApiError(400, "validation_failed", "The request is invalid", { fields: [`body.${path}`] });

const RETURNING_MEASUREMENT = `RETURNING ${MEASUREMENT_COLUMNS.replaceAll("ms.", "")}`;

/** Reindex jobs for the distinct non-null photo ids. */
function reindexJobs(babyId: string, photoIds: ReadonlyArray<string | null>): ReindexJob[] {
  return [...new Set(photoIds.filter((x): x is string => !!x))].map((photoId) => ({
    photoId,
    babyId,
    reason: "measurement" as const,
  }));
}

export function measurementsRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/babies/:id/measurements",
    schema: {
      params: idParamsSchema,
      querystring: measurementsListQuerySchema,
      response: { 200: measurementsListResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const { kind } = request.query;
      const rows = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        if (!(await babyAccess(client, ctx.uid, babyId))) throw babyNotFound();
        const values: unknown[] = [babyId];
        let byKind = "";
        if (kind) {
          values.push(kind);
          byKind = "AND ms.kind = $2";
        }
        values.push(LIST_MAX);
        const { rows } = await client.query<MeasurementRow>(
          `SELECT ${MEASUREMENT_COLUMNS} FROM public.measurements ms
            WHERE ms.baby_id = $1 ${byKind}
            ORDER BY ms.measured_at, ms.id
            LIMIT $${values.length}`,
          values,
        );
        return rows;
      });
      return { measurements: rows.map(toMeasurement) };
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/measurements",
    schema: {
      params: idParamsSchema,
      body: measurementCreateSchema,
      response: { 201: measurementSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId } = request.params;
      const body = request.body;
      // The schema already checked unit-for-kind and MEASUREMENT_LIMITS.
      const valueMetric = toMetric(body.kind, body.value, body.unit);
      const row = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        if (!(await babyAccess(client, ctx.uid, babyId))) throw babyNotFound();
        try {
          // RLS INSERT policy: admin of this baby, created_by = caller.
          const { rows } = await client.query<MeasurementRow>(
            `INSERT INTO public.measurements
               (baby_id, photo_id, kind, value_metric, value_entered, unit_entered, measured_at,
                note, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ${RETURNING_MEASUREMENT}`,
            [
              babyId,
              body.photoId ?? null,
              body.kind,
              valueMetric,
              body.value,
              body.unit,
              body.measuredAt,
              blankToNull(body.note),
              ctx.uid,
            ],
          );
          const created = rows[0];
          if (!created) throw adminOnly();
          await audit(client, "measurement.created", {
            babyId,
            actorUserId: ctx.uid,
            metadata: { measurement_id: created.id, kind: created.kind },
          });
          return created;
        } catch (err) {
          if (isPgError(err) && err.code === "42501") throw adminOnly();
          throw err;
        }
      });
      await enqueueReindexAll(app.jobs, reindexJobs(babyId, [row.photo_id]));
      return reply.code(201).send(toMeasurement(row));
    },
  });

  r.route({
    method: "PATCH",
    url: "/measurements/:id",
    schema: {
      params: measurementIdParamsSchema,
      body: measurementUpdateSchema,
      response: { 200: measurementSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const body = request.body;
      const result = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const { rows: current } = await client.query<MeasurementRow>(
          `SELECT ${MEASUREMENT_COLUMNS} FROM public.measurements ms WHERE ms.id = $1`,
          [id],
        );
        const before = current[0];
        if (!before) throw measurementNotFound();

        const sets: string[] = [];
        const values: unknown[] = [id];
        const set = (column: string, value: unknown) => {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        };
        if (body.value !== undefined && body.unit !== undefined) {
          // Re-normalize against the new kind, or the stored one (only the DB knows it).
          const kind: MeasurementKind = body.kind ?? before.kind;
          const unit: MeasurementUnit = body.unit;
          const issue = measurementValueIssue(kind, body.value, unit);
          if (issue) throw invalidField(issue.path);
          if (body.kind !== undefined) set("kind", body.kind);
          set("value_metric", toMetric(kind, body.value, unit));
          set("value_entered", body.value);
          set("unit_entered", unit);
        }
        if (body.measuredAt !== undefined) set("measured_at", body.measuredAt);
        if (body.photoId !== undefined) set("photo_id", body.photoId);
        if (body.note !== undefined) set("note", blankToNull(body.note));

        let updated: MeasurementRow | undefined;
        try {
          // RLS UPDATE policy: admin of the measurement's baby.
          const { rows } = await client.query<MeasurementRow>(
            `UPDATE public.measurements SET ${sets.join(", ")} WHERE id = $1
             ${RETURNING_MEASUREMENT}`,
            values,
          );
          updated = rows[0];
        } catch (err) {
          if (isPgError(err) && err.code === "42501") throw adminOnly();
          throw err;
        }
        // Visible (read above) but not updatable: not an admin of the baby.
        if (!updated) throw adminOnly();
        await audit(client, "measurement.updated", {
          babyId: updated.baby_id,
          actorUserId: ctx.uid,
          metadata: { measurement_id: id, kind: updated.kind },
        });
        return { updated, oldPhotoId: before.photo_id };
      });
      const { updated, oldPhotoId } = result;
      await enqueueReindexAll(
        app.jobs,
        reindexJobs(updated.baby_id, [oldPhotoId, updated.photo_id]),
      );
      return toMeasurement(updated);
    },
  });

  r.route({
    method: "DELETE",
    url: "/measurements/:id",
    schema: { params: measurementIdParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id } = request.params;
      const deleted = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        // RLS DELETE policy: admin of the measurement's baby.
        const { rows } = await client.query<{
          id: string;
          baby_id: string;
          photo_id: string | null;
          kind: MeasurementKind;
        }>("DELETE FROM public.measurements WHERE id = $1 RETURNING id, baby_id, photo_id, kind", [
          id,
        ]);
        const row = rows[0];
        if (!row) {
          const { rows: seen } = await client.query<{ id: string }>(
            "SELECT id FROM public.measurements WHERE id = $1",
            [id],
          );
          if (!seen[0]) throw measurementNotFound();
          throw adminOnly();
        }
        await audit(client, "measurement.deleted", {
          babyId: row.baby_id,
          actorUserId: ctx.uid,
          metadata: { measurement_id: id, kind: row.kind },
        });
        return row;
      });
      await enqueueReindexAll(app.jobs, reindexJobs(deleted.baby_id, [deleted.photo_id]));
      return reply.code(204).send();
    },
  });
}

/** An empty note is stored as NULL. */
function blankToNull(v: string | null | undefined): string | null {
  return v === undefined || v === null || v.trim() === "" ? null : v;
}
