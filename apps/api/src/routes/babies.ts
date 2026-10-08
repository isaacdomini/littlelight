import {
  type Baby,
  type BabyRole,
  type BabySummary,
  babiesListResponseSchema,
  babyCreateSchema,
  babySchema,
  babyUpdateSchema,
  idParamsSchema,
  type Plan,
} from "@littlelight/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  audit,
  requireAuth,
  requireConsent,
  requireFreshSignIn,
  type Tx,
  withClaims,
} from "../auth";
import { ApiError, forbidden, notFound } from "../lib/errors";

// `/babies` routes (docs/plans/step-3.md 2.4; PRD FR-1.2, FR-1.4, "Roles and permissions").
// Authorization is Postgres RLS (packages/db/migrations/1791520000200_identity.sql): a user sees
// only babies they are a member of, trashed ones only as admin, and only admins can UPDATE. The
// API never widens that; it only reads the caller's role after the fact to choose between 404
// (RLS shows no row) and 403 (visible, but the write matched nothing because the caller is not
// an admin). Every query names its columns (column-level grants: `SELECT *` on `babies` fails).
// Calendar dates leave Postgres as `YYYY-MM-DD` text (a JS Date would shift with the TZ).

const BABY_COLUMNS = `
  b.id, b.name, b.nickname, to_char(b.birth_date, 'YYYY-MM-DD') AS birth_date,
  b.birth_date_is_due_date, b.birth_weight_g, b.birth_length_mm, b.avatar_photo_id, b.plan,
  m.role, b.created_at, b.deleted_at`;

/** The caller's babies with their role; RLS filters out trashed babies for non-admins. */
const BABY_FROM = `
  FROM public.babies b
  JOIN public.baby_members m ON m.baby_id = b.id AND m.user_id = $1`;

interface BabyRow {
  id: string;
  name: string;
  nickname: string | null;
  birth_date: string;
  birth_date_is_due_date: boolean;
  birth_weight_g: number | null;
  birth_length_mm: number | null;
  avatar_photo_id: string | null;
  plan: Plan;
  role: BabyRole;
  created_at: Date;
  deleted_at: Date | null;
}

function toBaby(r: BabyRow): Baby {
  return {
    id: r.id,
    name: r.name,
    nickname: r.nickname,
    birthDate: r.birth_date,
    birthDateIsDueDate: r.birth_date_is_due_date,
    birthWeightG: r.birth_weight_g,
    birthLengthMm: r.birth_length_mm,
    avatarPhotoId: r.avatar_photo_id,
    plan: r.plan,
    role: r.role,
    createdAt: r.created_at.toISOString(),
    deletedAt: r.deleted_at?.toISOString() ?? null,
  };
}

/** Live babies of `uid` for `GET /me` and the header switcher, oldest first. */
export async function listBabySummaries(client: Tx, uid: string): Promise<BabySummary[]> {
  const { rows } = await client.query<BabyRow>(
    `SELECT ${BABY_COLUMNS} ${BABY_FROM} WHERE b.deleted_at IS NULL ORDER BY b.created_at, b.id`,
    [uid],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    nickname: r.nickname,
    birthDate: r.birth_date,
    plan: r.plan,
    role: r.role,
  }));
}

async function listBabies(client: Tx, uid: string): Promise<Baby[]> {
  const { rows } = await client.query<BabyRow>(
    `SELECT ${BABY_COLUMNS} ${BABY_FROM} ORDER BY b.created_at, b.id`,
    [uid],
  );
  return rows.map(toBaby);
}

/** One baby as the caller sees it, or null when RLS hides it (not a member, or trashed). */
async function findBaby(client: Tx, uid: string, babyId: string): Promise<Baby | null> {
  const { rows } = await client.query<BabyRow>(
    `SELECT ${BABY_COLUMNS} ${BABY_FROM} WHERE b.id = $2`,
    [uid, babyId],
  );
  const row = rows[0];
  return row ? toBaby(row) : null;
}

const babyNotFound = () => notFound("That album doesn't exist or you don't have access to it");
const notAdmin = () => forbidden("Only an admin of this album can do that");
const trashed = () => new ApiError(409, "conflict", "This album is in the trash");

/**
 * Updatable columns: API field → column. Plan/billing, owner, avatar and home location are not
 * here (billing is service_role-only; avatar and home arrive with photos in step 4/5).
 */
const UPDATABLE = {
  name: "name",
  nickname: "nickname",
  birthDate: "birth_date",
  birthDateIsDueDate: "birth_date_is_due_date",
  birthWeightG: "birth_weight_g",
  birthLengthMm: "birth_length_mm",
} as const satisfies Record<string, string>;

export function babiesRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/babies",
    schema: { response: { 200: babiesListResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) =>
      withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        return { babies: await listBabies(client, ctx.uid) };
      }),
  });

  r.route({
    method: "POST",
    url: "/babies",
    schema: { body: babyCreateSchema, response: { 201: babySchema } },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = request.body;
      const baby = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        // created_by = auth_uid() is required by the INSERT policy; the
        // babies_add_creator_admin trigger then makes the caller the first admin.
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO public.babies
             (name, nickname, birth_date, birth_date_is_due_date, birth_weight_g, birth_length_mm, created_by)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7)
           RETURNING id`,
          [
            body.name,
            body.nickname ?? null,
            body.birthDate,
            body.birthDateIsDueDate ?? false,
            body.birthWeightG ?? null,
            body.birthLengthMm ?? null,
            ctx.uid,
          ],
        );
        const id = rows[0]?.id;
        const created = id ? await findBaby(client, ctx.uid, id) : null;
        // Unreachable unless the creator-admin trigger is missing: fail rather than return a
        // baby the caller cannot see.
        if (!created) throw new ApiError(500, "internal", "Something went wrong");
        await audit(client, "baby.created", {
          babyId: created.id,
          actorUserId: ctx.uid,
          metadata: { role: created.role, client: request.auth?.clientKind ?? "web" },
        });
        return created;
      });
      return reply.code(201).send(baby);
    },
  });

  r.route({
    method: "GET",
    url: "/babies/:id",
    schema: { params: idParamsSchema, response: { 200: babySchema } },
    preHandler: requireAuth,
    handler: async (request) =>
      withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const baby = await findBaby(client, ctx.uid, request.params.id);
        if (!baby) throw babyNotFound();
        return baby;
      }),
  });

  r.route({
    method: "PATCH",
    url: "/babies/:id",
    schema: { params: idParamsSchema, body: babyUpdateSchema, response: { 200: babySchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id } = request.params;
      const body = request.body;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const sets: string[] = [];
        const values: unknown[] = [id];
        for (const [field, column] of Object.entries(UPDATABLE) as [
          keyof typeof UPDATABLE,
          string,
        ][]) {
          const value = body[field];
          if (value === undefined) continue;
          // `name` and `birthDate` are NOT NULL; the schema rejects null for them, but guard anyway.
          if (value === null && (field === "name" || field === "birthDate")) {
            throw new ApiError(400, "validation_failed", "The request is invalid", {
              fields: [`body.${field}`],
            });
          }
          values.push(field === "birthDateIsDueDate" ? (value ?? false) : value);
          sets.push(`${column} = $${values.length}${field === "birthDate" ? "::date" : ""}`);
        }
        // RLS: the UPDATE policy matches admins only; a contributor or non-member updates 0 rows.
        const { rowCount } = await client.query(
          `UPDATE public.babies SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`,
          values,
        );
        const baby = await findBaby(client, ctx.uid, id);
        if (!baby) throw babyNotFound();
        if (rowCount === 0) throw baby.role === "admin" ? trashed() : notAdmin();
        return baby;
      });
    },
  });

  r.route({
    method: "DELETE",
    url: "/babies/:id",
    schema: { params: idParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const baby = await findBaby(client, ctx.uid, id);
        if (!baby) throw babyNotFound();
        if (baby.role !== "admin") throw notAdmin();
        requireFreshSignIn(ctx);
        // Already in the trash: idempotent, nothing to record.
        if (baby.deletedAt !== null) return;
        // Soft delete; the worker's `purge.trash` job (step 4) hard-deletes after 30 days.
        const { rowCount } = await client.query(
          "UPDATE public.babies SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
          [id],
        );
        if (rowCount === 0) throw notAdmin();
        await audit(client, "baby.deleted", {
          babyId: id,
          actorUserId: ctx.uid,
          metadata: { client: request.auth?.clientKind ?? "web" },
        });
      });
      return reply.code(204).send();
    },
  });
}
