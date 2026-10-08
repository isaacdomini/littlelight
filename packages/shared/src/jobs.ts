import { z } from "zod";

// pg-boss job names (queues) and payloads (docs/plans/step-4.md 2.5). The worker owns queue
// creation and scheduling; the API only sends `photo.ingest`. Names live here so every producer
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
