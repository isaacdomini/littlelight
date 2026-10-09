import { IonIcon } from "@ionic/react";
import type { BabySummary, PhotoSummary } from "@littlelight/shared";
import { eyeOffOutline, flag } from "ionicons/icons";
import { memo } from "react";
import { t } from "../../i18n";
import { PhotoImage } from "../PhotoImage";
import { Button } from "../ui";

export interface ThumbProps {
  photo: PhotoSummary;
  baby: Pick<BabySummary, "name" | "nickname"> | null;
  milestoneName: string | null;
  timeZone: string;
  selectMode: boolean;
  selected: boolean;
  pendingActions: boolean;
  busy: boolean;
  onOpen: (photo: PhotoSummary) => void;
  onToggle: (photo: PhotoSummary) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

/** One grid cell: a fixed-aspect (square) button with badges, plus approve/reject when pending. */
export const Thumb = memo(function Thumb({
  photo: p,
  baby,
  milestoneName,
  timeZone,
  selectMode,
  selected,
  pendingActions,
  busy,
  onOpen,
  onToggle,
  onApprove,
  onReject,
}: ThumbProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        data-testid={`photo-${p.id}`}
        aria-pressed={selectMode ? selected : undefined}
        onClick={() => (selectMode ? onToggle(p) : onOpen(p))}
        className="relative aspect-square min-h-11 w-full min-w-11 overflow-hidden bg-gray-500/10 [contain:layout_paint_style]"
      >
        <PhotoImage
          photo={p}
          baby={baby}
          milestoneName={milestoneName}
          timeZone={timeZone}
          className="h-full w-full rounded-md object-cover"
        />
        {p.approval === "pending" ? (
          <span
            data-testid={`photo-pending-${p.id}`}
            className="absolute left-1 top-1 rounded bg-amber-500 px-1.5 py-0.5 text-xs font-semibold text-black"
          >
            {t("timeline.pendingBadge")}
          </span>
        ) : null}
        {p.milestoneId && milestoneName ? (
          <span
            data-testid={`photo-milestone-badge-${p.id}`}
            role="img"
            aria-label={t("timeline.milestoneBadge", { name: milestoneName })}
            title={milestoneName}
            className="absolute bottom-1 left-1 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ion-color-primary)] text-[var(--ion-color-primary-contrast)]"
          >
            <IonIcon icon={flag} aria-hidden className="h-4 w-4" />
          </span>
        ) : null}
        {p.aiStatus === "queued" || p.aiStatus === "analyzing" ? (
          <span
            data-testid={`photo-analyzing-${p.id}`}
            role="img"
            aria-label={t("ai.analyzingBadge")}
            title={t("ai.analyzingBadge")}
            className="absolute right-1 top-1 h-2.5 w-2.5 animate-pulse rounded-full bg-sky-400 ring-2 ring-black/40"
          />
        ) : null}
        {p.isSensitive ? (
          <span
            data-testid={`photo-sensitive-${p.id}`}
            role="img"
            aria-label={t("timeline.sensitiveBadge")}
            className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
          >
            <IonIcon icon={eyeOffOutline} aria-hidden className="h-4 w-4" />
          </span>
        ) : null}
        {selectMode ? (
          <span
            data-testid={`select-${p.id}`}
            aria-hidden
            className={`absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-sm font-bold ${
              selected
                ? "bg-[var(--ion-color-primary)] text-[var(--ion-color-primary-contrast)]"
                : "bg-black/40 text-transparent"
            }`}
          >
            ✓
          </span>
        ) : null}
        {selectMode && selected ? (
          <span className="absolute inset-0 ring-4 ring-inset ring-[var(--ion-color-primary)]" />
        ) : null}
      </button>
      {pendingActions ? (
        <div className="flex gap-1">
          <Button
            className="flex-1 !px-2"
            data-testid={`approve-${p.id}`}
            aria-label={t("timeline.approveLabel")}
            disabled={busy}
            onClick={() => onApprove(p.id)}
          >
            {t("timeline.approve")}
          </Button>
          <Button
            variant="secondary"
            className="flex-1 !px-2"
            data-testid={`reject-${p.id}`}
            aria-label={t("timeline.rejectLabel")}
            disabled={busy}
            onClick={() => onReject(p.id)}
          >
            {t("timeline.reject")}
          </Button>
        </div>
      ) : null}
    </div>
  );
});
