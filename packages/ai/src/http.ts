/**
 * Minimal provider HTTP client on Node's global `fetch` (no SDK, plan D2): timeout, retry with
 * jittered backoff, JSON / multipart bodies, JSONL streaming.
 *
 * Privacy: request and response bodies are never logged and never put into an error. Errors
 * carry the HTTP status and the provider's short error code/type only (`AiProviderError`).
 *
 * Retry policies (duplicate side effects matter: an orphaned upload is a copy of children's
 * photos left at the provider):
 * - `idempotent` (GET, DELETE, real-time `/v1/responses`, `/v1/messages`): network errors,
 *   408, 409, 429 and 5xx.
 * - `rate_limit_only` (file upload, batch create): 429 only, which the provider rejected
 *   before doing anything.
 * - `none`.
 */

import { AiProviderError, safeCode } from "./errors";
import type { AiLogger } from "./types";

export type RetryPolicy = "idempotent" | "rate_limit_only" | "none";

export interface HttpClientOptions {
  provider: string;
  baseUrl: string;
  /** Auth and version headers. Never logged. */
  headers: Record<string, string>;
  fetch?: typeof fetch;
  /** Default 60 s per attempt. */
  timeoutMs?: number;
  /** Default 3. */
  maxRetries?: number;
  /** Default 500 ms; doubled per attempt, ±50 % jitter, capped at 8 s. */
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: AiLogger;
}

export interface HttpRequest {
  /** Short operation name for logs and errors (`files.upload`, `batches.create`, ...). */
  op: string;
  method: "GET" | "POST" | "DELETE";
  /** Path below the base URL, starting with `/`. */
  path: string;
  json?: unknown;
  /** Pre-serialised JSON (large batch bodies are built once from parts). */
  jsonText?: string;
  form?: FormData;
  retry: RetryPolicy;
  timeoutMs?: number;
  /** Statuses returned to the caller instead of thrown (e.g. 404 on delete). */
  allowStatuses?: readonly number[];
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON body (`undefined` when empty or not JSON). */
  body: unknown;
}

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Short error code from a provider error body: OpenAI `{error: {code, type}}`, Anthropic `{error: {type}}`. */
export function providerErrorCode(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "object" && err !== null) {
      const e = err as Record<string, unknown>;
      const code = safeCode(e.code, "") || safeCode(e.type, "");
      if (code) return code;
    }
  }
  return `http_${status}`;
}

export class HttpClient {
  readonly provider: string;
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: AiLogger | undefined;

  constructor(opts: HttpClientOptions) {
    this.provider = opts.provider;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.headers = opts.headers;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.sleep = opts.sleep ?? defaultSleep;
    this.log = opts.log;
  }

  /** Absolute URL for a path, or for an absolute URL on the same origin as the base URL. */
  sameOriginPath(urlOrPath: string): string | null {
    if (urlOrPath.startsWith("/")) return urlOrPath;
    try {
      const u = new URL(urlOrPath);
      const base = new URL(this.baseUrl);
      if (u.origin !== base.origin) return null;
      const basePath = base.pathname.replace(/\/+$/, "");
      const path = u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) : u.pathname;
      return `${path}${u.search}`;
    } catch {
      return null;
    }
  }

  /** JSON request; throws `AiProviderError` on a non-2xx status not in `allowStatuses`. */
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.send(req);
    const text = await res.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    if (!res.ok && !req.allowStatuses?.includes(res.status)) {
      throw this.error(req, res.status, providerErrorCode(body, res.status), false);
    }
    return { status: res.status, body };
  }

  /**
   * Streams a JSONL body line by line without holding the file as one string. Empty lines are
   * skipped. Retries apply to obtaining the response only.
   */
  async *lines(req: HttpRequest): AsyncGenerator<string> {
    const res = await this.send(req);
    if (!res.ok) {
      let body: unknown;
      try {
        body = JSON.parse(await res.text());
      } catch {
        body = undefined;
      }
      throw this.error(req, res.status, providerErrorCode(body, res.status), false);
    }
    if (!res.body) return;
    yield* splitLines(res.body);
  }

  private error(req: HttpRequest, status: number, code: string, retryable: boolean) {
    return new AiProviderError(this.provider, req.op, status, code, retryable);
  }

  private async send(req: HttpRequest): Promise<Response> {
    const maxRetries = req.retry === "none" ? 0 : this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const headers: Record<string, string> = { ...this.headers };
      let body: string | FormData | undefined;
      if (req.json !== undefined || req.jsonText !== undefined) {
        headers["content-type"] = "application/json";
        body = req.jsonText ?? JSON.stringify(req.json);
      } else if (req.form) {
        body = req.form; // fetch sets the multipart boundary
      }
      let res: Response | undefined;
      let netCode: string | undefined;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${req.path}`, {
          method: req.method,
          headers,
          body,
          signal: AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs),
        });
      } catch (err) {
        netCode =
          err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
            ? "timeout"
            : "network";
      }
      const status = res?.status ?? 0;
      const retryable =
        req.retry === "idempotent"
          ? netCode !== undefined || RETRYABLE_STATUSES.has(status)
          : req.retry === "rate_limit_only"
            ? status === 429
            : false;
      if (res && (res.ok || !retryable || req.allowStatuses?.includes(status))) {
        this.log?.debug?.(
          { provider: this.provider, op: req.op, status, ms: Date.now() - started, attempt },
          "ai provider call",
        );
        return res;
      }
      if (!retryable || attempt >= maxRetries) {
        if (res) return res; // non-retryable or out of retries: caller maps the status
        throw this.error(req, 0, netCode ?? "network", retryable);
      }
      // Drain the failed body so the connection can be reused (contents are discarded).
      await res?.arrayBuffer().catch(() => undefined);
      const retryAfter = Number(res?.headers.get("retry-after"));
      const backoff = Math.min(8_000, this.retryBaseMs * 2 ** attempt);
      const jittered = backoff * (0.5 + Math.random());
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 60
          ? retryAfter * 1000
          : jittered;
      this.log?.warn(
        {
          provider: this.provider,
          op: req.op,
          status,
          code: netCode,
          attempt: attempt + 1,
          delayMs: Math.round(delay),
        },
        "ai provider call retry",
      );
      await this.sleep(delay);
    }
  }
}

/**
 * Splits a byte stream on `\n` (a `\r\n` line keeps no `\r`), decoding UTF-8 across chunk
 * boundaries; yields non-empty lines. Exported for tests (a line split mid-chunk).
 */
export async function* splitLines(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.trim()) yield line;
      idx = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  const last = buf.replace(/\r$/, "");
  if (last.trim()) yield last;
}
