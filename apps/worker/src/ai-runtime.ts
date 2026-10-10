import {
  AiConfigError,
  type AiEnvInput,
  AiNotConfiguredError,
  type AiStatus,
  aiEnvSchema,
  createEmbedder,
  createVisionDescriber,
  DEFAULT_EMBED_MODEL,
  DEFAULT_VISION_REASONING_EFFORT,
  EMBED_DIMS,
  type Embedder,
  embedModelTag,
  getAiStatus,
  type VisionDescriber,
} from "@tinyglow/ai";
import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION, SEARCH_DOC_VERSION } from "@tinyglow/shared";
import type { AiPipelineConfig, SearchIndexerConfig } from "./ai";
import { errorCategory } from "./clients";
import type { WorkerConfig } from "./config";
import type { WorkerLog } from "./log-types";

// AI wiring shared by `main.ts` and `run-job.ts` (docs/plans/step-6.md 2.7, docs/plans/step-7.md
// 2.7). The provider, models and keys come from `@tinyglow/ai`'s env (`getAiStatus` and the
// factories); a missing key or an invalid AI config never fails worker boot: the describer and/or
// the embedder is null, the pipeline's flush/poll skip with one log line and the search indexer
// writes rows without vectors (keyword search and filters still work). The describer and the
// embedder are built independently: an Anthropic-only deployment has a describer but no embedder
// (embeddings are OpenAI only). Log lines name env vars, providers and models only, never values.

export interface AiRuntime {
  status: AiStatus;
  /** Null when AI is not configured (no key, fake refused in production, invalid config). */
  describer: VisionDescriber | null;
  /** Set when `describer` is null: env var / field names only (the pipeline's skip log line). */
  disabledReason?: string;
  /**
   * Search document embedder (`createEmbedder`: OpenAI, or the bag-of-words fake when
   * `VISION_PROVIDER=fake`). Null without `OPENAI_API_KEY` or with an invalid config.
   */
  embedder: Embedder | null;
  /** Set when `embedder` is null: env var / field names only. */
  embedDisabledReason?: string;
}

type Built<T> = { value: T; reason?: undefined } | { value: null; reason: string };

/** Run a factory; on failure log one line (names only) prefixed with `label` and return null. */
function build<T>(factory: () => T, label: string, what: string, log: WorkerLog): Built<T> {
  try {
    return { value: factory() };
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      // The message is built from env var names only ("AI disabled: …").
      const reason = err.message.replace(/^AI disabled: /, "");
      log.info({}, `${label}: ${reason}`);
      return { value: null, reason };
    }
    if (err instanceof AiConfigError) {
      log.error({ fields: err.fields }, `${label}: invalid AI configuration`);
      return { value: null, reason: `invalid ${err.fields.join(", ")}` };
    }
    log.error({ err: errorCategory(err) }, `${label}: could not create the ${what}`);
    return { value: null, reason: `${what} could not be created` };
  }
}

const SEARCH_DEGRADED = "keyword search and filters still work";

/**
 * Build the vision describer and the embedder once per process and log the boot lines:
 * `AI enabled: provider=… vision=… embed=…` (plus `status.warning` at warn), or
 * `AI disabled: <reason>`; and, whenever there is no embedder, `search: embeddings disabled
 * (<reason>); keyword search and filters still work`.
 */
export function createAiRuntime(env: AiEnvInput, log: WorkerLog): AiRuntime {
  const status = getAiStatus(env);
  if (!status.configured) {
    log.info({}, `AI disabled: ${status.reason}`);
    log.info({}, `search: embeddings disabled (${status.reason}); ${SEARCH_DEGRADED}`);
    return {
      status,
      describer: null,
      disabledReason: status.reason,
      embedder: null,
      embedDisabledReason: status.reason,
    };
  }
  const vision = build(() => createVisionDescriber(env, { log }), "AI disabled", "describer", log);
  const embed = build(
    () => createEmbedder(env, { log }),
    "search: embeddings disabled",
    "embedder",
    log,
  );
  const embedLabel = embed.value ? embedModelTag(embed.value) : "off";
  if (vision.value) {
    log.info(
      {},
      `AI enabled: provider=${status.provider} vision=${status.visionModel} embed=${embedLabel}`,
    );
    if (status.warning) log.warn({ provider: status.provider }, status.warning);
  } else if (embed.value) {
    log.info({}, `search: embeddings enabled embed=${embedLabel}`);
  }
  if (!embed.value) {
    log.info({}, `search: embeddings disabled (${embed.reason}); ${SEARCH_DEGRADED}`);
  }
  return {
    status,
    describer: vision.value,
    ...(vision.value ? {} : { disabledReason: vision.reason }),
    embedder: embed.value,
    ...(embed.value ? {} : { embedDisabledReason: embed.reason }),
  };
}

/**
 * The search indexer's config: the embedding batch size, the `photo_search.embed_model` tag the
 * reconcile compares against (`embedModelTag(embedder)`, e.g. `text-embedding-3-small/1024` or
 * `fake/1024`; without an embedder `${EMBED_MODEL}/${EMBED_DIMS}` from env, so rows written now
 * are re-embedded once a key appears), the current search document version and the per-baby
 * monthly AI budget (the indexer writes rows without a vector once a baby's budget is spent).
 */
export function searchIndexerConfig(
  config: Pick<WorkerConfig, "SEARCH_EMBED_BATCH" | "AI_BABY_MONTHLY_BUDGET_USD">,
  env: AiEnvInput,
  embedder: Pick<Embedder, "model" | "dims"> | null,
): SearchIndexerConfig {
  let tag: string;
  if (embedder) {
    tag = embedModelTag(embedder);
  } else {
    const ai = aiEnvSchema.safeParse(env);
    tag = ai.success
      ? `${ai.data.EMBED_MODEL}/${ai.data.EMBED_DIMS}`
      : `${DEFAULT_EMBED_MODEL}/${EMBED_DIMS}`;
  }
  return {
    SEARCH_EMBED_BATCH: config.SEARCH_EMBED_BATCH,
    embedModelTag: tag,
    docVersion: SEARCH_DOC_VERSION,
    AI_BABY_MONTHLY_BUDGET_USD: config.AI_BABY_MONTHLY_BUDGET_USD,
  };
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
