import { z } from "zod";

// Error body of every non-2xx API response (docs/plans/step-3.md 2.4, 2.6). `message` is safe to
// show to the user and never contains SQL, parameters, tokens or emails other than masked ones.
// Zod failures use `validation_failed` with field paths only; 429s carry `Retry-After`.
// Step 7 (docs/plans/step-7.md 2.4, D13) adds `plan_required` and `ai_budget_exceeded` so the
// SPA can key the Plus upsell and the budget notice on a code, not on a message.
// Step 8 (docs/plans/step-8.md 2.4) adds the share-link viewer codes. The review-fixes batch
// (docs/plans/review-fixes.md 2.5) adds the data export codes; step 10 (docs/plans/step-10.md
// 2.6) the photo import codes; step 11 (docs/plans/step-11.md 2.3, 2.9) the family-start,
// one-family-per-parent, pending-queue and suspension codes.

export const apiErrorCodeSchema = z.enum([
  "unauthorized",
  "token_expired",
  "session_revoked",
  "csrf_rejected",
  "forbidden",
  "not_found",
  "conflict",
  "validation_failed",
  "rate_limited",
  "captcha_required",
  "captcha_failed",
  "invalid_code",
  "provider_disabled",
  "consent_required",
  "under_18",
  "consent_version_outdated",
  "fresh_sign_in_required",
  "invite_not_found",
  "invite_expired",
  "invite_revoked",
  "invite_accepted",
  "invite_email_mismatch",
  "invite_exists",
  "already_member",
  "admins_full",
  "last_admin",
  "sole_admin",
  "free_tier_limit",
  "upload_session_full",
  "upload_session_expired",
  "upload_incomplete",
  "unsupported_media_type",
  "file_too_large",
  /** 403: the baby has no AI entitlement (free tier / expired): chat, search, facets (step 7). */
  "plan_required",
  /** 429 + `Retry-After` (seconds to the next UTC month): the baby's monthly AI budget is spent. */
  "ai_budget_exceeded",
  /**
   * 410: the share link is unknown, expired, revoked, regenerated away, or its baby was deleted.
   * One response (`SHARE_EXPIRED_MESSAGE`) for every case, so it reveals nothing about which.
   */
  "share_link_expired",
  /** 401: the link has a passcode and none was sent (not counted as a failure). */
  "passcode_required",
  /** 401: wrong passcode; `details: { attemptsLeft }` for this IP's window. */
  "passcode_invalid",
  /** 429 + `Retry-After`: too many failures on this link from any IP; regenerate clears it. */
  "passcode_locked",
  // Data export (docs/plans/review-fixes.md 2.5; FR-10.1).
  /** 409: an export of this album is already queued or running (`data_exports_rate_limit`). */
  "export_in_progress",
  /** 410: the export is not ready, has expired or its ZIP was purged. */
  "export_expired",
  /** 403: only the admin who requested an export may download it (D3). */
  "not_requester",
  /** 409: the album is in the trash and cannot be exported. */
  "baby_trashed",
  // Photo import (docs/plans/step-10.md 2.6).
  /** 404: Google import is off on this server (`GOOGLE_IMPORT_PROVIDER=none`); the UI hides it. */
  "feature_unavailable",
  /** 409: the caller has not connected Google Photos. */
  "google_not_connected",
  /** 409: Google refused the stored refresh token (revoked / expired); connect again. */
  "google_reconnect",
  /** 409: a Picker import of this album is already picking, queued or running. */
  "import_in_progress",
  /** 409: another user's sync row already exists for this device and album. */
  "import_source_exists",
  /** 409: the album has the most sync rows allowed (`IMPORT_SOURCES_PER_BABY_MAX`). */
  "import_source_limit",
  // Free-tier abuse safeguards, family model (docs/plans/step-11.md 2.3, 2.4, 2.5, 2.9). Sign-in
  // is never refused (only suspension); the family-start checks run on an account's first album.
  /** 400 at family start (`POST /babies`, first album): the address is on a disposable domain. */
  "email_not_allowed",
  /**
   * 409 at family start: another account for the same inbox (`canonicalEmail`) is already a parent;
   * `details: { existingEmailMasked }` (`inboxHasFamilyDetailsSchema`), omitted when unknown.
   */
  "inbox_has_family",
  /** 429 + `Retry-After` at family start: too many new families from this network in 24 h. */
  "family_limited",
  /** 409 at admin-invite accept or promote: the account is already a parent in another family. */
  "already_parent_elsewhere",
  /**
   * 409 at upload/import: the caller has the most pending (unapproved) photos allowed in this
   * family (`PENDING_PHOTOS_PER_GUEST_PER_FAMILY` by default); `details: { pending, limit }`
   * (`pendingLimitDetailsSchema`) when known.
   */
  "pending_limit",
  /** 403 on every request and at sign-in: an operator suspended the account (message names `SUPPORT_EMAIL`). */
  "account_suspended",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** The single user-facing message of `share_link_expired` (FR-9.6). */
export const SHARE_EXPIRED_MESSAGE = "This link has expired. Ask the parents for a new link.";

/** `details` of a `passcode_invalid` error. */
export const passcodeInvalidDetailsSchema = z.object({
  attemptsLeft: z.number().int().nonnegative(),
});
export type PasscodeInvalidDetails = z.infer<typeof passcodeInvalidDetailsSchema>;

/** `{ error, message, details? }`. Named `…Response` to leave `ApiError` free for the API/SPA classes. */
export const apiErrorSchema = z.object({
  error: apiErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
