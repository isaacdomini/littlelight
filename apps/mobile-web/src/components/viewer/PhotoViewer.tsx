import { IonAlert, IonIcon, IonModal } from "@ionic/react";
import type { PhotoSummary } from "@littlelight/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  arrowUndoOutline,
  closeOutline,
  createOutline,
  downloadOutline,
  informationCircleOutline,
  shareOutline,
  trashOutline,
} from "ionicons/icons";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Swiper as SwiperType } from "swiper";
import { Keyboard, Virtual, Zoom } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import "swiper/css";
import "swiper/css/virtual";
import "swiper/css/zoom";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { t } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { FEATURES } from "../../lib/features";
import { cachePhotoImage } from "../../lib/imageCache";
import { useRetryAi, useUpdateAiOverrides } from "../../lib/queries/ai";
import { useMilestones } from "../../lib/queries/milestones";
import {
  fetchOriginalUrl,
  photoKey,
  useDeletePhoto,
  usePhoto,
  useRestorePhoto,
} from "../../lib/queries/photos";
import { useProfileTimeZone } from "../../lib/units";
import { MeasurementSheet } from "../measurements/MeasurementSheet";
import { PhotoImage } from "../PhotoImage";
import { Message } from "../ui";
import { AiEditForm } from "./AiEditForm";
import { DetailsForm } from "./DetailsForm";
import { DetailsPanel } from "./DetailsPanel";
import { useOptimisticDetails } from "./useOptimisticDetails";

export interface PhotoViewerProps {
  /** Photos to swipe through (the loaded timeline, newest first). */
  photos: PhotoSummary[];
  photoId: string;
  /** Absolute index of `photos[0]` in the whole album (0 unless a scrubber jump started mid-way). */
  positionOffset?: number;
  /** Photos in the whole album, for "n of N"; defaults to `photos.length`. */
  total?: number;
  layout: "modal" | "inline";
  onChange: (id: string) => void;
  onClose: () => void;
  /** Called when the last loaded slide is reached. */
  onEndReached?: () => void;
}

function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function ActionButton({
  icon,
  label,
  testId,
  onClick,
  disabled,
  danger,
}: {
  icon: string;
  label: string;
  testId: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "text-red-500" : ""}`}
    >
      <IonIcon icon={icon} aria-hidden className="h-6 w-6" />
    </button>
  );
}

function Slide({
  photo,
  near,
  active,
  milestoneName,
}: {
  photo: PhotoSummary;
  near: boolean;
  active: boolean;
  milestoneName: string | null;
}) {
  const { baby } = useCurrentBaby();
  const timeZone = useProfileTimeZone();
  const detail = usePhoto(near ? photo.id : undefined);
  const displayUrl = detail.data?.displayUrl ?? null;
  const source = detail.data ?? photo;
  return (
    <div className="swiper-zoom-container">
      <PhotoImage
        photo={source}
        kind={displayUrl ? "display" : "thumb"}
        displayUrl={displayUrl}
        baby={baby}
        milestoneName={milestoneName}
        timeZone={timeZone}
        eager
        cacheOnLoad={active && !!displayUrl}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

/**
 * Full-screen (modal) or inline (tablet/desktop pane) photo viewer: Swiper with pinch/double-tap
 * zoom and keyboard arrows over the loaded timeline, plus the details panel and edit form.
 */
export function PhotoViewer(props: PhotoViewerProps) {
  const { layout, onClose } = props;
  const body = <ViewerBody {...props} />;
  if (layout === "inline") return body;
  return (
    <IonModal
      isOpen
      onDidDismiss={onClose}
      data-testid="photo-viewer"
      aria-label={t("viewer.title")}
      key="viewer-modal"
    >
      {body}
    </IonModal>
  );
}

function ViewerBody({
  photos,
  photoId,
  positionOffset = 0,
  total,
  layout,
  onChange,
  onClose,
  onEndReached,
}: PhotoViewerProps) {
  const queryClient = useQueryClient();
  const { baby } = useCurrentBaby();
  const babyId = baby?.id ?? "none";
  const isAdmin = baby?.role === "admin";
  const paid = baby?.plan !== "free";
  const milestones = useMilestones(baby?.id);
  const milestoneList = milestones.data ?? [];
  const detail = usePhoto(photoId);
  const saveDetails = useOptimisticDetails(babyId);
  const remove = useDeletePhoto(babyId);
  const restore = useRestorePhoto(babyId);
  const updateAi = useUpdateAiOverrides(babyId);
  const retryAi = useRetryAi(babyId);

  const [detailsOpen, setDetailsOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [aiEditing, setAiEditing] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [measureOpen, setMeasureOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const swiperRef = useRef<SwiperType | null>(null);

  // Slides: the loaded list when it contains the photo (reload deep link otherwise shows just it).
  const listed = photos.some((p) => p.id === photoId);
  const slides: PhotoSummary[] = useMemo(() => {
    if (listed) return photos;
    return detail.data ? [detail.data] : [];
  }, [listed, photos, detail.data]);
  const index = Math.max(
    0,
    slides.findIndex((p) => p.id === photoId),
  );
  const milestoneName = (id: string | null) =>
    id ? (milestoneList.find((m) => m.id === id)?.name ?? null) : null;

  // Keep Swiper on the controlled photo (grid selection, prepended pages).
  useEffect(() => {
    const s = swiperRef.current;
    if (s && !s.destroyed && s.activeIndex !== index) s.slideTo(index, 0);
  }, [index]);

  // Reaching the end of the loaded items loads more.
  useEffect(() => {
    if (listed && index >= slides.length - 3) onEndReached?.();
  }, [listed, index, slides.length, onEndReached]);

  // Reset edit state only when the viewed photo changes, never when `slides` merely changes
  // identity (e.g. a cache patch of aiStatus/caption), which would close an open form mid-edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: photoId is the intentional trigger
  useEffect(() => {
    setEditing(false);
    setAiEditing(false);
    setSuggested(null);
    setError(null);
  }, [photoId]);

  // Neighbours: prefetch their detail and cache their thumbs for offline viewing.
  useEffect(() => {
    for (const n of [slides[index - 1], slides[index + 1]]) {
      if (!n) continue;
      void queryClient.prefetchQuery({ queryKey: photoKey(n.id), staleTime: 45 * 60_000 });
      if (n.thumbUrl) void cachePhotoImage(n.id, "thumb", n.thumbUrl);
    }
  }, [index, slides, queryClient]);

  // Escape closes the inline viewer (the modal handles its own).
  useEffect(() => {
    if (layout !== "inline") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, onClose]);

  const photo = detail.data;
  const isTrashed = !!photo?.deletedAt;
  const totalCount = total ?? slides.length;
  const position = positionOffset + index + 1;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const bar: ReactNode = (
    <div className="flex items-center gap-1 border-t border-gray-500/30 px-1 pb-[env(safe-area-inset-bottom)]">
      <ActionButton
        icon={informationCircleOutline}
        label={detailsOpen ? t("viewer.detailsHide") : t("viewer.detailsToggle")}
        testId="viewer-details-toggle"
        onClick={() => setDetailsOpen((o) => !o)}
      />
      {photo?.canEdit && !isTrashed ? (
        <ActionButton
          icon={createOutline}
          label={t("viewer.edit")}
          testId="viewer-edit"
          onClick={() => {
            setDetailsOpen(true);
            setSuggested(null);
            setEditing(true);
          }}
        />
      ) : null}
      <ActionButton
        icon={shareOutline}
        label={`${t("viewer.share")}. ${t("timeline.comingWithSharing")}`}
        testId="viewer-share"
        disabled={!FEATURES.sharing}
      />
      {isAdmin && photo ? (
        <ActionButton
          icon={downloadOutline}
          label={t("viewer.downloadOriginal")}
          testId="viewer-download-original"
          onClick={() => void run(async () => download(await fetchOriginalUrl(photo.id)))}
        />
      ) : null}
      {photo && isTrashed && isAdmin ? (
        <ActionButton
          icon={arrowUndoOutline}
          label={t("viewer.restore")}
          testId="viewer-restore"
          onClick={() =>
            void run(async () => {
              await restore.mutateAsync(photo.id);
              onClose();
            })
          }
        />
      ) : null}
      {photo?.canEdit && !isTrashed ? (
        <ActionButton
          icon={trashOutline}
          label={t("viewer.delete")}
          testId="viewer-delete"
          danger
          onClick={() => setConfirmDelete(true)}
        />
      ) : null}
    </div>
  );

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-[var(--ion-background-color)]"
      data-testid={layout === "inline" ? "photo-viewer" : "photo-viewer-body"}
      {...(layout === "inline" ? { role: "region", "aria-label": t("viewer.title") } : {})}
    >
      <div className="flex items-center justify-between px-1 pt-[env(safe-area-inset-top)]">
        <button
          type="button"
          data-testid="viewer-close"
          aria-label={t("viewer.close")}
          onClick={onClose}
          className="flex min-h-11 min-w-11 items-center justify-center"
        >
          <IonIcon icon={closeOutline} aria-hidden className="h-6 w-6" />
        </button>
        <p className="text-sm" data-testid="viewer-position" aria-live="polite">
          {t("viewer.position", { n: position, total: totalCount })}
        </p>
        <span className="w-11" />
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: carousel landmark, fieldset would add form semantics */}
      <div
        className="min-h-0 flex-1 bg-black"
        role="group"
        aria-roledescription="carousel"
        aria-label={t("viewer.carousel")}
      >
        {slides.length === 0 ? (
          <p className="p-4 text-white/80" role="status">
            {detail.isError ? t("viewer.loadError") : t("common.loading")}
          </p>
        ) : (
          <Swiper
            style={{ height: "100%" }}
            modules={[Virtual, Zoom, Keyboard]}
            virtual={{ addSlidesBefore: 1, addSlidesAfter: 1 }}
            zoom={{ maxRatio: 4 }}
            keyboard={{ enabled: true }}
            initialSlide={index}
            onSwiper={(s) => {
              swiperRef.current = s;
            }}
            onSlideChange={(s) => {
              const next = slides[s.activeIndex];
              if (next && next.id !== photoId) onChange(next.id);
            }}
          >
            {slides.map((p, i) => (
              <SwiperSlide
                key={p.id}
                virtualIndex={i}
                data-testid={`viewer-slide-${p.id}`}
                role="group"
                aria-roledescription="slide"
                aria-label={t("viewer.position", { n: positionOffset + i + 1, total: totalCount })}
              >
                <Slide
                  photo={p}
                  near={Math.abs(i - index) <= 1}
                  active={i === index}
                  milestoneName={milestoneName(p.milestoneId)}
                />
              </SwiperSlide>
            ))}
          </Swiper>
        )}
      </div>

      {detailsOpen ? (
        <div className="max-h-[45%] min-h-0 overflow-y-auto p-4">
          {error ? <Message>{error}</Message> : null}
          {!photo ? (
            <p role="status">{detail.isError ? t("viewer.loadError") : t("common.loading")}</p>
          ) : editing && photo.canEdit ? (
            <DetailsForm
              key={photo.id}
              photo={photo}
              babyId={babyId}
              isAdmin={isAdmin}
              initialMilestoneId={suggested}
              onCancel={() => {
                setEditing(false);
                setSuggested(null);
              }}
              onAddMeasurement={() => setMeasureOpen(true)}
              onSubmit={async (patch) => {
                await saveDetails(photo.id, patch);
                setEditing(false);
                setSuggested(null);
              }}
            />
          ) : aiEditing && FEATURES.aiEdits && photo.canEdit && photo.ai.status === "ready" ? (
            <AiEditForm
              key={photo.id}
              photo={photo}
              onCancel={() => setAiEditing(false)}
              onSubmit={async (patch) => {
                await updateAi.mutateAsync({ id: photo.id, ...patch });
                setAiEditing(false);
              }}
            />
          ) : (
            <>
              <DetailsPanel
                photo={photo}
                milestones={milestoneList}
                isAdmin={isAdmin}
                paid={paid}
                onEditAi={() => setAiEditing(true)}
                onRetry={() => retryAi.mutate(photo.id)}
                retrying={retryAi.isPending}
                retryError={retryAi.isError}
                onSuggestMilestone={(id) => {
                  setSuggested(id);
                  setEditing(true);
                }}
              />
              {!photo.canEdit ? (
                <p className="mt-3 text-sm opacity-70">{t("details.readOnly")}</p>
              ) : null}
            </>
          )}
        </div>
      ) : error ? (
        <div className="p-2">
          <Message>{error}</Message>
        </div>
      ) : null}

      {bar}

      <IonAlert
        isOpen={confirmDelete}
        header={t("timeline.deleteConfirmTitle")}
        message={t("timeline.deleteConfirmBody")}
        onDidDismiss={() => setConfirmDelete(false)}
        buttons={[
          { text: t("common.cancel"), role: "cancel" },
          {
            text: t("viewer.delete"),
            role: "destructive",
            handler: () => {
              if (photo) {
                void run(async () => {
                  await remove.mutateAsync(photo.id);
                  onClose();
                });
              }
            },
          },
        ]}
      />
      {isAdmin && photo ? (
        <MeasurementSheet
          babyId={babyId}
          photoId={photo.id}
          defaultMeasuredAt={photo.takenAt}
          open={measureOpen}
          onClose={() => {
            setMeasureOpen(false);
            void queryClient.invalidateQueries({ queryKey: photoKey(photo.id) });
          }}
        />
      ) : null}
    </div>
  );
}

/** Placeholder for the inline pane when no photo is selected. */
export function ViewerEmpty() {
  return (
    <div
      className="flex h-full items-center justify-center p-6 text-center opacity-70"
      data-testid="viewer-empty"
    >
      {t("viewer.empty")}
    </div>
  );
}
