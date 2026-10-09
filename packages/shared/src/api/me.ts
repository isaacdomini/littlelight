import { z } from "zod";
import { unitsSchema } from "../db-enums";
import { sessionUserSchema } from "./auth";
import { babySummarySchema } from "./babies";
import { isoDateTimeSchema } from "./common";

// `/api/me` contracts (docs/plans/step-3.md 2.4, 2.6; PRD "Sign-up flow" steps 3-4 and
// "Account deletion and recovery").

export const profileSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  relationshipLabel: z.string().nullable(),
  /** IANA time zone, e.g. `America/New_York`. */
  timezone: z.string(),
  units: unitsSchema,
  termsVersion: z.string().nullable(),
  privacyVersion: z.string().nullable(),
  acceptedAt: isoDateTimeSchema.nullable(),
  /**
   * Push opt-outs per kind (step 9, `profiles.notify_*`, NOT NULL default true; the OS
   * permission plus "Turn on notifications" is the opt-in).
   */
  notifyPhotosAnalyzed: z.boolean(),
  notifyShareViewed: z.boolean(),
});
export type Profile = z.infer<typeof profileSchema>;

/**
 * `POST /me/consent` → `meResponse`. `isAdult: false` ⇒ 403 `under_18` (nothing stored);
 * versions other than `TERMS_VERSION`/`PRIVACY_VERSION` ⇒ 409 `consent_version_outdated`.
 */
export const consentRequestSchema = z.object({
  termsVersion: z.string().min(1).max(40),
  privacyVersion: z.string().min(1).max(40),
  isAdult: z.boolean(),
});
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

/**
 * `PATCH /me/profile` → `meResponse`. All optional, at least one. The API additionally checks
 * `timezone` against `Intl.supportedValuesOf('timeZone')`.
 */
export const profileUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    relationshipLabel: z.string().trim().min(1).max(40),
    timezone: z.string().min(1).max(64),
    units: unitsSchema,
    /** Step 9: push opt-out for "N new photos are ready to search". */
    notifyPhotosAnalyzed: z.boolean(),
    /** Step 9: push opt-out for "Someone opened your shared album". */
    notifyShareViewed: z.boolean(),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "at least one field is required",
  });
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/** `GET /me`: the SPA's single bootstrap call. */
export const meResponseSchema = z.object({
  user: sessionUserSchema,
  /** Null until the first session-issuing response has created the row. */
  profile: profileSchema.nullable(),
  consent: z.object({
    /** Accepted versions equal the required ones. */
    ok: z.boolean(),
    requiredTermsVersion: z.string(),
    requiredPrivacyVersion: z.string(),
  }),
  /** Consent ok and a non-empty display name. */
  profileComplete: z.boolean(),
  babies: z.array(babySummarySchema),
  session: z.object({ createdAt: isoDateTimeSchema, isFresh: z.boolean() }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** `GET /me/deletion-preview`. */
export const deletionPreviewResponseSchema = z.object({
  /** Live babies where the user is the only admin: delete them or promote a co-admin first. */
  blockingBabies: z.array(z.object({ id: z.uuid(), name: z.string() })),
  /** Babies that stay with the other admin after deletion. */
  babiesKept: z.array(z.object({ id: z.uuid(), name: z.string(), otherAdminName: z.string() })),
  freshSignIn: z.boolean(),
});
export type DeletionPreviewResponse = z.infer<typeof deletionPreviewResponseSchema>;

/** `DELETE /me` (fresh sign-in) → 204. */
export const deleteAccountRequestSchema = z.object({ acknowledge: z.literal(true) });
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;
