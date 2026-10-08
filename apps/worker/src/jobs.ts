// pg-boss job names (queues) owned by the worker. Names are reserved here first so the API and
// later steps refer to one constant, never a string literal. Payloads carry IDs and object keys
// only, never photo bytes, GPS, emails or parent notes.

export const JOBS = {
  /**
   * Reserved in step 3 (docs/plans/step-3.md 3.9, 2.7 "Account deletion"); no handler or schedule
   * yet. Step 4 implements it as a scheduled job: hard-delete `babies` and `photos` trashed more
   * than 30 days ago (FR-10.3; `pipeline` role, whose DELETE policies only match rows with
   * `deleted_at < now() - interval '30 days'`), including every MinIO object version of their
   * originals and derivatives.
   */
  purgeTrash: "purge.trash",
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];
