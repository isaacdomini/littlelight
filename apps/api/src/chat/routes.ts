import { CHAT_SYSTEM_PROMPT_V1 } from "@littlelight/ai";
import {
  CHAT_COST_PER_TURN_ESTIMATE_USD,
  CHAT_LIMITS,
  CHAT_MESSAGES,
  type ChatEvent,
  type ChatMessageDto,
  type ChatPhoto,
  type ChatToolName,
  type ChatTurnResponse,
  chatSendRequestSchema,
  chatThreadResponseSchema,
  chatTurnResponseSchema,
  idParamsSchema,
  type PhotoSummary,
} from "@littlelight/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit, requireAuth, requireConsent, withClaims } from "../auth";
import { ApiError } from "../lib/errors";
import { requireChatAccess, todayIn } from "../search/access";
import { resolveSearchChatDeps, type SearchChatDeps } from "../search/deps";
import { defaultFastPathMinSimilarity } from "../search/hybrid";
import { liveRowsInOrder, signSummaries } from "../search/summaries";
import { type AgentEvent, runChatTurn, type TurnResult } from "./agent";
import {
  budgetAuditExists,
  currentThread,
  deleteThreads,
  insertAssistantTurn,
  insertUserMessage,
  lockThread,
  type MessageRow,
  monthCostUsd,
  replyInProgress,
  reserveTurn,
  threadMessages,
  turnsLast24h,
} from "./queries";
import { openChatEventStream } from "./sse";
import { runTool, type ToolContext } from "./tools";

// Chat endpoints (docs/plans/step-7.md 2.8 table; PRD FR-7.1, 7.4, 7.6, 7.7, "Cost controls").
//   GET    /babies/:id/chat/thread    the caller's thread (last 100 messages) + turns left today
//   POST   /babies/:id/chat/messages  one turn: SSE (`Accept: text/event-stream`) or JSON
//   DELETE /babies/:id/chat/thread    clear history (audit `chat.cleared`)
// Gate first (`requireChatAccess`: 404 stranger, 403 contributor, 403 `plan_required`), so no
// model call happens for anyone else; every statement runs under the caller's claims (no
// `withServiceRole`). Turn flow: Tx A (consent, gate, 100 turns/24 h via `chat_reserve_turn`,
// monthly budget incl. `ai_spend`, thread lock + "reply in progress" check, history, the user
// message) → the agent loop outside any transaction (each tool in its own claims transaction) →
// Tx B (assistant message + `ai_spend` row + thread touch). Logs carry ids, counts, tokens, cost
// and timings only: never the question, the answer, tool arguments or results.

const notConfigured = () => new ApiError(409, "conflict", CHAT_MESSAGES.notConfigured);
const busy = () => new ApiError(409, "conflict", CHAT_MESSAGES.busy);

/** Seconds until the next UTC month starts (Retry-After of `ai_budget_exceeded`). */
export function secondsToNextUtcMonth(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function toChatPhoto(p: PhotoSummary): ChatPhoto {
  return {
    id: p.id,
    babyId: p.babyId,
    takenAt: p.takenAt,
    ageDays: p.ageDays,
    isSensitive: p.isSensitive,
    thumbUrl: p.thumbUrl,
    urlExpiresAt: p.urlExpiresAt,
    caption: p.caption,
    milestoneId: p.milestoneId,
  };
}

/** Signed chat photos for ids (RLS + live album), in id order. */
async function chatPhotos(
  app: FastifyInstance,
  request: FastifyRequest,
  ids: readonly string[],
): Promise<ChatPhoto[]> {
  if (ids.length === 0) return [];
  const rows = await withClaims(request, (client) => liveRowsInOrder(client, ids));
  return (await signSummaries(app.signer, rows)).map(toChatPhoto);
}

function messageDto(row: MessageRow, photos: ChatPhoto[]): ChatMessageDto {
  const assistant = row.role === "assistant";
  return {
    id: row.id,
    role: row.role,
    text: row.content,
    photos: assistant ? photos : [],
    citations: {
      photoIds: assistant ? row.cited_photo_ids.slice(0, CHAT_LIMITS.citations) : [],
      measurementIds: assistant ? row.cited_measurement_ids.slice(0, CHAT_LIMITS.citations) : [],
    },
    // Stored turns do not keep the live `grounded` flag; a complete stored answer reads grounded.
    grounded: row.status === "complete",
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export function chatRoutes(app: FastifyInstance, given?: SearchChatDeps): void {
  const deps = resolveSearchChatDeps(app, given);
  const r = app.withTypeProvider<ZodTypeProvider>();
  const s = deps.settings;

  r.route({
    method: "GET",
    url: "/babies/:id/chat/thread",
    schema: { params: idParamsSchema, response: { 200: chatThreadResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const { id: babyId } = request.params;
      const { threadId, rows, used } = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        await requireChatAccess(client, ctx.uid, babyId);
        const thread = await currentThread(client, babyId, ctx.uid);
        const rows = thread
          ? await threadMessages(client, thread.id, CHAT_LIMITS.threadMessages)
          : [];
        return { threadId: thread?.id ?? null, rows, used: await turnsLast24h(client) };
      });
      const allIds = [
        ...new Set(rows.flatMap((m) => (m.role === "assistant" ? m.cited_photo_ids : []))),
      ];
      const photos = new Map((await chatPhotos(app, request, allIds)).map((p) => [p.id, p]));
      return {
        threadId,
        messages: rows.map((m) =>
          messageDto(
            m,
            m.cited_photo_ids.map((id) => photos.get(id)).filter((p): p is ChatPhoto => !!p),
          ),
        ),
        turnsLeftToday: Math.max(0, s.CHAT_TURNS_PER_DAY - used),
      };
    },
  });

  r.route({
    method: "DELETE",
    url: "/babies/:id/chat/thread",
    schema: { params: idParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId } = request.params;
      await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        await requireChatAccess(client, ctx.uid, babyId);
        const n = await deleteThreads(client, babyId, ctx.uid);
        await audit(client, "chat.cleared", { babyId, actorUserId: ctx.uid });
        request.log.info({ babyId, threads: n }, "chat cleared");
      });
      return reply.code(204).send();
    },
  });

  r.route({
    method: "POST",
    url: "/babies/:id/chat/messages",
    schema: {
      params: idParamsSchema,
      body: chatSendRequestSchema,
      response: { 200: chatTurnResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id: babyId } = request.params;
      const userText = request.body.text;
      const now = new Date();
      const busyWindowMs = s.CHAT_MODEL_TIMEOUT_MS * s.CHAT_MAX_TOOL_ROUNDS + 30_000;

      // ---- Tx A ----------------------------------------------------------------------------
      const a = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const access = await requireChatAccess(client, ctx.uid, babyId);
        const chat = deps.ai.chat;
        if (!chat) throw notConfigured();
        const turn = await reserveTurn(client, s.CHAT_TURNS_PER_DAY);
        if (!turn.allowed) {
          const retry = turn.oldestAt
            ? (turn.oldestAt.getTime() + 86_400_000 - now.getTime()) / 1000
            : 3600;
          throw new ApiError(429, "rate_limited", CHAT_MESSAGES.rateLimited, undefined, {
            retryAfterSec: Math.max(1, retry),
          });
        }
        const cost = await monthCostUsd(client, babyId, now);
        if (cost + CHAT_COST_PER_TURN_ESTIMATE_USD > s.AI_BABY_MONTHLY_BUDGET_USD) {
          const month = now.toISOString().slice(0, 7);
          if (!(await budgetAuditExists(client, babyId, month))) {
            await audit(client, "ai.budget_exceeded", {
              babyId,
              actorUserId: ctx.uid,
              metadata: { month, kind: "chat" },
            });
          }
          return { refused: "budget" as const };
        }
        const threadId = await lockThread(client, babyId, ctx.uid);
        if (!threadId || (await replyInProgress(client, threadId, busyWindowMs))) throw busy();
        const history = (await threadMessages(client, threadId, s.CHAT_HISTORY_MESSAGES))
          .filter((m) => m.status === "complete")
          .map((m) => ({ role: m.role, content: m.content }));
        const userMessage = await insertUserMessage(client, threadId, babyId, ctx.uid, userText);
        return { refused: null, access, chat, threadId, history, userMessage, uid: ctx.uid };
      });
      if (a.refused === "budget") {
        throw new ApiError(429, "ai_budget_exceeded", CHAT_MESSAGES.budgetExceeded, undefined, {
          retryAfterSec: secondsToNextUtcMonth(now),
        });
      }

      // ---- Agent loop (outside any transaction) -------------------------------------------------
      const toolCtx: ToolContext = {
        babyId,
        birthDate: a.access.birthDate,
        timezone: a.access.timezone,
        units: a.access.units,
        embedder: deps.ai.embedder,
        exactMax: s.SEARCH_EXACT_MAX,
        efSearch: s.SEARCH_HNSW_EF_SEARCH,
        minSimilarity: s.SEARCH_MIN_SIMILARITY ?? null,
        rerank: s.SEARCH_RERANK === "llm" ? { chat: a.chat, userId: a.uid } : null,
        runClaims: (fn) => withClaims(request, fn),
        log: request.log,
      };
      const events = runChatTurn(
        {
          chat: a.chat,
          executeTool: (name: ChatToolName, args: unknown) => runTool(toolCtx, name, args as never),
          log: request.log,
        },
        {
          systemPrompt: CHAT_SYSTEM_PROMPT_V1({
            babyName: a.access.name,
            nickname: a.access.nickname,
            birthDate: a.access.birthDate,
            today: todayIn(a.access.timezone, now),
            units: a.access.units,
          }),
          history: a.history,
          userText,
          maxRounds: s.CHAT_MAX_TOOL_ROUNDS,
          maxOutputTokens: s.CHAT_MAX_OUTPUT_TOKENS,
          timeoutMs: s.CHAT_MODEL_TIMEOUT_MS,
          fastPath: s.CHAT_FAST_PATH,
          fastPathMinSimilarity:
            s.CHAT_FAST_PATH_MIN_SIMILARITY ??
            defaultFastPathMinSimilarity(deps.ai.embedder?.model),
        },
      );

      /** Tx B + the response body of the turn. */
      const finish = async (result: TurnResult): Promise<ChatTurnResponse> => {
        const msg = await withClaims(request, (client) =>
          insertAssistantTurn(client, { threadId: a.threadId, babyId, uid: a.uid, result }),
        );
        const photos = await chatPhotos(app, request, result.photoIds);
        request.log.info(
          {
            babyId,
            threadId: a.threadId,
            userMessageId: a.userMessage.id,
            assistantMessageId: msg.id,
            status: result.status,
            costUsd: result.usage.costUsd,
          },
          "chat turn stored",
        );
        return {
          message: {
            id: msg.id,
            role: "assistant",
            text: result.text,
            photos,
            citations: result.citations,
            grounded: result.grounded,
            status: result.status,
            createdAt: msg.created_at.toISOString(),
          },
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            costUsd: result.usage.costUsd,
          },
          toolsUsed: result.toolsUsed,
        };
      };

      const wantsSse = (request.headers.accept ?? "").includes("text/event-stream");
      if (!wantsSse) {
        let result: TurnResult | undefined;
        for await (const ev of events) if (ev.type === "final") result = ev.result;
        return finish(result as TurnResult);
      }

      // ---- SSE ----------------------------------------------------------------------------------
      // The turn is not aborted when the client goes away: it finishes and is stored, so a
      // reload shows the answer (bounded by CHAT_MODEL_TIMEOUT_MS per call).
      const stream = openChatEventStream(reply);
      const sse = { send: (event: ChatEvent) => stream.send(event), end: () => stream.close() };
      try {
        sse.send({ type: "thread", threadId: a.threadId, userMessageId: a.userMessage.id });
        for await (const ev of events as AsyncIterable<AgentEvent>) {
          if (ev.type === "status") {
            sse.send(
              ev.tool
                ? { type: "status", stage: ev.stage, tool: ev.tool }
                : { type: "status", stage: ev.stage },
            );
          } else if (ev.type === "delta") {
            sse.send({ type: "delta", text: ev.text });
          } else if (ev.type === "photos") {
            sse.send({ type: "photos", photos: await chatPhotos(app, request, ev.photoIds) });
          } else {
            if (ev.result.status === "error") {
              sse.send({ type: "error", error: "internal", message: CHAT_MESSAGES.failed });
            }
            sse.send({ type: "done", ...(await finish(ev.result)) });
          }
        }
      } catch (err) {
        request.log.error(
          { err: err instanceof Error ? err.name : typeof err, threadId: a.threadId },
          "chat stream failed",
        );
        sse.send({ type: "error", error: "internal", message: CHAT_MESSAGES.failed });
      } finally {
        sse.end();
      }
      return reply;
    },
  });
}
