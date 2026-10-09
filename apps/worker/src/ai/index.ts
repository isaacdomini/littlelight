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
export * as AI_SQL from "./sql";
