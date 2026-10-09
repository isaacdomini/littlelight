import { IonIcon } from "@ionic/react";
import { ageGroupKey, type ViewerPhoto } from "@littlelight/shared";
import { eyeOffOutline, flag, imageOutline } from "ionicons/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { GroupedVirtuoso } from "react-virtuoso";
import { t, tn } from "../../i18n";
import { ageGroupText, ageText } from "../../lib/age";

interface Group {
  key: string;
  rows: ViewerPhoto[][];
  count: number;
}

/** 3 columns on phones, 4 on tablets, 6 on desktop (PRD "Responsive web"). */
export function shareColumns(width: number): number {
  if (width >= 1024) return 6;
  if (width >= 640) return 4;
  return 3;
}

function group(photos: readonly ViewerPhoto[], cols: number): Group[] {
  const out: Group[] = [];
  let cur: { key: string; items: ViewerPhoto[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const rows: ViewerPhoto[][] = [];
    for (let i = 0; i < cur.items.length; i += cols) rows.push(cur.items.slice(i, i + cols));
    out.push({ key: cur.key, rows, count: cur.items.length });
  };
  for (const p of photos) {
    const key = ageGroupKey(p.ageDays);
    if (cur && cur.key === key) cur.items.push(p);
    else {
      flush();
      cur = { key, items: [p] };
    }
  }
  flush();
  return out;
}

export function photoAlt(p: ViewerPhoto, name: string): string {
  const base =
    p.ageDays === null
      ? t("shareViewer.altNoAge", { name })
      : t("shareViewer.alt", { name, age: ageText(p.ageDays) });
  return p.milestone ? `${base}, ${p.milestone.name}` : base;
}

function Tile({
  photo,
  name,
  onOpen,
  onNeedUrl,
}: {
  photo: ViewerPhoto;
  name: string;
  onOpen: (p: ViewerPhoto) => void;
  onNeedUrl: (id: string) => void;
}) {
  const { id, thumbUrl, urlExpiresAt, hidden } = photo;
  // One error-driven URL refresh (expired signature), then a placeholder: never a request loop.
  const errors = useRef(0);
  const [broken, setBroken] = useState(false);
  // Refresh the signed URL 30 s before it expires (only mounted, i.e. visible, tiles do this).
  useEffect(() => {
    if (!urlExpiresAt) return;
    const wait = Math.max(0, new Date(urlExpiresAt).getTime() - Date.now() - 30_000);
    const timer = setTimeout(() => onNeedUrl(id), wait);
    return () => clearTimeout(timer);
  }, [id, urlExpiresAt, onNeedUrl]);

  if (hidden) {
    // No image request at all, and not tappable (D4).
    return (
      <div
        data-testid={`share-hidden-${id}`}
        role="img"
        aria-label={t("shareViewer.hiddenLabel")}
        className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md bg-fill p-2 text-center text-muted"
      >
        <IonIcon icon={eyeOffOutline} aria-hidden className="h-6 w-6" />
        <span className="text-xs">{t("shareViewer.hidden")}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid={`share-thumb-${id}`}
      onClick={() => onOpen(photo)}
      className="relative aspect-square min-h-11 w-full min-w-11 overflow-hidden rounded-md bg-fill [contain:layout_paint_style]"
    >
      {thumbUrl && !broken ? (
        <img
          src={thumbUrl}
          alt={photoAlt(photo, name)}
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => {
            errors.current += 1;
            if (errors.current > 1) setBroken(true);
            else onNeedUrl(id);
          }}
        />
      ) : (
        <>
          <span className="sr-only">{photoAlt(photo, name)}</span>
          <span aria-hidden className="flex h-full w-full items-center justify-center text-muted">
            <IonIcon icon={imageOutline} className="h-6 w-6 opacity-50" />
          </span>
        </>
      )}
      {photo.milestone ? (
        <span
          role="img"
          aria-label={photo.milestone.name}
          title={photo.milestone.name}
          className="absolute bottom-1.5 left-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-on-accent"
        >
          <IonIcon icon={flag} aria-hidden className="h-4 w-4" />
        </span>
      ) : null}
    </button>
  );
}

/** Age-grouped, virtualized album (newest first). No captions, search or chat (D10, FR-9). */
export function SharedAlbumGrid({
  photos,
  name,
  hasMore,
  onMore,
  onOpen,
  onNeedUrl,
}: {
  photos: ViewerPhoto[];
  name: string;
  hasMore: boolean;
  onMore: () => void;
  onOpen: (p: ViewerPhoto) => void;
  onNeedUrl: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const next = shareColumns(e?.contentRect.width ?? el.clientWidth);
      setCols((c) => (c === next ? c : next));
    });
    ro.observe(el);
    setCols(shareColumns(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const groups = useMemo(() => group(photos, cols), [photos, cols]);
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  return (
    <div ref={host} className="h-full min-h-0 w-full" data-testid="share-grid">
      <GroupedVirtuoso
        style={{ height: "100%" }}
        groupCounts={groups.map((g) => g.rows.length)}
        increaseViewportBy={{ top: 200, bottom: 1000 }}
        endReached={() => {
          if (hasMore) onMore();
        }}
        groupContent={(gi) => {
          const g = groups[gi];
          if (!g) return null;
          return (
            <div className="flex items-baseline justify-between bg-bg px-4 py-2">
              <h2 className="text-xs font-semibold text-muted">{ageGroupText(g.key)}</h2>
              <span className="text-xs text-muted">{tn("shareViewer.groupCount", g.count)}</span>
            </div>
          );
        }}
        itemContent={(index) => {
          const row = flat[index];
          if (!row) return <div className="h-1" />;
          return (
            <div
              className="grid gap-0.5 pb-0.5"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {row.map((p) => (
                <Tile key={p.id} photo={p} name={name} onOpen={onOpen} onNeedUrl={onNeedUrl} />
              ))}
            </div>
          );
        }}
      />
    </div>
  );
}
