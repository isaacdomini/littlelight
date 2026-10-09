// AI batch pipeline entry (docs/plans/step-6.md 2.6). Wiring (queues, schedules, run-job,
// heartbeat) lives outside this folder (2.7, backend-engineer).

export { buildVisionContext, captureTime, type PendingRow } from "./context";
export {
  type AiPipeline,
  type AiPipelineConfig,
  type AiPipelineDeps,
  aiErrorCategory,
  createAiPipeline,
  type FlushOptions,
  type FlushResult,
  MAX_FORCED_ROUNDS,
  MAX_SUBMIT_ATTEMPTS,
  POLL_LIMIT,
  type PollResult,
  type QueueAge,
  RESULT_CHUNK,
  SUBMIT_LEASE_MINUTES,
  type SubmittedBatch,
} from "./pipeline";
export {
  GOLDEN_COUNT,
  GOLDEN_SIGNATURES,
  GOLDEN_TARGETS,
  type GoldenKind,
  type GoldenTarget,
  goldenCollisions,
  SEARCH_SEED_BIRTH_DATE,
  SEARCH_SEED_MAX_AGE_DAYS,
  type SeedMeasurement,
  type SeedPhoto,
  searchSeedMeasurements,
  searchSeedPhotos,
  seedDescription,
} from "./search-content";
export * as SEARCH_SQL from "./search-doc-sql";
export {
  documentTime,
  mergedDescription,
  type SearchDocRow,
  toDocumentInput,
} from "./search-doc-sql";
// Search indexer (docs/plans/step-7.md 2.6): `photo.reindex`, `search.reconcile`,
// `search.backfill`; the dev search seed lives in `search-seed.ts` (`pnpm search:seed`).
export {
  createSearchIndexer,
  type IndexReason,
  RECONCILE_CHUNK,
  RECONCILE_FETCH,
  RECONCILE_MAX_ROUNDS,
  type ReconcileResult,
  type ReindexResult,
  type SearchIndexer,
  type SearchIndexerConfig,
  type SearchIndexerDeps,
  sha256Hex,
} from "./search-index";
export * as AI_SQL from "./sql";
