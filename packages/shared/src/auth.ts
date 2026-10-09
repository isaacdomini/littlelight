import { z } from "zod";
import { aiOverrideFieldSchema } from "./ai-description";
import { aiUsageMonthSchema } from "./api/ai";
import { aiSpendKindSchema, babyRoleSchema, measurementKindSchema, planSchema } from "./db-enums";
import { uploadFileErrorSchema } from "./upload";

// Auth constants and helpers shared by the API and the SPA (docs/plans/step-3.md 2.2, 2.6, 2.9).
// Browser-safe: no Node imports. Session transport: web uses httpOnly cookies set by the API,
// native (step 9) uses bearer tokens; the client kind travels in `CLIENT_HEADER`.

/** httpOnly access-token cookie: `HttpOnly; SameSite=Lax; Path=/api; Max-Age=3600` (+ Secure in production). */
export const AUTH_COOKIE_ACCESS = "ll_access";
/** httpOnly refresh-token cookie: `HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=2592000` (+ Secure in production). */
export const AUTH_COOKIE_REFRESH = "ll_refresh";

/**
 * Request header naming the client kind. Lowercase (Node lowercases incoming header names).
 * Cookie-authenticated non-GET requests without `web` here are rejected with 403 `csrf_rejected`;
 * `native` makes session endpoints return tokens in the body instead of setting cookies.
 */
export const CLIENT_HEADER = "x-littlelight-client";
export const clientKindSchema = z.enum(["web", "native"]);
export type ClientKind = z.infer<typeof clientKindSchema>;

/** SPA route that receives magic links (`#token_hash=…&type=email`) and OAuth returns (`?code=…`). */
export const SPA_AUTH_CALLBACK_PATH = "/signin/callback";
/** SPA route prefix of invite links: `${PUBLIC_URL}${INVITE_PATH}/${token}`. */
export const INVITE_PATH = "/invite";

/** GoTrue access JWT lifetime (`GOTRUE_JWT_EXP`), also the `ll_access` cookie Max-Age. */
export const ACCESS_TOKEN_TTL_SEC = 3600;
/** Web inactivity timeout: `ll_refresh` Max-Age, re-issued on every refresh. */
export const WEB_SESSION_IDLE_DAYS = 30;
/** Native inactivity timeout (`GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=2160h`). */
export const NATIVE_SESSION_IDLE_DAYS = 90;
/** Destructive actions need a GoTrue session created at most this many minutes ago. */
export const FRESH_SIGN_IN_MAX_AGE_MIN = 10;

export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_MIN = 10;
/** Verify attempts per email per `OTP_TTL_MIN` window. */
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_PER_EMAIL_PER_HOUR = 5;
export const OTP_PER_IP_PER_HOUR = 30;
/** Turnstile is required once an IP has requested this many codes in the hour (only when configured). */
export const OTP_CAPTCHA_AFTER_ATTEMPTS = 3;
export const INVITE_LOOKUPS_PER_IP_PER_HOUR = 60;
/** Pending co-admin removal requests older than this are ignored. */
export const MEMBER_REMOVAL_REQUEST_TTL_DAYS = 7;

/** Current Terms / Privacy Policy versions; consent must match both exactly. */
export const TERMS_VERSION = "2026-10-08";
export const PRIVACY_VERSION = "2026-10-08";
export const PLUS_PRICE_USD_MONTHLY = 3.99;

/** Suggested relationship chips on the profile screen; free text is also allowed. */
export const RELATIONSHIP_LABELS = [
  "Mom",
  "Dad",
  "Parent",
  "Grandparent",
  "Guardian",
  "Nanny",
  "Family",
  "Other",
] as const;
export type RelationshipLabel = (typeof RELATIONSHIP_LABELS)[number];

/** Canonical form for storing and comparing emails: NFC, trimmed, lowercase. */
export function normalizeEmail(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}

/**
 * An email as accepted in request bodies: normalized (`normalizeEmail`) and then validated, so
 * handlers always receive the canonical form. Max 320 chars, matching the `invites.email` CHECK.
 */
export const emailSchema = z
  .string()
  .normalize("NFC")
  .trim()
  .toLowerCase()
  .max(320)
  .pipe(z.email());

/**
 * Masks an email for display to someone who should not learn it in full:
 * `maskEmail('maria@gmail.com') === 'm***@gmail.com'`; a one-character local part becomes `*`
 * (`'a@x.com'` → `'*@x.com'`). Input without `@` becomes `***`.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = Array.from(email.slice(0, at));
  const domain = email.slice(at + 1);
  if (local.length === 1) return `*@${domain}`;
  return `${local[0]}***@${domain}`;
}

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Littlelight\//, "Littlelight app"],
  [/Edg(A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/CriOS\/|Chrome\/|Chromium\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const DEVICES: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone|iPod/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

/**
 * Coarse, non-identifying device label from a User-Agent string for the devices list and the
 * new-device email, e.g. "Safari on iPhone", "Chrome on Windows". Never includes versions.
 */
export function userAgentLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const s = ua.slice(0, 512);
  const browser = BROWSERS.find(([re]) => re.test(s))?.[1];
  const device = DEVICES.find(([re]) => re.test(s))?.[1];
  if (browser && device) return `${browser} on ${device}`;
  if (device) return `Browser on ${device}`;
  if (browser) return browser;
  return "Unknown device";
}

/**
 * `audit_log.event` values: step 3 (auth, invites, members, babies, account), step 4 (uploads,
 * photo moderation, purge, safety), step 5 (details, milestones, measurements), step 6 (AI
 * overrides, AI retry, plan changes, AI budget) and step 7 (chat history cleared). Step 8 appends
 * share-link events.
 */
export const AUDIT_EVENTS = [
  "auth.sign_in",
  "auth.sign_out",
  "auth.new_device",
  "invite.sent",
  "invite.resent",
  "invite.accepted",
  "invite.revoked",
  "member.role_changed",
  "member.removal_requested",
  "member.removed",
  "baby.created",
  "baby.deleted",
  "account.deletion_requested",
  "account.deleted",
  "upload.session_created",
  "upload.session_finished",
  "photo.approved",
  "photo.rejected",
  "photo.trashed",
  "photo.restored",
  "photo.original_downloaded",
  "photo.purged",
  "safety.hash_match",
  "photo.details_updated",
  "photos.details_batch_updated",
  "milestone.created",
  "milestone.updated",
  "milestone.deleted",
  "measurement.created",
  "measurement.updated",
  "measurement.deleted",
  /** Metadata `{photo_id, field}`: never the value. */
  "ai.override_updated",
  /** Metadata `{photo_id, field}`. */
  "ai.override_cleared",
  /** Metadata `{photo_id}`. */
  "ai.retry_requested",
  /** `pnpm db:plan` (operator) or billing; metadata `{plan}`. */
  "baby.plan_changed",
  /** Once per baby per UTC month; metadata `{month}` (the row's `baby_id` names the baby). */
  "ai.budget_exceeded",
  /** A user cleared their chat history for a baby (FR-7.6); no metadata (the row's `baby_id`). */
  "chat.cleared",
] as const;
export const auditEventSchema = z.enum(AUDIT_EVENTS);
export type AuditEvent = z.infer<typeof auditEventSchema>;

/**
 * `audit_log.metadata`. Rule: only these keys, ever. Never emails, IPs, tokens, codes, GPS,
 * notes, prompts, people, location labels, milestone names or measurement values. Strict: any other key is rejected, so `audit()` cannot be handed one.
 */
export const auditMetadataSchema = z.strictObject({
  /** `CF-IPCountry` value (ISO 3166-1 alpha-2, or Cloudflare's `XX`/`T1`). */
  ip_country: z
    .string()
    .regex(/^[A-Z0-9]{2}$/)
    .optional(),
  client: clientKindSchema.optional(),
  /** Output of `userAgentLabel`, never the raw User-Agent. */
  user_agent_label: z.string().min(1).max(100).optional(),
  role: babyRoleSchema.optional(),
  invite_id: z.uuid().optional(),
  /** Sign-out scope: `local`/`global` (GoTrue logout) or `device` (per-session sign-out). */
  scope: z.enum(["local", "global", "device"]).optional(),
  target_user_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
  photo_id: z.uuid().optional(),
  /** `upload.session_finished`: completed + ingested files. */
  count: z.number().int().nonnegative().optional(),
  duplicates: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  error: uploadFileErrorSchema.optional(),
  milestone_id: z.uuid().optional(),
  measurement_id: z.uuid().optional(),
  /**
   * Measurement kind (`weight`/`height`/`head`), never the value; or, on `ai.budget_exceeded`
   * (step 7), the AI spend kind that hit the budget (`embed`/`chat`/`rerank`). The two value
   * sets do not overlap.
   */
  kind: z.union([measurementKindSchema, aiSpendKindSchema]).optional(),
  /** `baby.plan_changed`: the new plan. */
  plan: planSchema.optional(),
  /** `ai.override_*`: which AI field, never its value. */
  field: aiOverrideFieldSchema.optional(),
  /** `ai.budget_exceeded`: UTC month `YYYY-MM` (with `kind` when raised by chat/search, step 7). */
  month: aiUsageMonthSchema.optional(),
});
export type AuditMetadata = z.infer<typeof auditMetadataSchema>;
