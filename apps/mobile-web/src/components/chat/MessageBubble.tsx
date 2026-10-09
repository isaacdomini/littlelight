import type { PhotoSummary } from "@littlelight/shared";
import { type ChatMessageDto, parseCitations } from "@littlelight/shared";
import { useMemo } from "react";
import { t } from "../../i18n";
import { ChatPhotoGrid } from "./ChatPhotoGrid";
import { chatPhotoToSummary } from "./chatPhotos";

type Baby = { name: string; nickname: string | null } | null;

/** Plain-text paragraphs (never HTML or markdown-to-HTML). */
function Text({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words">{text}</p>;
}

/**
 * Citation markers the server did not strip become tappable chips for photos in the grid;
 * they never appear in the text.
 */
function Chips({
  ids,
  photos,
  onOpen,
}: {
  ids: string[];
  photos: PhotoSummary[];
  onOpen: (p: PhotoSummary) => void;
}) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const chips = ids.flatMap((id, i) => {
    const photo = byId.get(id);
    return photo ? [{ photo, n: i + 1 }] : [];
  });
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1">
      {chips.map(({ photo, n }) => (
        <li key={photo.id}>
          <button
            type="button"
            data-testid={`chat-citation-${photo.id}`}
            onClick={() => onOpen(photo)}
            className="min-h-11 min-w-11 rounded-full border border-gray-500/50 px-3 text-sm"
          >
            {t("chat.citation", { n })}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One stored message (user or assistant) with its photo grid. */
export function MessageBubble({
  message,
  baby,
  timeZone,
  onOpenPhoto,
}: {
  message: ChatMessageDto;
  baby: Baby;
  timeZone: string;
  onOpenPhoto: (photo: PhotoSummary, set: PhotoSummary[]) => void;
}) {
  const mine = message.role === "user";
  const parsed = useMemo(() => parseCitations(message.text), [message.text]);
  const photos = useMemo(() => message.photos.map(chatPhotoToSummary), [message.photos]);
  const open = (p: PhotoSummary) => onOpenPhoto(p, photos);
  return (
    <li
      data-testid={mine ? "chat-user-message" : "chat-assistant-message"}
      className={`flex flex-col gap-2 ${mine ? "items-end" : "items-start"}`}
    >
      <span className="sr-only">{mine ? t("chat.you") : t("chat.assistant")}</span>
      <div
        className={`flex max-w-[92%] flex-col gap-2 rounded-2xl px-3 py-2 ${
          mine
            ? "bg-[var(--ion-color-primary)] text-[var(--ion-color-primary-contrast)]"
            : "border border-gray-500/30"
        } ${message.status === "error" ? "border-red-500/60" : ""}`}
      >
        <Text text={parsed.text} />
        {!mine ? (
          <>
            <Chips
              ids={parsed.citations.filter((c) => c.kind === "photo").map((c) => c.id)}
              photos={photos}
              onOpen={open}
            />
            <ChatPhotoGrid photos={photos} baby={baby} timeZone={timeZone} onOpen={open} />
            {message.status === "complete" && !message.grounded ? (
              <p className="text-xs opacity-70" data-testid="chat-ungrounded">
                {t("chat.ungrounded")}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}
