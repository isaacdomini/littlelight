import type { PhotoSummary } from "@littlelight/shared";
import { useCallback } from "react";
import { t } from "../../i18n";
import { Thumb } from "../timeline/Thumb";

const noop = () => {};

/** Small photo grid under an answer (<= 50 thumbs; not virtualized on purpose). */
export function ChatPhotoGrid({
  photos,
  baby,
  timeZone,
  onOpen,
}: {
  photos: PhotoSummary[];
  baby: { name: string; nickname: string | null } | null;
  timeZone: string;
  onOpen: (photo: PhotoSummary) => void;
}) {
  const open = useCallback((p: PhotoSummary) => onOpen(p), [onOpen]);
  if (photos.length === 0) return null;
  return (
    <ul
      className="grid grid-cols-3 gap-0.5 sm:grid-cols-4"
      data-testid="chat-photo-grid"
      aria-label={t("chat.photosLabel")}
    >
      {photos.map((p) => (
        <li key={p.id} className="min-w-0">
          <Thumb
            photo={p}
            baby={baby}
            milestoneName={null}
            timeZone={timeZone}
            selectMode={false}
            selected={false}
            pendingActions={false}
            busy={false}
            onOpen={open}
            onToggle={noop}
            onApprove={noop}
            onReject={noop}
          />
        </li>
      ))}
    </ul>
  );
}
