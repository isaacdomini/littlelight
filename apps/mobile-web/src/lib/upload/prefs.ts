// Persisted upload preferences (docs/plans/step-12.md Q6 follow-up): whether new large videos may
// use cellular data on native. A single "1" marker in localStorage, no ids or names; the default
// (absent) is "Wi-Fi only". The per-item switch on the Upload screen still overrides it.

const CELLULAR_KEY = "ll.upload.cellular.v1";

const listeners = new Set<() => void>();

export function cellularForLargeVideos(): boolean {
  try {
    return window.localStorage.getItem(CELLULAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCellularForLargeVideos(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(CELLULAR_KEY, "1");
    else window.localStorage.removeItem(CELLULAR_KEY);
  } catch {
    // storage unavailable: the switch is per-item only
  }
  for (const l of listeners) l();
}

/** `useSyncExternalStore` subscription. */
export function subscribeUploadPrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
