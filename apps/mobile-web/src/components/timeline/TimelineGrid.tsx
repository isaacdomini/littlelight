import type { BabySummary, PhotoSummary } from "@littlelight/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GroupedVirtuoso } from "react-virtuoso";
import { tn } from "../../i18n";
import { ageGroupText } from "../../lib/age";
import { groupPhotos, rowCounts } from "./groups";
import { Thumb } from "./Thumb";

const BASE_INDEX = 1_000_000;
const TARGET_THUMB_PX = 112;

/** Columns for a container width: 3 on phones up to 8 on wide screens (PRD breakpoints). */
export function columnsFor(width: number): number {
  if (width <= 0) return 3;
  return Math.max(3, Math.min(8, Math.round(width / TARGET_THUMB_PX)));
}

export interface TimelineGridProps {
  photos: PhotoSummary[];
  /** Group counts from the summary (whole album); falls back to the loaded count. */
  groupCounts?: Map<string, number>;
  baby: Pick<BabySummary, "name" | "nickname"> | null;
  milestoneNames: Map<string, string>;
  timeZone: string;
  selectMode: boolean;
  selected: ReadonlySet<string>;
  pendingActions: boolean;
  busyId: string | null;
  onOpen: (photo: PhotoSummary) => void;
  onToggle: (photo: PhotoSummary) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  hasNext: boolean;
  hasPrevious: boolean;
  fetchingNext: boolean;
  fetchingPrevious: boolean;
  fetchNext: () => void;
  fetchPrevious: () => void;
  onVisibleGroup: (key: string) => void;
}

/**
 * Virtualized, age-grouped grid. Rows of `cols` thumbs are the Virtuoso items (a row's height is
 * known from the aspect-square cells, so no per-item measuring work); group headers are sticky.
 * Newer pages prepended after a scrubber jump keep the scroll position via `firstItemIndex`.
 */
export function TimelineGrid(props: TimelineGridProps) {
  const {
    photos,
    groupCounts,
    baby,
    milestoneNames,
    timeZone,
    selectMode,
    selected,
    pendingActions,
    busyId,
    onOpen,
    onToggle,
    onApprove,
    onReject,
    hasNext,
    hasPrevious,
    fetchingNext,
    fetchingPrevious,
    fetchNext,
    fetchPrevious,
    onVisibleGroup,
  } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const next = columnsFor(entry?.contentRect.width ?? el.clientWidth);
      setCols((c) => (c === next ? c : next));
    });
    ro.observe(el);
    setCols(columnsFor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const groups = useMemo(() => groupPhotos(photos, cols), [photos, cols]);
  const counts = useMemo(() => rowCounts(groups), [groups]);
  const flatRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  // Prepending newer photos must lower firstItemIndex by the number of rows added.
  const [track, setTrack] = useState({
    firstId: photos[0]?.id,
    rows: flatRows.length,
    first: BASE_INDEX,
  });
  const firstId = photos[0]?.id;
  if (track.firstId !== firstId || track.rows !== flatRows.length) {
    let first = track.first;
    if (
      track.firstId &&
      firstId !== track.firstId &&
      photos.some((p) => p.id === track.firstId) &&
      flatRows.length > track.rows
    ) {
      first = track.first - (flatRows.length - track.rows);
    }
    setTrack({ firstId, rows: flatRows.length, first });
  }
  const firstItemIndex = track.first;

  const lastGroup = useRef<string | null>(null);
  const rangeChanged = useCallback(
    ({ startIndex }: { startIndex: number }) => {
      let acc = 0;
      for (const g of groups) {
        acc += g.rows.length;
        if (startIndex - firstItemIndex < acc) {
          if (lastGroup.current !== g.key) {
            lastGroup.current = g.key;
            onVisibleGroup(g.key);
          }
          return;
        }
      }
    },
    [groups, firstItemIndex, onVisibleGroup],
  );

  return (
    <div ref={hostRef} className="h-full min-h-0 w-full" data-testid="timeline-grid">
      <GroupedVirtuoso
        style={{ height: "100%" }}
        scrollerRef={(el) => {
          if (el instanceof HTMLElement) el.setAttribute("data-testid", "timeline-scroller");
        }}
        groupCounts={counts}
        firstItemIndex={firstItemIndex}
        increaseViewportBy={{ top: 200, bottom: 1200 }}
        rangeChanged={rangeChanged}
        computeItemKey={(index) => flatRows[index - firstItemIndex]?.[0]?.id ?? index}
        endReached={() => {
          if (hasNext && !fetchingNext) fetchNext();
        }}
        startReached={() => {
          if (hasPrevious && !fetchingPrevious) fetchPrevious();
        }}
        groupContent={(gi) => {
          const g = groups[gi];
          if (!g) return null;
          const total = groupCounts?.get(g.key) ?? g.count;
          return (
            <div
              data-testid={`timeline-group-${g.key}`}
              className="flex items-baseline justify-between bg-bg px-4 py-2"
            >
              <h2 className="text-xs font-semibold text-muted">{ageGroupText(g.key)}</h2>
              <span className="text-xs text-muted">{tn("timeline.groupCount", total)}</span>
            </div>
          );
        }}
        itemContent={(index, gi) => {
          const row = flatRows[index - firstItemIndex];
          if (!row) return <div className="h-1" />;
          return (
            <div
              className="grid gap-0.5 pb-0.5 [contain:layout_paint_style]"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              data-group={groups[gi]?.key}
            >
              {row.map((p) => (
                <Thumb
                  key={p.id}
                  photo={p}
                  baby={baby}
                  milestoneName={p.milestoneId ? (milestoneNames.get(p.milestoneId) ?? null) : null}
                  timeZone={timeZone}
                  selectMode={selectMode}
                  selected={selected.has(p.id)}
                  pendingActions={pendingActions}
                  busy={busyId === p.id}
                  onOpen={onOpen}
                  onToggle={onToggle}
                  onApprove={onApprove}
                  onReject={onReject}
                />
              ))}
            </div>
          );
        }}
      />
    </div>
  );
}
