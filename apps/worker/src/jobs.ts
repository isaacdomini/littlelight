// pg-boss job names and payload schemas are defined once in `@littlelight/shared` (`src/jobs.ts`,
// docs/plans/step-4.md 2.5) because the API sends `photo.ingest` too. The worker owns queue
// creation and scheduling. Payloads carry IDs and a time zone name only, never photo bytes, GPS,
// emails or parent notes.

export { type IngestJob, ingestJobSchema, JOBS, type JobName } from "@littlelight/shared";
