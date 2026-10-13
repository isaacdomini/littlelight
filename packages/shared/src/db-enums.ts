import { z } from "zod";

// Enum-like DB columns (docs/plans/step-2.md 2.4, 2.11). In SQL these are `text` columns with a
// `CHECK (col IN (...))` constraint; the values here must match those constraints literally, in
// the same order, so API validation and the database agree. Changing a value here requires a
// migration (and vice versa).

/** `baby_members.role`, `invites.role`. Max two admins per baby (`MAX_ADMINS_PER_BABY`). */
export const babyRoleSchema = z.enum(["admin", "contributor"]);
export type BabyRole = z.infer<typeof babyRoleSchema>;

/** `babies.plan`. AI features require `plus` with a live entitlement. */
export const planSchema = z.enum(["free", "plus"]);
export type Plan = z.infer<typeof planSchema>;

/** `profiles.units`: display preference only; storage is always metric. */
export const unitsSchema = z.enum(["metric", "imperial"]);
export type Units = z.infer<typeof unitsSchema>;

/**
 * `photos.status`. `queued`/`analyzing` are only reachable for approved, non-deleted photos of a
 * baby with AI enabled (enforced by the `photos_status_guard` trigger). `duplicate` (step 4) is a
 * transient marker set by ingest right before an exact duplicate's row is hard-deleted.
 */
export const photoStatusSchema = z.enum([
  "uploaded",
  "ingested",
  "queued",
  "analyzing",
  "ready",
  "failed",
  "duplicate",
]);
export type PhotoStatus = z.infer<typeof photoStatusSchema>;

/** `photos.approval`. Contributor uploads start `pending` (FR-2.7). */
export const photoApprovalSchema = z.enum(["pending", "approved", "rejected"]);
export type PhotoApproval = z.infer<typeof photoApprovalSchema>;

/**
 * `photos.media_kind`, `upload_files.media_kind`, `import_items.media_kind` (docs/plans/step-12.md
 * 2.2). A video is one **item** of the family's free pool, like a photo.
 */
export const mediaKindSchema = z.enum(["photo", "video"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/** The image part of `photos.mime` (photo-only call sites: EXIF, sharp decode). */
export const photoMimeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);
export type PhotoMime = z.infer<typeof photoMimeSchema>;

/** The video part of `photos.mime` (step 12): MP4 and QuickTime containers, H.264 or HEVC inside. */
export const videoMimeSchema = z.enum(["video/mp4", "video/quicktime"]);
export type VideoMime = z.infer<typeof videoMimeSchema>;

/**
 * `photos.mime` (the `photos_mime_check` CHECK since migration 22): photo mimes then video mimes,
 * in CHECK order. DTO fields carrying `photos.mime` use this; `photoMimeSchema` stays for
 * photo-only code paths.
 */
export const mediaMimeSchema = z.enum([...photoMimeSchema.options, ...videoMimeSchema.options]);
export type MediaMime = z.infer<typeof mediaMimeSchema>;

/**
 * `photo_derivatives.kind`. All derivatives are EXIF/GPS/QuickTime-tag-stripped; `analysis` (and,
 * for videos, `keyframe1..3`) are the only copies that may ever reach a model; viewers only ever
 * get `thumb`/`display` and, for videos, the `web` rendition (H.264/AAC MP4, ≤ 1080p). For a
 * video, `thumb`/`display`/`analysis` are its poster frame.
 */
export const derivativeKindSchema = z.enum([
  "thumb",
  "display",
  "analysis",
  "web",
  "keyframe1",
  "keyframe2",
  "keyframe3",
]);
export type DerivativeKind = z.infer<typeof derivativeKindSchema>;

/** The JPEG derivative kinds of every item (poster frame for a video); `DERIVATIVE_LONG_EDGE` keys. */
export const imageDerivativeKindSchema = z.enum(["thumb", "display", "analysis"]);
export type ImageDerivativeKind = z.infer<typeof imageDerivativeKindSchema>;

/**
 * `photos.rendition_status` (step 12): `none` for photos; a video is `pending` from upload
 * complete until `video.transcode` wrote the `web` rendition (`ready`) or gave up (`failed`:
 * poster, original download and export still work).
 */
export const renditionStatusSchema = z.enum(["none", "pending", "ready", "failed"]);
export type RenditionStatus = z.infer<typeof renditionStatusSchema>;

/** `photos.video_codec`: the original's codec as probed (the `web` rendition is always h264). */
export const videoCodecSchema = z.enum(["h264", "hevc"]);
export type VideoCodec = z.infer<typeof videoCodecSchema>;

/**
 * `measurements.kind`. Convention for `measurements.value_metric`: **grams** for `weight`,
 * **millimetres** for `height` and `head`. `value_entered` + `unit_entered` keep what the parent
 * typed for display.
 */
export const measurementKindSchema = z.enum(["weight", "height", "head"]);
export type MeasurementKind = z.infer<typeof measurementKindSchema>;

/** `measurements.unit_entered`. */
export const measurementUnitSchema = z.enum(["g", "kg", "oz", "lb", "mm", "cm", "in"]);
export type MeasurementUnit = z.infer<typeof measurementUnitSchema>;

/** `milestones.category`. */
export const milestoneCategorySchema = z.enum([
  "social",
  "motor",
  "feeding",
  "growth",
  "speech",
  "event",
  "custom",
]);
export type MilestoneCategory = z.infer<typeof milestoneCategorySchema>;

/** `ai_batches.status`. */
export const aiBatchStatusSchema = z.enum([
  "building",
  "submitted",
  "in_progress",
  "completed",
  "failed",
  "expired",
  "cancelled",
]);
export type AiBatchStatus = z.infer<typeof aiBatchStatusSchema>;

/**
 * `ai_batch_items.state` (one row per photo per attempt, docs/plans/step-6.md 2.3): `pending`
 * (claimed into a `building` batch), `submitted`, `succeeded` (`photo_ai` written), `failed`
 * (counts toward `AI_MAX_ATTEMPTS`), `dropped` (removed before submit: the baby is no longer paid
 * or the photo is no longer live; not an attempt).
 */
export const aiBatchItemStateSchema = z.enum([
  "pending",
  "submitted",
  "succeeded",
  "failed",
  "dropped",
]);
export type AiBatchItemState = z.infer<typeof aiBatchItemStateSchema>;

/**
 * `ai_batch_items.failure_kind`: an error category only, never prompt text, notes or provider
 * messages. `budget` = skipped by the per-baby monthly budget.
 */
export const aiFailureKindSchema = z.enum([
  "refusal",
  "invalid_output",
  "expired",
  "rate_limited",
  "provider_error",
  "budget",
]);
export type AiFailureKind = z.infer<typeof aiFailureKindSchema>;

/** `share_rules.mode`. No `share_rules` row means manual sharing only. */
export const shareRuleModeSchema = z.enum(["all", "milestones", "tags"]);
export type ShareRuleMode = z.infer<typeof shareRuleModeSchema>;

/** `shared_photos.added_by`. Sensitive photos are never added by `rule` (FR-9.5). */
export const sharedPhotoAddedBySchema = z.enum(["user", "rule"]);
export type SharedPhotoAddedBy = z.infer<typeof sharedPhotoAddedBySchema>;

/**
 * Derived share-link state (not a column; docs/plans/step-8.md 2.5): `revoked` when
 * `revoked_at` is set, else `expired` when `expires_at <= now()`, else `active`. Viewers of a
 * non-active link get 410 `share_link_expired`.
 */
export const shareLinkStatusSchema = z.enum(["active", "expired", "revoked"]);
export type ShareLinkStatus = z.infer<typeof shareLinkStatusSchema>;

/** `chat_messages.role`. */
export const chatRoleSchema = z.enum(["user", "assistant", "tool", "system"]);
export type ChatRole = z.infer<typeof chatRoleSchema>;

/**
 * `chat_messages.status` (docs/plans/step-7.md 2.3.8): `error` marks an assistant message written
 * after a model/tool failure (fixed text, no provider message).
 */
export const chatMessageStatusSchema = z.enum(["complete", "error"]);
export type ChatMessageStatus = z.infer<typeof chatMessageStatusSchema>;

/**
 * `ai_spend.kind` (docs/plans/step-7.md 2.3.6): spend that is not a vision batch item. `embed`
 * (worker, search documents), `chat` (one row per assistant turn), `rerank` (optional LLM re-rank).
 */
export const aiSpendKindSchema = z.enum(["embed", "chat", "rerank"]);
export type AiSpendKind = z.infer<typeof aiSpendKindSchema>;
