import { z } from "zod";

// pg-boss job names (queues) and payloads (docs/plans/step-4.md 2.5, docs/plans/step-5.md 2.5).
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
 * measurement, an AI field override (step 6), or a backfill/reconcile (step 7).
 */
export const REINDEX_REASONS = [
  "details",
  "milestone",
  "measurement",
  "ai_override",
  "backfill",
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
