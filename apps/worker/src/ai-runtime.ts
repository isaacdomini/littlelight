import {
  AiConfigError,
  type AiEnvInput,
  AiNotConfiguredError,
  type AiStatus,
  aiEnvSchema,
  createVisionDescriber,
  DEFAULT_VISION_REASONING_EFFORT,
  getAiStatus,
  type VisionDescriber,
} from "@littlelight/ai";
import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION } from "@littlelight/shared";
import type { AiPipelineConfig } from "./ai";
import { errorCategory } from "./clients";
import type { WorkerConfig } from "./config";
import type { WorkerLog } from "./log-types";

// AI wiring shared by `main.ts` and `run-job.ts` (docs/plans/step-6.md 2.7). The provider, model
// and keys come from `@littlelight/ai`'s env (`getAiStatus` / `createVisionDescriber`); a missing
// key or an invalid AI config never fails worker boot: the describer is null and the pipeline's
// flush/poll skip with one log line. Log lines name env vars and field names only, never values.

export interface AiRuntime {
  status: AiStatus;
  /** Null when AI is not configured (no key, fake refused in production, invalid config). */
  describer: VisionDescriber | null;
  /** Set when `describer` is null: env var / field names only (the pipeline's skip log line). */
  disabledReason?: string;
}

/**
 * Build the vision describer once per process and log the boot line: `AI enabled: provider=…
 * model=…` (plus `status.warning` at warn), or `AI disabled: <reason>`.
 */
export function createAiRuntime(env: AiEnvInput, log: WorkerLog): AiRuntime {
  const status = getAiStatus(env);
  if (!status.configured) {
    log.info({}, `AI disabled: ${status.reason}`);
    return { status, describer: null, disabledReason: status.reason };
  }
  try {
    const describer = createVisionDescriber(env, { log });
    log.info({}, `AI enabled: provider=${status.provider} model=${status.visionModel}`);
    if (status.warning) log.warn({ provider: status.provider }, status.warning);
    return { status, describer };
  } catch (err) {
    let disabledReason: string;
    if (err instanceof AiNotConfiguredError) {
      // The message is built from env var names only ("AI disabled: …").
      log.info({}, err.message);
      disabledReason = err.message.replace(/^AI disabled: /, "");
    } else if (err instanceof AiConfigError) {
      log.error({ fields: err.fields }, "AI disabled: invalid AI configuration");
      disabledReason = `invalid ${err.fields.join(", ")}`;
    } else {
      log.error({ err: errorCategory(err) }, "AI disabled: could not create the describer");
      disabledReason = "describer could not be created";
    }
    return { status, describer: null, disabledReason };
  }
}

/**
 * The pipeline's config: the parsed `aiPipelineEnvSchema` fields it uses, the current prompt and
 * schema versions and the vision reasoning effort. Provider and model come from the describer.
 */
export function aiPipelineConfig(config: WorkerConfig, env: AiEnvInput): AiPipelineConfig {
  const ai = aiEnvSchema.safeParse(env);
  return {
    AI_BATCH_MAX_PHOTOS: config.AI_BATCH_MAX_PHOTOS,
    AI_BATCH_FLUSH_MINUTES: config.AI_BATCH_FLUSH_MINUTES,
    AI_BATCH_MAX_BYTES: config.AI_BATCH_MAX_BYTES,
    AI_MAX_ATTEMPTS: config.AI_MAX_ATTEMPTS,
    AI_BABY_MONTHLY_BUDGET_USD: config.AI_BABY_MONTHLY_BUDGET_USD,
    AI_BUDGET_ALERT_PCT: config.AI_BUDGET_ALERT_PCT,
    AI_QUEUE_AGE_ALERT_MINUTES: config.AI_QUEUE_AGE_ALERT_MINUTES,
    promptVersion: AI_PROMPT_VERSION,
    schemaVersion: AI_SCHEMA_VERSION,
    // The configured effort (not the describer's): with `none`, reasoning tokens > 0 warn.
    VISION_REASONING_EFFORT: ai.success
      ? ai.data.VISION_REASONING_EFFORT
      : DEFAULT_VISION_REASONING_EFFORT,
  };
}
