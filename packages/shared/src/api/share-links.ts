import { z } from "zod";
import {
  SHARE_LINK_DEFAULT_TTL_HOURS,
  SHARE_LINK_MAX_TTL_HOURS,
  SHARE_LINK_NAME_MAX_CHARS,
  SHARE_LINK_TTL_CHOICES_HOURS,
  SHARE_RULE_TAGS_MAX,
} from "../constants";
import { sharedPhotoAddedBySchema, shareLinkStatusSchema, shareRuleModeSchema } from "../db-enums";
import { shareTagSchema } from "../share-rules";
import { isoDateTimeSchema } from "./common";
import { PHOTO_BATCH_MAX, photoSummarySchema } from "./photos";
import { shareCursorSchema, sharePasscodeSchema, shareUrlSchema } from "./share-viewer";

// Admin share-link contracts (PRD "FR-9 Sharing", "Roles and permissions": create/renew/revoke
// links are admin-only; docs/plans/step-8.md 2.4, 2.5). Routes: `/babies/:id/share-links`,
// `/share-links/:id…`, `/photos/:id/share-links`. Contributors get 403 `forbidden`, strangers 404.
// Browser-safe.
//
// Rules:
// - The token is shown once (D1): only `shareLinkCreatedResponse` (create and regenerate) carries
//   the URL. No other response, log line or audit row contains the token, its hash, the passcode
//   or the passcode hash; `hasPasscode` is the only passcode fact a client ever sees.
// - Request bodies are strict (an unknown key is a 400, so a misspelt `passcode` can never be
//   silently dropped). Response schemas strip, like every parent DTO.
// - Auto-share rules are Plus-only (D3): a free baby gets 403 `plan_required` (DB-enforced too).
// - Sharing is free (FR-5.8): manual add/remove works on every baby.

/** Expiry in whole hours, 1..`SHARE_LINK_MAX_TTL_HOURS` (30 days, D2). */
export const shareLinkTtlHoursSchema = z.number().int().min(1).max(SHARE_LINK_MAX_TTL_HOURS);

/** One of the UI's expiry choices (24 h, 3 d, 7 d, 30 d). The API accepts any `shareLinkTtlHours`. */
export const shareLinkTtlChoiceSchema = z.literal(SHARE_LINK_TTL_CHOICES_HOURS);

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/** A link name ("Grandparents"): NFC, trimmed, 1..80 chars, no control characters. Shown to viewers. */
export const shareLinkNameSchema = z
  .string()
  .normalize("NFC")
  .trim()
  .min(1)
  .max(SHARE_LINK_NAME_MAX_CHARS)
  .refine((s) => !CONTROL_CHAR_RE.test(s), "must not contain control characters");

const tagListSchema = z
  .array(shareTagSchema)
  .max(SHARE_RULE_TAGS_MAX)
  .transform((tags) => [...new Set(tags)]);

/** Route params `/share-links/:id/photos/:photoId`. */
export const shareLinkPhotoParamsSchema = z.object({ id: z.uuid(), photoId: z.uuid() });
export type ShareLinkPhotoParams = z.infer<typeof shareLinkPhotoParamsSchema>;

// ---------------------------------------------------------------------------------------------
// Auto-share rules (FR-9.4; one per link; Plus only)
// ---------------------------------------------------------------------------------------------

/**
 * `PUT /share-links/:id/rule` body (and `rule` on create). `mode`: `all` photos, only photos with
 * a parent-tagged `milestones`, or photos with any of `includeTags`; `excludeTags` always win.
 * Tags are normalized (`normalizeShareTag`) and de-duplicated; `includeTags` only matter for
 * `tags` mode, which needs at least one. Sensitive and unanalysed photos never match
 * (`shareRuleMatches`, and the database gate).
 */
export const shareRuleInputSchema = z
  .strictObject({
    mode: shareRuleModeSchema,
    includeTags: tagListSchema.default([]),
    excludeTags: tagListSchema.default([]),
  })
  .refine((r) => r.mode !== "tags" || r.includeTags.length > 0, {
    path: ["includeTags"],
    message: "Pick at least one tag",
  });
export type ShareRuleInput = z.infer<typeof shareRuleInputSchema>;

/** A stored rule. `evaluatedAt`: when the worker last synced the whole album (null until then). */
export const shareRuleSchema = z.object({
  mode: shareRuleModeSchema,
  includeTags: z.array(z.string()),
  excludeTags: z.array(z.string()),
  updatedAt: isoDateTimeSchema,
  evaluatedAt: isoDateTimeSchema.nullable(),
});
export type ShareRule = z.infer<typeof shareRuleSchema>;

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/** One link as its admins see it (FR-9.8 minimal: visits, last visit, active viewers; D15). */
export const shareLinkSchema = z.object({
  id: z.uuid(),
  babyId: z.uuid(),
  name: z.string(),
  status: shareLinkStatusSchema,
  expiresAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
  /** The duration "Renew" re-applies. */
  ttlHours: shareLinkTtlHoursSchema,
  allowDownload: z.boolean(),
  hasPasscode: z.boolean(),
  /** `SHARE_PASSCODE_FAILURES_PER_LINK` failures in the last hour: viewers are locked out until it passes or the link is regenerated. */
  passcodeLocked: z.boolean(),
  rule: shareRuleSchema.nullable(),
  /** Photos in the album, hidden ones included. */
  photoCount: z.number().int().nonnegative(),
  /** Sensitive photos in the album not released with "Show to family". */
  hiddenCount: z.number().int().nonnegative(),
  /** Visits (one per viewer session per `SHARE_VISIT_GAP_MIN` of inactivity). */
  viewCount: z.number().int().nonnegative(),
  lastViewedAt: isoDateTimeSchema.nullable(),
  /** Viewer sessions neither revoked nor expired. */
  activeViewers: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  createdBy: z.uuid().nullable(),
});
export type ShareLink = z.infer<typeof shareLinkSchema>;

/** `GET /babies/:id/share-links`: newest first. */
export const shareLinksResponseSchema = z.object({ links: z.array(shareLinkSchema) });
export type ShareLinksResponse = z.infer<typeof shareLinksResponseSchema>;

/**
 * `POST /babies/:id/share-links` body. Expiry `now() + ttlHours` (default 24 h). `passcode`
 * null/absent = none. A `rule` on a free baby ⇒ 403 `plan_required` and nothing is created; at
 * `SHARE_LINKS_PER_BABY_MAX` links ⇒ 409 `conflict`.
 */
export const shareLinkCreateRequestSchema = z.strictObject({
  name: shareLinkNameSchema,
  ttlHours: shareLinkTtlHoursSchema.default(SHARE_LINK_DEFAULT_TTL_HOURS),
  passcode: sharePasscodeSchema.nullable().optional(),
  allowDownload: z.boolean().default(false),
  rule: shareRuleInputSchema.nullable().optional(),
});
export type ShareLinkCreateRequest = z.infer<typeof shareLinkCreateRequestSchema>;

/**
 * 201 from create, 200 from `POST /share-links/:id/regenerate`: the only responses carrying the
 * link URL (D1). Show it once, keep it in memory only; never store or log it.
 */
export const shareLinkCreatedResponseSchema = z.object({
  link: shareLinkSchema,
  url: shareUrlSchema,
});
export type ShareLinkCreatedResponse = z.infer<typeof shareLinkCreatedResponseSchema>;

/**
 * `PATCH /share-links/:id` → `shareLink`. Only provided keys change; at least one. `passcode`:
 * 6 digits sets or changes it (and ends every open viewer session), `null` clears it.
 * `ttlHours` changes what "Renew" applies, not the current expiry.
 */
export const shareLinkPatchRequestSchema = z
  .strictObject({
    name: shareLinkNameSchema.optional(),
    allowDownload: z.boolean().optional(),
    passcode: sharePasscodeSchema.nullable().optional(),
    ttlHours: shareLinkTtlHoursSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nothing to update",
  });
export type ShareLinkPatchRequest = z.infer<typeof shareLinkPatchRequestSchema>;

/**
 * `POST /share-links/:id/renew` body (may be empty or absent: parse `body ?? {}`) → `shareLink`.
 * Same token, `expiresAt = now() + (ttlHours ?? the link's ttlHours)`; a given `ttlHours` is also
 * stored. A revoked link ⇒ 409 `conflict` (regenerate instead; D13).
 */
export const shareLinkRenewRequestSchema = z.strictObject({
  ttlHours: shareLinkTtlHoursSchema.optional(),
});
export type ShareLinkRenewRequest = z.infer<typeof shareLinkRenewRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Album membership (FR-9.3, FR-8.4, FR-9.5; D4)
// ---------------------------------------------------------------------------------------------

const uniqueIds = (max: number) =>
  z
    .array(z.uuid())
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, "photoIds must be unique");

/**
 * `POST /share-links/:id/photos`. Approved, live photos of the link's baby are added as
 * hand-picked (`added_by = 'user'`; a rule row becomes hand-picked). Sensitive photos are added
 * **hidden** unless `showSensitive` is true (an explicit admin release, audited per photo).
 */
export const shareLinkPhotosAddRequestSchema = z.strictObject({
  photoIds: uniqueIds(PHOTO_BATCH_MAX),
  showSensitive: z.boolean().default(false),
});
export type ShareLinkPhotosAddRequest = z.infer<typeof shareLinkPhotosAddRequestSchema>;

/** Why a photo was not added. */
export const shareLinkSkipReasonSchema = z.enum(["not_found", "not_approved", "trashed"]);
export type ShareLinkSkipReason = z.infer<typeof shareLinkSkipReasonSchema>;

export const shareLinkPhotosAddResponseSchema = z.object({
  added: z.number().int().nonnegative(),
  alreadyShared: z.number().int().nonnegative(),
  /** Sensitive photos added without `showSensitive`: family sees a hidden tile. */
  hidden: z.number().int().nonnegative(),
  skipped: z.array(z.object({ photoId: z.uuid(), reason: shareLinkSkipReasonSchema })),
});
export type ShareLinkPhotosAddResponse = z.infer<typeof shareLinkPhotosAddResponseSchema>;

/**
 * `POST /share-links/:id/photos/remove`: removes the photos (hand-picked or rule-added) and
 * records exclusions so the link's rule never re-adds them (D5).
 */
export const shareLinkPhotosRemoveRequestSchema = z.strictObject({
  photoIds: uniqueIds(PHOTO_BATCH_MAX),
});
export type ShareLinkPhotosRemoveRequest = z.infer<typeof shareLinkPhotosRemoveRequestSchema>;

export const shareLinkPhotosRemoveResponseSchema = z.object({
  removed: z.number().int().nonnegative(),
});
export type ShareLinkPhotosRemoveResponse = z.infer<typeof shareLinkPhotosRemoveResponseSchema>;

/**
 * `PATCH /share-links/:id/photos/:photoId`: `true` = "Show to family" (release a sensitive photo
 * to this link's viewers), `false` = hide it again. 404 when the photo is not in the album.
 */
export const shareLinkPhotoPatchRequestSchema = z.strictObject({
  showSensitive: z.boolean(),
});
export type ShareLinkPhotoPatchRequest = z.infer<typeof shareLinkPhotoPatchRequestSchema>;

/** `GET /share-links/:id/photos` query (strings coerced). */
export const shareLinkPhotosQuerySchema = z.object({
  cursor: shareCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ShareLinkPhotosQuery = z.infer<typeof shareLinkPhotosQuerySchema>;

/** A photo of the album as its admins see it (signed thumb, like the timeline). */
export const shareLinkPhotoSchema = photoSummarySchema.extend({
  sharedBy: sharedPhotoAddedBySchema,
  /** Sensitive and not released: viewers see a hidden tile. */
  hiddenFromViewers: z.boolean(),
  addedAt: isoDateTimeSchema,
});
export type ShareLinkPhoto = z.infer<typeof shareLinkPhotoSchema>;

/** Newest first (`sort_at DESC, id DESC`). */
export const shareLinkPhotosResponseSchema = z.object({
  photos: z.array(shareLinkPhotoSchema),
  nextCursor: z.string().nullable(),
});
export type ShareLinkPhotosResponse = z.infer<typeof shareLinkPhotosResponseSchema>;

/**
 * `GET /photos/:id/share-links` (admins): every link of the photo's baby with this photo's
 * membership, for the add/remove sheet's checked state.
 */
export const photoShareLinksResponseSchema = z.object({
  links: z.array(
    z.object({
      shareLinkId: z.uuid(),
      name: z.string(),
      status: shareLinkStatusSchema,
      shared: z.boolean(),
      sharedBy: sharedPhotoAddedBySchema.nullable(),
      hiddenFromViewers: z.boolean(),
      /** An admin removed it from this link; the rule will not re-add it. */
      excluded: z.boolean(),
    }),
  ),
});
export type PhotoShareLinksResponse = z.infer<typeof photoShareLinksResponseSchema>;
