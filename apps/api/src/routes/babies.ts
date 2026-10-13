import {
  type Baby,
  type BabyRole,
  type BabySummary,
  babiesListResponseSchema,
  babyCreateSchema,
  babySchema,
  babyUpdateSchema,
  FREE_TIER_PHOTO_LIMIT,
  FREE_TIER_VIDEO_LIMIT,
  type FreeTier,
  idParamsSchema,
  type Plan,
} from "@tinyglow/shared";
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
import {
  callerFamilyId,
  familyHolderEmailHint,
  familyStartGuards,
  recordFamilyStart,
  releaseFamilyStart,
} from "../auth/family-guards";
import {
  ApiError,
  forbidden,
  inboxHasFamily,
  isPgError,
  notFound,
  safeErrorLog,
} from "../lib/errors";
import { clientCountry, clientIp, clientKind } from "../lib/request";

// `/babies` routes (docs/plans/step-3.md 2.4; PRD FR-1.2, FR-1.4, "Roles and permissions").
// Authorization is Postgres RLS (packages/db/migrations/1791520000200_identity.sql): a user sees
// only babies they are a member of, trashed ones only as admin, and only admins can UPDATE. The
// API never widens that; it only reads the caller's role after the fact to choose between 404
// (RLS shows no row) and 403 (visible, but the write matched nothing because the caller is not
// an admin). Every query names its columns (column-level grants: `SELECT *` on `babies` fails).
// Calendar dates leave Postgres as `YYYY-MM-DD` text (a JS Date would shift with the TZ).

const SUMMARY_COLUMNS = `
  b.id, b.name, b.nickname, to_char(b.birth_date, 'YYYY-MM-DD') AS birth_date,
  b.birth_date_is_due_date, b.birth_weight_g, b.birth_length_mm, b.avatar_photo_id, b.plan,
  m.role, b.created_at, b.deleted_at`;

/**
 * Full `Baby` columns: the summary plus the free-tier pool (docs/plans/step-11.md 2.2 B, 2.5).
 * The two SECURITY DEFINER functions count the approved photos and the free, live albums of the
 * album's family (member-gated: the caller is a member of every row RLS shows). NULL for Plus or
 * trashed albums. `GET /me` (`listBabySummaries`) does not pay for the count.
 */
const BABY_COLUMNS = `${SUMMARY_COLUMNS},
  CASE WHEN b.plan = 'free' AND b.deleted_at IS NULL
       THEN public.free_tier_pool_used(b.id) END AS pool_used,
  CASE WHEN b.plan = 'free' AND b.deleted_at IS NULL
       THEN public.free_tier_pool_albums(b.id) END AS pool_albums,
  CASE WHEN b.plan = 'free' AND b.deleted_at IS NULL
       THEN public.free_tier_pool_videos(b.id) END AS pool_videos,
  public.free_tier_video_limit() AS video_limit`;

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
  /** Only in `BABY_COLUMNS` queries; null for Plus or trashed albums. */
  pool_used?: number | null;
  pool_albums?: number | null;
  /** Step 12 (Q3): live videos in the family's pool and the effective `free_tier_video_limit()`. */
  pool_videos?: number | null;
  video_limit?: number | null;
}

/** The pool numbers of a free, live album; `null` for Plus or trashed ones. */
function toFreeTier(r: BabyRow): FreeTier | null {
  if (r.plan !== "free" || r.deleted_at !== null) return null;
  return {
    used: Math.max(0, r.pool_used ?? 0),
    limit: FREE_TIER_PHOTO_LIMIT,
    // ≥ 1: this album is in its family's pool (the function answers 0 only for a non-member).
    familyAlbums: Math.max(1, r.pool_albums ?? 1),
    videos: Math.max(0, r.pool_videos ?? 0),
    videoLimit: Math.max(1, r.video_limit ?? FREE_TIER_VIDEO_LIMIT),
  };
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
    freeTier: toFreeTier(r),
  };
}

/** Live babies of `uid` for `GET /me` and the header switcher, oldest first. */
export async function listBabySummaries(client: Tx, uid: string): Promise<BabySummary[]> {
  const { rows } = await client.query<BabyRow>(
    `SELECT ${SUMMARY_COLUMNS} ${BABY_FROM} WHERE b.deleted_at IS NULL ORDER BY b.created_at, b.id`,
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
      const app = request.server;
      const email = request.auth?.email ?? null;
      const client = clientKind(request);

      // Family start (docs/plans/step-11.md 2.1, 2.5, D-J): a caller who is a parent nowhere
      // starts a family with this album, so the abuse checks run first, as service_role and
      // outside the insert transaction (they read other accounts' rows). Later albums join the
      // caller's family (`babies_set_family`) with no check.
      const before = await withClaims(request, async (tx, ctx) => {
        await requireConsent(tx, ctx);
        return { familyId: await callerFamilyId(tx), uid: ctx.uid };
      });
      const familyStart = before.familyId === null;
      let guards: Awaited<ReturnType<typeof familyStartGuards>> | null = null;
      if (familyStart) {
        const { blocklist, abuse } = app.authRuntime;
        try {
          guards = await familyStartGuards(app, blocklist, abuse.FAMILIES_PER_IP_PER_DAY, {
            email,
            // Hashed inside the guards; never logged, never stored raw.
            ip: clientIp(request),
            country: clientCountry(request),
            client,
            userId: before.uid,
          });
        } catch (err) {
          if (err instanceof ApiError) request.log.info({ outcome: err.code }, "family start");
          throw err;
        }
      }
      // The guards reserved a ledger row (hard per-network cap); drop it when no family was
      // started after all. Best effort: a leftover reservation only counts against the network.
      const releaseReservation = async () => {
        if (!guards) return;
        try {
          await releaseFamilyStart(app, guards.reservationId);
        } catch (err) {
          request.log.warn({ err: safeErrorLog(err) }, "family-start reservation not released");
        }
      };

      let created: { baby: Baby; startedFamilyId: string | null; uid: string };
      try {
        created = await withClaims(request, async (tx, ctx) => {
          await requireConsent(tx, ctx);
          // created_by = auth_uid() is required by the INSERT policy; `babies_set_family` puts
          // the album in the caller's family (or a new one), then `babies_add_creator_admin`
          // makes the caller its first admin.
          const { rows } = await tx.query<{ id: string }>(
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
          const baby = id ? await findBaby(tx, ctx.uid, id) : null;
          // Unreachable unless the creator-admin trigger is missing: fail rather than return a
          // baby the caller cannot see.
          if (!baby) throw new ApiError(500, "internal", "Something went wrong");
          // Did this insert found the family? `families.created_at` defaults to now(), the
          // transaction start: equal only for a row created in this transaction. Exact even when
          // two first albums of one caller race (the second joins the first one's family).
          let startedFamilyId: string | null = null;
          if (familyStart) {
            const fam = await tx.query<{ family_id: string; fresh: boolean }>(
              `SELECT b.family_id, (f.created_at = now()) AS fresh
                 FROM public.babies b JOIN public.families f ON f.id = b.family_id
                WHERE b.id = $1`,
              [baby.id],
            );
            const row = fam.rows[0];
            startedFamilyId = row?.fresh ? row.family_id : null;
          }
          await audit(tx, "baby.created", {
            babyId: baby.id,
            actorUserId: ctx.uid,
            metadata: {
              role: baby.role,
              client: request.auth?.clientKind ?? "web",
              ...(startedFamilyId ? { family_start: true } : {}),
            },
          });
          return { baby, startedFamilyId, uid: ctx.uid };
        });
      } catch (err) {
        await releaseReservation();
        // `babies_set_family` inbox arbiter (D-B): another account for this inbox is already a
        // parent. Add the masked hint here; the generic mapper has none.
        if (
          isPgError(err) &&
          err.code === "23514" &&
          err.message.startsWith("another account for this inbox")
        ) {
          request.log.info({ outcome: "inbox_has_family" }, "family start");
          const hint = email ? await familyHolderEmailHint(app, email).catch(() => null) : null;
          throw inboxHasFamily(hint);
        }
        throw err;
      }

      if (guards && created.startedFamilyId) {
        try {
          await recordFamilyStart(app, {
            reservationId: guards.reservationId,
            familyId: created.startedFamilyId,
          });
          request.log.info({ outcome: "started" }, "family start");
        } catch (err) {
          // The album exists; the reservation stays (family_id NULL) and still counts.
          request.log.warn({ err: safeErrorLog(err) }, "family-start ledger row not filled");
        }
      } else {
        // A concurrent first album of this account started the family: this one joined it.
        await releaseReservation();
      }
      return reply.code(201).send(created.baby);
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
