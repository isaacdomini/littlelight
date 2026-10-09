import { PassThrough } from "node:stream";
import {
  CHAT_SSE_KEEPALIVE,
  CHAT_SSE_KEEPALIVE_MS,
  type ChatEvent,
  encodeChatEvent,
} from "@littlelight/shared";
import type { FastifyReply } from "fastify";

// Server-sent events of the chat turn (docs/plans/step-7.md 2.4, 2.8, R6). Wire format from
// `encodeChatEvent` (`event: <type>\ndata: <json>\n\n`) plus a `: keepalive\n\n` comment every
// 15 s (cloudflared idles out at 100 s). The body is a `PassThrough` handed to `reply.send`, so
// Fastify keeps its normal lifecycle (hooks, request logging). Headers: `no-store, no-transform`
// and `x-accel-buffering: no` so no proxy buffers or re-encodes the stream; never register a
// compression plugin that touches `text/event-stream`. Never log what goes through here.

export interface ChatEventStream {
  /** Writes one event; false once the stream is closed or the client went away. */
  send(event: ChatEvent): boolean;
  /** Ends the response (idempotent). */
  close(): void;
  readonly closed: boolean;
}

/**
 * Starts a 200 `text/event-stream` response. Call only after every check that can fail with a
 * JSON error has passed; afterwards failures are an `error` event. The handler must
 * `return reply` after calling this.
 */
export function openChatEventStream(reply: FastifyReply): ChatEventStream {
  const body = new PassThrough();
  let closed = false;
  const keepalive = setInterval(() => {
    if (!closed) body.write(CHAT_SSE_KEEPALIVE);
  }, CHAT_SSE_KEEPALIVE_MS);
  keepalive.unref();
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
  };
  reply.raw.once("close", () => {
    const dropped = !reply.raw.writableFinished;
    finish();
    if (dropped) body.destroy();
  });
  reply.code(200).headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no",
  });
  void reply.send(body);
  // Flush headers right away so the client and every proxy see the stream open.
  body.write(": stream open\n\n");
  return {
    send(event) {
      if (closed) return false;
      body.write(encodeChatEvent(event));
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
  };
}
