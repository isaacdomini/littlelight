import { IonActionSheet, IonAlert, IonContent, IonPage } from "@ionic/react";
import type { PhotoSummary } from "@littlelight/shared";
import { useState } from "react";
import { useCurrentBaby } from "../auth/AuthProvider";
import { AppHeader } from "../components/AppHeader";
import { PhotoGrid } from "../components/PhotoGrid";
import { Button, Message } from "../components/ui";
import { t } from "../i18n";
import { errorMessage } from "../lib/api";
import {
  fetchOriginalUrl,
  useApprovePhoto,
  useBabyPhotos,
  useDeletePhoto,
  usePhotosInvalidation,
  useRejectPhoto,
} from "../lib/queries";

function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Minimal grid (the age-grouped, virtualized timeline is step 5) plus the approval queue. */
export function TimelinePage() {
  const { baby } = useCurrentBaby();
  const babyId = baby?.id;
  const isAdmin = baby?.role === "admin";
  usePhotosInvalidation();

  const [view, setView] = useState<"album" | "pending">("album");
  const album = useBabyPhotos(babyId, "album");
  const pending = useBabyPhotos(isAdmin ? babyId : undefined, "pending");
  const active = view === "pending" && isAdmin ? pending : album;

  const approve = useApprovePhoto(babyId ?? "none");
  const reject = useRejectPhoto(babyId ?? "none");
  const remove = useDeletePhoto(babyId ?? "none");

  const [selected, setSelected] = useState<PhotoSummary | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PhotoSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const photos = active.data?.pages.flatMap((p) => p.photos) ?? [];
  const pendingCount =
    album.data?.pages[0]?.pendingCount ?? pending.data?.pages[0]?.pendingCount ?? 0;
  const busyId =
    (approve.isPending ? approve.variables : null) ?? (reject.isPending ? reject.variables : null);

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  return (
    <IonPage>
      <AppHeader title={t("timeline.title")} />
      <IonContent className="ion-padding">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          {!baby ? <p className="opacity-70">{t("timeline.noBaby")}</p> : null}

          {isAdmin ? (
            <div role="tablist" className="flex gap-2">
              <Button
                role="tab"
                aria-selected={view === "album"}
                variant={view === "album" ? "primary" : "secondary"}
                data-testid="album-segment"
                onClick={() => setView("album")}
              >
                {t("timeline.segmentAll")}
              </Button>
              <Button
                role="tab"
                aria-selected={view === "pending"}
                variant={view === "pending" ? "primary" : "secondary"}
                data-testid="pending-segment"
                onClick={() => setView("pending")}
              >
                {t("timeline.segmentPending", { n: pendingCount })}
              </Button>
            </div>
          ) : null}

          {actionError ? <Message>{actionError}</Message> : null}
          {active.isError ? <Message>{t("timeline.loadError")}</Message> : null}

          {baby && !active.isPending && photos.length === 0 && !active.isError ? (
            <p className="opacity-70" data-testid="timeline-empty">
              {view === "pending" ? t("timeline.pendingEmpty") : t("timeline.empty")}
            </p>
          ) : null}

          {photos.length > 0 ? (
            <PhotoGrid
              photos={photos}
              pendingActions={isAdmin && view === "pending"}
              busyId={busyId}
              onOpen={setSelected}
              onApprove={(id) => void run(() => approve.mutateAsync(id))}
              onReject={(id) => void run(() => reject.mutateAsync(id))}
            />
          ) : null}

          {active.hasNextPage ? (
            <Button
              variant="secondary"
              className="self-center"
              data-testid="timeline-load-more"
              disabled={active.isFetchingNextPage}
              onClick={() => void active.fetchNextPage()}
            >
              {t("timeline.loadMore")}
            </Button>
          ) : null}
        </div>

        <IonActionSheet
          isOpen={selected !== null}
          header={t("timeline.openPhoto")}
          onDidDismiss={() => setSelected(null)}
          buttons={[
            ...(isAdmin
              ? [
                  {
                    text: t("timeline.downloadOriginal"),
                    data: "download",
                    handler: () => {
                      const id = selected?.id;
                      if (id) void run(async () => download(await fetchOriginalUrl(id)));
                    },
                  },
                ]
              : []),
            {
              text: t("timeline.delete"),
              role: "destructive",
              handler: () => setConfirmDelete(selected),
            },
            { text: t("common.cancel"), role: "cancel" },
          ]}
        />
        <IonAlert
          isOpen={confirmDelete !== null}
          header={t("timeline.deleteConfirmTitle")}
          message={t("timeline.deleteConfirmBody")}
          onDidDismiss={() => setConfirmDelete(null)}
          buttons={[
            { text: t("common.cancel"), role: "cancel" },
            {
              text: t("timeline.delete"),
              role: "destructive",
              handler: () => {
                const id = confirmDelete?.id;
                if (id) void run(() => remove.mutateAsync(id));
              },
            },
          ]}
        />
      </IonContent>
    </IonPage>
  );
}
