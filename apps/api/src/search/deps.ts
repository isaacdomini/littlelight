import type { ChatModel, Embedder } from "@littlelight/ai";
import {
  AI_PIPELINE_DEFAULTS,
  CHAT_DEFAULTS,
  type ChatEnv,
  SEARCH_DEFAULTS,
  type SearchEnv,
} from "@littlelight/shared";
import type { FastifyInstance } from "fastify";

// Dependencies of the search and chat route modules (docs/plans/step-7.md 2.8, 2.9). The API
// wiring (`apps/api/src/plugins/ai.ts`, task 7.8) builds the model clients once with
// `createChatModel` / `createEmbedder` from `@littlelight/ai` and passes them here; tests inject
// fakes. `null` means "not configured on this server" (no key): search degrades to keyword +
// filters, chat answers 409. Fields are read at request time, so a mutable holder works.

export interface AiServices {
  chat: ChatModel | null;
  embedder: Embedder | null;
}

/**
 * `searchEnvSchema` (incl. optional `SEARCH_MIN_SIMILARITY`: unset ⇒ the embedding model's default,
 * `defaultMinSimilarity`) + `chatEnvSchema` + the per-baby monthly budget.
 */
export type SearchChatSettings = Omit<SearchEnv, "SEARCH_MIN_SIMILARITY"> &
  ChatEnv & {
    AI_BABY_MONTHLY_BUDGET_USD: number;
    /** 0..1; null/unset ⇒ `defaultMinSimilarity(embedder.model)`. */
    SEARCH_MIN_SIMILARITY?: number | null;
  };

export interface SearchChatDeps {
  ai: AiServices;
  settings: SearchChatSettings;
}

/** Every default (tests, bench). */
export const DEFAULT_SEARCH_CHAT_SETTINGS: SearchChatSettings = {
  SEARCH_RERANK: SEARCH_DEFAULTS.SEARCH_RERANK,
  SEARCH_EXACT_MAX: SEARCH_DEFAULTS.SEARCH_EXACT_MAX,
  SEARCH_HNSW_EF_SEARCH: SEARCH_DEFAULTS.SEARCH_HNSW_EF_SEARCH,
  SEARCH_RECONCILE_CRON: SEARCH_DEFAULTS.SEARCH_RECONCILE_CRON,
  SEARCH_EMBED_BATCH: SEARCH_DEFAULTS.SEARCH_EMBED_BATCH,
  CHAT_TURNS_PER_DAY: CHAT_DEFAULTS.CHAT_TURNS_PER_DAY,
  CHAT_MAX_TOOL_ROUNDS: CHAT_DEFAULTS.CHAT_MAX_TOOL_ROUNDS,
  CHAT_MAX_OUTPUT_TOKENS: CHAT_DEFAULTS.CHAT_MAX_OUTPUT_TOKENS,
  CHAT_HISTORY_MESSAGES: CHAT_DEFAULTS.CHAT_HISTORY_MESSAGES,
  CHAT_MODEL_TIMEOUT_MS: CHAT_DEFAULTS.CHAT_MODEL_TIMEOUT_MS,
  CHAT_FAST_PATH: CHAT_DEFAULTS.CHAT_FAST_PATH,
  AI_BABY_MONTHLY_BUDGET_USD: AI_PIPELINE_DEFAULTS.AI_BABY_MONTHLY_BUDGET_USD,
};

/**
 * `deps` as given, else the app's own: `app.ai` (`plugins/ai.ts`, read at request time) and the
 * search/chat settings of `app.config` over the shared defaults.
 */
export function resolveSearchChatDeps(app: FastifyInstance, deps?: SearchChatDeps): SearchChatDeps {
  if (deps) return deps;
  const c = app.config as Partial<SearchChatSettings>;
  const settings = { ...DEFAULT_SEARCH_CHAT_SETTINGS };
  for (const key of Object.keys(settings) as (keyof SearchChatSettings)[]) {
    const v = c[key];
    if (v !== undefined) (settings as Record<string, unknown>)[key] = v;
  }
  if (c.SEARCH_MIN_SIMILARITY !== undefined)
    settings.SEARCH_MIN_SIMILARITY = c.SEARCH_MIN_SIMILARITY;
  if (c.CHAT_FAST_PATH_MIN_SIMILARITY !== undefined) {
    settings.CHAT_FAST_PATH_MIN_SIMILARITY = c.CHAT_FAST_PATH_MIN_SIMILARITY;
  }
  return {
    ai: {
      get chat() {
        return app.ai?.chat ?? null;
      },
      get embedder() {
        return app.ai?.embedder ?? null;
      },
    },
    settings,
  };
}
