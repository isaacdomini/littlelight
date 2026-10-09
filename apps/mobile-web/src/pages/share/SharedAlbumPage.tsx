import { IonContent, IonPage } from "@ionic/react";
import type { ShareAlbum, ViewerPhoto, ViewerPhotosResponse } from "@littlelight/shared";
import { type InfiniteData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlowPage } from "../../components/Page";
import { InstallPrompt } from "../../components/share/InstallPrompt";
import { PasscodeForm } from "../../components/share/PasscodeForm";
import { SharedAlbumGrid } from "../../components/share/SharedAlbumGrid";
import { SharedPhotoViewer } from "../../components/share/SharedPhotoViewer";
import { ShareExpired } from "../../components/share/ShareExpired";
import { Button, GridSkeleton, Message, PageSkeleton } from "../../components/ui";
import { t, tn } from "../../i18n";
import {
  fetchSharePhotos,
  fetchShareUrls,
  openShareSession,
  ShareApiError,
} from "../../lib/shareApi";

type View =
  | { kind: "loading" }
  | { kind: "passcode"; error: ShareApiError | null }
  | { kind: "expired" }
  | { kind: "error"; message: string }
  | { kind: "album"; album: ShareAlbum };

const PHOTOS_KEY = ["share", "photos"] as const;

/** Per-link head tags: noindex, no referrer, and the link's own web manifest (D11). */
function useShareHead(token: string) {
  useEffect(() => {
    const added: HTMLElement[] = [];
    const add = (tag: "meta" | "link", attrs: Record<string, string>) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      document.head.appendChild(el);
      added.push(el);
    };
    add("meta", { name: "robots", content: "noindex, nofollow" });
    if (!document.querySelector('meta[name="referrer"]')) {
      add("meta", { name: "referrer", content: "no-referrer" });
    }
    add("link", {
      rel: "manifest",
      href: `/api/share/manifest.webmanifest?t=${encodeURIComponent(token)}`,
    });
    add("link", { rel: "apple-touch-icon", href: "/icons/viewer-192.png" });
    return () => {
      for (const el of added) el.remove();
    };
  }, [token]);
}

/** `/s/:token`: public family album. No parent session, no parent endpoints, no chat or search. */
export function SharedAlbumPage({ token }: { token: string }) {
  useShareHead(token);
  const qc = useQueryClient();
  const [view, setView] = useState<View>({ kind: "loading" });
  const started = useRef(false);
  const lastRetry = useRef(0);

  const open = useCallback(
    async (passcode?: string) => {
      try {
        const res = await openShareSession(token, passcode);
        setView({ kind: "album", album: res.album });
      } catch (e) {
        qc.removeQueries({ queryKey: ["share"] });
        if (!(e instanceof ShareApiError)) throw e;
        if (e.code === "share_link_expired" || e.status === 410) setView({ kind: "expired" });
        else if (e.code === "passcode_required") setView({ kind: "passcode", error: null });
        else if (passcode)
          throw e; // wrong passcode / locked: PasscodeForm shows it
        else if (e.status === 429 || e.code === "passcode_locked") {
          setView({ kind: "passcode", error: e });
        } else setView({ kind: "error", message: e.message });
      }
    },
    [token, qc],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void open().catch(() => setView({ kind: "error", message: t("shareViewer.loadError") }));
  }, [open]);

  /** 401/410 mid-session: one silent re-exchange, then the expired page (never a retry loop). */
  const onLost = useCallback(() => {
    const now = Date.now();
    if (now - lastRetry.current < 10_000) {
      qc.removeQueries({ queryKey: ["share"] });
      setView({ kind: "expired" });
      return;
    }
    lastRetry.current = now;
    void open().catch(() => setView({ kind: "expired" }));
  }, [open, qc]);

  if (view.kind === "loading") return <PageSkeleton />;
  if (view.kind === "expired") return <ShareExpired />;
  if (view.kind === "passcode") {
    return <PasscodeForm initialError={view.error} onSubmit={(code) => open(code)} />;
  }
  if (view.kind === "error") {
    return (
      <FlowPage title={t("shareViewer.errorTitle")} testId="share-error">
        <Message>{view.message}</Message>
        <Button onClick={() => window.location.reload()}>{t("common.retry")}</Button>
      </FlowPage>
    );
  }
  return <Album album={view.album} onLost={onLost} />;
}

function Album({ album, onLost }: { album: ShareAlbum; onLost: () => void }) {
  const qc = useQueryClient();
  const name = album.babyNickname ?? album.babyName;
  const [openId, setOpenId] = useState<string | null>(null);

  const q = useInfiniteQuery({
    queryKey: PHOTOS_KEY,
    initialPageParam: undefined as string | undefined,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ pageParam }): Promise<ViewerPhotosResponse> => {
      try {
        return await fetchSharePhotos(pageParam);
      } catch (e) {
        if (e instanceof ShareApiError && (e.status === 401 || e.status === 410)) onLost();
        throw e;
      }
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const photos = useMemo(() => q.data?.pages.flatMap((p) => p.photos) ?? [], [q.data]);
  const visible = useMemo(() => photos.filter((p) => !p.hidden), [photos]);

  // Batched thumb URL refresh (expiring or failed images).
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needUrl = useCallback(
    (id: string) => {
      pending.current.add(id);
      if (timer.current) return;
      timer.current = setTimeout(async () => {
        timer.current = null;
        const ids = [...pending.current].slice(0, 200);
        for (const id of ids) pending.current.delete(id);
        if (ids.length === 0) return;
        try {
          const res = await fetchShareUrls(ids, "thumb");
          const byId = new Map(res.urls.map((u) => [u.id, u]));
          qc.setQueryData<InfiniteData<ViewerPhotosResponse, string | undefined>>(
            PHOTOS_KEY,
            (old) =>
              old
                ? {
                    ...old,
                    pages: old.pages.map((pg) => ({
                      ...pg,
                      photos: pg.photos.map((p): ViewerPhoto => {
                        const u = byId.get(p.id);
                        return u && !p.hidden
                          ? { ...p, thumbUrl: u.url, urlExpiresAt: u.expiresAt }
                          : p;
                      }),
                    })),
                  }
                : old,
          );
        } catch (e) {
          if (e instanceof ShareApiError && (e.status === 401 || e.status === 410)) onLost();
        }
      }, 150);
    },
    [qc, onLost],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const count = album.photoCount;
  return (
    <IonPage>
      <IonContent scrollY={false}>
        <div
          className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col"
          data-testid="share-album"
        >
          <header className="flex flex-col gap-3 px-4 pb-2 pt-[max(env(safe-area-inset-top),1rem)]">
            <div className="flex flex-col gap-0.5">
              <h1 className="text-2xl font-semibold" data-testid="share-album-title">
                {t("shareViewer.title", { name })}
              </h1>
              <p className="text-sm text-muted" aria-live="polite">
                {[album.linkName, tn("shareViewer.photoCount", count)].join(" · ")}
              </p>
            </div>
            <InstallPrompt />
          </header>

          {q.isPending ? <GridSkeleton count={18} /> : null}
          {q.isError ? (
            <div className="flex flex-col items-start gap-3 px-4">
              <Message>{t("shareViewer.loadError")}</Message>
              <Button variant="secondary" onClick={() => void q.refetch()}>
                {t("common.retry")}
              </Button>
            </div>
          ) : null}
          {q.isSuccess && photos.length === 0 ? (
            <p className="px-4 py-10 text-center text-muted" data-testid="share-album-empty">
              {t("shareViewer.empty")}
            </p>
          ) : null}
          {photos.length > 0 ? (
            <div className="min-h-0 flex-1">
              <SharedAlbumGrid
                photos={photos}
                name={name}
                hasMore={!!q.hasNextPage && !q.isFetchingNextPage}
                onMore={() => void q.fetchNextPage()}
                onOpen={(p) => setOpenId(p.id)}
                onNeedUrl={needUrl}
              />
            </div>
          ) : null}
        </div>
        {openId ? (
          <SharedPhotoViewer
            photos={visible}
            startId={openId}
            name={name}
            allowDownload={album.allowDownload}
            onClose={() => setOpenId(null)}
            onLost={onLost}
          />
        ) : null}
      </IonContent>
    </IonPage>
  );
}
