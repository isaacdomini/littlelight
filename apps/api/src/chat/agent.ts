import type { ChatMessage, ChatModel, ChatToolCall } from "@tinyglow/ai";
import {
  CHAT_LIMITS,
  CHAT_MESSAGES,
  CHAT_TOOL_DEFINITIONS,
  type ChatToolName,
  formatChatMessage,
  formatCitation,
  parseChatToolArguments,
  partitionCitations,
  SEARCH_RESULT_LIMIT,
} from "@tinyglow/shared";
import { createCitationFilter } from "./citations";
import { type ToolOutcome, toolError } from "./tools";

// The agentic RAG loop (docs/plans/step-7.md 2.8 "Agent"; PRD "Chat and RAG pipeline" steps 1-5).
// messages = [system prompt, history (user/assistant text only), user]; up to
// `CHAT_MAX_TOOL_ROUNDS` model calls. Text deltas pass through the citation filter (markers
// never reach the user). Tool calls are validated with the shared zod schemas before anything
// runs (invalid ⇒ an `invalid_arguments` tool result, never an error to the user), executed by
// `executeTool` (each in its own claims transaction), and fed back with the provider's raw
// output items (`providerItems`, `store: false`). At the end, citations are kept only if a tool
// returned that id during this turn (`partitionCitations`); the grid is the cited photos, else the
// top 12 of the last search. Errors after the user message was stored become a fixed
// "something went wrong" answer with `status: error`. Nothing here logs text, arguments or
// results: only tool names, counts, tokens, cost and timings.

export type AgentEvent =
  | { type: "status"; stage: "thinking" | "searching"; tool?: ChatToolName }
  | { type: "delta"; text: string }
  | { type: "photos"; photoIds: string[] }
  | { type: "final"; result: TurnResult };

export interface TurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Model calls made. */
  calls: number;
}

export interface TurnResult {
  /** Clean answer text (no markers), as streamed; never empty. */
  text: string;
  citations: { photoIds: string[]; measurementIds: string[] };
  /** The grid: cited photos in citation order, else the last search's top results. */
  photoIds: string[];
  grounded: boolean;
  status: "complete" | "error";
  usage: TurnUsage;
  toolsUsed: ChatToolName[];
  model: string;
  /** Citations removed because no tool returned the id (plus malformed markers). */
  citationsDropped: number;
  finishReason: string;
}

export interface AgentDeps {
  chat: ChatModel;
  /** Executes one validated call (`runTool` with the request's claims). */
  executeTool(name: ChatToolName, args: unknown): Promise<ToolOutcome>;
  log?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface AgentInput {
  systemPrompt: string;
  /** Earlier messages of the thread, oldest first (text only). */
  history: { role: "user" | "assistant"; content: string }[];
  userText: string;
  maxRounds: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /**
   * Find-photos fast path (`CHAT_FAST_PATH`): when the first model call asks only for
   * `search_photos` and the question asks for photos (not a what/when/how question), the answer is
   * written server-side from the results and the second model call is skipped. Default off here;
   * the route passes the setting (default on).
   */
  fastPath?: boolean;
  /**
   * Fast-path confidence (`CHAT_FAST_PATH_MIN_SIMILARITY`): a search with free text counts as
   * confident when a result has a lexical match or its best vector similarity reaches this
   * (default 0.38, `defaultFastPathMinSimilarity`). Filter-only searches are confident.
   */
  fastPathMinSimilarity?: number;
}

/**
 * Round-robin merge of several searches' results (best of each first, duplicates once): a
 * comparison ("at 1, 6 and 12 months") shows every period in the first rows of the grid.
 * Exported for tests.
 */
export function interleave(groups: ReadonlyArray<readonly string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < longest; i++) {
    for (const g of groups) {
      const id = g[i];
      if (id !== undefined && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/**
 * True for a request to see photos ("Show first steps", "Photos with Grandma", "beach in July"),
 * false for a question that needs a written answer (what / when / how / did / tell / describe /
 * summarise / compare …), which keeps the model-written second call. Exported for tests.
 */
export function isFindPhotosRequest(text: string): boolean {
  const q = text.trim().toLowerCase();
  return !/^(what|when|where|why|how|who|whose|which|did|does|do|was|were|is|are|has|have|had|can|could|would|should|will|tell|describe|summari[sz]e|compare|explain|list)\b/.test(
    q,
  );
}

export async function* runChatTurn(deps: AgentDeps, input: AgentInput): AsyncGenerator<AgentEvent> {
  const started = Date.now();
  const messages: ChatMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.userText },
  ];
  const filter = createCitationFilter();
  const usage: TurnUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    calls: 0,
  };
  const allowedPhotos = new Set<string>();
  const allowedMeasurements = new Set<string>();
  const toolsUsed: ChatToolName[] = [];
  const measurementPhotos = new Map<string, string>();
  const roundMs: number[] = [];
  const toolMs: number[] = [];
  let firstDeltaMs: number | null = null;
  let fastPath = false;
  let lastSearch: string[] | null = null;
  /** The last round's `search_photos` results, one entry per call (interleaved for the grid). */
  let searchGroups: string[][] = [];
  let fastPathDeclined: string | null = null;
  /** Per-search summaries (key names, counts, flags) repeated on the `chat turn` line. */
  const searchLogs: Record<string, unknown>[] = [];
  let photosSent = false;
  let anyData = false;
  let text = "";
  let status: "complete" | "error" = "complete";
  let finishReason = "stop";

  try {
    yield { type: "status", stage: "thinking" };
    let pending: ChatToolCall[] = [];
    for (let round = 0; round < input.maxRounds; round++) {
      pending = [];
      const roundStart = Date.now();
      // Tool calls start as soon as each one is complete in the stream (overlapping the rest of
      // the response) and run in parallel, each in its own claims transaction; results are fed
      // back in call order.
      const running: {
        call: ChatToolCall;
        outcome: Promise<ToolOutcome>;
        name: ChatToolName | null;
      }[] = [];
      let completion: Awaited<ReturnType<ChatModel["complete"]>> | undefined;
      for await (const ev of deps.chat.stream(messages, CHAT_TOOL_DEFINITIONS, {
        maxOutputTokens: input.maxOutputTokens,
        signal: AbortSignal.timeout(input.timeoutMs),
      })) {
        if (ev.type === "text_delta") {
          const clean = filter.push(ev.delta);
          if (clean) {
            text += clean;
            firstDeltaMs ??= Date.now() - started;
            yield { type: "delta", text: clean };
          }
        } else if (ev.type === "tool_call") {
          pending.push(ev.toolCall);
          const parsed = parseChatToolArguments(ev.toolCall.name, ev.toolCall.arguments);
          if (!parsed.ok) {
            deps.log?.info(
              { tool: ev.toolCall.name.slice(0, 40), error: parsed.error },
              "chat tool rejected",
            );
            running.push({
              call: ev.toolCall,
              outcome: Promise.resolve(toolError(parsed.error, parsed.issues)),
              name: null,
            });
          } else {
            if (!toolsUsed.includes(parsed.name)) toolsUsed.push(parsed.name);
            yield { type: "status", stage: "searching", tool: parsed.name };
            const t0 = Date.now();
            const outcome = deps.executeTool(parsed.name, parsed.args).then((o) => {
              toolMs.push(Date.now() - t0);
              return o;
            });
            // Avoid an unhandled rejection while the stream is still being read.
            outcome.catch(() => undefined);
            running.push({ call: ev.toolCall, outcome, name: parsed.name });
          }
        } else {
          completion = ev.completion;
        }
      }
      roundMs.push(Date.now() - roundStart);
      if (!completion) throw new Error("chat stream ended without a completion");
      usage.calls++;
      usage.inputTokens += completion.usage.inputTokens;
      usage.cachedInputTokens += completion.usage.cachedInputTokens;
      usage.outputTokens += completion.usage.outputTokens;
      usage.reasoningTokens += completion.usage.reasoningTokens ?? 0;
      usage.costUsd += completion.usage.costUsd;
      finishReason = completion.finishReason;
      if (pending.length === 0) break;

      messages.push({
        role: "assistant",
        content: completion.text,
        toolCalls: pending,
        ...(completion.providerItems ? { providerItems: completion.providerItems } : {}),
      });
      const roundGroups: string[][] = [];
      const confidences: NonNullable<ToolOutcome["searchConfidence"]>[] = [];
      for (const r of running) {
        const outcome = await r.outcome;
        for (const id of outcome.photoIds) allowedPhotos.add(id);
        for (const id of outcome.measurementIds) allowedMeasurements.add(id);
        for (const [m, ph] of Object.entries(outcome.measurementPhotos ?? {}))
          measurementPhotos.set(m, ph);
        if (outcome.hasData) anyData = true;
        if (outcome.searchPhotoIds) roundGroups.push(outcome.searchPhotoIds);
        if (outcome.searchConfidence) confidences.push(outcome.searchConfidence);
        if (outcome.searchLog) {
          searchLogs.push(outcome.searchLog);
          deps.log?.info(outcome.searchLog, "chat tool search_photos");
        }
        messages.push({ role: "tool", toolCallId: r.call.id, content: outcome.content });
      }
      // Confident = a lexical match, a filter-only search, or a strong vector similarity. Weak
      // results are never shown on their own: no early grid, no fallback grid, no fast path; the
      // model decides (it can say nothing matched, and the grid is then only what it cites).
      const minSim = input.fastPathMinSimilarity ?? 0.38;
      const confident = confidences.every(
        (c) => c.results === 0 || c.filtersOnly || c.lexical || (c.topSimilarity ?? -1) >= minSim,
      );
      if (roundGroups.length > 0) {
        searchGroups = roundGroups;
        lastSearch = confident ? interleave(roundGroups) : null;
        if (!photosSent && lastSearch && lastSearch.length > 0) {
          photosSent = true;
          yield { type: "photos", photoIds: lastSearch.slice(0, SEARCH_RESULT_LIMIT) };
        }
      }
      if (
        round === 0 &&
        input.fastPath === true &&
        completion.text.trim() === "" &&
        running.length > 0 &&
        running.every((r) => r.name === "search_photos") &&
        confidences.length === running.length &&
        confident &&
        isFindPhotosRequest(input.userText)
      ) {
        const ids = interleave(roundGroups).slice(0, CHAT_LIMITS.citations);
        const message =
          ids.length === 0
            ? CHAT_MESSAGES.nothingFound
            : roundGroups.length > 1
              ? formatChatMessage(CHAT_MESSAGES.fastPathGroups, { count: ids.length })
              : ids.length === 1
                ? CHAT_MESSAGES.fastPathOne
                : formatChatMessage(CHAT_MESSAGES.fastPathMany, { count: ids.length });
        const answer = `${message}${ids.map((id) => ` ${formatCitation("photo", id)}`).join("")}`;
        const clean = filter.push(answer);
        if (clean) {
          text += clean;
          firstDeltaMs ??= Date.now() - started;
          yield { type: "delta", text: clean };
        }
        fastPath = true;
        finishReason = "fast_path";
        pending = [];
        break;
      }
      if (round === 0 && input.fastPath === true && !confident) fastPathDeclined = "weak_results";
    }
    const rest = filter.flush();
    if (rest) {
      text += rest;
      yield { type: "delta", text: rest };
    }
    if (pending.length > 0) {
      // Round cap reached while the model still wanted tools.
      const extra = `${text.trim() ? "\n" : ""}${CHAT_MESSAGES.tooBroad}`;
      text += extra;
      yield { type: "delta", text: extra };
    } else if (!text.trim()) {
      const extra = anyData ? "Here's what I found in the album." : CHAT_MESSAGES.nothingFound;
      text += extra;
      yield { type: "delta", text: extra };
    }
  } catch (err) {
    status = "error";
    finishReason = "error";
    deps.log?.warn(
      {
        err: err instanceof Error ? err.name : typeof err,
        code: (err as { code?: unknown })?.code,
        status: (err as { status?: unknown })?.status,
      },
      "chat turn failed",
    );
    text = CHAT_MESSAGES.failed;
  }

  const kept =
    status === "complete"
      ? partitionCitations(filter.citations, {
          photoIds: allowedPhotos,
          measurementIds: allowedMeasurements,
        })
      : { photoIds: [], measurementIds: [], dropped: 0 };
  // A cited measurement brings its source photo (PRD: "an answer with the source photo and
  // date"), server-side, whatever the model cited: the photo came from a tool result of this
  // turn (RLS-scoped) and the grid is signed under the caller's claims again.
  const citedPhotoIds = [...kept.photoIds];
  for (const m of kept.measurementIds) {
    const ph = measurementPhotos.get(m);
    if (ph && !citedPhotoIds.includes(ph)) citedPhotoIds.push(ph);
  }
  if (searchGroups.length > 1) {
    // Comparison turns: cited photos follow the round-robin order of the searches.
    const order = new Map(interleave(searchGroups).map((id, i) => [id, i]));
    citedPhotoIds.sort(
      (a, b) =>
        (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  const cited = citedPhotoIds.length + kept.measurementIds.length;
  const photoIds =
    citedPhotoIds.length > 0
      ? citedPhotoIds.slice(0, CHAT_LIMITS.photos)
      : status === "complete" && lastSearch
        ? lastSearch.slice(0, SEARCH_RESULT_LIMIT)
        : [];
  const result: TurnResult = {
    text: text.trim().slice(0, 8000) || CHAT_MESSAGES.nothingFound,
    citations: {
      photoIds: citedPhotoIds.slice(0, CHAT_LIMITS.citations),
      measurementIds: kept.measurementIds,
    },
    photoIds,
    grounded: status === "complete" && (cited > 0 || !anyData),
    status,
    usage: { ...usage, costUsd: Math.round(usage.costUsd * 1e10) / 1e10 },
    toolsUsed,
    model: deps.chat.model,
    citationsDropped: kept.dropped + filter.invalid,
    finishReason,
  };
  deps.log?.info(
    {
      status,
      finishReason,
      calls: usage.calls,
      tools: toolsUsed,
      citedPhotos: citedPhotoIds.length,
      measurementPhotos: citedPhotoIds.length - kept.photoIds.length,
      citedMeasurements: kept.measurementIds.length,
      citationsDropped: result.citationsDropped,
      photos: photoIds.length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      costUsd: result.usage.costUsd,
      fastPath,
      fastPathDeclined,
      searches: searchLogs,
      firstDeltaMs,
      roundMs,
      toolMs,
      ms: Date.now() - started,
    },
    "chat turn",
  );
  yield { type: "final", result };
}
