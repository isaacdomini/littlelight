import { PassThrough } from "node:stream";
import { CHAT_SSE_KEEPALIVE, CHAT_SSE_KEEPALIVE_MS } from "@littlelight/shared";
import type { FastifyReply } from "fastify";

// Server-sent events for the chat stream (docs/plans/step-7.md 2.4, 2.8, 2.9, R6). Wire format:
// `event: <type>\ndata: <json>\n\n` per event (the same bytes as the shared `encodeChatEvent`)
// and the shared keepalive comment every `CHAT_SSE_KEEPALIVE_MS` (15 s), so cloudflared (100 s
// idle limit) and nginx keep the connection open while the model thinks.
//
// Proxy and compression safety:
// - `cache-control: no-store, no-transform` (no proxy may buffer, cache or re-encode the stream),
//   `x-accel-buffering: no` (nginx; the prod config also turns buffering off for the chat path).
// - The API registers no compression plugin; a future one must skip `text/event-stream` (gzip
//   buffers until a block fills, which would hold back every delta).
// - The body is a `PassThrough` handed to `reply.send`, so Fastify keeps its normal response
//   lifecycle (hooks, request logging, no hijack) and each `write` goes out as one chunk.
//
// Never log what goes through here (the model's answer and the user's photos).

export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
});

export interface EventStream {
  /** Write one event. Returns false (and writes nothing) once the stream is closed. */
  send(event: string, data: unknown): boolean;
  /** End the response (idempotent). */
  close(): void;
  /** True after `close()` or a client disconnect. */
  readonly closed: boolean;
  /** Aborted when the client disconnects before `close()` (optional for callers to honour). */
  readonly signal: AbortSignal;
}

export interface EventStreamOptions {
  /** Default `CHAT_SSE_KEEPALIVE_MS` (15 s). */
  keepaliveMs?: number;
}

/** One SSE frame. `data` is JSON on a single line (JSON.stringify escapes newlines). */
export function sseFrame(event: string, data: unknown): string {
  if (!/^[a-z_]{1,32}$/.test(event)) throw new Error("invalid SSE event name");
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Start a 200 `text/event-stream` response on `reply` and return a writer. Call it only after
 * every check that can fail with a JSON error (auth, gate, rate limit, budget) has passed: once
 * the stream is open, failures must be sent as an `error` event followed by `close()`. The route
 * handler must `return reply` after calling this.
 */
export function openEventStream(reply: FastifyReply, opts: EventStreamOptions = {}): EventStream {
  const body = new PassThrough();
  const controller = new AbortController();
  let closed = false;

  const keepalive = setInterval(() => {
    if (!closed) body.write(CHAT_SSE_KEEPALIVE);
  }, opts.keepaliveMs ?? CHAT_SSE_KEEPALIVE_MS);
  keepalive.unref();

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
  };

  // `close` on the raw response fires on completion AND on a dropped connection; only the
  // latter aborts (nothing more is written; callers may stop work via `signal`).
  reply.raw.once("close", () => {
    const aborted = !reply.raw.writableFinished;
    finish();
    if (aborted) {
      controller.abort();
      body.destroy();
    }
  });

  reply.code(200).headers(SSE_HEADERS);
  void reply.send(body);

  return {
    send(event, data) {
      if (closed) return false;
      body.write(sseFrame(event, data));
      return true;
    },
    close() {
      if (closed) return;
      finish();
      body.end();
    },
    get closed() {
      return closed;
    },
    signal: controller.signal,
  };
}
