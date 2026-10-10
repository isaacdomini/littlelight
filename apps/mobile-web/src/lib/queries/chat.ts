import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CHAT_MESSAGES,
  type ChatEvent,
  type ChatMessageDto,
  type ChatPhoto,
  type ChatThreadResponse,
  chatThreadResponseSchema,
} from "@tinyglow/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, isApiError } from "../api";
import { postEventStream } from "../sse";

export const chatThreadKey = (babyId: string) => ["babies", babyId, "chat", "thread"] as const;

/** `GET /babies/:id/chat/thread` (admins of paid babies; `enabled` carries that gate). */
export function useChatThread(babyId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: chatThreadKey(babyId ?? "none"),
    enabled: !!babyId && enabled,
    staleTime: 30_000,
    queryFn: () => apiFetch(`/babies/${babyId}/chat/thread`, { schema: chatThreadResponseSchema }),
  });
}

/** `DELETE /babies/:id/chat/thread`: clears this user's history for the baby. */
export function useClearChat(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(`/babies/${babyId}/chat/thread`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<ChatThreadResponse>(chatThreadKey(babyId), (old) => ({
        threadId: null,
        messages: [],
        turnsLeftToday: old?.turnsLeftToday ?? 0,
      }));
      void queryClient.invalidateQueries({ queryKey: chatThreadKey(babyId) });
    },
  });
}

/** Friendly copy for a failed send (server messages are user-safe; fall back to fixed copy). */
export function chatErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "rate_limited":
        return CHAT_MESSAGES.rateLimited;
      case "ai_budget_exceeded":
        return CHAT_MESSAGES.budgetExceeded;
      case "plan_required":
        return CHAT_MESSAGES.planRequired;
      case "forbidden":
        return CHAT_MESSAGES.parentsOnly;
      case "conflict":
        return e.message || CHAT_MESSAGES.busy;
      case "network":
        return e.message;
      default:
        return CHAT_MESSAGES.failed;
    }
  }
  return CHAT_MESSAGES.failed;
}

export interface ChatTurnState {
  /** The text the user just sent (shown until the stored messages arrive). */
  userText: string;
  text: string;
  photos: ChatPhoto[];
  status: "thinking" | "searching";
  /** Set when the turn failed; `retryable` when nothing was stored server-side. */
  error: { text: string; code: ApiError["code"] | null } | null;
  done: boolean;
}

/**
 * Sends one chat turn and streams the answer into local state; on `done` both messages are
 * appended to the cached thread (and the thread is refetched to settle). The text never goes
 * into a URL, a log or a query key.
 */
export function useSendChat(babyId: string | undefined) {
  const queryClient = useQueryClient();
  const [turn, setTurn] = useState<ChatTurnState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const abort = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string): Promise<void> => {
      if (!babyId || abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      let userMessageId: string | null = null;
      let threadId: string | null = null;
      let failed: ChatTurnState["error"] = null;
      setTurn({
        userText: text,
        text: "",
        photos: [],
        status: "thinking",
        error: null,
        done: false,
      });

      const onEvent = (ev: ChatEvent) => {
        switch (ev.type) {
          case "thread":
            userMessageId = ev.userMessageId;
            threadId = ev.threadId;
            break;
          case "status":
            setTurn((s) => (s ? { ...s, status: ev.stage } : s));
            break;
          case "photos":
            setTurn((s) => (s ? { ...s, photos: ev.photos } : s));
            break;
          case "delta":
            setTurn((s) => (s ? { ...s, text: s.text + ev.text } : s));
            break;
          case "error":
            failed = { text: CHAT_MESSAGES.failed, code: ev.error };
            setTurn((s) => (s ? { ...s, error: failed } : s));
            break;
          case "done": {
            const user: ChatMessageDto = {
              id: userMessageId ?? crypto.randomUUID(),
              role: "user",
              text,
              photos: [],
              citations: { photoIds: [], measurementIds: [] },
              grounded: true,
              status: "complete",
              createdAt: new Date().toISOString(),
            };
            queryClient.setQueryData<ChatThreadResponse>(chatThreadKey(babyId), (old) => ({
              threadId: old?.threadId ?? threadId,
              messages: [...(old?.messages ?? []), user, ev.message],
              turnsLeftToday: Math.max(0, (old?.turnsLeftToday ?? 1) - 1),
            }));
            setTurn((s) => (s ? { ...s, done: true } : s));
            break;
          }
        }
      };

      try {
        await postEventStream(
          `/babies/${babyId}/chat/messages`,
          { text },
          onEvent,
          controller.signal,
        );
        // Stream closed without `done` (dropped connection): settle from the server.
        setTurn((s) =>
          s && !s.done && !s.error
            ? { ...s, error: { text: CHAT_MESSAGES.failed, code: "network" } }
            : s,
        );
      } catch (e) {
        if (controller.signal.aborted) {
          setTurn(null);
        } else {
          const code = isApiError(e) ? e.code : null;
          setTurn((s) => (s ? { ...s, error: { text: chatErrorText(e), code } } : s));
        }
      } finally {
        abortRef.current = null;
        void queryClient.invalidateQueries({ queryKey: chatThreadKey(babyId) });
      }
    },
    [babyId, queryClient],
  );

  /** Drops the finished turn from local state (the stored messages take over). */
  const reset = useCallback(() => setTurn(null), []);

  return { turn, send, abort, reset, streaming: !!turn && !turn.done && !turn.error };
}
