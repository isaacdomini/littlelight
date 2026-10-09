import { z } from "zod";

// Error body of every non-2xx API response (docs/plans/step-3.md 2.4, 2.6). `message` is safe to
// show to the user and never contains SQL, parameters, tokens or emails other than masked ones.
// Zod failures use `validation_failed` with field paths only; 429s carry `Retry-After`.
// Step 7 (docs/plans/step-7.md 2.4, D13) adds `plan_required` and `ai_budget_exceeded` so the
// SPA can key the Plus upsell and the budget notice on a code, not on a message.

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
  "internal",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** `{ error, message, details? }`. Named `…Response` to leave `ApiError` free for the API/SPA classes. */
export const apiErrorSchema = z.object({
  error: apiErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
