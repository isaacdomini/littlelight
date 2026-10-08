import { IonAlert, IonContent, IonPage, IonSpinner } from "@ionic/react";
import type { PhotoGroup, PhotoSummary, PhotosView } from "@littlelight/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../auth/AuthProvider";
import { useRouteActive } from "../auth/guards";
import { AppHeader } from "../components/AppHeader";
import { ChatPanePlaceholder } from "../components/ChatPanePlaceholder";
import { Panes, useBreakpoint, useOnline } from "../components/layout/Panes";
import { BatchDetailsSheet } from "../components/timeline/BatchDetailsSheet";
import { Scrubber } from "../components/timeline/Scrubber";
import { TimelineGrid } from "../components/timeline/TimelineGrid";
import { Button, Message } from "../components/ui";
import { PhotoViewer, ViewerEmpty } from "../components/viewer/PhotoViewer";
import { useViewerParam } from "../components/viewer/useViewerParam";
import { t, tn } from "../i18n";
import { apiFetch, errorMessage } from "../lib/api";
import { FEATURES } from "../lib/features";
import { useMilestones } from "../lib/queries/milestones";
import {
  flattenTimeline,
  photosRoot,
  useApprovePhoto,
  useBatchDetails,
  usePhotosInvalidation,
  useRejectPhoto,
  useTimeline,
  useTimelineSummary,
} from "../lib/queries/photos";
import { useProfileTimeZone } from "../lib/units";
import { uploadManager } from "../lib/upload/manager";

/** Age-grouped, virtualized timeline with scrubber, select mode, viewer and responsive panes. */
export function TimelinePage() {
  const { baby } = useCurrentBaby();
  const babyId = baby?.id;
  const isAdmin = baby?.role === "admin";
  const canUpload = baby?.role === "admin" || baby?.role === "contributor";
  const timeZone = useProfileTimeZone();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const active = useRouteActive("/timeline");
  const breakpoint = useBreakpoint();
  const online = useOnline();
  usePhotosInvalidation();

  const viewer = useViewerParam("/timeline");
  const milestoneId = viewer.params.get("milestone") ?? undefined;

  const [view, setView] = useState<PhotosView>("album");
  const [jump, setJump] = useState<{ cursor?: string; nonce: number }>({ nonce: 0 });
  const effectiveView: PhotosView = isAdmin ? view : "album";
  const timeline = useTimeline(babyId, {
    view: effectiveView,
    milestoneId,
    startCursor: jump.cursor,
  });
  const summary = useTimelineSummary(babyId, effectiveView);
  const milestones = useMilestones(babyId);

  const photos = useMemo(() => flattenTimeline(timeline.data), [timeline.data]);
  const milestoneNames = useMemo(
    () => new Map((milestones.data ?? []).map((m) => [m.id, m.name])),
    [milestones.data],
  );
  const filterName = milestoneId ? (milestoneNames.get(milestoneId) ?? null) : null;
  const filtered = !!milestoneId;
  const pendingCount = timeline.data?.pages[0]?.pendingCount ?? 0;

  const groupCounts = useMemo(
    () =>
      !filtered && summary.data
        ? new Map(summary.data.groups.map((g) => [g.key, g.count]))
        : undefined,
    [filtered, summary.data],
  );
  const total = !filtered && summary.data ? summary.data.total : photos.length;

  // Absolute index of the first loaded photo (needed for "n of N" after a scrubber jump).
  const positionOffset = useMemo(() => {
    if (!jump.cursor || filtered || !summary.data) return 0;
    const at = summary.data.groups.findIndex((g) => g.cursor === jump.cursor);
    if (at < 0) return 0;
    const before = summary.data.groups.slice(0, at).reduce((n, g) => n + g.count, 0);
    const prepended = (timeline.data?.pages ?? []).reduce(
      (n, p, i) => (timeline.data?.pageParams[i]?.dir === "newer" ? n + p.photos.length : n),
      0,
    );
    return Math.max(0, before - prepended);
  }, [jump.cursor, filtered, summary.data, timeline.data]);

  const [visibleGroup, setVisibleGroup] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const approve = useApprovePhoto(babyId ?? "none");
  const reject = useRejectPhoto(babyId ?? "none");
  const batch = useBatchDetails(babyId ?? "none");
  const busyId =
    (approve.isPending ? approve.variables : null) ?? (reject.isPending ? reject.variables : null);

  const resetStream = () => setJump((j) => ({ nonce: j.nonce + 1 }));
  const changeView = (v: PhotosView) => {
    setView(v);
    setSelected(new Set());
    setVisibleGroup(null);
    resetStream();
  };
  const clearFilter = () => {
    const next = new URLSearchParams(location.search);
    next.delete("milestone");
    next.delete("photo");
    const qs = next.toString();
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : "" }, { replace: true });
    resetStream();
  };

  const onJump = useCallback((group: PhotoGroup, index: number) => {
    setVisibleGroup(group.key);
    setJump((j) => ({ cursor: index === 0 ? undefined : group.cursor, nonce: j.nonce + 1 }));
  }, []);

  const { photoId: openPhotoId, change: changePhoto, open: openPhoto } = viewer;
  const onOpen = useCallback(
    (p: PhotoSummary) => (openPhotoId ? changePhoto(p.id) : openPhoto(p.id)),
    [openPhotoId, changePhoto, openPhoto],
  );
  const onToggle = useCallback((p: PhotoSummary) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
  }, []);
  const approveAsync = approve.mutateAsync;
  const rejectAsync = reject.mutateAsync;
  const onApprove = useCallback(
    (id: string) => void approveAsync(id).catch((e) => setActionError(errorMessage(e))),
    [approveAsync],
  );
  const onReject = useCallback(
    (id: string) => void rejectAsync(id).catch((e) => setActionError(errorMessage(e))),
    [rejectAsync],
  );

  const fetchNext = useCallback(() => void timeline.fetchNextPage(), [timeline]);
  const fetchPrevious = useCallback(() => void timeline.fetchPreviousPage(), [timeline]);

  function leaveSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  async function batchDelete() {
    const ids = [...selected];
    const results = await Promise.allSettled(
      ids.map((id) => apiFetch(`/photos/${id}`, { method: "DELETE" })),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (babyId) {
      await queryClient.invalidateQueries({ queryKey: photosRoot(babyId) });
    }
    if (failed > 0) setActionError(tn("timeline.batchSkipped", failed));
    leaveSelectMode();
  }

  const empty = !!baby && !timeline.isPending && photos.length === 0 && !timeline.isError;

  const onDrop = (e: React.DragEvent) => {
    setDragging(false);
    if (!canUpload || !babyId) return;
    const files = [...e.dataTransfer.files];
    if (files.length === 0) return;
    e.preventDefault();
    uploadManager.add(babyId, files);
    navigate("/upload");
  };

  const grid = (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only drag-and-drop upload zone; touch users use the Upload tab
    <section
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (canUpload && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-col gap-2 px-3 pb-1 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm opacity-80" data-testid="timeline-total" aria-live="polite">
            {baby ? tn("timeline.photoCount", total) : ""}
          </p>
          {photos.length > 0 ? (
            <Button
              variant={selectMode ? "primary" : "secondary"}
              data-testid="select-mode"
              aria-pressed={selectMode}
              onClick={() => (selectMode ? leaveSelectMode() : setSelectMode(true))}
            >
              {selectMode ? t("timeline.selectDone") : t("timeline.selectMode")}
            </Button>
          ) : null}
        </div>

        {isAdmin ? (
          <div role="tablist" className="flex flex-wrap gap-2">
            <Button
              role="tab"
              aria-selected={view === "album"}
              variant={view === "album" ? "primary" : "secondary"}
              data-testid="album-segment"
              onClick={() => changeView("album")}
            >
              {t("timeline.segmentAll")}
            </Button>
            <Button
              role="tab"
              aria-selected={view === "pending"}
              variant={view === "pending" ? "primary" : "secondary"}
              data-testid="pending-segment"
              onClick={() => changeView("pending")}
            >
              {t("timeline.segmentPending", { n: pendingCount })}
            </Button>
            <Button
              role="tab"
              aria-selected={view === "trash"}
              variant={view === "trash" ? "primary" : "secondary"}
              data-testid="trash-segment"
              onClick={() => changeView("trash")}
            >
              {t("timeline.trash")}
            </Button>
          </div>
        ) : null}

        {filtered ? (
          <div
            className="flex items-center justify-between gap-2 rounded-lg border border-gray-500/40 px-3"
            data-testid="timeline-filter"
          >
            <span className="text-sm">
              {t("timeline.filteredByMilestone", { name: filterName ?? "…" })}
            </span>
            <Button variant="link" data-testid="timeline-clear-filter" onClick={clearFilter}>
              {t("timeline.clearFilter")}
            </Button>
          </div>
        ) : null}

        {!online ? (
          <Message kind="info" data-testid="offline-banner">
            {t("offline.banner")}
          </Message>
        ) : null}
        {notice ? <Message kind="info">{notice}</Message> : null}
        {actionError ? <Message>{actionError}</Message> : null}
        {timeline.isError ? <Message>{t("timeline.loadError")}</Message> : null}
        {!baby ? <p className="opacity-70">{t("timeline.noBaby")}</p> : null}
      </div>

      {empty ? (
        <p className="px-3 opacity-70" data-testid="timeline-empty">
          {effectiveView === "pending" ? t("timeline.pendingEmpty") : t("timeline.empty")}
        </p>
      ) : null}
      {baby && timeline.isPending && !timeline.isError ? (
        <div className="flex justify-center p-6" role="status">
          <IonSpinner aria-label={t("common.loading")} />
        </div>
      ) : null}

      {photos.length > 0 ? (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1">
            <TimelineGrid
              key={`${effectiveView}-${milestoneId ?? ""}-${jump.nonce}`}
              photos={photos}
              groupCounts={groupCounts}
              baby={baby ?? null}
              milestoneNames={milestoneNames}
              timeZone={timeZone}
              selectMode={selectMode}
              selected={selected}
              pendingActions={isAdmin && effectiveView === "pending"}
              busyId={busyId}
              onOpen={onOpen}
              onToggle={onToggle}
              onApprove={onApprove}
              onReject={onReject}
              hasNext={timeline.hasNextPage}
              hasPrevious={timeline.hasPreviousPage}
              fetchingNext={timeline.isFetchingNextPage}
              fetchingPrevious={timeline.isFetchingPreviousPage}
              fetchNext={fetchNext}
              fetchPrevious={fetchPrevious}
              onVisibleGroup={setVisibleGroup}
            />
          </div>
          {!filtered && summary.data ? (
            <Scrubber groups={summary.data.groups} activeKey={visibleGroup} onJump={onJump} />
          ) : null}
        </div>
      ) : null}

      {selectMode ? (
        <div
          className="flex flex-wrap items-center gap-2 border-t border-gray-500/30 bg-[var(--ion-background-color)] px-3 py-2"
          data-testid="select-bar"
        >
          <span className="text-sm" aria-live="polite">
            {tn("timeline.selectedCount", selected.size)}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              data-testid="batch-details"
              disabled={selected.size === 0}
              onClick={() => setBatchOpen(true)}
            >
              {t("timeline.batchDetails")}
            </Button>
            {isAdmin ? (
              <Button
                variant="danger"
                data-testid="batch-delete"
                disabled={selected.size === 0}
                onClick={() => setConfirmBatchDelete(true)}
              >
                {t("timeline.batchDelete")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              data-testid="batch-share"
              disabled={!FEATURES.sharing || selected.size === 0}
              aria-disabled={!FEATURES.sharing || selected.size === 0}
              title={FEATURES.sharing ? undefined : t("timeline.comingWithSharing")}
            >
              {t("timeline.batchShare")}
            </Button>
          </div>
          {FEATURES.sharing ? null : (
            <p className="w-full text-right text-xs opacity-70">
              {t("timeline.comingWithSharing")}
            </p>
          )}
        </div>
      ) : null}

      {dragging ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-lg font-semibold text-white"
          data-testid="timeline-drop-overlay"
        >
          {t("timeline.dropHint")}
        </div>
      ) : null}
    </section>
  );

  const showViewer = active && !!viewer.photoId;
  const viewerNode = viewer.photoId ? (
    <PhotoViewer
      photos={photos}
      photoId={viewer.photoId}
      positionOffset={positionOffset}
      total={total}
      layout={breakpoint === "phone" ? "modal" : "inline"}
      onChange={viewer.change}
      onClose={viewer.close}
      onEndReached={fetchNext}
    />
  ) : null;

  return (
    <IonPage>
      <AppHeader title={t("timeline.title")} />
      <IonContent scrollY={false}>
        <Panes
          breakpoint={breakpoint}
          chat={<ChatPanePlaceholder />}
          grid={grid}
          viewer={showViewer ? viewerNode : <ViewerEmpty />}
        />
        {breakpoint === "phone" && showViewer ? viewerNode : null}

        <BatchDetailsSheet
          open={batchOpen}
          count={selected.size}
          babyId={babyId ?? "none"}
          onClose={() => setBatchOpen(false)}
          onSubmit={async (changes) => {
            const res = await batch.mutateAsync({ photoIds: [...selected], ...changes });
            setBatchOpen(false);
            setNotice(
              res.skipped.length > 0
                ? `${tn("timeline.batchSaved", res.updated.length)} ${tn("timeline.batchSkipped", res.skipped.length)}`
                : tn("timeline.batchSaved", res.updated.length),
            );
            leaveSelectMode();
          }}
        />
        <IonAlert
          isOpen={confirmBatchDelete}
          header={tn("timeline.batchDeleteConfirm", selected.size)}
          message={t("timeline.deleteConfirmBody")}
          onDidDismiss={() => setConfirmBatchDelete(false)}
          buttons={[
            { text: t("common.cancel"), role: "cancel" },
            {
              text: t("timeline.batchDelete"),
              role: "destructive",
              handler: () => void batchDelete(),
            },
          ]}
        />
      </IonContent>
    </IonPage>
  );
}
