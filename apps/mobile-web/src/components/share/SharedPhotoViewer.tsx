import { IonIcon } from "@ionic/react";
import type { ViewerPhoto } from "@tinyglow/shared";
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

/** Signed URLs of one kind, by photo id; refreshed shortly before they expire. */
type UrlMap = Record<string, Display>;

const CHROME_HIDE_MS = 2000;

/** `takenAt` is a UTC calendar date (`YYYY-MM-DD`): format it as that date in any zone. */
function takenText(day: string | null): string | null {
  if (!day) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(d);
}

/**
 * A video slide for family (docs/plans/step-12.md 2.8): the poster (display derivative) under a
 * native `<video controls>` fed by the signed `web` rendition URL. A playback error asks for a
 * fresh URL once; swiping pauses while playing. Viewers never see the original.
 */
function ShareVideo({
  photo,
  name,
  poster,
  src,
  active,
  onPlaying,
  onRefresh,
}: {
  photo: ViewerPhoto;
  name: string;
  poster: string | undefined;
  src: string | undefined;
  active: boolean;
  onPlaying: (playing: boolean) => void;
  onRefresh: (id: string) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const errors = useRef(0);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!active) {
      ref.current?.pause();
      onPlaying(false);
    }
  }, [active, onPlaying]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh URL clears the failure
  useEffect(() => {
    setBroken(false);
  }, [src]);
  if (!src || broken) {
    return (
      <div className="relative flex h-full w-full items-center justify-center">
        {poster ? (
          <img
            src={poster}
            alt={photoAlt(photo, name)}
            referrerPolicy="no-referrer"
            draggable={false}
            className="max-h-full max-w-full object-contain"
          />
        ) : null}
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-16">
          <p
            role="status"
            className="ll-viewer-round px-4 py-2 text-sm"
            data-testid="share-video-wait"
          >
            {broken ? (
              t("shareViewer.videoLoadError")
            ) : (
              <>
                <span
                  aria-hidden
                  className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent align-[-3px]"
                />
                {t("common.loading")}
              </>
            )}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center">
      {/* biome-ignore lint/a11y/useMediaCaption: family clips have no caption track */}
      <video
        ref={ref}
        data-testid={`share-video-player-${photo.id}`}
        controls
        playsInline
        preload="metadata"
        poster={poster}
        src={src}
        aria-label={photoAlt(photo, name)}
        className="max-h-full max-w-full bg-black"
        onPlay={() => onPlaying(true)}
        onPause={() => onPlaying(false)}
        onEnded={() => onPlaying(false)}
        onError={() => {
          errors.current += 1;
          onPlaying(false);
          if (errors.current > 1) setBroken(true);
          else onRefresh(photo.id);
        }}
      />
    </div>
  );
}

/**
 * Full-screen photo view for family: swipe, pinch-zoom, age, date and milestone (no captions,
 * D10). Display URLs are fetched for the current photo and two neighbours and refreshed 30 s
 * before they expire; videos (step 12) also get their `web` rendition URL and play inline.
 * Download (1600 px for photos, the MP4 rendition for videos, D9/Q9) only when the link allows it.
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
  const [display, setDisplay] = useState<UrlMap>({});
  const [web, setWeb] = useState<UrlMap>({});
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

  // Keep ±2 slides' display URLs fresh, and the `web` URL of the video slides among them (one
  // request per kind; the api answers `web` for video rows only).
  useEffect(() => {
    let cancelled = false;
    const near = photos.slice(Math.max(0, index - 2), index + 3);
    const stale = (map: UrlMap, id: string, key: string) => {
      const d = map[id];
      return (!d || d.expiresAt - Date.now() < 45_000) && !inflight.current.has(key);
    };
    const fetchKind = async (kind: "display" | "web", ids: string[], set: typeof setDisplay) => {
      if (ids.length === 0) return;
      const keys = ids.map((id) => `${kind}:${id}`);
      for (const k of keys) inflight.current.add(k);
      try {
        const res = await fetchShareUrls(ids, kind);
        if (cancelled) return;
        set((cur) => {
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
        for (const k of keys) inflight.current.delete(k);
      }
    };
    const load = () =>
      Promise.all([
        fetchKind(
          "display",
          near.map((p) => p.id).filter((id) => stale(display, id, `display:${id}`)),
          setDisplay,
        ),
        fetchKind(
          "web",
          near
            .filter((p) => p.mediaKind === "video")
            .map((p) => p.id)
            .filter((id) => stale(web, id, `web:${id}`)),
          setWeb,
        ),
      ]);
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [index, photos, display, web, onLost]);

  /** A playback error on a signed URL: drop it so the next tick fetches a fresh one. */
  const refreshWeb = useCallback((id: string) => {
    setWeb((cur) => {
      if (!cur[id]) return cur;
      const next = { ...cur };
      delete next[id];
      return next;
    });
  }, []);
  const onPlaying = useCallback((playing: boolean) => {
    const s = swiper.current;
    if (s && !s.destroyed) s.allowTouchMove = !playing;
  }, []);

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
        if (!(await downloadAndShare(res.url, `Tinyglow-${photo.id.slice(0, 8)}`))) {
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
                {p.mediaKind === "video" ? (
                  <ShareVideo
                    photo={p}
                    name={name}
                    poster={d?.url ?? p.thumbUrl ?? undefined}
                    src={web[p.id]?.url}
                    active={i === index}
                    onPlaying={onPlaying}
                    onRefresh={refreshWeb}
                  />
                ) : (
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
                )}
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
