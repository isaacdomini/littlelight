import { z } from "zod";

// Error body of every non-2xx API response (docs/plans/step-3.md 2.4, 2.6). `message` is safe to
// show to the user and never contains SQL, parameters, tokens or emails other than masked ones.
// Zod failures use `validation_failed` with field paths only; 429s carry `Retry-After`.
// Step 7 (docs/plans/step-7.md 2.4, D13) adds `plan_required` and `ai_budget_exceeded` so the
// SPA can key the Plus upsell and the budget notice on a code, not on a message.
// Step 8 (docs/plans/step-8.md 2.4) adds the share-link viewer codes.

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
