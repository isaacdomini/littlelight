import { createHash, randomBytes } from "node:crypto";
import {
  type BabyRole,
  babyInviteParamsSchema,
  canonicalEmail,
  INVITE_PATH,
  type Invite,
  type InviteLookupResponse,
  idParamsSchema,
  inviteAcceptResponseSchema,
  inviteCreateSchema,
  inviteEmailMismatchMessage,
  inviteLookupResponseSchema,
  inviteSchema,
  inviteTokenParamsSchema,
  maskEmail,
  normalizeEmail,
} from "@tinyglow/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { inviteEmail } from "../email/templates";
import { ApiError, forbidden, isPgError, notFound, rateLimited } from "../lib/errors";
import { clientIp } from "../lib/request";
import {
  audit,
  requireConsent,
  type Tx,
  type TxContext,
  withClaims,
  withServiceRole,
} from "./context";
import { requireAuth } from "./plugin";
import { isReviewEmail } from "./review";
import type { AuthRuntime } from "./runtime";

// Invites (PRD "Invites", FR-1.3, FR-1.6; docs/plans/step-3.md 2.4, 3.5).
//
// Token model: 32 random bytes, base64url (43 chars). Only `sha256(token)` is stored
// (`invites.token_hash`, a column no user role can read); the plaintext exists in the emailed
// link and in the `/invites/:token` path of the two public-facing routes, which the request
// logger redacts. No response body ever carries the token or its hash.
//
// Role boundaries: create/resend/revoke/list run as `authenticated` under the admin's claims
// (RLS: `invites_authenticated_*` policies need `is_baby_admin`). Lookup by token is the one
// `service_role` call site here (`token_hash` is invisible to users). Accepting re-enters
// `authenticated`: the insert into `baby_members` is authorised by the policy's invite branch
// (`invite_allows_join`: live invite, same lower-cased email, same role) and the step-2
// `baby_members_consume_invite` trigger marks the invite accepted, `baby_members_max_two_admins`
// raises `admins_full`. The API never re-implements those rules, only maps their errors.

export const INVITE_TOKEN_BYTES = 32;
export const INVITE_TTL_DAYS = 7;

/** New plaintext token (43-char base64url) and its sha256 for storage. */
export function newInviteToken(): { token: string; hash: Buffer } {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** `${PUBLIC_URL}/invite/${token}`; carries a bearer token, so only ever handed to the mailer. */
export function inviteAcceptUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${INVITE_PATH}/${token}`;
}

interface InviteRow {
  id: string;
  email: string;
  role: BabyRole;
  expires_at: Date;
  created_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

export function toInvite(row: InviteRow, now: Date = new Date()): Invite {
  let status: Invite["status"] = "pending";
  if (row.revoked_at) status = "revoked";
  else if (row.accepted_at) status = "accepted";
  else if (row.expires_at.getTime() <= now.getTime()) status = "expired";
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    status,
  };
}

const INVITE_COLUMNS = "id, email, role, expires_at, created_at, accepted_at, revoked_at";

const LIVE_INVITE_INDEX = "invites_one_live_per_email_idx";

/** The baby as the caller sees it (RLS: members only; admins also see trashed babies). */
async function loadBabyForAdmin(client: Tx, babyId: string): Promise<{ id: string; name: string }> {
  const { rows } = await client.query<{ id: string; name: string; deleted_at: Date | null }>(
    "SELECT id, name, deleted_at FROM public.babies WHERE id = $1",
    [babyId],
  );
  const baby = rows[0];
  if (!baby) throw notFound("No such album");
  const admin = await client.query<{ ok: boolean }>("SELECT public.is_baby_admin($1) AS ok", [
    babyId,
  ]);
  if (!admin.rows[0]?.ok) throw forbidden("Only an admin can manage invites");
  if (baby.deleted_at) throw new ApiError(409, "conflict", "This album is in the trash");
  return { id: baby.id, name: baby.name };
}

async function inviterName(client: Tx, ctx: Pick<TxContext, "uid">): Promise<string> {
  const { rows } = await client.query<{ display_name: string }>(
    "SELECT display_name FROM public.profiles WHERE user_id = $1",
    [ctx.uid],
  );
  const name = rows[0]?.display_name.trim();
  return name ? name : "A parent";
}

/**
 * Send the invite email inside the transaction that created or rotated the token, so a delivery
 * failure rolls the row back (no orphaned invite that then answers `invite_exists`). The mailer
 * has its own short timeouts; this holds one pooled connection for that long at most.
 */
async function deliverInvite(
  runtime: AuthRuntime,
  request: FastifyRequest,
  input: {
    to: string;
    babyName: string;
    inviterName: string;
    role: BabyRole;
    token: string;
    expiresAt: Date;
  },
): Promise<void> {
  const content = inviteEmail({
    babyName: input.babyName,
    inviterName: input.inviterName,
    role: input.role,
    acceptUrl: inviteAcceptUrl(runtime.config.PUBLIC_URL, input.token),
    expiresAt: input.expiresAt,
  });
  try {
    await runtime.mailer.send({ to: input.to, ...content });
  } catch {
    // The mailer already logged its safe category; never log the recipient or the link.
    request.log.warn("invite email not sent");
    throw new ApiError(503, "internal", "We couldn't send the invite email, try again shortly");
  }
}

export function inviteRoutes(app: FastifyInstance, runtime: AuthRuntime): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const lookupThrottle = runtime.throttles.inviteLookupPerIp;

  r.route({
    method: "POST",
    url: "/babies/:id/invites",
    schema: {
      params: idParamsSchema,
      body: inviteCreateSchema,
      response: { 201: inviteSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId } = request.params;
      const { email, role } = request.body;
      const invite = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const baby = await loadBabyForAdmin(client, babyId);

        // Membership by email: profiles hold no email, so "already a member" is the caller
        // themselves or someone who joined on an earlier invite to this address and is still in.
        // Canonical comparison (step 11, D9): `you+baby@gmail.com` is the caller's own inbox too.
        if (ctx.email && canonicalEmail(ctx.email) === canonicalEmail(email)) {
          throw new ApiError(409, "already_member", "That's your own email address");
        }
        const member = await client.query(
          `SELECT 1 FROM public.invites i
             JOIN public.baby_members m ON m.baby_id = i.baby_id AND m.user_id = i.accepted_by
            WHERE i.baby_id = $1 AND i.email = $2 AND i.accepted_at IS NOT NULL
            LIMIT 1`,
          [babyId, email],
        );
        if (member.rows.length > 0) {
          throw new ApiError(
            409,
            "already_member",
            "That person is already a member of this album",
          );
        }

        if (role === "admin") {
          const admins = await client.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM public.baby_members WHERE baby_id = $1 AND role = 'admin'",
            [babyId],
          );
          if ((admins.rows[0]?.n ?? 0) >= 2) {
            throw new ApiError(409, "admins_full", "This album already has two admins");
          }
        }

        // One live invite per (baby, email): a still-valid one is a duplicate; an expired one
        // that was never revoked is retired so a fresh link can go out.
        const live = await client.query<{ id: string; expires_at: Date }>(
          `SELECT id, expires_at FROM public.invites
            WHERE baby_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [babyId, email],
        );
        const existing = live.rows[0];
        if (existing) {
          if (existing.expires_at.getTime() > Date.now()) {
            throw new ApiError(409, "invite_exists", "An invite to that email is already pending");
          }
          await client.query("UPDATE public.invites SET revoked_at = now() WHERE id = $1", [
            existing.id,
          ]);
        }

        const { token, hash } = newInviteToken();
        let row: InviteRow;
        try {
          const inserted = await client.query<InviteRow>(
            `INSERT INTO public.invites (baby_id, email, role, token_hash, invited_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING ${INVITE_COLUMNS}`,
            [babyId, email, role, hash, ctx.uid],
          );
          row = inserted.rows[0] as InviteRow;
        } catch (err) {
          // Lost a race with a concurrent invite to the same address.
          if (isPgError(err) && err.code === "23505" && err.constraint === LIVE_INVITE_INDEX) {
            throw new ApiError(409, "invite_exists", "An invite to that email is already pending");
          }
          throw err;
        }

        await audit(client, "invite.sent", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { role, invite_id: row.id },
        });
        await deliverInvite(runtime, request, {
          to: row.email,
          babyName: baby.name,
          inviterName: await inviterName(client, ctx),
          role,
          token,
          expiresAt: row.expires_at,
        });
        return toInvite(row);
      });
      return reply.code(201).send(invite);
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/invites/:inviteId/resend",
    schema: { params: babyInviteParamsSchema, response: { 200: inviteSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId, inviteId } = request.params;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const baby = await loadBabyForAdmin(client, babyId);
        const { rows } = await client.query<InviteRow>(
          `SELECT ${INVITE_COLUMNS} FROM public.invites WHERE id = $1 AND baby_id = $2`,
          [inviteId, babyId],
        );
        const current = rows[0];
        if (!current) throw notFound("No such invite");
        if (current.revoked_at) {
          throw new ApiError(410, "invite_revoked", "This invite was revoked");
        }
        if (current.accepted_at) {
          throw new ApiError(410, "invite_accepted", "This invite was already accepted");
        }

        // Rotate: the old link stops working the moment this commits.
        const { token, hash } = newInviteToken();
        const updated = await client.query<InviteRow>(
          `UPDATE public.invites
              SET token_hash = $2, expires_at = now() + make_interval(days => $3)
            WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
            RETURNING ${INVITE_COLUMNS}`,
          [inviteId, hash, INVITE_TTL_DAYS],
        );
        const row = updated.rows[0];
        if (!row) throw notFound("No such invite");

        await audit(client, "invite.resent", {
          babyId,
          actorUserId: ctx.uid,
          metadata: { role: row.role, invite_id: row.id },
        });
        await deliverInvite(runtime, request, {
          to: row.email,
          babyName: baby.name,
          inviterName: await inviterName(client, ctx),
          role: row.role,
          token,
          expiresAt: row.expires_at,
        });
        return toInvite(row);
      });
    },
  });

  r.route({
    method: "DELETE",
    url: "/babies/:id/invites/:inviteId",
    schema: { params: babyInviteParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId, inviteId } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        // Revoking is allowed on a trashed baby too: only the admin check matters here.
        const admin = await client.query<{ ok: boolean }>("SELECT public.is_baby_admin($1) AS ok", [
          babyId,
        ]);
        const { rows } = await client.query<InviteRow>(
          `SELECT ${INVITE_COLUMNS} FROM public.invites WHERE id = $1 AND baby_id = $2`,
          [inviteId, babyId],
        );
        const current = rows[0];
        if (!current) throw notFound("No such invite");
        if (!admin.rows[0]?.ok) throw forbidden("Only an admin can revoke invites");
        if (current.accepted_at) {
          throw new ApiError(410, "invite_accepted", "This invite was already accepted");
        }
        if (!current.revoked_at) {
          await client.query("UPDATE public.invites SET revoked_at = now() WHERE id = $1", [
            inviteId,
          ]);
          await audit(client, "invite.revoked", {
            babyId,
            actorUserId: ctx.uid,
            metadata: { role: current.role, invite_id: current.id },
          });
        }
      });
      return reply.code(204).send();
    },
  });

  /** Public: what the invite page shows before sign-in. Never the email in full. */
  r.route({
    method: "GET",
    url: "/invites/:token",
    schema: { params: inviteTokenParamsSchema, response: { 200: inviteLookupResponseSchema } },
    handler: async (request): Promise<InviteLookupResponse> => {
      const hit = lookupThrottle.hit(clientIp(request));
      if (!hit.allowed) throw rateLimited(hit.retryAfterSec);
      const found = await lookupByToken(request.server, request.params.token);
      return {
        status: found.status,
        babyName: found.babyName,
        inviterName: found.inviterName,
        role: found.role,
        maskedEmail: maskEmail(found.email),
        expiresAt: found.expiresAt.toISOString(),
      };
    },
  });

  r.route({
    method: "POST",
    url: "/invites/:token/accept",
    schema: { params: inviteTokenParamsSchema, response: { 200: inviteAcceptResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const hit = lookupThrottle.hit(clientIp(request));
      if (!hit.allowed) throw rateLimited(hit.retryAfterSec);
      const found = await lookupByToken(request.server, request.params.token);
      switch (found.status) {
        case "expired":
          throw new ApiError(410, "invite_expired", "This invite has expired");
        case "revoked":
          throw new ApiError(410, "invite_revoked", "This invite was revoked");
        case "accepted":
          throw new ApiError(410, "invite_accepted", "This invite was already used");
        default:
          break;
      }

      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        // Case-insensitive match on the signed-in email (PRD "Invites"), or the same canonical
        // inbox (step 11, D9: an invite to `mom+baby@gmail.com` is accepted by `mom@gmail.com`,
        // the only account that inbox may have). The policy below checks the same thing in SQL
        // (`invite_allows_join`: exact lower-cased or `email_canonical` equal); this gives the
        // exact message.
        if (
          !ctx.email ||
          (normalizeEmail(ctx.email) !== found.email &&
            canonicalEmail(ctx.email) !== canonicalEmail(found.email))
        ) {
          throw new ApiError(403, "invite_email_mismatch", inviteEmailMismatchMessage(found.email));
        }
        // Store-review account (D4, review.ts): it signs in without proving its mailbox, so it
        // may never join a family; its sign-in guard allows only its synthetic review family.
        if (isReviewEmail(runtime.review, normalizeEmail(ctx.email))) {
          request.log.warn({ userId: ctx.uid }, "invite accept refused for the review account");
          throw forbidden("This account can't join a family");
        }
        const existing = await client.query<{ role: BabyRole }>(
          "SELECT role FROM public.baby_members WHERE baby_id = $1 AND user_id = $2",
          [found.babyId, ctx.uid],
        );
        if (existing.rows.length > 0) {
          throw new ApiError(409, "already_member", "You're already a member of this album");
        }
        try {
          // RLS invite branch + triggers: consume invite, max two admins (-> admins_full), one
          // family per parent (step 11, `baby_members_one_family`: an admin invite accepted by
          // an account that is a parent in another family -> 409 already_parent_elsewhere).
          await client.query(
            "INSERT INTO public.baby_members (baby_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)",
            [found.babyId, ctx.uid, found.role, found.invitedBy],
          );
        } catch (err) {
          // The invite died between the lookup and the insert (revoked/accepted concurrently):
          // the policy's invite branch no longer holds. Only that (42501) becomes
          // invite_expired; every trigger refusal (23514: admins_full, already_parent_elsewhere,
          // invite_expired from the consume trigger) is rethrown for the shared mapper.
          if (isPgError(err) && err.code === "42501") {
            throw new ApiError(410, "invite_expired", "This invite is no longer valid");
          }
          throw err;
        }
        await audit(client, "invite.accepted", {
          babyId: found.babyId,
          actorUserId: ctx.uid,
          metadata: { role: found.role, invite_id: found.id },
        });
        return { babyId: found.babyId, role: found.role };
      });
    },
  });
}

interface LookupResult {
  id: string;
  babyId: string;
  babyName: string;
  inviterName: string | null;
  invitedBy: string | null;
  role: BabyRole;
  email: string;
  expiresAt: Date;
  status: InviteLookupResponse["status"];
}

/**
 * Resolve a plaintext token to its invite. `service_role`: `token_hash` is readable by no user
 * role. Unknown hash, or a baby that is in the trash, is 404 `invite_not_found` (a trashed
 * album's name must not leak through an old link).
 */
async function lookupByToken(app: FastifyInstance, token: string): Promise<LookupResult> {
  const hash = hashInviteToken(token);
  const row = await withServiceRole(app, "invite lookup by token hash", async (client) => {
    const { rows } = await client.query<{
      id: string;
      baby_id: string;
      baby_name: string;
      baby_deleted_at: Date | null;
      inviter_name: string | null;
      invited_by: string | null;
      role: BabyRole;
      email: string;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT i.id, i.baby_id, b.name AS baby_name, b.deleted_at AS baby_deleted_at,
              p.display_name AS inviter_name, i.invited_by, i.role, i.email, i.expires_at,
              i.accepted_at, i.revoked_at
         FROM public.invites i
         JOIN public.babies b ON b.id = i.baby_id
         LEFT JOIN public.profiles p ON p.user_id = i.invited_by
        WHERE i.token_hash = $1`,
      [hash],
    );
    return rows[0];
  });
  if (!row || row.baby_deleted_at) {
    throw new ApiError(404, "invite_not_found", "This invite link isn't valid");
  }
  let status: LookupResult["status"] = "valid";
  if (row.revoked_at) status = "revoked";
  else if (row.accepted_at) status = "accepted";
  else if (row.expires_at.getTime() <= Date.now()) status = "expired";
  const inviter = row.inviter_name?.trim();
  return {
    id: row.id,
    babyId: row.baby_id,
    babyName: row.baby_name,
    inviterName: inviter ? inviter : null,
    invitedBy: row.invited_by,
    role: row.role,
    email: row.email,
    expiresAt: row.expires_at,
    status,
  };
}
