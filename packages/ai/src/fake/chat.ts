/**
 * Deterministic rule-based chat model (`VISION_PROVIDER=fake`; docs/plans/step-7.md 2.5, D1).
 * Used by CI, the keyless dev stack and the golden gate. No key, no network.
 *
 * One turn = two calls, like a real tool-using model:
 * 1. After a user message, it plans tool calls from the text (`planFakeToolCalls`):
 *    - a photo id ("tell me about photo <uuid>") ⇒ `get_photo`;
 *    - measurement words (weigh, weight, heavy, height, tall, long, length, head) ⇒
 *      `get_measurements {kind, date range}` (ages are converted to dates with the birth date);
 *    - "when did", "first time", "milestone" ⇒ `get_milestones {}`;
 *    - otherwise `search_photos`: people from "with <Name>, <Name> and <Name>" (capitalised words
 *      and family words: Grandma, Grandpa, Mom, Dad, Nanny, Aunt <Name>…), milestones from the 11
 *      preset names (singular/plural tolerant) and "first <word>" phrases, temporal phrases
 *      (`resolveTemporal`, relative to the prompt's `Today:` and `Birth date:` lines), `#tag`
 *      tokens as tags, and the remaining content words as `query` (null when none). A
 *      comparison ("at 1, 6 and 12 months") makes one `search_photos` call per age (parallel).
 * 2. After the tool results, it composes the answer deterministically, citing only ids that a
 *    tool returned (with `formatCitation`): search ⇒ "Here are N photos that match." + every
 *    returned photo id in rank order; measurements ⇒ one sentence per row with its measurement
 *    id (and its linked photo id, if any); milestones ⇒ one line each with its first photo id; get_photo ⇒ the caption + id; no
 *    data ⇒ `CHAT_MESSAGES.nothingFound`. The text streams in three deltas (`delayMs` apart).
 * With `jsonSchema` (re-rank), it answers `{"<first array property>": [every uuid in the last
 * user message, in order]}` (an identity ranking).
 *
 * Usage per call is fixed (1,500 input / 120 output, 0 reasoning) and priced on the configured
 * chat model's standard tier, so the `ai_spend` ledger is non-zero. Refuses construction when
 * `NODE_ENV=production` unless `AI_ALLOW_FAKE_IN_PRODUCTION=true`.
 *
 * Test scripts (`options.script`): `cite_unknown` (adds a citation of a random uuid no tool
 * returned), `bad_args` (the first `search_photos` asks for `limit: 999`), `no_cite` (answers
 * without markers), `length` (stops early with `finishReason: "length"`).
 */

import { randomUUID } from "node:crypto";
import {
  CHAT_MESSAGES,
  type ChatToolName,
  formatCitation,
  type MeasurementKind,
  MILESTONE_PRESETS,
} from "@littlelight/shared";
import { DEFAULT_CHAT_MODEL } from "../defaults";
import { AiNotConfiguredError } from "../errors";
import { drainChatStream } from "../openai/chat";
import { assertPriced, costUsd } from "../pricing";
import { readChatPromptDates } from "../prompts/chat-v1";
import type {
  AiLogger,
  ChatCompletion,
  ChatFinishReason,
  ChatMessage,
  ChatModel,
  ChatOptions,
  ChatStreamEvent,
  ChatToolCall,
  ChatToolDefinition,
  ModelUsage,
} from "../types";
import { ageRangeToDates, resolveTemporal, type TemporalRange } from "./temporal";

export type FakeChatScript = "cite_unknown" | "bad_args" | "no_cite" | "length";

export interface FakeChatOptions {
  /** Model whose price table is used (default `gpt-6-luna`; must be priced). */
  model?: string;
  /** Milliseconds between the three text deltas (default 20; tests use 0). */
  delayMs?: number;
  /** Tests only (see module doc). */
  script?: FakeChatScript;
  /** Fallback "today" when the system prompt has no `Today:` line (default: the UTC date). */
  now?: () => Date;
  log?: AiLogger;
  /** Process env used for the production guard (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Fixed per-call usage of the fake. */
export const FAKE_CHAT_USAGE = { inputTokens: 1500, outputTokens: 120 } as const;

/** A planned tool call (arguments exactly as the strict tool schemas expect). */
export interface FakePlannedCall {
  name: ChatToolName;
  arguments: Record<string, unknown>;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const FAMILY_WORDS = [
  "grandma",
  "grandpa",
  "granny",
  "grandad",
  "granddad",
  "grandmother",
  "grandfather",
  "nana",
  "nanna",
  "papa",
  "mom",
  "mum",
  "mommy",
  "mummy",
  "mama",
  "dad",
  "daddy",
  "dada",
  "nanny",
  "babysitter",
] as const;
const TITLES = ["aunt", "auntie", "uncle", "cousin", "grandma", "grandpa", "nana", "papa"];

const MEASUREMENT_WORDS: ReadonlyArray<[RegExp, MeasurementKind]> = [
  [/\b(weigh|weighs|weighed|weight|weights|heavy|heavier)\b/i, "weight"],
  [/\b(head|circumference)\b/i, "head"],
  [/\b(height|heights|tall|taller|long|length)\b/i, "height"],
];

/** Words dropped from the query after the structured parts were taken out. */
const QUERY_FILLER = new Set(
  (
    "a an and any all are at be can could did do does find for from get give had has have her " +
    "hers him his how i in is it its let look looking me my of on or our please photo photos " +
    "pic pics picture pictures see shot shots show some tell that the their them there these " +
    "they this those to us was we were what whats when where which who with you your " +
    "happened happen"
  ).split(" "),
);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Preset milestone names (not the "[person]" template), each with a tolerant matcher. */
const PRESET_MATCHERS = MILESTONE_PRESETS.filter((p) => !p.name.includes("[")).map((p) => ({
  name: p.name,
  re: new RegExp(
    `\\b${p.name
      .toLowerCase()
      .split(" ")
      .map((w) => `${w.replace(/s$/, "")}s?`)
      .join("\\s+")}\\b`,
    "gi",
  ),
}));

const NOT_MILESTONE_AFTER_FIRST = new Set([
  "time",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "day",
  "days",
  "few",
  "one",
  "photo",
  "photos",
  "picture",
  "pictures",
]);

/** `[Gg]randma`: first letter either case (JS regexes have no inline case modifier on Node 22). */
const eitherCase = (w: string) => `[${w[0]?.toUpperCase()}${w[0]}]${w.slice(1)}`;
const NAME = `(?:(?:${TITLES.map(eitherCase).join("|")})\\s+[A-Z][\\p{L}'-]*|(?:${FAMILY_WORDS.map(eitherCase).join("|")})(?![\\p{L}])|[A-Z][\\p{L}'-]*)`;
/** "with Grandma", "with Aunt Lily and Dad", "With Sam, Mia & grandpa". */
const WITH_PEOPLE_RE = new RegExp(
  `\\b[Ww]ith\\s+(${NAME}(?:\\s*(?:,|and|&|\\+)\\s*${NAME})*)`,
  "gu",
);

interface PlanContext {
  today: string;
  birthDate: string | null;
}

/** Splits "Grandma, Aunt Lily and Dad" into names; keeps capitalised words and family words. */
function namesFrom(list: string): string[] {
  const out: string[] = [];
  for (const raw of list.split(/\s*(?:,|\band\b|&|\+)\s*/i)) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const first = (words[0] as string).toLowerCase();
    if (TITLES.includes(first) && words[1] && /^[A-Z]/.test(words[1])) {
      out.push(`${capitalize(first)} ${words[1]}`);
      continue;
    }
    if ((FAMILY_WORDS as readonly string[]).includes(first)) {
      out.push(capitalize(first));
      continue;
    }
    if (/^[A-Z][\p{L}'-]*$/u.test(words[0] as string)) out.push(words[0] as string);
  }
  return out;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = v.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The tool calls the fake makes for a user message (exported for tests and the golden set).
 * Deterministic for a given text, today and birth date.
 */
export function planFakeToolCalls(
  text: string,
  ctx: PlanContext,
  script?: FakeChatScript,
): FakePlannedCall[] {
  // 1. One photo by id.
  const ids = text.match(UUID_RE);
  if (ids && /\bphoto\b/i.test(text)) {
    return [{ name: "get_photo", arguments: { photo_id: (ids[0] as string).toLowerCase() } }];
  }

  const temporal = resolveTemporal(text, { today: ctx.today, birthDate: ctx.birthDate });

  // 2. Measurements.
  const measurement = MEASUREMENT_WORDS.find(([re]) => re.test(text));
  if (measurement) {
    const range = temporal.ranges[0];
    let dates: { dateFrom: string | null; dateTo: string | null } = {
      dateFrom: null,
      dateTo: null,
    };
    if (range) {
      // A comparison spans from the first range's start to the last range's end.
      const last = temporal.ranges[temporal.ranges.length - 1] as TemporalRange;
      const merged: TemporalRange = {
        dateFrom: range.dateFrom,
        dateTo: last.dateTo,
        ageFromDays: range.ageFromDays,
        ageToDays: last.ageToDays,
      };
      dates = ageRangeToDates(merged, ctx.birthDate);
    }
    return [
      {
        name: "get_measurements",
        arguments: { kind: measurement[1], date_from: dates.dateFrom, date_to: dates.dateTo },
      },
    ];
  }

  // 3. Milestone questions.
  if (/\b(when did|first time|milestones?)\b/i.test(text)) {
    return [{ name: "get_milestones", arguments: {} }];
  }

  // 4. Photo search.
  let rest = ` ${temporal.rest} `;
  const people: string[] = [];
  rest = rest.replace(WITH_PEOPLE_RE, (m, list: string) => {
    const names = namesFrom(list);
    if (names.length === 0) return m;
    people.push(...names);
    return " ";
  });
  rest = rest.replace(
    new RegExp(`\\b(${FAMILY_WORDS.join("|")})(?:'s)?\\b`, "gi"),
    (_m, w: string) => {
      people.push(capitalize(w.toLowerCase()));
      return " ";
    },
  );
  const milestones: string[] = [];
  for (const p of PRESET_MATCHERS) {
    rest = rest.replace(p.re, () => {
      milestones.push(p.name);
      return " ";
    });
  }
  rest = rest.replace(/\bfirst\s+([a-z]+)\b/gi, (m, w: string) => {
    if (NOT_MILESTONE_AFTER_FIRST.has(w.toLowerCase())) return m;
    milestones.push(`First ${w.toLowerCase()}`);
    return " ";
  });
  const tags: string[] = [];
  rest = rest.replace(/#([\p{L}\p{N}_-]{1,60})/gu, (_m, t: string) => {
    tags.push(t.toLowerCase());
    return " ";
  });
  const words = rest
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !QUERY_FILLER.has(w.toLowerCase()));
  const query = words.length ? words.join(" ").slice(0, 300) : null;

  const common = {
    query,
    milestones: dedupe(milestones).slice(0, 5),
    people: dedupe(people).slice(0, 5),
    tags: dedupe(tags).slice(0, 10),
  };
  const ranges: (TemporalRange | null)[] = temporal.ranges.length ? temporal.ranges : [null];
  return ranges.map((r, i) => ({
    name: "search_photos" as const,
    arguments: {
      query: common.query,
      date_from: r?.dateFrom ?? null,
      date_to: r?.dateTo ?? null,
      age_from_days: r?.ageFromDays ?? null,
      age_to_days: r?.ageToDays ?? null,
      milestones: common.milestones,
      people: common.people,
      tags: common.tags,
      limit: script === "bad_args" && i === 0 ? 999 : null,
    },
  }));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const KIND_LABEL: Record<string, string> = {
  weight: "Weight",
  height: "Height",
  head: "Head circumference",
};

/**
 * The fake's answer to one turn's tool results (exported for tests): every id it cites comes
 * from a tool result. `cite` false omits markers (the `no_cite` script).
 */
export function composeFakeAnswer(
  results: { name: string; content: string }[],
  cite = true,
): string {
  const c = (kind: "photo" | "measurement", id: string) =>
    cite ? ` ${formatCitation(kind, id)}` : "";
  const parts: string[] = [];
  for (const r of results) {
    let data: unknown;
    try {
      data = JSON.parse(r.content);
    } catch {
      continue;
    }
    if (!isObj(data) || "error" in data) continue;
    if (r.name === "search_photos") {
      const rows = Array.isArray(data.results) ? data.results.filter(isObj) : [];
      const photoIds = rows
        .map((x) => x.photo_id)
        .filter((x): x is string => typeof x === "string");
      if (photoIds.length === 0) continue;
      const n = photoIds.length;
      parts.push(
        `Here ${n === 1 ? "is 1 photo that matches" : `are ${n} photos that match`}.${photoIds.map((id) => c("photo", id)).join("")}`,
      );
    } else if (r.name === "get_measurements") {
      const rows = Array.isArray(data.measurements) ? data.measurements.filter(isObj) : [];
      for (const m of rows) {
        if (typeof m.measurement_id !== "string") continue;
        const label = KIND_LABEL[String(m.kind)] ?? "Measurement";
        const age = typeof m.age === "string" ? ` (${m.age})` : "";
        const photo = typeof m.photo_id === "string" ? c("photo", m.photo_id) : "";
        parts.push(
          `${label} ${String(m.value)} on ${String(m.measured_at)}${age}.${c("measurement", m.measurement_id)}${photo}`,
        );
      }
    } else if (r.name === "get_milestones") {
      const rows = Array.isArray(data.milestones) ? data.milestones.filter(isObj) : [];
      const lines: string[] = [];
      for (const m of rows) {
        const photoIds = strs(m.photo_ids);
        const when =
          typeof m.date === "string"
            ? ` on ${m.date}${typeof m.age === "string" ? ` (${m.age})` : ""}`
            : "";
        lines.push(`${String(m.name)}${when}.${photoIds[0] ? c("photo", photoIds[0]) : ""}`);
      }
      if (lines.length) parts.push(lines.join("\n"));
    } else if (r.name === "get_photo") {
      if (typeof data.photo_id !== "string") continue;
      const caption =
        typeof data.caption === "string"
          ? data.caption
          : typeof data.description === "string"
            ? data.description
            : "Here is that photo.";
      parts.push(`${caption}${c("photo", data.photo_id)}`);
    }
  }
  return parts.length ? parts.join("\n") : CHAT_MESSAGES.nothingFound;
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Three roughly equal chunks (may split a citation marker: the API's filter must cope). */
function threeChunks(text: string): string[] {
  if (text.length < 3) return [text];
  const a = Math.floor(text.length / 3);
  const b = Math.floor((2 * text.length) / 3);
  return [text.slice(0, a), text.slice(a, b), text.slice(b)];
}

export function createFakeChatModel(options: FakeChatOptions = {}): ChatModel {
  const env = options.env ?? process.env;
  if (env.NODE_ENV === "production" && env.AI_ALLOW_FAKE_IN_PRODUCTION !== "true") {
    throw new AiNotConfiguredError(
      "AI disabled: VISION_PROVIDER=fake is refused in production (AI_ALLOW_FAKE_IN_PRODUCTION not set)",
    );
  }
  const model = options.model ?? DEFAULT_CHAT_MODEL;
  assertPriced(model, "CHAT_MODEL");
  const delayMs = options.delayMs ?? 20;
  const now = options.now ?? (() => new Date());

  function usage(): ModelUsage {
    return {
      inputTokens: FAKE_CHAT_USAGE.inputTokens,
      cachedInputTokens: 0,
      outputTokens: FAKE_CHAT_USAGE.outputTokens,
      reasoningTokens: 0,
      costUsd: costUsd(model, "standard", {
        inputTokens: FAKE_CHAT_USAGE.inputTokens,
        cachedInputTokens: 0,
        outputTokens: FAKE_CHAT_USAGE.outputTokens,
      }),
    };
  }

  async function* stream(
    messages: ChatMessage[],
    tools: readonly ChatToolDefinition[],
    callOptions: ChatOptions = {},
  ): AsyncGenerator<ChatStreamEvent> {
    const started = Date.now();
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const dates = readChatPromptDates(system);
    const ctx: PlanContext = {
      today: dates.today ?? now().toISOString().slice(0, 10),
      birthDate: dates.birthDate,
    };
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUser = i;
        break;
      }
    }
    const userText = lastUser >= 0 ? (messages[lastUser]?.content ?? "") : "";
    const turn = messages.slice(lastUser + 1);
    const priorCalls = turn.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []));
    const done = (
      text: string,
      toolCalls: ChatToolCall[],
      finishReason: ChatFinishReason,
    ): ChatCompletion => ({
      model,
      text,
      toolCalls,
      finishReason,
      usage: usage(),
      latencyMs: Date.now() - started,
      providerItems: [{ type: "fake_turn_marker", calls: toolCalls.map((t) => t.id) }],
    });

    const respond = async function* (text: string, finishReason: ChatFinishReason) {
      for (const [i, chunk] of threeChunks(text).entries()) {
        if (callOptions.signal?.aborted) break;
        if (i > 0) await sleep(delayMs);
        if (chunk) yield { type: "text_delta" as const, delta: chunk };
      }
      const completion = done(text, [], finishReason);
      options.log?.info(
        { provider: "fake", op: "chat", model, finishReason, tools: [], ms: completion.latencyMs },
        "ai chat call",
      );
      yield { type: "done" as const, completion };
    };

    // Structured output (re-rank): identity ranking of the uuids in the prompt.
    if (callOptions.jsonSchema) {
      const props = callOptions.jsonSchema.schema.properties;
      const key =
        (isObj(props) &&
          Object.entries(props).find(
            ([, v]) => isObj(v) && String(v.type).includes("array"),
          )?.[0]) ||
        "ids";
      const ids = dedupe((userText.match(UUID_RE) ?? []).map((x) => x.toLowerCase()));
      yield* respond(JSON.stringify({ [key]: ids }), "stop");
      return;
    }

    // Round 1: plan tool calls.
    const canUseTools = tools.length > 0 && callOptions.toolChoice !== "none";
    if (priorCalls.length === 0 && canUseTools) {
      const available = new Set(tools.map((t) => t.name));
      const planned = planFakeToolCalls(userText, ctx, options.script).filter((p) =>
        available.has(p.name),
      );
      if (planned.length > 0) {
        const round = turn.filter((m) => m.role === "assistant").length;
        const calls: ChatToolCall[] = planned.map((p, i) => ({
          id: `call_fake_${round}_${i}`,
          name: p.name,
          arguments: p.arguments,
        }));
        for (const call of calls) yield { type: "tool_call", toolCall: call };
        const completion = done("", calls, "tool_calls");
        options.log?.info(
          {
            provider: "fake",
            op: "chat",
            model,
            finishReason: "tool_calls",
            tools: calls.map((c) => c.name),
            ms: completion.latencyMs,
          },
          "ai chat call",
        );
        yield { type: "done", completion };
        return;
      }
    }

    // Round 2: answer from this turn's tool results.
    const nameById = new Map(priorCalls.map((c) => [c.id, c.name]));
    const results = turn
      .filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool")
      .map((m) => ({ name: nameById.get(m.toolCallId) ?? "", content: m.content }));
    let text = composeFakeAnswer(results, options.script !== "no_cite");
    if (options.script === "cite_unknown") text += ` ${formatCitation("photo", randomUUID())}`;
    if (options.script === "length") {
      yield* respond(text.slice(0, Math.max(1, Math.floor(text.length / 2))), "length");
      return;
    }
    yield* respond(text, "stop");
  }

  async function complete(
    messages: ChatMessage[],
    tools: readonly ChatToolDefinition[],
    callOptions?: ChatOptions,
  ): Promise<ChatCompletion> {
    return drainChatStream(stream(messages, tools, callOptions), "fake");
  }

  return { provider: "fake", model, complete, stream };
}
