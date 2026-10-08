import { useMemo, useSyncExternalStore } from "react";
import { summarize, type UploadItem, uploadManager } from "./manager";

/** Items of one baby plus their summary counts; re-renders on every manager change. */
export function useUploadItems(babyId: string | undefined): {
  items: UploadItem[];
  summary: ReturnType<typeof summarize>;
} {
  const all = useSyncExternalStore(uploadManager.subscribe, uploadManager.getSnapshot);
  return useMemo(() => {
    const items = babyId ? all.filter((i) => i.babyId === babyId) : [];
    return { items, summary: summarize(items) };
  }, [all, babyId]);
}
