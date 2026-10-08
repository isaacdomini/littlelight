import type { PhotoSummary } from "@littlelight/shared";
import { useState } from "react";
import { t } from "../i18n";
import { Button } from "./ui";

/** Square thumbnail; a neutral placeholder when there is no thumb yet or the URL 404s/expired. */
function Thumb({ photo }: { photo: PhotoSummary }) {
  const [broken, setBroken] = useState(false);
  const url = photo.thumbUrl;
  if (!url || broken) {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-gray-500/20 text-xs opacity-70"
        data-testid={`photo-placeholder-${photo.id}`}
      >
        {url === null && photo.status === "uploaded" ? t("timeline.processing") : null}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-full w-full object-cover"
      onError={() => setBroken(true)}
    />
  );
}

/**
 * CSS grid of square thumbs (minimal; step 5 replaces it with the virtualized, age-grouped
 * timeline). In the pending view admins get Approve / Reject per item.
 */
export function PhotoGrid({
  photos,
  pendingActions,
  busyId,
  onOpen,
  onApprove,
  onReject,
}: {
  photos: PhotoSummary[];
  pendingActions: boolean;
  busyId: string | null;
  onOpen: (photo: PhotoSummary) => void;
  onApprove: (photoId: string) => void;
  onReject: (photoId: string) => void;
}) {
  return (
    <ul
      data-testid="timeline-grid"
      className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8"
    >
      {photos.map((p) => (
        <li key={p.id} className="flex flex-col gap-1">
          <button
            type="button"
            data-testid={`photo-${p.id}`}
            aria-label={t("timeline.openPhoto")}
            onClick={() => onOpen(p)}
            className="relative aspect-square w-full overflow-hidden rounded-md"
          >
            <Thumb photo={p} />
            {p.approval === "pending" ? (
              <span
                data-testid={`photo-pending-${p.id}`}
                className="absolute left-1 top-1 rounded bg-amber-500 px-1.5 py-0.5 text-xs font-semibold text-black"
              >
                {t("timeline.pendingBadge")}
              </span>
            ) : null}
          </button>
          {pendingActions ? (
            <div className="flex gap-1">
              <Button
                className="flex-1 !px-2"
                data-testid={`approve-${p.id}`}
                aria-label={t("timeline.approveLabel")}
                disabled={busyId === p.id}
                onClick={() => onApprove(p.id)}
              >
                {t("timeline.approve")}
              </Button>
              <Button
                variant="secondary"
                className="flex-1 !px-2"
                data-testid={`reject-${p.id}`}
                aria-label={t("timeline.rejectLabel")}
                disabled={busyId === p.id}
                onClick={() => onReject(p.id)}
              >
                {t("timeline.reject")}
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
