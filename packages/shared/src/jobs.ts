import { z } from "zod";

// pg-boss job names (queues) and payloads (docs/plans/step-4.md 2.5, docs/plans/step-5.md 2.5,
// docs/plans/step-6.md 2.4, docs/plans/step-7.md 2.4, docs/plans/step-8.md 2.4,
// docs/plans/step-9.md 2.8).
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
  /**
   * On demand (`shareApplyJobSchema`, singleton key `shareLinkId`): full auto-share sync of one
   * link after its rule was set or changed (docs/plans/step-8.md 2.7). Sent by the api after
   * commit; no model call.
   */
  shareApply: "share.apply",
  /**
   * Cron `SHARE_RECONCILE_CRON` (default `41 * * * *`), singleton, no payload
   * (`shareReconcileJobSchema`): watermark sync of every auto-share rule.
   */
  shareReconcile: "share.reconcile",
  /**
   * On demand (`pushNotifyJobSchema`, `short` queue, singleton key `pushNotifySingletonKey`):
   * one push notification fan-out to a baby's admins (docs/plans/step-9.md 2.8). Sent by the
   * worker's reindex hook (`photos_analyzed`) and by the api after a new viewer session
   * (`share_viewed`), with a per-kind debounce as `startAfter`.
   */
  pushNotify: "push.notify",
  /**
   * On demand (`dataExportJobSchema`, singleton key `exportId`): builds one album export ZIP
   * (FR-10.1; docs/plans/review-fixes.md 2.3). Sent by the api after the request committed;
   * `exclusive`, `retryLimit 1`, `retryDelay 60`, `expireInSeconds 14400`. No model call.
   */
  dataExport: "data.export",
  /**
   * On demand (`importGoogleJobSchema`, singleton key `batchId`): one Google Picker batch import
   * (docs/plans/step-10.md 2.7). Sent by the api after the batch turned `queued` and re-sent by
   * `import.sweep`; `exclusive`, `retryLimit 2`, `retryDelay 60`, `expireInSeconds 7200`. No model
   * call.
   */
  importGoogle: "import.google",
  /**
   * Cron `37 * * * *`, singleton, no payload (`importSweepJobSchema`): expires abandoned picker
   * sessions, re-sends stuck `queued` batches, fails stale `running` ones, cleans orphaned objects
   * and applies item retention (docs/plans/step-10.md 2.7).
   */
  importSweep: "import.sweep",
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

/**
 * `share.apply` reasons: `rule_changed` (the api, after a rule was created or edited) or
 * `manual` (operator / `run-job`).
 */
export const SHARE_APPLY_REASONS = ["rule_changed", "manual"] as const;
export const shareApplyReasonSchema = z.enum(SHARE_APPLY_REASONS);
export type ShareApplyReason = z.infer<typeof shareApplyReasonSchema>;

/**
 * `share.apply` payload: the link id and a reason only (strict: never a token, passcode, link
 * name or tag). The worker re-reads the rule at run time and runs as `pipeline`, whose rights
 * (and `shared_photos_gate`) can never add a sensitive, unanalysed or free-tier photo.
 */
export const shareApplyJobSchema = z.strictObject({
  shareLinkId: z.uuid(),
  reason: shareApplyReasonSchema,
});
export type ShareApplyJob = z.infer<typeof shareApplyJobSchema>;

/** `share.reconcile` payload: none (cron ticks send no data; handlers parse `job.data ?? {}`). */
export const shareReconcileJobSchema = z.strictObject({});
export type ShareReconcileJob = z.infer<typeof shareReconcileJobSchema>;

/**
 * Queue name of push notifications (docs/plans/step-9.md 2.8): an alias of `JOBS.pushNotify`,
 * kept for the api's `enqueuePush`. Queue policy `short` (one queued job per
 * `pushNotifySingletonKey(job)`, so a burst coalesces), `retryLimit 2`, `retryDelay 30`,
 * `expireInSeconds 300`; `startAfter` = `PUSH_PHOTOS_DEBOUNCE_SEC` / `PUSH_SHARE_DEBOUNCE_SEC`.
 */
export const PUSH_NOTIFY_JOB = JOBS.pushNotify;

/**
 * `push.notify` payload: a kind and one id (strict: never a token, name, count or text). The
 * worker resolves recipients at run time through `push_targets` (admins, prefs on, live sessions;
 * `photos_analyzed` only for babies with AI enabled) and builds the text with `pushMessage`.
 * - `photos_analyzed`: sent by the worker's reindex hook for `reason: "ai"` batches, per baby.
 * - `share_viewed`: sent by the api after a viewer exchange created a new viewer session.
 */
export const pushNotifyJobSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("photos_analyzed"), babyId: z.uuid() }),
  z.strictObject({ kind: z.literal("share_viewed"), shareLinkId: z.uuid() }),
]);
export type PushNotifyJob = z.infer<typeof pushNotifyJobSchema>;

/** pg-boss `singletonKey` of a `push.notify` job: `${kind}:${id}`, so a burst coalesces. */
export function pushNotifySingletonKey(job: PushNotifyJob): string {
  return job.kind === "photos_analyzed"
    ? `${job.kind}:${job.babyId}`
    : `${job.kind}:${job.shareLinkId}`;
}

/**
 * Queue name of the data export (docs/plans/review-fixes.md 2.2, 2.3; PRD FR-10.1): an alias of
 * `JOBS.dataExport`. Queue policy `exclusive`, `singletonKey = exportId`
 * (`dataExportSingletonKey`), `retryLimit 1`, `retryDelay 60`, `expireInSeconds 14400`.
 */
export const DATA_EXPORT_JOB = JOBS.dataExport;

/**
 * `data.export` payload: ids only (strict). The worker re-reads the `data_exports` row (status,
 * `include_location`, requester) and every photo at run time as `pipeline`; the payload never
 * carries a storage key, a URL, an email, a flag that widens the export or any parent text.
 */
export const dataExportJobSchema = z.strictObject({
  exportId: z.uuid(),
  babyId: z.uuid(),
});
export type DataExportJob = z.infer<typeof dataExportJobSchema>;

/** pg-boss `singletonKey` of a `data.export` job: the export id (one queued/active job per export). */
export function dataExportSingletonKey(job: DataExportJob): string {
  return job.exportId;
}

// Photo import (docs/plans/step-10.md 2.3, 2.7): `JOBS.importGoogle` / `JOBS.importSweep`; the
// constants below are aliases kept for the producers.

/**
 * Queue name of one Google Picker batch import (`importGoogleJobSchema`). Sent by the api after
 * the batch turned `queued` (commit first) and re-sent by `import.sweep`. Queue policy
 * `exclusive`, `singletonKey = batchId` (`importGoogleSingletonKey`), `retryLimit 2`,
 * `retryDelay 60`, `expireInSeconds 7200`. No model call: imported photos follow the ingest →
 * reindex path, whose paid-tier gate is unchanged.
 */
export const IMPORT_GOOGLE_JOB = JOBS.importGoogle;

/**
 * Queue name of the hourly import sweep (`importSweepJobSchema`, cron `37 * * * *`, `exclusive`):
 * expires abandoned picker sessions, re-sends stuck `queued` batches, fails stale `running` ones,
 * deletes orphaned objects and finished items after 30 days.
 */
export const IMPORT_SWEEP_JOB = JOBS.importSweep;

/**
 * `import.google` payload: ids only (strict: never a token, a Google session or item id, a
 * `baseUrl`, a file name or a time zone). The worker re-reads the batch (status, requester,
 * `tz_hint`, `provider_session_id`) as `pipeline` at run time.
 */
export const importGoogleJobSchema = z.strictObject({
  batchId: z.uuid(),
  babyId: z.uuid(),
});
export type ImportGoogleJob = z.infer<typeof importGoogleJobSchema>;

/** pg-boss `singletonKey` of an `import.google` job: the batch id (one queued/active job per batch). */
export function importGoogleSingletonKey(job: ImportGoogleJob): string {
  return job.batchId;
}

/** `import.sweep` payload: none (cron ticks send no data; handlers parse `job.data ?? {}`). */
export const importSweepJobSchema = z.strictObject({});
export type ImportSweepJob = z.infer<typeof importSweepJobSchema>;
