/**
 * In-process OpenAI mock (docs/plans/step-6.md 2.5, D1): `/v1/files` (upload, content, delete),
 * `/v1/batches` (create, retrieve, cancel; completes after N retrieves; can expire or fail
 * validation), `/v1/responses` (one canned structured response), `/v1/embeddings`. Lets the
 * real adapter's wire format be asserted byte-for-byte without network:
 *
 *   const mock = await startOpenAiMockServer({ completeAfterPolls: 1 });
 *   const d = createOpenAiVisionDescriber({ ...opts, apiKey: "test", baseUrl: mock.baseUrl });
 *   ...; mock.requests  // every request, with parsed JSON / multipart fields
 *   await mock.close();
 */

import { randomUUID } from "node:crypto";
import { fakeDescription } from "../fake/describe";
import { fakeEmbedding } from "../fake/embed";
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
          usage: { prompt_tokens: inputs.length * 10, total_tokens: inputs.length * 10 },
        },
      };
    }
    return notFound;
  });

  return { ...base, files, batches, deletedFiles };
}
