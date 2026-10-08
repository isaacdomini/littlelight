import type { PhotoSummary } from "@littlelight/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { type AltTextBaby, photoAltText } from "../lib/altText";
import { cachedPhotoImageUrl, cachePhotoImage } from "../lib/imageCache";
import { useRefreshUrls } from "../lib/queries/photos";

type ImagePhoto = Pick<
  PhotoSummary,
  | "id"
  | "babyId"
  | "status"
  | "thumbUrl"
  | "urlExpiresAt"
  | "caption"
  | "ageDays"
  | "takenAt"
  | "milestoneId"
>;

export interface PhotoImageProps {
  photo: ImagePhoto;
  /** `thumb` uses `photo.thumbUrl`; `display` needs `displayUrl` (from `GET /photos/:id`). */
  kind?: "thumb" | "display";
  displayUrl?: string | null;
  /** For the fallback alt text ("{baby} at {age}, {date}"). */
  baby?: AltTextBaby | null;
  milestoneName?: string | null;
  timeZone?: string;
  /** Overrides the computed alt text. */
  alt?: string;
  className?: string;
  /** Store the loaded image in the offline cache (the viewer sets this for opened photos). */
  cacheOnLoad?: boolean;
  /** Load eagerly (the open photo); thumbs default to lazy. */
  eager?: boolean;
  onLoad?: () => void;
}

/**
 * Photo `<img>` that prefers the offline cache, falls back to the signed URL, and asks for a
 * fresh URL (once) when the signed one fails after `urlExpiresAt`. Alt text is the caption or a
 * generated description; a neutral placeholder (also labelled) shows when no image is available.
 */
export function PhotoImage({
  photo,
  kind = "thumb",
  displayUrl,
  baby,
  milestoneName,
  timeZone,
  alt,
  className = "h-full w-full object-cover",
  cacheOnLoad = false,
  eager = false,
  onLoad,
}: PhotoImageProps) {
  const refresh = useRefreshUrls(photo.babyId);
  const signed = kind === "display" ? (displayUrl ?? null) : photo.thumbUrl;
  const [cached, setCached] = useState<string | null>(null);
  const [override, setOverride] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const refreshed = useRef(false);
  const triedCache = useRef(false);
  const cachedRef = useRef<string | null>(null);

  // Cache first (object URL, revoked on unmount / photo change).
  useEffect(() => {
    let cancelled = false;
    setCached(null);
    setOverride(null);
    setFailed(false);
    refreshed.current = false;
    triedCache.current = false;
    // Grid thumbs go straight to the network (browser HTTP cache); a Cache API lookup per mount
    // costs an async hop plus a src swap (double decode) on every cell during fast scrolls. The
    // offline fallback runs from onError instead.
    if (kind === "display") {
      void cachedPhotoImageUrl(photo.id, kind).then((url) => {
        if (!url) return;
        if (cancelled) URL.revokeObjectURL(url);
        else {
          cachedRef.current = url;
          setCached(url);
        }
      });
    }
    return () => {
      cancelled = true;
      if (cachedRef.current) {
        URL.revokeObjectURL(cachedRef.current);
        cachedRef.current = null;
      }
    };
  }, [photo.id, kind]);

  // A new signed URL from the parent (refetch) clears a previous failure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on URL change only
  useEffect(() => {
    setOverride(null);
    setFailed(false);
  }, [signed]);

  const src = cached ?? override ?? signed;
  const altText = useMemo(
    () => alt ?? photoAltText(photo, baby, milestoneName, timeZone),
    [alt, photo, baby, milestoneName, timeZone],
  );

  async function onError() {
    if (cached) {
      setCached(null);
      return;
    }
    if (kind === "thumb" && !triedCache.current) {
      triedCache.current = true;
      const url = await cachedPhotoImageUrl(photo.id, kind);
      if (url) {
        cachedRef.current = url;
        setCached(url);
        return;
      }
    }
    const expired = !photo.urlExpiresAt || new Date(photo.urlExpiresAt).getTime() <= Date.now();
    if (expired && !refreshed.current) {
      refreshed.current = true;
      const fresh = await refresh(photo.id);
      const next = kind === "display" ? fresh?.displayUrl : fresh?.thumbUrl;
      if (next && next !== src) {
        setOverride(next);
        return;
      }
    }
    setFailed(true);
  }

  function handleLoad() {
    onLoad?.();
    if (cacheOnLoad && !cached && src) void cachePhotoImage(photo.id, kind, src);
  }

  if (!src || failed) {
    return (
      <div
        role="img"
        aria-label={altText}
        data-testid={`photo-placeholder-${photo.id}`}
        className="flex h-full w-full items-center justify-center bg-gray-500/20 text-xs opacity-70"
      >
        {photo.thumbUrl === null && photo.status === "uploaded" ? t("timeline.processing") : null}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={altText}
      loading={kind === "thumb" && !eager ? "lazy" : "eager"}
      decoding="async"
      draggable={false}
      className={className}
      onLoad={handleLoad}
      onError={() => void onError()}
    />
  );
}
