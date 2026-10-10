import { ageGroupKey, type PhotoSummary } from "@tinyglow/shared";

export interface TimelineGroup {
  key: string;
  /** Photos of this group among the loaded items. */
  count: number;
  /** The group's photos chunked into grid rows. */
  rows: PhotoSummary[][];
}

/**
 * Groups loaded photos (already newest first) by age group, in order, and chunks each group into
 * rows of `cols`. A group never interleaves another because the sort is by capture time, so a
 * single pass is enough; a key that did reappear simply starts a new group.
 */
export function groupPhotos(photos: readonly PhotoSummary[], cols: number): TimelineGroup[] {
  const size = Math.max(1, Math.floor(cols));
  const groups: TimelineGroup[] = [];
  let current: { key: string; items: PhotoSummary[] } | null = null;
  const flush = () => {
    if (!current) return;
    const rows: PhotoSummary[][] = [];
    for (let i = 0; i < current.items.length; i += size) {
      rows.push(current.items.slice(i, i + size));
    }
    groups.push({ key: current.key, count: current.items.length, rows });
  };
  for (const p of photos) {
    const key = ageGroupKey(p.ageDays);
    if (current && current.key === key) current.items.push(p);
    else {
      flush();
      current = { key, items: [p] };
    }
  }
  flush();
  return groups;
}

/** Rows per group, for `GroupedVirtuoso.groupCounts`. */
export function rowCounts(groups: readonly TimelineGroup[]): number[] {
  return groups.map((g) => g.rows.length);
}

/** Short rail label of a group key ("W3", "M12", "2y", "New", "Pre"). */
export function shortGroupLabel(key: string): string {
  if (key === "unknown") return "New";
  if (key === "pre") return "Pre";
  if (key.startsWith("y")) return `${key.slice(1)}y`;
  return key.toUpperCase();
}
