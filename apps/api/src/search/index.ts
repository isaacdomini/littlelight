// Search module (docs/plans/step-7.md 2.8). See `../chat/index.ts` for the registration snippet.
export {
  type ChatAccess,
  parentsOnly,
  planRequired,
  requireChatAccess,
  safeTimeZone,
  todayIn,
} from "./access";
export {
  type AiServices,
  DEFAULT_SEARCH_CHAT_SETTINGS,
  type SearchChatDeps,
  type SearchChatSettings,
} from "./deps";
export { searchFacets } from "./facets";
export {
  candidateCall,
  defaultFastPathMinSimilarity,
  defaultMinSimilarity,
  embedQuery,
  exactVectorSql,
  filterSql,
  type HybridInput,
  type HybridOptions,
  type HybridResult,
  hnswVectorSql,
  hybridSearch,
  MEDIA_NARROW_SQL,
  MEDIA_OVERFETCH,
  mediaFilter,
  narrowToMedia,
  queryTokens,
  setHnswLocals,
  vectorLiteral,
} from "./hybrid";
export { RERANK_JSON_SCHEMA, RERANK_SCHEMA_NAME, rerankWithChat } from "./rerank";
export { searchRoutes } from "./routes";
export { type FusedResult, reciprocalRankFusion } from "./rrf";
export { liveRowsInOrder, signSummaries } from "./summaries";
