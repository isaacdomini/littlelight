import {
  IonAlert,
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import type { ShareLinkPhoto } from "@tinyglow/shared";
import { eyeOffOutline, imagesOutline } from "ionicons/icons";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { VirtuosoGrid } from "react-virtuoso";
import { useCurrentBaby } from "../auth/AuthProvider";
import { PhotoImage } from "../components/PhotoImage";
import { Button, EmptyState, GridSkeleton, Message } from "../components/ui";
import { t, tn } from "../i18n";
import { errorMessage } from "../lib/api";
import {
  useRemoveFromShareLink,
  useShareLinkPhotos,
  useShareLinks,
  useShowSensitive,
} from "../lib/queries/sharing";
import { useProfileTimeZone } from "../lib/units";

/** `/family/share/:linkId`: the photos in one shared album (parents' view). Admins only. */
export function ShareLinkPhotosPage() {
  const { linkId = "" } = useParams();
  const { baby } = useCurrentBaby();
  const timeZone = useProfileTimeZone();
  const babyId = baby?.id ?? "none";
  const links = useShareLinks(baby?.id);
  const link = links.data?.find((l) => l.id === linkId);
  const photosQ = useShareLinkPhotos(linkId);
  const remove = useRemoveFromShareLink(babyId);
  const sensitive = useShowSensitive(babyId);

  const photos = useMemo(() => photosQ.data?.pages.flatMap((p) => p.photos) ?? [], [photosQ.data]);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmShow, setConfirmShow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const babyForAlt = baby ? { name: baby.name, nickname: baby.nickname } : null;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function doRemove() {
    setError(null);
    try {
      await remove.mutateAsync({ linkId, photoIds: [...selected] });
      setSelected(new Set());
      setSelectMode(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function setShow(photoId: string, showSensitive: boolean) {
    setError(null);
    try {
      await sensitive.mutateAsync({ linkId, photoId, showSensitive });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const tile = (_i: number, p: ShareLinkPhoto) => (
    <div className="flex min-w-0 flex-col gap-1" data-testid={`share-photo-${p.id}`}>
      <button
        type="button"
        aria-pressed={selectMode ? selected.has(p.id) : undefined}
        disabled={!selectMode}
        onClick={() => toggle(p.id)}
        className="relative aspect-square w-full overflow-hidden rounded-md bg-fill disabled:cursor-default"
      >
        <PhotoImage
          photo={p}
          baby={babyForAlt}
          timeZone={timeZone}
          className="h-full w-full object-cover"
        />
        {p.hiddenFromViewers || p.sharedBy === "rule" ? (
          <span className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] flex-col items-start gap-1">
            {p.hiddenFromViewers ? (
              <span
                data-testid={`share-hidden-badge-${p.id}`}
                className="flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white"
              >
                <IonIcon icon={eyeOffOutline} aria-hidden className="h-3.5 w-3.5 shrink-0" />
                {t("share.photos.hiddenBadge")}
              </span>
            ) : null}
            {p.sharedBy === "rule" ? (
              <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white">
                {t("share.photos.byRule")}
              </span>
            ) : null}
          </span>
        ) : null}
        {selectMode ? (
          <span
            aria-hidden
            className={`absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-sm font-semibold ${
              selected.has(p.id) ? "bg-accent text-on-accent" : "bg-black/40 text-transparent"
            }`}
          >
            ✓
          </span>
        ) : null}
      </button>
      {p.isSensitive ? (
        <Button
          variant={p.hiddenFromViewers ? "secondary" : "danger"}
          size="sm"
          className="w-full !px-2"
          data-testid="share-show-sensitive"
          onClick={() => (p.hiddenFromViewers ? setConfirmShow(p.id) : void setShow(p.id, false))}
        >
          {p.hiddenFromViewers ? t("share.photos.show") : t("share.photos.hide")}
        </Button>
      ) : null}
    </div>
  );

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/family" />
          </IonButtons>
          <IonTitle>{link?.name ?? t("share.photos.title")}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent scrollY={false}>
        <div
          className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col"
          data-testid="share-photos-page"
        >
          <div className="flex flex-col gap-3 px-4 pb-2 pt-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted" aria-live="polite">
                {link
                  ? [
                      tn("share.photoCount", link.photoCount),
                      link.hiddenCount > 0 ? tn("share.hiddenCount", link.hiddenCount) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : ""}
              </p>
              {photos.length > 0 ? (
                <Button
                  variant={selectMode ? "link" : "secondary"}
                  size="sm"
                  data-testid="share-photos-select"
                  aria-pressed={selectMode}
                  onClick={() => {
                    setSelectMode((v) => !v);
                    setSelected(new Set());
                  }}
                >
                  {selectMode ? t("timeline.selectDone") : t("timeline.selectMode")}
                </Button>
              ) : null}
            </div>
            {link?.rule ? <p className="ll-caption">{t("share.rule.note")}</p> : null}
            {error ? <Message>{error}</Message> : null}
            {photosQ.isError ? <Message>{errorMessage(photosQ.error)}</Message> : null}
          </div>

          {photosQ.isPending ? <GridSkeleton count={12} /> : null}
          {photosQ.isSuccess && photos.length === 0 ? (
            <EmptyState icon={imagesOutline} data-testid="share-photos-empty">
              {t("share.photos.empty")}
            </EmptyState>
          ) : null}
          {photos.length > 0 ? (
            <VirtuosoGrid
              className="min-h-0 flex-1"
              data={photos}
              computeItemKey={(_i, p) => p.id}
              listClassName="grid grid-cols-3 gap-0.5 sm:grid-cols-4 lg:grid-cols-6"
              itemClassName="min-w-0"
              endReached={() => {
                if (photosQ.hasNextPage && !photosQ.isFetchingNextPage)
                  void photosQ.fetchNextPage();
              }}
              itemContent={tile}
            />
          ) : null}

          {selectMode ? (
            <div
              className="flex items-center gap-3 border-t border-line bg-bg px-4 py-3"
              data-testid="share-photos-bar"
            >
              <span className="text-sm" aria-live="polite">
                {tn("share.photos.selected", selected.size)}
              </span>
              <Button
                variant="danger"
                size="sm"
                className="ml-auto"
                data-testid="share-photos-remove"
                disabled={selected.size === 0 || remove.isPending}
                onClick={() => setConfirmRemove(true)}
              >
                {t("share.photos.remove")}
              </Button>
            </div>
          ) : null}
        </div>

        <IonAlert
          isOpen={confirmRemove}
          header={tn("share.photos.removeConfirm", selected.size)}
          message={t("share.photos.removeBody")}
          onDidDismiss={() => setConfirmRemove(false)}
          buttons={[
            { text: t("common.cancel"), role: "cancel" },
            { text: t("share.photos.remove"), role: "destructive", handler: () => void doRemove() },
          ]}
        />
        <IonAlert
          isOpen={confirmShow !== null}
          header={t("share.photos.showConfirmTitle")}
          message={t("share.photos.showConfirmBody")}
          onDidDismiss={() => setConfirmShow(null)}
          buttons={[
            { text: t("common.cancel"), role: "cancel" },
            {
              text: t("share.photos.show"),
              handler: () => {
                if (confirmShow) void setShow(confirmShow, true);
              },
            },
          ]}
        />
      </IonContent>
    </IonPage>
  );
}
