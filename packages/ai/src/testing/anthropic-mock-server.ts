/**
 * In-process Anthropic mock (docs/plans/step-6.md 2.5, D1): `/v1/messages/batches` (create,
 * retrieve, results JSONL, cancel, delete; ends after N retrieves) and `/v1/messages` (one canned
 * structured response). Requires `x-api-key` and `anthropic-version: 2023-06-01`.
 */

import { randomUUID } from "node:crypto";
import { fakeDescription } from "../fake/describe";
import { type MockServerBase, type RecordedRequest, startMockServer } from "./mock-http";

/**
 * `ok`, `refusal` (`stop_reason: refusal`), `max_tokens` (truncated), `invalid_json`,
 * `errored_rate_limit` / `errored_server` (`errored` result), `expired`, `canceled`.
 */
export type AnthropicMockOutcome =
  | "ok"
  | "refusal"
  | "max_tokens"
  | "invalid_json"
  | "errored_rate_limit"
  | "errored_server"
  | "expired"
  | "canceled";

export interface AnthropicMockOptions {
  /** Retrieves answered `in_progress` before the batch ends (default 1). */
  completeAfterPolls?: number;
  outcome?: (customId: string | null) => AnthropicMockOutcome;
  describe?: (customId: string) => unknown;
  /** Usage per answered request (Anthropic semantics: `input` excludes cache reads/writes). */
  usage?: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    output: number;
  };
}

export interface MockMessageBatch {
  id: string;
  type: "message_batch";
  processing_status: "in_progress" | "canceling" | "ended";
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  ended_at: string | null;
  created_at: string;
  expires_at: string;
  cancel_initiated_at: string | null;
  results_url: string | null;
  polls: number;
  requests: { custom_id: string; params: Record<string, unknown> }[];
  results: string[];
}

export interface AnthropicMockServer extends MockServerBase {
  batches: Map<string, MockMessageBatch>;
  deletedBatches: string[];
}

const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export async function startAnthropicMockServer(
  options: AnthropicMockOptions = {},
): Promise<AnthropicMockServer> {
  const batches = new Map<string, MockMessageBatch>();
  const deletedBatches: string[] = [];
  const completeAfter = options.completeAfterPolls ?? 1;
  const usage = options.usage ?? { input: 700, cacheRead: 700, cacheWrite: 0, output: 400 };
  const outcomeOf = options.outcome ?? (() => "ok" as const);
  const describe = options.describe ?? ((id: string) => fakeDescription(id));
  let baseUrl = "";

  const usageJson = (output = usage.output) => ({
    input_tokens: usage.input,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_creation: {
      ephemeral_5m_input_tokens: usage.cacheWrite - (usage.cacheWrite1h ?? 0),
      ephemeral_1h_input_tokens: usage.cacheWrite1h ?? 0,
    },
    output_tokens: output,
  });

  function message(customId: string | null, outcome: AnthropicMockOutcome, model: string) {
    const base = {
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model,
    };
    switch (outcome) {
      case "refusal":
        return {
          ...base,
          content: [{ type: "text", text: "I can't help with that." }],
          stop_reason: "refusal",
          usage: usageJson(10),
        };
      case "max_tokens":
        return {
          ...base,
          content: [{ type: "text", text: '{"caption": "A baby' }],
          stop_reason: "max_tokens",
          usage: usageJson(),
        };
      case "invalid_json":
        return {
          ...base,
          content: [{ type: "text", text: '{"caption": "A baby sits"' }],
          stop_reason: "end_turn",
          usage: usageJson(),
        };
      default:
        return {
          ...base,
          content: [{ type: "text", text: JSON.stringify(describe(customId ?? "realtime")) }],
          stop_reason: "end_turn",
          usage: usageJson(),
        };
    }
  }

  function finish(b: MockMessageBatch) {
    const counts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
    b.results = b.requests.map((r) => {
      const outcome = outcomeOf(r.custom_id);
      const model = String(r.params.model);
      let result: unknown;
      if (outcome === "expired") {
        counts.expired++;
        result = { type: "expired" };
      } else if (outcome === "canceled") {
        counts.canceled++;
        result = { type: "canceled" };
      } else if (outcome === "errored_rate_limit" || outcome === "errored_server") {
        counts.errored++;
        result = {
          type: "errored",
          error: {
            type: "error",
            error: {
              type: outcome === "errored_rate_limit" ? "rate_limit_error" : "api_error",
              message: "mock error",
            },
          },
        };
      } else {
        counts.succeeded++;
        result = { type: "succeeded", message: message(r.custom_id, outcome, model) };
      }
      return JSON.stringify({ custom_id: r.custom_id, result });
    });
    b.results.reverse(); // results are not in input order
    b.request_counts = counts;
    b.processing_status = "ended";
    b.ended_at = new Date().toISOString();
    b.results_url = `${baseUrl}/v1/messages/batches/${b.id}/results`;
  }

  const json = (b: MockMessageBatch) => {
    const { polls: _p, requests: _r, results: _res, ...rest } = b;
    return rest;
  };
  const err = (status: number, type: string) => ({
    status,
    json: { type: "error", error: { type, message: "mock" } },
  });

  const base = await startMockServer(async (req: RecordedRequest) => {
    if (!req.headers["x-api-key"]) return err(401, "authentication_error");
    if (req.headers["anthropic-version"] !== "2023-06-01") return err(400, "invalid_request_error");
    const m = req.method;
    const p = req.path;
    if (m === "POST" && p === "/v1/messages/batches") {
      const body = req.body as { requests?: unknown } | undefined;
      if (!Array.isArray(body?.requests) || body.requests.length === 0)
        return err(400, "invalid_request_error");
      const requests = body.requests as { custom_id: string; params: Record<string, unknown> }[];
      const ids = new Set<string>();
      for (const r of requests) {
        if (
          typeof r.custom_id !== "string" ||
          !CUSTOM_ID.test(r.custom_id) ||
          ids.has(r.custom_id)
        ) {
          return err(400, "invalid_request_error");
        }
        ids.add(r.custom_id);
        if (typeof r.params?.model !== "string") return err(400, "invalid_request_error");
      }
      const created = new Date();
      const b: MockMessageBatch = {
        id: `msgbatch_${randomUUID().replaceAll("-", "")}`,
        type: "message_batch",
        processing_status: "in_progress",
        request_counts: {
          processing: requests.length,
          succeeded: 0,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
        ended_at: null,
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + 86_400_000).toISOString(),
        cancel_initiated_at: null,
        results_url: null,
        polls: 0,
        requests,
        results: [],
      };
      batches.set(b.id, b);
      return { status: 200, json: json(b) };
    }
    let match = /^\/v1\/messages\/batches\/([^/]+)$/.exec(p);
    if (match && (m === "GET" || m === "DELETE")) {
      const id = decodeURIComponent(match[1] as string);
      const b = batches.get(id);
      if (!b) return err(404, "not_found_error");
      if (m === "DELETE") {
        if (b.processing_status !== "ended") return err(400, "invalid_request_error");
        batches.delete(id);
        deletedBatches.push(id);
        return { status: 200, json: { id, type: "message_batch_deleted" } };
      }
      if (b.processing_status !== "ended") {
        b.polls++;
        if (b.polls > completeAfter || b.processing_status === "canceling") finish(b);
      }
      return { status: 200, json: json(b) };
    }
    match = /^\/v1\/messages\/batches\/([^/]+)\/results$/.exec(p);
    if (m === "GET" && match) {
      const b = batches.get(decodeURIComponent(match[1] as string));
      if (!b) return err(404, "not_found_error");
      if (b.processing_status !== "ended") return err(400, "invalid_request_error");
      return { status: 200, text: `${b.results.join("\n")}\n`, contentType: "application/binary" };
    }
    match = /^\/v1\/messages\/batches\/([^/]+)\/cancel$/.exec(p);
    if (m === "POST" && match) {
      const b = batches.get(decodeURIComponent(match[1] as string));
      if (!b) return err(404, "not_found_error");
      if (b.processing_status === "in_progress") {
        b.processing_status = "canceling";
        b.cancel_initiated_at = new Date().toISOString();
      }
      return { status: 200, json: json(b) };
    }
    if (m === "POST" && p === "/v1/messages") {
      const body = req.body as { model?: string } | undefined;
      const outcome = outcomeOf(null);
      if (outcome === "errored_rate_limit") return err(429, "rate_limit_error");
      if (outcome === "errored_server") return err(500, "api_error");
      return { status: 200, json: message(null, outcome, body?.model ?? "unknown") };
    }
    return err(404, "not_found_error");
  });
  baseUrl = base.baseUrl;
  return { ...base, batches, deletedBatches };
}
