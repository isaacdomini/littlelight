import { z } from "zod";
import { emailSchema, maskEmail } from "../auth";
import { babyRoleSchema } from "../db-enums";
import { isoDateTimeSchema } from "./common";

// Invite contracts (docs/plans/step-3.md 2.4, 2.6; PRD "Invites"). The invite token (32 random
// bytes, base64url, 43 chars) appears only in the emailed link and in `/invites/:token` paths;
// no response ever contains it.

/** Length of an invite token: 32 bytes base64url without padding. */
export const INVITE_TOKEN_LENGTH = 43;
export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Route params of `GET /invites/:token` and `POST /invites/:token/accept`. */
export const inviteTokenParamsSchema = z.object({ token: inviteTokenSchema });
export type InviteTokenParams = z.infer<typeof inviteTokenParamsSchema>;

/** Route params of `/babies/:id/invites/:inviteId…`. */
export const babyInviteParamsSchema = z.object({ id: z.uuid(), inviteId: z.uuid() });
export type BabyInviteParams = z.infer<typeof babyInviteParamsSchema>;

/** `POST /babies/:id/invites` (admin) → 201 `invite`. The email is normalized by `emailSchema`. */
export const inviteCreateSchema = z.object({
  email: emailSchema,
  role: babyRoleSchema,
});
export type InviteCreate = z.infer<typeof inviteCreateSchema>;

export const inviteStatusSchema = z.enum(["pending", "accepted", "revoked", "expired"]);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

/** An invite as seen by the baby's admins (never includes the token or its hash). */
export const inviteSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: babyRoleSchema,
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  status: inviteStatusSchema,
});
export type Invite = z.infer<typeof inviteSchema>;

export const inviteLookupStatusSchema = z.enum(["valid", "expired", "revoked", "accepted"]);
export type InviteLookupStatus = z.infer<typeof inviteLookupStatusSchema>;

/** `GET /invites/:token` (public, rate-limited). Unknown token ⇒ 404 `invite_not_found`. */
export const inviteLookupResponseSchema = z.object({
  status: inviteLookupStatusSchema,
  babyName: z.string(),
  /** Inviter's display name; null when the inviter's account no longer exists. */
  inviterName: z.string().nullable(),
  role: babyRoleSchema,
  /** `maskEmail(invite.email)`. */
  maskedEmail: z.string(),
  expiresAt: isoDateTimeSchema,
});
export type InviteLookupResponse = z.infer<typeof inviteLookupResponseSchema>;

/** `POST /invites/:token/accept` → 200. */
export const inviteAcceptResponseSchema = z.object({
  babyId: z.uuid(),
  role: babyRoleSchema,
});
export type InviteAcceptResponse = z.infer<typeof inviteAcceptResponseSchema>;

/**
 * The exact 403 `invite_email_mismatch` message (PRD "Invites"):
 * `inviteEmailMismatchMessage('maria@gmail.com') === 'This invite was sent to m***@gmail.com'`.
 */
export function inviteEmailMismatchMessage(inviteEmail: string): string {
  return `This invite was sent to ${maskEmail(inviteEmail)}`;
}
