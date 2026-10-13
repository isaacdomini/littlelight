import {
  type ApiErrorCode,
  type ApiErrorResponse,
  CHAT_MESSAGES,
  EXPORTS_PER_BABY_PER_DAY,
  FREE_TIER_VIDEO_LIMIT,
  IMPORT_BATCHES_PER_BABY_PER_DAY,
  IMPORT_SOURCES_PER_BABY_MAX,
  type InboxHasFamilyDetails,
  type PasscodeInvalidDetails,
  type PendingLimitDetails,
  SHARE_EXPIRED_MESSAGE,
  SHARE_LINKS_PER_BABY_MAX,
  SUPPORT_EMAIL,
} from "@tinyglow/shared";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

// API error model (docs/plans/step-3.md 2.4 "Error mapping"). Every non-2xx body is
// `apiErrorSchema`: `{ error: <code>, message, details? }`. Messages are user-safe: they never
// contain SQL, bind parameters, tokens, cookies or unmasked emails. Validation failures report
// field paths only. 429 responses carry `Retry-After`.

export interface ApiErrorOptions {
  /** Seconds; sets `Retry-After` (use with 429). */
  retryAfterSec?: number;
}

/** Throw from any handler or hook; the global error handler turns it into the response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly retryAfterSec: number | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: unknown,
    options?: ApiErrorOptions,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSec =
      options?.retryAfterSec === undefined
        ? undefined
        : Math.max(1, Math.ceil(options.retryAfterSec));
  }

  toBody(): ApiErrorResponse {
    return this.details === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, details: this.details };
  }
}

/** Shorthands for the common cases. */
export const notFound = (message = "Not found") => new ApiError(404, "not_found", message);
export const forbidden = (message = "You don't have access to that") =>
  new ApiError(403, "forbidden", message);
export const rateLimited = (
  retryAfterSec: number,
  message = "Too many requests, try again later",
) => new ApiError(429, "rate_limited", message, undefined, { retryAfterSec });
export const internalError = () => new ApiError(500, "internal", "Something went wrong");

/**
 * 403 `plan_required` (docs/plans/step-7.md D13): the baby has no AI entitlement (free tier or
 * lapsed). The chat/search gate raises its own (`search/access.ts`); this one maps the
 * `ai_spend_guard` trigger (plan lapsed during a turn).
 */
export const planRequired = () => new ApiError(403, "plan_required", CHAT_MESSAGES.planRequired);

// Step 8 (docs/plans/step-8.md 2.4, 2.9): share-link viewer errors. Thrown by
// `apps/api/src/sharing/**`; the codes and statuses are fixed here so every route answers alike.

/**
 * 410 `share_link_expired`: unknown, expired, revoked, regenerated-away or deleted-baby link, and
 * a viewer session that `viewer_session_check` no longer returns. One body for every case.
 */
export const shareLinkExpired = () =>
  new ApiError(410, "share_link_expired", SHARE_EXPIRED_MESSAGE);

/** 401 `passcode_required`: the link has a passcode and the exchange sent none (not a failure). */
export const passcodeRequired = () =>
  new ApiError(401, "passcode_required", "Enter the passcode the parents gave you");

/** 401 `passcode_invalid` with `details: { attemptsLeft }` (this IP's window, never negative). */
export const passcodeInvalid = (attemptsLeft: number) =>
  new ApiError(401, "passcode_invalid", "That passcode isn't right", {
    attemptsLeft: Math.max(0, Math.floor(attemptsLeft)),
  } satisfies PasscodeInvalidDetails);

/** 429 `passcode_locked` + `Retry-After`: too many failures on this link from any IP (D8). */
export const passcodeLocked = (retryAfterSec: number) =>
  new ApiError(
    429,
    "passcode_locked",
    "This link is locked after too many wrong passcodes. Ask the parents for a new link.",
    undefined,
    { retryAfterSec },
  );

/** 403 `plan_required` for auto-share rules on a free baby (route pre-check and DB trigger, D3). */
export const shareRulePlanRequired = () =>
  new ApiError(
    403,
    "plan_required",
    "Auto-share checks every photo for sensitive content first; it's part of Plus",
  );

/** 409 `conflict`: the baby already has `SHARE_LINKS_PER_BABY_MAX` links (`share_links_cap`). */
export const shareLinkLimit = () =>
  new ApiError(
    409,
    "conflict",
    `This album already has the maximum of ${SHARE_LINKS_PER_BABY_MAX} share links`,
  );

// Review fixes (docs/plans/review-fixes.md 2.5; PRD FR-10.1): data export errors. Thrown by
// `apps/api/src/exports/**` and mapped from the `data_exports` triggers below.

/** 409 `export_in_progress`: one queued/running export per album (`data_exports_rate_limit`). */
export const exportInProgress = () =>
  new ApiError(
    409,
    "export_in_progress",
    "An export of this album is already being prepared. You'll get an email when it's ready.",
  );

/** 429 `rate_limited`: `EXPORTS_PER_BABY_PER_DAY` exports per album per rolling 24 h. */
export const exportRateLimited = () =>
  new ApiError(
    429,
    "rate_limited",
    `This album can be exported ${EXPORTS_PER_BABY_PER_DAY} times a day. Try again tomorrow.`,
    undefined,
    { retryAfterSec: 3600 },
  );

/** 409 `baby_trashed`: the album is in the trash (`data_exports_baby_live`). */
export const babyTrashed = () =>
  new ApiError(409, "baby_trashed", "This album is in the trash. Restore it first.");

/**
 * 410 `export_expired`: not downloadable — still being prepared (`pending`), or failed, past its
 * expiry or its ZIP was removed. One code for the client; the message says which.
 */
export const exportExpired = (pending = false) =>
  new ApiError(
    410,
    "export_expired",
    pending
      ? "This export is still being prepared. You'll get an email when it's ready."
      : "This export is no longer available. Start a new one.",
  );

/** 403 `not_requester`: only the admin who requested an export can download it (D3). */
export const notRequester = () =>
  new ApiError(403, "not_requester", "Only the parent who started this export can download it");

// Step 10 (docs/plans/step-10.md 2.6; packages/db/migrations/1792300000300_photo-import.sql):
// photo import errors. Thrown by `apps/api/src/imports/**` and mapped from the import triggers
// below. Messages never name a token, a Google id, an album title or a device label.

/**
 * 404 `feature_unavailable`: Google import is off on this server (`GOOGLE_IMPORT_PROVIDER=none`).
 * The UI hides the feature from `GET /me/import/google/connection` (`available: false`).
 */
export const featureUnavailable = () =>
  new ApiError(404, "feature_unavailable", "Google Photos import isn't available on this server");

/** 409 `google_not_connected`: the caller has no Google connection. */
export const googleNotConnected = () =>
  new ApiError(409, "google_not_connected", "Connect Google Photos first");

/** 409 `google_reconnect`: Google refused the stored refresh token (revoked or expired). */
export const googleReconnect = () =>
  new ApiError(
    409,
    "google_reconnect",
    "Google Photos needs to be connected again. Reconnect and try once more.",
  );

/** 409 `import_in_progress`: one picking/queued/running Picker batch per album. */
export const importInProgress = () =>
  new ApiError(
    409,
    "import_in_progress",
    "An import into this album is already in progress. Wait for it to finish or cancel it.",
  );

/** 429 `rate_limited`: `IMPORT_BATCHES_PER_BABY_PER_DAY` Picker batches per album per 24 h. */
export const importRateLimited = () =>
  new ApiError(
    429,
    "rate_limited",
    `This album can import from Google Photos ${IMPORT_BATCHES_PER_BABY_PER_DAY} times a day. Try again tomorrow.`,
    undefined,
    { retryAfterSec: 3600 },
  );

/** 409 `import_source_exists`: another user's sync row exists for this device and album. */
export const importSourceExists = () =>
  new ApiError(
    409,
    "import_source_exists",
    "Someone else already syncs an album from this device into this baby's album",
  );

/** 409 `import_source_limit`: `IMPORT_SOURCES_PER_BABY_MAX` sync rows per album. */
export const importSourceLimit = () =>
  new ApiError(
    409,
    "import_source_limit",
    `This album already syncs from the maximum of ${IMPORT_SOURCES_PER_BABY_MAX} devices`,
  );

/** A node-postgres `DatabaseError` (has a 5-character SQLSTATE). */
export interface PgErrorLike {
  code: string;
  message: string;
  severity?: string;
  constraint?: string;
  table?: string;
  column?: string;
  routine?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

export function isPgError(err: unknown): err is PgErrorLike {
  if (typeof err !== "object" || err === null) return false;
  const { code, message, severity } = err as Record<string, unknown>;
  return (
    typeof code === "string" &&
    SQLSTATE.test(code) &&
    typeof message === "string" &&
    typeof severity === "string"
  );
}

/**
 * Trigger messages (`RAISE … USING ERRCODE = 'check_violation'`, packages/db/migrations) mapped
 * to API errors. Matched by prefix of the trigger's own text; never echoed.
 */
const CHECK_VIOLATIONS: ReadonlyArray<readonly [string, () => ApiError]> = [
  [
    "baby already has two admins",
    () => new ApiError(409, "admins_full", "This album already has two admins"),
  ],
  [
    "baby must keep at least one admin",
    () => new ApiError(409, "last_admin", "An album must keep at least one admin"),
  ],
  [
    "invite rate limit",
    () =>
      new ApiError(
        429,
        "rate_limited",
        "Too many invites for this album today, try again tomorrow",
        undefined,
        {
          retryAfterSec: 3600,
        },
      ),
  ],
  [
    "invite is no longer valid",
    () => new ApiError(410, "invite_expired", "This invite is no longer valid"),
  ],
  // Step 4 (packages/db/migrations/1791700000100_uploads-and-ingest.sql, 1791520000300_photos.sql);
  // per family and approved-only from step 11 (`photos_free_tier_cap`, migration 21): raised by
  // admin uploads, approve, restore and import booking alike.
  ["free tier photo limit reached", () => freeTierLimit()],
  // Step 12 (Q3; packages/db/migrations/1792500000100_video.sql `photos_free_tier_video_cap`):
  // the family's free albums already hold the most videos allowed.
  ["free tier video limit reached", () => freeTierLimit("video")],
  // Step 11 (docs/plans/step-11.md 2.2 A–C, 2.5; packages/db/migrations/1792400000100_free-tier-abuse.sql).
  // `baby_members_one_family`: accepting an admin invite or a promotion while a parent elsewhere.
  ["user is already a parent in another family", () => alreadyParentElsewhere()],
  // `photos_pending_cap`: the uploader's pending queue in this family is full. Routes that know
  // the counts throw `pendingLimit({ pending, limit })` themselves; this fallback omits them.
  ["pending photo limit reached", () => pendingLimit()],
  // `babies_set_family` inbox arbiter. `POST /babies` catches it first to add the masked hint;
  // anywhere else it maps without one.
  ["another account for this inbox already has a family", () => inboxHasFamily(null)],
  [
    "upload session is full",
    () =>
      new ApiError(409, "upload_session_full", "This upload already has the maximum of 500 photos"),
  ],
  [
    "upload session is closed",
    () => new ApiError(410, "upload_session_expired", "This upload session has ended"),
  ],
  ["upload session belongs to another user", () => forbidden()],
  // Tripwires: the API derives both values itself, so reaching these is a state conflict.
  [
    "upload file must belong to the baby of its session",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
  [
    "duplicate_of_photo_id must be a photo of the same baby",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
  // Step 5 (packages/db/migrations/1791800000100_timeline-and-details.sql).
  [
    "milestone limit reached",
    () =>
      new ApiError(409, "conflict", "This album already has the maximum of 200 custom milestones"),
  ],
  [
    "measurement photo must belong to the same baby",
    () => new ApiError(409, "conflict", "That photo isn't part of this album"),
  ],
  // Cross-baby milestone tags (`photo_details` / `upload_sessions` shape triggers). Listed
  // before the generic `<table>.<column>` rule below, which would make them 400s.
  [
    "photo_details.milestone_id must belong to the same baby",
    () => new ApiError(409, "conflict", "That milestone belongs to another album"),
  ],
  [
    "upload_sessions.milestone_id must belong to the same baby",
    () => new ApiError(409, "conflict", "That milestone belongs to another album"),
  ],
  [
    "photo_details.people holds at most 20 entries",
    () =>
      new ApiError(400, "validation_failed", "A photo can list at most 20 people", {
        fields: ["body.people"],
      }),
  ],
  // Step 6 (packages/db/migrations/1791900000100_ai-pipeline.sql; docs/plans/step-6.md 2.8).
  // The API validates override fields and values with the same rules first, so these are
  // tripwires; a non-overridable field is an input error, the AI-queue/results guards are state
  // conflicts that should never surface to users.
  [
    "photo_ai_overrides.field_path is not an overridable field",
    () =>
      new ApiError(400, "validation_failed", "That AI field can't be edited", {
        fields: ["body"],
      }),
  ],
  [
    "photo cannot enter the AI queue",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
  [
    "AI results can only be stored",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
  [
    "photo_details.location_label is longer than 120 characters",
    () =>
      new ApiError(400, "validation_failed", "The location label is too long", {
        fields: ["body.locationLabel"],
      }),
  ],
  // Step 7 (packages/db/migrations/1792000000100_search-and-chat.sql; docs/plans/step-7.md 2.9).
  // The API never writes `photo_search`; reaching the guard is a state conflict.
  [
    "search rows can only be stored",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
  // The gate checked the plan before the turn; the plan lapsed while it ran.
  ["AI spend can only be recorded for a paid-tier baby", () => planRequired()],
  // The user's message: an input error (the route validates 1..1000 chars first).
  [
    "chat_messages.content must be",
    () =>
      new ApiError(400, "validation_failed", "The message is too long or empty", {
        fields: ["body.text"],
      }),
  ],
  // Server-built arrays (citations, tool names): an agent bug, never the user's fault. Listed
  // before the generic `<table>.<column>` rule, which would make them 400s.
  ["chat_messages.cited_photo_ids holds more than", () => internalError()],
  ["chat_messages.cited_measurement_ids holds more than", () => internalError()],
  ["chat_messages.tools_used holds more than", () => internalError()],
  ["chat_reserve_turn expects a positive limit", () => internalError()],
  // Step 8 (packages/db/migrations/1792100000100_sharing-v1.sql; docs/plans/step-8.md 2.3, 2.9).
  // The routes validate with the shared schemas and pre-filter photos first, so these surface
  // only on a race or a bug. Listed before the generic `<table>.<column>` rule.
  ["share link limit reached", () => shareLinkLimit()],
  // `share_links_lifecycle` (D13): renew is refused on a revoked link; only regenerate (a new
  // token) brings it back. The route checks first; these surface on a concurrent revoke.
  [
    "a revoked share link cannot be renewed",
    () => new ApiError(409, "conflict", "This link was revoked. Regenerate it to share again."),
  ],
  [
    "a revoked share link can only be reactivated with a new token",
    () => new ApiError(409, "conflict", "This link was revoked. Regenerate it to share again."),
  ],
  // `viewer_sessions_guard`: the token exchange raced a revoke/expiry. Same body as every other
  // dead-link case.
  ["share link is not active", () => shareLinkExpired()],
  ["auto-share rules need the paid plan", () => shareRulePlanRequired()],
  [
    "share rule needs at least one include tag",
    () =>
      new ApiError(400, "validation_failed", "Pick at least one tag to share", {
        fields: ["body.includeTags"],
      }),
  ],
  [
    "share_rules tags hold at most 20 entries per list",
    () =>
      new ApiError(400, "validation_failed", "A rule can list at most 20 tags", {
        fields: ["body"],
      }),
  ],
  [
    "share_rules tags must be 1 to 60 characters, trimmed and lower-case",
    () =>
      new ApiError(400, "validation_failed", "Tags must be 1 to 60 characters", {
        fields: ["body"],
      }),
  ],
  [
    "share link expiry must be within 30 days",
    () =>
      new ApiError(400, "validation_failed", "A link can stay open for at most 30 days", {
        fields: ["body.ttlHours"],
      }),
  ],
  [
    "share_links.ttl_hours must be 1 to 720",
    () =>
      new ApiError(400, "validation_failed", "A link can stay open for at most 30 days", {
        fields: ["body.ttlHours"],
      }),
  ],
  // `shared_photos_gate` and `shared_photo_exclusions_guard` on manual adds/removes: the photo
  // changed (trashed, quarantined, flagged, moved) between the route's pre-filter and the insert.
  // The gate uses one message for pending, trashed and quarantined photos (quarantine is never
  // disclosed).
  [
    "photo does not belong to the share link's baby",
    () => new ApiError(409, "conflict", "That photo isn't part of this album"),
  ],
  ...[
    "only approved, non-deleted photos can be shared",
    "sensitive photos are never auto-shared",
    "only analysed photos can be auto-shared",
    "photo was removed from this album by an admin",
    "only hand-picked photos can be shown to family",
    "a sensitive photo can only be shown by the admin releasing it",
  ].map(
    (prefix) =>
      [
        prefix,
        () => new ApiError(409, "conflict", "That photo can't be shared right now"),
      ] as const,
  ),
  // Step 9 (packages/db/migrations/1792200000100_native-push.sql; docs/plans/step-9.md 2.8, 2.9).
  // `register_push_device` re-checks what `pushDeviceRegisterRequestSchema` already validated,
  // so these are tripwires. Fixed messages; the token is never echoed. Listed before the generic
  // `<table>.<column>` rule so each names its field.
  [
    "push registration has an invalid platform or provider",
    () =>
      new ApiError(400, "validation_failed", "The device platform and provider don't match", {
        fields: ["body.provider"],
      }),
  ],
  [
    "push_devices.token has an invalid shape",
    () =>
      new ApiError(400, "validation_failed", "The device token is invalid", {
        fields: ["body.token"],
      }),
  ],
  [
    "push_devices.app_version has an invalid shape",
    () =>
      new ApiError(400, "validation_failed", "The app version is invalid", {
        fields: ["body.appVersion"],
      }),
  ],
  // Review fixes (packages/db/migrations/1792300000200_data-exports.sql; docs/plans/
  // review-fixes.md 2.5). The export request's own outcomes: in progress, rate limit, trashed.
  ["an export is already in progress for this album", () => exportInProgress()],
  ["export rate limit reached", () => exportRateLimited()],
  ["cannot export a trashed album", () => babyTrashed()],
  // `data_exports_user_update_guard`: the API only shortens expiry (`LEAST`) and moves the
  // counter forward, so these are tripwires.
  [
    "an export cannot be extended",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
  [
    "export download history cannot be rewritten",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
  // `photos_user_write_guard` (1792300000100_review-hardening.sql, D13): the database pins the
  // approver; the API never writes another one, so this is a tripwire.
  [
    "approved_by and approved_at are set by the database",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
  // Step 10 (packages/db/migrations/1792300000300_photo-import.sql; docs/plans/step-10.md 2.6).
  // Listed before the generic `<table>.<column>` rule: the `google_accounts` shape messages are
  // server bugs (the API builds every value), never input errors.
  ["import source limit reached", () => importSourceLimit()],
  ["cannot sync into a trashed album", () => babyTrashed()],
  ["cannot import into a trashed album", () => babyTrashed()],
  ["an import is already in progress for this album", () => importInProgress()],
  ["import rate limit reached", () => importRateLimited()],
  [
    "import batch transition not allowed",
    () => new ApiError(409, "conflict", "This import has already moved on"),
  ],
  [
    "import_sources counters must be zero or more",
    () =>
      new ApiError(400, "validation_failed", "The request is invalid", {
        fields: ["body"],
      }),
  ],
  ["google_accounts.", () => internalError()],
  ["import item must belong to an active batch", () => internalError()],
];

/**
 * `insufficient_privilege` raised with a fixed message by a SECURITY DEFINER function (not a
 * grant or RLS failure), mapped by prefix. Anything else with 42501 stays 403 `forbidden`.
 */
const PRIVILEGE_VIOLATIONS: ReadonlyArray<readonly [string, () => ApiError]> = [
  // Step 9 `register_push_device`: the claims' GoTrue session is gone or idle past 90 days
  // (`withClaims` checked liveness a moment earlier, so this is a race or an idle session).
  [
    "push registration needs a session",
    () => new ApiError(401, "session_revoked", "You were signed out on this device"),
  ],
  // The profile is missing or deleted (`requireConsent` ran first, so this is a race).
  [
    "push registration needs a profile",
    () => new ApiError(403, "consent_required", "Accept the Terms and Privacy Policy to continue"),
  ],
  // `photos_user_write_guard` (D13): a contributor tried to change a photo's sensitivity or
  // approval (the routes check the role first; this is the database's answer to a race or bug).
  [
    "contributors may only trash their own pending uploads",
    () => forbidden("Only an admin of this album can do that"),
  ],
];

/**
 * Shape triggers on parent-text and input columns (`<table>_shape`, step 5) raise 23514 with a
 * fixed message starting `<table>.<column>` (e.g. `photo_details.note is longer than 2000
 * characters`) and naming no value: those are input errors, 400 `validation_failed`, never echoed.
 */
const SHAPE_MESSAGE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]* /;
/** Shape messages that do not follow the `<table>.<column>` pattern. */
const SHAPE_MESSAGE_PREFIXES: readonly string[] = ["measurements values must be positive"];
/** Remaining plain CHECK constraints on these tables are input-shape errors too (by `table`). */
const INPUT_CHECK_TABLES: ReadonlySet<string> = new Set(["photo_details", "measurements"]);

/** 23505 by constraint name; anything else is the generic 409. */
const UNIQUE_VIOLATIONS: ReadonlyMap<string, () => ApiError> = new Map([
  // Also raised by the `milestones_name_guard` trigger for a custom name equal to a preset's.
  [
    "milestones_baby_id_lower_name_key",
    () => new ApiError(409, "conflict", "A milestone with that name already exists"),
  ],
  // Backstop of `data_exports_rate_limit` (two concurrent requests; the trigger normally wins).
  ["data_exports_one_active_per_baby", () => exportInProgress()],
  // Backstop of `import_batches_one_active` (step 10).
  ["import_batches_one_active_per_baby", () => importInProgress()],
]);

/**
 * 409 `free_tier_limit` (DB trigger `photos_free_tier_cap` and the API pre-checks). From step 11
 * (docs/plans/step-11.md 2.2 B, 2.9) the 1,000 photos are a per-family pool of approved photos
 * shared by every free, live album of the family (pending photos never count). Step 12 (Q3,
 * docs/plans/step-12.md 2.4, 2.11): `kind = "video"` is the per-family video count
 * (`photos_free_tier_video_cap`, `free_tier_video_limit()`), reported as `details.kind`.
 */
export const freeTierLimit = (kind: "photo" | "video" = "photo") =>
  kind === "video"
    ? new ApiError(
        409,
        "free_tier_limit",
        `Your family's free albums already hold ${FREE_TIER_VIDEO_LIMIT} videos. Upgrade to Plus or delete videos to add more.`,
        { kind: "video" },
      )
    : new ApiError(
        409,
        "free_tier_limit",
        "Your family's free albums are full: free albums hold 1,000 photos per family. Upgrade to Plus or delete photos to add more.",
      );

// Step 11 (docs/plans/step-11.md 2.4, 2.5, 2.9, D-B, D-J): family-start refusals, the
// one-family-per-parent rule, the guest pending cap and suspension. Messages name no address
// except the masked hint of `inboxHasFamily`.

/**
 * 409 `inbox_has_family` at family start (`POST /babies`, `babies_set_family` inbox arbiter):
 * another live account with the same canonical address is already a parent. `existingEmailMasked`
 * must already be masked (`maskEmail`); it is the only address ever echoed. `null` (hint
 * unreadable, or the generic trigger mapping) omits it from both the message and `details`.
 */
export const inboxHasFamily = (existingEmailMasked: string | null) =>
  existingEmailMasked
    ? new ApiError(
        409,
        "inbox_has_family",
        `Another Tinyglow account for this inbox (${existingEmailMasked}) already has a family. Sign in with that account to add an album, or use a different email.`,
        { existingEmailMasked } satisfies InboxHasFamilyDetails,
      )
    : new ApiError(
        409,
        "inbox_has_family",
        "Another Tinyglow account for this inbox already has a family. Sign in with that account to add an album, or use a different email.",
      );

/** 400 `email_not_allowed`: starting a family (first album) from a disposable domain. */
export const emailNotAllowed = () =>
  new ApiError(
    400,
    "email_not_allowed",
    "Temporary or disposable email addresses can't start a family. Use your regular email address, or join a family as a guest.",
  );

/** 429 `family_limited` + `Retry-After`: `FAMILIES_PER_IP_PER_DAY` reached for this network. */
export const familyLimited = (retryAfterSec: number) =>
  new ApiError(
    429,
    "family_limited",
    "Too many new families were started from your network today. Try again tomorrow, or join a family as a guest.",
    undefined,
    { retryAfterSec },
  );

/**
 * 409 `already_parent_elsewhere` (`baby_members_one_family`): an admin-invite accept or a
 * promotion would make the account a parent in a second family.
 */
export const alreadyParentElsewhere = () =>
  new ApiError(
    409,
    "already_parent_elsewhere",
    "This account is already a parent in another family. Use a different account to be a parent here, or join as a guest.",
  );

/**
 * 409 `pending_limit` (`photos_pending_cap` and the upload/import pre-checks): the caller's live
 * pending photos in this family reached `public.pending_photo_limit()`. `details` only when the
 * caller knows the counts.
 */
export const pendingLimit = (counts?: PendingLimitDetails) =>
  counts
    ? new ApiError(
        409,
        "pending_limit",
        `You have ${counts.pending} photos waiting for approval in this family (the most is ${counts.limit}). Wait for a parent to review them before adding more.`,
        { pending: counts.pending, limit: counts.limit } satisfies PendingLimitDetails,
      )
    : new ApiError(
        409,
        "pending_limit",
        "You have the most photos waiting for approval in this family. Wait for a parent to review them before adding more.",
      );

/** 403 `account_suspended`: an operator suspended the account (`admin:suspend`). */
export const accountSuspended = () =>
  new ApiError(
    403,
    "account_suspended",
    `This account has been suspended. Contact ${SUPPORT_EMAIL}.`,
  );

function isInputCheck(err: PgErrorLike): boolean {
  if (SHAPE_MESSAGE.test(err.message)) return true;
  if (SHAPE_MESSAGE_PREFIXES.some((prefix) => err.message.startsWith(prefix))) return true;
  return err.table !== undefined && INPUT_CHECK_TABLES.has(err.table);
}

/**
 * Map a Postgres error to an `ApiError`. SQLSTATE `23514` by trigger message (then any
 * `<table>.<column> …` shape-trigger message → 400), `42501` by function message, else 403
 * `forbidden` (privilege or RLS `WITH CHECK` failure), `23505` → 409 `conflict` (by constraint name when known), `23503` → 409
 * (a referenced row vanished concurrently); anything else → 500 `internal`. The result never
 * carries the SQL, parameters or the original message.
 */
export function mapPgError(err: PgErrorLike): ApiError {
  switch (err.code) {
    case "23514": {
      const hit = CHECK_VIOLATIONS.find(([prefix]) => err.message.startsWith(prefix));
      if (hit) return hit[1]();
      if (isInputCheck(err)) {
        return new ApiError(400, "validation_failed", "The request is invalid");
      }
      return internalError();
    }
    case "42501": {
      const hit = PRIVILEGE_VIOLATIONS.find(([prefix]) => err.message.startsWith(prefix));
      return hit ? hit[1]() : forbidden();
    }
    case "23505": {
      const known = err.constraint ? UNIQUE_VIOLATIONS.get(err.constraint) : undefined;
      return known ? known() : new ApiError(409, "conflict", "That already exists");
    }
    case "23503":
      return new ApiError(409, "conflict", "That conflicts with the current state");
    default:
      return internalError();
  }
}

/** Field paths of a validation failure, never the received values. */
function zodIssuePaths(err: ZodError): string[] {
  return [...new Set(err.issues.map((i) => i.path.map(String).join(".") || "(root)"))];
}

function fastifyValidationPaths(err: FastifyError): string[] {
  const out = new Set<string>();
  for (const v of err.validation ?? []) {
    const ctx = err.validationContext ?? "body";
    const raw = (v as { instancePath?: string }).instancePath ?? "";
    const path = raw.replace(/^\//, "").replaceAll("/", ".");
    out.add(path ? `${ctx}.${path}` : ctx);
  }
  return [...out];
}

const STATUS_FALLBACK: Readonly<Record<number, readonly [ApiErrorCode, string]>> = {
  400: ["validation_failed", "The request is invalid"],
  401: ["unauthorized", "Sign in to continue"],
  403: ["forbidden", "You don't have access to that"],
  404: ["not_found", "Not found"],
  405: ["not_found", "Not found"],
  406: ["validation_failed", "The request is invalid"],
  409: ["conflict", "That conflicts with the current state"],
  413: ["validation_failed", "The request is too large"],
  415: ["validation_failed", "Unsupported content type"],
  429: ["rate_limited", "Too many requests, try again later"],
};

/** Convert anything thrown into an `ApiError`. Exported for unit tests. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    return new ApiError(400, "validation_failed", "The request is invalid", {
      fields: zodIssuePaths(err),
    });
  }
  if (isPgError(err)) return mapPgError(err);
  if (typeof err === "object" && err !== null) {
    const fe = err as FastifyError;
    if (Array.isArray(fe.validation)) {
      return new ApiError(400, "validation_failed", "The request is invalid", {
        fields: fastifyValidationPaths(fe),
      });
    }
    const status = typeof fe.statusCode === "number" ? fe.statusCode : 500;
    if (status >= 400 && status < 500) {
      const [code, message] = STATUS_FALLBACK[status] ?? [
        "validation_failed",
        "The request is invalid",
      ];
      return new ApiError(status, code, message);
    }
  }
  return internalError();
}

/**
 * Log-safe description of an error. Postgres errors: SQLSTATE and schema identifiers only (their
 * messages can quote input values). ApiErrors: code. Anything else: name, code and stack, which
 * come from our own code paths (never put secrets, emails or claims in an Error message).
 */
export function safeErrorLog(err: unknown): Record<string, unknown> {
  if (err instanceof ApiError) return { name: err.name, code: err.code, status: err.status };
  if (isPgError(err)) {
    return {
      name: "DatabaseError",
      sqlstate: err.code,
      constraint: err.constraint,
      table: err.table,
      column: err.column,
      routine: err.routine,
    };
  }
  if (err instanceof ZodError) return { name: "ZodError", fields: zodIssuePaths(err) };
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, code: typeof code === "string" ? code : undefined, stack: err.stack };
  }
  return { name: typeof err };
}

function send(reply: FastifyReply, apiErr: ApiError) {
  if (apiErr.retryAfterSec !== undefined) reply.header("retry-after", String(apiErr.retryAfterSec));
  return reply.code(apiErr.status).type("application/json; charset=utf-8").send(apiErr.toBody());
}

/**
 * Global error and not-found handlers. Register on the root instance before any routes; child
 * plugins inherit them. Response bodies are already in `apiErrorSchema` shape; we bypass route
 * response schemas by serializing directly.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const apiErr = toApiError(err);
    if (apiErr.status >= 500) {
      request.log.error({ err: safeErrorLog(err) }, "request failed");
    } else {
      request.log.debug({ code: apiErr.code, status: apiErr.status }, "request rejected");
    }
    return send(reply, apiErr);
  });

  app.setNotFoundHandler((_request, reply) => send(reply, notFound()));
}
