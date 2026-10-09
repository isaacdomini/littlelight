/**
 * In-process OpenAI mock (docs/plans/step-6.md 2.5, D1; docs/plans/step-7.md 2.5): `/v1/files`
 * (upload, content, delete), `/v1/batches` (create, retrieve, cancel; completes after N
 * retrieves; can expire or fail validation), `/v1/responses` (one canned structured response;
 * with `stream: true` a scripted chat turn as SSE in the Responses event names of plan 2.2),
 * `/v1/embeddings` (bag-of-words vectors, `usage.prompt_tokens`). Lets the real adapters' wire
 * format be asserted byte-for-byte without network:
 *
 *   const mock = await startOpenAiMockServer({ completeAfterPolls: 1 });
 *   const d = createOpenAiVisionDescriber({ ...opts, apiKey: "test", baseUrl: mock.baseUrl });
 *   ...; mock.requests  // every request, with parsed JSON / multipart fields
 *   await mock.close();
 */

import { randomUUID } from "node:crypto";
import { fakeDescription } from "../fake/describe";
import { fakeEmbedding, fakeTokenCount } from "../fake/embed";
import { type MockServerBase, type RecordedRequest, startMockServer } from "./mock-http";

/**
 * Per-request outcome: `ok` (valid JSON description), `refusal` (refusal content part),
 * `incomplete` (`status: incomplete`, `max_output_tokens`), `invalid_json` (truncated text),
 * `error_429` / `error_500` (non-200 line in the error file), `expired` (`batch_expired` in the
 * error file; makes the batch `expired`).
 */
export type OpenAiMockOutcome =
  | "ok"
  | "refusal"
  | "incomplete"
  | "invalid_json"
  | "error_429"
  | "error_500"
  | "expired";

export interface OpenAiMockOptions {
  /** Retrieves answered `in_progress` before the batch completes (default 1). */
  completeAfterPolls?: number;
  /** Outcome per `custom_id` (real-time calls get `null`). Default `ok`. */
  outcome?: (customId: string | null) => OpenAiMockOutcome;
  /** The batch fails input validation (`status: failed`, `errors.data[0].code`). */
  failValidation?: boolean;
  /** Description returned for `ok` (default `fakeDescription(customId)`). */
  describe?: (customId: string) => unknown;
  /** Usage per answered request. */
  usage?: { input: number; cached: number; output: number; reasoning?: number };
  /**
   * Streamed chat (`/v1/responses` with `stream: true`): the output steps of call `callIndex`
   * (0-based over streamed calls). Default `defaultChatScript`.
   */
  chatScript?: (body: Record<string, unknown>, callIndex: number) => OpenAiMockChatStep[];
}

/**
 * One step of a streamed chat response. `reasoning` emits a reasoning item with
 * `encrypted_content`; `function_call` an item whose arguments stream in 3 deltas; `text` a
 * message whose text streams in deltas of ≤ 12 characters. A trailing `incomplete`, `failed` or
 * `error` step ends the stream with that event instead of `response.completed`; `truncate` ends
 * it without any terminal event.
 */
export type OpenAiMockChatStep =
  | { type: "reasoning" }
  | { type: "function_call"; name: string; arguments: unknown }
  | { type: "text"; text: string }
  | { type: "incomplete"; reason: "max_output_tokens" | "content_filter" }
  | { type: "failed"; code: string }
  | { type: "error"; code: string }
  | { type: "truncate" };

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Default chat script: without a `function_call_output` in the input, a reasoning item and one
 * `search_photos` call (query = the last user text); with one, a reasoning item and a final
 * answer citing the first uuid found in the tool outputs.
 */
export function defaultChatScript(body: Record<string, unknown>): OpenAiMockChatStep[] {
  const input = Array.isArray(body.input) ? (body.input as Record<string, unknown>[]) : [];
  const outputs = input.filter((i) => i?.type === "function_call_output");
  if (outputs.length === 0) {
    const lastUser = [...input].reverse().find((i) => i?.role === "user");
    return [
      { type: "reasoning" },
      {
        type: "function_call",
        name: "search_photos",
        arguments: {
          query: typeof lastUser?.content === "string" ? lastUser.content : null,
          date_from: null,
          date_to: null,
          age_from_days: null,
          age_to_days: null,
          milestones: [],
          people: [],
          tags: [],
          limit: null,
        },
      },
    ];
  }
  const id = outputs
    .map((o) => String(o.output ?? ""))
    .join(" ")
    .match(UUID_RE)?.[0];
  return [
    { type: "reasoning" },
    { type: "text", text: id ? `Here is the bath photo [photo:${id}].` : "Nothing matched." },
  ];
}

export interface MockFile {
  id: string;
  purpose: string;
  filename: string;
  content: string;
}

export interface MockBatch {
  id: string;
  object: "batch";
  endpoint: string;
  input_file_id: string;
  completion_window: string;
  metadata: unknown;
  status: string;
  polls: number;
  output_file_id: string | null;
  error_file_id: string | null;
  created_at: number;
  expires_at: number;
  request_counts: { total: number; completed: number; failed: number };
  errors: { object: "list"; data: { code: string; line: number | null; message: string }[] } | null;
}

export interface OpenAiMockServer extends MockServerBase {
  files: Map<string, MockFile>;
  batches: Map<string, MockBatch>;
  /** File ids deleted through `DELETE /v1/files/{id}`. */
  deletedFiles: string[];
}

const now = () => Math.floor(Date.now() / 1000);

export async function startOpenAiMockServer(
  options: OpenAiMockOptions = {},
): Promise<OpenAiMockServer> {
  const files = new Map<string, MockFile>();
  const batches = new Map<string, MockBatch>();
  const deletedFiles: string[] = [];
  const completeAfter = options.completeAfterPolls ?? 1;
  const usage = options.usage ?? { input: 1400, cached: 700, output: 400, reasoning: 0 };
  const outcomeOf = options.outcome ?? (() => "ok" as const);
  const describe = options.describe ?? ((id: string) => fakeDescription(id));
  const chatScript = options.chatScript ?? defaultChatScript;
  let chatCalls = 0;

  const usageJson = (output = usage.output) => ({
    input_tokens: usage.input,
    input_tokens_details: { cached_tokens: usage.cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
    total_tokens: usage.input + output,
  });

  /** A Responses API object for a given outcome (only the 200-status outcomes). */
  function responseObject(customId: string | null, outcome: OpenAiMockOutcome, model: string) {
    const base = { id: `resp_${randomUUID().replaceAll("-", "")}`, object: "response", model };
    const message = (content: unknown[]) => [
      { type: "message", id: "msg_1", status: "completed", role: "assistant", content },
    ];
    switch (outcome) {
      case "refusal":
        return {
          ...base,
          status: "completed",
          output: message([{ type: "refusal", refusal: "I can't help with that request." }]),
          usage: usageJson(12),
        };
      case "incomplete":
        return {
          ...base,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: message([{ type: "output_text", text: '{"caption": "A baby', annotations: [] }]),
          usage: usageJson(),
        };
      case "invalid_json":
        return {
          ...base,
          status: "completed",
          output: message([
            { type: "output_text", text: '{"caption": "A baby sits"', annotations: [] },
          ]),
          usage: usageJson(),
        };
      default:
        return {
          ...base,
          status: "completed",
          output: message([
            {
              type: "output_text",
              text: JSON.stringify(describe(customId ?? "realtime")),
              annotations: [],
            },
          ]),
          usage: usageJson(),
        };
    }
  }

  function addFile(purpose: string, filename: string, content: string): MockFile {
    const f = { id: `file-${randomUUID().replaceAll("-", "")}`, purpose, filename, content };
    files.set(f.id, f);
    return f;
  }

  function fileJson(f: MockFile) {
    return {
      id: f.id,
      object: "file",
      bytes: Buffer.byteLength(f.content),
      created_at: now(),
      filename: f.filename,
      purpose: f.purpose,
      status: "processed",
    };
  }

  function batchJson(b: MockBatch) {
    const { polls: _polls, ...rest } = b;
    return rest;
  }

  /** Runs the batch: builds output and error files from the input lines. */
  function finish(b: MockBatch) {
    const input = files.get(b.input_file_id);
    const lines = (input?.content ?? "").split("\n").filter((l) => l.trim());
    const out: string[] = [];
    const err: string[] = [];
    let expired = false;
    for (const line of lines) {
      const req = JSON.parse(line) as { custom_id: string; body: { model: string } };
      const outcome = outcomeOf(req.custom_id);
      const id = `batch_req_${randomUUID().replaceAll("-", "")}`;
      if (outcome === "expired") {
        expired = true;
        err.push(
          JSON.stringify({
            id,
            custom_id: req.custom_id,
            response: null,
            error: {
              code: "batch_expired",
              message: "This request could not be executed before the completion window expired.",
            },
          }),
        );
      } else if (outcome === "error_429" || outcome === "error_500") {
        const status = outcome === "error_429" ? 429 : 500;
        err.push(
          JSON.stringify({
            id,
            custom_id: req.custom_id,
            response: {
              status_code: status,
              request_id: "req_x",
              body: {
                error: {
                  message: "mock error",
                  type: status === 429 ? "requests" : "server_error",
                  code: status === 429 ? "rate_limit_exceeded" : "server_error",
                },
              },
            },
            error: null,
          }),
        );
      } else {
        out.push(
          JSON.stringify({
            id,
            custom_id: req.custom_id,
            response: {
              status_code: 200,
              request_id: "req_x",
              body: responseObject(req.custom_id, outcome, req.body.model),
            },
            error: null,
          }),
        );
      }
    }
    // Output order is not input order: reverse it.
    out.reverse();
    if (out.length)
      b.output_file_id = addFile("batch_output", "batch_output.jsonl", `${out.join("\n")}\n`).id;
    if (err.length)
      b.error_file_id = addFile("batch_output", "batch_error.jsonl", `${err.join("\r\n")}`).id;
    b.request_counts = { total: lines.length, completed: out.length, failed: err.length };
    b.status = expired ? "expired" : "completed";
  }

  function validateInput(content: string): { code: string; line: number | null } | null {
    const lines = content.split("\n").filter((l) => l.trim());
    if (!lines.length) return { code: "empty_file", line: 0 };
    const models = new Set<string>();
    for (const [i, line] of lines.entries()) {
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        const body = r.body as Record<string, unknown> | undefined;
        if (
          typeof r.custom_id !== "string" ||
          r.method !== "POST" ||
          r.url !== "/v1/responses" ||
          !body
        ) {
          return { code: "invalid_request", line: i + 1 };
        }
        if ("stream" in body) return { code: "invalid_request", line: i + 1 };
        models.add(String(body.model));
      } catch {
        return { code: "invalid_json_line", line: i + 1 };
      }
    }
    if (models.size > 1) return { code: "mismatched_model", line: null };
    return null;
  }

  /** A streamed Responses turn as SSE text (event names per docs/plans/step-7.md 2.2). */
  function chatSse(steps: OpenAiMockChatStep[], model: string): string {
    const id = `resp_${randomUUID().replaceAll("-", "")}`;
    let seq = 0;
    const frames: string[] = [];
    const ev = (type: string, data: Record<string, unknown>) => {
      frames.push(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: seq++ })}\n\n`,
      );
    };
    const response = (status: string, output: unknown[], extra: Record<string, unknown> = {}) => ({
      id,
      object: "response",
      created_at: now(),
      status,
      model,
      output,
      ...extra,
    });
    const output: unknown[] = [];
    ev("response.created", { response: response("in_progress", []) });
    ev("response.in_progress", { response: response("in_progress", []) });
    let terminal: OpenAiMockChatStep | null = null;
    for (const step of steps) {
      const index = output.length;
      if (step.type === "reasoning") {
        const item = {
          type: "reasoning",
          id: `rs_${randomUUID().replaceAll("-", "")}`,
          summary: [],
          encrypted_content: `enc_${randomUUID().replaceAll("-", "")}`,
        };
        ev("response.output_item.added", {
          output_index: index,
          item: { ...item, encrypted_content: null },
        });
        ev("response.output_item.done", { output_index: index, item });
        output.push(item);
      } else if (step.type === "function_call") {
        const args =
          typeof step.arguments === "string" ? step.arguments : JSON.stringify(step.arguments);
        const itemId = `fc_${randomUUID().replaceAll("-", "")}`;
        const callId = `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
        const base = { type: "function_call", id: itemId, call_id: callId, name: step.name };
        ev("response.output_item.added", {
          output_index: index,
          item: { ...base, arguments: "", status: "in_progress" },
        });
        const third = Math.ceil(args.length / 3);
        for (let i = 0; i < args.length; i += third) {
          ev("response.function_call_arguments.delta", {
            item_id: itemId,
            output_index: index,
            delta: args.slice(i, i + third),
          });
        }
        ev("response.function_call_arguments.done", {
          item_id: itemId,
          output_index: index,
          arguments: args,
        });
        const item = { ...base, arguments: args, status: "completed" };
        ev("response.output_item.done", { output_index: index, item });
        output.push(item);
      } else if (step.type === "text") {
        const itemId = `msg_${randomUUID().replaceAll("-", "")}`;
        ev("response.output_item.added", {
          output_index: index,
          item: {
            type: "message",
            id: itemId,
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        });
        ev("response.content_part.added", {
          item_id: itemId,
          output_index: index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        for (let i = 0; i < step.text.length; i += 12) {
          ev("response.output_text.delta", {
            item_id: itemId,
            output_index: index,
            content_index: 0,
            delta: step.text.slice(i, i + 12),
          });
        }
        ev("response.output_text.done", {
          item_id: itemId,
          output_index: index,
          content_index: 0,
          text: step.text,
        });
        const part = { type: "output_text", text: step.text, annotations: [] };
        ev("response.content_part.done", {
          item_id: itemId,
          output_index: index,
          content_index: 0,
          part,
        });
        const item = {
          type: "message",
          id: itemId,
          status: "completed",
          role: "assistant",
          content: [part],
        };
        ev("response.output_item.done", { output_index: index, item });
        output.push(item);
      } else {
        terminal = step;
        break;
      }
    }
    if (terminal?.type === "truncate") return frames.join("");
    if (terminal?.type === "error") {
      ev("error", { code: terminal.code, message: "mock stream error", param: null });
      return frames.join("");
    }
    if (terminal?.type === "failed") {
      ev("response.failed", {
        response: response("failed", output, {
          error: { code: terminal.code, message: "mock failure" },
        }),
      });
      return frames.join("");
    }
    const final = response(terminal?.type === "incomplete" ? "incomplete" : "completed", output, {
      usage: usageJson(),
      ...(terminal?.type === "incomplete"
        ? { incomplete_details: { reason: terminal.reason } }
        : {}),
    });
    ev(terminal?.type === "incomplete" ? "response.incomplete" : "response.completed", {
      response: final,
    });
    return frames.join("");
  }

  const notFound = {
    status: 404,
    json: { error: { message: "No such object", type: "invalid_request_error", code: null } },
  };

  const base = await startMockServer(async (req: RecordedRequest) => {
    if (
      req.headers.authorization !== undefined &&
      !req.headers.authorization.startsWith("Bearer ")
    ) {
      return {
        status: 401,
        json: {
          error: { message: "bad auth", type: "invalid_request_error", code: "invalid_api_key" },
        },
      };
    }
    const m = req.method;
    const p = req.path;
    if (m === "POST" && p === "/v1/files") {
      const f = req.form;
      if (!f?.content || !f.purpose)
        return { status: 400, json: { error: { type: "invalid_request_error", code: null } } };
      return {
        status: 200,
        json: fileJson(addFile(f.purpose, f.filename ?? "upload.jsonl", f.content)),
      };
    }
    let match = /^\/v1\/files\/([^/]+)\/content$/.exec(p);
    if (m === "GET" && match) {
      const f = files.get(decodeURIComponent(match[1] as string));
      return f
        ? { status: 200, text: f.content, contentType: "application/octet-stream" }
        : notFound;
    }
    match = /^\/v1\/files\/([^/]+)$/.exec(p);
    if (m === "DELETE" && match) {
      const id = decodeURIComponent(match[1] as string);
      if (!files.delete(id)) return notFound;
      deletedFiles.push(id);
      return { status: 200, json: { id, object: "file", deleted: true } };
    }
    if (m === "POST" && p === "/v1/batches") {
      const body = req.body as Record<string, unknown> | undefined;
      const input = files.get(String(body?.input_file_id));
      if (!input || body?.endpoint !== "/v1/responses" || body?.completion_window !== "24h") {
        return {
          status: 400,
          json: {
            error: { message: "bad batch", type: "invalid_request_error", code: "invalid_value" },
          },
        };
      }
      const created = now();
      const b: MockBatch = {
        id: `batch_${randomUUID().replaceAll("-", "")}`,
        object: "batch",
        endpoint: body.endpoint,
        input_file_id: input.id,
        completion_window: "24h",
        metadata: body.metadata ?? null,
        status: "validating",
        polls: 0,
        output_file_id: null,
        error_file_id: null,
        created_at: created,
        expires_at: created + 86_400,
        request_counts: { total: 0, completed: 0, failed: 0 },
        errors: null,
      };
      const invalid = options.failValidation
        ? { code: "invalid_request", line: 1 }
        : validateInput(input.content);
      if (invalid) {
        b.status = "failed";
        b.errors = {
          object: "list",
          data: [{ code: invalid.code, line: invalid.line, message: "mock validation error" }],
        };
      }
      batches.set(b.id, b);
      return { status: 200, json: batchJson(b) };
    }
    match = /^\/v1\/batches\/([^/]+)$/.exec(p);
    if (m === "GET" && match) {
      const b = batches.get(decodeURIComponent(match[1] as string));
      if (!b) return notFound;
      if (["validating", "in_progress", "finalizing"].includes(b.status)) {
        b.polls++;
        if (b.polls > completeAfter) finish(b);
        else b.status = "in_progress";
      } else if (b.status === "cancelling") {
        b.status = "cancelled";
      }
      return { status: 200, json: batchJson(b) };
    }
    match = /^\/v1\/batches\/([^/]+)\/cancel$/.exec(p);
    if (m === "POST" && match) {
      const b = batches.get(decodeURIComponent(match[1] as string));
      if (!b) return notFound;
      if (!["completed", "failed", "expired", "cancelled"].includes(b.status))
        b.status = "cancelling";
      return { status: 200, json: batchJson(b) };
    }
    if (m === "POST" && p === "/v1/responses" && (req.body as { stream?: unknown })?.stream) {
      const body = req.body as Record<string, unknown>;
      return {
        status: 200,
        text: chatSse(chatScript(body, chatCalls++), String(body.model ?? "unknown")),
        contentType: "text/event-stream",
      };
    }
    if (m === "POST" && p === "/v1/responses") {
      const body = req.body as { model?: string } | undefined;
      const outcome = outcomeOf(null);
      if (outcome === "error_429" || outcome === "error_500") {
        const status = outcome === "error_429" ? 429 : 500;
        return {
          status,
          json: {
            error: {
              message: "mock",
              type: "server_error",
              code: status === 429 ? "rate_limit_exceeded" : "server_error",
            },
          },
        };
      }
      return { status: 200, json: responseObject(null, outcome, body?.model ?? "unknown") };
    }
    if (m === "POST" && p === "/v1/embeddings") {
      const body = req.body as { input?: unknown; dimensions?: number; model?: string } | undefined;
      const inputs = Array.isArray(body?.input) ? (body.input as string[]) : [String(body?.input)];
      const dims = body?.dimensions ?? 1536;
      return {
        status: 200,
        json: {
          object: "list",
          model: body?.model,
          data: inputs
            .map((t, index) => ({ object: "embedding", index, embedding: fakeEmbedding(t, dims) }))
            .reverse(),
          usage: { prompt_tokens: fakeTokenCount(inputs), total_tokens: fakeTokenCount(inputs) },
        },
      };
    }
    return notFound;
  });

  return { ...base, files, batches, deletedFiles };
}
