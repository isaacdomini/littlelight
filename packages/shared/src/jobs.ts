import { z } from "zod";

// pg-boss job names (queues) and payloads (docs/plans/step-4.md 2.5, docs/plans/step-5.md 2.5,
// docs/plans/step-6.md 2.4, docs/plans/step-7.md 2.4).
// The worker owns queue creation and scheduling; the API sends `photo.ingest` and
// `photo.reindex`. Names live here so every producer
// and consumer refers to one constant, never a string literal. Payloads carry ids and a time
// zone name only: never photo bytes, object keys with signatures, GPS, emails or parent notes.

export const JOBS = {
  /** Per photo, sent by the api after upload complete and by `ingest.reconcile`. */
  ingest: "photo.ingest",
  /** Cron `*\/5 * * * *`: re-sends `photo.ingest` for photos stuck in `uploaded`. */
  ingestReconcile: "ingest.reconcile",
  /**
   * Cron `7 * * * *`: hard-deletes babies and photos trashed more than 30 days ago (FR-10.2,
   * FR-10.3) as `pipeline`, including every MinIO object version, plus leftover duplicates and
   * orphaned upload objects.
   */
  purgeTrash: "purge.trash",
  /** Cron `23,53 * * * *`: aborts expired upload sessions' multipart uploads. */
  uploadsSweep: "uploads.sweep",
  /** Per photo, sent after commit of any edit that changes its search document (`reindexJobSchema`). */
  reindex: "photo.reindex",
  /**
   * Cron `AI_FLUSH_INTERVAL_CRON` (default `*\/5 * * * *`), singleton: claims eligible photos of
   * paid babies into the `building` batch and submits it at `AI_BATCH_MAX_PHOTOS` photos or
   * `AI_BATCH_FLUSH_MINUTES` age (`aiFlushJobSchema`; docs/plans/step-6.md 2.6).
   */
  aiFlush: "ai.flush",
  /** Cron `AI_POLL_INTERVAL_CRON` (default `*\/5 * * * *`), singleton: polls submitted batches (`aiPollJobSchema`). */
  aiPoll: "ai.poll",
  /** On demand: upgrade backfill, prompt/schema version backfill or a manual forced flush (`aiBackfillJobSchema`). */
  aiBackfill: "ai.backfill",
  /**
   * Cron `SEARCH_RECONCILE_CRON` (default `17 * * * *`), singleton, no payload
   * (`searchReconcileJobSchema`): re-indexes stale/missing `photo_search` rows of paid babies
   * (`search_stale_photos()`) and deletes orphans (docs/plans/step-7.md 2.6).
   */
  searchReconcile: "search.reconcile",
  /**
   * On demand (`searchBackfillJobSchema`, singleton key `babyId ?? "all"`): after a plan upgrade
   * (sent when the `ai.backfill` upgrade completes), after an embedding model / search document
   * version change, or by an operator.
   */
  searchBackfill: "search.backfill",
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** True when `tz` is an IANA time zone name the runtime knows (e.g. `America/New_York`, `UTC`). */
function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * `photo.ingest` payload. `tzHint` is the uploader's profile time zone, used to interpret EXIF
 * wall times without an offset tag (`pipeline` cannot read `profiles`). Strict: an unexpected
 * key (an object key, a note, coordinates) fails the producer instead of reaching pg-boss.
 */
export const ingestJobSchema = z.strictObject({
  photoId: z.uuid(),
  babyId: z.uuid(),
  uploadFileId: z.uuid().optional(),
  tzHint: z.string().min(1).max(64).refine(isTimeZone, "must be an IANA time zone").optional(),
});
export type IngestJob = z.infer<typeof ingestJobSchema>;

/**
 * Why a photo's search document is stale: parent details, a milestone rename/delete, a linked
 * measurement, an AI field override (step 6), a backfill/reconcile (step 7), or a fresh
 * `photo_ai` row written by the AI poller (step 6).
 */
export const REINDEX_REASONS = [
  "details",
  "milestone",
  "measurement",
  "ai_override",
  "backfill",
  "ai",
] as const;
export const reindexReasonSchema = z.enum(REINDEX_REASONS);
export type ReindexReason = z.infer<typeof reindexReasonSchema>;

/**
 * `photo.reindex` payload: ids and a reason only (strict, like `ingestJobSchema`). Sent by the
 * api after commit, outside the claims transaction, with `singletonKey = photoId` on an
 * `exclusive` queue (`retryLimit 3`, `retryDelay 15`, `retryBackoff`, `expireInSeconds 300`).
 *
 * Contract for the handler (no-op in step 5; step 7 embeds):
 * - It re-reads everything at run time; the payload never carries details, notes or values.
 * - An edit that lands while a job for the same photo is `active` is dropped by the exclusive
 *   policy, so step 7 also runs a reconcile that re-embeds rows where `photo_search.updated_at <
 *   GREATEST(photo_details.updated_at, max(measurements.updated_at), milestones.updated_at)`;
 *   those `updated_at` columns are the durable "stale" signal.
 * - Free-tier babies: the handler checks `baby_ai_enabled` and returns without any model or
 *   embedding call.
 */
export const reindexJobSchema = z.strictObject({
  photoId: z.uuid(),
  babyId: z.uuid(),
  reason: reindexReasonSchema,
});
export type ReindexJob = z.infer<typeof reindexJobSchema>;

/**
 * `ai.flush` payload. Cron ticks send no data (handlers parse `job.data ?? {}`); `run-job` may
 * force an immediate submit, optionally for one baby. Strict: ids and a flag only.
 */
export const aiFlushJobSchema = z.strictObject({
  force: z.boolean().optional(),
  babyId: z.uuid().optional(),
});
export type AiFlushJob = z.infer<typeof aiFlushJobSchema>;

/** `ai.poll` payload: none (cron ticks send no data; handlers parse `job.data ?? {}`). */
export const aiPollJobSchema = z.strictObject({});
export type AiPollJob = z.infer<typeof aiPollJobSchema>;

/**
 * `ai.backfill` reasons: `upgrade` (FR-5.8: one backfill for a baby that just became paid),
 * `version` (FR-5.7: re-describe rows whose `(prompt_version, schema_version)` differ from the
 * current ones), `manual` (operator/gate: a forced flush).
 */
export const AI_BACKFILL_REASONS = ["upgrade", "version", "manual"] as const;
export const aiBackfillReasonSchema = z.enum(AI_BACKFILL_REASONS);
export type AiBackfillReason = z.infer<typeof aiBackfillReasonSchema>;

const versionTagSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/);

/**
 * `ai.backfill` payload (singleton key `babyId ?? "all"`). `promptVersion`/`schemaVersion`
 * narrow a `version` backfill to rows with those old versions. An `upgrade` names the baby.
 * The worker still applies the paid-tier eligibility check per photo; this payload can never
 * make a free-tier photo eligible.
 */
export const aiBackfillJobSchema = z
  .strictObject({
    babyId: z.uuid().optional(),
    reason: aiBackfillReasonSchema,
    promptVersion: versionTagSchema.optional(),
    schemaVersion: versionTagSchema.optional(),
  })
  .refine((job) => job.reason !== "upgrade" || job.babyId !== undefined, {
    path: ["babyId"],
    message: "required for an upgrade backfill",
  });
export type AiBackfillJob = z.infer<typeof aiBackfillJobSchema>;

/** `search.reconcile` payload: none (cron ticks send no data; handlers parse `job.data ?? {}`). */
export const searchReconcileJobSchema = z.strictObject({});
export type SearchReconcileJob = z.infer<typeof searchReconcileJobSchema>;

/**
 * `search.backfill` reasons: `upgrade` (FR-5.8: search follows a plan upgrade; names the baby),
 * `model` (every row whose `embed_model`/`doc_version` differ from the current ones, after an
 * `EMBED_MODEL` or `SEARCH_DOC_VERSION` change), `manual` (operator/gate: a plain reconcile, for one
 * baby or all).
 */
export const SEARCH_BACKFILL_REASONS = ["upgrade", "model", "manual"] as const;
export const searchBackfillReasonSchema = z.enum(SEARCH_BACKFILL_REASONS);
export type SearchBackfillReason = z.infer<typeof searchBackfillReasonSchema>;

/**
 * `search.backfill` payload: an optional baby id and a reason (strict). The indexer still checks
 * `baby_ai_enabled` per photo in SQL: this payload can never index a free-tier baby.
 */
export const searchBackfillJobSchema = z
  .strictObject({
    babyId: z.uuid().optional(),
    reason: searchBackfillReasonSchema,
  })
  .refine((job) => job.reason !== "upgrade" || job.babyId !== undefined, {
    path: ["babyId"],
    message: "required for an upgrade backfill",
  });
export type SearchBackfillJob = z.infer<typeof searchBackfillJobSchema>;
