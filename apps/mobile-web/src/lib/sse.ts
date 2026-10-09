import { type ChatEvent, chatTurnResponseSchema, decodeChatEventFrame } from "@littlelight/shared";
import { ApiError, headers, parseError, refreshSession } from "./api";

const API_PREFIX = "/api";

/** Splits buffered SSE text into complete frames; returns the frames and the unfinished rest. */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts, rest };
}

async function open(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const init = async (): Promise<RequestInit> => {
    const h = await headers(true);
    h.set("Accept", "text/event-stream, application/json;q=0.5");
    return {
      method: "POST",
      credentials: "same-origin",
      headers: h,
      body: JSON.stringify(body),
      signal,
    };
  };
  try {
    return await fetch(`${API_PREFIX}${path}`, await init());
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ApiError(0, "network", "Can't reach Littlelight. Check your connection.");
  }
}

/**
 * POST `body` and deliver the response as validated `ChatEvent`s. Keepalive comments and invalid
 * frames are skipped. Failures before the stream starts (401/403/409/429...) reject with an
 * `ApiError`. When the WebView exposes no readable stream the whole response is read at once; a
 * JSON answer (server fallback) is turned into `photos`, `delta` and `done` events. Aborting
 * through `signal` rejects with an `AbortError`.
 */
export async function postEventStream(
  path: string,
  body: unknown,
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res = await open(path, body, signal);
  if (res.status === 401) {
    const err = await parseError(res.clone());
    if (err.code === "token_expired" && (await refreshSession())) {
      res = await open(path, body, signal);
    }
  }
  if (!res.ok) throw await parseError(res);

  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const turn = chatTurnResponseSchema.parse(await res.json());
    if (turn.message.photos.length > 0) onEvent({ type: "photos", photos: turn.message.photos });
    onEvent({ type: "delta", text: turn.message.text });
    onEvent({ type: "done", ...turn });
    return;
  }

  const emit = (frames: string[]) => {
    for (const frame of frames) {
      const event = decodeChatEventFrame(frame);
      if (event) onEvent(event);
    }
  };

  if (!res.body?.getReader) {
    emit(splitFrames(`${await res.text()}\n\n`).frames);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = splitFrames(buffer);
      buffer = rest;
      emit(frames);
    }
    buffer += decoder.decode();
    emit(splitFrames(`${buffer}\n\n`).frames);
  } finally {
    reader.releaseLock();
  }
}
