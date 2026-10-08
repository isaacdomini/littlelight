import {
  type DeletionPreviewResponse,
  deleteAccountRequestSchema,
  deletionPreviewResponseSchema,
} from "@littlelight/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError, safeErrorLog } from "../lib/errors";
import { audit, requireFreshSignIn, type Tx, withClaims, withServiceRole } from "./context";
import { GoTrueError } from "./gotrue";
import { requireAuth } from "./plugin";
import type { AuthRuntime } from "./runtime";
import { clearSessionCookies } from "./session";

// Account deletion (PRD "Account deletion and recovery", FR-10.3; docs/plans/step-3.md 2.4,
// 2.7, D6). Real deletion, not a hide flag: GoTrue hard-deletes `auth.users`, which cascades
// `auth.sessions` (every device is signed out at once: the next request on any of them fails
// the `auth_session_info` liveness check), `auth.identities`, `public.profiles` and from there
// `baby_members` and the user's chat; `babies.plan_owner_user_id`, `photos.uploaded_by` and the
// other author columns become NULL, so a remaining admin keeps the album and its photos and the
// plan reverts to free by trigger. Albums the user trashed are purged by the worker's
// `purge.trash` job (step 4) within the PRD's 30-day window.
//
// Sole-admin rule: a live baby whose only admin is this user blocks deletion (409 `sole_admin`);
// the user deletes that album or promotes a co-admin first. The same rule is enforced one level
// down by the `baby_members_keep_last_admin` trigger, which would make GoTrue's cascade fail.

interface BabyRef {
  id: string;
  name: string;
}

/** Live babies where the caller is the only admin (RLS: the caller sees only their babies). */
async function blockingBabies(client: Tx, uid: string): Promise<BabyRef[]> {
  const { rows } = await client.query<BabyRef>(
    `SELECT b.id, b.name
       FROM public.babies b
       JOIN public.baby_members me ON me.baby_id = b.id AND me.user_id = $1 AND me.role = 'admin'
      WHERE b.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.baby_members o
           WHERE o.baby_id = b.id AND o.role = 'admin' AND o.user_id <> me.user_id)
      ORDER BY b.created_at, b.id`,
    [uid],
  );
  return rows;
}

/** Live babies that stay with another admin after the caller is gone. */
async function keptBabies(client: Tx, uid: string): Promise<DeletionPreviewResponse["babiesKept"]> {
  const { rows } = await client.query<{ id: string; name: string; other_admin_name: string }>(
    `SELECT b.id, b.name,
            (SELECT p.display_name
               FROM public.baby_members o
               JOIN public.profiles p ON p.user_id = o.user_id
              WHERE o.baby_id = b.id AND o.role = 'admin' AND o.user_id <> me.user_id
              ORDER BY o.joined_at, o.user_id
              LIMIT 1) AS other_admin_name
       FROM public.babies b
       JOIN public.baby_members me ON me.baby_id = b.id AND me.user_id = $1
      WHERE b.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM public.baby_members o
           WHERE o.baby_id = b.id AND o.role = 'admin' AND o.user_id <> me.user_id)
      ORDER BY b.created_at, b.id`,
    [uid],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    otherAdminName: r.other_admin_name.trim() || "the other admin",
  }));
}

function soleAdmin(babies: BabyRef[]): ApiError {
  return new ApiError(409, "sole_admin", "Delete that album or promote a co-admin first", {
    babies,
  });
}

export function accountRoutes(app: FastifyInstance, runtime: AuthRuntime): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/me/deletion-preview",
    schema: { response: { 200: deletionPreviewResponseSchema } },
    preHandler: requireAuth,
    handler: async (request): Promise<DeletionPreviewResponse> =>
      withClaims(request, async (client, ctx) => ({
        blockingBabies: await blockingBabies(client, ctx.uid),
        babiesKept: await keptBabies(client, ctx.uid),
        freshSignIn: ctx.isFresh,
      })),
  });

  r.route({
    method: "DELETE",
    url: "/me",
    schema: { body: deleteAccountRequestSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
      const uid = auth.uid;

      // 1-2. Under the user's own claims: liveness, fresh sign-in, the sole-admin rule.
      await withClaims(request, async (client, ctx) => {
        requireFreshSignIn(ctx);
        const blocking = await blockingBabies(client, ctx.uid);
        if (blocking.length > 0) throw soleAdmin(blocking);
        await audit(client, "account.deletion_requested", {
          actorUserId: ctx.uid,
          metadata: { client: auth.clientKind },
        });
      });

      // 3-5. One service_role transaction: re-check (a co-admin may have left meanwhile), the
      // final audit row (actor becomes NULL after the cascade), mark the profile, commit.
      await withServiceRole(request.server, "account deletion", async (client) => {
        const blocking = await blockingBabies(client, uid);
        if (blocking.length > 0) throw soleAdmin(blocking);
        await audit(client, "account.deleted", {
          actorUserId: uid,
          metadata: { client: auth.clientKind },
        });
        await client.query(
          "UPDATE public.profiles SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL",
          [uid],
        );
      });

      // 6. GoTrue hard delete: cascades sessions, identities, profile, memberships.
      try {
        await runtime.gotrue.adminDeleteUser(uid);
      } catch (err) {
        if (err instanceof GoTrueError) {
          request.log.error({ status: err.status, code: err.code }, "gotrue user delete failed");
        } else {
          request.log.error({ err: safeErrorLog(err) }, "gotrue user delete failed");
        }
        // The session is still live (nothing cascaded); the user can retry within the fresh
        // sign-in window. The profile's deleted_at stays set as a record of the attempt.
        throw new ApiError(
          503,
          "internal",
          "Account deletion is temporarily unavailable, try again",
        );
      }

      // 7. This browser's cookies are now dead tokens: drop them.
      if (auth.transport === "cookie") clearSessionCookies(reply, runtime.config);
      return reply.code(204).send();
    },
  });
}
