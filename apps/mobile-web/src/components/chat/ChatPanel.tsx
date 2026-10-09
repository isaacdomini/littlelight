import { IonAlert, IonSpinner } from "@ionic/react";
import { CHAT_LIMITS, type PhotoSummary } from "@littlelight/shared";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { type MessageKey, t, tn } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { FEATURES } from "../../lib/features";
import { useChatThread, useClearChat, useSendChat } from "../../lib/queries/chat";
import { useProfileTimeZone } from "../../lib/units";
import { Button, Message } from "../ui";
import { PhotoViewer } from "../viewer/PhotoViewer";
import { useViewerParam } from "../viewer/useViewerParam";
import { ChatPhotoGrid } from "./ChatPhotoGrid";
import { chatPhotoToSummary } from "./chatPhotos";
import { MessageBubble } from "./MessageBubble";

const SUGGESTIONS = [
  "chat.suggestion0",
  "chat.suggestion1",
  "chat.suggestion2",
  "chat.suggestion3",
] as const satisfies readonly MessageKey[];

/** Errors where trying again straight away cannot help. */
const NO_RETRY = new Set(["rate_limited", "ai_budget_exceeded", "plan_required", "forbidden"]);
const TURNS_LEFT_NOTICE = 10;

/**
 * Chat for admins of a paid baby (FR-7.7; the server enforces it too): suggested prompts, a
 * streaming answer with an inline photo grid, history and clear. Contributors get a notice and
 * free babies an upsell. `page` is the home tab (opens its own viewer); `pane` is the desktop
 * left pane next to the timeline (photos open in the timeline's viewer).
 */
export function ChatPanel({ variant }: { variant: "page" | "pane" }) {
  const { baby } = useCurrentBaby();
  const timeZone = useProfileTimeZone();
  const viewer = useViewerParam(variant === "page" ? "/chat" : "/timeline");
  const babyId = baby?.id;
  const isAdmin = baby?.role === "admin";
  const paid = baby?.plan !== undefined && baby.plan !== "free";
  const canChat = FEATURES.chat && isAdmin && paid;

  const thread = useChatThread(babyId, canChat);
  const chat = useSendChat(babyId);
  const clear = useClearChat(babyId ?? "none");
  const [text, setText] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const messages = thread.data?.messages ?? [];
  const turn = chat.turn && !chat.turn.done ? chat.turn : null;
  const turnPhotos = useMemo(() => (turn ? turn.photos.map(chatPhotoToSummary) : []), [turn]);

  // The swipe set of the viewer: the photos of the answer that contains the open photo.
  const viewerSet = useMemo(() => {
    const id = viewer.photoId;
    if (!id) return [];
    if (turnPhotos.some((p) => p.id === id)) return turnPhotos;
    for (const m of [...messages].reverse()) {
      if (m.photos.some((p) => p.id === id)) return m.photos.map(chatPhotoToSummary);
    }
    return [];
  }, [viewer.photoId, turnPhotos, messages]);

  const turnText = turn?.text;
  const messageCount = messages.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when content grows
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount, turnText, turn?.error, turnPhotos.length]);

  const { photoId, change, open } = viewer;
  const openPhoto = (p: PhotoSummary) => (photoId ? change(p.id) : open(p.id));
  const babyName = baby?.nickname ?? baby?.name ?? "";
  const babyForAlt = baby ? { name: baby.name, nickname: baby.nickname } : null;

  const shell = (children: React.ReactNode, testId: string) => (
    <section
      className="flex h-full min-h-0 flex-col gap-2 p-4"
      aria-label={t("chat.title")}
      data-testid={testId}
    >
      {variant === "pane" ? <h2 className="text-lg font-semibold">{t("chat.title")}</h2> : null}
      {children}
    </section>
  );

  if (!baby) return shell(<p className="opacity-70">{t("chat.noBaby")}</p>, "chat-empty-baby");
  if (!isAdmin) {
    return shell(
      <div className="flex flex-col gap-1" data-testid="chat-contributor-notice">
        <p className="font-semibold">{t("chat.contributorNotice")}</p>
        <p className="text-sm opacity-80">{t("chat.contributorBody")}</p>
      </div>,
      "chat-gated",
    );
  }
  if (!paid) {
    return shell(
      <div className="flex flex-col gap-2" data-testid="chat-upsell">
        <p className="font-semibold">{t("chat.upsellTitle")}</p>
        <p className="text-sm opacity-80">{t("chat.upsellBody")}</p>
        <Link
          to="/settings"
          className="inline-flex min-h-11 w-fit items-center rounded-lg bg-[var(--ion-color-primary)] px-4 font-semibold text-[var(--ion-color-primary-contrast)]"
          data-testid="chat-upsell-link"
        >
          {t("chat.upsellCta")}
        </Link>
      </div>,
      "chat-gated",
    );
  }

  const busy = chat.streaming;
  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !busy && thread.isSuccess;
  const turnsLeft = thread.data?.turnsLeftToday;
  const showSuggestions = thread.isSuccess && messages.length === 0 && !chat.turn;

  function submit(value: string) {
    const v = value.trim();
    if (!v || busy) return;
    setText("");
    void chat.send(v);
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSend) submit(text);
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) submit(text);
    }
  }

  async function doClear() {
    setClearError(null);
    try {
      await clear.mutateAsync();
      chat.reset();
    } catch (e) {
      setClearError(errorMessage(e));
    }
  }

  return shell(
    <>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="chat-scroll">
        {thread.isPending ? (
          <div className="flex justify-center p-6" role="status">
            <IonSpinner aria-label={t("common.loading")} />
          </div>
        ) : null}
        {thread.isError ? (
          <div className="flex flex-col items-start gap-2">
            <Message>{t("chat.loadError")}</Message>
            <Button variant="secondary" onClick={() => void thread.refetch()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : null}

        {showSuggestions ? (
          <div className="flex flex-col gap-3" data-testid="chat-intro">
            <p className="opacity-80">{t("chat.intro", { name: babyName })}</p>
            <p className="text-sm font-medium">{t("chat.suggestions")}</p>
            <ul className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((key, n) => (
                <li key={key}>
                  <button
                    type="button"
                    data-testid={`chat-suggestion-${n}`}
                    onClick={() => submit(t(key))}
                    className="min-h-11 rounded-full border border-gray-500/50 px-4 text-left text-base"
                  >
                    {t(key)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <ol
          className="flex flex-col gap-3"
          data-testid="chat-messages"
          aria-label={t("chat.messages")}
        >
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              baby={babyForAlt}
              timeZone={timeZone}
              onOpenPhoto={openPhoto}
            />
          ))}
          {chat.turn && !chat.turn.done ? (
            <>
              <li className="flex flex-col items-end" data-testid="chat-user-message">
                <div className="max-w-[92%] rounded-2xl bg-[var(--ion-color-primary)] px-3 py-2 text-[var(--ion-color-primary-contrast)]">
                  <p className="whitespace-pre-wrap break-words">{chat.turn.userText}</p>
                </div>
              </li>
              {chat.turn.error ? (
                <li className="flex flex-col items-start gap-2" data-testid="chat-error">
                  <Message>{chat.turn.error.text}</Message>
                  {!NO_RETRY.has(chat.turn.error.code ?? "") ? (
                    <Button
                      variant="secondary"
                      data-testid="chat-retry"
                      onClick={() => chat.turn && void chat.send(chat.turn.userText)}
                    >
                      {t("chat.retry")}
                    </Button>
                  ) : null}
                </li>
              ) : (
                <li className="flex flex-col items-start gap-2">
                  <div
                    className="flex max-w-[92%] flex-col gap-2 rounded-2xl border border-gray-500/30 px-3 py-2"
                    data-testid="chat-streaming"
                    aria-live="polite"
                    aria-busy={true}
                  >
                    {chat.turn.text ? (
                      <p className="whitespace-pre-wrap break-words">{chat.turn.text}</p>
                    ) : null}
                    <p className="text-sm opacity-70" data-testid="chat-status">
                      {chat.turn.status === "searching" ? t("chat.searching") : t("chat.thinking")}
                    </p>
                    <ChatPhotoGrid
                      photos={turnPhotos}
                      baby={babyForAlt}
                      timeZone={timeZone}
                      onOpen={openPhoto}
                    />
                  </div>
                </li>
              )}
            </>
          ) : null}
        </ol>
      </div>

      {clearError ? <Message>{clearError}</Message> : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-1">
        <div className="flex items-end gap-2">
          <textarea
            data-testid="chat-input"
            aria-label={t("chat.inputLabel")}
            placeholder={t("chat.inputPlaceholder")}
            value={text}
            rows={2}
            maxLength={CHAT_LIMITS.text}
            enterKeyHint="send"
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-11 w-full resize-none rounded-lg border border-gray-500/50 bg-transparent px-3 py-2 text-base text-[var(--ion-text-color)] outline-none focus:border-[var(--ion-color-primary)] focus:ring-2 focus:ring-[var(--ion-color-primary)]"
          />
          {busy ? (
            <Button variant="secondary" data-testid="chat-stop" onClick={chat.abort}>
              {t("chat.stop")}
            </Button>
          ) : (
            <Button type="submit" data-testid="chat-send" disabled={!canSend}>
              {t("chat.send")}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs opacity-70">
          {text.length > CHAT_LIMITS.text * 0.8 ? (
            <span aria-live="polite">
              {t("chat.counter", { n: text.length, max: CHAT_LIMITS.text })}
            </span>
          ) : null}
          {turnsLeft !== undefined && turnsLeft <= TURNS_LEFT_NOTICE ? (
            <span data-testid="chat-turns-left">{tn("chat.turnsLeft", turnsLeft)}</span>
          ) : null}
          {messages.length > 0 && !busy ? (
            <Button
              variant="link"
              className="!min-h-11 !px-2 !text-xs"
              data-testid="chat-clear"
              onClick={() => setConfirmClear(true)}
            >
              {t("chat.clear")}
            </Button>
          ) : null}
        </div>
        <p className="text-xs opacity-70" data-testid="chat-disclaimer">
          {t("chat.disclaimer")}
        </p>
      </form>

      <IonAlert
        isOpen={confirmClear}
        header={t("chat.clearConfirm")}
        message={t("chat.clearBody", { name: babyName })}
        onDidDismiss={() => setConfirmClear(false)}
        buttons={[
          { text: t("common.cancel"), role: "cancel" },
          { text: t("chat.clear"), role: "destructive", handler: () => void doClear() },
        ]}
      />

      {variant === "page" && viewer.photoId && viewerSet.length > 0 ? (
        <PhotoViewer
          photos={viewerSet}
          photoId={viewer.photoId}
          layout="modal"
          onChange={viewer.change}
          onClose={viewer.close}
        />
      ) : null}
    </>,
    "chat-panel",
  );
}
