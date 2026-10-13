import {
  idParamsSchema,
  type PhotoSummary,
  searchFacetsQuerySchema,
  searchFacetsResponseSchema,
  searchQuerySchema,
  searchResponseSchema,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth, requireConsent, withClaims } from "../auth";
import { requireChatAccess } from "./access";
import { resolveSearchChatDeps, type SearchChatDeps } from "./deps";
import { searchFacets } from "./facets";
import { hybridSearch } from "./hybrid";
import { liveRowsInOrder, signSummaries } from "./summaries";

// `GET /babies/:id/search` and `GET /babies/:id/search/facets` (docs/plans/step-7.md 2.8; PRD
// FR-7.5 classic search bar + chips, FR-7.3 hybrid retrieval). Admins of a paid baby only
// (`requireChatAccess`: 404 stranger, 403 `forbidden` contributor, 403 `plan_required` free),
// checked before any embedding call. Everything else runs under the caller's claims: no
// `withServiceRole`. The query string never reaches a log (the request serializer drops it) and
// neither does a result.

export function searchRoutes(app: FastifyInstance, given?: SearchChatDeps): void {
  const deps = resolveSearchChatDeps(app, given);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/babies/:id/search",
    schema: {
      params: idParamsSchema,
      querystring: searchQuerySchema,
      response: { 200: searchResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const q = request.query;
      const { rows, result } = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireChatAccess(client, ctx.uid, babyId);
        const result = await hybridSearch(
          client,
          {
            babyId,
            query: q.q ?? null,
            dateFrom: q.dateFrom ?? null,
            dateTo: q.dateTo ?? null,
            ageFromDays: q.ageFrom ?? null,
            ageToDays: q.ageTo ?? null,
            milestoneIds: q.milestoneId ? [q.milestoneId] : [],
            people: q.person ? [q.person] : [],
            tags: q.tag ? [q.tag] : [],
            place: q.place ?? null,
            media: q.media,
            limit: q.limit,
            timezone: access.timezone,
          },
          {
            embedder: deps.ai.embedder,
            exactMax: deps.settings.SEARCH_EXACT_MAX,
            efSearch: deps.settings.SEARCH_HNSW_EF_SEARCH,
            minSimilarity: deps.settings.SEARCH_MIN_SIMILARITY ?? null,
            rerank:
              deps.settings.SEARCH_RERANK === "llm" && deps.ai.chat
                ? { chat: deps.ai.chat, userId: ctx.uid }
                : null,
          },
        );
        return { rows: await liveRowsInOrder(client, result.ids), result };
      });
      request.log.info(
        {
          babyId,
          path: result.path,
          candidates: result.candidates,
          results: rows.length,
          tookMs: result.tookMs,
          embedMs: result.embedMs,
          degraded: result.degraded,
        },
        "search",
      );
      const photos: PhotoSummary[] = await signSummaries(app.signer, rows);
      return { photos, tookMs: result.tookMs, degraded: result.degraded };
    },
  });

  r.route({
    method: "GET",
    url: "/babies/:id/search/facets",
    schema: {
      params: idParamsSchema,
      querystring: searchFacetsQuerySchema,
      response: { 200: searchFacetsResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireChatAccess(client, ctx.uid, babyId);
        return searchFacets(client, babyId, access.timezone);
      });
    },
  });
}
