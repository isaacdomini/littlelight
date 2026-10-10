import {
  type DeletionPreviewResponse,
  deleteAccountRequestSchema,
  deletionPreviewResponseSchema,
} from "@littlelight/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { revokeGoogleConnection } from "../imports/google/connection";
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
//
// Ordering (docs/plans/review-fixes.md 2.8, D14): `profiles.deleted_at` is set before the GoTrue
// call and cleared again if it fails, so it is only left set by a deletion that happened;
// `account.deleted` is written only after GoTrue succeeded (`account.deletion_requested` records
// every attempt).
//
// Google Photos connection (docs/plans/step-10.md 2.8, task 10.10): between steps 2 and 3 the
// user's Google refresh token is revoked at Google (best effort) and the `google_accounts` row
// deleted, while the profile still exists; the row would cascade with the profile anyway. A failed
// revoke never blocks deletion, and only `{ revoked }` is logged (never the token or Google's
// answer). If GoTrue then fails, the connection stays removed: the user reconnects if they keep the
// account, which is the safe direction for a credential.

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
  // The co-admin's name comes from `member_profiles` (`profiles` is self-only for
  // `authenticated`, review-fixes D12); NULL when their own profile is mid-deletion.
  const { rows } = await client.query<{
    id: string;
    name: string;
    other_admin_name: string | null;
  }>(
    `SELECT b.id, b.name,
            (SELECT p.display_name
               FROM public.baby_members o
               JOIN public.member_profiles p ON p.user_id = o.user_id
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
    otherAdminName: r.other_admin_name?.trim() || "the other admin",
  }));
}

/** Whether the caller has a Google Photos connection (RLS: `authenticated` sees its own row). */
async function googlePhotosConnected(client: Tx, uid: string): Promise<boolean> {
  const { rows } = await client.query<{ connected: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM public.google_accounts WHERE user_id = $1) AS connected",
    [uid],
  );
  return rows[0]?.connected === true;
}

/**
 * D14 step 5: clear the pre-mark after a failed GoTrue delete. "gone" when no profile row exists
 * any more (the cascade ran, so the deletion actually happened); "failed" when the compensation
 * itself errored (logged; the profile stays marked until a later attempt either succeeds or
 * compensates).
 */
async function compensate(
  request: FastifyRequest,
  uid: string,
): Promise<"cleared" | "gone" | "failed"> {
  try {
    return await withServiceRole(
      request.server,
      "account deletion compensation",
      async (client) => {
        const { rowCount } = await client.query(
          "UPDATE public.profiles SET deleted_at = NULL WHERE user_id = $1",
          [uid],
        );
        return rowCount === 1 ? "cleared" : "gone";
      },
    );
  } catch (err) {
    request.log.error(
      { err: safeErrorLog(err) },
      "account deletion compensation failed; profile stays marked deleted",
    );
    return "failed";
  }
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
        googlePhotosConnected: await googlePhotosConnected(client, ctx.uid),
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

      // 1. Under the user's own claims: liveness, fresh sign-in, the sole-admin rule.
      await withClaims(request, async (client, ctx) => {
        requireFreshSignIn(ctx);
        const blocking = await blockingBabies(client, ctx.uid);
        if (blocking.length > 0) throw soleAdmin(blocking);
        await audit(client, "account.deletion_requested", {
          actorUserId: ctx.uid,
          metadata: { client: auth.clientKind },
        });
      });

      // 2. service_role: re-check (a co-admin may have left meanwhile) and pre-mark the profile,
      // so pushes and co-member visibility stop at once while GoTrue works (review-fixes D14).
      // Idempotent: a retry after a failed attempt keeps the existing mark. Returns whether the
      // profile row exists (every signed-in user has one; verify creates it): step 5 may only
      // infer "already deleted" from a missing row if it was here at this point.
      const hadProfile = await withServiceRole(
        request.server,
        "account deletion",
        async (client) => {
          const blocking = await blockingBabies(client, uid);
          if (blocking.length > 0) throw soleAdmin(blocking);
          const { rows } = await client.query<{ user_id: string }>(
            `UPDATE public.profiles SET deleted_at = COALESCE(deleted_at, now())
              WHERE user_id = $1
              RETURNING user_id`,
            [uid],
          );
          return rows.length === 1;
        },
      );

      // 2b. Revoke the Google Photos grant (if any) before the account goes. Never throws by
      // contract; the catch only guards that contract, so deletion is never blocked by Google.
      await revokeGoogleConnection(request.server, uid, request.log).catch(() => {
        request.log.warn({ revoked: false }, "google connection revoke skipped");
      });

      // 3. GoTrue hard delete: cascades sessions, identities, profile, memberships.
      try {
        await runtime.gotrue.adminDeleteUser(uid);
      } catch (err) {
        if (err instanceof GoTrueError) {
          request.log.error({ status: err.status, code: err.code }, "gotrue user delete failed");
        } else {
          request.log.error({ err: safeErrorLog(err) }, "gotrue user delete failed");
        }
        // 5. Compensation: nothing cascaded and the account is still live, so it must not stay
        // marked deleted (no pushes, hidden from co-members). If this fails too, the 503 still
        // stands and the next attempt's step 2 is idempotent.
        const outcome = await compensate(request, uid);
        if (outcome !== "gone" || !hadProfile) {
          // The session is still live; the user can retry within the fresh sign-in window. The
          // attempt stays recorded by step 1's `account.deletion_requested`.
          throw new ApiError(
            503,
            "internal",
            "Account deletion is temporarily unavailable, try again",
          );
        }
        // The profile row existed at step 2 and is gone now, which only GoTrue's `auth.users`
        // cascade does (nothing else deletes profiles): the delete went through despite the
        // error (a timeout, or a retry answered 404). Treat it as the success it was.
        request.log.warn("gotrue reported a failure but the user is deleted; treating as success");
      }

      // 4. Only now is the deletion real: record it. The profile is gone (actor NULL), so the
      // target goes in metadata. The account no longer exists whatever happens here, so a failed
      // audit write is logged and the request still succeeds (a 5xx would invite a retry that
      // can only fail with 401).
      try {
        await withServiceRole(request.server, "account deletion audit", async (client) => {
          await audit(client, "account.deleted", {
            actorUserId: null,
            metadata: { client: auth.clientKind, target_user_id: uid },
          });
        });
      } catch (auditErr) {
        request.log.error({ err: safeErrorLog(auditErr) }, "account.deleted audit write failed");
      }

      // 6. This browser's cookies are now dead tokens: drop them.
      if (auth.transport === "cookie") clearSessionCookies(reply, runtime.config);
      return reply.code(204).send();
    },
  });
}
