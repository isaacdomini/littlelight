import { z } from "zod";
import { aiOverrideFieldSchema } from "./ai-description";
import { aiUsageMonthSchema } from "./api/ai";
import { importBatchKindSchema, importSourceKindSchema } from "./api/imports";
import { SHARE_LINK_MAX_TTL_HOURS } from "./constants";
import {
  aiSpendKindSchema,
  babyRoleSchema,
  measurementKindSchema,
  planSchema,
  shareRuleModeSchema,
} from "./db-enums";
import { APP_UA_TOKEN } from "./native";
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
export const CLIENT_HEADER = "x-tinyglow-client";
export const clientKindSchema = z.enum(["web", "native"]);
export type ClientKind = z.infer<typeof clientKindSchema>;

/**
 * Share-link viewer session cookie (docs/plans/step-8.md 2.2): a short HS256 JWT (`role=viewer`,
 * `share_link_id`, `jti` = `viewer_sessions.id`, `exp` = the link's expiry) signed with a key
 * HKDF-derived from `JWT_SECRET` (never GoTrue's key). `HttpOnly; SameSite=Lax;
 * Path=/api/share; Max-Age = exp − now` (+ Secure in production). Its own name and path: the
 * browser never sends it to a parent route (`/api/babies/*`, chat, search), and the parent
 * cookies' paths never make a parent session reach the viewer routes as a viewer.
 */
export const VIEWER_COOKIE = "ll_viewer";
/** Browser-facing path of every viewer route (nginx/Vite strip `/api`; the API serves `/share/*`). */
export const VIEWER_COOKIE_PATH = "/api/share";
/** `aud` of viewer JWTs; `iss` is `${PUBLIC_URL}${VIEWER_COOKIE_PATH}`. GoTrue tokens never carry it. */
export const VIEWER_JWT_AUDIENCE = "tinyglow-viewer";

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

// ---------------------------------------------------------------------------------------------
// Family-start safeguards (docs/plans/step-11.md 2.2 A/D/E, 2.3, 2.4, D-B, D-J). Sign-in is never
// refused (only suspension); an account's first album runs the checks. Two accounts may share an
// inbox, but only one of them may be a parent: starting a family compares `canonicalEmail`,
// mirrored step by step by the SQL `public.email_canonical()` (the parity test runs both over
// `CANONICAL_EMAIL_FIXTURES`).
// ---------------------------------------------------------------------------------------------

/** Default of `FAMILIES_PER_IP_PER_DAY`: new families per client IP per rolling 24 h (guests never count). */
export const FAMILIES_PER_IP_PER_DAY_DEFAULT = 5;
/** `family_starts` rows older than this are pruned (`family_starts_prune()`, FR-10.3). */
export const FAMILY_START_RETENTION_DAYS = 30;
/** Support contact named in the `account_suspended` message (docs/plans/step-11.md 2.9). */
export const SUPPORT_EMAIL = "support@tinyglow.app";
/**
 * Email domains the disposable-domain check never blocks, whatever the vendored list or
 * `EMAIL_DOMAIN_DENYLIST` say (exact domain match): Apple Hide My Email relay addresses are
 * real accounts (PRD), and our own / dev / e2e domains keep the seed and the tests working.
 */
export const NEVER_BLOCKED_EMAIL_DOMAINS = [
  "privaterelay.appleid.com",
  "tinyglow.app",
  "tinyglow.local",
  "example.com",
] as const;

/** Why an operator suspended an account (`profiles.suspended_reason`, `admin:suspend --reason`). */
export const SUSPENSION_REASONS = ["abuse", "other"] as const;
export const suspensionReasonSchema = z.enum(SUSPENSION_REASONS);
export type SuspensionReason = z.infer<typeof suspensionReasonSchema>;

/** Gmail's two domain spellings; the canonical one is `gmail.com`. */
const GMAIL_DOMAIN = "gmail.com";
const GOOGLEMAIL_DOMAIN = "googlemail.com";

/** How an address was canonicalised (the `family_starts` flags). */
export interface EmailShape {
  /** The local part had a `+tag` that was stripped. */
  readonly plusTag: boolean;
  /** Gmail dots were removed from the local part. */
  readonly dotsFolded: boolean;
  /** Canonical domain (lowercase, trailing dots removed, `googlemail.com` → `gmail.com`); `""` without an `@`. */
  readonly domain: string;
}

function canonicalParts(s: string): { canonical: string; shape: EmailShape } {
  // Same order as the SQL: NFC, trim, lowercase.
  const e = normalizeEmail(s);
  const at = e.lastIndexOf("@");
  if (at < 0) return { canonical: e, shape: { plusTag: false, dotsFolded: false, domain: "" } };
  const original = e.slice(0, at);
  let domain = e.slice(at + 1).replace(/\.+$/, "");
  if (domain === GOOGLEMAIL_DOMAIN) domain = GMAIL_DOMAIN;
  const plus = original.indexOf("+");
  // `split_part(local, '+', 1)`; an empty result keeps the original local part.
  let local = plus > 0 ? original.slice(0, plus) : original;
  const plusTag = local !== original;
  let dotsFolded = false;
  if (domain === GMAIL_DOMAIN && local.includes(".")) {
    local = local.replaceAll(".", "");
    dotsFolded = true;
  }
  return { canonical: `${local}@${domain}`, shape: { plusTag, dotsFolded, domain } };
}

/**
 * Canonical form of an email for "one inbox = one family" (D-B). Mirrors SQL
 * `public.email_canonical()` exactly:
 * 1. NFC, trim, lowercase (`normalizeEmail`); no `@` ⇒ that string;
 * 2. split at the **last** `@`; trailing dots removed from the domain;
 * 3. `googlemail.com` → `gmail.com`;
 * 4. `+tag` stripped for every domain, unless that empties the local part;
 * 5. dots removed from the local part for `gmail.com` only.
 * Never stored as the user's address: `auth.users.email` stays as typed (Apple relay addresses
 * as-is); this value only feeds `profiles.email_canonical` and comparisons.
 */
export function canonicalEmail(s: string): string {
  return canonicalParts(s).canonical;
}

/** The `family_starts` flags of an address: whether canonicalisation stripped a `+tag` or folded Gmail dots. */
export function emailShape(s: string): EmailShape {
  return canonicalParts(s).shape;
}

/**
 * Parity fixtures `[input, canonical]` shared by the TS unit test and the SQL
 * `email_canonical()` integration test (docs/plans/step-11.md 2.3). Add cases here, never in
 * one test only.
 */
export const CANONICAL_EMAIL_FIXTURES: ReadonlyArray<readonly [input: string, canonical: string]> =
  Object.freeze([
    ["Maria.Rossi+baby@Gmail.com", "mariarossi@gmail.com"],
    ["m.rossi@googlemail.com", "mrossi@gmail.com"],
    ["dad+twins@outlook.com", "dad@outlook.com"],
    ["dad@example.com ", "dad@example.com"],
    ["+tag@gmail.com", "+tag@gmail.com"],
    ["a.b@fastmail.com", "a.b@fastmail.com"],
    ["user@sub.example.co.uk.", "user@sub.example.co.uk"],
    ["ÄBC@Example.com", "äbc@example.com"],
  ] as const);

/** The native apps' User-Agent product token, `Tinyglow/<version>` (`appendUserAgent`). */
const APP_UA_RE = new RegExp(`(^|[\\s;(])${APP_UA_TOKEN}/[0-9A-Za-z.+-]+`);
const APP_LABEL = "Tinyglow app";

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [APP_UA_RE, APP_LABEL],
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
 * new-device email, e.g. "Safari on iPhone", "Chrome on Windows". Never includes versions. The
 * native apps (`Tinyglow/<version>`) are "Tinyglow app on iPhone" / "on iPad" / "on Android".
 */
export function userAgentLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const s = ua.slice(0, 512);
  const browser = BROWSERS.find(([re]) => re.test(s))?.[1];
  let device = DEVICES.find(([re]) => re.test(s))?.[1];
  // The app ships for iOS and Android only; an iPad's WKWebView sends a desktop-class
  // ("Macintosh") User-Agent by default, so the app on "Mac" is an iPad.
  if (browser === APP_LABEL && device === "Mac") device = "iPad";
  if (browser && device) return `${browser} on ${device}`;
  if (device) return `Browser on ${device}`;
  if (browser) return browser;
  return "Unknown device";
}

/**
 * `audit_log.event` values: step 3 (auth, invites, members, babies, account), step 4 (uploads,
 * photo moderation, purge, safety), step 5 (details, milestones, measurements), step 6 (AI
 * overrides, AI retry, plan changes, AI budget), step 7 (chat history cleared), step 8
 * (share links), the review-fixes batch (data exports), step 10 (photo import) and step 11
 * (account suspension).
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
  // Step 8 (docs/plans/step-8.md 2.4). The row's `share_link_id` names the link; metadata never
  // carries the token, its hash, the passcode, the link name or rule tags.
  /** Metadata `{hours, has_passcode, allow_download, mode?}`. */
  "share_link.created",
  /** Metadata `{fields}`: which settings changed, never their values. */
  "share_link.updated",
  /** Metadata `{hours}`. */
  "share_link.renewed",
  /** New token; every open viewer session ended. No metadata. */
  "share_link.regenerated",
  "share_link.revoked",
  /** Written before the delete (the FK then sets `share_link_id` NULL). */
  "share_link.deleted",
  /** Metadata `{mode}`. */
  "share_link.rule_updated",
  "share_link.rule_removed",
  /** Metadata `{count}`. */
  "share_link.photos_added",
  /** Metadata `{count}`. */
  "share_link.photos_removed",
  /** An admin released a sensitive photo to this link's viewers; metadata `{photo_id}` (or `{count}`). */
  "share_link.sensitive_shown",
  /** Metadata `{photo_id}`. */
  "share_link.sensitive_hidden",
  /** Per-link passcode lock reached (written by the token exchange, `actor_user_id` NULL). */
  "share_link.passcode_locked",
  // Data export (docs/plans/review-fixes.md 2.2, 2.3, 2.5; FR-10.1). The row's `baby_id` names
  // the baby; metadata never carries the storage key, bytes, a URL or an email.
  /** An admin requested an export; metadata `{export_id, include_location}`. */
  "export.requested",
  /** The worker finished the ZIP (`actor_user_id` NULL); metadata `{export_id, count}`. */
  "export.ready",
  /** The worker gave up (`actor_user_id` NULL); metadata `{export_id}`. */
  "export.failed",
  /** The requester minted a download URL; metadata `{export_id}`. */
  "export.downloaded",
  /** An admin expired an export early (`DELETE …/exports/:exportId`); metadata `{export_id}`. */
  "export.expired",
  /** The hourly sweep deleted the ZIP (`actor_user_id` NULL); metadata `{export_id}`. */
  "export.purged",
  // Photo import (docs/plans/step-10.md 2.3, 2.6, 2.7). The row's `baby_id` names the baby where
  // there is one; metadata never carries a token, a Google session or item id, a URL, a file
  // name, an album title, a device label or a PHAsset identifier.
  /** An admin turned on Apple album sync on a device; metadata `{source_id, kind}`. */
  "import.source_created",
  /** A sync row was removed (owner or baby admin); metadata `{source_id}`. */
  "import.source_deleted",
  /** The user connected Google Photos (no `baby_id`); no metadata. */
  "import.google_connected",
  /** The user disconnected Google Photos (token revoked best effort; no `baby_id`); no metadata. */
  "import.google_disconnected",
  /** A Picker batch was created; metadata `{batch_id, kind}`. */
  "import.batch_created",
  /** The worker finished a batch (`actor_user_id` NULL); metadata `{batch_id, count, duplicates, failed}`. */
  "import.batch_finished",
  /** The requester cancelled a batch; metadata `{batch_id}`. */
  "import.batch_cancelled",
  /** The worker gave up on a batch (`actor_user_id` NULL); metadata `{batch_id}`. */
  "import.batch_failed",
  // Free-tier abuse safeguards (docs/plans/step-11.md 2.2 F, 2.7). Written by the operator
  // tool `admin:suspend` (`actor_user_id` NULL); family-start refusals are not audited (a family
  // start itself is `baby.created` with `family_start: true`).
  /** An operator suspended an account; metadata `{target_user_id, reason}`. */
  "account.suspended",
  /** An operator lifted a suspension; metadata `{target_user_id}`. */
  "account.unsuspended",
] as const;
export const auditEventSchema = z.enum(AUDIT_EVENTS);
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Share-link settings named by `share_link.updated` metadata `fields` (never their values). */
export const SHARE_LINK_AUDIT_FIELDS = ["name", "allow_download", "passcode", "ttl_hours"] as const;
export const shareLinkAuditFieldSchema = z.enum(SHARE_LINK_AUDIT_FIELDS);
export type ShareLinkAuditField = z.infer<typeof shareLinkAuditFieldSchema>;

/**
 * `audit_log.metadata`. Rule: only these keys, ever. Never emails, IPs, tokens, codes, GPS,
 * notes, prompts, people, location labels, milestone names or measurement values. Strict: any other key is rejected, so `audit()` cannot be handed one.
 */
export const auditMetadataSchema = z.strictObject({
  /** `auth.sign_in` through the store-review account (step 9, D4); absent for normal sign-ins. */
  method: z.enum(["review"]).optional(),
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
   * (step 7), the AI spend kind that hit the budget (`embed`/`chat`/`rerank`); or, on
   * `import.source_created` / `import.batch_created` (step 10), the import kind
   * (`apple_photos`/`google_picker`). The value sets do not overlap.
   */
  kind: z
    .union([
      measurementKindSchema,
      aiSpendKindSchema,
      importSourceKindSchema,
      importBatchKindSchema,
    ])
    .optional(),
  /** `baby.plan_changed`: the new plan. */
  plan: planSchema.optional(),
  /** `ai.override_*`: which AI field, never its value. */
  field: aiOverrideFieldSchema.optional(),
  /** `ai.budget_exceeded`: UTC month `YYYY-MM` (with `kind` when raised by chat/search, step 7). */
  month: aiUsageMonthSchema.optional(),
  /** `share_link.created` / `share_link.rule_updated`: the auto-share rule mode, never its tags. */
  mode: shareRuleModeSchema.optional(),
  /** `share_link.created`: the download setting. */
  allow_download: z.boolean().optional(),
  /** `share_link.created`: whether a passcode was set (never the passcode or its hash). */
  has_passcode: z.boolean().optional(),
  /** `share_link.created` / `share_link.renewed`: validity in hours. */
  hours: z.number().int().min(1).max(SHARE_LINK_MAX_TTL_HOURS).optional(),
  /** `share_link.updated`: which settings changed. */
  fields: z.array(shareLinkAuditFieldSchema).min(1).max(SHARE_LINK_AUDIT_FIELDS.length).optional(),
  /** `export.*`: the `data_exports` row (never its storage key, size or a URL). */
  export_id: z.uuid().optional(),
  /** `export.requested`: whether GPS columns were asked for (never a coordinate). */
  include_location: z.boolean().optional(),
  /** `import.source_*`: the `import_sources` row (never its album title, device label or device id). */
  source_id: z.uuid().optional(),
  /** `import.batch_*`: the `import_batches` row (never the Google session id). */
  batch_id: z.uuid().optional(),
  /** `account.suspended` / `account.unsuspended` (step 11): the operator's reason code, never free text. */
  reason: suspensionReasonSchema.optional(),
  /**
   * `baby.created` (step 11): `true` when this album started the caller's family (the
   * family-start checks ran); omitted otherwise. Never the family id, IP or address.
   */
  family_start: z.boolean().optional(),
});
export type AuditMetadata = z.infer<typeof auditMetadataSchema>;
