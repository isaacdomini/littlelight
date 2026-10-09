import { IonIcon } from "@ionic/react";
import type { ViewerPhoto } from "@littlelight/shared";
import { closeOutline, downloadOutline } from "ionicons/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Swiper as SwiperType } from "swiper";
import { Keyboard, Virtual, Zoom } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import { isNative } from "../../platform/platform";
import "swiper/css";
import "swiper/css/virtual";
import "swiper/css/zoom";
import { t } from "../../i18n";
import { ageText } from "../../lib/age";
import { fetchShareDownload, fetchShareUrls } from "../../lib/shareApi";
import { photoAlt } from "./SharedAlbumGrid";

interface Display {
  url: string;
  expiresAt: number;
}

const CHROME_HIDE_MS = 2000;

function takenText(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(d);
}

/**
 * Full-screen photo view for family: swipe, pinch-zoom, age, date and milestone (no captions,
 * D10). Display URLs are fetched for the current photo and two neighbours and refreshed 30 s
 * before they expire. Download (1600 px, D9) only when the link allows it.
 */
export function SharedPhotoViewer({
  photos,
  startId,
  name,
  allowDownload,
  onClose,
  onLost,
}: {
  /** Visible (non-hidden) photos in album order. */
  photos: ViewerPhoto[];
  startId: string;
  name: string;
  allowDownload: boolean;
  onClose: () => void;
  /** A 401/410 while loading URLs: the session is gone. */
  onLost: () => void;
}) {
  const [index, setIndex] = useState(
    Math.max(
      0,
      photos.findIndex((p) => p.id === startId),
    ),
  );
  const [display, setDisplay] = useState<Record<string, Display>>({});
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swiper = useRef<SwiperType | null>(null);
  const inflight = useRef(new Set<string>());

  const wake = useCallback(() => {
    setVisible(true);
    if (hide.current) clearTimeout(hide.current);
    hide.current = setTimeout(() => setVisible(false), CHROME_HIDE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => {
      if (hide.current) clearTimeout(hide.current);
    };
  }, [wake]);

  // Keep ±2 slides' display URLs fresh.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const want = photos
        .slice(Math.max(0, index - 2), index + 3)
        .map((p) => p.id)
        .filter((id) => {
          const d = display[id];
          return (!d || d.expiresAt - Date.now() < 45_000) && !inflight.current.has(id);
        });
      if (want.length === 0) return;
      for (const id of want) inflight.current.add(id);
      try {
        const res = await fetchShareUrls(want, "display");
        if (cancelled) return;
        setDisplay((cur) => {
          const next = { ...cur };
          for (const u of res.urls) {
            next[u.id] = { url: u.url, expiresAt: new Date(u.expiresAt).getTime() };
          }
          return next;
        });
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 401 || status === 410) onLost();
        else setError(t("shareViewer.loadError"));
      } finally {
        for (const id of want) inflight.current.delete(id);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [index, photos, display, onLost]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const photo = photos[index];
  const date = takenText(photo?.takenAt ?? null);

  async function download() {
    if (!photo) return;
    setError(null);
    try {
      const res = await fetchShareDownload(photo.id);
      if (isNative()) {
        const { downloadAndShare } = await import("../../platform/native/share");
        if (!(await downloadAndShare(res.url, `Littlelight-${photo.id.slice(0, 8)}`))) {
          throw new Error("share failed");
        }
        return;
      }
      const a = document.createElement("a");
      a.href = res.url;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setError(t("shareViewer.downloadError"));
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("shareViewer.viewerLabel")}
      data-testid="share-viewer"
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
      onPointerMove={wake}
      onPointerDown={wake}
      onKeyDown={wake}
    >
      <div className="relative min-h-0 flex-1">
        <Swiper
          style={{ height: "100%" }}
          modules={[Virtual, Zoom, Keyboard]}
          virtual={{ addSlidesBefore: 1, addSlidesAfter: 1 }}
          zoom={{ maxRatio: 4 }}
          keyboard={{ enabled: true }}
          initialSlide={index}
          onSwiper={(s) => {
            swiper.current = s;
          }}
          onSlideChange={(s) => setIndex(s.activeIndex)}
        >
          {photos.map((p, i) => {
            const d = display[p.id];
            return (
              <SwiperSlide key={p.id} virtualIndex={i} data-testid={`share-slide-${p.id}`}>
                <div className="swiper-zoom-container">
                  {d || p.thumbUrl ? (
                    <img
                      src={d?.url ?? p.thumbUrl ?? undefined}
                      alt={photoAlt(p, name)}
                      referrerPolicy="no-referrer"
                      draggable={false}
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : null}
                </div>
              </SwiperSlide>
            );
          })}
        </Swiper>

        <div
          data-hidden={!visible}
          className="ll-viewer-chrome pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 p-2 pt-[max(env(safe-area-inset-top),0.5rem)]"
        >
          <button
            type="button"
            data-testid="share-viewer-close"
            aria-label={t("shareViewer.close")}
            onClick={onClose}
            className="ll-viewer-round pointer-events-auto"
          >
            <IonIcon icon={closeOutline} aria-hidden className="h-6 w-6" />
          </button>
          <p className="ll-viewer-round pointer-events-auto px-4 text-sm" aria-live="polite">
            {t("shareViewer.position", { n: index + 1, total: photos.length })}
          </p>
          <span className="w-11" />
        </div>
      </div>

      <div
        data-hidden={!visible}
        className="ll-viewer-chrome flex items-center gap-3 bg-black px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3"
      >
        <div className="min-w-0 flex-1" data-testid="share-viewer-info">
          <p className="font-semibold">
            {photo?.ageDays !== null && photo?.ageDays !== undefined
              ? ageText(photo.ageDays)
              : name}
          </p>
          <p className="text-sm text-white/80">
            {[date, photo?.milestone?.name].filter(Boolean).join(" · ")}
          </p>
        </div>
        {allowDownload ? (
          <button
            type="button"
            data-testid="share-download"
            aria-label={t("shareViewer.download")}
            onClick={() => void download()}
            className="ll-viewer-round gap-2 px-4"
          >
            <IonIcon icon={downloadOutline} aria-hidden className="h-5 w-5" />
            <span className="text-sm font-semibold">{t("shareViewer.download")}</span>
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="absolute inset-x-0 bottom-24 flex justify-center px-4">
          <p
            role="alert"
            className="rounded-xl bg-black/80 px-4 py-2 text-sm font-semibold text-[#ff8f86]"
          >
            {error}
          </p>
        </div>
      ) : null}
    </div>
  );
}
