// pg-boss job names and payload schemas are defined once in `@tinyglow/shared` (`src/jobs.ts`,
// docs/plans/step-4.md 2.5, docs/plans/step-5.md 2.5) because the API sends `photo.ingest` and
// `photo.reindex` too. The worker owns queue creation and scheduling. Payloads carry IDs, a
// reason and a time zone name only, never photo bytes, GPS, emails or parent notes.

export {
  type IngestJob,
  ingestJobSchema,
  JOBS,
  type JobName,
  REINDEX_REASONS,
  type ReindexJob,
  type ReindexReason,
  reindexJobSchema,
} from "@tinyglow/shared";
