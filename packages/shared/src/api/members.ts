import { z } from "zod";
import { babyRoleSchema } from "../db-enums";
import { isoDateTimeSchema } from "./common";
import { inviteSchema } from "./invites";

// Member contracts (docs/plans/step-3.md 2.4, 2.6; PRD FR-1.3-FR-1.6). Removing a co-admin is a
// request the target confirms (D4); a request older than MEMBER_REMOVAL_REQUEST_TTL_DAYS is
// reported as null.

/** Route params of `/babies/:id/members/:userId…`. */
export const babyMemberParamsSchema = z.object({ id: z.uuid(), userId: z.uuid() });
export type BabyMemberParams = z.infer<typeof babyMemberParamsSchema>;

export const memberSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  relationshipLabel: z.string().nullable(),
  role: babyRoleSchema,
  joinedAt: isoDateTimeSchema,
  removalRequestedBy: z.uuid().nullable(),
  removalRequestedAt: isoDateTimeSchema.nullable(),
});
export type Member = z.infer<typeof memberSchema>;

/** `PATCH /babies/:id/members/:userId` (admin) → `member`. */
export const memberRoleUpdateSchema = z.object({ role: babyRoleSchema });
export type MemberRoleUpdate = z.infer<typeof memberRoleUpdateSchema>;

/** `GET /babies/:id/members`. `invites` is empty for non-admins. */
export const membersListResponseSchema = z.object({
  members: z.array(memberSchema),
  invites: z.array(inviteSchema),
});
export type MembersListResponse = z.infer<typeof membersListResponseSchema>;
