import {
  type BabyRole,
  babyMemberParamsSchema,
  idParamsSchema,
  MEMBER_REMOVAL_REQUEST_TTL_DAYS,
  type Member,
  type MembersListResponse,
  memberRoleUpdateSchema,
  memberSchema,
  membersListResponseSchema,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError, forbidden, notFound } from "../lib/errors";
import {
  audit,
  requireConsent,
  requireFreshSignIn,
  type Tx,
  withClaims,
  withServiceRole,
} from "./context";
import { toInvite } from "./invites";
import { requireAuth } from "./plugin";
import type { AuthRuntime } from "./runtime";

// Members (PRD "Roles and permissions", FR-1.3, FR-1.5, FR-1.6; docs/plans/step-3.md 2.4, 2.5,
// D4). Everything runs as `authenticated` under the caller's claims: RLS on `baby_members`
// decides what is visible (members only) and writable (admins; a member may delete their own
// row), the step-2 triggers enforce "max two admins" and "the last admin stays", and the
// step-3 `baby_members_release_plan` trigger returns the plan to free when the paying admin
// leaves, is removed, or steps down. The only `service_role` writes are the two removal-request
// columns, which no user role may touch (a self-writable row would let a member forge or clear
// a request).
//
// FR-1.5 "removing an admin requires the other admin's confirmation" (D4): an admin cannot
// remove, and cannot demote, the other admin directly. Removal is a request the target
// confirms (or declines) within MEMBER_REMOVAL_REQUEST_TTL_DAYS; demotion is self-service only
// (an admin may step down; demote-then-remove would otherwise bypass the confirmation).

interface MemberRow {
  user_id: string;
  display_name: string;
  relationship_label: string | null;
  role: BabyRole;
  joined_at: Date;
  removal_requested_by: string | null;
  removal_requested_at: Date | null;
}

// Co-member names come from `member_profiles` (review-fixes D12): `profiles` is self-only for
// `authenticated`. LEFT JOIN so a member whose profile is mid-deletion (`deleted_at` set, hidden
// by the view) still appears, with an empty name, until GoTrue's cascade removes the row.
const MEMBER_SELECT = `SELECT m.user_id, COALESCE(p.display_name, '') AS display_name,
         p.relationship_label, m.role, m.joined_at,
         m.removal_requested_by, m.removal_requested_at
    FROM public.baby_members m
    LEFT JOIN public.member_profiles p ON p.user_id = m.user_id
   WHERE m.baby_id = $1`;

/** A removal request is live for 7 days; older ones are reported (and treated) as absent. */
export function removalRequestLive(requestedAt: Date | null, now: Date = new Date()): boolean {
  if (!requestedAt) return false;
  return now.getTime() - requestedAt.getTime() <= MEMBER_REMOVAL_REQUEST_TTL_DAYS * 86_400_000;
}

export function toMember(row: MemberRow, now: Date = new Date()): Member {
  const live = removalRequestLive(row.removal_requested_at, now);
  return {
    userId: row.user_id,
    displayName: row.display_name,
    relationshipLabel: row.relationship_label,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
    removalRequestedBy: live ? row.removal_requested_by : null,
    removalRequestedAt:
      live && row.removal_requested_at ? row.removal_requested_at.toISOString() : null,
  };
}

/** All members of a baby as the caller sees them; empty (-> 404) unless the caller is a member. */
async function loadMembers(client: Tx, babyId: string): Promise<MemberRow[]> {
  const { rows } = await client.query<MemberRow>(
    `${MEMBER_SELECT} ORDER BY m.joined_at, m.user_id`,
    [babyId],
  );
  if (rows.length === 0) throw notFound("No such album");
  return rows;
}

function memberOf(rows: MemberRow[], userId: string): MemberRow | undefined {
  return rows.find((m) => m.user_id === userId);
}

function requireActorAdmin(rows: MemberRow[], uid: string): MemberRow {
  const actor = memberOf(rows, uid);
  if (actor?.role !== "admin") throw forbidden("Only an admin can do that");
  return actor;
}

const OTHER_ADMIN_DENIED = () =>
  forbidden(
    "An admin can't be demoted by someone else; ask them to step down or request their removal",
  );

/**
 * A role change or removal the `baby_members` policies refused (0 rows affected). The checks
 * above normally answer first; this covers a race (the target became an admin, or the actor
 * stopped being one) with the same 403 messages, never a 500 or a silent success.
 */
function policyDenied(target: MemberRow, actorUid: string): ApiError {
  if (target.role === "admin" && target.user_id !== actorUid) return OTHER_ADMIN_DENIED();
  return forbidden("Only an admin can do that");
}

export function memberRoutes(app: FastifyInstance, _runtime: AuthRuntime): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/babies/:id/members",
    schema: { params: idParamsSchema, response: { 200: membersListResponseSchema } },
    preHandler: requireAuth,
    handler: async (request): Promise<MembersListResponse> => {
      const { id: babyId } = request.params;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const rows = await loadMembers(client, babyId);
        const now = new Date();
        const members = rows.map((m) => toMember(m, now));
        // Pending invites are admin-only (the policy would also show a member an invite to
        // their own email; the list deliberately does not).
        if (memberOf(rows, ctx.uid)?.role !== "admin") return { members, invites: [] };
        const invites = await client.query<Parameters<typeof toInvite>[0]>(
          `SELECT id, email, role, expires_at, created_at, accepted_at, revoked_at
             FROM public.invites
            WHERE baby_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
            ORDER BY created_at, id`,
          [babyId],
        );
        return { members, invites: invites.rows.map((i) => toInvite(i, now)) };
      });
    },
  });

  r.route({
    method: "PATCH",
    url: "/babies/:id/members/:userId",
    schema: {
      params: babyMemberParamsSchema,
      body: memberRoleUpdateSchema,
      response: { 200: memberSchema },
    },
    preHandler: requireAuth,
    handler: async (request): Promise<Member> => {
      const { id: babyId, userId } = request.params;
      const { role } = request.body;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const rows = await loadMembers(client, babyId);
        requireActorAdmin(rows, ctx.uid);
        const target = memberOf(rows, userId);
        if (!target) throw notFound("No such member");
        if (target.role === role) return toMember(target);

        if (role !== "admin") {
          // Demotion: self only (see header). Losing admin is destructive -> fresh sign-in.
          if (userId !== ctx.uid) throw OTHER_ADMIN_DENIED();
          requireFreshSignIn(ctx);
        }

        // Triggers: max two admins -> 409 admins_full; last admin -> 409 last_admin; the paying
        // admin stepping down -> plan_owner_user_id cleared, plan back to free.
        const updatedRole = await client.query(
          "UPDATE public.baby_members SET role = $3 WHERE baby_id = $1 AND user_id = $2",
          [babyId, userId, role],
        );
        // The `baby_members_authenticated_update` policy (FR-1.5 at the database) makes a denied
        // UPDATE affect 0 rows instead of raising: surface it as the same 403, never a silent
        // success (review-fixes R4).
        if (updatedRole.rowCount !== 1) throw policyDenied(target, ctx.uid);
        await audit(client, "member.role_changed", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { target_user_id: userId, role },
        });
        const updated = await client.query<MemberRow>(`${MEMBER_SELECT} AND m.user_id = $2`, [
          babyId,
          userId,
        ]);
        const row = updated.rows[0];
        if (!row) throw notFound("No such member");
        return toMember(row);
      });
    },
  });

  r.route({
    method: "DELETE",
    url: "/babies/:id/members/:userId",
    schema: { params: babyMemberParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId, userId } = request.params;
      const outcome = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const rows = await loadMembers(client, babyId);
        const target = memberOf(rows, userId);

        if (userId === ctx.uid) {
          // Leave. Audit before the delete: once the row is gone the caller is no longer a
          // member and the audit_log insert policy would refuse the row.
          if (!target) throw notFound("No such member");
          requireFreshSignIn(ctx);
          await audit(client, "member.removed", {
            babyId,
            actorUserId: ctx.uid,
            metadata: { target_user_id: userId, role: target.role },
          });
          // Trigger: the last admin of a live baby cannot leave -> 409 last_admin.
          const left = await client.query(
            "DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
            [babyId, userId],
          );
          // A member may always delete their own row; 0 rows means it is already gone.
          if (left.rowCount !== 1) throw notFound("No such member");
          return "removed" as const;
        }

        requireActorAdmin(rows, ctx.uid);
        if (!target) throw notFound("No such member");

        if (target.role === "contributor") {
          await audit(client, "member.removed", {
            babyId,
            actorUserId: ctx.uid,
            metadata: { target_user_id: userId, role: target.role },
          });
          const removed = await client.query(
            "DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
            [babyId, userId],
          );
          // Policy: an admin may delete contributor rows only (0 rows if the target became an
          // admin meanwhile, or the actor lost admin): 403, never a silent success.
          if (removed.rowCount !== 1) throw policyDenied(target, ctx.uid);
          return "removed" as const;
        }

        // Co-admin: record a removal request the target must confirm (FR-1.5). Destructive
        // admin action -> fresh sign-in (PRD "Auth security requirements").
        requireFreshSignIn(ctx);
        await audit(client, "member.removal_requested", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { target_user_id: userId, role: target.role },
        });
        return "requested" as const;
      });

      if (outcome === "requested") {
        await withServiceRole(request.server, "co-admin removal request", async (client) => {
          const auth = request.auth;
          if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
          await client.query(
            `UPDATE public.baby_members
                SET removal_requested_by = $3, removal_requested_at = now()
              WHERE baby_id = $1 AND user_id = $2 AND role = 'admin'`,
            [babyId, userId, auth.uid],
          );
        });
        return reply.code(202).send();
      }
      return reply.code(204).send();
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/members/:userId/removal/confirm",
    schema: { params: babyMemberParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId, userId } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        if (userId !== ctx.uid) throw forbidden("Only the member being removed can confirm");
        const rows = await loadMembers(client, babyId);
        const me = memberOf(rows, ctx.uid);
        if (!me) throw notFound("No such member");
        if (!removalRequestLive(me.removal_requested_at)) {
          throw notFound("There is no pending removal request for you");
        }
        requireFreshSignIn(ctx);
        await audit(client, "member.removed", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { target_user_id: userId, role: me.role },
        });
        // Still subject to the last-admin trigger (409 last_admin if the requester left since).
        const confirmed = await client.query(
          "DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
          [babyId, userId],
        );
        if (confirmed.rowCount !== 1) throw notFound("No such member");
      });
      return reply.code(204).send();
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/members/:userId/removal/decline",
    schema: { params: babyMemberParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId, userId } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const rows = await loadMembers(client, babyId);
        const target = memberOf(rows, userId);
        if (!target) throw notFound("No such member");
        if (userId !== ctx.uid) requireActorAdmin(rows, ctx.uid);
        if (!removalRequestLive(target.removal_requested_at)) {
          throw notFound("There is no pending removal request");
        }
      });
      await withServiceRole(request.server, "co-admin removal request", async (client) => {
        await client.query(
          `UPDATE public.baby_members
              SET removal_requested_by = NULL, removal_requested_at = NULL
            WHERE baby_id = $1 AND user_id = $2`,
          [babyId, userId],
        );
      });
      return reply.code(204).send();
    },
  });
}
